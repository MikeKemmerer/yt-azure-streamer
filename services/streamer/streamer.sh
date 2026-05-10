#!/usr/bin/env bash
set -euo pipefail

# Streamer service: plays videos from blobfuse2 in playlist order to YouTube
# RTMP, with bookmark-based resume and configurable max resolution.
#
# Supports dual-stream output: landscape (16:9) and portrait (9:16, 1080x1920)
# with independent stream keys and schedules. Both outputs play the same video
# in sync. The scheduler writes signal files to indicate which streams are active.
#
# Config is read from /etc/yt/schedule.json:
#   "stream": { "max_resolution": "720p" }                   (legacy settings)
#   "streams": { "landscape": {...}, "portrait": {...} }      (per-stream config)
#
# Supported resolutions: 144p 240p 360p 480p 720p 1080p 1440p 2160p
# Videos below max_resolution are NOT upsampled.

PREFIX=$(cat /etc/yt/nameprefix 2>/dev/null || echo "unknown")
MODE=$(cat /etc/yt/mode 2>/dev/null || echo "azure")

# --- Determine video directory ---
if [[ "$MODE" == "local" ]]; then
  VIDEO_DIR=$(grep '^VIDEO_DIR=' /etc/yt/local.conf 2>/dev/null | cut -d= -f2-)
  VIDEO_DIR="${VIDEO_DIR:-/mnt/videos}"
else
  KV_NAME="${PREFIX,,}-kv"
  VIDEO_DIR="/mnt/blobfuse2"
fi

PLAYLIST="/etc/yt/playlist.txt"
STATE_FILE="/etc/yt/playlist-state.json"
CONFIG_FILE="/etc/yt/schedule.json"

# --- Resolution lookup tables ---
declare -A RES_HEIGHT=(
  [144p]=144 [240p]=240 [360p]=360 [480p]=480
  [720p]=720 [1080p]=1080 [1440p]=1440 [2160p]=2160
)
declare -A RES_BITRATE=(
  [144p]=400k  [240p]=700k  [360p]=1000k [480p]=1500k
  [720p]=3000k [1080p]=5000k [1440p]=8000k [2160p]=16000k
)
declare -A RES_BUFSIZE=(
  [144p]=800k   [240p]=1400k  [360p]=2000k  [480p]=3000k
  [720p]=6000k  [1080p]=10000k [1440p]=16000k [2160p]=32000k
)
declare -A RES_AUDIO=(
  [144p]=96k  [240p]=96k  [360p]=128k [480p]=128k
  [720p]=128k [1080p]=192k [1440p]=192k [2160p]=256k
)

echo "Streamer starting with prefix: $PREFIX"

# --- Read max resolution from config ---
MAX_RES="720p"
if [[ -f "$CONFIG_FILE" ]]; then
  CONFIGURED_RES=$(python3 -c "
import json, sys
try:
  cfg = json.load(open('$CONFIG_FILE'))
  print(cfg.get('stream', {}).get('max_resolution', ''))
except: pass
" 2>/dev/null || true)
  if [[ -n "$CONFIGURED_RES" && -n "${RES_HEIGHT[$CONFIGURED_RES]+x}" ]]; then
    MAX_RES="$CONFIGURED_RES"
  fi
fi
MAX_H="${RES_HEIGHT[$MAX_RES]}"
MAXRATE="${RES_BITRATE[$MAX_RES]}"
BUFSIZE="${RES_BUFSIZE[$MAX_RES]}"
AUDIO_BR="${RES_AUDIO[$MAX_RES]}"
echo "Max resolution: $MAX_RES (${MAX_H}p, maxrate=$MAXRATE)"

# --- Portrait dimensions (9:16 — width=MAX_H, height=MAX_H*16/9) ---
PORT_W="$MAX_H"
PORT_H=$(( MAX_H * 16 / 9 ))
# Video pad offset: center video vertically in the portrait frame
# 16:9 video at PORT_W wide → video height = PORT_W * 9 / 16 = MAX_H * 9 / 16
PORT_VID_H=$(( PORT_W * 9 / 16 ))
PORT_PAD_Y=$(( (PORT_H - PORT_VID_H) / 2 + PORT_VID_H / 10 ))
# Font sizes scaled proportionally (base: 1080 wide)
PORT_FONT_CHURCH=$(( 42 * PORT_W / 1080 ))
PORT_FONT_LOCATION=$(( 32 * PORT_W / 1080 ))
PORT_FONT_TITLE=$(( 42 * PORT_W / 1080 ))
# Text Y positions scaled proportionally (pushed down to clear YouTube nav)
PORT_Y_CHURCH=$(( 360 * PORT_H / 1920 ))
PORT_Y_LOCATION=$(( 420 * PORT_H / 1920 ))
PORT_Y_TITLE=$(( 480 * PORT_H / 1920 ))
# Position just below the video for time display and progress bar
PORT_VID_BOTTOM=$(( PORT_PAD_Y + PORT_VID_H ))
PORT_FONT_TIME=$(( 24 * PORT_W / 1080 ))
PORT_PROGRESS_H=4
echo "Portrait: ${PORT_W}x${PORT_H}"

# --- Read per-stream config ---
LANDSCAPE_KEY_NAME="youtube-stream-key"
PORTRAIT_KEY_NAME="youtube-stream-key-portrait"
PORTRAIT_CHURCH_NAME="Saint Demetrios Greek Orthodox Church"
PORTRAIT_CHURCH_LOCATION="Seattle, Washington"
LANDSCAPE_STREAM_NAME="Main Stream"
PORTRAIT_STREAM_NAME="Shorts / Vertical"
if [[ -f "$CONFIG_FILE" ]]; then
  eval "$(python3 -c "
import json
try:
  cfg = json.load(open('$CONFIG_FILE'))
  streams = cfg.get('streams', {})
  l = streams.get('landscape', {})
  p = streams.get('portrait', {})
  # Escape single quotes for bash
  def esc(s): return str(s).replace(\"'\", \"'\\\\\\\"'\\\\\\\"'\")
  print(f\"LANDSCAPE_KEY_NAME='{esc(l.get('stream_key_name', 'youtube-stream-key'))}'\")
  print(f\"PORTRAIT_KEY_NAME='{esc(p.get('stream_key_name', 'youtube-stream-key-portrait'))}'\")
  print(f\"PORTRAIT_CHURCH_NAME='{esc(p.get('church_name', 'Saint Demetrios Greek Orthodox Church'))}'\")
  print(f\"PORTRAIT_CHURCH_LOCATION='{esc(p.get('church_location', 'Seattle, Washington'))}'\")
  print(f\"LANDSCAPE_STREAM_NAME='{esc(l.get('name', 'Main Stream'))}'\")
  print(f\"PORTRAIT_STREAM_NAME='{esc(p.get('name', 'Shorts / Vertical'))}'\")
except: pass
" 2>/dev/null)"
fi
echo "Landscape key name: $LANDSCAPE_KEY_NAME ($LANDSCAPE_STREAM_NAME)"
echo "Portrait key name: $PORTRAIT_KEY_NAME ($PORTRAIT_STREAM_NAME)"

# --- Fetch YouTube stream keys ---
fetch_stream_key() {
  local key_name="$1"
  local display_name="$2"
  if [[ "$MODE" == "local" ]]; then
    local key_file="/etc/yt/secrets/$key_name"
    local key
    key=$(cat "$key_file" 2>/dev/null | tr -d '[:space:]')
    if [[ -z "$key" ]]; then
      echo "WARNING: Stream key not found at $key_file ($display_name)" >&2
      return 1
    fi
    echo "$key"
  else
    local key
    key=$(az keyvault secret show \
      --vault-name "$KV_NAME" \
      --name "$key_name" \
      --query value \
      -o tsv 2>/dev/null || true)
    if [[ -z "$key" ]]; then
      echo "WARNING: '$key_name' secret not found in Key Vault '$KV_NAME' ($display_name)" >&2
      return 1
    fi
    echo "$key"
  fi
}

if [[ "$MODE" != "local" ]]; then
  echo "Logging in with managed identity..."
  az login --identity >/dev/null 2>&1
fi

LANDSCAPE_KEY=""
PORTRAIT_KEY=""
LANDSCAPE_KEY=$(fetch_stream_key "$LANDSCAPE_KEY_NAME" "$LANDSCAPE_STREAM_NAME") || true
PORTRAIT_KEY=$(fetch_stream_key "$PORTRAIT_KEY_NAME" "$PORTRAIT_STREAM_NAME") || true

if [[ -z "$LANDSCAPE_KEY" && -z "$PORTRAIT_KEY" ]]; then
  echo "ERROR: No stream keys available. At least one stream key is required."
  exit 1
fi

LANDSCAPE_RTMP=""
PORTRAIT_RTMP=""
[[ -n "$LANDSCAPE_KEY" ]] && LANDSCAPE_RTMP="rtmp://a.rtmp.youtube.com/live2/${LANDSCAPE_KEY}"
[[ -n "$PORTRAIT_KEY" ]] && PORTRAIT_RTMP="rtmp://a.rtmp.youtube.com/live2/${PORTRAIT_KEY}"

echo "Landscape RTMP: ${LANDSCAPE_RTMP:+configured}${LANDSCAPE_RTMP:-NOT AVAILABLE}"
echo "Portrait RTMP: ${PORTRAIT_RTMP:+configured}${PORTRAIT_RTMP:-NOT AVAILABLE}"

# --- Read shuffle config ---
SHUFFLE_FLAG=""
if [[ -f "$CONFIG_FILE" ]]; then
  SHUFFLE=$(python3 -c "
import json, sys
try:
  cfg = json.load(open('$CONFIG_FILE'))
  print(cfg.get('stream', {}).get('shuffle', False))
except: pass
" 2>/dev/null || true)
  if [[ "$SHUFFLE" == "True" ]]; then
    SHUFFLE_FLAG="--shuffle"
  fi
fi

# --- Read watermark config ---
WATERMARK=false
if [[ -f "$CONFIG_FILE" ]]; then
  WM=$(python3 -c "
import json, sys
try:
  cfg = json.load(open('$CONFIG_FILE'))
  print(cfg.get('stream', {}).get('watermark', False))
except: pass
" 2>/dev/null || true)
  if [[ "$WM" == "True" ]]; then
    WATERMARK=true
  fi
fi
echo "Watermark: $WATERMARK"

# Watermark fonts
WM_FONT_SERIF="/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf"
if [[ ! -f "$WM_FONT_SERIF" ]]; then
  WM_FONT_SERIF="/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf"
fi
WM_FONT_SANS="/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
if [[ ! -f "$WM_FONT_SANS" ]]; then
  WM_FONT_SANS="/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
fi

# --- Generate playlist ---
bash /usr/local/bin/generate-playlist.sh $SHUFFLE_FLAG "$VIDEO_DIR" "$PLAYLIST"

# Parse playlist into an array of file paths
# Parse playlist into an array of file paths (unescape ffmpeg's '\'' quoting)
mapfile -t VIDEOS < <(grep "^file " "$PLAYLIST" | sed "s/^file '//;s/'$//" | sed "s/'\\\\''/'/g")
NUM_VIDEOS=${#VIDEOS[@]}

if [[ $NUM_VIDEOS -eq 0 ]]; then
  echo "ERROR: No videos in playlist"
  exit 1
fi
echo "Playlist: $NUM_VIDEOS videos"

# --- Read bookmark ---
START_INDEX=0
if [[ -f "$STATE_FILE" ]]; then
  SAVED_INDEX=$(python3 -c "
import json, sys
try:
  s = json.load(open('$STATE_FILE'))
  print(s.get('index', 0))
except: print(0)
" 2>/dev/null || echo 0)
  SAVED_FILE=$(python3 -c "
import json, sys
try:
  s = json.load(open('$STATE_FILE'))
  print(s.get('file', ''))
except: print('')
" 2>/dev/null || echo "")

  # Resume from the NEXT video after the bookmark (the bookmarked one was partial)
  RESUME_INDEX=$(( (SAVED_INDEX + 1) % NUM_VIDEOS ))

  # Validate: if the saved file still exists at that index, use it;
  # otherwise search for it; otherwise start from 0
  if [[ -n "$SAVED_FILE" ]]; then
    if [[ "$SAVED_INDEX" -lt "$NUM_VIDEOS" && "${VIDEOS[$SAVED_INDEX]}" == "$SAVED_FILE" ]]; then
      START_INDEX=$RESUME_INDEX
      echo "Resuming after bookmark: index $SAVED_INDEX ($SAVED_FILE) → starting at $START_INDEX"
    else
      # File may have moved position — search for it
      FOUND=false
      for i in "${!VIDEOS[@]}"; do
        if [[ "${VIDEOS[$i]}" == "$SAVED_FILE" ]]; then
          START_INDEX=$(( (i + 1) % NUM_VIDEOS ))
          echo "Bookmark file found at new index $i → starting at $START_INDEX"
          FOUND=true
          break
        fi
      done
      if [[ "$FOUND" == false ]]; then
        echo "Bookmarked file no longer in playlist — starting from index 0"
        START_INDEX=0
      fi
    fi
  fi
fi

# --- Build ffmpeg scale filter ---
# Downscale videos above max resolution; never upscale.
# scale=-2:N ensures width is divisible by 2 (required by libx264).
SCALE_FILTER="scale=-2:'min(ih,${MAX_H})':force_original_aspect_ratio=decrease"

# --- Stream loop ---
INDEX=$START_INDEX
while true; do
  VIDEO="${VIDEOS[$INDEX]}"
  BASENAME=$(basename "$VIDEO")
  TITLE="${BASENAME%.*}"  # filename without extension (default)

  # Check for custom display title in playlist config
  CUSTOM_TITLE=$(python3 -c "
import json, sys
try:
    cfg = json.load(open('/etc/yt/playlist-config.json'))
    for v in cfg.get('videos', []):
        if v.get('file') == sys.argv[1] and v.get('title'):
            print(v['title'])
            break
except: pass
" "$BASENAME" 2>/dev/null || true)
  if [[ -n "$CUSTOM_TITLE" ]]; then
    TITLE="$CUSTOM_TITLE"
  fi

  echo "[$INDEX/$((NUM_VIDEOS-1))] Streaming: $BASENAME"
  echo "  Title: $TITLE"

  # Probe the input resolution to decide whether to scale
  INPUT_H=$(ffprobe -v error -select_streams v:0 \
    -show_entries stream=height -of csv=p=0 "$VIDEO" 2>/dev/null || echo 0)

  # Build video filter chain
  # SCALE_VF: common scaling (applied to all outputs)
  # LANDSCAPE_WM: landscape-only watermark/HUD (NOT applied to portrait)
  SCALE_VF=()
  if [[ "$INPUT_H" -gt "$MAX_H" ]]; then
    echo "  Input ${INPUT_H}p > max ${MAX_H}p — downscaling to ${MAX_RES}"
    SCALE_VF+=("$SCALE_FILTER")
  else
    echo "  Input ${INPUT_H}p <= max ${MAX_H}p — no scaling"
  fi

  # --- Prepare title/upnext text files (used by landscape watermark and portrait overlays) ---
  MAX_LINE=55
  TITLE_FILE="/tmp/streamer-title.txt"
  NUM_LINES=1
  if [[ ${#TITLE} -gt $MAX_LINE ]]; then
    NUM_LINES=2
  fi
  if [[ $NUM_LINES -eq 2 ]]; then
    TARGET=$(( ${#TITLE} / 2 ))
    BEST=-1
    for ((d=0; d < ${#TITLE}; d++)); do
      FWD=$((TARGET + d))
      BWD=$((TARGET - d))
      if [[ $FWD -lt ${#TITLE} && "${TITLE:FWD:1}" == " " ]]; then
        BEST=$FWD; break
      fi
      if [[ $BWD -gt 0 && "${TITLE:BWD:1}" == " " ]]; then
        BEST=$BWD; break
      fi
    done
    if [[ $BEST -gt 0 ]]; then
      printf '%s\n%s' "${TITLE:0:BEST}" "${TITLE:BEST+1}" > "$TITLE_FILE"
    else
      printf '%s' "$TITLE" > "$TITLE_FILE"
    fi
  else
    printf '%s' "$TITLE" > "$TITLE_FILE"
  fi

  UPNEXT_FILE="/tmp/streamer-upnext.txt"
  NEXT_INDEX=$(( (INDEX + 1) % NUM_VIDEOS ))
  NEXT_BASENAME=$(basename "${VIDEOS[$NEXT_INDEX]}")
  NEXT_DISPLAY="${NEXT_BASENAME%.*}"
  NEXT_CUSTOM=$(python3 -c "
import json, sys
try:
    cfg = json.load(open('/etc/yt/playlist-config.json'))
    for v in cfg.get('videos', []):
        if v.get('file') == sys.argv[1] and v.get('title'):
            print(v['title'])
            break
except: pass
" "$NEXT_BASENAME" 2>/dev/null || true)
  if [[ -n "$NEXT_CUSTOM" ]]; then
    NEXT_DISPLAY="$NEXT_CUSTOM"
  fi
  NEXT_TITLE="Up Next: ${NEXT_DISPLAY}"
  if [[ ${#NEXT_TITLE} -gt $MAX_LINE ]]; then
    TARGET=$(( ${#NEXT_TITLE} / 2 ))
    BEST=-1
    for ((d=0; d < ${#NEXT_TITLE}; d++)); do
      FWD=$((TARGET + d))
      BWD=$((TARGET - d))
      if [[ $FWD -lt ${#NEXT_TITLE} && "${NEXT_TITLE:FWD:1}" == " " ]]; then
        BEST=$FWD; break
      fi
      if [[ $BWD -gt 0 && "${NEXT_TITLE:BWD:1}" == " " ]]; then
        BEST=$BWD; break
      fi
    done
    if [[ $BEST -gt 0 ]]; then
      printf '%s\n%s' "${NEXT_TITLE:0:BEST}" "${NEXT_TITLE:BEST+1}" > "$UPNEXT_FILE"
    else
      printf '%s' "$NEXT_TITLE" > "$UPNEXT_FILE"
    fi
  else
    printf '%s' "$NEXT_TITLE" > "$UPNEXT_FILE"
  fi

  # Alpha expressions for 41s cycle: 33s main visible, 0.5s crossfade, 7s up-next, 0.5s crossfade
  ALPHA_MAIN='if(lt(mod(t\,41)\,32.5)\,1\,if(lt(mod(t\,41)\,33)\,(33-mod(t\,41))/0.5\,if(lt(mod(t\,41)\,40)\,0\,(mod(t\,41)-40)/0.5)))'
  ALPHA_NEXT='if(lt(mod(t\,41)\,32.5)\,0\,if(lt(mod(t\,41)\,33)\,(mod(t\,41)-32.5)/0.5\,if(lt(mod(t\,41)\,40)\,1\,(41-mod(t\,41))/0.5)))'

  # --- Portrait title files (tighter wrap for larger font) ---
  PORT_MAX_LINE=22
  PORT_TITLE_FILE="/tmp/streamer-title-portrait.txt"
  if [[ ${#TITLE} -gt $PORT_MAX_LINE ]]; then
    TARGET=$(( ${#TITLE} / 2 ))
    BEST=-1
    for ((d=0; d < ${#TITLE}; d++)); do
      FWD=$((TARGET + d)); BWD=$((TARGET - d))
      if [[ $FWD -lt ${#TITLE} && "${TITLE:FWD:1}" == " " ]]; then BEST=$FWD; break; fi
      if [[ $BWD -gt 0 && "${TITLE:BWD:1}" == " " ]]; then BEST=$BWD; break; fi
    done
    if [[ $BEST -gt 0 ]]; then
      printf '%s\n%s' "${TITLE:0:BEST}" "${TITLE:BEST+1}" > "$PORT_TITLE_FILE"
    else
      printf '%s' "$TITLE" > "$PORT_TITLE_FILE"
    fi
  else
    printf '%s' "$TITLE" > "$PORT_TITLE_FILE"
  fi

  PORT_UPNEXT_FILE="/tmp/streamer-upnext-portrait.txt"
  if [[ ${#NEXT_TITLE} -gt $PORT_MAX_LINE ]]; then
    TARGET=$(( ${#NEXT_TITLE} / 2 ))
    BEST=-1
    for ((d=0; d < ${#NEXT_TITLE}; d++)); do
      FWD=$((TARGET + d)); BWD=$((TARGET - d))
      if [[ $FWD -lt ${#NEXT_TITLE} && "${NEXT_TITLE:FWD:1}" == " " ]]; then BEST=$FWD; break; fi
      if [[ $BWD -gt 0 && "${NEXT_TITLE:BWD:1}" == " " ]]; then BEST=$BWD; break; fi
    done
    if [[ $BEST -gt 0 ]]; then
      printf '%s\n%s' "${NEXT_TITLE:0:BEST}" "${NEXT_TITLE:BEST+1}" > "$PORT_UPNEXT_FILE"
    else
      printf '%s' "$NEXT_TITLE" > "$PORT_UPNEXT_FILE"
    fi
  else
    printf '%s' "$NEXT_TITLE" > "$PORT_UPNEXT_FILE"
  fi

  LANDSCAPE_WM=()
  if [[ "$WATERMARK" == true && -f "$WM_FONT_SANS" ]]; then
    TITLE_FONTSIZE="h/22"
    if [[ ${#TITLE} -gt $((MAX_LINE * 2)) ]]; then
      TITLE_FONTSIZE="h/28"
    fi
    UPNEXT_FONTSIZE="h/22"
    if [[ ${#NEXT_TITLE} -gt $((MAX_LINE * 2)) ]]; then
      UPNEXT_FONTSIZE="h/28"
    fi

    # Broadcast-style lower third:
    # Single semi-transparent background bar, church name always visible,
    # title and "up next" crossfade on a 41s cycle
    CHURCH_NAME="Saint Demetrios Greek Orthodox Church - Seattle, WA"
    LANDSCAPE_WM+=("drawbox=x=0:y=ih-ih/6:w=iw:h=ih/6:color=black@0.5:t=fill")
    LANDSCAPE_WM+=("drawtext=fontfile=${WM_FONT_SERIF}:text='${CHURCH_NAME}':fontsize=h/32:fontcolor=white@0.9:shadowcolor=black@0.6:shadowx=2:shadowy=2:x=w/30:y=h-h/7")
    LANDSCAPE_WM+=("drawtext=fontfile=${WM_FONT_SANS}:textfile=${TITLE_FILE}:fontsize=${TITLE_FONTSIZE}:fontcolor=white:shadowcolor=black@0.8:shadowx=3:shadowy=3:x=w/30:y=h-h/7+h/26:alpha=${ALPHA_MAIN}")
    LANDSCAPE_WM+=("drawtext=fontfile=${WM_FONT_SANS}:textfile=${UPNEXT_FILE}:fontsize=${UPNEXT_FONTSIZE}:fontcolor=white:shadowcolor=black@0.8:shadowx=3:shadowy=3:x=w/30:y=h-h/7+h/26:alpha=${ALPHA_NEXT}")
  fi

  # Build -vf argument as an array (avoids word-splitting issues with spaces in text)
  # Probe video duration and write "now playing" state for the web UI
  DURATION=$(ffprobe -v error -show_entries format=duration \
    -of csv=p=0 "$VIDEO" 2>/dev/null || echo "0")
  DURATION=${DURATION%%.*}  # truncate to integer seconds

  # Elapsed/duration time display (bottom right)
  if [[ "${DURATION:-0}" -gt 0 ]]; then
    # Build time display: MM:SS if duration < 1h, else H:MM:SS
    # Use textfile= instead of text= to avoid filter graph escaping issues entirely.
    # File content is read directly by drawtext — colons/commas are literal.
    TIME_FILE="/tmp/streamer-time.txt"
    if [[ -f "$WM_FONT_SANS" ]]; then
      if [[ "$DURATION" -ge 3600 ]]; then
        DUR_H=$((DURATION/3600))
        DUR_M=$(( (DURATION%3600)/60 ))
        DUR_S=$((DURATION%60))
        DUR_FMT=$(printf '%d:%02d:%02d' "$DUR_H" "$DUR_M" "$DUR_S")
        printf '%%{eif:trunc(min(t,%d)/3600):d}:%%{eif:mod(trunc(min(t,%d)/60),60):d:2}:%%{eif:mod(trunc(min(t,%d)),60):d:2} / %s' \
          "$DURATION" "$DURATION" "$DURATION" "$DUR_FMT" > "$TIME_FILE"
      else
        DUR_M=$((DURATION/60))
        DUR_S=$((DURATION%60))
        DUR_FMT=$(printf '%d:%02d' "$DUR_M" "$DUR_S")
        printf '%%{eif:trunc(min(t,%d)/60):d}:%%{eif:mod(trunc(min(t,%d)),60):d:2} / %s' \
          "$DURATION" "$DURATION" "$DUR_FMT" > "$TIME_FILE"
      fi
      LANDSCAPE_WM+=("drawtext=fontfile=${WM_FONT_SANS}:textfile=${TIME_FILE}:fontsize=h/40:fontcolor=white@0.8:shadowcolor=black@0.6:shadowx=1:shadowy=1:x=w-tw-w/30:y=h-h/20")
    fi
  fi

  # --- Portrait HUD: time display + progress bar just below video ---
  PORTRAIT_HUD=""
  if [[ "${DURATION:-0}" -gt 0 && -f "$WM_FONT_SANS" ]]; then
    PORTRAIT_HUD=",drawtext=fontfile=${WM_FONT_SANS}:textfile=${TIME_FILE}:fontsize=${PORT_FONT_TIME}:fontcolor=white@0.8:shadowcolor=black@0.6:shadowx=1:shadowy=1:x=w-tw-w/15:y=${PORT_VID_BOTTOM}+10"
    PORTRAIT_HUD="${PORTRAIT_HUD},drawbox=x=0:y=${PORT_VID_BOTTOM}:w=${PORT_W}*t/${DURATION}:h=${PORT_PROGRESS_H}:color=red:thickness=fill:eval=frame"
  fi

  NOW_FILE="/run/streamer-now.json"
  python3 -c "
import json, sys
with open('$NOW_FILE', 'w') as f:
    json.dump({'file': sys.argv[1], 'startedAt': int(sys.argv[2]), 'duration': int(sys.argv[3])}, f)
" "$VIDEO" "$(date +%s)" "${DURATION:-0}"

  # Build filter_complex: apply filters, split into stream + preview + optional portrait
  PREVIEW_LANDSCAPE="/opt/yt/web/frontend/stream-preview.jpg"
  PREVIEW_PORTRAIT="/opt/yt/web/frontend/stream-preview-portrait.jpg"

  # Common VF string (scale only — for portrait and pre-split in dual mode)
  COMMON_VF_STRING=""
  if [[ ${#SCALE_VF[@]} -gt 0 ]]; then
    COMMON_VF_STRING="$(IFS=,; echo "${SCALE_VF[*]}"),"
  fi

  # Full landscape VF string (scale + watermark — for landscape-only mode)
  ALL_LANDSCAPE=("${SCALE_VF[@]}" "${LANDSCAPE_WM[@]}")
  LANDSCAPE_VF_STRING=""
  if [[ ${#ALL_LANDSCAPE[@]} -gt 0 ]]; then
    LANDSCAPE_VF_STRING="$(IFS=,; echo "${ALL_LANDSCAPE[*]}"),"
  fi

  # Landscape watermark chain (applied after split in dual mode)
  LANDSCAPE_WM_CHAIN="null"
  if [[ ${#LANDSCAPE_WM[@]} -gt 0 ]]; then
    LANDSCAPE_WM_CHAIN="$(IFS=,; echo "${LANDSCAPE_WM[*]}")"
  fi

  # Check if input has an audio stream
  HAS_AUDIO=$(ffprobe -v error -select_streams a:0 \
    -show_entries stream=codec_type -of csv=p=0 "$VIDEO" 2>/dev/null || echo "")

  EXTRA_INPUTS=()
  if [[ -z "$HAS_AUDIO" ]]; then
    echo "  No audio stream — generating silence"
    EXTRA_INPUTS=("-f" "lavfi" "-t" "${DURATION:-0}" "-i" "anullsrc=r=44100:cl=stereo")
    AUDIO_FILTER="[1:a]anull[audio]"
  else
    # Normalize audio loudness to -14 LUFS (YouTube standard) with -1 dBTP true peak
    AUDIO_FILTER="[0:a:0]loudnorm=I=-14:TP=-1:LRA=11[audio]"
  fi

  # --- Determine which streams are active ---
  STREAM_LANDSCAPE=false
  STREAM_PORTRAIT=false
  if [[ -f /run/streamer-active-landscape && -n "$LANDSCAPE_RTMP" ]]; then
    STREAM_LANDSCAPE=true
  fi
  if [[ -f /run/streamer-active-portrait && -n "$PORTRAIT_RTMP" ]]; then
    STREAM_PORTRAIT=true
  fi

  # Fallback: only when NO signal files exist (before scheduler first runs)
  if [[ ! -f /run/streamer-active-landscape && ! -f /run/streamer-active-portrait ]]; then
    if [[ -n "$LANDSCAPE_RTMP" ]]; then
      STREAM_LANDSCAPE=true
    elif [[ -n "$PORTRAIT_RTMP" ]]; then
      STREAM_PORTRAIT=true
    fi
  fi

  echo "  Active streams: landscape=$STREAM_LANDSCAPE portrait=$STREAM_PORTRAIT"

  # If no streams are active (signal files exist but keys are missing), skip
  if [[ "$STREAM_LANDSCAPE" == false && "$STREAM_PORTRAIT" == false ]]; then
    echo "  WARNING: No active streams — signal files present but stream keys unavailable"
    sleep 10
    continue
  fi

  # --- Build filter_complex and output args based on active streams ---
  OUTPUT_ARGS=()

  if [[ "$STREAM_LANDSCAPE" == true && "$STREAM_PORTRAIT" == true ]]; then
    # Dual output: scale before split, watermark on landscape branch only
    PORTRAIT_FONT_SERIF="$WM_FONT_SERIF"
    PORTRAIT_FONT_SANS="$WM_FONT_SANS"
    FILTER_COMPLEX="[0:v]${COMMON_VF_STRING}split=3[land_src][port_src][prev_land_src];\
[land_src]${LANDSCAPE_WM_CHAIN}[land];\
[prev_land_src]fps=1/10,scale=640:-2[preview_land];\
[port_src]scale=${PORT_W}:-2:force_original_aspect_ratio=decrease,pad=${PORT_W}:${PORT_H}:(ow-iw)/2:${PORT_PAD_Y}:black,\
drawtext=fontfile=${PORTRAIT_FONT_SERIF}:text='${PORTRAIT_CHURCH_NAME}':fontsize=${PORT_FONT_CHURCH}:fontcolor=white:x=(w-tw)/2:y=${PORT_Y_CHURCH},\
drawtext=fontfile=${PORTRAIT_FONT_SANS}:text='${PORTRAIT_CHURCH_LOCATION}':fontsize=${PORT_FONT_LOCATION}:fontcolor=white@0.85:x=(w-tw)/2:y=${PORT_Y_LOCATION},\
drawtext=fontfile=${PORTRAIT_FONT_SANS}:textfile=${PORT_TITLE_FILE}:fontsize=${PORT_FONT_TITLE}:fontcolor=white:shadowcolor=black@0.8:shadowx=2:shadowy=2:x=(w-tw)/2:y=${PORT_Y_TITLE}:alpha=${ALPHA_MAIN},\
drawtext=fontfile=${PORTRAIT_FONT_SANS}:textfile=${PORT_UPNEXT_FILE}:fontsize=${PORT_FONT_TITLE}:fontcolor=white@0.85:shadowcolor=black@0.8:shadowx=2:shadowy=2:x=(w-tw)/2:y=${PORT_Y_TITLE}:alpha=${ALPHA_NEXT}${PORTRAIT_HUD},\
split=2[portrait][prev_port_src];\
[prev_port_src]fps=1/10,scale=-2:480[preview_port];\
${AUDIO_FILTER};\
[audio]asplit=2[audio_land][audio_port]"
    OUTPUT_ARGS+=(
      -map "[land]" -map "[audio_land]"
      -c:v libx264 -preset veryfast -maxrate "$MAXRATE" -bufsize "$BUFSIZE"
      -pix_fmt yuv420p -force_key_frames "expr:gte(t,n_forced*2)"
      -c:a aac -b:a "$AUDIO_BR" -ar 44100
      -f flv "$LANDSCAPE_RTMP"
      -map "[portrait]" -map "[audio_port]"
      -c:v libx264 -preset veryfast -maxrate "$MAXRATE" -bufsize "$BUFSIZE"
      -pix_fmt yuv420p -force_key_frames "expr:gte(t,n_forced*2)"
      -c:a aac -b:a "$AUDIO_BR" -ar 44100
      -f flv "$PORTRAIT_RTMP"
      -map "[preview_land]"
      -update 1 -q:v 3 "$PREVIEW_LANDSCAPE"
      -map "[preview_port]"
      -update 1 -q:v 3 "$PREVIEW_PORTRAIT"
    )
  elif [[ "$STREAM_LANDSCAPE" == true ]]; then
    # Landscape only (original behavior)
    rm -f "$PREVIEW_PORTRAIT"
    FILTER_COMPLEX="[0:v]${LANDSCAPE_VF_STRING}split=2[stream][prev];[prev]fps=1/10,scale=640:-2[preview];${AUDIO_FILTER}"
    OUTPUT_ARGS+=(
      -map "[stream]" -map "[audio]"
      -c:v libx264 -preset veryfast -maxrate "$MAXRATE" -bufsize "$BUFSIZE"
      -pix_fmt yuv420p -force_key_frames "expr:gte(t,n_forced*2)"
      -c:a aac -b:a "$AUDIO_BR" -ar 44100
      -f flv "$LANDSCAPE_RTMP"
      -map "[preview]"
      -update 1 -q:v 3 "$PREVIEW_LANDSCAPE"
    )
  elif [[ "$STREAM_PORTRAIT" == true ]]; then
    # Portrait only (no landscape watermark — portrait has its own overlays)
    rm -f "$PREVIEW_LANDSCAPE"
    PORTRAIT_FONT_SERIF="$WM_FONT_SERIF"
    PORTRAIT_FONT_SANS="$WM_FONT_SANS"
    FILTER_COMPLEX="[0:v]${COMMON_VF_STRING}\
scale=${PORT_W}:-2:force_original_aspect_ratio=decrease,pad=${PORT_W}:${PORT_H}:(ow-iw)/2:${PORT_PAD_Y}:black,\
drawtext=fontfile=${PORTRAIT_FONT_SERIF}:text='${PORTRAIT_CHURCH_NAME}':fontsize=${PORT_FONT_CHURCH}:fontcolor=white:x=(w-tw)/2:y=${PORT_Y_CHURCH},\
drawtext=fontfile=${PORTRAIT_FONT_SANS}:text='${PORTRAIT_CHURCH_LOCATION}':fontsize=${PORT_FONT_LOCATION}:fontcolor=white@0.85:x=(w-tw)/2:y=${PORT_Y_LOCATION},\
drawtext=fontfile=${PORTRAIT_FONT_SANS}:textfile=${PORT_TITLE_FILE}:fontsize=${PORT_FONT_TITLE}:fontcolor=white:shadowcolor=black@0.8:shadowx=2:shadowy=2:x=(w-tw)/2:y=${PORT_Y_TITLE}:alpha=${ALPHA_MAIN},\
drawtext=fontfile=${PORTRAIT_FONT_SANS}:textfile=${PORT_UPNEXT_FILE}:fontsize=${PORT_FONT_TITLE}:fontcolor=white@0.85:shadowcolor=black@0.8:shadowx=2:shadowy=2:x=(w-tw)/2:y=${PORT_Y_TITLE}:alpha=${ALPHA_NEXT}${PORTRAIT_HUD},\
split=2[portrait][prev_port];\
[prev_port]fps=1/10,scale=-2:480[preview];\
${AUDIO_FILTER}"
    OUTPUT_ARGS+=(
      -map "[portrait]" -map "[audio]"
      -c:v libx264 -preset veryfast -maxrate "$MAXRATE" -bufsize "$BUFSIZE"
      -pix_fmt yuv420p -force_key_frames "expr:gte(t,n_forced*2)"
      -c:a aac -b:a "$AUDIO_BR" -ar 44100
      -f flv "$PORTRAIT_RTMP"
      -map "[preview]"
      -update 1 -q:v 3 "$PREVIEW_PORTRAIT"
    )
  fi

  # Always re-encode to guarantee keyframes every 2 seconds (YouTube requires ≤4s)
  ffmpeg -y -re -i "$VIDEO" "${EXTRA_INPUTS[@]}" \
    -filter_complex "$FILTER_COMPLEX" \
    "${OUTPUT_ARGS[@]}" </dev/null || true

  # Update bookmark after each video completes (or is interrupted)
  python3 -c "
import json, sys
with open('$STATE_FILE', 'w') as f:
    json.dump({'index': int(sys.argv[1]), 'file': sys.argv[2]}, f)
" "$INDEX" "$VIDEO"
  echo "  Bookmark saved: index $INDEX"

  # Check for graceful restart signal (set by web UI after an update)
  RESTART_SIGNAL="/run/streamer-restart-requested"
  if [[ -f "$RESTART_SIGNAL" ]]; then
    rm -f "$RESTART_SIGNAL"
    echo "Restart signal detected — exiting for service restart."
    exit 0
  fi

  # Check for stop-after-current signal (set by web UI)
  STOP_SIGNAL="/run/streamer-stop-after-current"
  if [[ -f "$STOP_SIGNAL" ]]; then
    rm -f "$STOP_SIGNAL"
    echo "Stop-after-current signal detected — stopping streamer."
    exit 0
  fi

  # Advance to next video (wrap around)
  INDEX=$(( (INDEX + 1) % NUM_VIDEOS ))
done


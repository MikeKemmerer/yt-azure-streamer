#!/usr/bin/env bash
set -euo pipefail

# Streamer service: plays videos from blobfuse2 in playlist order to YouTube
# RTMP, with bookmark-based resume and configurable max resolution.
#
# Config is read from /etc/yt/schedule.json:
#   "stream": { "max_resolution": "720p" }
#
# Supported resolutions: 144p 240p 360p 480p 720p 1080p 1440p 2160p
# Videos below max_resolution are NOT upsampled.

PREFIX=$(cat /etc/yt/nameprefix 2>/dev/null || echo "unknown")
KV_NAME="${PREFIX,,}-kv"

VIDEO_DIR="/mnt/blobfuse2"
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

# --- Fetch YouTube stream key ---
echo "Fetching stream key from Key Vault '$KV_NAME'..."
az login --identity >/dev/null 2>&1

STREAM_KEY=$(az keyvault secret show \
  --vault-name "$KV_NAME" \
  --name "youtube-stream-key" \
  --query value \
  -o tsv 2>/dev/null || true)

if [[ -z "$STREAM_KEY" ]]; then
  echo "ERROR: 'youtube-stream-key' secret not found in Key Vault '$KV_NAME'."
  echo "       Set it with:"
  echo "         az keyvault secret set --vault-name $KV_NAME --name youtube-stream-key --value <YOUR_KEY>"
  exit 1
fi

RTMP_URL="rtmp://a.rtmp.youtube.com/live2/${STREAM_KEY}"

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
  VF_PARTS=()
  if [[ "$INPUT_H" -gt "$MAX_H" ]]; then
    echo "  Input ${INPUT_H}p > max ${MAX_H}p — downscaling to ${MAX_RES}"
    VF_PARTS+=("$SCALE_FILTER")
  else
    echo "  Input ${INPUT_H}p <= max ${MAX_H}p — no scaling"
  fi

  if [[ "$WATERMARK" == true && -f "$WM_FONT_SANS" ]]; then
    # Split title into max 2 lines; shrink font if title is very long
    MAX_LINE=55
    TITLE_FILE="/tmp/streamer-title.txt"
    TITLE_FONTSIZE="h/22"
    # Force max 2 lines — if title is too long for 2 lines, shrink font
    if [[ ${#TITLE} -gt $((MAX_LINE * 2)) ]]; then
      TITLE_FONTSIZE="h/28"
    fi
    NUM_LINES=1
    if [[ ${#TITLE} -gt $MAX_LINE ]]; then
      NUM_LINES=2
    fi
    if [[ $NUM_LINES -eq 2 ]]; then
      # Split at the space nearest the midpoint
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

    # --- "Up Next" cycling text ---
    UPNEXT_FILE="/tmp/streamer-upnext.txt"
    NEXT_INDEX=$(( (INDEX + 1) % NUM_VIDEOS ))
    NEXT_BASENAME=$(basename "${VIDEOS[$NEXT_INDEX]}")
    NEXT_DISPLAY="${NEXT_BASENAME%.*}"
    # Check for custom display title for next video
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
    UPNEXT_FONTSIZE="h/22"
    if [[ ${#NEXT_TITLE} -gt $((MAX_LINE * 2)) ]]; then
      UPNEXT_FONTSIZE="h/28"
    fi
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
    # Timeline: 0-32.5 main=1, 32.5-33 fade out main/fade in next, 33-40 next=1, 40-41 fade out next/fade in main
    ALPHA_MAIN='if(lt(mod(t\,41)\,32.5)\,1\,if(lt(mod(t\,41)\,33)\,(33-mod(t\,41))/0.5\,if(lt(mod(t\,41)\,40)\,0\,(mod(t\,41)-40)/0.5)))'
    ALPHA_NEXT='if(lt(mod(t\,41)\,32.5)\,0\,if(lt(mod(t\,41)\,33)\,(mod(t\,41)-32.5)/0.5\,if(lt(mod(t\,41)\,40)\,1\,(41-mod(t\,41))/0.5)))'

    # Broadcast-style lower third:
    # Single semi-transparent background bar, church name always visible,
    # title and "up next" crossfade on a 41s cycle
    CHURCH_NAME="Saint Demetrios Greek Orthodox Church - Seattle, WA"
    VF_PARTS+=("drawbox=x=0:y=ih-ih/6:w=iw:h=ih/6:color=black@0.5:t=fill")
    VF_PARTS+=("drawtext=fontfile=${WM_FONT_SERIF}:text='${CHURCH_NAME}':fontsize=h/32:fontcolor=white@0.9:shadowcolor=black@0.6:shadowx=2:shadowy=2:x=w/30:y=h-h/7")
    VF_PARTS+=("drawtext=fontfile=${WM_FONT_SANS}:textfile=${TITLE_FILE}:fontsize=${TITLE_FONTSIZE}:fontcolor=white:shadowcolor=black@0.8:shadowx=3:shadowy=3:x=w/30:y=h-h/7+h/26:alpha=${ALPHA_MAIN}")
    VF_PARTS+=("drawtext=fontfile=${WM_FONT_SANS}:textfile=${UPNEXT_FILE}:fontsize=${UPNEXT_FONTSIZE}:fontcolor=white:shadowcolor=black@0.8:shadowx=3:shadowy=3:x=w/30:y=h-h/7+h/26:alpha=${ALPHA_NEXT}")
  fi

  # Build -vf argument as an array (avoids word-splitting issues with spaces in text)
  # Probe video duration and write "now playing" state for the web UI
  DURATION=$(ffprobe -v error -show_entries format=duration \
    -of csv=p=0 "$VIDEO" 2>/dev/null || echo "0")
  DURATION=${DURATION%%.*}  # truncate to integer seconds

  # Progress bar (0.5% height at very bottom) and elapsed/remaining time (bottom right)
  if [[ "${DURATION:-0}" -gt 0 ]]; then
    VF_PARTS+=("drawbox=x=0:y=ih-ih/200:w=iw*(t/${DURATION}):h=ih/200:color=red@0.8:t=fill")
    # Build time display: MM:SS if duration < 1h, else H:MM:SS
    if [[ "$DURATION" -ge 3600 ]]; then
      # Elapsed with hours: H:MM:SS
      ELAPSED_EXPR='%{eif\\:trunc(t/3600)\\:d}\\:%{eif\\:mod(trunc(t/60)\\,60)\\:d\\:2}\\:%{eif\\:mod(trunc(t)\\,60)\\:d\\:2}'
      DUR_H=$((DURATION/3600))
      DUR_M=$(( (DURATION%3600)/60 ))
      DUR_S=$((DURATION%60))
      DUR_FMT=$(printf '%d\\:%02d\\:%02d' "$DUR_H" "$DUR_M" "$DUR_S")
    else
      # Elapsed without hours: M:SS or MM:SS
      ELAPSED_EXPR='%{eif\\:trunc(t/60)\\:d}\\:%{eif\\:mod(trunc(t)\\,60)\\:d\\:2}'
      DUR_M=$((DURATION/60))
      DUR_S=$((DURATION%60))
      DUR_FMT=$(printf '%d\\:%02d' "$DUR_M" "$DUR_S")
    fi
    VF_PARTS+=("drawtext=fontfile=${WM_FONT_SANS}:text='${ELAPSED_EXPR} / ${DUR_FMT}':fontsize=h/40:fontcolor=white@0.8:shadowcolor=black@0.6:shadowx=1:shadowy=1:x=w-tw-w/30:y=h-h/7")
  fi

  NOW_FILE="/run/streamer-now.json"
  python3 -c "
import json, sys
with open('$NOW_FILE', 'w') as f:
    json.dump({'file': sys.argv[1], 'startedAt': int(sys.argv[2]), 'duration': int(sys.argv[3])}, f)
" "$VIDEO" "$(date +%s)" "${DURATION:-0}"

  # Build filter_complex: apply filters, split into stream + preview
  PREVIEW_FILE="/opt/yt/web/frontend/stream-preview.jpg"
  VF_STRING=""
  if [[ ${#VF_PARTS[@]} -gt 0 ]]; then
    VF_STRING="$(IFS=,; echo "${VF_PARTS[*]}"),"
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

  FILTER_COMPLEX="[0:v]${VF_STRING}split=2[stream][prev];[prev]fps=1/10,scale=640:-2[preview];${AUDIO_FILTER}"

  # Always re-encode to guarantee keyframes every 2 seconds (YouTube requires ≤4s)
  # The split sends the same filtered video to both RTMP and a periodic JPEG preview
  ffmpeg -y -re -i "$VIDEO" "${EXTRA_INPUTS[@]}" \
    -filter_complex "$FILTER_COMPLEX" \
    -map "[stream]" -map "[audio]" \
    -c:v libx264 -preset veryfast -maxrate "$MAXRATE" -bufsize "$BUFSIZE" \
    -pix_fmt yuv420p -force_key_frames "expr:gte(t,n_forced*2)" \
    -c:a aac -b:a "$AUDIO_BR" -ar 44100 \
    -f flv "$RTMP_URL" \
    -map "[preview]" \
    -update 1 -q:v 3 "$PREVIEW_FILE" </dev/null || true

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

  # Advance to next video (wrap around)
  INDEX=$(( (INDEX + 1) % NUM_VIDEOS ))
done


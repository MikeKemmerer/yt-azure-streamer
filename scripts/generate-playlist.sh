#!/usr/bin/env bash
set -euo pipefail

# Generate an ffmpeg-compatible concat playlist from video files in the
# blobfuse2 mount.  Files with date-prefixed names (e.g. "January 2, 2025 -
# Sermon.mp4") are sorted chronologically; other files sort alphabetically
# after all dated files.
#
# With --shuffle, the playlist is randomized instead.  The random order is
# written to disk and preserved until the playlist is regenerated.
#
# Usage: generate-playlist.sh [--shuffle] [VIDEO_DIR] [PLAYLIST_FILE]

SHUFFLE=false
if [[ "${1:-}" == "--shuffle" ]]; then
  SHUFFLE=true
  shift
fi

VIDEO_DIR="${1:-/mnt/blobfuse2}"
PLAYLIST_FILE="${2:-/etc/yt/playlist.txt}"
PLAYLIST_CONFIG="/etc/yt/playlist-config.json"

echo "Scanning $VIDEO_DIR for video files..."

# ─── Check for playlist-config.json (managed by web UI) ────────────
# If the config exists and has entries, use it for ordering and filtering.
# This takes priority over date-sorting and shuffle.

if [[ -f "$PLAYLIST_CONFIG" ]] && command -v python3 &>/dev/null; then
  mapfile -t config_files < <(python3 -c "
import json, sys, os
try:
  cfg = json.load(open('$PLAYLIST_CONFIG'))
  for v in cfg.get('videos', []):
    if v.get('enabled', True):
      fp = os.path.join('$VIDEO_DIR', v['file'])
      if os.path.isfile(fp):
        print(fp)
except Exception as e:
  print(f'ERROR: {e}', file=sys.stderr)
  sys.exit(1)
" 2>/dev/null)

  if [[ ${#config_files[@]} -gt 0 ]]; then
    echo "Using playlist-config.json (${#config_files[@]} enabled videos)"
    : > "$PLAYLIST_FILE"
    for f in "${config_files[@]}"; do
      escaped="${f//\'/\'\\\'\'}"
      echo "file '${escaped}'" >> "$PLAYLIST_FILE"
    done
    echo "Playlist written to $PLAYLIST_FILE (${#config_files[@]} files)"
    exit 0
  fi
  echo "playlist-config.json found but no enabled videos matched — falling back to directory scan."
fi

# Sort helper: extracts a date from filenames like "January 2, 2025 - Sermon.mp4"
# and outputs "YYYY-MM-DD<TAB>filepath" for date-based sorting.
# Files without a parseable date get "9999-99-99" so they sort last alphabetically.
date_sort_key() {
  local filepath="$1"
  local basename
  basename="$(basename "$filepath")"
  # Try to parse a date from the beginning of the filename using GNU date
  # Matches patterns like: "January 2, 2025", "April 12, 2026", "Dec 25, 2024"
  local parsed=""
  if [[ "$basename" =~ ^([A-Za-z]+[[:space:]]+[0-9]{1,2},[[:space:]]*[0-9]{4}) ]]; then
    parsed=$(date -d "${BASH_REMATCH[1]}" '+%Y-%m-%d' 2>/dev/null || true)
  fi
  if [[ -n "$parsed" ]]; then
    printf '%s\t%s\n' "$parsed" "$filepath"
  else
    printf '9999-99-99\t%s\n' "$filepath"
  fi
}

# Collect video files (common extensions), sorted by date then alphabetically
mapfile -t raw_files < <(find "$VIDEO_DIR" -maxdepth 1 -type f \
  \( -iname '*.mp4' -o -iname '*.mkv' -o -iname '*.mov' -o -iname '*.avi' -o -iname '*.ts' -o -iname '*.flv' \))

# Sort: shuffle randomly, or by date then alphabetically
if [[ "$SHUFFLE" == true ]]; then
  mapfile -t files < <(printf '%s\n' "${raw_files[@]}" | shuf)
else
  mapfile -t files < <(
    for f in "${raw_files[@]}"; do
      date_sort_key "$f"
    done | sort -t$'\t' -k1,1 -k2,2 | cut -f2
  )
fi

if [[ ${#files[@]} -eq 0 ]]; then
  echo "ERROR: No video files found in $VIDEO_DIR"
  exit 1
fi

# Write ffmpeg concat demuxer format
: > "$PLAYLIST_FILE"
for f in "${files[@]}"; do
  # Escape single quotes for ffmpeg concat format
  escaped="${f//\'/\'\\\'\'}"
  echo "file '${escaped}'" >> "$PLAYLIST_FILE"
done

echo "Playlist written to $PLAYLIST_FILE (${#files[@]} files)"

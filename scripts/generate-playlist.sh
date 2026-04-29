#!/usr/bin/env bash
set -euo pipefail

# Generate an ffmpeg-compatible concat playlist from video files in the
# blobfuse2 mount.  Sorted alphabetically so playback order is predictable.
#
# Usage: generate-playlist.sh [VIDEO_DIR] [PLAYLIST_FILE]

VIDEO_DIR="${1:-/mnt/blobfuse2}"
PLAYLIST_FILE="${2:-/opt/yt/playlist.txt}"

echo "Scanning $VIDEO_DIR for video files..."

# Collect video files (common extensions), sorted alphabetically
mapfile -t files < <(find "$VIDEO_DIR" -maxdepth 1 -type f \
  \( -iname '*.mp4' -o -iname '*.mkv' -o -iname '*.mov' -o -iname '*.avi' -o -iname '*.ts' -o -iname '*.flv' \) \
  | sort)

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

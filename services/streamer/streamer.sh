#!/usr/bin/env bash
set -euo pipefail

# Streamer service: fetches the YouTube stream key from Key Vault and
# runs an ffmpeg pipeline to push a video file from blobfuse2 to YouTube RTMP.
# Place the video file at /mnt/blobfuse2/stream.mp4 (loops continuously).

PREFIX=$(cat /etc/nameprefix 2>/dev/null || echo "unknown")
# /etc/nameprefix stores the user-supplied namePrefix (original casing from ARM parameter).
# ARM's keyVaultName = toLower(namePrefix)-kv, so we match it with ${PREFIX,,}.
KV_NAME="${PREFIX,,}-kv"

echo "Streamer starting with prefix: $PREFIX"

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

INPUT="/mnt/blobfuse2/stream.mp4"
RTMP_URL="rtmp://a.rtmp.youtube.com/live2/${STREAM_KEY}"

if [[ ! -f "$INPUT" ]]; then
  echo "ERROR: Input file '$INPUT' not found on blobfuse2 mount."
  exit 1
fi

echo "Starting ffmpeg stream to YouTube..."
exec ffmpeg \
  -re \
  -stream_loop -1 \
  -i "$INPUT" \
  -c:v libx264 -preset veryfast -maxrate 3000k -bufsize 6000k \
  -pix_fmt yuv420p -g 50 \
  -c:a aac -b:a 128k -ar 44100 \
  -f flv "$RTMP_URL"


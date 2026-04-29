#!/usr/bin/env bash
set -euo pipefail

# package.sh
# Creates a clean ZIP of the repo without .git or build artifacts.

OUT="yt-azure-streamer.zip"

echo "Packaging repository into $OUT..."

zip -r "$OUT" . \
  -x ".git/*" \
  -x ".gitignore" \
  -x "tools/*" \
  -x "*.zip" \
  -x "*.tmp" \
  -x "*.log"

echo "Package created: $OUT"

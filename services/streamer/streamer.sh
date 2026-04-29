#!/usr/bin/env bash
set -euo pipefail

# Streamer service stub
# This will eventually:
# - read namePrefix from /etc/nameprefix
# - mount blobfuse2
# - run ffmpeg or your chosen pipeline
# - push to YouTube RTMP

PREFIX=$(cat /etc/nameprefix 2>/dev/null || echo "unknown")

echo "Streamer starting with prefix: $PREFIX"
# TODO: implement ffmpeg pipeline

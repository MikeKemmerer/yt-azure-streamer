#!/usr/bin/env bash
set -euo pipefail

# Scheduler service stub
# This will eventually:
# - read namePrefix from /etc/nameprefix
# - determine next start/stop times
# - update local schedule files
# - call schedule-sync.sh

PREFIX=$(cat /etc/nameprefix 2>/dev/null || echo "unknown")

echo "Scheduler running with prefix: $PREFIX"
# TODO: implement schedule logic

#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
WORK_DIR=$(mktemp -d)
trap 'rm -rf "$WORK_DIR"' EXIT

PLAYBACK=$(sed -n '/# Always re-encode at 30 fps CFR/,/# Update bookmark/{
  /# Update bookmark/d
  p
}' "$ROOT_DIR/services/streamer/streamer.sh")
[[ -n "$PLAYBACK" ]]

VIDEO="fixture.mp4"
EXTRA_INPUTS=()
OUTPUT_ARGS=()
FILTER_COMPLEX=""
SKIP_SIGNAL="$WORK_DIR/skip"

sleep() {
  if [[ "$1" != 10 ]]; then command sleep "$@"; fi
}

run_case() {
  local outcome="$1" expected="$2"
  local advanced=false
  rm -f "$SKIP_SIGNAL"
  ffmpeg() {
    if [[ "$outcome" == skip ]]; then
      exec sleep 30
    fi
    command sleep 0.2
    return "$outcome"
  }
  if [[ "$outcome" == skip ]]; then
    (command sleep 0.2; touch "$SKIP_SIGNAL") &
    local requester=$!
  fi
  for attempt in 1; do
    eval "$PLAYBACK"
    advanced=true
  done
  if [[ "$outcome" == skip ]]; then
    wait "$requester"
    [[ "$SKIPPED" == true && "$FFMPEG_STATUS" -ne 0 ]]
    [[ ! -f "$SKIP_SIGNAL" ]]
  fi
  if [[ "$advanced" != "$expected" ]]; then
    echo "FAIL: $outcome: expected advancement=$expected, got $advanced" >&2
    exit 1
  fi
}

run_case 0 true
run_case 42 false
run_case skip true
echo "Streamer skip tests passed."

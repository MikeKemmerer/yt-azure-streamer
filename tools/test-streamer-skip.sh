#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
WORK_DIR=$(mktemp -d)
trap 'rm -rf "$WORK_DIR"' EXIT

PLAYBACK=$(sed -n '/# Always re-encode at 30 fps CFR/,/# Failed playback must retain its bookmark/{
  /# Failed playback must retain its bookmark/d
  p
}' "$ROOT_DIR/services/streamer/streamer.sh")
[[ -n "$PLAYBACK" ]]

VIDEO="fixture.mp4"
EXTRA_INPUTS=()
OUTPUT_ARGS=()
FILTER_COMPLEX=""
SKIP_SIGNAL="$WORK_DIR/skip"
STOP_SIGNAL="$WORK_DIR/stop"
RESTART_SIGNAL="$WORK_DIR/restart"
MANUAL_STOP="$WORK_DIR/manual-stop"
MANUAL_OVERRIDE="$WORK_DIR/manual-override"

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

BOOKMARK=$(sed -n '/# Failed playback must retain its bookmark/,/# An explicit stop job/{
  /# An explicit stop job/d
  p
}' "$ROOT_DIR/services/streamer/streamer.sh")
CONTROL=$(sed -n '/# An explicit stop job/,/# Adopt playlist changes/{
  /# Adopt playlist changes/d
  p
}' "$ROOT_DIR/services/streamer/streamer.sh")
[[ -n "$BOOKMARK" && -n "$CONTROL" ]]
STATE_FILE="$WORK_DIR/bookmark"
INDEX=0

run_control_case() {
  local outcome="$1" action="$2"
  rm -f "$SKIP_SIGNAL" "$STOP_SIGNAL" "$RESTART_SIGNAL" "$MANUAL_STOP" "$WORK_DIR/systemctl"
  echo previous > "$STATE_FILE"
  touch "$MANUAL_OVERRIDE" "$RESTART_SIGNAL"
  if [[ "$action" == stop ]]; then touch "$STOP_SIGNAL"; fi
  ffmpeg() { return "$outcome"; }
  python3() { echo current > "$STATE_FILE"; }
  systemctl() { printf '%s\n' "$*" > "$WORK_DIR/systemctl"; }
  (
    for attempt in 1; do
      eval "$PLAYBACK"
      eval "$BOOKMARK"
      eval "$CONTROL"
      echo "FAIL: pending control was ignored" >&2
      exit 1
    done
    echo "FAIL: pending control entered retry loop" >&2
    exit 1
  )
  [[ ! -f "$RESTART_SIGNAL" ]]
  if [[ "$outcome" == 0 ]]; then
    [[ "$(cat "$STATE_FILE")" == current ]]
  else
    [[ "$(cat "$STATE_FILE")" == previous ]]
  fi
  if [[ "$action" == stop ]]; then
    [[ -f "$MANUAL_STOP" && ! -f "$MANUAL_OVERRIDE" && ! -f "$STOP_SIGNAL" ]]
    [[ "$(cat "$WORK_DIR/systemctl")" == 'stop --no-block streamer.service' ]]
  else
    [[ -f "$MANUAL_OVERRIDE" && ! -f "$MANUAL_STOP" && ! -f "$WORK_DIR/systemctl" ]]
  fi
}

run_control_case 0 stop
run_control_case 42 stop
run_control_case 42 restart

SCHEDULER=$(sed -n '/^while true; do/,$p' "$ROOT_DIR/services/scheduler/scheduler.sh")
QUEUE_HOLD="$WORK_DIR/queue-hold"
YOUTUBE_OWNER="$WORK_DIR/youtube-owner.json"
ACTIVE_LANDSCAPE="$WORK_DIR/landscape"
ACTIVE_PORTRAIT="$WORK_DIR/portrait"
CHECK_INTERVAL=1
(
  TICK=0
  touch "$QUEUE_HOLD" "$MANUAL_STOP"
  rm -f "$MANUAL_OVERRIDE" "$WORK_DIR/systemctl"
  get_active_streams() {
    if [[ "$TICK" == 1 ]]; then return 1; fi
    echo landscape
  }
  update_stream_signals() { :; }
  youtube_schedule_enabled() { return 1; }
  stream_is_running() { return 1; }
  systemctl() { echo "$*" >> "$WORK_DIR/systemctl"; }
  sleep() {
    TICK=$((TICK + 1))
    if [[ "$TICK" == 3 ]]; then exit 0; fi
  }
  eval "$SCHEDULER"
)
[[ -f "$QUEUE_HOLD" && ! -f "$MANUAL_STOP" && ! -f "$WORK_DIR/systemctl" ]]
echo "Streamer skip and deferred-control tests passed."

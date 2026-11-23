#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
WORK_DIR=$(mktemp -d)
REQUESTER=""
TELEMETRY_PID=""
FFMPEG_PID=""
cleanup() {
  for pid in "$REQUESTER" "$TELEMETRY_PID" "$FFMPEG_PID"; do
    if [[ -n "$pid" ]]; then kill -TERM "$pid" 2>/dev/null || true; fi
  done
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT
mkdir "$WORK_DIR/run" "$WORK_DIR/etc" "$WORK_DIR/media" "$WORK_DIR/overlays"
for name in A B C D; do
  duration=4
  if [[ "$name" == A ]]; then duration=10; fi
  ffmpeg -nostdin -hide_banner -loglevel error -f lavfi -i "color=s=64x64:r=30:d=$duration" \
    -c:v libx264 "$WORK_DIR/media/$name.mp4"
  printf "file '%s/media/%s.mp4'\n" "$WORK_DIR" "$name" >> "$WORK_DIR/etc/playlist.txt"
done

CONTROL_ENABLED=true
CONTROL_REQUEST="$WORK_DIR/run/streamer-control-request.json"
ON_AIR_SIGNAL="$WORK_DIR/run/streamer-onair.json"
PROGRESS_PORT_FILE="$WORK_DIR/run/progress-port"
SKIP_SIGNAL="$WORK_DIR/run/skip"
STOP_SIGNAL="$WORK_DIR/run/streamer-stop-after-current"
RESTART_SIGNAL="$WORK_DIR/run/streamer-restart-requested"
QUEUE_HOLD="$WORK_DIR/run/streamer-queue-hold"
MANUAL_STOP="$WORK_DIR/run/manual-stop"
MANUAL_OVERRIDE="$WORK_DIR/run/manual-override"
STATE_FILE="$WORK_DIR/etc/playlist-state.json"
playback_control() {
  python3 "$ROOT_DIR/services/streamer/streamer-control.py" "$@" \
    --run "$WORK_DIR/run" --etc "$WORK_DIR/etc" --overlays "$WORK_DIR/overlays"
}
cleanup_telemetry() {
  kill -TERM "$TELEMETRY_PID" 2>/dev/null || true
  wait "$TELEMETRY_PID" 2>/dev/null || true
  TELEMETRY_PID=""
  rm -f "$PROGRESS_PORT_FILE"
}
PLAYBACK=$(sed -n '/# Always re-encode at 30 fps CFR/,/# Failed playback must retain its bookmark/{
  /# Failed playback must retain its bookmark/d
  p
}' "$ROOT_DIR/services/streamer/streamer.sh")
BOOKMARK=$(sed -n '/# Failed playback must retain its bookmark/,/# An explicit stop job/{
  /# An explicit stop job/d
  p
}' "$ROOT_DIR/services/streamer/streamer.sh")
QUEUE_TAIL=$(sed -n '/# Adopt playlist changes/,$p' "$ROOT_DIR/services/streamer/streamer.sh" | sed '$d')
mapfile -t CONTROL_PLAYBACK < <(playback_control init --owner "$$" --video-dir "$WORK_DIR/media")
EXTRA_INPUTS=()
OUTPUT_ARGS=(-map "[video]" -c:v libx264 -preset veryfast -f null -)
FILTER_COMPLEX="[0:v]null[video]"

python3 - "$WORK_DIR" <<'PY' &
import json
import os
import sys
import time
from pathlib import Path

root = Path(sys.argv[1])
deadline = time.monotonic() + 35
state_path = root / "run/streamer-control-state.json"

def wait_for(predicate):
    while time.monotonic() < deadline:
        state = json.loads(state_path.read_text())
        if predicate(state):
            return state
        time.sleep(0.1)
    raise AssertionError("Playback acknowledgement timed out")

def submit(state, action_id, operation, **values):
    command = {"id": action_id, "session": state["session"], "revision": state["revision"],
               "operation": operation, **values}
    temporary = root / "run/request.tmp"
    temporary.write_text(json.dumps(command))
    os.replace(temporary, root / "run/streamer-control-request.json")

def applied(action_id):
    return wait_for(lambda state: any(
        action["id"] == action_id and action["status"] == "applied" for action in state["actions"]
    ))

state = wait_for(lambda state: state["current"].get("onAir"))
original_pid = state["current"]["encoderPid"]
submit(state, "reorder", "replace", files=["D.mp4", "B.mp4", "C.mp4"])
state = applied("reorder")
assert state["current"]["encoderPid"] == original_pid, "reorder interrupted the current video"
assert (root / "overlays/streamer-upnext.txt").read_text() == "Up Next: D"
submit(state, "play-now", "now", file="D.mp4")
state = applied("play-now")
assert Path(state["current"]["file"]).name == "D.mp4"
assert state["current"]["encoderPid"] != original_pid
bookmark = json.loads((root / "etc/playlist-state.json").read_text())
assert Path(bookmark["file"]).name == "A.mp4", "one-off must not replace the ordinary bookmark"
submit(state, "queue-next", "next", file="B.mp4")
state = applied("queue-next")
assert [Path(item["file"]).name for item in state["upcoming"]] == ["B.mp4", "C.mp4"]
state = wait_for(lambda state: Path(state["current"]["file"]).name == "B.mp4"
                 and state["current"].get("onAir"))
submit(state, "clear", "replace", files=[])
state = applied("clear")
assert state["explicitEmpty"]
assert Path(state["current"]["file"]).name == "B.mp4"
PY
REQUESTER=$!

for expected in A D B; do
  VIDEO="${CONTROL_PLAYBACK[0]}"
  CURRENT_ORDINARY="${CONTROL_PLAYBACK[1]}"
  INDEX="${CONTROL_PLAYBACK[2]}"
  [[ "$(basename "$VIDEO")" == "$expected.mp4" ]]
  eval "$PLAYBACK"
  FFMPEG_PID=""
  eval "$BOOKMARK"
  if [[ "$expected" != B ]]; then
    mapfile -t CONTROL_PLAYBACK < <(playback_control next)
  fi
done
wait "$REQUESTER"
REQUESTER=""
(
  systemctl() { printf '%s\n' "$*" > "$WORK_DIR/stopped"; }
  eval "$QUEUE_TAIL"
  echo "FAIL: explicitly emptied queue did not stop" >&2
  exit 1
)
[[ -f "$QUEUE_HOLD" && "$(cat "$WORK_DIR/stopped")" == 'stop --no-block streamer.service' ]]
echo "Live reorder, Queue Next, Play Now/on-air return order, bookmarks and explicit-empty stop passed."

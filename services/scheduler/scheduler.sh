#!/usr/bin/env bash
set -euo pipefail

# Scheduler daemon: reads /opt/yt/schedule.json and starts/stops
# streamer.service based on the current time window.
# Runs continuously under systemd (Type=simple, Restart=always).

SCHEDULE_FILE="/opt/yt/schedule.json"
CHECK_INTERVAL=30  # seconds between checks
MANUAL_OVERRIDE="/run/streamer-manual-override"

PREFIX=$(cat /etc/nameprefix 2>/dev/null || echo "unknown")
echo "Scheduler starting with prefix: $PREFIX"

stream_is_running() {
  systemctl is-active --quiet streamer.service 2>/dev/null
}

# Returns exit 0 if we are inside a scheduled stream window, else exit 1.
should_stream_now() {
  [[ -f "$SCHEDULE_FILE" ]] || return 1
  python3 - "$SCHEDULE_FILE" <<'PYEOF'
import sys, json, datetime

try:
    from zoneinfo import ZoneInfo
except ImportError:
    raise RuntimeError("zoneinfo not available — this script requires Python 3.9+ (Ubuntu 22.04+)")

schedule_file = sys.argv[1]
try:
    with open(schedule_file) as f:
        schedule = json.load(f)
except Exception:
    sys.exit(1)

try:
    tz = ZoneInfo(schedule.get("timezone", "UTC"))
except Exception:
    tz = datetime.timezone.utc

now = datetime.datetime.now(tz=tz)
day_map = {"Mon": 0, "Tue": 1, "Wed": 2, "Thu": 3, "Fri": 4, "Sat": 5, "Sun": 6}

for event in schedule.get("events", []):
    days = [day_map[d] for d in event.get("days", []) if d in day_map]
    if now.weekday() not in days:
        continue
    sh, sm = map(int, event["start"].split(":"))
    eh, em = map(int, event["stop"].split(":"))
    start_t = now.replace(hour=sh, minute=sm, second=0, microsecond=0)
    stop_t  = now.replace(hour=eh, minute=em, second=0, microsecond=0)
    if start_t <= now < stop_t:
        sys.exit(0)  # Inside a streaming window

sys.exit(1)  # Not in any streaming window
PYEOF
}

while true; do
  if should_stream_now; then
    # Inside a schedule window — clear any manual override (schedule takes over)
    if [[ -f "$MANUAL_OVERRIDE" ]]; then
      echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) Entered scheduled window — clearing manual override"
      rm -f "$MANUAL_OVERRIDE"
    fi
    if ! stream_is_running; then
      echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) Schedule active — starting streamer..."
      systemctl start streamer.service || true
    fi
  else
    if stream_is_running; then
      if [[ -f "$MANUAL_OVERRIDE" ]]; then
        # Streamer was started manually — leave it running
        :
      else
        echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) Outside schedule — stopping streamer..."
        systemctl stop streamer.service || true
      fi
    fi
  fi
  sleep "$CHECK_INTERVAL"
done


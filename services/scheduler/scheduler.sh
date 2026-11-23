#!/usr/bin/env bash
set -euo pipefail

# Scheduler daemon: reads /etc/yt/schedule.json and starts/stops
# streamer.service based on the current time window.
# Runs continuously under systemd (Type=simple, Restart=always).
#
# Supports dual-stream scheduling: events may target specific streams
# (landscape, portrait, or both). Signal files in /run/ tell the streamer
# which outputs to activate.

SCHEDULE_FILE="/etc/yt/schedule.json"
CHECK_INTERVAL=30  # seconds between checks
MANUAL_OVERRIDE="/run/streamer-manual-override"
MANUAL_STOP="/run/streamer-manual-stop"
ACTIVE_LANDSCAPE="/run/streamer-active-landscape"
ACTIVE_PORTRAIT="/run/streamer-active-portrait"

PREFIX=$(cat /etc/yt/nameprefix 2>/dev/null || echo "unknown")
echo "Scheduler starting with prefix: $PREFIX"

stream_is_running() {
  systemctl is-active --quiet streamer.service 2>/dev/null
}

# Returns a space-separated list of active stream profiles ("landscape", "portrait", or both)
# to stdout. Exit 0 if any stream should be active, exit 1 if none.
get_active_streams() {
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
today_str = now.strftime("%Y-%m-%d")
day_map = {"Mon": 0, "Tue": 1, "Wed": 2, "Thu": 3, "Fri": 4, "Sat": 5, "Sun": 6}

active_streams = set()

# Check overrides first — if today has an override, use it instead of weekly schedule
for override in schedule.get("overrides", []):
    if override.get("date") != today_str:
        continue
    # Found an override for today
    o_start = override.get("start")
    o_stop = override.get("stop")
    o_start_now = override.get("startNow", False)
    if not o_stop:
        sys.exit(1)  # Override with no stop = skip today
    if not o_start and not o_start_now:
        sys.exit(1)  # No start info = skip today
    # Use per-override timezone if specified
    o_tz_name = override.get("timezone")
    if o_tz_name:
        try:
            o_tz = ZoneInfo(o_tz_name)
            now = datetime.datetime.now(tz=o_tz)
        except Exception:
            pass
    eh, em = map(int, o_stop.split(":"))
    stop_t  = now.replace(hour=eh, minute=em, second=0, microsecond=0)
    if o_start_now:
        # startNow: stream is active from override creation until stop
        if o_start:
            sh, sm = map(int, o_start.split(":"))
            start_t = now.replace(hour=sh, minute=sm, second=0, microsecond=0)
        else:
            start_t = now.replace(hour=0, minute=0, second=0, microsecond=0)
    else:
        sh, sm = map(int, o_start.split(":"))
        start_t = now.replace(hour=sh, minute=sm, second=0, microsecond=0)
    if stop_t <= start_t:
        stop_t += datetime.timedelta(days=1)
    if start_t <= now < stop_t:
        streams = override.get("streams", ["landscape"])
        for s in streams:
            active_streams.add(s)
    # Override found for today — don't check weekly events
    if active_streams:
        print(" ".join(sorted(active_streams)))
        sys.exit(0)
    sys.exit(1)

# No override — use weekly schedule
for event in schedule.get("events", []):
    days = [day_map[d] for d in event.get("days", []) if d in day_map]
    sh, sm = map(int, event["start"].split(":"))
    eh, em = map(int, event["stop"].split(":"))
    overnight = (eh, em) <= (sh, sm)

    # Same-day windows
    if now.weekday() in days:
        start_t = now.replace(hour=sh, minute=sm, second=0, microsecond=0)
        stop_t  = now.replace(hour=eh, minute=em, second=0, microsecond=0)
        if overnight:
            stop_t += datetime.timedelta(days=1)
        if start_t <= now < stop_t:
            streams = event.get("streams", ["landscape"])
            for s in streams:
                active_streams.add(s)

    # Overnight windows after midnight (previous day's event)
    if overnight and ((now.weekday() - 1) % 7) in days:
        prev_day = now - datetime.timedelta(days=1)
        start_t = prev_day.replace(hour=sh, minute=sm, second=0, microsecond=0)
        stop_t  = now.replace(hour=eh, minute=em, second=0, microsecond=0)
        if start_t <= now < stop_t:
            streams = event.get("streams", ["landscape"])
            for s in streams:
                active_streams.add(s)

if active_streams:
    print(" ".join(sorted(active_streams)))
    sys.exit(0)
sys.exit(1)  # Not in any streaming window
PYEOF
}

update_stream_signals() {
  local active_streams="$1"
  # Update landscape signal
  if echo "$active_streams" | grep -qw landscape; then
    [[ -f "$ACTIVE_LANDSCAPE" ]] || touch "$ACTIVE_LANDSCAPE"
  else
    rm -f "$ACTIVE_LANDSCAPE"
  fi
  # Update portrait signal
  if echo "$active_streams" | grep -qw portrait; then
    [[ -f "$ACTIVE_PORTRAIT" ]] || touch "$ACTIVE_PORTRAIT"
  else
    rm -f "$ACTIVE_PORTRAIT"
  fi
}

while true; do
  ACTIVE_STREAMS=""
  if ACTIVE_STREAMS=$(get_active_streams); then
    # Inside a schedule window — clear any manual override (schedule takes over)
    if [[ -f "$MANUAL_OVERRIDE" ]]; then
      echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) Entered scheduled window — clearing manual override"
      rm -f "$MANUAL_OVERRIDE"
    fi

    # Update per-stream signal files
    update_stream_signals "$ACTIVE_STREAMS"

    # Respect manual stop — user explicitly stopped during this window
    if [[ -f "$MANUAL_STOP" ]]; then
      :
    elif ! stream_is_running; then
      echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) Schedule active (streams: $ACTIVE_STREAMS) — starting streamer..."
      systemctl start streamer.service || true
    fi
  else
    # Outside schedule window — clear manual stop and stream signals
    if [[ -f "$MANUAL_STOP" ]]; then
      echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) Outside schedule — clearing manual stop"
      rm -f "$MANUAL_STOP"
    fi
    if stream_is_running; then
      if [[ -f "$MANUAL_OVERRIDE" ]]; then
        # Streamer was started manually — preserve its selected outputs. Older
        # manual starts have no signals, so retain the landscape fallback.
        if [[ ! -f "$ACTIVE_LANDSCAPE" && ! -f "$ACTIVE_PORTRAIT" ]]; then
          touch "$ACTIVE_LANDSCAPE"
        fi
      else
        rm -f "$ACTIVE_LANDSCAPE" "$ACTIVE_PORTRAIT"
        echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) Outside schedule — stopping streamer..."
        systemctl stop streamer.service || true
      fi
    elif [[ ! -f "$MANUAL_OVERRIDE" ]]; then
      rm -f "$ACTIVE_LANDSCAPE" "$ACTIVE_PORTRAIT"
    fi
  fi
  sleep "$CHECK_INTERVAL"
done

#!/usr/bin/env bash
set -euo pipefail

# Syncs /etc/yt/schedule.json to Azure Automation schedules.
# Creates weekly recurring schedules for VM start (event.start - 2 min)
# and VM stop (event.stop + 2 min), linked to Start/Stop runbooks.
#
# Usage:
#   ./schedule-sync.sh                            (reads from /etc/yt/ — systemd timer mode)
#   ./schedule-sync.sh <resource-group> <prefix>  (CLI / workstation mode)

SCHEDULE_FILE="/etc/yt/schedule.json"
PADDING_MINUTES=2

if [[ $# -eq 0 ]]; then
  PREFIX=$(cat /etc/yt/nameprefix)
  RG=$(cat /etc/yt/resourcegroup)
elif [[ $# -eq 2 ]]; then
  RG="$1"
  PREFIX="$2"
else
  echo "Usage: $0 [<resource-group> <namePrefix>]"
  exit 1
fi

AA="${PREFIX}-automation"
VM="${PREFIX}-vm"

echo "Logging in with managed identity..."
az login --identity >/dev/null 2>&1 || true

echo "Syncing '$SCHEDULE_FILE' → Automation Account '$AA'..."

python3 - "$SCHEDULE_FILE" "$PADDING_MINUTES" "$RG" "$AA" "$VM" <<'PYEOF'
import sys, json, subprocess, datetime, uuid

try:
    from zoneinfo import ZoneInfo
except ImportError:
    raise RuntimeError("zoneinfo not available — requires Python 3.9+ (Ubuntu 22.04+)")

schedule_file  = sys.argv[1]
padding_min    = int(sys.argv[2])
RG, AA, VM     = sys.argv[3], sys.argv[4], sys.argv[5]

RUNBOOK_START = "Start-StreamerVM"
RUNBOOK_STOP  = "Stop-StreamerVM"

def az(*args):
    """Run an az command; raise on failure."""
    result = subprocess.run(["az"] + list(args), capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"az {' '.join(args[:4])}: {result.stderr.strip()}")
    return result.stdout.strip()

def az_silent(*args):
    """Run an az command; ignore failures (used for idempotent deletes)."""
    subprocess.run(["az"] + list(args), capture_output=True)

# Get subscription ID for REST API calls
SUB = az("account", "show", "--query", "id", "-o", "tsv")

BASE_URL = f"/subscriptions/{SUB}/resourceGroups/{RG}/providers/Microsoft.Automation/automationAccounts/{AA}"

def delete_job_schedules_for(sched_name):
    """Delete any existing job schedules linked to sched_name (idempotent)."""
    result = subprocess.run(
        ["az", "rest", "--method", "GET",
         "--url", f"{BASE_URL}/jobSchedules?api-version=2023-11-01"],
        capture_output=True, text=True)
    if result.returncode != 0:
        return
    try:
        data = json.loads(result.stdout)
    except json.JSONDecodeError:
        return
    for js in data.get("value", []):
        props = js.get("properties", {})
        if props.get("schedule", {}).get("name") == sched_name:
            js_id = js["name"]  # jobScheduleId is the resource name
            subprocess.run(
                ["az", "rest", "--method", "DELETE",
                 "--url", f"{BASE_URL}/jobSchedules/{js_id}?api-version=2023-11-01"],
                capture_output=True)

def next_occurrence(weekday_idx, hour, minute, tz_obj):
    """Return the next UTC datetime for the given weekday+time."""
    now = datetime.datetime.now(tz=tz_obj)
    days_ahead = weekday_idx - now.weekday()
    if days_ahead < 0 or (days_ahead == 0 and (now.hour, now.minute) >= (hour, minute)):
        days_ahead += 7
    target = (now + datetime.timedelta(days=days_ahead)).replace(
        hour=hour, minute=minute, second=0, microsecond=0)
    return target.astimezone(datetime.timezone.utc)

try:
    with open(schedule_file) as f:
        schedule = json.load(f)
except (FileNotFoundError, json.JSONDecodeError) as e:
    print(f"ERROR: cannot read {schedule_file}: {e}", file=sys.stderr)
    sys.exit(1)

try:
    tz = ZoneInfo(schedule.get("timezone", "UTC"))
except Exception:
    tz = datetime.timezone.utc

az_days_full = [
    "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"
]
day_map = {"Mon": 0, "Tue": 1, "Wed": 2, "Thu": 3, "Fri": 4, "Sat": 5, "Sun": 6}

def apply_padding(day_idx, hour, minute, delta_minutes):
    """Apply a minute delta to a weekday+time, wrapping across day/week boundaries."""
    total_minutes = day_idx * 1440 + hour * 60 + minute + delta_minutes
    total_minutes = total_minutes % (7 * 1440)  # Wrap within a week
    new_day = total_minutes // 1440
    remaining = total_minutes % 1440
    return new_day, remaining // 60, remaining % 60

# Build the set of schedule names we EXPECT to exist after this sync
expected_schedules = set()
for event in schedule.get("events", []):
    event_name = event.get("name", "stream").replace(" ", "-")
    for day_abbr in event.get("days", []):
        if day_abbr not in day_map:
            continue
        expected_schedules.add(f"{event_name}-{day_abbr}-start")
        expected_schedules.add(f"{event_name}-{day_abbr}-stop")

# Delete all existing automation schedules NOT in the expected set
# This cleans up removed events and removed days
print("Cleaning up stale schedules...")
result = subprocess.run(
    ["az", "rest", "--method", "GET",
     "--url", f"{BASE_URL}/schedules?api-version=2023-11-01"],
    capture_output=True, text=True)
if result.returncode == 0:
    try:
        existing = json.loads(result.stdout)
        for sched in existing.get("value", []):
            sched_name = sched.get("name", "")
            # Only touch schedules that look like ours (contain -start or -stop suffix)
            if not (sched_name.endswith("-start") or sched_name.endswith("-stop")):
                continue
            if sched_name not in expected_schedules:
                print(f"  Removing stale schedule: {sched_name}")
                delete_job_schedules_for(sched_name)
                subprocess.run(
                    ["az", "rest", "--method", "DELETE",
                     "--url", f"{BASE_URL}/schedules/{sched_name}?api-version=2023-11-01"],
                    capture_output=True)
    except json.JSONDecodeError:
        print("  WARNING: could not parse existing schedules", file=sys.stderr)

for event in schedule.get("events", []):
    event_name = event.get("name", "stream").replace(" ", "-")
    start_h, start_m = map(int, event["start"].split(":"))
    stop_h,  stop_m  = map(int, event["stop"].split(":"))

    for day_abbr in event.get("days", []):
        if day_abbr not in day_map:
            print(f"  WARNING: unknown day '{day_abbr}', skipping")
            continue

        day_idx = day_map[day_abbr]

        # Apply padding with correct midnight/week-boundary wrapping
        start_day, start_ph, start_pm = apply_padding(day_idx, start_h, start_m, -padding_min)
        stop_day,  stop_ph,  stop_pm  = apply_padding(day_idx, stop_h,  stop_m,  +padding_min)

        for kind, pd, h, m, runbook in [
            ("start", start_day, start_ph, start_pm, RUNBOOK_START),
            ("stop",  stop_day,  stop_ph,  stop_pm,  RUNBOOK_STOP),
        ]:
            az_day     = az_days_full[pd]
            sched_name = f"{event_name}-{day_abbr}-{kind}"
            next_dt    = next_occurrence(pd, h, m, tz)
            start_iso  = next_dt.strftime("%Y-%m-%dT%H:%M:%S+00:00")

            # Remove stale schedule + job-schedules (idempotent upsert)
            delete_job_schedules_for(sched_name)
            subprocess.run(
                ["az", "rest", "--method", "DELETE",
                 "--url", f"{BASE_URL}/schedules/{sched_name}?api-version=2023-11-01"],
                capture_output=True)

            # Create schedule (use REST API — CLI doesn't support --week-days)
            sched_body = json.dumps({"properties": {
                "description": f"Auto-{kind} VM for '{event_name}' ({day_abbr})",
                "startTime": start_iso,
                "frequency": "Week",
                "interval": 1,
                "timeZone": schedule.get("timezone", "UTC"),
                "advancedSchedule": {"weekDays": [az_day]}
            }})
            az("rest", "--method", "PUT",
               "--url", f"/subscriptions/{SUB}/resourceGroups/{RG}/providers/Microsoft.Automation/automationAccounts/{AA}/schedules/{sched_name}?api-version=2023-11-01",
               "--body", sched_body)

            # Link schedule to runbook (REST API)
            js_id = str(uuid.uuid4())
            js_body = json.dumps({"properties": {
                "schedule": {"name": sched_name},
                "runbook": {"name": runbook},
                "parameters": {"ResourceGroupName": RG, "VMName": VM}
            }})
            az("rest", "--method", "PUT",
               "--url", f"{BASE_URL}/jobSchedules/{js_id}?api-version=2023-11-01",
               "--body", js_body)

            print(f"  ✓ {sched_name}: {kind} at {h:02d}:{m:02d} UTC every {az_day}")

print("Schedule sync complete.")
PYEOF


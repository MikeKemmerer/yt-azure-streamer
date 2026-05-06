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
            js_id = props.get("jobScheduleId") or js["id"].rsplit("/", 1)[-1]
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

# ─── Build desired state ────────────────────────────────────────────
# desired[name] = { weekDay, hour, minute, runbook, timezone, description }
desired = {}
for event in schedule.get("events", []):
    event_name = event.get("name", "stream").replace(" ", "-")
    start_h, start_m = map(int, event["start"].split(":"))
    stop_h,  stop_m  = map(int, event["stop"].split(":"))

    for day_abbr in event.get("days", []):
        if day_abbr not in day_map:
            print(f"  WARNING: unknown day '{day_abbr}', skipping")
            continue
        day_idx = day_map[day_abbr]
        start_day, start_ph, start_pm = apply_padding(day_idx, start_h, start_m, -padding_min)
        stop_day,  stop_ph,  stop_pm  = apply_padding(day_idx, stop_h,  stop_m,  +padding_min)

        for kind, pd, h, m, runbook in [
            ("start", start_day, start_ph, start_pm, RUNBOOK_START),
            ("stop",  stop_day,  stop_ph,  stop_pm,  RUNBOOK_STOP),
        ]:
            sched_name = f"{event_name}-{day_abbr}-{kind}"
            desired[sched_name] = {
                "weekDay": az_days_full[pd],
                "hour": h,
                "minute": m,
                "runbook": runbook,
                "timezone": schedule.get("timezone", "UTC"),
                "description": f"Auto-{kind} VM for '{event_name}' ({day_abbr})",
            }

# ─── Process overrides ─────────────────────────────────────────────
# For each override:
#   1. Push conflicting recurring schedule's startTime forward by 7 days
#   2. Create one-time schedules for the override date
# desired_onetime[name] = { startTimeUtc, runbook, description }
# pushed_schedules tracks which recurring schedules need their startTime bumped
desired_onetime = {}
pushed_schedules = {}  # sched_name -> override_date (the date to skip past)

today = datetime.datetime.now(tz=tz).date()
day_abbr_map = {0: "Mon", 1: "Tue", 2: "Wed", 3: "Thu", 4: "Fri", 5: "Sat", 6: "Sun"}

for override in schedule.get("overrides", []):
    o_date_str = override.get("date")
    if not o_date_str:
        continue
    try:
        o_date = datetime.date.fromisoformat(o_date_str)
    except ValueError:
        print(f"  WARNING: invalid override date '{o_date_str}', skipping")
        continue

    # Skip past overrides
    if o_date < today:
        continue

    o_weekday = o_date.weekday()  # 0=Mon
    o_day_abbr = day_abbr_map[o_weekday]

    # Find which recurring schedules fall on this weekday and push them
    for sched_name, info in list(desired.items()):
        # Match by the original day abbreviation in the schedule name
        if f"-{o_day_abbr}-" in sched_name:
            pushed_schedules[sched_name] = o_date

    # Create one-time schedules for this override (if it has start/stop times)
    o_start = override.get("start")
    o_stop = override.get("stop")
    if not o_start or not o_stop:
        # Null times = skip day entirely (just push recurring, no one-time)
        continue

    o_start_h, o_start_m = map(int, o_start.split(":"))
    o_stop_h, o_stop_m = map(int, o_stop.split(":"))

    # Apply padding
    start_dt = datetime.datetime(o_date.year, o_date.month, o_date.day,
                                  o_start_h, o_start_m, tzinfo=tz)
    start_dt -= datetime.timedelta(minutes=padding_min)
    stop_dt = datetime.datetime(o_date.year, o_date.month, o_date.day,
                                 o_stop_h, o_stop_m, tzinfo=tz)
    stop_dt += datetime.timedelta(minutes=padding_min)

    # Convert to UTC for Azure
    start_utc = start_dt.astimezone(datetime.timezone.utc)
    stop_utc = stop_dt.astimezone(datetime.timezone.utc)

    o_name = override.get("name", "override").replace(" ", "-")
    desired_onetime[f"override-{o_date_str}-start"] = {
        "startTimeUtc": start_utc.strftime("%Y-%m-%dT%H:%M:%S+00:00"),
        "runbook": RUNBOOK_START,
        "description": f"One-time start for '{o_name}' on {o_date_str}",
    }
    desired_onetime[f"override-{o_date_str}-stop"] = {
        "startTimeUtc": stop_utc.strftime("%Y-%m-%dT%H:%M:%S+00:00"),
        "runbook": RUNBOOK_STOP,
        "description": f"One-time stop for '{o_name}' on {o_date_str}",
    }

# ─── Fetch current state from Azure ────────────────────────────────
print("Fetching current schedules from Azure...")
result = subprocess.run(
    ["az", "rest", "--method", "GET",
     "--url", f"{BASE_URL}/schedules?api-version=2023-11-01"],
    capture_output=True, text=True)
if result.returncode != 0:
    print("ERROR: failed to list schedules from Azure", file=sys.stderr)
    sys.exit(1)

try:
    existing_data = json.loads(result.stdout)
except json.JSONDecodeError:
    print("ERROR: could not parse schedules response", file=sys.stderr)
    sys.exit(1)

# Parse existing schedules into comparable form
# existing[name] = { weekDay, hour, minute, timezone }
existing = {}
for sched in existing_data.get("value", []):
    name = sched.get("name", "")
    # Only consider schedules that look like ours
    if not (name.endswith("-start") or name.endswith("-stop")):
        continue
    props = sched.get("properties", {})
    adv = props.get("advancedSchedule", {})
    week_days = adv.get("weekDays", [])
    start_time = props.get("startTime", "")
    tz_name = props.get("timeZone", "UTC")
    # Parse hour:minute from startTime
    try:
        dt = datetime.datetime.fromisoformat(start_time.replace("+00:00", "+00:00"))
        # Convert to the schedule's timezone to compare
        sched_tz = ZoneInfo(tz_name) if tz_name != "UTC" else datetime.timezone.utc
        dt_local = dt.astimezone(sched_tz)
        existing[name] = {
            "weekDay": week_days[0] if week_days else "",
            "hour": dt_local.hour,
            "minute": dt_local.minute,
            "timezone": tz_name,
        }
    except Exception:
        # Can't parse — mark for recreation
        existing[name] = None

# ─── Compute diff ───────────────────────────────────────────────────
to_create = []   # names that need to be created or updated
to_delete = []   # names that should be removed

for name in existing:
    if name not in desired and not name.startswith("override-"):
        to_delete.append(name)

for name, want in desired.items():
    have = existing.get(name)
    if have is None:
        # Doesn't exist or unparseable — create it
        to_create.append(name)
    else:
        # Compare relevant fields
        if (have["weekDay"] != want["weekDay"] or
            have["hour"] != want["hour"] or
            have["minute"] != want["minute"] or
            have["timezone"] != want["timezone"]):
            to_create.append(name)  # will delete + recreate
        elif name in pushed_schedules:
            # Schedule matches but needs startTime pushed forward — force recreate
            to_create.append(name)

# Check for one-time override schedules that need creation or cleanup
onetime_to_create = []
onetime_to_delete = []

for name in existing:
    if name.startswith("override-") and name not in desired_onetime:
        onetime_to_delete.append(name)

for name in desired_onetime:
    if name not in existing:
        onetime_to_create.append(name)

has_changes = to_create or to_delete or onetime_to_create or onetime_to_delete
if not has_changes:
    print("No changes needed — Azure schedules already match.")
    sys.exit(0)

print(f"Changes: {len(to_create)} recurring create/update, {len(to_delete)} recurring delete, "
      f"{len(onetime_to_create)} one-time create, {len(onetime_to_delete)} one-time delete")

# ─── Apply deletes ─────────────────────────────────────────────────
for name in to_delete + onetime_to_delete:
    print(f"  Removing: {name}")
    delete_job_schedules_for(name)
    subprocess.run(
        ["az", "rest", "--method", "DELETE",
         "--url", f"{BASE_URL}/schedules/{name}?api-version=2023-11-01"],
        capture_output=True)

# ─── Apply recurring creates/updates ──────────────────────────────
for name in to_create:
    want = desired[name]
    # Delete existing first (idempotent upsert)
    if name in existing:
        delete_job_schedules_for(name)
        subprocess.run(
            ["az", "rest", "--method", "DELETE",
             "--url", f"{BASE_URL}/schedules/{name}?api-version=2023-11-01"],
            capture_output=True)

    # If this schedule is pushed due to an override, compute startTime
    # as the first occurrence AFTER the override date
    if name in pushed_schedules:
        override_date = pushed_schedules[name]
        # Find next occurrence of this weekday after override_date
        days_ahead = az_days_full.index(want["weekDay"]) - override_date.weekday()
        if days_ahead <= 0:
            days_ahead += 7
        resume_date = override_date + datetime.timedelta(days=days_ahead)
        start_dt = datetime.datetime(resume_date.year, resume_date.month, resume_date.day,
                                      want["hour"], want["minute"], 0, tzinfo=tz)
        next_dt = start_dt.astimezone(datetime.timezone.utc)
    else:
        next_dt = next_occurrence(
            az_days_full.index(want["weekDay"]), want["hour"], want["minute"], tz)

    start_iso = next_dt.strftime("%Y-%m-%dT%H:%M:%S+00:00")

    sched_body = json.dumps({"properties": {
        "description": want["description"],
        "startTime": start_iso,
        "frequency": "Week",
        "interval": 1,
        "timeZone": want["timezone"],
        "advancedSchedule": {"weekDays": [want["weekDay"]]}
    }})
    az("rest", "--method", "PUT",
       "--url", f"{BASE_URL}/schedules/{name}?api-version=2023-11-01",
       "--body", sched_body)

    # Link schedule to runbook
    js_id = str(uuid.uuid4())
    js_body = json.dumps({"properties": {
        "schedule": {"name": name},
        "runbook": {"name": want["runbook"]},
        "parameters": {"ResourceGroupName": RG, "VMName": VM}
    }})
    az("rest", "--method", "PUT",
       "--url", f"{BASE_URL}/jobSchedules/{js_id}?api-version=2023-11-01",
       "--body", js_body)

    pushed_note = " (pushed +7d for override)" if name in pushed_schedules else ""
    print(f"  ✓ {name}: {want['weekDay']} {want['hour']:02d}:{want['minute']:02d}{pushed_note}")

# ─── Apply one-time override schedules ────────────────────────────
for name in onetime_to_create:
    info = desired_onetime[name]
    # Delete if somehow exists (idempotent)
    if name in existing:
        delete_job_schedules_for(name)
        subprocess.run(
            ["az", "rest", "--method", "DELETE",
             "--url", f"{BASE_URL}/schedules/{name}?api-version=2023-11-01"],
            capture_output=True)

    sched_body = json.dumps({"properties": {
        "description": info["description"],
        "startTime": info["startTimeUtc"],
        "frequency": "OneTime",
        "timeZone": "UTC",
    }})
    az("rest", "--method", "PUT",
       "--url", f"{BASE_URL}/schedules/{name}?api-version=2023-11-01",
       "--body", sched_body)

    # Link to runbook
    js_id = str(uuid.uuid4())
    js_body = json.dumps({"properties": {
        "schedule": {"name": name},
        "runbook": {"name": info["runbook"]},
        "parameters": {"ResourceGroupName": RG, "VMName": VM}
    }})
    az("rest", "--method", "PUT",
       "--url", f"{BASE_URL}/jobSchedules/{js_id}?api-version=2023-11-01",
       "--body", js_body)

    print(f"  ✓ {name}: one-time at {info['startTimeUtc']}")

print("Schedule sync complete.")
PYEOF


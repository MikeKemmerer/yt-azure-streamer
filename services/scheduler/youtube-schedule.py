#!/usr/bin/env python3
"""Read-only YouTube discovery and local scheduler decisions."""

import argparse
import datetime as dt
import hashlib
import json
import math
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from zoneinfo import ZoneInfo

ROOT = Path("/etc/yt")
RUN = Path("/run")
SCOPE = "https://www.googleapis.com/auth/youtube.readonly"
PROFILES = {"landscape", "portrait"}
TERMINAL = {"complete", "revoked", "deleted"}
FRESH_SECONDS = 600
LATE_SECONDS = 600
DAILY_CALL_LIMIT = 8000


class QuotaLimitError(RuntimeError):
    pass


def read_json(path, default=None):
    try:
        value = json.loads(Path(path).read_text())
        return value if isinstance(value, dict) else default
    except (OSError, ValueError):
        return default


def atomic_json(path, value, mode=0o644):
    path = Path(path)
    fd, name = tempfile.mkstemp(prefix=path.name + ".", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as f:
            os.fchmod(f.fileno(), mode)
            json.dump(value, f, ensure_ascii=True)
            f.write("\n")
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def title_key(value):
    return " ".join(value.split()).lower()


def settings(schedule):
    config = schedule.get("youtube", {})
    channel = config.get("channelId", "")
    provider = config.get("provider", "api")
    if provider not in {"api", "yt-dlp"}:
        raise ValueError("Invalid YouTube discovery provider")
    if provider == "yt-dlp" and (not isinstance(channel, str) or not re.fullmatch(r"UC[A-Za-z0-9_-]{22}", channel)):
        raise ValueError("Configure a YouTube channel ID beginning with UC")
    if not isinstance(config.get("manualStudioChecks", False), bool):
        raise ValueError("Invalid manual Studio confirmation")
    rules = config.get("rules", [])
    if not isinstance(channel, str) or not channel or len(channel) > 100:
        raise ValueError("Configure the authorized channel ID")
    if not isinstance(rules, list) or not 1 <= len(rules) <= 32:
        raise ValueError("Configure 1-32 title/output rules")
    seen = set()
    for rule in rules:
        if not isinstance(rule, dict):
            raise ValueError("Invalid title rule")
        title, profile = rule.get("title"), rule.get("profile")
        seconds = rule.get("durationSeconds", 28800)
        if not isinstance(title, str) or not title.strip() or len(title) > 200:
            raise ValueError("Rules require a title of 1-200 characters")
        if profile not in PROFILES:
            raise ValueError("Rules require landscape or portrait")
        if isinstance(seconds, bool) or not isinstance(seconds, int) or not 60 <= seconds <= 86400:
            raise ValueError("Fallback duration must be 1 minute to 24 hours")
        key = title_key(title)
        if key in seen:
            raise ValueError("Duplicate title rules")
        seen.add(key)
    return channel, rules


def fingerprint(schedule):
    data = {key: schedule.get(key) for key in ("scheduleSource", "youtube", "streams")}
    return hashlib.sha256(json.dumps(data, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()


def key_fingerprint(keys):
    data = {profile: keys.get(profile) for profile in sorted(PROFILES)}
    return hashlib.sha256(json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()


def timestamp(value):
    parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("Timestamp must include timezone")
    return parsed.timestamp()


def normalize(schedule, broadcasts, streams, keys, now):
    channel, rules = settings(schedule)
    matches = {title_key(r["title"]): r for r in rules}
    events = []
    for broadcast in broadcasts:
        snippet = broadcast.get("snippet", {})
        title = snippet.get("title", "")
        if not isinstance(title, str) or title_key(title) not in matches:
            continue
        rule = matches[title_key(title)]
        details = broadcast.get("contentDetails", {})
        status = broadcast.get("status", {}).get("lifeCycleStatus", "")
        event = {"id": broadcast["id"], "title": title, "profile": rule["profile"],
                 "status": status, "start": None, "end": None, "errors": []}
        errors = event["errors"]
        if snippet.get("channelId") != channel:
            errors.append("Wrong channel")
        try:
            start = timestamp(snippet["scheduledStartTime"])
            end = timestamp(snippet["scheduledEndTime"]) if snippet.get("scheduledEndTime") else start + rule.get("durationSeconds", 28800)
            if start <= 0 or end <= start or end - start > 86400:
                raise ValueError()
            event.update(start=start, end=end)
        except (KeyError, TypeError, ValueError, OverflowError):
            errors.append("Invalid scheduled window")
        if status not in {"ready", "live", "liveStarting", "testing", "testStarting"}:
            errors.append("Broadcast is not ready")
        if details.get("enableAutoStart") is not True or details.get("enableAutoStop") is not True:
            errors.append("Enable Auto-start and Auto-stop in YouTube Studio")
        bound = details.get("boundStreamId")
        ingestion = streams.get(bound, {}).get("cdn", {}).get("ingestionInfo", {})
        expected = keys.get(rule["profile"])
        if not bound or not expected or ingestion.get("streamName") != expected:
            errors.append("Broadcast is not bound to this output's configured stream key")
        # Auto-start reacts to input, not to our title/time filters.
        if bound and any(other["id"] != broadcast["id"]
                         and (other.get("contentDetails", {}).get("boundStreamId") == bound
                              or (expected and streams.get(other.get("contentDetails", {}).get("boundStreamId"), {})
                                  .get("cdn", {}).get("ingestionInfo", {}).get("streamName") == expected))
                         and other.get("status", {}).get("lifeCycleStatus") not in TERMINAL
                         for other in broadcasts):
            errors.append("Another broadcast shares this stream binding")
        events.append(event)
    return validate_windows(events, now)


def validate_windows(events, now):
    candidates = [e for e in events if not e["errors"] and e.get("end") and e["end"] > now]
    for i, first in enumerate(candidates):
        for second in candidates[i + 1:]:
            if max(first["start"], second["start"]) < min(first["end"], second["end"]):
                aligned = first["start"] == second["start"] and first["end"] == second["end"]
                if first["profile"] == second["profile"] or not aligned:
                    first["errors"].append("Overlapping or staggered output windows")
                    second["errors"].append("Overlapping or staggered output windows")
    return sorted(events, key=lambda e: (e["start"] or 0, e["id"]))


PUBLIC_METADATA_WORKER = """
import json, sys
import yt_dlp
listing = sys.argv[2] == 'listing'
options = {'skip_download': True, 'ignore_no_formats_error': True, 'quiet': True,
           'no_warnings': True, 'socket_timeout': 8, 'retries': 0, 'extractor_retries': 0,
           'cachedir': False, 'noplaylist': not listing, 'playlistend': 100}
if listing:
    options['extract_flat'] = 'in_playlist'
with yt_dlp.YoutubeDL(options) as client:
    data = client.extract_info(sys.argv[1], download=False, process=listing)
def metadata(item):
    return {key: item.get(key) for key in
            ('id', 'title', 'channel_id', 'live_status', 'release_timestamp', 'media_type')}
result = metadata(data)
if listing:
    result['entries'] = [metadata(item) for item in (data.get('entries') or [])]
print(json.dumps(result))
"""


class PublicYouTube:
    def __init__(self):
        self.deadline = time.monotonic() + 55

    def extract(self, identifier, listing=False):
        pattern = r"UC[A-Za-z0-9_-]{22}" if listing else r"[A-Za-z0-9_-]{11}"
        if not isinstance(identifier, str) or not re.fullmatch(pattern, identifier):
            raise ValueError("Invalid public YouTube identifier")
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("Public discovery timeout")
        url = ("https://www.youtube.com/channel/" + identifier + "/streams" if listing
               else "https://www.youtube.com/watch?v=" + identifier)
        result = subprocess.run(
            [sys.executable, "-c", PUBLIC_METADATA_WORKER, url, "listing" if listing else "video"],
            stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=min(20, remaining),
        )
        if result.returncode:
            if "No module named 'yt_dlp'" in result.stderr:
                raise ImportError("Install the documented YouTube dependencies")
            raise RuntimeError("Public YouTube metadata request failed")
        if len(result.stdout) > 2097152:
            raise ValueError("Public discovery response too large")
        data = json.loads(result.stdout)
        if not isinstance(data, dict):
            raise ValueError("Invalid public discovery response")
        return data


def discover_public(api, schedule, previous, keys, now):
    channel, rules = settings(schedule)
    listing = api.extract(channel, listing=True)
    if listing.get("channel_id") != channel or not isinstance(listing.get("entries"), list):
        raise ValueError("Public discovery channel mismatch")
    matches = {title_key(rule["title"]): rule for rule in rules}
    entries = listing["entries"]
    if any(not isinstance(item, dict) for item in entries):
        raise ValueError("Invalid public channel listing")
    active = {item["id"] for item in entries if item.get("live_status") == "is_live"}
    observed = {item["id"]: item for item in entries}
    previous = previous if previous and previous.get("fingerprint") == fingerprint(schedule) else {}
    tracked = {event["id"]: event for event in previous.get("events", [])
               if event.get("end") and event["end"] > now}
    ids = {item["id"] for item in entries
           if item.get("live_status") in {"is_live", "is_upcoming"}
           and isinstance(item.get("title"), str) and title_key(item["title"]) in matches}
    ids.update(tracked)
    ids.update(previous.get("trackedIds", []))
    if len(ids) > 32:
        raise ValueError("Too many matching public broadcasts")
    events, terminal = [], {}
    for identifier in sorted(ids):
        item = api.extract(identifier)
        if item.get("id") != identifier or item.get("channel_id") != channel:
            raise ValueError("Public broadcast identity mismatch")
        lifecycle = item.get("live_status")
        observed[identifier] = item
        if lifecycle in {"was_live", "post_live"}:
            active.discard(identifier)
            terminal[identifier] = "complete"
            continue
        if lifecycle not in {"is_upcoming", "is_live"}:
            raise ValueError("Public broadcast lifecycle is unavailable")
        if lifecycle == "is_live":
            active.add(identifier)
        else:
            active.discard(identifier)
        title = item.get("title")
        if not isinstance(title, str) or title_key(title) not in matches:
            continue
        rule = matches[title_key(title)]
        event = {"id": identifier, "title": title, "profile": rule["profile"],
                 "status": "ready" if lifecycle == "is_upcoming" else "live",
                 "start": None, "end": None, "errors": []}
        start = item.get("release_timestamp")
        # Public live timestamps may change to actual start; retain the committed window.
        if lifecycle == "is_live" and identifier in tracked:
            start = tracked[identifier]["start"]
        if (isinstance(start, bool) or not isinstance(start, (int, float))
                or not math.isfinite(start) or start <= 0):
            event["errors"].append("Scheduled start is unavailable")
        else:
            event.update(start=start, end=start + rule.get("durationSeconds", 28800))
        if lifecycle == "is_live":
            actual = item.get("release_timestamp")
            if isinstance(actual, (int, float)) and not isinstance(actual, bool) and math.isfinite(actual) and actual > 0:
                event["liveStart"] = actual
        if item.get("media_type") != "livestream":
            event["errors"].append("Not a confirmed livestream; premieres are not supported")
        if schedule["youtube"].get("manualStudioChecks") is not True:
            event["errors"].append("Confirm stream keys and Auto-start/Auto-stop in Studio")
        if not keys.get(rule["profile"]):
            event["errors"].append("Configure this output's stream key")
        events.append(event)
    # A successor ends the previous slot; overlapping fallback durations are not simultaneous shows.
    for event in events:
        successors = [other["start"] for other in events if other["profile"] == event["profile"]
                      and other.get("start") and event.get("start") and other["start"] > event["start"]
                      and all(error == "Confirm stream keys and Auto-start/Auto-stop in Studio"
                              for error in other["errors"])]
        if successors and event.get("end"):
            event["end"] = min(event["end"], min(successors))
    validate_windows([event for event in events if event["status"] == "ready"], now)
    return {"version": 1, "provider": "yt-dlp", "fingerprint": fingerprint(schedule),
            "keyFingerprint": key_fingerprint(keys), "fetchedAt": time.time(),
            "channelId": channel, "events": sorted(events, key=lambda event: (event["start"] or 0, event["id"])),
            "terminal": terminal,
            "activeBroadcasts": [observed[identifier] for identifier in sorted(active)]}


class YouTube:
    def __init__(self, credentials_path, quota_path):
        from google.auth.transport.requests import Request
        from google.oauth2.credentials import Credentials
        self.credentials = Credentials.from_authorized_user_file(str(credentials_path), [SCOPE])
        if not self.credentials.valid:
            self.credentials.refresh(Request())
            atomic_json(credentials_path, json.loads(self.credentials.to_json()), 0o600)
        self.deadline = time.monotonic() + 50
        self.quota_path = quota_path

    def get(self, resource, **params):
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("Discovery timeout")
        day = dt.datetime.now(ZoneInfo("America/Los_Angeles")).date().isoformat()
        usage = read_json(self.quota_path, {})
        calls = usage.get("calls", 0) if usage.get("day") == day else 0
        if calls >= DAILY_CALL_LIMIT:
            raise QuotaLimitError()
        atomic_json(self.quota_path, {"day": day, "calls": calls + 1})
        url = "https://www.googleapis.com/youtube/v3/" + resource + "?" + urllib.parse.urlencode(params)
        request = urllib.request.Request(url, headers={"Authorization": "Bearer " + self.credentials.token})
        with urllib.request.urlopen(request, timeout=min(12, remaining)) as response:
            body = response.read(1048577)
            if len(body) > 1048576:
                raise ValueError("Response too large")
            return json.loads(body)

    def pages(self, resource, **params):
        items, token = [], None
        for _ in range(10):
            page = self.get(resource, maxResults=50, **params, **({"pageToken": token} if token else {}))
            items.extend(page.get("items", []))
            token = page.get("nextPageToken")
            if not token:
                return items
        raise ValueError("Discovery page limit exceeded")


def discover(api, schedule, previous, keys, now):
    channel, _ = settings(schedule)
    channels = api.get("channels", part="id", mine="true").get("items", [])
    if channel not in {item["id"] for item in channels}:
        raise ValueError("OAuth channel does not match configured channel")
    broadcasts = {}
    for status in ("upcoming", "active"):
        for item in api.pages("liveBroadcasts", part="snippet,contentDetails,status",
                              broadcastStatus=status, broadcastType="all"):
            broadcasts[item["id"]] = item
    # Upcoming discovery no longer contains broadcasts that ended or were deleted.
    tracked = {e["id"] for e in (previous or {}).get("events", []) if e.get("end", 0) and e["end"] > now}
    terminal = {}
    ids = sorted(tracked - broadcasts.keys())
    for offset in range(0, len(ids), 50):
        batch = ids[offset:offset + 50]
        found = api.get("liveBroadcasts", part="snippet,contentDetails,status", id=",".join(batch)).get("items", [])
        found_ids = {item["id"] for item in found}
        for item in found:
            broadcasts[item["id"]] = item
            state = item.get("status", {}).get("lifeCycleStatus")
            if state in TERMINAL:
                terminal[item["id"]] = state
        for missing in set(batch) - found_ids:
            terminal[missing] = "deleted"
    bindings = sorted({b.get("contentDetails", {}).get("boundStreamId") for b in broadcasts.values()} - {None, ""})
    streams = {}
    for offset in range(0, len(bindings), 50):
        for item in api.get("liveStreams", part="cdn,status", id=",".join(bindings[offset:offset + 50])).get("items", []):
            streams[item["id"]] = item
    return {"version": 1, "fingerprint": fingerprint(schedule), "keyFingerprint": key_fingerprint(keys), "fetchedAt": now,
            "channelId": channel, "events": normalize(schedule, list(broadcasts.values()), streams, keys, now),
            "terminal": terminal}


def decision(schedule, cache, state, now, running=False, manual=False, stopped=False, hold=False,
             policy=None, calendar=None, standby=None, profiles=None):
    """Return scheduler command, profiles, and updated transient ownership."""
    if policy and policy.get("rolloverEnabled") is True and schedule.get("youtube", {}).get("provider") == "yt-dlp":
        return rollover_decision(schedule, cache, state or {}, now, running, manual, stopped, hold,
                                 policy, calendar, standby, profiles or [])
    state = state or {}
    state.setdefault("suppressed", {})
    state["suppressed"] = {key: end for key, end in state["suppressed"].items() if end > now}
    owner = state.get("owner")
    fresh = bool(cache and cache.get("fingerprint") == fingerprint(schedule)
                 and 0 <= now - cache.get("fetchedAt", 0) <= FRESH_SECONDS)
    events = cache.get("events", []) if fresh else []
    window = [e for e in events if e.get("start") is not None and e["start"] <= now < e["end"]]
    if manual:
        if owner:
            for event in owner["events"]:
                state["suppressed"][event["id"]] = event["end"]
        state.pop("owner", None)
        return "MANUAL", [], state
    if stopped or hold:
        for event in window + (owner["events"] if owner else []):
            state["suppressed"][event["id"]] = event["end"]
        if owner:
            owner["stopping"] = True
        if running and owner:
            return "STOP", [], state
        state.pop("owner", None)
        return ("HOLD" if window or hold or (stopped and not fresh) else "IDLE"), [], state
    if owner:
        if fresh:
            indexed = {e["id"]: e for e in events}
            for owned in owner["events"]:
                observed = indexed.get(owned["id"])
                if owned["id"] in cache.get("terminal", {}) or (observed and observed["status"] in TERMINAL):
                    owner["stopping"] = True
                elif observed:
                    if observed["errors"] or observed["profile"] != owned["profile"] or observed["start"] != owned["start"]:
                        owner["stopping"] = True
                    else:
                        owned["end"] = observed["end"]
            if len({e["end"] for e in owner["events"]}) != 1:
                owner["stopping"] = True
        if now >= min(e["end"] for e in owner["events"]) or owner.get("stopping"):
            for event in owner["events"]:
                state["suppressed"][event["id"]] = max(event["end"], now + LATE_SECONDS)
            owner["stopping"] = True
            if running:
                return "STOP", [], state
            state.pop("owner", None)
            return "IDLE", [], state
        # A dead player may retry only against fresh, still-eligible discovery.
        profiles = sorted({e["profile"] for e in owner["events"]})
        if running:
            return "KEEP", profiles, state
        if fresh:
            return "START", profiles, state
        return "HOLD", [], state
    if running:
        # No ownership means no authority to stop/take over this process.
        return "MANUAL", [], state
    eligible = [e for e in window if not e["errors"] and e["status"] == "ready"
                and e["id"] not in state["suppressed"] and now - e["start"] <= LATE_SECONDS]
    if cache and cache.get("provider") == "yt-dlp" and cache.get("activeBroadcasts"):
        eligible = []
    if eligible:
        state["owner"] = {"events": [dict(e) for e in eligible], "startedAt": now}
        return "START", sorted({e["profile"] for e in eligible}), state
    return ("HOLD" if window else "IDLE"), [], state


def calendar_block(calendar, standby, state, now):
    released = state.setdefault("calendarReleased", {})
    released = {key: at for key, at in released.items() if at > now - 7 * 86400}
    state["calendarReleased"] = released
    ready = bool(calendar and calendar.get("ok") and 0 <= now - calendar.get("fetchedAt", 0) <= 180)
    blocked = False
    failover = (standby or {}).get("failover_started")
    valid_failover = ((standby or {}).get("state") in {"counting", "fired"}
                      and isinstance(failover, (int, float)) and not isinstance(failover, bool)
                      and math.isfinite(failover) and failover <= now)
    pending = state.get("calendarPendingStart")
    if pending is not None and not (valid_failover and failover >= pending):
        blocked = True
    elif pending is not None:
        state.pop("calendarPendingStart", None)
    for window in (calendar or {}).get("windows", []):
        if window["start"] > now or window["id"] in released:
            continue
        if valid_failover and failover >= window["start"]:
            released[window["id"]] = now
        else:
            blocked = True
            state["calendarPendingStart"] = max(state.get("calendarPendingStart", window["start"]), window["start"])
    return blocked, ready


def rollover_decision(schedule, cache, state, now, running, manual, stopped, hold,
                      policy, calendar, standby, profiles):
    fresh = bool(cache and cache.get("fingerprint") == fingerprint(schedule)
                 and 0 <= now - cache.get("fetchedAt", 0) <= FRESH_SECONDS)
    events = cache.get("events", []) if fresh else []
    blocked, calendar_ready = calendar_block(calendar, standby, state, now) if policy.get("calendarUrl") else (False, True)
    state["controlStatus"] = {"churchBlocked": blocked, "calendarReady": calendar_ready}
    controls_manual = policy.get("controlManual") is True
    owner = state.get("owner")
    if running and not owner and controls_manual and fresh:
        live = [event for event in events if event["status"] == "live"
                and event["profile"] in profiles and event.get("liveStart")
                and all(error == "Confirm stream keys and Auto-start/Auto-stop in Studio" for error in event["errors"])]
        if (live and len(live) == len(set(profiles)) and {event["profile"] for event in live} == set(profiles)
                and len({(event["start"], event["end"]) for event in live}) == 1
                and {event["id"] for event in live} == {item["id"] for item in cache.get("activeBroadcasts", [])}):
            owner = {"events": [dict(event) for event in live], "startedAt": now, "adoptedManual": True}
            state["owner"] = owner
    if owner:
        for event in owner["events"]:
            observed = next((item for item in events if item["id"] == event["id"]), {})
            if observed.get("liveStart") and not event.get("liveStart"):
                event["liveStart"] = observed["liveStart"]
            if event.get("liveStart"):
                event["end"] = min(event["end"], event["liveStart"] + 86400)
    if stopped or hold or (manual and not controls_manual):
        return decision(schedule, cache, state, now, running, manual and not controls_manual, stopped, hold)
    if blocked and running and (owner or controls_manual):
        state.setdefault("handoff", {"ids": [event["id"] for event in owner["events"]] if owner else
                                    [item["id"] for item in (cache or {}).get("activeBroadcasts", [])],
                                    "disconnectedAt": None, "completed": [], "reason": "church"})
        if owner:
            owner["stopping"] = True
        return "STOP", [], state
    handoff = state.get("handoff")
    if handoff:
        if fresh:
            handoff["completed"] = sorted(set(handoff.get("completed", [])) |
                                          (set(handoff["ids"]) & set(cache.get("terminal", {}))))
        if running:
            handoff["disconnectedAt"] = None
            return "STOP", [], state
        if handoff.get("disconnectedAt") is None:
            handoff["disconnectedAt"] = now
        wait = policy.get("disconnectSeconds", 30)
        wait = max(30, wait) if isinstance(wait, int) and not isinstance(wait, bool) else 30
        if (policy.get("resumeChurchLive") is True and handoff.get("reason") == "church" and owner
                and not blocked and calendar_ready and fresh and not handoff.get("completed")
                and now - handoff["disconnectedAt"] >= wait
                and cache["fetchedAt"] >= handoff["disconnectedAt"]
                and set(handoff["ids"]) == {item["id"] for item in cache.get("activeBroadcasts", [])}
                and set(handoff["ids"]) == {event["id"] for event in owner["events"]}):
            indexed = {event["id"]: event for event in events}
            resumable = True
            for owned in owner["events"]:
                observed = indexed.get(owned["id"], {})
                allowed_errors = {"Confirm stream keys and Auto-start/Auto-stop in Studio"} if owner.get("adoptedManual") else set()
                live_start = owned.get("liveStart")
                if (observed.get("status") != "live" or observed.get("profile") != owned["profile"]
                        or observed.get("start") != owned["start"] or not live_start
                        or owned["id"] in cache.get("terminal", {})
                        or owned["id"] in state.get("suppressed", {})
                        or set(observed.get("errors", [])) - allowed_errors
                        or not observed.get("end")
                        or not owned["start"] <= now < min(owned["end"], observed["end"], live_start + 86400)):
                    resumable = False
            if resumable:
                for owned in owner["events"]:
                    owned["end"] = min(owned["end"], indexed[owned["id"]]["end"], owned["liveStart"] + 86400)
                owner.pop("stopping", None)
                state.pop("handoff", None)
                return "START", sorted({event["profile"] for event in owner["events"]}), state
        if (blocked or not calendar_ready or not fresh or now - handoff["disconnectedAt"] < wait
                or not set(handoff["ids"]).issubset(handoff.get("completed", []))):
            return "HOLD", [], state
        state.setdefault("suppressed", {}).update({identifier: now + 86400 for identifier in handoff["ids"]})
        state.pop("owner", None)
        state.pop("handoff", None)
    if blocked or (not running and not calendar_ready):
        return "HOLD", [], state
    # Do not let a refreshed public timestamp extend the absolute live-age limit.
    if owner and fresh:
        cache = dict(cache, events=[dict(event) for event in events])
        for observed in cache["events"]:
            owned = next((event for event in owner["events"] if event["id"] == observed["id"]), {})
            if owned.get("liveStart") and observed.get("end"):
                observed["end"] = min(observed["end"], owned["liveStart"] + 86400)
            if owned and owner.get("adoptedManual"):
                observed["errors"] = [error for error in observed["errors"]
                                      if error != "Confirm stream keys and Auto-start/Auto-stop in Studio"]
    owned_ids = [event["id"] for event in state.get("owner", {}).get("events", [])]
    command, outputs, state = decision(schedule, cache, state, now, running=running)
    if command == "STOP" and owned_ids:
        state.setdefault("handoff", {"ids": owned_ids, "disconnectedAt": None, "completed": []})
    return command, outputs, state


def sync_calendar(root, policy, now):
    if not policy.get("calendarUrl"):
        return
    path = root / "youtube-calendar.json"
    previous = read_json(path, {})
    try:
        url = policy["calendarUrl"]
        parsed = urllib.parse.urlsplit(url)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
            raise ValueError("Invalid calendar URL")
        with urllib.request.urlopen(url, timeout=5) as response:
            raw = response.read(1048577)
        if len(raw) > 1048576:
            raise ValueError("Calendar response too large")
        entries = json.loads(raw)
        if not isinstance(entries, list):
            raise ValueError("Invalid calendar response")
        windows = {}
        for entry in entries:
            if entry.get("calendar") != policy.get("serviceCalendar", "Services") or entry.get("allDay"):
                continue
            start, end = timestamp(entry["start"]), timestamp(entry["end"])
            if end <= start:
                raise ValueError("Invalid church-service window")
            if now - 7 * 86400 <= start <= now + 14 * 86400:
                identifier = str(start)
                windows[identifier] = {"id": identifier, "start": start}
        # A started service is released by actual failover, not calendar edits or its planned end.
        for old in previous.get("windows", []):
            if now - 7 * 86400 <= old["start"] <= now:
                windows.setdefault(old["id"], old)
        atomic_json(path, {"ok": True, "fetchedAt": now, "windows": list(windows.values())})
    except Exception:
        atomic_json(path, dict(previous, ok=False, checkedAt=now, error="Local service calendar unavailable"))


def output_keys(root, schedule):
    result = {}
    for profile in PROFILES:
        name = schedule.get("streams", {}).get(profile, {}).get(
            "stream_key_name", "youtube-stream-key" + ("-portrait" if profile == "portrait" else ""))
        if not isinstance(name, str) or not name or Path(name).name != name or "\\" in name or name in {".", ".."}:
            raise ValueError("Invalid stream key file name")
        try:
            result[profile] = "".join((root / "secrets" / name).read_text().split())
        except OSError:
            result[profile] = None
    return result


def sync(root, run=RUN):
    schedule = read_json(root / "schedule.json", {})
    public = schedule.get("youtube", {}).get("provider", "api") == "yt-dlp"
    if (root / "mode").read_text().strip() != "local":
        return
    if schedule.get("scheduleSource", "weekly") != "youtube" and not (
            public and schedule.get("youtube", {}).get("channelId") and schedule.get("youtube", {}).get("rules")):
        return
    status_path = root / "youtube-sync-status.json"
    status = read_json(status_path, {})
    now = time.time()
    started = time.monotonic()
    policy = read_json(root / "youtube-local.json", {})
    sync_calendar(root, policy, now)
    if status.get("retryAt", 0) > now:
        return
    try:
        api = PublicYouTube() if public else YouTube(root / "secrets" / "youtube-oauth.json", root / "youtube-quota.json")
        discovery = discover_public if public else discover
        previous = read_json(root / "youtube-schedule.json", {})
        if public:
            previous = previous if previous.get("fingerprint") == fingerprint(schedule) else {"fingerprint": fingerprint(schedule)}
            state = read_json(run / "streamer-youtube-owner.json", {})
            previous["trackedIds"] = sorted({event["id"] for event in state.get("owner", {}).get("events", [])}
                                           | set(state.get("handoff", {}).get("ids", [])))
            for owned in state.get("owner", {}).get("events", []):
                if not any(event["id"] == owned["id"] for event in previous.get("events", [])):
                    previous.setdefault("events", []).append(owned)
        cache = discovery(api, schedule, previous, output_keys(root, schedule), now)
        atomic_json(root / "youtube-schedule.json", cache)
        atomic_json(status_path, {"ok": True, "checkedAt": now, "failures": 0,
                                 "provider": "yt-dlp" if public else "api",
                                 "durationSeconds": round(time.monotonic() - started, 2),
                                 "callsToday": read_json(root / "youtube-quota.json", {}).get("calls", 0)})
    except Exception as error:
        failures = min(status.get("failures", 0) + 1, 8)
        # Never echo provider responses/exceptions, which may include credentials.
        message = "YouTube discovery failed; check authorization, configuration, and connectivity"
        if public:
            message = "Public YouTube discovery failed; check connectivity and update yt-dlp if needed"
        if isinstance(error, ValueError):
            message = "YouTube configuration or response is invalid; check channel, rules, and discovery limits"
        if isinstance(error, ImportError):
            message = "Install the documented YouTube environment dependencies"
        if isinstance(error, QuotaLimitError):
            message = "Local YouTube daily request budget reached; new starts are blocked once discovery becomes stale"
        atomic_json(status_path, {"ok": False, "checkedAt": now, "failures": failures,
                                 "durationSeconds": round(time.monotonic() - started, 2),
                                 "retryAt": now + min(900, 60 * 2 ** (failures - 1)), "error": message})


def authorize(root, client_file):
    from google_auth_oauthlib.flow import InstalledAppFlow
    flow = InstalledAppFlow.from_client_secrets_file(client_file, [SCOPE])
    credentials = flow.run_local_server(host="localhost", bind_addr="127.0.0.1", port=8765,
                                        open_browser=False, access_type="offline", prompt="consent")
    if not credentials.refresh_token:
        raise ValueError("Offline authorization did not provide a refresh token")
    directory = root / "secrets"
    directory.mkdir(mode=0o700, exist_ok=True)
    atomic_json(directory / "youtube-oauth.json", json.loads(credentials.to_json()), 0o600)
    print("Read-only YouTube authorization saved.")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["sync", "decide", "stopped", "authorize"])
    parser.add_argument("--root", type=Path, default=ROOT)
    parser.add_argument("--run", type=Path, default=RUN)
    parser.add_argument("--client-file")
    parser.add_argument("--running", action="store_true")
    args = parser.parse_args()
    if args.command == "authorize":
        if not args.client_file:
            parser.error("--client-file is required")
        authorize(args.root, args.client_file)
    elif args.command == "sync":
        sync(args.root, args.run)
    elif args.command == "stopped":
        path = args.run / "streamer-youtube-owner.json"
        state = read_json(path, {})
        if state.get("handoff") and state["handoff"].get("disconnectedAt") is None:
            state["handoff"]["disconnectedAt"] = time.time()
            atomic_json(path, state)
    else:
        state_path = args.run / "streamer-youtube-owner.json"
        schedule = read_json(args.root / "schedule.json", {})
        cache = read_json(args.root / "youtube-schedule.json")
        try:
            if cache and cache.get("keyFingerprint") != key_fingerprint(output_keys(args.root, schedule)):
                cache = None
        except (ValueError, TypeError, AttributeError):
            cache = None
        mode_path = args.root / "mode"
        policy = read_json(args.root / "youtube-local.json", {}) if mode_path.exists() and mode_path.read_text().strip() == "local" else {}
        command, profiles, state = decision(
            schedule, cache,
            read_json(state_path, {}), time.time(), running=args.running,
            manual=(args.run / "streamer-manual-override").exists(),
            stopped=(args.run / "streamer-manual-stop").exists(),
            hold=(args.run / "streamer-queue-hold").exists(),
            policy=policy, calendar=read_json(args.root / "youtube-calendar.json"),
            standby=read_json(Path(policy.get("standbyState", "/run/videokiosk2/standby.json"))),
            profiles=[profile for profile in PROFILES if (args.run / ("streamer-active-" + profile)).exists()])
        state["decision"] = {"command": command, "profiles": profiles, "observedAt": time.time()}
        atomic_json(state_path, state)
        print(" ".join([command] + profiles))


if __name__ == "__main__":
    main()

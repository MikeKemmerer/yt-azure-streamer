#!/usr/bin/env python3
"""Read-only YouTube discovery and local scheduler decisions."""

import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
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
    candidates = [e for e in events if not e["errors"] and e["end"] > now]
    for i, first in enumerate(candidates):
        for second in candidates[i + 1:]:
            if max(first["start"], second["start"]) < min(first["end"], second["end"]):
                aligned = first["start"] == second["start"] and first["end"] == second["end"]
                if first["profile"] == second["profile"] or not aligned:
                    first["errors"].append("Overlapping or staggered output windows")
                    second["errors"].append("Overlapping or staggered output windows")
    return sorted(events, key=lambda e: (e["start"] or 0, e["id"]))


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


def decision(schedule, cache, state, now, running=False, manual=False, stopped=False, hold=False):
    """Return scheduler command, profiles, and updated transient ownership."""
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
    if eligible:
        state["owner"] = {"events": [dict(e) for e in eligible], "startedAt": now}
        return "START", sorted({e["profile"] for e in eligible}), state
    return ("HOLD" if window else "IDLE"), [], state


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


def sync(root):
    schedule = read_json(root / "schedule.json", {})
    if (root / "mode").read_text().strip() != "local" or schedule.get("scheduleSource", "weekly") != "youtube":
        return
    status_path = root / "youtube-sync-status.json"
    status = read_json(status_path, {})
    now = time.time()
    if status.get("retryAt", 0) > now:
        return
    try:
        api = YouTube(root / "secrets" / "youtube-oauth.json", root / "youtube-quota.json")
        cache = discover(api, schedule, read_json(root / "youtube-schedule.json"), output_keys(root, schedule), now)
        atomic_json(root / "youtube-schedule.json", cache)
        atomic_json(status_path, {"ok": True, "checkedAt": now, "failures": 0,
                                 "callsToday": read_json(root / "youtube-quota.json", {}).get("calls", 0)})
    except Exception as error:
        failures = min(status.get("failures", 0) + 1, 8)
        # Never echo provider responses/exceptions, which may include credentials.
        message = "YouTube discovery failed; check authorization, configuration, and connectivity"
        if isinstance(error, ValueError):
            message = "YouTube configuration or response is invalid; check channel, rules, and discovery limits"
        if isinstance(error, ImportError):
            message = "Run the documented YouTube OAuth environment setup"
        if isinstance(error, QuotaLimitError):
            message = "Local YouTube daily request budget reached; new starts are blocked once discovery becomes stale"
        atomic_json(status_path, {"ok": False, "checkedAt": now, "failures": failures,
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
    parser.add_argument("command", choices=["sync", "decide", "authorize"])
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
        sync(args.root)
    else:
        state_path = args.run / "streamer-youtube-owner.json"
        schedule = read_json(args.root / "schedule.json", {})
        cache = read_json(args.root / "youtube-schedule.json")
        try:
            if cache and cache.get("keyFingerprint") != key_fingerprint(output_keys(args.root, schedule)):
                cache = None
        except (ValueError, TypeError, AttributeError):
            cache = None
        command, profiles, state = decision(
            schedule, cache,
            read_json(state_path, {}), time.time(), running=args.running,
            manual=(args.run / "streamer-manual-override").exists(),
            stopped=(args.run / "streamer-manual-stop").exists(),
            hold=(args.run / "streamer-queue-hold").exists())
        atomic_json(state_path, state)
        print(" ".join([command] + profiles))


if __name__ == "__main__":
    main()

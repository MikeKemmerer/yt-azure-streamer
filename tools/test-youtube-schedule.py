#!/usr/bin/env python3
import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
from types import SimpleNamespace

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("youtube_schedule", ROOT / "services/scheduler/youtube-schedule.py")
yt = importlib.util.module_from_spec(spec)
spec.loader.exec_module(yt)

NOW = yt.timestamp("2026-11-24T19:00:00Z")


def config():
    return {"scheduleSource": "youtube", "youtube": {"channelId": "UC-test", "rules": [
        {"title": "Sermons & Speakers", "profile": "landscape", "durationSeconds": 28800}
    ]}}


def broadcast(id="show", title="Sermons & Speakers", stream="main"):
    return {"id": id, "snippet": {"channelId": "UC-test", "title": title,
                                 "scheduledStartTime": "2026-11-24T11:00:00-08:00"},
            "status": {"lifeCycleStatus": "ready"},
            "contentDetails": {"boundStreamId": stream, "enableAutoStart": True, "enableAutoStop": True}}


def normalized(items=None, schedule=None):
    return yt.normalize(schedule or config(), items or [broadcast()],
                        {"main": {"cdn": {"ingestionInfo": {"streamName": "secret-main"}}},
                         "vertical": {"cdn": {"ingestionInfo": {"streamName": "secret-vertical"}}}},
                        {"landscape": "secret-main", "portrait": "secret-vertical"}, NOW)


def snapshot():
    return {"fingerprint": yt.fingerprint(config()),
            "keyFingerprint": yt.key_fingerprint({"landscape": "secret-main", "portrait": "secret-vertical"}),
            "fetchedAt": NOW, "events": normalized(), "terminal": {}}


class ScheduleTests(unittest.TestCase):
    def test_exact_normalized_title_and_offset_time(self):
        event = normalized([broadcast(title="  SERMONS  & speakers ")])[0]
        self.assertEqual(event["errors"], [])
        self.assertEqual(event["start"], NOW)
        self.assertEqual(event["end"], NOW + 28800)
        self.assertEqual(normalized([broadcast(title="Other Sermons & Speakers")]), [])

    def test_end_precedence_and_invalid_windows(self):
        item = broadcast()
        item["snippet"]["scheduledEndTime"] = "2026-11-25T03:00:00Z"
        self.assertEqual(normalized([item])[0]["end"], NOW + 28800)
        item["snippet"]["scheduledEndTime"] = "2026-11-24T20:00:00Z"
        self.assertEqual(normalized([item])[0]["end"], NOW + 3600)
        item["snippet"]["scheduledStartTime"] = "2026-11-24T11:00:00"
        self.assertIn("Invalid scheduled window", normalized([item])[0]["errors"])

    def test_wrong_channel_key_and_autostop(self):
        item = broadcast()
        item["snippet"]["channelId"] = "another-channel"
        item["contentDetails"]["enableAutoStop"] = False
        item["contentDetails"]["boundStreamId"] = "unknown"
        self.assertEqual(len(normalized([item])[0]["errors"]), 3)
        self.assertNotIn("secret-main", json.dumps(normalized([item])))

    def test_unrelated_future_binding_is_unsafe(self):
        other = broadcast(id="other", title="Unrelated show")
        other["snippet"]["scheduledStartTime"] = "2026-12-01T19:00:00Z"
        self.assertIn("Another broadcast shares this stream binding", normalized([broadcast(), other])[0]["errors"])

    def test_aligned_dual_outputs_and_stagger_rejection(self):
        schedule = config()
        schedule["youtube"]["rules"].append({"title": "Vertical Show", "profile": "portrait", "durationSeconds": 28800})
        vertical = broadcast("portrait", "Vertical Show", "vertical")
        self.assertTrue(all(not e["errors"] for e in normalized([broadcast(), vertical], schedule)))
        vertical["snippet"]["scheduledStartTime"] = "2026-11-24T19:10:00Z"
        self.assertTrue(all(e["errors"] for e in normalized([broadcast(), vertical], schedule)))

    def test_duplicate_and_invalid_rules(self):
        schedule = config()
        schedule["youtube"]["rules"].append({"title": "  sermons & speakers ", "profile": "portrait"})
        with self.assertRaisesRegex(ValueError, "Duplicate"):
            yt.settings(schedule)
        schedule["youtube"]["rules"] = [{"title": "Show", "profile": "landscape", "durationSeconds": True}]
        with self.assertRaises(ValueError):
            yt.settings(schedule)

    def test_owned_start_once_end_and_failed_stop_retry(self):
        command, profiles, state = yt.decision(config(), snapshot(), {}, NOW)
        self.assertEqual((command, profiles), ("START", ["landscape"]))
        command, _, state = yt.decision(config(), snapshot(), state, NOW + 30, running=True)
        self.assertEqual(command, "KEEP")
        command, _, state = yt.decision(config(), None, state, NOW + 28800, running=True)
        self.assertEqual(command, "STOP")
        command, _, state = yt.decision(config(), None, state, NOW + 28830, running=True)
        self.assertEqual(command, "STOP")
        command, _, state = yt.decision(config(), None, state, NOW + 28860)
        self.assertEqual(command, "IDLE")
        self.assertNotIn("owner", state)

    def test_outage_keeps_deadline_but_blocks_new_launches(self):
        cache = snapshot()
        self.assertEqual(yt.decision(config(), cache, {}, NOW + 601)[0], "IDLE")
        _, _, state = yt.decision(config(), cache, {}, NOW)
        self.assertEqual(yt.decision(config(), None, copy.deepcopy(state), NOW + 1000, running=True)[0], "KEEP")
        self.assertEqual(yt.decision(config(), None, state, NOW + 1000)[0], "HOLD")

    def test_fresh_but_too_late_and_clock_rollback(self):
        cache = snapshot()
        cache["fetchedAt"] = NOW + 601
        self.assertEqual(yt.decision(config(), cache, {}, NOW + 601)[0], "HOLD")
        self.assertEqual(yt.decision(config(), cache, {}, NOW)[0], "IDLE")

    def test_manual_stop_suppresses_event_and_manual_takeover(self):
        self.assertEqual(yt.decision(config(), None, {}, NOW, stopped=True)[0], "HOLD",
                         "stale discovery must not clear a manual stop")
        _, _, state = yt.decision(config(), snapshot(), {}, NOW)
        self.assertEqual(yt.decision(config(), snapshot(), state, NOW + 1, stopped=True, running=True)[0], "STOP")
        command, _, state = yt.decision(config(), snapshot(), state, NOW + 2, stopped=True)
        self.assertEqual(command, "HOLD")
        self.assertEqual(yt.decision(config(), snapshot(), state, NOW + 3)[0], "HOLD")
        _, _, state = yt.decision(config(), snapshot(), {}, NOW)
        command, _, state = yt.decision(config(), snapshot(), state, NOW + 1, manual=True, running=True)
        self.assertEqual(command, "MANUAL")
        self.assertNotIn("owner", state)
        self.assertEqual(yt.decision(config(), None, state, NOW + 40000, running=True)[0], "MANUAL")

    def test_queue_hold_and_unowned_session(self):
        self.assertEqual(yt.decision(config(), snapshot(), {}, NOW, hold=True)[0], "HOLD")
        self.assertEqual(yt.decision(config(), snapshot(), {}, NOW, running=True)[0], "MANUAL")

    def test_verified_completion_blocks_retry(self):
        cache = snapshot()
        _, _, state = yt.decision(config(), cache, {}, NOW)
        cache["terminal"] = {"show": "complete"}
        command, _, state = yt.decision(config(), cache, state, NOW + 10, running=True)
        self.assertEqual(command, "STOP")
        _, _, state = yt.decision(config(), cache, state, NOW + 20)
        self.assertEqual(yt.decision(config(), snapshot(), state, NOW + 30)[0], "HOLD")

    def test_rescheduling_owned_run_cannot_switch_profiles(self):
        cache = snapshot()
        _, _, state = yt.decision(config(), cache, {}, NOW)
        cache["events"][0]["end"] = NOW + 3600
        _, _, state = yt.decision(config(), cache, state, NOW + 10, running=True)
        self.assertEqual(state["owner"]["events"][0]["end"], NOW + 3600)
        cache["events"][0]["profile"] = "portrait"
        self.assertEqual(yt.decision(config(), cache, state, NOW + 20, running=True)[0], "STOP")

    def test_discovery_tracks_completion_and_deletion(self):
        class API:
            def get(self, resource, **params):
                if resource == "channels":
                    return {"items": [{"id": "UC-test"}]}
                if resource == "liveBroadcasts":
                    done = broadcast()
                    done["status"]["lifeCycleStatus"] = "complete"
                    return {"items": [done]}
                return {"items": [{"id": "main", "cdn": {"ingestionInfo": {"streamName": "secret-main"}}}]}

            def pages(self, resource, **params):
                self_outer.assertNotIn("mine", params)
                return []
        self_outer = self
        previous = snapshot()
        previous["events"].append({**previous["events"][0], "id": "deleted"})
        data = yt.discover(API(), config(), previous, {"landscape": "secret-main"}, NOW)
        self.assertEqual(data["terminal"], {"show": "complete", "deleted": "deleted"})
        self.assertNotIn("secret-main", json.dumps(data))

    def test_pagination_and_page_limit(self):
        api = object.__new__(yt.YouTube)
        calls = []

        def get(resource, **params):
            calls.append(params)
            if "pageToken" not in params:
                return {"items": [{"id": "first"}], "nextPageToken": "second"}
            return {"items": [{"id": "last"}]}
        api.get = get
        self.assertEqual([e["id"] for e in api.pages("liveBroadcasts", broadcastStatus="upcoming")], ["first", "last"])
        self.assertEqual(calls[1]["pageToken"], "second")
        api.get = lambda *args, **kw: {"items": [], "nextPageToken": "forever"}
        with self.assertRaisesRegex(ValueError, "page limit"):
            api.pages("liveBroadcasts")

    def test_atomic_snapshot_and_secret_permissions(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "credential.json"
            yt.atomic_json(path, {"refresh_token": "fixture"}, 0o600)
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(yt.read_json(path)["refresh_token"], "fixture")
            self.assertEqual(len(list(Path(directory).iterdir())), 1)

    def test_failed_sync_preserves_previous_snapshot_and_redacts(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "mode").write_text("local")
            yt.atomic_json(root / "schedule.json", config())
            yt.atomic_json(root / "youtube-schedule.json", snapshot())
            original = yt.YouTube
            try:
                def fail(*args):
                    raise RuntimeError("private-token-and-provider-response")
                yt.YouTube = fail
                yt.sync(root)
            finally:
                yt.YouTube = original
            self.assertEqual(yt.read_json(root / "youtube-schedule.json"), snapshot())
            status = yt.read_json(root / "youtube-sync-status.json")
            self.assertFalse(status["ok"])
            self.assertNotIn("private-token", json.dumps(status))
            self.assertGreater(status["retryAt"], status["checkedAt"])

    def test_daily_budget_counts_requests_and_resets_on_pacific_date(self):
        with tempfile.TemporaryDirectory() as directory:
            api = object.__new__(yt.YouTube)
            api.credentials = SimpleNamespace(token="private-fixture")
            api.deadline = time.monotonic() + 50
            api.quota_path = Path(directory) / "quota.json"
            yt.atomic_json(api.quota_path, {"day": "2000-01-01", "calls": yt.DAILY_CALL_LIMIT})
            response = SimpleNamespace(read=lambda limit: b'{"items":[]}')
            class Response:
                def __enter__(self):
                    return response
                def __exit__(self, *args):
                    pass
            with patch.object(yt.urllib.request, "urlopen", return_value=Response()) as request:
                self.assertEqual(api.get("channels", part="id", mine="true"), {"items": []})
                self.assertEqual(yt.read_json(api.quota_path)["calls"], 1)
                self.assertIn("Bearer private-fixture", request.call_args[0][0].get_header("Authorization"))
            usage = yt.read_json(api.quota_path)
            usage["calls"] = yt.DAILY_CALL_LIMIT
            yt.atomic_json(api.quota_path, usage)
            with patch.object(yt.urllib.request, "urlopen") as request:
                with self.assertRaises(yt.QuotaLimitError):
                    api.get("channels", part="id", mine="true")
                request.assert_not_called()

    def test_installed_oauth_library_accepts_restricted_offline_credentials(self):
        try:
            from google_auth_oauthlib.flow import InstalledAppFlow
        except ImportError:
            self.skipTest("Optional OAuth environment not installed")
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "oauth.json"
            yt.atomic_json(path, {"type": "authorized_user", "client_id": "fixture", "client_secret": "fixture",
                                 "refresh_token": "fixture", "token": "fixture", "expiry": "2099-01-01T00:00:00Z",
                                 "scopes": [yt.SCOPE]}, 0o600)
            api = yt.YouTube(path, Path(directory) / "quota.json")
            self.assertTrue(api.credentials.valid)
            self.assertEqual(api.credentials.scopes, [yt.SCOPE])
            flow = InstalledAppFlow.from_client_config({"installed": {
                "client_id": "fixture", "client_secret": "fixture",
                "auth_uri": "https://accounts.google.com/o/oauth2/auth",
                "token_uri": "https://oauth2.googleapis.com/token"
            }}, [yt.SCOPE])
            url, _ = flow.authorization_url(access_type="offline")
            self.assertIn("youtube.readonly", url)

    def test_production_bash_dispatch_owns_systemctl(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            now = time.time()
            (root / "secrets").mkdir()
            (root / "secrets/youtube-stream-key").write_text("secret-main")
            (root / "secrets/youtube-stream-key-portrait").write_text("secret-vertical")
            cache = snapshot()
            cache["fetchedAt"] = now
            cache["events"][0].update(start=now - 5, end=now + 60)
            yt.atomic_json(root / "schedule.json", config())
            yt.atomic_json(root / "youtube-schedule.json", cache)
            source = (ROOT / "services/scheduler/scheduler.sh").read_text()
            functions = source[source.index("update_stream_signals()"):source.index("\nwhile true; do")]
            harness = root / "harness.sh"
            harness.write_text('''#!/usr/bin/env bash
set -euo pipefail
ROOT="$1"; HELPER="$2"
ACTIVE_LANDSCAPE="$ROOT/streamer-active-landscape"
ACTIVE_PORTRAIT="$ROOT/streamer-active-portrait"
MANUAL_STOP="$ROOT/streamer-manual-stop"
stream_is_running() { [[ -f "$ROOT/running" ]]; }
python3() { shift; command python3 "$HELPER" "$@" --root "$ROOT" --run "$ROOT"; }
systemctl() {
  if [[ "$1" == show ]]; then
    if [[ -f "$ROOT/running" ]]; then echo active; else echo inactive; fi
    return
  fi
  echo "$1" >> "$ROOT/calls"
  if [[ "$1" == start ]]; then touch "$ROOT/running"; else rm -f "$ROOT/running"; fi
}
''' + functions + "\nyoutube_schedule_tick\n")

            def tick():
                subprocess.run(["bash", str(harness), str(root), str(ROOT / "services/scheduler/youtube-schedule.py")],
                               check=True, capture_output=True, timeout=10)
            (root / "secrets/youtube-stream-key").write_text("changed-key")
            tick()
            self.assertFalse((root / "calls").exists())
            (root / "secrets/youtube-stream-key").write_text("secret-main")
            tick()
            tick()
            self.assertEqual((root / "calls").read_text().splitlines(), ["start"])
            self.assertTrue((root / "streamer-active-landscape").exists())
            owner = yt.read_json(root / "streamer-youtube-owner.json")
            owner["owner"]["events"][0]["end"] = now - 1
            yt.atomic_json(root / "streamer-youtube-owner.json", owner)
            # An outage must still honor the committed deadline.
            (root / "youtube-schedule.json").unlink()
            tick()
            tick()
            self.assertEqual((root / "calls").read_text().splitlines(), ["start", "stop"])


if __name__ == "__main__":
    unittest.main()

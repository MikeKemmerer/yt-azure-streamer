#!/usr/bin/env python3
import datetime as dt
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
HELPER = Path(__file__).resolve().parents[1] / "services/streamer/streamer-diagnostics.py"
spec = importlib.util.spec_from_file_location("diagnostics", HELPER)
d = importlib.util.module_from_spec(spec)
spec.loader.exec_module(d)


class DiagnosticsTests(unittest.TestCase):
    def test_expiry_is_sanitized_and_has_warning_boundaries(self):
        now = dt.datetime(2026, 1, 1, tzinfo=dt.timezone.utc).timestamp()
        for days, severity in ((90, "ok"), (30, "warn"), (7, "error"), (-1, "error")):
            expires = dt.datetime.fromtimestamp(now + days * 86400, dt.timezone.utc).isoformat().replace("+00:00", "Z")
            result = d.expiry_info(f"azstorage:\n  mode: sas\n  sas: 'sig=never-export-this&se={expires}'", now)
            self.assertEqual(result["severity"], severity)
            self.assertEqual(result["days_remaining"], days)
            self.assertNotIn("never-export-this", json.dumps(result))
            json_result = d.expiry_info(json.dumps({"azstorage": {
                "mode": "sas", "sas": f"sig=never-export-this&se={expires}"}}), now)
            self.assertEqual(json_result, result)
            self.assertNotIn("never-export-this", json.dumps(json_result))
        self.assertEqual(d.expiry_info("mode: msi", now)["severity"], "ok")
        self.assertEqual(d.expiry_info("auth-type: msi", now)["mode"], "msi")
        self.assertEqual(d.expiry_info("mode: sas\nsas: sig=private", now)["severity"], "unknown")
        self.assertEqual(d.expiry_info("mode: sas\nsas: se=invalid&sig=private", now)["severity"], "unknown")

    def test_probe_reads_only_small_recording_and_preserves_library(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "sample.mp4").write_bytes(b"media" * 2000)
            (root / "playlist-config.json").write_text(json.dumps({"videos": [{"file": "sample.mp4", "enabled": True}]}))
            result = d.storage_probe(root, root, str(root))
            self.assertEqual(result["severity"], "ok")
            self.assertEqual(result["available_count"], 1)
            self.assertEqual(result["saved_enabled_count"], 1)
            self.assertEqual(result["total_bytes"], 10000)
            self.assertFalse(result["remote_roundtrip_verified"])
            self.assertEqual((root / "sample.mp4").stat().st_size, 10000)
            with (root / "streamer-diagnostics-storage.lock").open("a") as lock:
                d.fcntl.flock(lock, d.fcntl.LOCK_EX | d.fcntl.LOCK_NB)
                self.assertEqual(d.storage_probe(root, root, str(root))["severity"], "unknown")

    def test_nonregular_entries_and_malformed_playlist_are_safe(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "directory.mp4").mkdir()
            (root / "link.mp4").symlink_to(root / "directory.mp4")
            os.mkfifo(root / "pipe.mp4")
            self.assertEqual(d.storage_probe(root, root, directory)["available_count"], 0)
            (root / "valid.mp4").write_bytes(b"small")
            for config in ([], {"videos": None}, {"videos": "invalid"}):
                (root / "playlist-config.json").write_text(json.dumps(config))
                result = d.storage_probe(root, root, directory)
                self.assertEqual(result["severity"], "ok")
                self.assertEqual(result["available_count"], 1)
                self.assertEqual(result["read_bytes"], 5)

    def test_azure_template_auth_and_absent_mount(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "blobfuse2").mkdir()
            (root / "blobfuse2/blobfuse2.yaml").write_text("azstorage:\n  auth-type: msi\n")
            reply = subprocess.CompletedProcess([], 0, stdout="", stderr="")
            with patch.object(d.subprocess, "run", return_value=reply) as command:
                result = d.collect(root, root, directory, "azure")
            self.assertEqual(command.call_count, 1, "missing mount must not trigger a recording read")
            self.assertEqual(result["auth"]["mode"], "msi")
            self.assertEqual(result["storage"]["severity"], "error")
            self.assertTrue(result["storage_mount"]["required"])

    def test_real_cli_collects_without_mutating_playback(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "sample.mp4").write_bytes(b"fixture media")
            (root / "streamer-control-state.json").write_text('{"session":"preserve-me"}')
            reply = subprocess.run([sys.executable, str(HELPER), "--root", directory, "--run", directory,
                                    "--mode", "local", "--video-dir", directory],
                                   capture_output=True, text=True, timeout=8, check=True)
            result = json.loads(reply.stdout)
            self.assertEqual(result["storage"]["severity"], "ok")
            self.assertEqual(result["storage"]["read_bytes"], 13)
            self.assertEqual(result["storage"]["total_bytes"], 13)
            self.assertGreater(result["resources"]["uptime_seconds"], 0)
            self.assertGreater(result["resources"]["disk_total_bytes"], 0)
            self.assertEqual(result["auth"]["mode"], "not_applicable")
            self.assertEqual((root / "streamer-control-state.json").read_text(), '{"session":"preserve-me"}')

    def test_empty_library_and_storage_timeout_are_not_healthy(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.assertEqual(d.storage_probe(root, root, directory)["severity"], "error")
            def run(args, **kwargs):
                if args[0] == "systemctl":
                    return subprocess.CompletedProcess(args, 0, stdout="", stderr="")
                self.assertEqual(kwargs["timeout"], 3)
                raise subprocess.TimeoutExpired(args, 3)
            with patch.object(d.subprocess, "run", side_effect=run):
                result = d.collect(root, root, directory, "local")
            self.assertEqual(result["storage"]["severity"], "unknown")
            self.assertIn("timed out", result["storage"]["reason"])
            self.assertIn("observed_at", result)


if __name__ == "__main__":
    unittest.main()

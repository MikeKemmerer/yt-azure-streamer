#!/usr/bin/env python3
import importlib.util
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path


sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location(
    "streamer_control", Path(__file__).resolve().parents[1] / "services/streamer/streamer-control.py"
)
control = importlib.util.module_from_spec(spec)
spec.loader.exec_module(control)


class QueueTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        root = Path(self.temporary.name)
        for name in ("run", "etc", "media", "overlays"):
            (root / name).mkdir()
        self.media = root / "media"
        self.files = [str(self.media / f"{name}.mp4") for name in "ABCD"]
        for filename in self.files:
            Path(filename).touch()
        (root / "etc/playlist.txt").write_text(
            "".join(f"file '{filename}'\n" for filename in self.files)
        )
        self.actor = control.Controller(root / "run", root / "etc", root / "overlays")
        self.state = self.actor.init(0, os.getpid(), str(self.media))
        self.available = self.actor.available(self.state)

    def command(self, operation, **values):
        return {
            "id": f"action-{len(self.state['actions'])}",
            "session": self.state["session"], "revision": self.state["revision"],
            "operation": operation, **values,
        }

    def apply(self, operation, **values):
        self.state, interrupted = control.apply_command(
            self.state, self.command(operation, **values), self.available, self.files
        )
        return interrupted

    def upcoming(self):
        return [Path(item["file"]).name for item in self.state["upcoming"]]

    def next(self):
        self.state = control.advance(self.state, self.files, set(self.files))
        return Path(self.state["current"]["file"]).name

    def test_play_now_returns_to_ordinary_queue_without_duplicate(self):
        self.assertTrue(self.apply("now", file="D.mp4"))
        self.assertEqual(self.upcoming(), ["B.mp4", "C.mp4"])
        self.assertEqual([self.next(), self.next(), self.next()], ["D.mp4", "B.mp4", "C.mp4"])
        self.assertTrue(self.state["current"]["ordinary"])
        self.assertEqual(self.next(), "A.mp4")

    def test_next_moves_existing_and_preserves_current(self):
        self.assertFalse(self.apply("next", file="D.mp4"))
        self.assertEqual(self.upcoming(), ["D.mp4", "B.mp4", "C.mp4"])
        self.assertEqual(self.state["current"]["file"], self.files[0])
        self.assertEqual(self.next(), "D.mp4")
        self.assertFalse(self.state["current"]["ordinary"], "Queue Next is a temporary request, not a rotation bookmark")
        self.assertEqual(self.next(), "B.mp4")

    def test_bookmarked_rotation_refills_at_the_original_cycle_anchor(self):
        self.state = self.actor.init(2, os.getpid(), str(self.media))
        self.assertEqual([self.next() for _ in range(4)], ["D.mp4", "A.mp4", "B.mp4", "C.mp4"])

    def test_clear_is_not_natural_exhaustion(self):
        self.apply("replace", files=[])
        self.next()
        self.assertTrue(self.state["stopped"])
        state = self.actor.init(3, os.getpid(), str(self.media))
        state["upcoming"] = []
        state = control.advance(state, self.files, set(self.files))
        self.assertEqual(state["current"]["file"], self.files[3])
        self.assertFalse(state["stopped"])

    def test_reset_cancels_pending_empty(self):
        self.apply("replace", files=[])
        self.apply("reset")
        self.assertFalse(self.state["explicitEmpty"])
        self.assertEqual(self.upcoming(), ["B.mp4", "C.mp4", "D.mp4"])

    def test_unavailable_media_does_not_create_operator_stop_hold(self):
        for filename in self.files:
            Path(filename).unlink()
        state = self.actor.next()
        self.assertTrue(state["stopped"])
        self.assertFalse(state["explicitEmpty"])
        self.assertFalse((self.actor.run / "streamer-queue-hold").exists())

    def test_conflicts_duplicates_current_and_unavailable(self):
        for values in (
            {"session": "old"}, {"revision": 0},
            {"files": ["B.mp4", "B.mp4"]}, {"files": ["A.mp4"]},
            {"files": ["../B.mp4"]}, {"files": [[]]},
        ):
            with self.subTest(values=values), self.assertRaises(ValueError):
                control.apply_command(
                    self.state, {**self.command("replace", files=["B.mp4"]), **values},
                    self.available, self.files,
                )

    def test_repeated_request_does_not_interrupt_twice(self):
        command = self.command("now", file="D.mp4")
        self.state, _ = control.apply_command(self.state, command, self.available, self.files)
        original = json.dumps(self.state)
        self.state, interrupted = control.apply_command(self.state, command, self.available, self.files)
        self.assertFalse(interrupted)
        self.assertEqual(json.dumps(self.state), original)
        with self.assertRaises(ValueError):
            control.apply_command(
                self.state, self.command("now", file="B.mp4"), self.available, self.files
            )

    def test_concat_single_quote_paths_are_preserved(self):
        filename = str(self.media / "Bob's sermon.mp4")
        Path(filename).touch()
        escaped = filename.replace("'", "'\\''")
        (self.actor.etc / "playlist.txt").write_text(f"file '{escaped}'\n")
        self.assertEqual(self.actor.saved(), [filename])

    def test_reset_during_one_off_excludes_current_request(self):
        self.apply("now", file="D.mp4")
        self.next()
        self.apply("reset")
        self.assertEqual(self.upcoming(), ["A.mp4", "B.mp4", "C.mp4"])

    def test_missing_requested_video_is_rejected_not_acknowledged_on_wrong_video(self):
        self.apply("now", file="D.mp4")
        self.state = control.advance(self.state, self.files, set(self.files[:-1]))
        self.assertEqual(Path(self.state["current"]["file"]).name, "B.mp4")
        self.assertEqual(self.state["actions"][-1]["status"], "rejected")

    def test_mailbox_ack_and_generation_match(self):
        control.atomic_json(self.actor.request_file, self.command("now", file="D.mp4"))
        self.assertTrue(self.actor.command())
        self.assertFalse(self.actor.request_file.exists())
        self.actor.next()
        self.actor.launched(os.getpid(), os.getpid())
        generation = self.actor.prepare()
        current = control.read_json(self.actor.state_file)["current"]
        self.assertFalse(any(key in current for key in ("encoderPid", "encoderStart", "telemetryPid", "telemetryStart")),
                         "preparing a retry must invalidate previous process identities")
        control.atomic_json(self.actor.onair_file, {"generation": "previous"})
        self.actor.confirm()
        self.assertEqual(control.read_json(self.actor.state_file)["actions"][-1]["status"], "starting")
        control.atomic_json(self.actor.onair_file, {"generation": generation})
        self.actor.confirm()
        self.assertEqual(control.read_json(self.actor.state_file)["actions"][-1]["status"], "applied")

    def test_restart_discards_queue_edits_without_writing_bookmark(self):
        self.apply("replace", files=["D.mp4"])
        self.actor.save(self.state)
        restored = self.actor.init(1, os.getpid(), str(self.media))
        self.assertEqual(restored["current"]["file"], self.files[1])
        self.assertNotEqual(restored["session"], self.state["session"])
        self.assertEqual(restored["actions"], [])
        self.assertFalse((self.actor.etc / "playlist-state.json").exists())

    def test_bad_mailbox_and_pending_stop_do_not_interrupt(self):
        self.actor.request_file.write_text("not json")
        self.assertFalse(self.actor.command())
        control.atomic_json(self.actor.request_file, self.command("now", file="D.mp4"))
        (self.actor.run / "streamer-stop-after-current").touch()
        self.assertFalse(self.actor.command())
        self.assertEqual(control.read_json(self.actor.state_file)["actions"][-1]["status"], "rejected")

    def test_invalid_optional_titles_do_not_block_queue_application(self):
        cases = [(None, "C"), (42, "C"), ({"invalid": "collection"}, "C"), ([
            {"file": [], "title": "invalid filename"},
            {"file": "C.mp4", "title": {"invalid": "title"}},
        ], "C"), ([{"file": "C.mp4", "title": "\ud800"}], "?")]
        for videos, title in cases:
            with self.subTest(videos=videos):
                control.atomic_json(self.actor.etc / "playlist-config.json", {"videos": videos})
                self.state = self.actor.init(0, os.getpid(), str(self.media))
                control.atomic_json(self.actor.request_file, self.command("replace", files=["C.mp4"]))
                self.assertFalse(self.actor.command())
                self.assertFalse(self.actor.request_file.exists())
                self.assertEqual(control.read_json(self.actor.state_file)["actions"][-1]["status"], "applied")
                self.assertEqual((self.actor.overlays / "streamer-upnext.txt").read_text(), f"Up Next: {title}")


if __name__ == "__main__":
    unittest.main()

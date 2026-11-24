#!/usr/bin/env python3
import importlib.util
import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path


sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location(
    "streamer_control", Path(__file__).resolve().parents[1] / "services/streamer/streamer-control.py"
)
control = importlib.util.module_from_spec(spec)
spec.loader.exec_module(control)


class QueueTests(unittest.TestCase):
    def test_automatic_display_title_cleanup(self):
        for value, expected in (
            ("2020-10-04 - October 4, 2020 - Love Beyond Fairness.mp4", "October 4, 2020 - Love Beyond Fairness"),
            ("2020-10-04_Title.MP4.mp4", "Title"),
            ("  Custom title.mp4  ", "Custom title"),
            ("October 4, 2020 - Love Beyond Fairness.mp4", "October 4, 2020 - Love Beyond Fairness"),
            ("Love in 2020-10-04.mp4", "Love in 2020-10-04"),
            ("Faith.mp4 and life.mp4", "Faith.mp4 and life"),
        ):
            self.assertEqual(control.display_title(value), expected)
        (self.actor.etc / "playlist-config.json").write_text(json.dumps({
            "videos": [{"file": "B.mp4", "title": "2020-10-04 - Love Beyond Fairness.mp4"}]
        }))
        self.actor.overlay(self.state)
        for name in ("streamer-upnext.txt", "streamer-upnext-portrait.txt"):
            self.assertEqual((self.actor.overlays / name).read_text(), "Up Next: Love Beyond Fairness")

    def test_portrait_titles_use_three_lines_without_losing_words(self):
        title = "January 4, 2025 - Repentance is the Beginning, Middle, and End to a Christian Way of Life"
        wrapped = control.wrap_overlay(title, 40, 3)
        self.assertEqual(len(wrapped.splitlines()), 3)
        self.assertEqual(" ".join(wrapped.splitlines()), title)
        self.assertLess(max(map(len, wrapped.splitlines())), 40)
        self.assertEqual(control.wrap_overlay("Short sermon", 40, 3), "Short sermon")
        self.assertEqual(control.wrap_overlay("A title that takes two lines", 40, 3), "A title that takes two lines")
        self.assertEqual(control.wrap_overlay("X" * 90, 40, 3).splitlines(), ["X" * 30] * 3)
        (self.actor.etc / "playlist-config.json").write_text(json.dumps({
            "videos": [{"file": "B.mp4", "title": title}]
        }))
        self.actor.overlay(self.state)
        portrait = (self.actor.overlays / "streamer-upnext-portrait.txt").read_text()
        landscape = (self.actor.overlays / "streamer-upnext.txt").read_text()
        self.assertEqual(len(portrait.splitlines()), 3)
        self.assertLessEqual(len(landscape.splitlines()), 2)
        self.assertEqual(" ".join(portrait.splitlines()), "Up Next: " + title)
        for shorter, expected_lines in (
            ("A concise sermon title", 1),
            ("February 16, 2025 - The Parable of the Prodigal Son", 2),
        ):
            (self.actor.etc / "playlist-config.json").write_text(json.dumps({
                "videos": [{"file": "B.mp4", "title": shorter}]
            }))
            self.actor.overlay(self.state)
            actual = (self.actor.overlays / "streamer-upnext-portrait.txt").read_text()
            self.assertEqual(len(actual.splitlines()), expected_lines)
            self.assertEqual(" ".join(actual.splitlines()), "Up Next: " + shorter)

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

    def checkpoint(self, elapsed=45, offset=0, ordinary=True):
        state = control.read_json(self.actor.state_file)
        state["current"].update(offsetSeconds=offset, ordinary=ordinary)
        self.actor.save(state)
        generation = self.actor.prepare()
        control.atomic_json(self.actor.run / "streamer-now.json", {
            "file": state["current"]["file"], "duration": 120,
        })
        sample = {"generation": generation, "elapsed": elapsed, "at": time.time(), "end": False}
        control.atomic_json(self.actor.progress_file, sample)
        self.assertTrue(self.actor.checkpoint())
        return sample

    def test_persistent_resume_restores_video_and_saved_rotation_after_reboot(self):
        self.actor.init(2, os.getpid(), str(self.media))
        self.checkpoint()
        bookmark = self.actor.etc / "playlist-state.json"
        bookmark.write_text('{"last_file":"A.mp4","last_index":0}')
        for filename in self.actor.run.iterdir():
            filename.unlink()
        restarted = self.actor.init(1, os.getpid(), str(self.media))
        self.assertEqual(restarted["current"]["file"], self.files[2])
        self.assertEqual(restarted["current"]["offsetSeconds"], 43)
        self.assertEqual([item["file"] for item in restarted["upcoming"]],
                         [self.files[3], self.files[0], self.files[1]])
        self.assertEqual(json.loads(bookmark.read_text())["last_file"], "A.mp4")

    def test_resumed_request_does_not_change_ordinary_bookmark_or_repeat_request(self):
        self.actor.init(3, os.getpid(), str(self.media))
        self.checkpoint(ordinary=False)
        restarted = self.actor.init(1, os.getpid(), str(self.media))
        self.assertFalse(restarted["current"]["ordinary"])
        self.assertEqual(restarted["current"]["file"], self.files[3])
        self.assertEqual([item["file"] for item in restarted["upcoming"]],
                         [self.files[1], self.files[2], self.files[0]])

    def test_resume_rejects_bad_positions_media_and_directory(self):
        self.checkpoint()
        original = control.read_json(self.actor.resume_file)
        for changes in (
            {"position": -1}, {"position": float("nan")}, {"position": float("inf")},
            {"position": True}, {"position": "45"}, {"position": 120},
            {"file": "../A.mp4"}, {"file": "missing.mp4"}, {"size": 1},
            {"videoDir": "/different/storage"}, {"duration": float("nan")},
            {"ordinary": "true"}, {"version": 99},
        ):
            with self.subTest(changes=changes):
                control.atomic_json(self.actor.resume_file, {**original, **changes})
                self.assertIsNone(self.actor.resume(str(self.media)))
        for content in ("not json", "[]", "null", '{"file":{}}'):
            self.actor.resume_file.write_text(content)
            self.assertIsNone(self.actor.resume(str(self.media)))
        control.atomic_json(self.actor.resume_file, original)
        (self.actor.etc / "playlist.txt").write_text(
            "".join(f"file '{filename}'\n" for filename in self.files[1:]))
        restarted = self.actor.init(0, os.getpid(), str(self.media))
        self.assertEqual(restarted["current"]["file"], self.files[1])
        self.assertNotIn("offsetSeconds", restarted["current"])

    def test_controlled_checkpoint_accumulates_seek_offset_and_retries(self):
        sample = self.checkpoint(elapsed=15, offset=30)
        self.assertEqual(self.actor.offset(), 43)
        self.assertFalse(self.actor.checkpoint(sample),
                         "old elapsed time must not be added to a newly selected seek offset")
        generation = self.actor.prepare()
        next_sample = {**sample, "generation": generation, "elapsed": 10, "at": time.time()}
        self.assertTrue(self.actor.checkpoint(next_sample))
        self.assertEqual(control.read_json(self.actor.resume_file)["position"], 53)
        self.assertFalse(self.actor.checkpoint({**next_sample, "elapsed": 8}))
        restarted = self.actor.init(0, os.getpid(), str(self.media))
        self.assertEqual(restarted["current"]["offsetSeconds"], 51)

    def test_completion_and_intentional_interrupts_cannot_resurrect_checkpoint(self):
        for operation in ("skip", "now", "complete"):
            with self.subTest(operation=operation):
                self.state = self.actor.init(0, os.getpid(), str(self.media))
                sample = self.checkpoint()
                if operation == "complete":
                    self.actor.discard_resume()
                else:
                    self.state = control.read_json(self.actor.state_file)
                    command = self.command(operation, **({"file": "D.mp4"} if operation == "now" else {}))
                    control.atomic_json(self.actor.request_file, command)
                    self.assertTrue(self.actor.command())
                self.assertFalse(self.actor.resume_file.exists())
                self.assertFalse(self.actor.checkpoint(sample))
                self.assertFalse(self.actor.resume_file.exists())

    def test_encoder_end_and_stale_samples_do_not_erase_restart_position(self):
        sample = self.checkpoint()
        for changes in (
            {"end": True}, {"generation": "old"}, {"at": time.time() - 11},
            {"elapsed": float("inf")}, {"elapsed": float("nan")},
        ):
            with self.subTest(changes=changes):
                self.assertFalse(self.actor.checkpoint({**sample, **changes}))
                self.assertEqual(control.read_json(self.actor.resume_file)["position"], 45)
        self.actor.resume_file.write_text("[]")
        self.assertTrue(self.actor.checkpoint(sample))

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

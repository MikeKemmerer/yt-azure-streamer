#!/usr/bin/env python3
"""Check actual ffmpeg progress and independence from telemetry-reader failure."""

import json
import os
import select
import subprocess
import tempfile
import time
import unittest
from pathlib import Path


HELPER = Path(__file__).resolve().parents[1] / "services/streamer/streamer-control.py"


class ProgressTests(unittest.TestCase):
    def test_controlled_restart_keeps_fresh_checkpoint_and_seeks_production_input(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ("run", "etc", "media", "overlays"):
                (root / name).mkdir()
            media = root / "media/sermon.mp4"
            subprocess.run([
                "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error",
                "-f", "lavfi", "-i", "color=s=64x64:r=30:d=8",
                "-c:v", "libx264", str(media),
            ], check=True, timeout=15)
            (root / "etc/playlist.txt").write_text(f"file '{media}'\n")
            options = ["--run", str(root / "run"), "--etc", str(root / "etc"),
                       "--overlays", str(root / "overlays")]

            def helper(*args):
                return subprocess.run(
                    ["python3", str(HELPER), *args, *options],
                    check=True, capture_output=True, text=True, timeout=10).stdout.strip()

            helper("init", "--owner", str(os.getpid()), "--video-dir", str(root / "media"))
            generation = helper("prepare")
            state_path = root / "run/streamer-control-state.json"
            state = json.loads(state_path.read_text())
            state["current"]["offsetSeconds"] = 2
            state_path.write_text(json.dumps(state))
            (root / "run/streamer-now.json").write_text(json.dumps({
                "file": str(media), "duration": 8, "offsetSeconds": 2,
            }))
            source = (HELPER.parent / "streamer.sh").read_text()
            prefix = next(
                line.strip().split('"${EXTRA_INPUTS[@]}"')[0]
                for line in source.splitlines()
                if line.strip().startswith("ffmpeg -y -re ")
            )
            receiver = subprocess.Popen([
                "python3", str(HELPER), "telemetry", "--generation", generation, *options
            ], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            encoder = None
            try:
                ready, _, _ = select.select([receiver.stdout], [], [], 10)
                self.assertTrue(ready, "Telemetry reader did not become ready")
                port = int(receiver.stdout.readline().strip())
                environment = {**os.environ, "VIDEO": str(media), "RESUME_SECONDS": "2"}
                encoder = subprocess.Popen([
                    "bash", "-c", "exec " + prefix + " -nostdin -hide_banner -loglevel error"
                    f" -progress 'udp://127.0.0.1:{port}?pkt_size=1024&connect=0'"
                    " -c:v libx264 -preset veryfast -f null -",
                ], env=environment, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                    stderr=subprocess.PIPE, text=True)
                progress_path = root / "run/streamer-progress.json"
                deadline = time.monotonic() + 10
                while time.monotonic() < deadline:
                    if progress_path.exists() and json.loads(progress_path.read_text())["elapsed"] >= 1.5:
                        break
                    time.sleep(0.05)
                else:
                    self.fail("Encoder did not publish measured playback")
                self.assertTrue((root / "etc/playback-resume.json").exists(),
                                "The telemetry reader must persist position without a controlled stop")
                helper("checkpoint")
                checkpoint = json.loads((root / "etc/playback-resume.json").read_text())
                self.assertGreaterEqual(checkpoint["position"], 3.5)
                encoder.terminate()
                _, errors = encoder.communicate(timeout=5)
                self.assertIn(encoder.returncode, (0, 255), errors)
                time.sleep(0.1)
                receiver.terminate()
                receiver.wait(timeout=5)
                preserved = json.loads((root / "etc/playback-resume.json").read_text())
                self.assertEqual(preserved["position"], checkpoint["position"],
                                 "FFmpeg progress=end on SIGTERM must not erase the stop checkpoint")
                helper("init", "--owner", str(os.getpid()), "--video-dir", str(root / "media"))
                restored = json.loads(state_path.read_text())
                self.assertEqual(restored["current"]["file"], str(media))
                offset = restored["current"]["offsetSeconds"]
                self.assertAlmostEqual(offset, checkpoint["position"] - 2, places=3)
                audio_setup = source[source.index("  EXTRA_INPUTS=()"):
                                     source.index("  # --- Determine which streams are active ---")]
                result = subprocess.run([
                    "bash", "-c", audio_setup + "\n" + prefix.replace(" -re ", " ", 1)
                    + ' "${EXTRA_INPUTS[@]}" -nostdin -hide_banner -loglevel error -progress pipe:1'
                    ' -filter_complex "$AUDIO_FILTER" -map 0:v -map "[audio]"'
                    " -c:v libx264 -preset veryfast -c:a aac -f null -",
                ], env={**environment, "RESUME_SECONDS": str(offset), "DURATION": "8", "HAS_AUDIO": ""},
                    capture_output=True, text=True, timeout=10)
                self.assertEqual(result.returncode, 0, result.stderr)
                elapsed = [int(line.split("=")[1]) / 1e6 for line in result.stdout.splitlines()
                           if line.startswith("out_time_us=") and line.split("=")[1].lstrip("-").isdigit()]
                self.assertAlmostEqual(elapsed[-1], 8 - offset, delta=0.2,
                                       msg="Production input and generated audio must both use the remaining duration")
            finally:
                for process in (encoder, receiver):
                    if process is not None and process.poll() is None:
                        process.terminate()
                        process.wait(timeout=5)
                receiver.stdout.close()
                receiver.stderr.close()
                if encoder is not None:
                    encoder.stderr.close()

    def test_preview_cadence_configuration(self):
        source = (HELPER.parent / "streamer.sh").read_text()
        start = source.index('PREVIEW_FPS="${YT_PREVIEW_FPS')
        end = source.index('GOP_SIZE=', start)
        setup = source[start:end]
        for value, expected in (("", "1/10"), ("1", "1"), ("1/10", "1/10")):
            result = subprocess.run(
                ["bash", "-c", setup + '\nprintf "%s" "$PREVIEW_FPS"'],
                env={**os.environ, "YT_PREVIEW_FPS": value},
                capture_output=True, text=True, timeout=5)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout, expected)
        invalid = subprocess.run(["bash", "-c", setup],
                                 env={**os.environ, "YT_PREVIEW_FPS": "30"},
                                 capture_output=True, text=True, timeout=5)
        self.assertNotEqual(invalid.returncode, 0)

    def test_finite_video_and_reader_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            for kill_reader in (False, True):
                generation = "reader-failed" if kill_reader else "finite-video"
                receiver = subprocess.Popen([
                    "python3", str(HELPER), "telemetry", "--run", directory,
                    "--generation", generation
                ], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                encoder = None
                try:
                    ready, _, _ = select.select([receiver.stdout], [], [], 5)
                    self.assertTrue(ready, "Telemetry reader did not become ready")
                    port = int(receiver.stdout.readline().strip())
                    encoder = subprocess.Popen([
                        "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-re",
                        "-f", "lavfi", "-i", "color=s=64x64:r=30:d=3",
                        "-progress", f"udp://127.0.0.1:{port}?pkt_size=1024&connect=0",
                        "-c:v", "libx264", "-preset", "veryfast", "-f", "null", "-"
                    ], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
                    if kill_reader:
                        time.sleep(1)
                        receiver.terminate()
                        receiver.wait(timeout=3)
                    _, errors = encoder.communicate(timeout=8)
                    self.assertEqual(encoder.returncode, 0, errors)
                    if not kill_reader:
                        deadline = time.monotonic() + 2
                        sample = {}
                        while time.monotonic() < deadline:
                            sample = json.loads((Path(directory) / "streamer-progress.json").read_text())
                            if sample.get("end"):
                                break
                            time.sleep(0.05)
                        self.assertEqual(sample["generation"], generation)
                        self.assertGreater(sample["elapsed"], 2)
                        self.assertTrue(sample["end"], "finite completion must remain normal completion")
                        onair = json.loads((Path(directory) / "streamer-onair.json").read_text())
                        self.assertEqual(onair["generation"], generation)
                finally:
                    for process in (encoder, receiver):
                        if process is not None and process.poll() is None:
                            process.terminate()
                            try:
                                process.wait(timeout=3)
                            except subprocess.TimeoutExpired:
                                process.kill()
                                process.wait()
                    receiver.stdout.close()
                    receiver.stderr.close()
                    if encoder is not None:
                        encoder.stderr.close()


if __name__ == "__main__":
    unittest.main()

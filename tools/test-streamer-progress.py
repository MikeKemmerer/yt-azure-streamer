#!/usr/bin/env python3
"""Check actual ffmpeg progress and independence from telemetry-reader failure."""

import json
import select
import subprocess
import tempfile
import time
import unittest
from pathlib import Path


HELPER = Path(__file__).resolve().parents[1] / "services/streamer/streamer-control.py"


class ProgressTests(unittest.TestCase):
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

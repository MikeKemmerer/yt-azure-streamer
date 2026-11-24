#!/usr/bin/env python3
"""Live queue control, durable resume, and nonblocking ffmpeg progress collection."""

import argparse
import copy
import fcntl
import json
import math
import os
import re
import signal
import socket
import sys
import time
import uuid
from pathlib import Path


def atomic_json(path, value, durable=False):
    temporary = str(path) + f".{os.getpid()}.tmp"
    try:
        with open(temporary, "w", encoding="utf-8") as output:
            json.dump(value, output)
            if durable:
                output.flush()
                os.fsync(output.fileno())
        os.replace(temporary, path)
        if durable:
            directory = os.open(str(Path(path).parent), os.O_DIRECTORY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def read_json(path, default=None):
    try:
        with open(path, encoding="utf-8") as source:
            return json.load(source)
    except (OSError, ValueError):
        return default


def display_title(text):
    text = re.sub(r"(?:\.(?:mp4|mkv|mov|avi|ts|flv))+$", "", text.strip(), flags=re.I)
    return re.sub(r"^\d{4}-\d{2}-\d{2}(?:\s*[-_]\s*|\s+)", "", text).strip()


def wrap_overlay(text, width, max_lines=2):
    if len(text) <= width:
        return text
    lines = min(max_lines, math.ceil(len(text) / width))
    result = []
    remaining = text
    for count in range(lines, 1, -1):
        target = len(remaining) // count
        spaces = [i for i, char in enumerate(remaining) if char == " " and 0 < i < len(remaining) - 1]
        if spaces:
            split = min(spaces, key=lambda i: (abs(i - target), -i))
            result.append(remaining[:split])
            remaining = remaining[split + 1:]
        elif max_lines > 2:
            result.append(remaining[:target])
            remaining = remaining[target:]
        else:
            return text
    return "\n".join(result + [remaining])


def process_start(pid):
    try:
        return Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[19]
    except (OSError, IndexError):
        return ""


def apply_command(state, command, available, saved):
    updated = copy.deepcopy(state)
    action_id = command.get("id", "")
    if not isinstance(action_id, str) or not 1 <= len(action_id) <= 80:
        raise ValueError("Invalid action ID")
    if any(action["id"] == action_id for action in state["actions"]):
        return updated, False
    if state.get("interrupt"):
        raise ValueError("A playback interruption is already pending")
    if command.get("session") != state["session"]:
        raise ValueError("Playback session changed; reload the queue")
    if command.get("revision") != state["revision"]:
        raise ValueError("Queue changed; reload before editing")
    operation = command.get("operation")
    current = state["current"]["file"]
    entries = updated["upcoming"]
    interrupt = False

    def entry(filename):
        if not isinstance(filename, str) or filename not in available:
            raise ValueError("Video is unavailable")
        if available[filename] == current:
            raise ValueError("That video is already playing")
        return next(
            (item for item in entries if item["file"] == available[filename]),
            {"file": available[filename], "ordinary": False},
        )

    if operation == "replace":
        files = command.get("files")
        if (not isinstance(files, list) or not all(isinstance(item, str) for item in files)
                or len(files) != len(set(files))):
            raise ValueError("Queue must contain unique filenames")
        updated["upcoming"] = [entry(filename) for filename in files]
        updated["explicitEmpty"] = not files
    elif operation == "reset":
        index = saved.index(current) + 1 if current in saved else 0
        rotated = saved[index:] + saved[:index]
        updated["upcoming"] = [
            {"file": filename, "ordinary": True}
            for filename in rotated if filename != current
        ]
        updated["explicitEmpty"] = False
        updated["refillAnchor"] = current
    elif operation in ("next", "now"):
        target = entry(command.get("file"))
        updated["upcoming"] = [
            item for item in entries if item["file"] != target["file"]
        ]
        updated["explicitEmpty"] = False
        if operation == "next":
            target["ordinary"] = False
            updated["upcoming"].insert(0, target)
        else:
            updated["interrupt"] = {
                "file": target["file"], "ordinary": False, "actionId": action_id
            }
            interrupt = True
    elif operation == "skip":
        updated["interrupt"] = {"actionId": action_id}
        interrupt = True
    else:
        raise ValueError("Unknown queue operation")

    updated["revision"] += 1
    updated["actions"] = (updated["actions"] + [{
        "id": action_id, "status": "accepted" if interrupt else "applied",
        "operation": operation, "at": time.time(),
    }])[-16:]
    return updated, interrupt


def advance(state, saved, available):
    updated = copy.deepcopy(state)
    for action in updated["actions"]:
        if action["id"] == updated["current"].get("actionId") and action["status"] == "starting":
            action.update(status="unconfirmed", error="Video ended before on-air confirmation")
    request = updated.pop("interrupt", None)
    if request and "file" in request and request["file"] not in available:
        for action in updated["actions"]:
            if action["id"] == request["actionId"]:
                action.update(status="rejected", error="Requested video is no longer available")
        request = None
    pending = [item for item in updated["upcoming"] if item["file"] in available]
    updated["upcoming"] = pending
    if request and request.get("file") in available:
        updated["current"] = {
            "file": request["file"], "ordinary": False,
            "actionId": request["actionId"],
        }
    else:
        if not pending:
            if updated["explicitEmpty"]:
                updated["stopped"] = True
                return updated
            pending = [
                {"file": filename, "ordinary": True}
                for filename in saved if filename in available
            ]
            anchor = updated.get("refillAnchor")
            anchor_index = next(
                (index for index, item in enumerate(pending) if item["file"] == anchor), 0
            )
            pending = pending[anchor_index:] + pending[:anchor_index]
            updated["upcoming"] = pending
        if not pending:
            updated["stopped"] = True
            return updated
        updated["current"] = pending.pop(0)
        if request:
            updated["current"]["actionId"] = request["actionId"]
    updated["revision"] += 1
    for action in updated["actions"]:
        if action["id"] == updated["current"].get("actionId"):
            action["status"] = "starting"
    return updated


class Controller:
    def __init__(self, run="/run", etc="/etc/yt", overlays="/tmp"):
        self.run = Path(run)
        self.etc = Path(etc)
        self.overlays = Path(overlays)
        self.state_file = self.run / "streamer-control-state.json"
        self.request_file = self.run / "streamer-control-request.json"
        self.progress_file = self.run / "streamer-progress.json"
        self.onair_file = self.run / "streamer-onair.json"
        self.resume_file = self.etc / "playback-resume.json"
        self.resume_lock = self.etc / "playback-resume.lock"
        self.resume_blocked = self.run / "streamer-resume-blocked.json"

    def resume(self, video_dir):
        value = read_json(self.resume_file, {})
        try:
            name, position = value["file"], value["position"]
            if (value.get("version") != 1 or not isinstance(name, str)
                    or Path(name).name != name or "\\" in name
                    or "\n" in name or "\r" in name
                    or value.get("videoDir") != str(Path(video_dir).resolve())
                    or isinstance(position, bool) or not isinstance(position, (int, float))
                    or not math.isfinite(position) or position < 0
                    or not isinstance(value.get("ordinary"), bool)):
                return None
            media = Path(video_dir) / name
            if media.suffix.lower() not in (".mp4", ".mkv", ".mov", ".avi", ".ts", ".flv"):
                return None
            if not media.is_file() or media.stat().st_size != value["size"]:
                return None
            duration = value.get("duration", 0)
            if not isinstance(duration, (int, float)) or not math.isfinite(duration) or duration < 0:
                return None
            if duration and position >= duration - 1:
                return None
            return {**value, "path": str(media), "offset": round(max(0, position - 2), 3)}
        except (OSError, KeyError, TypeError, ValueError):
            return None

    def checkpoint(self, sample=None):
        with open(self.resume_lock, "a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            state = read_json(self.state_file, {}) or {}
            sample = sample if sample is not None else read_json(self.progress_file, {}) or {}
            current = state.get("current", {})
            generation = current.get("generation")
            blocked = read_json(self.resume_blocked, {}) or {}
            if (not generation or generation != sample.get("generation") or state.get("interrupt")
                    or blocked.get("generation") == generation):
                return False
            if sample.get("end"):
                return False
            elapsed, at = sample.get("elapsed"), sample.get("at")
            if (isinstance(elapsed, bool) or not isinstance(elapsed, (int, float))
                    or not math.isfinite(elapsed) or elapsed <= 0
                    or not isinstance(at, (int, float)) or not 0 <= time.time() - at <= 10):
                return False
            now = read_json(self.run / "streamer-now.json", {}) or {}
            duration = now.get("duration", 0) if now.get("file") == current.get("file") else 0
            position = current.get("offsetSeconds", 0) + elapsed
            if duration and position >= duration - 1:
                return False
            try:
                size = Path(current["file"]).stat().st_size
                previous = read_json(self.resume_file, {}) or {}
                if not isinstance(previous, dict):
                    previous = {}
                if previous.get("generation") == generation and previous.get("position", 0) > position:
                    return False
                atomic_json(self.resume_file, {
                    "version": 1, "file": Path(current["file"]).name, "size": size,
                    "videoDir": str(Path(state["videoDir"]).resolve()),
                    "ordinary": current.get("ordinary", True), "position": position,
                    "duration": duration, "generation": generation, "at": at,
                }, durable=True)
                return True
            except (OSError, KeyError, TypeError):
                return False

    def discard_resume(self):
        with open(self.resume_lock, "a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            state = read_json(self.state_file, {}) or {}
            atomic_json(self.resume_blocked, {"generation": state.get("current", {}).get("generation")})
            atomic_json(self.resume_file, {}, durable=True)
            self.resume_file.unlink(missing_ok=True)

    def offset(self):
        self.checkpoint()
        state = read_json(self.state_file)
        value = self.resume(state["videoDir"])
        current = state["current"]
        if (value and value.get("generation") == current.get("generation")
                and value["path"] == current["file"]):
            current["offsetSeconds"] = value["offset"]
            current.pop("generation", None)
            self.save(state)
            self.progress_file.unlink(missing_ok=True)
        return current.get("offsetSeconds", 0)

    def saved(self):
        try:
            lines = (self.etc / "playlist.txt").read_text().splitlines()
            files = [
                line[6:-1].replace("'\\''", "'")
                for line in lines if line.startswith("file '") and line.endswith("'")
            ]
            return list(dict.fromkeys(filename for filename in files if os.path.isfile(filename)))
        except OSError:
            return []

    def available(self, state):
        directory = Path(state["videoDir"])
        return {
            filename.name: str(filename)
            for filename in directory.iterdir()
            if filename.is_file() and filename.suffix.lower() in
            (".mp4", ".mkv", ".mov", ".avi", ".ts", ".flv")
            and "\n" not in filename.name and "\r" not in filename.name
        }

    def save(self, state):
        state["updatedAt"] = time.time()
        atomic_json(self.state_file, state)
        atomic_json(self.run / "streamer-playlist.json", [
            state["current"]["file"],
            *[item["file"] for item in state["upcoming"]],
        ])
        self.overlay(state)

    def overlay(self, state):
        config = read_json(self.etc / "playlist-config.json", {}) or {}
        if not isinstance(config, dict):
            config = {}
        videos = config.get("videos", [])
        if not isinstance(videos, list):
            videos = []
        titles = {
            item["file"]: item.get("title", "")
            for item in videos if isinstance(item, dict)
            and isinstance(item.get("file"), str) and isinstance(item.get("title", ""), str)
        }
        filename = Path(state["upcoming"][0]["file"]).name if state["upcoming"] else ""
        title = display_title(titles.get(filename) or filename)
        text = f"Up Next: {title}" if title else ""
        for name, width, lines in (("streamer-upnext.txt", 55, 2), ("streamer-upnext-portrait.txt", 40, 3)):
            wrapped = wrap_overlay(text, width, lines)
            temporary = self.overlays / (name + f".{os.getpid()}.tmp")
            try:
                temporary.write_text(wrapped, encoding="utf-8", errors="replace")
                os.replace(temporary, self.overlays / name)
            except OSError:
                try:
                    temporary.unlink()
                except OSError:
                    pass

    def init(self, index, owner, video_dir):
        saved = self.saved()
        if not saved:
            raise ValueError("No available saved videos")
        index %= len(saved)
        ordered = saved[index:] + saved[:index]
        state = {
            "version": 1, "session": uuid.uuid4().hex, "revision": 1,
            "ownerPid": owner, "ownerStart": process_start(owner),
            "videoDir": video_dir,
            "current": {"file": ordered[0], "ordinary": True},
            "upcoming": [{"file": filename, "ordinary": True} for filename in ordered[1:]],
            "explicitEmpty": False, "actions": [], "stopped": False,
            "refillAnchor": ordered[0],
        }
        resume = self.resume(video_dir)
        if resume and (not resume["ordinary"] or resume["path"] in saved):
            if resume["ordinary"]:
                resume_index = saved.index(resume["path"])
                ordered = saved[resume_index:] + saved[:resume_index]
                state["refillAnchor"] = ordered[0]
            state["current"] = {
                "file": resume["path"], "ordinary": resume["ordinary"],
                "offsetSeconds": resume["offset"],
            }
            state["upcoming"] = [
                {"file": filename, "ordinary": True} for filename in ordered
                if filename != resume["path"]
            ]
        for filename in (self.request_file, self.progress_file, self.onair_file):
            filename.unlink(missing_ok=True)
        self.save(state)
        return state

    def command(self):
        state = read_json(self.state_file)
        command = read_json(self.request_file, {})
        if not isinstance(command, dict):
            command = {}
        if not state:
            raise ValueError("Player state unavailable")
        interrupt = False
        try:
            if any((self.run / name).exists() for name in (
                "streamer-stop-after-current", "streamer-restart-requested"
            )):
                raise ValueError("Stop or restart is pending")
            state, interrupt = apply_command(state, command, self.available(state), self.saved())
        except (ValueError, TypeError, KeyError, OSError) as error:
            state["actions"] = (state["actions"] + [{
                "id": command.get("id", "") if isinstance(command, dict) else "",
                "status": "rejected", "error": str(error), "at": time.time(),
            }])[-16:]
        self.save(state)
        if interrupt:
            self.discard_resume()
        self.request_file.unlink(missing_ok=True)
        return interrupt

    def prepare(self):
        state = read_json(self.state_file)
        generation = uuid.uuid4().hex
        for key in ("encoderPid", "encoderStart", "telemetryPid", "telemetryStart"):
            state["current"].pop(key, None)
        state["current"].update(generation=generation, startedAt=time.time(), onAir=False)
        self.progress_file.unlink(missing_ok=True)
        self.onair_file.unlink(missing_ok=True)
        self.save(state)
        return generation

    def confirm(self):
        state = read_json(self.state_file)
        sample = read_json(self.onair_file, {}) or {}
        self.onair_file.unlink(missing_ok=True)
        if sample.get("generation") != state["current"].get("generation"):
            return
        state["current"]["onAir"] = True
        for action in state["actions"]:
            if action["id"] == state["current"].get("actionId"):
                action["status"] = "applied"
                action["at"] = time.time()
        self.save(state)

    def launched(self, pid, telemetry_pid=0):
        state = read_json(self.state_file)
        state["current"].update(
            encoderPid=pid, encoderStart=process_start(pid),
            telemetryPid=telemetry_pid, telemetryStart=process_start(telemetry_pid),
        )
        self.save(state)

    def next(self):
        state = read_json(self.state_file)
        state = advance(state, self.saved(), set(self.available(state).values()))
        if state["stopped"] and state["explicitEmpty"]:
            (self.run / "streamer-queue-hold").touch()
        self.save(state)
        return state

    def selection(self, state):
        if state.get("stopped"):
            print("STOP" if state["explicitEmpty"] else "UNAVAILABLE")
            return
        saved = self.saved()
        current = state["current"]
        print(current["file"])
        print("true" if current["ordinary"] else "false")
        print(saved.index(current["file"]) if current["file"] in saved else 0)

    def telemetry(self, generation):
        # UDP keeps advisory telemetry independent of reader availability/backpressure.
        receiver = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        receiver.bind(("127.0.0.1", 0))
        print(receiver.getsockname()[1], flush=True)
        sample = {}
        announced = False
        checkpoint_at = 0
        buffered = ""
        while True:
            buffered += receiver.recv(4096).decode("utf-8", errors="replace")
            lines = buffered.split("\n")
            buffered = lines.pop()[-4096:]
            for line in lines:
                key, separator, value = line.strip().partition("=")
                if not separator or key not in ("out_time_us", "speed", "progress"):
                    continue
                sample[key] = value
                if key != "progress":
                    continue
                try:
                    seconds = max(0, float(sample.get("out_time_us", 0)) / 1_000_000)
                    speed = float(sample.get("speed", "0").rstrip("x"))
                    if not seconds or not math.isfinite(seconds) or not math.isfinite(speed):
                        sample = {}
                        continue
                    data = {
                        "generation": generation, "elapsed": seconds,
                        "speed": speed, "at": time.time(), "end": value == "end",
                    }
                    atomic_json(self.progress_file, data)
                    if data["elapsed"] > 0 and (data["end"] or data["at"] - checkpoint_at >= 5):
                        try:
                            self.checkpoint(data)
                        except OSError:
                            pass
                        checkpoint_at = data["at"]
                    if not announced:
                        atomic_json(self.onair_file, data)
                        announced = True
                except (ValueError, OSError):
                    pass
                sample = {}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("operation", choices=("init", "command", "prepare", "launched", "confirm", "next", "overlay", "telemetry", "wrap", "title", "checkpoint", "complete", "offset"))
    parser.add_argument("--text", default="")
    parser.add_argument("--width", type=int, default=40)
    parser.add_argument("--lines", type=int, choices=(2, 3), default=3)
    parser.add_argument("--run", default="/run")
    parser.add_argument("--etc", default="/etc/yt")
    parser.add_argument("--overlays", default="/tmp")
    parser.add_argument("--index", type=int, default=0)
    parser.add_argument("--owner", type=int, default=os.getppid())
    parser.add_argument("--encoder-pid", type=int)
    parser.add_argument("--telemetry-pid", type=int, default=0)
    parser.add_argument("--video-dir")
    parser.add_argument("--generation")
    args = parser.parse_args()
    if args.operation == "title":
        sys.stdout.buffer.write(display_title(args.text).encode("utf-8", errors="replace"))
        return
    if args.operation == "wrap":
        if args.width < 1:
            parser.error("--width must be positive")
        sys.stdout.buffer.write(wrap_overlay(args.text, args.width, args.lines).encode("utf-8", errors="replace"))
        return
    controller = Controller(args.run, args.etc, args.overlays)
    if args.operation == "init":
        controller.selection(controller.init(args.index, args.owner, args.video_dir))
    elif args.operation == "command":
        print("interrupt" if controller.command() else "continue")
    elif args.operation == "prepare":
        print(controller.prepare())
    elif args.operation == "confirm":
        controller.confirm()
    elif args.operation == "launched":
        controller.launched(args.encoder_pid, args.telemetry_pid)
    elif args.operation == "next":
        controller.selection(controller.next())
    elif args.operation == "overlay":
        controller.overlay(read_json(controller.state_file))
    elif args.operation == "checkpoint":
        controller.checkpoint()
    elif args.operation == "complete":
        controller.discard_resume()
    elif args.operation == "offset":
        print(controller.offset())
    else:
        signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
        controller.telemetry(args.generation)


if __name__ == "__main__":
    main()

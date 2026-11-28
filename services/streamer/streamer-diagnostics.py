#!/usr/bin/env python3
"""Bounded read-only appliance probes; output never includes credentials."""

import argparse
import datetime as dt
import fcntl
import json
import math
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import time
from urllib.parse import parse_qs


def read_json(path, default=None):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return default


def expiry_info(text, now):
    try:
        config = json.loads(text)
    except ValueError:
        config = None
    if isinstance(config, dict):
        storage = config.get("azstorage", {})
        storage = storage if isinstance(storage, dict) else {}
        mode = storage.get("mode", storage.get("auth-type", "unknown"))
        mode = mode.lower() if isinstance(mode, str) else "unknown"
        value = storage.get("sas", storage.get("sas_token"))
    else:
        mode = re.search(r"^\s*(?:mode|auth-type):\s*['\"]?([A-Za-z_]+)", text, re.M)
        mode = mode.group(1).lower() if mode else "unknown"
        match = re.search(r"^\s*(?:sas|sas_token):\s*(.*?)\s*$", text, re.M)
        value = match.group(1) if match else None
    if mode in {"msi", "azcli", "workloadidentity"}:
        return {"severity": "ok", "reason": "Managed authentication; no SAS expiry", "mode": mode}
    if mode in {"key", "accountkey"}:
        return {"severity": "ok", "reason": "Account-key authentication; no SAS expiry", "mode": mode}
    if not isinstance(value, str):
        return {"severity": "unknown", "reason": "Blob credential expiry unavailable", "mode": mode}
    try:
        value = value.strip("'\"").lstrip("?")
        expires = parse_qs(value)["se"][0]
        parsed = dt.datetime.fromisoformat(expires.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            raise ValueError()
        remaining = parsed.timestamp() - now
        days = math.floor(remaining / 86400)
        return {"severity": "error" if remaining <= 7 * 86400 else "warn" if remaining <= 30 * 86400 else "ok",
                "reason": "Blob SAS expired" if remaining <= 0 else "Blob SAS expiry",
                "mode": "sas", "expires_at": parsed.astimezone(dt.timezone.utc).isoformat(),
                "days_remaining": days}
    except (KeyError, ValueError, OverflowError):
        return {"severity": "unknown", "reason": "Blob SAS expiry is missing or invalid", "mode": "sas"}


def storage_probe(root, run, directory):
    # The worker retains this lock even if blocked in FUSE after its parent times out.
    with (run / "streamer-diagnostics-storage.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return {"severity": "unknown", "reason": "Previous storage probe has not finished"}
        files = []
        total_bytes = 0
        with os.scandir(directory) as entries:
            for index, item in enumerate(entries):
                if index >= 10000:
                    return {"severity": "unknown", "reason": "Storage listing limit reached"}
                if (Path(item.name).suffix.lower() in {".mp4", ".mkv", ".mov", ".avi", ".ts", ".flv"}
                        and item.is_file(follow_symlinks=False)):
                    files.append(item.name)
                    total_bytes += item.stat(follow_symlinks=False).st_size
        if not files:
            return {"severity": "error", "reason": "No recordings discovered", "available_count": 0, "total_bytes": 0}
        config = read_json(root / "playlist-config.json", {}) or {}
        videos = config.get("videos", []) if isinstance(config, dict) else []
        videos = videos if isinstance(videos, list) else []
        enabled = [item["file"] for item in videos
                   if isinstance(item, dict) and item.get("enabled", True) and item.get("file") in files]
        selected = enabled[0] if enabled else files[0]
        descriptor = os.open(Path(directory) / selected, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(descriptor, "rb") as media:
            if not stat.S_ISREG(os.fstat(media.fileno()).st_mode):
                return {"severity": "error", "reason": "Recording is not a regular file"}
            content = media.read(4096)
            if not content:
                return {"severity": "error", "reason": "Recording is empty", "available_count": len(files)}
        return {"severity": "ok", "reason": "Recording read succeeded; may be served by FUSE cache",
                "available_count": len(files), "saved_enabled_count": len(enabled),
                "total_bytes": total_bytes,
                "selection_source": "saved_playlist" if enabled else "directory_scan",
                "read_bytes": len(content), "remote_roundtrip_verified": False}


def collect(root, run, directory, mode):
    now = time.time()
    result = {"observed_at": now}
    units = ["streamer.service", "scheduler.service", "web-backend.service", "caddy.service"]
    if mode == "local":
        units.append("youtube-sync.timer")
    else:
        units.extend(["schedule-sync.timer", "mnt-blobfuse2.mount"])
    try:
        reply = subprocess.run(["systemctl", "show", *units, "--property=Id,ActiveState,NRestarts"],
                               capture_output=True, text=True, timeout=3)
        services = {}
        for block in reply.stdout.strip().split("\n\n"):
            values = dict(line.split("=", 1) for line in block.splitlines() if "=" in line)
            if values.get("Id") in units:
                services[values["Id"]] = {"state": values.get("ActiveState", "unknown"),
                                           "restarts": int(values.get("NRestarts", 0))}
        result["services"] = services
    except (OSError, ValueError, subprocess.TimeoutExpired):
        result["services"] = {}
    config_paths = [root / "blobfuse2/onprem.yaml", root / "blobfuse2/blobfuse2.yaml",
                    root / "blobfuse2.yaml", root / "blobfuse2/config.yaml"]
    blob_config = next((p for p in config_paths if p.exists()), None)
    result["auth"] = {"severity": "ok" if mode == "local" and not blob_config else "unknown",
                      "reason": "No Blob configuration discovered", "mode": "not_applicable" if not blob_config else "unknown"}
    if blob_config:
        try:
            result["auth"] = expiry_info(blob_config.read_text(), now)
        except OSError:
            result["auth"] = {"severity": "unknown", "reason": "Blob credential configuration unreadable", "mode": "unknown"}
    try:
        mounts = Path("/proc/self/mountinfo").read_text().splitlines()
        mount = next((line for line in mounts if line.split()[4].replace("\\040", " ") == directory), None)
        mounted = mount is not None
        result["storage_mount"] = {"mounted": mounted, "required": mode == "azure" or blob_config is not None}
        if result["storage_mount"]["required"] and not mounted:
            result["storage"] = {"severity": "error", "reason": "Recording mount is absent"}
        else:
            worker = subprocess.run([sys.executable, str(Path(__file__).resolve()), "--storage-worker",
                                     "--root", str(root), "--run", str(run), "--video-dir", directory],
                                    capture_output=True, text=True, timeout=3)
            result["storage"] = json.loads(worker.stdout) if worker.returncode == 0 else {
                "severity": "error", "reason": "Recording listing or read failed"}
    except subprocess.TimeoutExpired:
        result["storage"] = {"severity": "unknown", "reason": "Storage probe timed out"}
    except (OSError, ValueError, IndexError):
        result["storage"] = {"severity": "unknown", "reason": "Storage probe unavailable"}
    try:
        memory = dict(re.findall(r"^(MemTotal|MemAvailable):\s+(\d+)", Path("/proc/meminfo").read_text(), re.M))
        disk = os.statvfs("/")
        temps = []
        for path in Path("/sys/class/thermal").glob("thermal_zone*/temp"):
            try:
                temps.append(int(path.read_text()) / 1000)
            except (OSError, ValueError):
                pass
        resources = {"load_1m": os.getloadavg()[0], "cpu_cores": os.cpu_count(),
                     "uptime_seconds": float(Path("/proc/uptime").read_text().split()[0]),
                     "memory_available_mb": int(memory["MemAvailable"]) // 1024,
                     "memory_total_mb": int(memory["MemTotal"]) // 1024,
                     "disk_available_bytes": disk.f_bavail * disk.f_frsize,
                     "disk_total_bytes": disk.f_blocks * disk.f_frsize,
                     "disk_used_bytes": (disk.f_blocks - disk.f_bfree) * disk.f_frsize,
                     "disk_available_percent": disk.f_bavail / disk.f_blocks * 100,
                     "temperature_c": max(temps) if temps else None}
        pressure = resources["memory_available_mb"] < 256 or resources["disk_available_percent"] < 5 or (
            resources["temperature_c"] is not None and resources["temperature_c"] >= 85)
        result["resources"] = dict(resources, severity="warn" if pressure else "ok",
                                   reason="Host resource pressure" if pressure else "Host resources available")
    except (OSError, ValueError, KeyError, ZeroDivisionError):
        result["resources"] = {"severity": "unknown", "reason": "Host resource metrics unavailable"}
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=Path("/etc/yt"))
    parser.add_argument("--run", type=Path, default=Path("/run"))
    parser.add_argument("--video-dir", required=True)
    parser.add_argument("--mode", choices=["local", "azure"], default="azure")
    parser.add_argument("--storage-worker", action="store_true")
    args = parser.parse_args()
    try:
        data = storage_probe(args.root, args.run, args.video_dir) if args.storage_worker else collect(
            args.root, args.run, args.video_dir, args.mode)
    except Exception:
        data = {"severity": "unknown", "reason": "Diagnostic probe failed"}
    print(json.dumps(data))


if __name__ == "__main__":
    main()

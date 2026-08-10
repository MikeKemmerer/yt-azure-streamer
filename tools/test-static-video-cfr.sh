#!/usr/bin/env bash
set -euo pipefail

command -v ffmpeg >/dev/null
command -v ffprobe >/dev/null

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
STREAMER="$ROOT_DIR/services/streamer/streamer.sh"
WORK_DIR=$(mktemp -d)
trap 'rm -rf "$WORK_DIR"' EXIT

DURATION=6
OUTPUT_FPS=30
TARGET_BITRATE=850k
TARGET_BITRATE_BPS=850000
BUFSIZE=1700k
GOP_SIZE=$((OUTPUT_FPS * 2))

assert_streamer_contract() {
  python3 - "$STREAMER" <<'PY'
import sys
from pathlib import Path

source = Path(sys.argv[1]).read_text()
required = {
    'OUTPUT_FPS=30': 1,
    'GOP_SIZE=$((OUTPUT_FPS * 2))': 1,
    'SCALE_VF+=("fps=${OUTPUT_FPS}:start_time=0" "realtime")': 1,
    'aresample=44100:async=1000:first_pts=0': 2,
    ':reload=${OUTPUT_FPS}:': 2,
    'Reloaded active playlist': 1,
    '-fps_mode cfr': 4,
    '-x264-params "nal-hrd=cbr:force-cfr=1"': 4,
    '-g "$GOP_SIZE" -keyint_min "$GOP_SIZE" -sc_threshold 0': 4,
}
for text, expected in required.items():
    actual = source.count(text)
    if actual != expected:
        raise SystemExit(f"{text!r}: expected {expected}, found {actual}")
if "force_key_frames" in source:
    raise SystemExit("legacy force_key_frames option is still present")
PY
}

make_fixture() {
  local name="$1"
  local fps="$2"
  local with_audio="$3"
    local sample_rate="$4"
  local output="$WORK_DIR/${name}.mp4"

  if [[ "$with_audio" == true ]]; then
    ffmpeg -hide_banner -loglevel error -y \
      -f lavfi -i "color=c=blue:s=320x180:r=${fps}:d=${DURATION}" \
    -f lavfi -i "sine=f=440:r=${sample_rate}:d=${DURATION}" \
      -c:v libx264 -pix_fmt yuv420p -c:a aac -t "$DURATION" "$output"
  else
    ffmpeg -hide_banner -loglevel error -y \
      -f lavfi -i "color=c=blue:s=320x180:r=${fps}:d=${DURATION}" \
      -c:v libx264 -pix_fmt yuv420p -t "$DURATION" "$output"
  fi
}

transcode_fixture() {
  local name="$1"
  local with_audio="$2"
  local input="$WORK_DIR/${name}.mp4"
  local landscape="$WORK_DIR/${name}-landscape.flv"
  local portrait="$WORK_DIR/${name}-portrait.flv"
  local -a extra_inputs=()
    local audio_filter="[0:a]loudnorm=I=-14:TP=-1:LRA=11,aresample=44100:async=1000:first_pts=0[audio]"

  if [[ "$with_audio" != true ]]; then
    extra_inputs=(-f lavfi -t "$DURATION" -i anullsrc=r=44100:cl=stereo)
        audio_filter="[1:a]aresample=44100:async=1000:first_pts=0[audio]"
  fi

  ffmpeg -hide_banner -loglevel error -y -i "$input" "${extra_inputs[@]}" \
    -filter_complex \
            "[0:v]fps=${OUTPUT_FPS}:start_time=0,realtime,split=2[land][port_src];\
[port_src]scale=180:-2,pad=180:320:(ow-iw)/2:(oh-ih)/2[portrait];\
${audio_filter};[audio]asplit=2[audio_land][audio_port]" \
    -map '[land]' -map '[audio_land]' \
    -c:v libx264 -preset veryfast -r "$OUTPUT_FPS" -fps_mode cfr \
    -b:v "$TARGET_BITRATE" -minrate "$TARGET_BITRATE" -maxrate "$TARGET_BITRATE" -bufsize "$BUFSIZE" \
    -g "$GOP_SIZE" -keyint_min "$GOP_SIZE" -sc_threshold 0 \
    -x264-params 'nal-hrd=cbr:force-cfr=1' -pix_fmt yuv420p \
    -c:a aac -b:a 96k -ar 44100 -f flv "$landscape" \
    -map '[portrait]' -map '[audio_port]' \
    -c:v libx264 -preset veryfast -r "$OUTPUT_FPS" -fps_mode cfr \
    -b:v "$TARGET_BITRATE" -minrate "$TARGET_BITRATE" -maxrate "$TARGET_BITRATE" -bufsize "$BUFSIZE" \
    -g "$GOP_SIZE" -keyint_min "$GOP_SIZE" -sc_threshold 0 \
    -x264-params 'nal-hrd=cbr:force-cfr=1' -pix_fmt yuv420p \
    -c:a aac -b:a 96k -ar 44100 -f flv "$portrait"
}

validate_output() {
  local path="$1"
  local expected_width="$2"
  local expected_height="$3"

  python3 - "$path" "$expected_width" "$expected_height" \
    "$OUTPUT_FPS" "$DURATION" "$GOP_SIZE" "$TARGET_BITRATE_BPS" <<'PY'
import json
import math
import subprocess
import sys

path = sys.argv[1]
expected_width = int(sys.argv[2])
expected_height = int(sys.argv[3])
fps = int(sys.argv[4])
duration = int(sys.argv[5])
gop_size = int(sys.argv[6])
target_bitrate = int(sys.argv[7])

def probe(*args):
    output = subprocess.check_output(
        ["ffprobe", "-v", "error", *args, "-of", "json", path],
        text=True,
    )
    return json.loads(output)

metadata = probe("-count_frames", "-show_streams", "-show_format")
video = next(stream for stream in metadata["streams"] if stream["codec_type"] == "video")
audio = next((stream for stream in metadata["streams"] if stream["codec_type"] == "audio"), None)
if (video["width"], video["height"]) != (expected_width, expected_height):
    raise SystemExit(f"unexpected dimensions: {video['width']}x{video['height']}")
if video["r_frame_rate"] != f"{fps}/1" or video["avg_frame_rate"] != f"{fps}/1":
    raise SystemExit(f"unexpected frame rate: {video['r_frame_rate']} / {video['avg_frame_rate']}")
expected_frames = fps * duration
actual_frames = int(video.get("nb_read_frames", 0))
if actual_frames != expected_frames:
    raise SystemExit(f"expected {expected_frames} frames, found {actual_frames}")
if audio is None or audio.get("sample_rate") != "44100":
    raise SystemExit("missing 44.1 kHz audio")

audio_packets = probe(
    "-select_streams", "a:0",
    "-show_packets",
    "-show_entries", "packet=pts_time",
)["packets"]
audio_timestamps = [float(packet["pts_time"]) for packet in audio_packets]
audio_deltas = [
    current - previous
    for previous, current in zip(audio_timestamps, audio_timestamps[1:])
]
if any(delta <= 0 for delta in audio_deltas):
    raise SystemExit("audio timestamps are not strictly monotonic")
if not audio_deltas or max(audio_deltas) > 0.030:
    raise SystemExit(f"audio packet gap exceeds 30 ms: {max(audio_deltas, default=0):.6f}")

frames = probe(
    "-select_streams", "v:0",
    "-show_frames",
    "-show_entries", "frame=key_frame,best_effort_timestamp_time",
)["frames"]
timestamps = [float(frame["best_effort_timestamp_time"]) for frame in frames]
if any(current <= previous for previous, current in zip(timestamps, timestamps[1:])):
    raise SystemExit("video timestamps are not strictly monotonic")
expected_delta = 1 / fps
if max(abs((current - previous) - expected_delta) for previous, current in zip(timestamps, timestamps[1:])) > 0.001:
    raise SystemExit("video timestamp spacing is not CFR")
keyframes = [float(frame["best_effort_timestamp_time"]) for frame in frames if frame["key_frame"] == 1]
expected_gop_seconds = gop_size / fps
if len(keyframes) != math.ceil(duration / expected_gop_seconds):
    raise SystemExit(f"unexpected keyframe count: {keyframes}")
if any(abs((current - previous) - expected_gop_seconds) > 0.001 for previous, current in zip(keyframes, keyframes[1:])):
    raise SystemExit(f"unexpected keyframe cadence: {keyframes}")

packets = probe(
    "-select_streams", "v:0",
    "-show_packets",
    "-show_entries", "packet=pts_time,size",
)["packets"]
windows = {}
for packet in packets:
    second = int(float(packet["pts_time"]))
    windows[second] = windows.get(second, 0) + int(packet["size"]) * 8
complete_windows = [windows[second] for second in range(1, duration - 1)]
lower = target_bitrate * 0.70
upper = target_bitrate * 1.30
if not complete_windows or any(bits < lower or bits > upper for bits in complete_windows):
    raise SystemExit(f"video bitrate windows outside CBR tolerance: {complete_windows}")

format_bitrate = int(metadata["format"].get("bit_rate", 0))
print(
    f"PASS {path}: {actual_frames} frames, {video['avg_frame_rate']} fps, "
    f"keyframes={keyframes}, max_audio_gap={max(audio_deltas):.3f}s, "
    f"format_bitrate={format_bitrate}, windows={complete_windows}"
)
PY
}

run_case() {
  local name="$1"
  local fps="$2"
  local with_audio="$3"
    local sample_rate="$4"

    make_fixture "$name" "$fps" "$with_audio" "$sample_rate"
  transcode_fixture "$name" "$with_audio"
  validate_output "$WORK_DIR/${name}-landscape.flv" 320 180
  validate_output "$WORK_DIR/${name}-portrait.flv" 180 320
}

assert_streamer_contract
run_case static-audio-96k 1 true 96000
run_case static-silent 1 false 44100
run_case normal-audio 30 true 48000
echo "All static-video CFR tests passed."
#!/usr/bin/env python3
"""Deterministic desktop workload plus read-only CPU/DRM/stream sampling.

Run inside the container as abc with /usr/bin/python3 (python3-tk). Select the
codec and resolution in the existing remote client first. No input is sent to
messaging apps, and this script never changes the stream settings.
"""
import argparse
import csv
from datetime import datetime, timezone
import json
import math
import os
from pathlib import Path
import time

WORKLOAD_VERSION = "desktop-codec-v1"
CODECS = {"h264": "x264enc", "h265": "h265enc", "av1": "av1enc"}
PHASES = ("static", "scroll", "mixed")
DEFAULT_STATE = "/run/selkies-video/diagnostics.json"


def phase_at(elapsed, warmup, segment):
    if elapsed < warmup:
        return "warmup", elapsed
    value = elapsed - warmup
    index = min(int(value // segment), len(PHASES) - 1)
    return PHASES[index], value - index * segment


def read_stream(path, now=None):
    now = time.time() if now is None else now
    try:
        document = json.loads(Path(path).read_text())
        if document.get("schema_version") != 1:
            return None, "unsupported_stream_schema"
        updated = float(document["updated_at"])
        if not math.isfinite(updated) or now - updated > 3 or updated - now > 1:
            return None, "stale_stream_snapshot"
        value = dict(document["displays"]["primary"])
        value["updated_at"] = updated
        return value, None
    except (OSError, ValueError, KeyError, TypeError):
        return None, "stream_snapshot_unavailable"


def stream_problems(state, args, session_id=None):
    if not state:
        return ["stream_snapshot_unavailable"]
    problems = []
    if state.get("active") is not True:
        problems.append("stream_inactive")
    if state.get("codec") != args.codec or state.get("requested_encoder") != CODECS[args.codec]:
        problems.append("actual_codec_mismatch")
    if state.get("width") != args.width or state.get("height") != args.height:
        problems.append("actual_resolution_mismatch")
    if state.get("target_fps") != args.fps:
        problems.append("actual_framerate_mismatch")
    if not state.get("session_id"):
        problems.append("stream_session_missing")
    elif session_id is not None and state["session_id"] != session_id:
        problems.append("stream_session_changed")
    return problems


def cpu_usage_usec(root=Path("/sys/fs/cgroup")):
    try:
        entries = dict(line.split() for line in (root / "cpu.stat").read_text().splitlines())
        return int(entries["usage_usec"])
    except (OSError, ValueError, KeyError):
        try:
            return int((root / "cpuacct/cpuacct.usage").read_text()) // 1000
        except (OSError, ValueError):
            return None


def parse_fdinfo(text):
    values = dict(line.split(":", 1) for line in text.splitlines() if ":" in line)
    identifier = values.get("drm-client-id", "").strip()
    device = values.get("drm-pdev", "").strip()
    if not identifier:
        return None
    engines = {}
    capacities = {}
    for key, value in values.items():
        parts = value.strip().split()
        try:
            if key.startswith("drm-engine-capacity-") and len(parts) == 1:
                capacities[key.removeprefix("drm-engine-capacity-")] = max(1, int(parts[0]))
            elif key.startswith("drm-engine-") and len(parts) == 2 and parts[1] == "ns":
                engines[key.removeprefix("drm-engine-")] = int(parts[0])
        except ValueError:
            pass
    return device + ":" + identifier, {"device": device or "unknown", "engines": engines,
                                        "capacities": capacities}


def gpu_snapshot(proc=Path("/proc")):
    clients = {}
    for process in proc.iterdir():
        if not process.name.isdigit():
            continue
        try:
            for info in (process / "fdinfo").iterdir():
                try:
                    parsed = parse_fdinfo(info.read_text())
                    if parsed:
                        key, record = parsed
                        # Shared/duplicated DRM file descriptors count once.
                        current = clients.setdefault(key, record)
                        for engine, value in record["engines"].items():
                            current["engines"][engine] = max(value, current["engines"].get(engine, 0))
                except OSError:
                    pass
        except OSError:
            pass
    return clients


def gpu_delta(previous, current, seconds):
    values = {}
    for client, record in current.items():
        old = previous.get(client)
        if not old:
            continue
        for engine, counter in record["engines"].items():
            before = old["engines"].get(engine)
            if before is None:
                continue
            # The kernel ABI permits temporary counter regressions. Retain the
            # high-water mark until the driver catches up, not a negative load.
            record["engines"][engine] = max(counter, before)
            capacity = record["capacities"].get(engine, 1)
            key = record["device"] + "/" + engine
            values[key] = values.get(key, 0) + max(0, counter - before) / seconds / 1e7 / capacity
    return {key: round(value, 3) for key, value in values.items()} or None


def summarize(rows, args):
    measured = [row for row in rows if row["phase"] != "warmup"]
    problems = sorted({problem for row in rows for problem in row["problems"]})
    if len(measured) < max(3, int(args.segment_seconds * 3) - 3):
        problems.append("incomplete_workload")
    for phase in PHASES:
        phase_rows = [row for row in measured if row["phase"] == phase]
        if len(phase_rows) < max(2, args.segment_seconds - 2):
            problems.append("incomplete_" + phase + "_phase")
        if phase in ("scroll", "mixed"):
            phase_states = [row["stream"] for row in phase_rows if row["stream"]]
            if len(phase_states) > 1:
                first_frames, last_frames = phase_states[0].get("frames"), phase_states[-1].get("frames")
                if (not isinstance(first_frames, (int, float)) or not isinstance(last_frames, (int, float))
                        or last_frames <= first_frames):
                    problems.append("no_video_during_" + phase)
    cpu = [row["cpu_one_core_percent"] for row in measured if row["cpu_one_core_percent"] is not None]
    streams = [row["stream"] for row in measured if row["stream"]]
    hardware = [state.get("hardware") for state in streams]
    hardware_status = "verified" if hardware and all(value is True for value in hardware) else (
        "software" if any(value is False for value in hardware) else "unknown")
    bandwidth = None
    if len(streams) > 1:
        first, last = streams[0], streams[-1]
        try:
            duration = last["updated_at"] - first["updated_at"]
            byte_delta = last["bytes"] - first["bytes"]
            frame_delta = last["frames"] - first["frames"]
            if duration > 0 and byte_delta > 0 and frame_delta > 0:
                bandwidth = {"duration_seconds": duration, "wire_bytes": byte_delta,
                             "frames": frame_delta, "average_bitrate_bps": 8 * byte_delta / duration,
                             "average_fps": frame_delta / duration,
                             "peak_bitrate_bps": max(state.get("bitrate_bps", 0) or 0 for state in streams)}
            else:
                problems.append("stream_counters_invalid")
        except (KeyError, TypeError):
            problems.append("stream_counters_unavailable")
    return {"valid_run": not problems, "problems": sorted(set(problems)),
            "hardware_evidence": hardware_status,
            "hardware_comparison_ready": not problems and hardware_status == "verified",
            "sample_count": len(measured),
            "cpu_average_one_core_percent": sum(cpu) / len(cpu) if cpu else None,
            "cpu_peak_one_core_percent": max(cpu) if cpu else None,
            "wire_video": bandwidth}


def write_results(base, metadata, rows, summary):
    base = Path(base)
    base.parent.mkdir(parents=True, exist_ok=True)
    result = {"metadata": metadata, "summary": summary, "samples": rows}
    base.with_suffix(".json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    fields = ["elapsed_seconds", "phase", "cpu_one_core_percent", "actual_codec", "hardware",
              "fps", "bitrate_bps", "frames", "bytes", "gpu_engine_percent", "problems"]
    with base.with_suffix(".csv").open("w", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=fields)
        writer.writeheader()
        for row in rows:
            state = row["stream"] or {}
            writer.writerow({"elapsed_seconds": row["elapsed_seconds"], "phase": row["phase"],
                             "cpu_one_core_percent": row["cpu_one_core_percent"],
                             "actual_codec": state.get("codec"), "hardware": state.get("hardware"),
                             **{key: state.get(key) for key in ("fps", "bitrate_bps", "frames", "bytes")},
                             "gpu_engine_percent": json.dumps(row["gpu_engine_percent"]),
                             "problems": ";".join(row["problems"])})


def run_workload(args):
    import tkinter as tk
    import tkinter.font as tkfont

    state, error = read_stream(args.stream_state)
    problems = [error] if error else stream_problems(state, args)
    if problems:
        raise RuntimeError("Preflight: " + ", ".join(problems))
    session_id = state["session_id"]
    root = tk.Tk()
    root.withdraw()
    if (root.winfo_screenwidth(), root.winfo_screenheight()) != (args.width, args.height):
        root.destroy()
        raise RuntimeError("X11 screen size does not match --width/--height; set the client resolution first")
    root.title("Selkies codec benchmark")
    root.overrideredirect(True)
    root.geometry(f"{args.width}x{args.height}+0+0")
    root.attributes("-topmost", True)
    canvas = tk.Canvas(root, width=args.width, height=args.height, highlightthickness=0, background="#f0f2f5")
    canvas.pack(fill="both", expand=True)
    families = set(tkfont.families(root))
    cjk = next((font for font in ("Noto Sans CJK SC", "Noto Sans CJK JP", "WenQuanYi Micro Hei") if font in families), None)
    font = cjk or "DejaVu Sans"
    sentence = "中文小字测试：消息列表、细线条与照片混合，保持原始分辨率。" if cjk else "Text clarity: messages, thin lines and image detail at native resolution."
    # Fixed procedural RGB image; no user photos, network fetch or random seed.
    image = tk.PhotoImage(width=256, height=144)
    image.put(" ".join("{" + " ".join(
        f"#{(x * 5 + y * 3) % 256:02x}{(x * 2 + y * 7) % 256:02x}{(x ^ y) % 256:02x}"
        for x in range(256)) + "}" for y in range(144)))
    image = image.zoom(2, 2)
    metadata = {"workload_version": WORKLOAD_VERSION, "generated_at": datetime.now(timezone.utc).isoformat(),
                "requested_codec": args.codec, "width": args.width, "height": args.height,
                "target_fps": args.fps, "warmup_seconds": args.warmup_seconds,
                "segment_seconds": args.segment_seconds, "phases": list(PHASES),
                "font": font, "chinese_text": bool(cjk), "session_id": session_id,
                "cpu_unit": "100 percent equals one fully occupied logical CPU",
                "gpu_source": "per-client DRM fdinfo engine time; null means unavailable",
                "recording": "not started by this script"}
    rows = []
    started = time.monotonic()
    previous_cpu, previous_gpu = cpu_usage_usec(), gpu_snapshot()
    previous_sample = started
    previous_phase, previous_frame, scroll_offset = None, None, 0
    draw_updates = {phase: 0 for phase in PHASES}
    total = args.warmup_seconds + args.segment_seconds * len(PHASES)
    interrupted = False

    def stop():
        nonlocal interrupted
        interrupted = True
        root.quit()
    root.bind("<Escape>", lambda _event: stop())
    root.protocol("WM_DELETE_WINDOW", stop)

    def draw_phase(phase):
        nonlocal scroll_offset
        canvas.delete("all")
        scroll_offset = 0
        canvas.create_rectangle(0, 0, args.width, 74, fill="#253443", outline="")
        canvas.create_text(24, 36, text=WORKLOAD_VERSION + " | " + phase, anchor="w", fill="white", font=(font, 20))
        if phase == "static":
            for row in range(14):
                canvas.create_text(30, 105 + row * 35, text=f"{row + 1:02d}  {sentence}", anchor="w",
                                   font=(font, 9 + row % 4), fill=("#1b2733", "#ca4265", "#2670b5")[row % 3])
                canvas.create_line(30, 120 + row * 35, args.width - 30, 120 + row * 35, fill="#a5b0bb")
        elif phase in ("scroll", "mixed"):
            column = args.width if phase == "scroll" else max(600, args.width - 560)
            row_count = max(80, math.ceil((args.height + args.segment_seconds * 180) / 72) + 1)
            for row in range(row_count):
                y = 95 + row * 72
                canvas.create_rectangle(20, y, column - 30, y + 58, fill="#ffffff" if row % 2 else "#d6e8d4",
                                        outline="#c5ced6", tags="scroll")
                canvas.create_text(32, y + 28, text=f"{row:03d}  {sentence}", anchor="w", font=(font, 12),
                                   fill="#243441", tags="scroll")
            if phase == "mixed":
                canvas.create_rectangle(args.width - 550, 75, args.width, args.height, fill="#132330", outline="")
                for row in range(2):
                    canvas.create_image(args.width - 530, 100 + row * 320, image=image, anchor="nw", tags="image")
        else:
            canvas.create_text(args.width // 2, args.height // 2, text="Warmup | Escape to stop",
                               font=(font, 28), fill="#243441")

    def tick():
        nonlocal previous_sample, previous_cpu, previous_gpu, previous_phase, previous_frame, scroll_offset
        now = time.monotonic()
        elapsed = now - started
        phase, local_time = phase_at(elapsed, args.warmup_seconds, args.segment_seconds)
        frame = int(local_time * args.fps)
        if phase != previous_phase:
            draw_phase(phase)
            previous_phase, previous_frame = phase, None
        if frame != previous_frame and phase in ("scroll", "mixed"):
            draw_updates[phase] += 1
            offset = -int(frame * 180 / args.fps)
            canvas.move("scroll", 0, offset - scroll_offset)
            scroll_offset = offset
            if phase == "mixed":
                canvas.coords("image", args.width - 530 + int(10 * math.sin(frame / args.fps * 2)), 100)
        previous_frame = frame
        if now - previous_sample >= 1:
            current_cpu, current_gpu = cpu_usage_usec(), gpu_snapshot()
            seconds = now - previous_sample
            cpu = (current_cpu - previous_cpu) / seconds / 10000 if current_cpu is not None and previous_cpu is not None else None
            current_state, read_error = read_stream(args.stream_state)
            issues = [read_error] if read_error else stream_problems(current_state, args, session_id)
            if cpu is not None and cpu < 0:
                issues.append("cpu_counter_reset")
                cpu = None
            rows.append({"elapsed_seconds": round(elapsed, 3), "phase": phase,
                         "cpu_one_core_percent": round(cpu, 3) if cpu is not None else None,
                         "gpu_engine_percent": gpu_delta(previous_gpu, current_gpu, seconds),
                         "stream": current_state, "problems": issues})
            previous_cpu, previous_gpu, previous_sample = current_cpu, current_gpu, now
        if elapsed >= total:
            root.quit()
            return
        root.after(max(1, int(1000 / args.fps)), tick)

    root.deiconify()
    root.focus_force()
    root.after(0, tick)
    try:
        root.mainloop()
    finally:
        root.destroy()
    summary = summarize(rows, args)
    metadata["draw_updates_by_phase"] = draw_updates
    if interrupted:
        summary["problems"].append("workload_interrupted")
        summary["valid_run"] = summary["hardware_comparison_ready"] = False
    write_results(args.output, metadata, rows, summary)
    print(json.dumps({"output_json": str(Path(args.output).with_suffix(".json")),
                      "output_csv": str(Path(args.output).with_suffix(".csv")), "summary": summary}, indent=2))
    return 0 if summary["valid_run"] else 2


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--codec", required=True, choices=CODECS)
    parser.add_argument("--width", type=int, default=1920)
    parser.add_argument("--height", type=int, default=1080)
    parser.add_argument("--fps", type=int, default=30)
    parser.add_argument("--warmup-seconds", type=int, default=5)
    parser.add_argument("--segment-seconds", type=int, default=20)
    parser.add_argument("--stream-state", default=DEFAULT_STATE)
    parser.add_argument("--output", required=True, help="JSON/CSV filename stem; may be under /config/logs")
    args = parser.parse_args()
    if not (640 <= args.width <= 8192 and 480 <= args.height <= 8192 and 1 <= args.fps <= 120
            and 0 <= args.warmup_seconds <= 30 and 5 <= args.segment_seconds <= 120):
        parser.error("Unsupported dimensions, fps or duration")
    try:
        return run_workload(args)
    except Exception as exc:
        print(json.dumps({"valid_run": False, "error": str(exc)}))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""Container probe for typing correctness and frame ACK processing.

Runs the production input and WebSocket methods against real Xvfb/xterm.
Chinese commits use the production X11 selection transaction, including targets
paused for 300/500 ms and restoration of a binary clipboard. Frame ACKs keep
flowing while the target is paused for 4.3 seconds with an input backlog.

Host mode creates a resource-limited container from a local image, copies this
script and the repository's ``input_handler.py`` into it, and runs inside mode
with the image's own Python (which has python-xlib, Xvfb, xterm and xdotool).

    python tests/ime_xtest_container_probe.py --image wechat-selkies:1.75
"""

from __future__ import annotations

import argparse
import asyncio
import ast
import logging
import os
import shutil
import subprocess
import sys
import tempfile
import time
import uuid
from difflib import SequenceMatcher
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
INPUT_HANDLER = REPO_ROOT / "root/lsiopy/lib/python3.12/site-packages/selkies/input_handler.py"
# Not /tmp: the container gets a fresh tmpfs there when it starts.
CONTAINER_SOURCE = "/opt/input_handler.py"
CONTAINER_SCRIPT = "/opt/ime_xtest_container_probe.py"
CONTAINER_PYTHON = "/lsiopy/bin/python3"
XTEST_METHODS = {"_xtest_input_enabled", "send_x11_keypress"}
SERVER_SOURCE = INPUT_HANDLER.with_name("selkies.py")
STATS_FIXTURE = REPO_ROOT / "tests/test_ws_stats_lifecycle.py"



# --------------------------------------------------------------------------------------
# host mode
# --------------------------------------------------------------------------------------


def run_command(args: list[str], *, timeout: float = 30, check: bool = True) -> subprocess.CompletedProcess:
    executed = subprocess.run(
        args, capture_output=True, text=True, encoding="utf-8", errors="replace",
        timeout=timeout, check=False,
    )
    if check and executed.returncode:
        raise RuntimeError(
            f"command failed ({executed.returncode}): {args}\n"
            f"stdout: {executed.stdout!r}\nstderr: {executed.stderr!r}"
        )
    return executed


def docker_has_image(image: str) -> bool:
    """False when Docker is unavailable or the image is not built locally."""
    try:
        return run_command(["docker", "image", "inspect", image], timeout=30, check=False).returncode == 0
    except (OSError, RuntimeError):
        return False


def host_main(image: str, python_binary: str) -> int:
    if not INPUT_HANDLER.is_file():
        raise FileNotFoundError(INPUT_HANDLER)
    run_command(["docker", "image", "inspect", image], timeout=30)

    name = "codex-ime-xtest-" + uuid.uuid4().hex[:10]
    create = run_command(
        [
            "docker", "create", "--name", name,
            "--network", "none",
            "--cpus=1", "--memory=1g", "--pids-limit=64",
            "--tmpfs", "/tmp:rw,nosuid,nodev,exec,size=256m,mode=1777",
            "--user", "0:0",
            "--entrypoint", "/bin/sh",
            image, "-c", "sleep 180",
        ],
        timeout=60,
    )
    container_id = create.stdout.strip()
    if not container_id:
        raise RuntimeError(f"docker create returned no container ID: {create.stderr}")

    result_code = 1
    try:
        run_command(["docker", "cp", str(INPUT_HANDLER), f"{container_id}:{CONTAINER_SOURCE}"], timeout=60)
        run_command(["docker", "cp", str(Path(__file__).resolve()), f"{container_id}:{CONTAINER_SCRIPT}"], timeout=60)
        run_command(["docker", "cp", str(SERVER_SOURCE), f"{container_id}:/opt/selkies.py"], timeout=60)
        run_command(["docker", "cp", str(STATS_FIXTURE), f"{container_id}:/opt/stats_fixture.py"], timeout=60)
        run_command(["docker", "cp", str(INPUT_HANDLER.with_name("x11_text_paste.py")), f"{container_id}:/lsiopy/lib/python3.12/site-packages/selkies/x11_text_paste.py"], timeout=60)
        run_command(["docker", "start", container_id], timeout=60)
        print(f"CONTAINER image={image} id={container_id[:12]} network=none cpu_limit=1 memory_limit=1GiB")
        executed = run_command(
            ["docker", "exec", container_id, python_binary, CONTAINER_SCRIPT, "--inside",
             "--source", CONTAINER_SOURCE],
            timeout=170, check=False,
        )
        if executed.stdout:
            print(executed.stdout, end="")
        if executed.stderr:
            print(executed.stderr, end="", file=sys.stderr)
        result_code = executed.returncode
    finally:
        removed = run_command(["docker", "rm", "-f", container_id], timeout=30, check=False)
        print(f"CLEANUP_OK id={container_id[:12]}" if not removed.returncode
              else f"CLEANUP_FAILED id={container_id[:12]} stderr={removed.stderr.strip()}")
    return result_code


# --------------------------------------------------------------------------------------
# inside mode
# --------------------------------------------------------------------------------------


def module_constants(source: str) -> dict:
    values = {}
    for node in ast.parse(source).body:
        if isinstance(node, ast.Assign) and isinstance(node.targets[0], ast.Name):
            try:
                values[node.targets[0].id] = ast.literal_eval(node.value)
            except (ValueError, SyntaxError, TypeError):
                pass
    return values


def build_handler(source_path: Path, spawn_records: list, log_records: list):
    """Instantiate the production class methods with real python-xlib."""
    import Xlib.X
    import Xlib.ext.xtest

    source = source_path.read_text(encoding="utf-8-sig")
    tree = ast.parse(source)
    klass = next(
        node for node in tree.body
        if isinstance(node, ast.ClassDef)
        and any(getattr(m, "name", "") == "on_message" for m in node.body)
    )
    wanted = XTEST_METHODS | {"on_message", "_get_clipboard_lock", "_paste_committed_text"}
    body = [
        node for node in klass.body
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in wanted
    ]
    missing = wanted - {node.name for node in body}
    if missing:
        raise RuntimeError(f"production methods missing from {source_path}: {sorted(missing)}")
    injected = ast.ClassDef(name="XTestProbeClient", bases=[], keywords=[], body=body, decorator_list=[])
    module = ast.Module(body=[injected], type_ignores=[])
    ast.fix_missing_locations(module)

    async def recording_create_subprocess_exec(*args, **kwargs):
        process = await asyncio.create_subprocess_exec(*args, **kwargs)
        spawn_records.append({"args": args, "process": process})
        return process

    logger = logging.getLogger(f"ime-xtest-probe-{os.getpid()}")
    logger.setLevel(logging.DEBUG)
    logger.propagate = False

    class Collector(logging.Handler):
        def emit(self, record):
            log_records.append(record)

    logger.addHandler(Collector())
    namespace = {
        "__package__": "selkies", "__name__": "selkies.input_handler",
        "X11_LIBS_AVAILABLE": True, "xtest": Xlib.ext.xtest, "X": Xlib.X,
        "logger_webrtc_input": logger, "asyncio": asyncio,
        "env_truthy": lambda name, default=False: (
            os.environ.get(name, str(default)).strip().lower() in {"1", "true", "yes", "on"}
        ),
        "subprocess": type("SubprocessProxy", (), {
            "PIPE": asyncio.subprocess.PIPE,
            "create_subprocess_exec": staticmethod(recording_create_subprocess_exec),
        })(),
        "UNICODE_KEYSYM_BASE": 0x01000000,
        "X11_KEYSYM_MAP": {65293: {"xkey_name": "Return"}},
    }
    exec(compile(module, str(source_path), "exec"), namespace)

    client = namespace["XTestProbeClient"]()
    client.send_clipboard_status = lambda message: logger.warning(message)
    client.is_wayland = False
    client.active_shortcut_modifiers = set()
    client.active_modifiers = set()
    client.MODIFIER_KEYSYMS = {0xFFE3, 0xFFE1, 0xFFE9, 0xFFE2, 0xFFE4, 0xFFEA}
    client.atomically_typed_keys = set()
    client.wayland_input = None
    client.SHORTCUT_MODIFIER_XKEY_NAMES = {"Control_L", "Shift_L", "Alt_L", "Super_L"}
    return client


def snapshot_keyboard_mapping(display) -> dict:
    info = display.display.info
    low, high = int(info.min_keycode), int(info.max_keycode)
    entries = display.get_keyboard_mapping(low, high - low + 1)
    return {low + index: tuple(int(sym or 0) for sym in entry) for index, entry in enumerate(entries)}


def print_diff(label: str, expected: str, actual: str) -> None:
    ops = [
        (tag, i1, i2, j1, j2)
        for tag, i1, i2, j1, j2 in SequenceMatcher(None, expected, actual, autojunk=False).get_opcodes()
        if tag != "equal"
    ]
    print(f"DETAIL {label} diff_ops={ops[:12]!r} expected={expected[:120]!r} actual={actual[:120]!r}")
    print(f"DETAIL {label} expected_codepoints=" + ",".join(f"{ord(c):04X}" for c in expected))
    print(f"DETAIL {label} actual_codepoints=" + ",".join(f"{ord(c):04X}" for c in actual))


async def probe_frame_acks(client, spawn_records, drain, lines, terminal_pid) -> bool:
    """Run the real ws_handler while its real input method types for >4 s."""
    import importlib.util
    from types import SimpleNamespace

    spec = importlib.util.spec_from_file_location("stats_fixture", "/opt/stats_fixture.py")
    fixture = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(fixture)
    fixture.SOURCE = Path("/opt/selkies.py")

    class ProbeWebSocket:
        remote_address = ("127.0.0.1", 4599)
        request = SimpleNamespace(path="/", headers={})

        def __init__(self):
            self.queue = asyncio.Queue()
            self.closed = False

        def feed(self, message):
            self.queue.put_nowait(message)

        async def send(self, message):
            pass

        async def close(self, **kwargs):
            self.closed = True
            self.feed(None)

        async def __aiter__(self):
            while True:
                message = await self.queue.get()
                if message is None:
                    return
                yield message

    async def ignore_mouse(*args, **kwargs):
        pass

    client.send_x11_mouse = ignore_mouse
    ws = ProbeWebSocket()
    server, _ = fixture.stats_server(input_handler=client, display_id="primary")
    state = {"ws": ws, "acknowledged_frame_id": -1}
    server.display_clients["primary"] = state
    handler = asyncio.create_task(server.ws_handler(ws))
    payload = "输入画面继续播放" * 3
    start_line, start_children = len(lines()), len(spawn_records)
    latencies = []
    import signal
    started_paste, done_paste = asyncio.Event(), asyncio.Event()
    native_paste = client._paste_committed_text
    async def tracked_paste(text):
        started_paste.set()
        try:
            await native_paste(text)
        finally:
            done_paste.set()
    client._paste_committed_text = tracked_paste
    os.kill(terminal_pid, signal.SIGSTOP)
    async def resume_target():
        await asyncio.sleep(4.3)
        os.kill(terminal_pid, signal.SIGCONT)
    resume = asyncio.create_task(resume_target())
    started = time.monotonic()
    try:
        ws.feed("co,end," + payload)
        deadline = started + 12
        while not started_paste.is_set():
            if time.monotonic() > deadline or handler.done():
                raise RuntimeError("queued native injection did not start")
            await asyncio.sleep(.01)

        # More than the old 256-message cap. These composition preedits don't
        # alter the target text, but they do exercise the real ordered FIFO.
        for _ in range(300):
            ws.feed("co,start,ni")
        for x in range(259):
            ws.feed(f"m,{x},0,0,0")
        frame_id = 0
        while time.monotonic() < deadline:
            frame_id += 1
            ack_started = time.monotonic()
            ws.feed(f"CLIENT_FRAME_ACK {frame_id}")
            while state["acknowledged_frame_id"] != frame_id:
                if time.monotonic() - ack_started > .5:
                    raise RuntimeError("frame ACK stalled behind native input")
                await asyncio.sleep(.005)
            latencies.append(time.monotonic() - ack_started)
            if done_paste.is_set():
                break
            await asyncio.sleep(.1)
        else:
            raise RuntimeError("native injection did not complete")
        inject_seconds = time.monotonic() - started
        drain()
        captured = lines()[start_line:]
        ok = (captured == [payload, ""] and not ws.closed
              and len(latencies) > 20 and inject_seconds > 4)
        print(f"CASE frame_acks status={'PASS' if ok else 'FAIL'} "
              f"inject={inject_seconds:.2f}s acks={len(latencies)} "
              f"max_ack_ms={max(latencies) * 1000:.1f} "
              f"captured_chars={len(captured[0]) if captured else 0}")
        return ok
    finally:
        os.kill(terminal_pid, signal.SIGCONT)
        await resume
        client._paste_committed_text = native_paste
        ws.feed(None)
        await asyncio.wait_for(handler, 3)


async def inside_main(source_path: Path) -> int:
    for tool in ("Xvfb", "xterm", "xdotool"):
        if shutil.which(tool) is None:
            raise RuntimeError(f"{tool} is required inside the container")
    import Xlib.display
    # /opt/selkies.py is the AST fixture, not the installed selkies package.
    sys.path[:] = [entry for entry in sys.path if entry != "/opt"]

    # xterm uses Shift+Insert; WeChat/QQ use the default Ctrl+V.
    os.environ["SELKIES_IME_PASTE_SHORTCUT"] = "shift+Insert"
    env = os.environ.copy()
    display_number = 90 + (os.getpid() % 60)
    display_name = f":{display_number}"
    env["DISPLAY"] = display_name
    os.environ["DISPLAY"] = display_name
    env.setdefault("LANG", "en_US.UTF-8")
    env.setdefault("LC_ALL", "en_US.UTF-8")

    spawn_records: list = []
    log_records: list = []
    client = build_handler(source_path, spawn_records, log_records)

    temp_dir = Path(tempfile.mkdtemp(prefix="ime-xtest-"))
    capture_file = temp_dir / "captured.txt"
    server = subprocess.Popen(
        ["Xvfb", display_name, "-screen", "0", "1280x800x24", "-nolisten", "tcp", "-noreset"],
        env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True,
    )
    terminal = None
    failures = 0
    try:
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            probe = subprocess.run(["xdotool", "getdisplaygeometry"], env=env, capture_output=True,
                                   text=True, timeout=5, check=False)
            if probe.returncode == 0:
                break
            time.sleep(0.1)
        else:
            raise RuntimeError("Xvfb did not come up")

        terminal = subprocess.Popen(
            ["xterm", "-title", "IME XTEST Capture", "-geometry", "120x50+0+0",
             "-xrm", "*selectToClipboard: true",
             "-e", "/bin/sh", "-c", f"cat > {capture_file}"],
            env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True,
        )
        search = subprocess.run(
            ["xdotool", "search", "--sync", "--onlyvisible", "--name", "IME XTEST Capture"],
            env=env, capture_output=True, text=True, timeout=10, check=False,
        )
        if search.returncode or not search.stdout.strip():
            raise RuntimeError(f"capture window not found: {search.stderr.strip()}")
        window_id = search.stdout.splitlines()[-1].strip()

        xdisplay = Xlib.display.Display()
        client.xdisplay = xdisplay
        mapping_before = snapshot_keyboard_mapping(xdisplay)

        def focus() -> None:
            focused = subprocess.run(["xdotool", "windowfocus", "--sync", window_id], env=env,
                                     capture_output=True, text=True, timeout=10, check=False)
            if focused.returncode:
                raise RuntimeError(f"cannot focus capture window: {focused.stderr.strip()}")

        def lines() -> list[str]:
            try:
                return capture_file.read_text(encoding="utf-8", errors="replace").splitlines()
            except FileNotFoundError:
                return []

        def drain() -> None:
            # Two Returns: the first commits the typed line, the second is the
            # drain sentinel that would catch any late key event.
            for _ in range(2):
                result = subprocess.run(["xdotool", "key", "--clearmodifiers", "Return"], env=env,
                                        capture_output=True, text=True, timeout=10, check=False)
                if result.returncode:
                    raise RuntimeError(f"xdotool Return failed: {result.stderr.strip()}")
                time.sleep(0.25)

        async def run_case(label: str, messages: list[str], expected: str, xtest_enabled: bool,
                           expect_children: int | None) -> bool:
            os.environ["SELKIES_XTEST_INPUT"] = "true" if xtest_enabled else "false"
            focus()
            start_line, start_children = len(lines()), len(spawn_records)
            started = time.monotonic()
            for message in messages:
                await client.on_message(message, "primary")
            inject_seconds = time.monotonic() - started
            drain()
            case_children = spawn_records[start_children:]
            captured_lines = lines()[start_line:]
            actual = captured_lines[0] if captured_lines else ""
            drained = len(captured_lines) > 1 and captured_lines[1] == ""
            elapsed = time.monotonic() - started
            ok = actual == expected and drained
            if expect_children is not None:
                ok = ok and len(case_children) == expect_children
            print(
                f"CASE {label} status={'PASS' if ok else 'MISMATCH'} xtest={xtest_enabled} "
                f"chars={len(expected)} captured={len(actual)} children={len(case_children)} "
                f"drained={drained} inject={inject_seconds:.2f}s "
                f"per_char={inject_seconds / max(1, len(expected)) * 1000:.0f}ms total={elapsed:.2f}s"
            )
            if not ok:
                print("WARNINGS", [record.getMessage() for record in log_records][-8:])
                print_diff(label, expected, actual)
            return ok

        cases = [
            await run_case("cjk_commit", ["co,end,中文测试，你好，世界。"], "中文测试，你好，世界。", True, 0),
            await run_case("mixed_ascii", ["co,end,abc，你好123！ok"], "abc，你好123！ok", True, 0),
            await run_case(
                "key_by_key",
                [part for char in "123!?-" for part in (f"kd,{ord(char)}", f"ku,{ord(char)}")],
                "123!?-", True, 6,
            ),
        ]
        # Exercise actual delayed application consumption, not a sleep in the
        # sender. Confirm both first-character preservation and binary restore.
        import signal
        import io
        from PIL import Image
        image_buffer = io.BytesIO()
        Image.effect_noise((320, 320), 100).convert("RGB").save(image_buffer, "PNG")
        clipboard_image = image_buffer.getvalue()
        clip_owner = subprocess.Popen(["xclip", "-selection", "clipboard", "-i", "-t", "image/png", "-quiet"],
                                      stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        clip_owner.stdin.write(clipboard_image)
        clip_owner.stdin.close()
        await asyncio.sleep(.1)
        for pause, payload in ((.3, "中ab"), (.5, "中文")):
            os.kill(terminal.pid, signal.SIGSTOP)
            async def resume_target(delay=pause):
                await asyncio.sleep(delay)
                os.kill(terminal.pid, signal.SIGCONT)
            resume = asyncio.create_task(resume_target())
            async def clipboard_observer():
                # Another clipboard consumer must not acknowledge the app's paste.
                await asyncio.sleep(.1)
                child = await asyncio.create_subprocess_exec("xclip", "-selection", "clipboard", "-o", "-t", "UTF8_STRING",
                                                             stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
                await asyncio.wait_for(child.communicate(), 2)
            observer = asyncio.create_task(clipboard_observer())
            try:
                cases.append(await run_case(f"busy_target_{pause}", ["co,end," + payload], payload, True, 0))
            finally:
                os.kill(terminal.pid, signal.SIGCONT)
                await resume
                await observer
            restored = subprocess.run(["xclip", "-selection", "clipboard", "-o", "-t", "image/png"], capture_output=True, timeout=5)
            preserved = restored.returncode == 0 and restored.stdout == clipboard_image
            print(f"CASE clipboard_restore status={'PASS' if preserved else 'FAIL'} bytes={len(clipboard_image)}")
            cases.append(preserved)
        if clip_owner.poll() is None:
            clip_owner.terminate()
        clip_owner.wait(timeout=5)
        cases.append(await probe_frame_acks(client, spawn_records, drain, lines, terminal.pid))
        failures += sum(1 for ok in cases if not ok)

        # No production scratch map or cleanup timer remains. The established
        # xdotool path must restore its own mappings before it returns.
        xdisplay.sync()
        mapping_after = snapshot_keyboard_mapping(xdisplay)
        changed = {
            keycode: (before, mapping_after[keycode])
            for keycode, before in mapping_before.items()
            if mapping_after.get(keycode) != before
        }
        if changed:
            failures += 1
            print(f"CASE mapping_restore status=FAIL changed={list(changed.items())[:6]}")
        else:
            print("CASE mapping_restore status=PASS keyboard mapping unchanged")

        warned = [record.getMessage() for record in log_records if record.levelno >= logging.WARNING]
        print(f"SUMMARY cases={len(cases)} failures={failures} children={len(spawn_records)} "
              f"warnings={warned[:4]}")
        return 1 if failures else 0
    finally:
        for process in (terminal, server):
            if process is None:
                continue
            try:
                os.killpg(process.pid, 15)
            except (ProcessLookupError, PermissionError):
                process.terminate()
        shutil.rmtree(temp_dir, ignore_errors=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--inside", action="store_true")
    parser.add_argument("--source", type=Path)
    parser.add_argument("--image", default="wechat-selkies:latest")
    parser.add_argument("--python", dest="python_binary", default=CONTAINER_PYTHON)
    args = parser.parse_args()

    if args.inside:
        if args.source is None:
            parser.error("--inside requires --source")
        return asyncio.run(inside_main(args.source))
    return host_main(args.image, args.python_binary)


if __name__ == "__main__":
    sys.exit(main())

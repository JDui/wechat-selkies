#!/usr/bin/env python3
"""Run bounded real-subprocess/X11 IME pressure checks in a disposable Docker container.

Host mode (default) creates only a uniquely named throwaway container from an
already-local image, copies this script and input_handler.py into it, runs the
checks, then removes the container by the ID returned by docker create.
"""

from __future__ import annotations

import argparse
import ast
import asyncio
from difflib import SequenceMatcher
import importlib.util
import logging
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import uuid


REPO_ROOT = Path(__file__).resolve().parents[1]
INPUT_HANDLER = (
    REPO_ROOT
    / "root/lsiopy/lib/python3.12/site-packages/selkies/input_handler.py"
)
CONTAINER_SCRIPT = "/opt/ime_container_stress.py"
CONTAINER_SOURCE = "/opt/ime_input_handler.py"


def run_command(args: list[str], *, timeout: float = 20, check: bool = True):
    result = subprocess.run(
        args,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
        check=False,
    )
    if check and result.returncode:
        raise RuntimeError(
            f"command failed ({result.returncode}): {args!r}\n"
            f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}"
        )
    return result


def host_main(
    image: str,
    quick: bool = False,
    segment_size: int = 0,
    probe_key: bool = False,
    first_character: bool = False,
) -> int:
    if not INPUT_HANDLER.is_file():
        raise FileNotFoundError(INPUT_HANDLER)
    if not Path(__file__).is_file():
        raise FileNotFoundError(__file__)

    run_command(["docker", "image", "inspect", image], timeout=20)
    name = "codex-ime-stress-" + uuid.uuid4().hex[:10]
    create = run_command(
        [
            "docker",
            "create",
            "--name",
            name,
            "--network",
            "none",
            "--cpus=0.5",
            "--memory=1g",
            "--pids-limit=64",
            "--tmpfs",
            "/tmp:rw,nosuid,nodev,exec,size=256m,mode=1777",
            "--user",
            "0:0",
            "--entrypoint",
            "/bin/sh",
            image,
            "-c",
            "sleep 60" if first_character else "sleep 180",
        ],
        timeout=30,
    )
    container_id = create.stdout.strip()
    if not container_id:
        raise RuntimeError(f"docker create returned no container ID: {create.stderr}")

    result_code = 1
    try:
        run_command(
            ["docker", "cp", str(INPUT_HANDLER), f"{container_id}:{CONTAINER_SOURCE}"]
        )
        run_command(
            ["docker", "cp", str(Path(__file__).resolve()), f"{container_id}:{CONTAINER_SCRIPT}"]
        )
        run_command(["docker", "cp", str(INPUT_HANDLER.with_name("x11_text_paste.py")), f"{container_id}:/lsiopy/lib/python3.12/site-packages/selkies/x11_text_paste.py"])
        run_command(["docker", "start", container_id])
        print(
            f"CONTAINER image={image} id={container_id[:12]} "
            "network=none cpu_limit=0.5 memory_limit=1GiB pids_limit=64"
        )
        try:
            exec_args = [
                    "docker",
                    "exec",
                    container_id,
                    "python3",
                    CONTAINER_SCRIPT,
                    "--inside",
                    "--source",
                    CONTAINER_SOURCE,
                ]
            if quick:
                exec_args.append("--quick")
            if segment_size:
                exec_args.extend(["--segment-size", str(segment_size)])
            if probe_key:
                exec_args.append("--probe-key")
            if first_character:
                exec_args.append("--first-character")
            executed = subprocess.run(
                exec_args,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=35 if first_character else 150,
                check=False,
            )
            if executed.stdout:
                print(executed.stdout, end="")
            if executed.stderr:
                print(executed.stderr, end="", file=sys.stderr)
            result_code = executed.returncode
        except subprocess.TimeoutExpired as error:
            print(f"HOST_TIMEOUT after {error.timeout}s; container will be removed")
            if error.stdout:
                print(error.stdout.decode(errors="replace") if isinstance(error.stdout, bytes) else error.stdout)
            if error.stderr:
                print(error.stderr.decode(errors="replace") if isinstance(error.stderr, bytes) else error.stderr, file=sys.stderr)
            result_code = 124
    finally:
        removed = run_command(["docker", "rm", "-f", container_id], timeout=20, check=False)
        if removed.returncode:
            print(
                f"CLEANUP_FAILED id={container_id[:12]} "
                f"stderr={removed.stderr.strip()}",
                file=sys.stderr,
            )
            result_code = result_code or 1
        else:
            print(f"CLEANUP_OK id={container_id[:12]}")
    return result_code


def cpu_usage_usec() -> int | None:
    for candidate in ("/sys/fs/cgroup/cpu.stat", "/sys/fs/cgroup/cpu/cpu.stat"):
        try:
            for line in Path(candidate).read_text().splitlines():
                key, value = line.split()
                if key == "usage_usec":
                    return int(value)
        except (OSError, ValueError):
            pass
    return None


def cpu_limit_text() -> str:
    try:
        return Path("/sys/fs/cgroup/cpu.max").read_text().strip()
    except OSError:
        return "unavailable"


def require_x11_tools() -> None:
    required = ("Xvfb", "xdotool", "xterm", "timeout", "python3")
    missing = [name for name in required if shutil.which(name) is None]
    if missing:
        raise RuntimeError("missing in local image: " + ", ".join(missing))


def wait_for_x_server(display: str, env: dict[str, str], server: subprocess.Popen) -> None:
    for _ in range(100):
        if server.poll() is not None:
            raise RuntimeError(f"Xvfb exited early with status {server.returncode}")
        check = subprocess.run(
            ["xdotool", "getdisplaygeometry"],
            env=env,
            capture_output=True,
            text=True,
            timeout=2,
            check=False,
        )
        if check.returncode == 0:
            return
        time.sleep(0.05)
    raise RuntimeError(f"X server {display} did not become ready")


async def inside_main(
    source_path: Path,
    quick: bool = False,
    segment_size: int = 0,
    probe_key: bool = False,
    first_character: bool = False,
) -> int:
    require_x11_tools()
    handler_source = source_path.read_text(encoding="utf-8-sig")
    tree = ast.parse(handler_source)
    input_class = next(
        node
        for node in tree.body
        if isinstance(node, ast.ClassDef)
        and any(getattr(method, "name", "") == "on_message" for method in node.body)
    )
    on_message_ast = next(
        method for method in input_class.body if getattr(method, "name", "") == "on_message"
    )

    records: list[dict[str, object]] = []
    timeout_values: list[float] = []
    log_records: list[logging.LogRecord] = []

    async def real_create_subprocess_exec(*args, **kwargs):
        process = await asyncio.create_subprocess_exec(*args, **kwargs)
        record = {"process": process, "args": args, "started": time.monotonic()}
        original_communicate = process.communicate

        async def tracked_communicate(*comm_args, **comm_kwargs):
            result = await original_communicate(*comm_args, **comm_kwargs)
            record["communicate_result"] = result
            return result

        process.communicate = tracked_communicate
        records.append(record)
        return process

    async def measured_wait_for(coro, timeout):
        timeout_values.append(timeout)
        return await asyncio.wait_for(coro, timeout=timeout)

    logger = logging.getLogger(f"ime-container-stress-{os.getpid()}")
    logger.setLevel(logging.WARNING)
    logger.propagate = False

    class LogCollector(logging.Handler):
        def emit(self, record):
            log_records.append(record)

    collector = LogCollector()
    logger.addHandler(collector)
    namespace = {
        "__package__": "selkies", "__name__": "selkies.input_handler",
        "subprocess": type(
            "SubprocessProxy",
            (),
            {
                "PIPE": asyncio.subprocess.PIPE,
                "create_subprocess_exec": staticmethod(real_create_subprocess_exec),
            },
        )(),
        "asyncio": type(
            "AsyncioProxy",
            (),
            {
                "wait_for": staticmethod(measured_wait_for),
                "Lock": asyncio.Lock,
                "CancelledError": asyncio.CancelledError,
                "get_running_loop": staticmethod(asyncio.get_running_loop),
                "sleep": staticmethod(asyncio.sleep),
            },
        )(),
        "logger_webrtc_input": logger,
    }
    exec(
        compile(ast.Module(body=[on_message_ast] + [m for m in input_class.body if getattr(m, "name", "") in {"_get_clipboard_lock", "_paste_committed_text"}], type_ignores=[]), str(source_path), "exec"),
        namespace,
    )
    on_message = namespace["on_message"]
    client = type("Client", (), {"is_wayland": False, "_get_clipboard_lock": namespace["_get_clipboard_lock"],
                                "_paste_committed_text": namespace["_paste_committed_text"],
                                "send_clipboard_status": lambda self, message: logger.warning(message)})()

    display = f":{90 + (os.getpid() % 80)}"
    os.environ["SELKIES_IME_PASTE_SHORTCUT"] = "shift+Insert"
    env = os.environ.copy()
    env["DISPLAY"] = display
    env.setdefault("LANG", "en_US.UTF-8")
    env.setdefault("LC_ALL", "en_US.UTF-8")
    os.environ["DISPLAY"] = display
    os.environ.setdefault("LANG", "en_US.UTF-8")
    os.environ.setdefault("LC_ALL", "en_US.UTF-8")
    temp_dir = Path(tempfile.mkdtemp(prefix="ime-x11-stress-"))
    capture_file = temp_dir / "captured.txt"
    server: subprocess.Popen | None = None
    terminal: subprocess.Popen | None = None
    hogs: list[subprocess.Popen] = []
    failed = False
    unicode_capture_ok = False
    cpu_limit = cpu_limit_text()
    print(
        f"ENV python={sys.version.split()[0]} display={display} "
        f"cpu.max={cpu_limit} xdotool={shutil.which('xdotool')} xterm={shutil.which('xterm')}"
    )

    def stop_process_group(process: subprocess.Popen) -> None:
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except (ProcessLookupError, PermissionError):
            try:
                process.terminate()
            except ProcessLookupError:
                pass
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                process.kill()
            process.wait(timeout=2)

    def current_lines() -> list[str]:
        try:
            return capture_file.read_text(encoding="utf-8", errors="replace").splitlines()
        except FileNotFoundError:
            return []

    def xdotool(*args: str) -> subprocess.CompletedProcess:
        return subprocess.run(
            ["xdotool", *args],
            env=env,
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )

    def flush_capture_line() -> None:
        # The first Return commits the typed line through the same X server
        # input stream. A second empty Return is a drain sentinel: any late key
        # events from the previous xdotool process would appear on that line.
        before = capture_file.stat().st_size if capture_file.exists() else 0
        for sentinel_index in range(2):
            result = xdotool("key", "--clearmodifiers", "Return")
            if result.returncode:
                raise RuntimeError(f"xdotool Return failed: {result.stderr.strip()}")
            deadline = time.monotonic() + 3
            while time.monotonic() < deadline:
                size = capture_file.stat().st_size if capture_file.exists() else 0
                if size > before:
                    before = size
                    break
                time.sleep(0.02)
            else:
                raise RuntimeError(
                    f"xterm/cat did not flush capture sentinel {sentinel_index + 1}"
                )

    def report_case(
        label: str,
        expected: str,
        start_line: int,
        start_record: int,
        start_timeout: int,
        started_at: float,
        cpu_before: int | None,
        require_hogs: bool = False,
    ) -> tuple[bool, str, int | None, float]:
        elapsed = time.monotonic() - started_at
        result_lines = current_lines()[start_line:]
        actual = result_lines[0] if result_lines else ""
        drained = len(result_lines) > 1 and result_lines[1] == ""
        case_records = records[start_record:]
        process_record = case_records[-1] if case_records else None
        process = process_record["process"] if process_record else None
        returncode = process.returncode if process is not None else None
        child_codes = [
            record["process"].returncode for record in case_records
        ]
        hogs_alive = sum(1 for hog in hogs if hog.poll() is None)
        timeout_value = timeout_values[start_timeout] if len(timeout_values) > start_timeout else None
        cpu_after = cpu_usage_usec()
        cpu_pct = None
        if cpu_before is not None and cpu_after is not None and elapsed > 0:
            cpu_pct = ((cpu_after - cpu_before) / 1_000_000) / elapsed * 100
        hogs_ok = not require_hogs or hogs_alive == 2
        ok = (
            actual == expected
            and drained
            and all(code == 0 for code in child_codes)
            and hogs_ok
        )
        print(
            f"CASE {label} status={'PASS' if ok else 'MISMATCH'} chars={len(expected)} "
            f"captured={len(actual)} children={len(child_codes)} child_rcs={child_codes} "
            f"rc={returncode} timeout={timeout_value} "
            f"drained={drained} hogs_alive={hogs_alive} elapsed={elapsed:.2f}s "
            f"cpu_one_core={cpu_pct:.1f}%"
            if cpu_pct is not None
            else f"CASE {label} status={'PASS' if ok else 'MISMATCH'} chars={len(expected)} "
            f"captured={len(actual)} children={len(child_codes)} child_rcs={child_codes} "
            f"rc={returncode} timeout={timeout_value} drained={drained} "
            f"hogs_alive={hogs_alive} elapsed={elapsed:.2f}s"
        )
        if not ok:
            diff_ops = [
                (tag, i1, i2, j1, j2)
                for tag, i1, i2, j1, j2 in SequenceMatcher(
                    None, expected, actual, autojunk=False
                ).get_opcodes()
                if tag != "equal"
            ]
            print(
                f"CASE_DETAIL {label} diff_ops={diff_ops[:12]!r} "
                f"expected={expected[:160]!r} actual={actual[:160]!r}"
            )
            print(
                f"CASE_CODEPOINTS {label} expected="
                + ",".join(f"{ord(char):04X}" for char in expected)
            )
            print(
                f"CASE_CODEPOINTS {label} actual="
                + ",".join(f"{ord(char):04X}" for char in actual)
            )
            if process_record and process_record.get("communicate_result"):
                _, stderr = process_record["communicate_result"]
                if stderr:
                    print(f"CASE_CHILD_STDERR {label}={stderr.decode('utf-8', errors='replace')[:300]!r}")
        return ok, actual, returncode, elapsed

    async def inject_case(
        label: str,
        text: str,
        outer_timeout: float = 40,
        segment_size: int = 0,
    ) -> tuple[int, int]:
        start_record = len(records)
        start_timeout = len(timeout_values)
        started_at = time.monotonic()

        async def send():
            if segment_size > 0:
                for offset in range(0, len(text), segment_size):
                    await on_message(client, "co,end," + text[offset : offset + segment_size])
            else:
                await on_message(client, "co,end," + text)

        try:
            await asyncio.wait_for(send(), timeout=outer_timeout)
        except asyncio.TimeoutError:
            print(f"CASE {label} HARNESS_TIMEOUT after {outer_timeout}s")
        elapsed = time.monotonic() - started_at
        case_records = records[start_record:]
        record = case_records[-1] if case_records else None
        process = record["process"] if record else None
        ret = process.returncode if process is not None else None
        inner = timeout_values[start_timeout] if len(timeout_values) > start_timeout else None
        print(
            f"INJECT {label} elapsed={elapsed:.2f}s children={len(case_records)} "
            f"rc={ret} inner_timeout={inner} segment_size={segment_size or 'whole'}"
        )
        return start_record, start_timeout

    try:
        server = subprocess.Popen(
            ["Xvfb", display, "-screen", "0", "1280x800x24", "-nolisten", "tcp", "-noreset"],
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        wait_for_x_server(display, env, server)
        terminal = subprocess.Popen(
            [
                "xterm", "-xrm", "*selectToClipboard: true",
                "-title",
                "IME Stress Capture",
                "-geometry",
                "120x50+0+0",
                "-e",
                "/bin/sh",
                "-c",
                f"cat > {capture_file}",
            ],
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        window_search = subprocess.run(
            ["xdotool", "search", "--sync", "--onlyvisible", "--name", "IME Stress Capture"],
            env=env,
            capture_output=True,
            text=True,
            timeout=8,
            check=False,
        )
        if window_search.returncode or not window_search.stdout.strip():
            raise RuntimeError(f"capture xterm window not found: {window_search.stderr.strip()}")
        window_id = window_search.stdout.splitlines()[-1].strip()
        focused = xdotool("windowfocus", "--sync", window_id)
        if focused.returncode:
            raise RuntimeError(f"cannot focus capture xterm: {focused.stderr.strip()}")

        if first_character:
            qt_modules = []
            for module_name in ("PyQt5", "PyQt6", "PySide6", "PySide2"):
                try:
                    if importlib.util.find_spec(module_name) is not None:
                        qt_modules.append(module_name)
                except (ImportError, ModuleNotFoundError, ValueError):
                    pass
            qt_apps = [
                command
                for command in ("qtdemo", "qtcreator", "kate", "kwrite")
                if shutil.which(command)
            ]
            print(
                f"QT_DEPENDENCY_PROBE python_modules={qt_modules} "
                f"existing_editors={qt_apps}"
            )

            def begin_case():
                return (
                    len(current_lines()),
                    len(records),
                    len(timeout_values),
                    time.monotonic(),
                    cpu_usage_usec(),
                )

            def finish_case(label: str, expected: str, started) -> bool:
                start_line, start_record, start_timeout, started_at, cpu_before = started
                flush_capture_line()
                ok, _, returncode, _ = report_case(
                    label,
                    expected,
                    start_line,
                    start_record,
                    start_timeout,
                    started_at,
                    cpu_before,
                )
                return ok and returncode in (0, None)

            case_results = []

            # This is the first X11 key event after the fresh X server gained focus.
            started = begin_case()
            await on_message(client, "co,end,你好")
            case_results.append(finish_case("fresh-focus-first-unicode", "你好", started))

            # Existing text must remain ahead of a newly committed Chinese word.
            started = begin_case()
            await on_message(client, "co,end,A")
            await on_message(client, "co,end,中文")
            case_results.append(finish_case("append-to-existing-text", "A中文", started))

            # These are injected server-side key states. They isolate the X11
            # key state around co,end; they do not claim that an active browser
            # IME normally forwards these candidate-confirmation keys.
            started = begin_case()
            space_down = xdotool("keydown", "space")
            await on_message(client, "co,end,中文")
            space_up = xdotool("keyup", "space")
            case_results.append(
                finish_case("space-held-across-commit", " 中文", started)
                and space_down.returncode == 0
                and space_up.returncode == 0
            )
            print(
                f"KEY_STATE_INJECTION space down_rc={space_down.returncode} "
                f"up_rc={space_up.returncode}"
            )

            started = begin_case()
            digit_down = xdotool("keydown", "2")
            await on_message(client, "co,end,中文")
            digit_up = xdotool("keyup", "2")
            case_results.append(
                finish_case("digit-held-across-commit", "2中文", started)
                and digit_down.returncode == 0
                and digit_up.returncode == 0
            )
            print(
                f"KEY_STATE_INJECTION digit2 down_rc={digit_down.returncode} "
                f"up_rc={digit_up.returncode}"
            )

            result = all(case_results)
            print(
                f"FIRST_CHARACTER_SUMMARY status={'PASS' if result else 'FAIL'} "
                f"cases={len(case_results)} x11=xvfb+xterm+real_on_message"
            )
            return 0 if result else 1

        if probe_key:
            for command in (("help",), ("help", "key"), ("help", "keydown"), ("help", "keyup")):
                result = xdotool(*command)
                help_text = (result.stdout + result.stderr).strip().replace("\n", " | ")
                print(
                    f"XDOTOOL_HELP command={' '.join(command)!r} rc={result.returncode} "
                    f"text={help_text[:1200]!r}"
                )

            for _ in range(2):
                hogs.append(
                    subprocess.Popen(
                        ["timeout", "90s", "yes"],
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL,
                        start_new_session=True,
                    )
                )
            await asyncio.sleep(0.25)

            probe_results = []
            for label in ("key-delay-200", "keydown-hold-100"):
                start_line = len(current_lines())
                started_at = time.monotonic()
                cpu_before = cpu_usage_usec()
                if label == "key-delay-200":
                    down = xdotool("key", "--clearmodifiers", "--delay", "200", "U4F60")
                    up = None
                else:
                    down = xdotool("keydown", "--clearmodifiers", "U4F60")
                    await asyncio.sleep(0.1)
                    up = xdotool("keyup", "U4F60")
                flush_capture_line()
                elapsed = time.monotonic() - started_at
                cpu_after = cpu_usage_usec()
                cpu_pct = None
                if cpu_before is not None and cpu_after is not None and elapsed > 0:
                    cpu_pct = ((cpu_after - cpu_before) / 1_000_000) / elapsed * 100
                lines = current_lines()[start_line:]
                actual = lines[0] if lines else ""
                drained = len(lines) > 1 and lines[1] == ""
                passed = (
                    down.returncode == 0
                    and (up is None or up.returncode == 0)
                    and actual == "你"
                    and drained
                    and sum(hog.poll() is None for hog in hogs) == 2
                )
                probe_results.append(passed)
                print(
                    f"KEY_PROBE {label} status={'PASS' if passed else 'MISMATCH'} "
                    f"chars={len(actual)} actual={actual!r} down_rc={down.returncode} "
                    f"up_rc={up.returncode if up else 'n/a'} drained={drained} "
                    f"hogs_alive={sum(hog.poll() is None for hog in hogs)} "
                    f"elapsed={elapsed:.2f}s"
                    + (f" cpu_one_core={cpu_pct:.1f}%" if cpu_pct is not None else "")
                )
            print(f"KEY_PROBE_SUMMARY status={'PASS' if all(probe_results) else 'FAIL'}")
            return 0 if all(probe_results) else 1

        idle_text = "A-中-𠮷-😀"
        start_record = len(records)
        start_timeout = len(timeout_values)
        started_at = time.monotonic()
        cpu_before = cpu_usage_usec()
        await inject_case("idle-unicode", idle_text)
        flush_capture_line()
        ok, _, _, _ = report_case(
            "idle-unicode",
            idle_text,
            0,
            start_record,
            start_timeout,
            started_at,
            cpu_before,
        )
        unicode_capture_ok = ok
        if not ok:
            print("LIMITATION unicode keysyms were not captured exactly by this Xvfb/xterm setup")
            failed = True

        stress_text = ("你a😀" * 41) + "𠮷e\u0301a😀"
        if len(stress_text) != 128:
            raise AssertionError(f"expected exactly 128 code points, got {len(stress_text)}")
        start_line = len(current_lines())
        start_record = len(records)
        start_timeout = len(timeout_values)
        started_at = time.monotonic()
        cpu_before = cpu_usage_usec()
        await inject_case("idle-unicode-128", stress_text)
        flush_capture_line()
        ok, _, returncode, _ = report_case(
            "idle-unicode-128",
            stress_text,
            start_line,
            start_record,
            start_timeout,
            started_at,
            cpu_before,
        )
        if not ok or returncode != 0:
            failed = True

        cpu_hog_seconds = 150
        for _ in range(2):
            hogs.append(
                subprocess.Popen(
                    ["timeout", f"{cpu_hog_seconds}s", "yes"],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    start_new_session=True,
                )
            )
        time.sleep(0.25)
        start_line = len(current_lines())
        start_record = len(records)
        start_timeout = len(timeout_values)
        started_at = time.monotonic()
        cpu_before = cpu_usage_usec()
        loaded_label = (
            f"cpu-loaded-128-segments-{segment_size}" if segment_size else "cpu-loaded-128"
        )
        await inject_case("cpu-loaded-128", stress_text, segment_size=segment_size)
        flush_capture_line()
        ok, _, returncode, _ = report_case(
            loaded_label,
            stress_text,
            start_line,
            start_record,
            start_timeout,
            started_at,
            cpu_before,
            require_hogs=True,
        )
        if not ok or returncode != 0:
            failed = True

        # Repeat a full Unicode commit, then a short Chinese word without an
        # intervening Return. The single output line verifies FIFO character
        # order across two sequential commits under the same CPU load.
        repeat_line = len(current_lines())
        repeat_record = len(records)
        repeat_timeout = len(timeout_values)
        repeat_started = time.monotonic()
        repeat_cpu = cpu_usage_usec()
        await inject_case("cpu-loaded-128-repeat", stress_text)
        await inject_case("cpu-loaded-short-word", "中文")
        flush_capture_line()
        repeat_ok, _, repeat_rc, _ = report_case(
            "cpu-loaded-128-then-short",
            stress_text + "中文",
            repeat_line,
            repeat_record,
            repeat_timeout,
            repeat_started,
            repeat_cpu,
            require_hogs=True,
        )
        if not repeat_ok or repeat_rc != 0:
            failed = True

        ascii_text = "a" * 128
        start_line = len(current_lines())
        start_record = len(records)
        start_timeout = len(timeout_values)
        started_at = time.monotonic()
        cpu_before = cpu_usage_usec()
        await inject_case("cpu-loaded-ascii-128", ascii_text)
        flush_capture_line()
        ok, _, returncode, _ = report_case(
            "cpu-loaded-ascii-128",
            ascii_text,
            start_line,
            start_record,
            start_timeout,
            started_at,
            cpu_before,
            require_hogs=True,
        )
        if not ok or returncode != 0:
            failed = True

        # This exceeds the current frontend's 128-codepoint chunk contract.
        # It exercises the server's 30-second compatibility cap only.
        compatibility_text = "a" * 3000
        start_line = len(current_lines())
        start_record = len(records)
        start_timeout = len(timeout_values)
        started_at = time.monotonic()
        cpu_before = cpu_usage_usec()
        partial_or_complete = ""
        if not quick:
            await inject_case("cpu-loaded-compat-3000", compatibility_text, outer_timeout=40)
            flush_capture_line()
            long_lines = current_lines()[start_line:]
            record = records[start_record] if len(records) > start_record else None
            long_process = record["process"] if record else None
            long_returncode = long_process.returncode if long_process else None
            long_timeout = timeout_values[start_timeout] if len(timeout_values) > start_timeout else None
            partial_or_complete = long_lines[0] if long_lines else ""
            drained_long = len(long_lines) > 1 and long_lines[1] == ""
            if long_returncode == -9:
                long_status = (
                    bool(partial_or_complete)
                    and len(partial_or_complete) < len(compatibility_text)
                    and drained_long
                )
            else:
                long_status = (
                    long_returncode == 0
                    and partial_or_complete == compatibility_text
                    and drained_long
                )
            long_elapsed = time.monotonic() - started_at
            long_cpu_after = cpu_usage_usec()
            long_cpu_pct = None
            if cpu_before is not None and long_cpu_after is not None and long_elapsed > 0:
                long_cpu_pct = ((long_cpu_after - cpu_before) / 1_000_000) / long_elapsed * 100
            print(
                f"CASE cpu-loaded-compat-3000 status={'PASS' if long_status else 'MISMATCH'} "
                f"chars={len(compatibility_text)} captured={len(partial_or_complete)} "
                f"rc={long_returncode} timeout={long_timeout} "
                f"drained={drained_long} elapsed={long_elapsed:.2f}s"
                + (f" cpu_one_core={long_cpu_pct:.1f}%" if long_cpu_pct is not None else "")
            )
            if not long_status:
                print(
                    f"CASE_DETAIL cpu-loaded-compat-3000 captured_prefix="
                    f"{partial_or_complete[:24]!r}"
                )
                failed = True

            # A later message must begin only after the timed-out/finished child is
            # reaped. Return first so the terminal commits the partial line.
            next_line_start = len(current_lines())
            next_record = len(records)
            next_timeout = len(timeout_values)
            next_started = time.monotonic()
            next_cpu = cpu_usage_usec()
            await inject_case("after-compat-3000", "NEXT")
            flush_capture_line()
            order_lines = current_lines()[next_line_start:]
            # The second line is the blank drain sentinel. If old key events
            # remained queued, they would appear there instead.
            order_ok = (
                len(order_lines) >= 2
                and order_lines[0] == "NEXT"
                and order_lines[1] == ""
            )
            next_ok, _, next_rc, _ = report_case(
                "after-compat-3000",
                "NEXT",
                next_line_start,
                next_record,
                next_timeout,
                next_started,
                next_cpu,
            )
            if not order_ok or not next_ok or next_rc != 0:
                print(f"CASE_DETAIL order_lines={order_lines[:3]!r}")
                failed = True
            else:
                print("ORDER_CHECK prefix-before-NEXT status=PASS")

        print(
            f"SUMMARY status={'FAIL' if failed else 'PASS'} "
            f"unicode_x11_capture={'PASS' if unicode_capture_ok else 'MISMATCH'} "
            "container_test_scope=real_on_message+real_subprocess+Xvfb+xterm"
        )
        return 1 if failed else 0
    finally:
        for hog in hogs:
            if hog.poll() is None:
                stop_process_group(hog)
        if terminal is not None and terminal.poll() is None:
            stop_process_group(terminal)
        if server is not None and server.poll() is None:
            stop_process_group(server)
        logger.removeHandler(collector)
        shutil.rmtree(temp_dir, ignore_errors=True)


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(errors="backslashreplace")
    parser = argparse.ArgumentParser()
    parser.add_argument("--image", default="wechat-selkies:1.73")
    parser.add_argument("--inside", action="store_true")
    parser.add_argument("--quick", action="store_true", help="skip the 30-second compatibility payload")
    parser.add_argument("--segment-size", type=int, default=0, help="diagnostic: send a commit as serial substrings")
    parser.add_argument("--probe-key", action="store_true", help="probe existing xdotool Unicode key timing in Xvfb")
    parser.add_argument("--first-character", action="store_true", help="probe fresh-focus and held-key commit boundaries")
    parser.add_argument("--source", type=Path, default=Path(CONTAINER_SOURCE))
    args = parser.parse_args()
    if args.inside:
        return asyncio.run(
            inside_main(
                args.source,
                quick=args.quick,
                segment_size=args.segment_size,
                probe_key=args.probe_key,
                first_character=args.first_character,
            )
        )
    return host_main(
        args.image,
        quick=args.quick,
        segment_size=args.segment_size,
        probe_key=args.probe_key,
        first_character=args.first_character,
    )


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit(130)
    except Exception as error:
        print(f"ERROR {type(error).__name__}: {error}", file=sys.stderr)
        raise SystemExit(1)

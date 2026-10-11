#!/usr/bin/env python3
"""WeChat abnormal-logout monitor.

Detects when the WeChat Linux client process disappears while auto-start is
enabled and records only the important process-lifecycle events. It cannot
observe account logout while the client process remains alive.

    LOGOUT       process disappeared (auto-restart expected from watchdog)
    STILL_DOWN   periodic reminder while the client stays offline
    RECOVERED    process came back, with total downtime
    CRASH_LOOP   repeated logout/recovery cycles inside a short window
    MONITOR_*    monitor lifecycle markers

Rolling policy (defaults, all overridable via env):
    * entries older than WECHAT_LOGOUT_LOG_KEEP_DAYS (3) days are dropped
    * the file never exceeds WECHAT_LOGOUT_LOG_MAX_BYTES (512 KiB); when it
      would, the oldest entries are dropped first

The monitor only observes and logs; recovery/restart stays with
process-watchdog.sh.
"""

import os
import pathlib
import signal
import sys
import time
from datetime import datetime, timedelta

DEFAULT_LOG_PATH = "/config/logs/wechat-logout.log"
FALLBACK_LOG_DIR = "/tmp"
DEFAULT_MAX_BYTES = 512 * 1024
MIN_MAX_BYTES = 64 * 1024
DEFAULT_KEEP_DAYS = 3
DEFAULT_INTERVAL = 20
DEFAULT_REMINDER_SECONDS = 1800
DEFAULT_CRASH_LOOP_CYCLES = 3
DEFAULT_CRASH_LOOP_WINDOW_SECONDS = 600
DEFAULT_STARTUP_GRACE_SECONDS = 90
WECHAT_PROC = "/usr/bin/wechat"
SOURCE_TAG = "[wechat-logout]"


def is_true(raw):
    return str(raw or "").strip().lower() in {"true", "1", "yes", "on"}


def env_int(name, default, minimum, maximum):
    raw = str(os.getenv(name, "") or "").strip()
    try:
        value = int(raw)
    except Exception:
        return default
    if value < minimum or value > maximum:
        return default
    return value


def local_now():
    return datetime.now().astimezone()


def iso(ts):
    return ts.isoformat(timespec="seconds")


def parse_line_ts(line):
    try:
        return datetime.fromisoformat(line[:25])
    except Exception:
        return None


def wechat_pids():
    """Return actual WeChat pids, excluding wrappers, probes and zombies."""
    pids = []
    executables = {WECHAT_PROC, os.path.realpath(WECHAT_PROC)}
    try:
        entries = os.listdir("/proc")
    except OSError:
        return pids
    for entry in entries:
        if not entry.isdigit():
            continue
        try:
            with open(f"/proc/{entry}/cmdline", "rb") as stream:
                executable = stream.read().split(b"\x00", 1)[0].decode("utf-8", "replace")
            with open(f"/proc/{entry}/stat", "rb") as stream:
                stat = stream.read().decode("utf-8", "replace")
        except OSError:
            continue
        if executable not in executables:
            continue
        # stat format: pid (comm) state ...; zombies count as gone.
        try:
            state = stat.rsplit(")", 1)[1].split()[0]
        except Exception:
            state = ""
        if state == "Z":
            continue
        pids.append(int(entry))
    return sorted(pids)


class RollingEventLog:
    """Append-only log with time and size based retention."""

    def __init__(self, path, max_bytes, keep_days):
        self.path = pathlib.Path(path)
        self.max_bytes = max_bytes
        self.keep_days = keep_days
        self.last_write_failed = False

    def _target_path(self):
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            if os.access(self.path.parent, os.W_OK):
                return self.path
        except OSError:
            pass
        return pathlib.Path(FALLBACK_LOG_DIR) / self.path.name

    def append(self, line):
        target = self._target_path()
        try:
            lines = []
            if target.exists():
                lines = [
                    item
                    for item in target.read_text(encoding="utf-8", errors="replace").splitlines()
                    if item.strip()
                ]
            candidate = line.strip()
            if candidate:
                lines.append(candidate)

            if self.keep_days > 0:
                cutoff = local_now() - timedelta(days=self.keep_days)
                lines = [item for item in lines if (parse_line_ts(item) or local_now()) >= cutoff]

            data = ("\n".join(lines) + "\n").encode("utf-8") if lines else b""
            while len(data) > self.max_bytes and lines:
                lines = lines[1:]
                data = ("\n".join(lines) + "\n").encode("utf-8")

            tmp = target.with_name(target.name + ".tmp")
            with open(tmp, "wb") as stream:
                stream.write(data)
            os.replace(tmp, target)
            self.last_write_failed = False
        except OSError:
            if not self.last_write_failed:
                self.last_write_failed = True
                sys.stderr.write(f"{iso(local_now())} {SOURCE_TAG} LOG_WRITE_FAILED path={target}\n")
                sys.stderr.flush()


class Monitor:
    def __init__(self):
        self.interval = env_int("WECHAT_LOGOUT_MONITOR_INTERVAL", DEFAULT_INTERVAL, 5, 300)
        self.reminder_seconds = env_int("WECHAT_LOGOUT_REMINDER_SECONDS", DEFAULT_REMINDER_SECONDS, 60, 86400)
        self.crash_loop_cycles = env_int("WECHAT_LOGOUT_CRASH_LOOP_CYCLES", DEFAULT_CRASH_LOOP_CYCLES, 2, 50)
        self.crash_loop_window = env_int("WECHAT_LOGOUT_CRASH_LOOP_WINDOW_SECONDS", DEFAULT_CRASH_LOOP_WINDOW_SECONDS, 60, 604800)
        self.startup_grace = env_int("WECHAT_LOGOUT_STARTUP_GRACE_SECONDS", DEFAULT_STARTUP_GRACE_SECONDS, 0, 600)
        self.log = RollingEventLog(
            os.getenv("WECHAT_LOGOUT_LOG_PATH", DEFAULT_LOG_PATH),
            env_int("WECHAT_LOGOUT_LOG_MAX_BYTES", DEFAULT_MAX_BYTES, MIN_MAX_BYTES, 16 * 1024 * 1024),
            env_int("WECHAT_LOGOUT_LOG_KEEP_DAYS", DEFAULT_KEEP_DAYS, 1, 30),
        )
        self.auto_restart = is_true(os.getenv("WATCHDOG_RESTART_WECHAT", "true"))
        self.running = True
        self.pids = wechat_pids()
        self.was_up = bool(self.pids)
        self.started_at = local_now()
        self.grace_deadline = self.started_at + timedelta(seconds=self.startup_grace)
        self.down_since = None
        self.last_pids = ",".join(str(pid) for pid in self.pids)
        self.last_reminder_at = None
        self.last_crash_loop_at = None
        self.logout_times = []

    def emit(self, event, **details):
        parts = [f"{iso(local_now())} {SOURCE_TAG} {event}"]
        parts.extend(f"{key}={value}" for key, value in details.items())
        return self.log.append(" ".join(parts))

    def note_logout(self, pids):
        now = local_now()
        self.logout_times.append(now)
        window_start = now - timedelta(seconds=self.crash_loop_window)
        self.logout_times = [item for item in self.logout_times if item >= window_start]
        self.emit(
            "LOGOUT",
            process=WECHAT_PROC,
            last_pids=pids or "none",
            auto_restart="true" if self.auto_restart else "false",
            cycles_in_window=len(self.logout_times),
        )
        if (
            len(self.logout_times) >= self.crash_loop_cycles
            and (self.last_crash_loop_at is None or (now - self.last_crash_loop_at).total_seconds() >= self.crash_loop_window)
        ):
            self.last_crash_loop_at = now
            self.emit(
                "CRASH_LOOP",
                cycles=len(self.logout_times),
                window_s=self.crash_loop_window,
                auto_restart="true" if self.auto_restart else "false",
            )

    def stop(self, *_args):
        self.running = False

    def run_once(self):
        now = local_now()
        pids = wechat_pids()
        if pids:
            self.was_up = True
            if self.down_since is not None:
                downtime = int((now - self.down_since).total_seconds())
                self.emit(
                    "RECOVERED",
                    downtime_s=downtime,
                    pids=",".join(str(pid) for pid in pids),
                    restart="watchdog-auto" if self.auto_restart else "manual-or-external",
                )
                self.down_since = None
                self.last_reminder_at = None
            self.last_pids = ",".join(str(pid) for pid in pids)
            return

        if not self.was_up:
            # WeChat never came up in this monitor lifetime; the startup grace
            # window keeps container boot races out of the log.
            if now < self.grace_deadline:
                return
            self.was_up = True
            self.down_since = self.started_at
            self.last_reminder_at = now
            self.note_logout("never-seen")
            return

        if self.down_since is None:
            self.down_since = now
            self.note_logout(self.last_pids)
            self.last_reminder_at = now
            return

        if self.last_reminder_at is None or (now - self.last_reminder_at).total_seconds() >= self.reminder_seconds:
            self.last_reminder_at = now
            self.emit(
                "STILL_DOWN",
                down_for_s=int((now - self.down_since).total_seconds()),
                auto_restart="true" if self.auto_restart else "false",
            )

    def run(self):
        self.emit("MONITOR_STARTED", interval=self.interval, auto_restart="true" if self.auto_restart else "false",
                  observes="process", account_login_state="unknown")
        while self.running:
            deadline = time.monotonic() + self.interval
            try:
                self.run_once()
            except Exception as exc:  # keep the daemon alive no matter what
                self.emit("MONITOR_ERROR", error=repr(exc))
            while self.running:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                time.sleep(min(remaining, 1.0))
        self.emit("MONITOR_STOPPED")


def main():
    if not is_true(os.getenv("AUTO_START_WECHAT", "true")):
        sys.stderr.write(f"{iso(local_now())} {SOURCE_TAG} auto-start disabled, monitor idle\n")
        return 0
    monitor = Monitor()
    signal.signal(signal.SIGTERM, monitor.stop)
    signal.signal(signal.SIGINT, monitor.stop)
    monitor.run()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

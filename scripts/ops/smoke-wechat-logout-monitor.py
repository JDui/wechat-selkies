"""Functional smoke test for the WeChat logout monitor state machine.

Patches wechat_pids() to simulate: up -> down (LOGOUT) -> still down (STILL_DOWN)
-> up again (RECOVERED), and repeated up/down cycling (CRASH_LOOP).
"""

import importlib.util
import pathlib
import time

spec = importlib.util.spec_from_file_location("m", "root/scripts/wechat-logout-monitor.py")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

sequence = [[111], [], [], [222], [], [333], [], []]
step = {"i": 0}


def fake_pids():
    value = sequence[min(step["i"], len(sequence) - 1)]
    step["i"] += 1
    return value


m.wechat_pids = fake_pids

mon = m.Monitor()
mon.interval = 5
mon.reminder_seconds = 0  # allow STILL_DOWN every poll for the test
mon.crash_loop_cycles = 3
mon.crash_loop_window = 600
mon.startup_grace = 0
mon.auto_restart = True
mon.log = m.RollingEventLog(pathlib.Path("func.log"), 512 * 1024, 3)
mon.started_at = m.local_now()
mon.grace_deadline = mon.started_at
mon.pids = sequence[0]
mon.was_up = bool(mon.pids)
mon.last_pids = "111"

for expected in sequence:
    mon.run_once()

content = pathlib.Path("func.log").read_text(encoding="utf-8")
pathlib.Path("func.log").unlink()
print(content)
events = [line.split("] ")[1].split()[0] for line in content.splitlines() if "]" in line]
print("events:", " ".join(events))
assert events.count("LOGOUT") == 3, events
assert events.count("RECOVERED") == 2, events
assert "STILL_DOWN" in events
assert "CRASH_LOOP" in events
print("SMOKE OK")

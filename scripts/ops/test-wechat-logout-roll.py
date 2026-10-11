import datetime
import importlib.util
import pathlib
import sys

spec = importlib.util.spec_from_file_location("m", "root/scripts/wechat-logout-monitor.py")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

# 1) entries older than keep_days are dropped on append
log = m.RollingEventLog(pathlib.Path("logs-a.log"), 512 * 1024, 3)
old = m.local_now() - datetime.timedelta(days=4)
log.append(m.iso(old) + " [wechat-logout] LOGOUT process=/usr/bin/wechat last_pids=1")
log.append(m.iso(m.local_now()) + " [wechat-logout] LOGOUT process=/usr/bin/wechat last_pids=2")
text_a = log.path.read_text(encoding="utf-8")
print("A-lines:", text_a.count("\n"), "old-dropped:", "last_pids=1" not in text_a)

# 2) size cap: file never exceeds max_bytes, oldest lines dropped first
small = m.RollingEventLog(pathlib.Path("logs-b.log"), 2048, 3)
for i in range(200):
    small.append(m.iso(m.local_now()) + " [wechat-logout] LOGOUT process=/usr/bin/wechat seq=%d" % i)
size = small.path.stat().st_size
lines = small.path.read_text(encoding="utf-8").splitlines()
print("B-size:", size, "<=2048:", size <= 2048, "B-lines:", len(lines), "B-first-seq:", lines[0].rsplit("=", 1)[-1], "B-last-seq:", lines[-1].rsplit("=", 1)[-1])

# 3) parser round-trip
parsed = m.parse_line_ts("2026-09-29T21:00:00+08:00 [wechat-logout] LOGOUT")
print("C-parse:", parsed == datetime.datetime(2026, 9, 29, 21, 0, 0, tzinfo=m.local_now().tzinfo))

# 4) env clamps
print("D-clamp:", m.env_int("NOPE", 20, 5, 300) == 20, m.env_int("NOPE", 20, 5, 300) == 20)

log.path.unlink()
small.path.unlink()
print("OK")

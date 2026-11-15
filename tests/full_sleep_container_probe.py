"""Host-side probe; never run the driver inside a container it will freeze.

Only for a disposable container named wechat-sleep-*-check with apps disabled.
Port 13080 must be bound to host loopback, PIN is the test-only 246810.
"""
import json
import subprocess
import time
import urllib.error
import urllib.request

CONTAINER = "wechat-sleep-180-check"
HTTP = "http://127.0.0.1:13080"
MANAGER = HTTP + "/api/container-sleep"
COOKIE = ""


def request(url, body=None, headers=None):
    global COOKIE
    headers = dict(headers or {})
    if COOKIE and "/api/" in url:
        headers["Cookie"] = COOKIE
    req = urllib.request.Request(url, data=body, headers=headers)
    with urllib.request.urlopen(req, timeout=8) as response:
        if response.headers.get("Set-Cookie"):
            COOKIE = response.headers["Set-Cookie"].split(";", 1)[0]
        return response.read(), response.headers


def execute(*args):
    return subprocess.check_output(["docker", "exec", CONTAINER, *args], timeout=12).decode()


SNAPSHOT = '''import json,pathlib
p=pathlib.Path('/run/selkies-container-sleep.json')
s=json.loads(p.read_text())
frozen=[]
for pid in s.get('frozen_pids',[]):
    try:
        fields=pathlib.Path(f'/proc/{pid}/status').read_text().splitlines()
        info={k:v.strip() for k,v in (line.split(':',1) for line in fields if ':' in line)}
        frozen.append({'pid':pid,'name':info['Name'],'state':info['State'].split()[0]})
    except FileNotFoundError: pass
cpu=dict(line.split() for line in pathlib.Path('/sys/fs/cgroup/cpu.stat').read_text().splitlines())
print(json.dumps({'state':s,'processes':frozen,'cpu_usec':int(cpu['usage_usec'])}))
'''


def main():
    execute("python3", "-c", "from pathlib import Path; import json; Path('/config/state/notification-bridge.json').write_text(json.dumps({'adaptive_sleep_enabled':True,'adaptive_sleep_idle_seconds':2700,'adaptive_sleep_idle_seconds_user_set':True}))")
    execute("/scripts/healthcheck.sh")
    request(HTTP + "/auth/pin", b"", {"X-PIN": "246810"})
    try:
        result = json.loads(request(MANAGER + "/sleep", b"{}")[0])
        assert result["ok"]
        first = json.loads(execute("python3", "-c", SNAPSHOT))
        assert first["state"]["mode"] == "full"
        assert len(first["processes"]) > 10
        assert all(p["state"] == "T" for p in first["processes"]), first
        names = {p["name"] for p in first["processes"]}
        assert "Xvfb" in names and "selkies" in names, names
        page, _ = request(HTTP + "/")
        assert b"PIN" in page, "login page unavailable during sleep"
        execute("/scripts/healthcheck.sh")
        try:
            request(HTTP + "/auth/pin", b"", {"X-PIN": "wrong-test-pin"})
            raise AssertionError("incorrect PIN accepted")
        except urllib.error.HTTPError as error:
            assert error.code == 401
        assert json.loads(request(MANAGER + "/status")[0])["sleeping"]
        # Measure only the steady waiting period, excluding login/health checks.
        first_cpu = json.loads(execute("python3", "-c", SNAPSHOT))["cpu_usec"]
        start = time.monotonic()
        time.sleep(3)
        last = json.loads(execute("python3", "-c", SNAPSHOT))
        cpu_percent = (last["cpu_usec"] - first_cpu) / ((time.monotonic()-start)*1e6) * 100
        result, headers = request(HTTP + "/auth/pin", b"", {"X-PIN": "246810"})
        assert json.loads(result)["ok"] and headers.get("Set-Cookie")
        awake = json.loads(request(MANAGER + "/status")[0])
        assert not awake["sleeping"]
        assert awake["resumed_count"] == len(first["processes"])
        execute("/scripts/healthcheck.sh")
        print(json.dumps(dict(result="PASS", frozen=len(first["processes"]),
                              login_available=True, wrong_pin_keeps_asleep=True,
                              correct_pin_resumes=awake["resumed_count"],
                              sleep_cpu_one_core_percent=round(cpu_percent, 2))))
    finally:
        request(HTTP + "/auth/pin", b"", {"X-PIN": "246810"})


if __name__ == "__main__":
    main()

"""P1 targeted checks. Native test requires Xvfb, Thunar, xdotool and Xlib.

Run in an isolated Linux environment, never an active user's DISPLAY:
  /lsiopy/bin/python3 /workspace/tests/test_xdnd_download_probe.py
"""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest

PRODUCTION = os.environ.get("AXI_PRODUCTION_XDND") == "1"

PROBE = Path(__file__).resolve().parents[1] / "scripts/ops/xdnd-download-probe.py"
spec = importlib.util.spec_from_file_location("probe", PROBE)
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class ValidationTests(unittest.TestCase):
    def test_geometry(self):
        self.assertEqual(probe.map_rect((450, 375, 200, 50), (100, 50, 800, 400),
                                       (1600, 800)), (700, 650, 400, 100))
        self.assertEqual(probe.map_rect((50, 25, 200, 100), (100, 50, 800, 400),
                                       (800, 400)), (0, 0, 150, 75))
        self.assertIsNone(probe.map_rect((0, 0, 50, 20), (100, 50, 800, 400), (800, 400)))

    @unittest.skipUnless(os.name == "posix", "container local URI semantics")
    def test_uri_validation(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "测试 file.txt"
            path.write_bytes(b"source stays unchanged")
            self.assertEqual(probe.local_files(("# comment\r\n" + path.as_uri()).encode()),
                             [(str(path), 22)])
            alias = Path(folder) / "alias"
            alias.symlink_to(path)
            for payload in [b"https://example.com/a", b"file://remote/tmp/a", b"file:///tmp/../etc/passwd",
                            Path(folder).as_uri().encode(), alias.as_uri().encode(), b"file:///tmp/%00", b"#empty"]:
                with self.subTest(payload=payload), self.assertRaises((ValueError, OSError)):
                    probe.local_files(payload)


@unittest.skipUnless(os.environ.get("AXI_NATIVE_XDND_TEST") == "1", "explicit isolated native test opt-in")
class NativeTests(unittest.TestCase):
    def test_real_thunar_drag(self):
        from Xlib import display
        with tempfile.TemporaryDirectory() as folder:
            source_folder = Path(folder) / "files"
            source_folder.mkdir()
            path = source_folder / "probe.txt"
            path.write_bytes(b"XDND probe file\n")
            env = dict(os.environ, DISPLAY=":98")
            children = []
            output = Path(folder) / "events.jsonl"
            with output.open("w+") as log, open(os.devnull, "w") as quiet:
                def start(args, stdout=quiet):
                    process = subprocess.Popen(args, env=env, stdout=stdout, stderr=quiet)
                    children.append(process)
                    return process

                def mouse(*args):
                    subprocess.run(["xdotool", *args], env=env, check=True, timeout=5)

                def events():
                    log.flush()
                    return [json.loads(line) for line in output.read_text().splitlines() if line]

                def wait_for(predicate):
                    until = time.monotonic() + 5
                    while time.monotonic() < until:
                        if predicate():
                            return
                        time.sleep(.05)
                    self.fail("native probe timed out: " + str(events()))

                try:
                    start(["Xvfb", ":98", "-screen", "0", "1280x800x24", "-ac"])
                    time.sleep(.3)
                    # Thunar's single-instance D-Bus behavior must be isolated
                    # from other file managers in the test container.
                    start(["dbus-run-session", "--", "thunar", str(source_folder)])
                    time.sleep(.8)
                    ids = subprocess.check_output(["xdotool", "search", "--onlyvisible", "--class", "Thunar"], env=env).decode().split()
                    mouse("windowmove", ids[-1], "0", "0", "windowsize", ids[-1], "800", "500")
                    if PRODUCTION:
                        env.update(SELKIES_DROP_CACHE=str(Path(folder) / "cache"),
                                   SELKIES_DROP_SOURCE_ROOTS=str(source_folder), SELKIES_DROP_MIN_FREE_BYTES="0")
                        runner = '''import sys, time, threading, json
sys.path.insert(0, "/workspace/root/scripts")
from container_download import Downloads
from xdnd_receiver import run
manager = Downloads(lambda: ("test", 1))
original_event = manager.event
def event(phase, **fields):
    original_event(phase, **fields)
    print(json.dumps(dict(phase=phase, **fields)), flush=True)
manager.event = event
def lease():
    while True:
        manager.configure(("test", 1), "a"*32, [850,550,350,200])
        time.sleep(.5)
threading.Thread(target=lease, daemon=True).start()
run(manager)
'''
                        receiver = start(["/lsiopy/bin/python3", "-u", "-c", runner], log)
                    else:
                        receiver = start([os.environ.get("PYTHON", "/lsiopy/bin/python3"), str(PROBE),
                                          "--rect", "850", "550", "350", "200"], log)
                    wait_for(lambda: any(e["phase"] == "ready" for e in events()))
                    connection = display.Display(":98")
                    target = events()[0]["window"]
                    mouse("mousemove", "950", "650")
                    self.assertNotEqual(getattr(connection.screen().root.query_pointer().child, "id", 0), target,
                                        "Idle InputOnly window must not intercept ordinary clicks")
                    # File icon in Thunar icon view; the new directory contains
                    # only probe.txt at launch. Default is a zero-dwell stress
                    # case. Set AXI_XDND_DROP_DWELL=.15 for the handshake control.
                    dwell = os.environ.get("AXI_XDND_DROP_DWELL", "0")
                    mouse("mousemove", "210", "150", "mousedown", "1", "sleep", ".2",
                          "mousemove", "250", "190", "sleep", ".3")
                    if PRODUCTION:
                        # Execute the exact shipped mouse method, with real
                        # XTest transport. Final Motion+Release is one call.
                        driver = '''import ast, asyncio, pathlib, types
import Xlib
from Xlib import X, display
from Xlib.ext import xtest
path = pathlib.Path("/workspace/root/lsiopy/lib/python3.12/site-packages/selkies/input_handler.py")
tree = ast.parse(path.read_text())
method = next(n for c in tree.body if isinstance(c, ast.ClassDef) and c.name == "WebRTCInput" for n in c.body if getattr(n,"name","") == "send_x11_mouse")
scope = dict(asyncio=asyncio, Xlib=Xlib)
for node in tree.body:
    if isinstance(node, ast.Assign) and len(node.targets)==1 and isinstance(node.targets[0],ast.Name) and node.targets[0].id.startswith("MOUSE_"):
        try: scope[node.targets[0].id]=ast.literal_eval(node.value)
        except ValueError: pass
exec(compile(ast.Module(body=[method],type_ignores=[]),str(path),"exec"),scope)
d=display.Display()
def send(action,data):
    if action==scope["MOUSE_POSITION"]: xtest.fake_input(d,X.MotionNotify,x=data[0],y=data[1])
    elif action==scope["MOUSE_BUTTON"]: xtest.fake_input(d,X.ButtonRelease,detail=1)
    d.sync()
obj=types.SimpleNamespace(xdisplay=d,wayland_input=None,data_server_instance=None,last_x=250,last_y=190,button_mask=1,send_mouse=send)
asyncio.run(scope["send_x11_mouse"](obj,900,600,0,0))
'''
                        subprocess.run(["/lsiopy/bin/python3", "-c", driver], env=env, check=True, timeout=5)
                    else:
                        mouse("mousemove", "900", "600", "sleep", dwell, "mouseup", "1")
                    wait_for(lambda: any(e["phase"] == "received" for e in events()))
                    if not PRODUCTION:
                        self.assertTrue(any(e.get("sizes") == [16] for e in events()))
                    else:
                        wait_for(lambda: len(list((Path(folder) / "cache").glob("*.data"))) == 1)
                        self.assertEqual(next((Path(folder) / "cache").glob("*.data")).read_bytes(), b"XDND probe file\n")
                    self.assertEqual(path.read_bytes(), b"XDND probe file\n")
                    before = sum(e["phase"] == "received" for e in events())
                    mouse("mousemove", "210", "150", "mousedown", "1", "sleep", ".2",
                          "mousemove", "250", "190", "sleep", ".2", "mousemove", "900", "600",
                          "sleep", ".2", "mousemove", "950", "650", "sleep", ".2",
                          "mousemove", "700", "400", "sleep", ".2", "key", "Escape", "mouseup", "1")
                    wait_for(lambda: any(e["phase"] in ("leave", "cancelled") for e in events()))
                    self.assertEqual(sum(e["phase"] == "received" for e in events()), before)
                    self.assertIsNone(receiver.poll())
                    connection.close()
                    print("Native evidence:", json.dumps(events()))
                finally:
                    for process in reversed(children):
                        process.terminate()
                    for process in reversed(children):
                        try:
                            process.wait(timeout=3)
                        except subprocess.TimeoutExpired:
                            process.kill()
                            process.wait()


if __name__ == "__main__":
    unittest.main()

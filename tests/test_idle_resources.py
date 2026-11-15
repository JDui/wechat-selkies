"""Focused lifecycle checks; native X11 probe runs in an isolated container."""
import ast
import asyncio
import json
import logging
import os
import pathlib
import sys
import tempfile
import threading
import time
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "root/scripts"))
from x11_window_reader import WindowReader


def sleep_server():
    path = ROOT / "root/lsiopy/lib/python3.12/site-packages/selkies/selkies.py"
    cls = next(n for n in ast.parse(path.read_text(encoding="utf-8-sig")).body
               if isinstance(n, ast.ClassDef) and n.name == "DataStreamingServer")
    names = {"_adaptive_sleep_step", "_enter_adaptive_sleep", "_leave_adaptive_sleep",
             "_has_sleepable_pipeline_state", "_stream_sleep_requested",
             "_start_capture_for_display", "_start_pcmflux_pipeline"}
    cls.body = [n for n in cls.body if getattr(n, "name", "") in names]
    scope = dict(asyncio=asyncio, json=json, pathlib=pathlib, time=SimpleNamespace(monotonic=time.monotonic),
                 data_logger=logging.getLogger("idle-test"), PCMFLUX_AVAILABLE=True,
                 websockets=SimpleNamespace(broadcast=Mock()))
    exec(compile(ast.Module(body=[cls], type_ignores=[]), str(path), "exec"), scope)
    server = scope[cls.name]()
    server.clock = scope["time"]
    server._adaptive_sleep_enabled = Mock(return_value=True)
    server._awake_client_count = Mock(return_value=0)
    server._stream_sleep_requested = Mock(return_value=False)
    server.hidden_stream_idle_seconds = 60
    server.adaptive_sleep_idle_seconds = 2700
    server._adaptive_sleep_no_awake_since = 0
    server._adaptive_sleeping = False
    server._reconfigure_lock = asyncio.Lock()
    server.display_clients = {"primary": {"video_active": True}}
    server.capture_instances = {"primary": {}}
    server.clients = {object()}
    server.is_pcmflux_capturing = True
    server._stop_capture_for_display = AsyncMock(side_effect=lambda key: server.capture_instances.pop(key, None))
    server._stop_pcmflux_pipeline = AsyncMock()
    server._release_idle_capture_memory = Mock()
    server.reconfigure_displays = AsyncMock()
    return server


class IdlePipelineTests(unittest.IsolatedAsyncioTestCase):
    async def test_hidden_capture_stops_after_grace_and_visible_resumes(self):
        server = sleep_server()
        with patch.object(server.clock, "monotonic", return_value=100):
            await server._adaptive_sleep_step()
        with patch.object(server.clock, "monotonic", return_value=159):
            await server._adaptive_sleep_step()
            self.assertFalse(server._adaptive_sleeping)
        with patch.object(server.clock, "monotonic", return_value=160):
            await server._adaptive_sleep_step()
        self.assertTrue(server._adaptive_sleeping)
        self.assertFalse(server.capture_instances)
        server._stop_pcmflux_pipeline.assert_awaited_once()
        server._release_idle_capture_memory.assert_called_once()
        server._start_pcmflux_pipeline = AsyncMock()
        server._awake_client_count.return_value = 1
        await server._adaptive_sleep_step()
        self.assertFalse(server._adaptive_sleeping)
        self.assertTrue(server.display_clients["primary"]["video_active"])
        server.reconfigure_displays.assert_awaited_once()
        server._start_pcmflux_pipeline.assert_awaited_once()

    async def test_visible_page_is_not_treated_as_idle(self):
        server = sleep_server()
        server._awake_client_count.return_value = 1
        server._adaptive_sleep_no_awake_since = 1
        await server._adaptive_sleep_step()
        server._stop_capture_for_display.assert_not_awaited()

    async def test_recovery_cannot_restart_capture_while_sleeping(self):
        server = sleep_server()
        server._stream_sleep_requested.return_value = True
        server._awake_client_count.return_value = 1
        await server._adaptive_sleep_step()
        self.assertTrue(server._adaptive_sleeping)
        await server._start_capture_for_display("primary", 1280, 720, 0, 0)
        self.assertFalse(await server._start_pcmflux_pipeline())
        self.assertFalse(server.capture_instances)


class WindowSnapshotTests(unittest.TestCase):
    @unittest.skipUnless(os.environ.get("AXI_IDLE_NATIVE") == "1", "isolated Xvfb only")
    def test_drag_selection_event_wakes_low_rate_idle_receiver(self):
        from Xlib import X, display
        from Xlib.ext import xtest
        from Xlib.xobject.drawable import Window
        import xdnd_receiver
        ready, armed, stopped = threading.Event(), threading.Event(), threading.Event()
        errors, queries = [], []

        class Finished(Exception):
            pass

        class Manager:
            def geometry(self):
                if stopped.is_set():
                    raise Finished()
                return [800, 500, 200, 150]

            def event(self, phase, **fields):
                if phase == "ready":
                    ready.set()
                if phase == "armed":
                    armed.set()

        def receive():
            try:
                xdnd_receiver.run(Manager())
            except Finished:
                pass
            except Exception as error:
                errors.append(repr(error))

        query = Window.query_pointer
        def counted_query(window, *args, **kwargs):
            queries.append(time.monotonic())
            return query(window, *args, **kwargs)

        conn = display.Display()
        window = conn.screen().root.create_window(10, 10, 100, 100, 0, X.CopyFromParent)
        worker = threading.Thread(target=receive, daemon=True)
        try:
            with patch.object(Window, "query_pointer", counted_query):
                worker.start()
                self.assertTrue(ready.wait(2), errors)
                baseline = len(queries)
                time.sleep(.65)
                idle_queries = len(queries) - baseline
                self.assertLessEqual(idle_queries, 3, "idle receiver still polls at 50 Hz")
                start = time.monotonic()
                xtest.fake_input(conn, X.ButtonPress, 1)
                window.set_selection_owner(conn.intern_atom("XdndSelection"), X.CurrentTime)
                conn.sync()
                self.assertTrue(armed.wait(.3), errors)
                print(json.dumps({"idle_pointer_queries_650ms": idle_queries,
                                  "selection_to_arm_ms": round((time.monotonic()-start)*1000, 2)}))
        finally:
            xtest.fake_input(conn, X.ButtonRelease, 1)
            window.destroy()
            conn.sync()
            stopped.set()
            worker.join(2)
            conn.close()
        self.assertFalse(worker.is_alive())
        self.assertFalse(errors, errors)

    def test_snapshot_reuses_connection_work_and_recovers_after_failure(self):
        reader = WindowReader()
        expected = {"active": None, "windows": []}
        reader._read = Mock(side_effect=[expected, OSError("X restarted"), expected])
        with patch.object(time, "monotonic", return_value=100):
            self.assertEqual(reader.snapshot(), expected)
            self.assertEqual(reader.snapshot(), expected)
        self.assertEqual(reader._read.call_count, 1)
        with patch.object(time, "monotonic", return_value=101):
            self.assertIsNone(reader.snapshot())
            self.assertIsNone(reader.snapshot())
        with patch.object(time, "monotonic", return_value=104):
            self.assertEqual(reader.snapshot(), expected)

    @unittest.skipUnless(os.environ.get("AXI_IDLE_NATIVE") == "1", "isolated Xvfb only")
    def test_real_x11_title_attention_focus_and_no_subprocesses(self):
        from Xlib import X, Xatom, display
        import notification_bridge as bridge
        conn = display.Display()
        root = conn.screen().root
        windows = []
        try:
            for name in ("WeChat", "QQ"):
                window = root.create_window(10, 10, 200, 100, 0, X.CopyFromParent)
                windows.append(window)
                window.set_wm_name(name)
                window.set_wm_class(name.lower(), name.lower())
                # Real Qt/Electron windows carry WM_HINTS (rq.DictWrapper).
                window.set_wm_hints(flags=1, input=1)
                window.change_property(conn.intern_atom("_NET_WM_WINDOW_TYPE"), Xatom.ATOM, 32,
                                       [conn.intern_atom("_NET_WM_WINDOW_TYPE_NORMAL")])
                window.map()
            root.change_property(conn.intern_atom("_NET_CLIENT_LIST"), Xatom.WINDOW, 32, [w.id for w in windows])
            windows[0].change_property(conn.intern_atom("_NET_WM_NAME"), conn.intern_atom("UTF8_STRING"), 8,
                                      "WeChat 新消息".encode())
            windows[0].change_property(conn.intern_atom("_NET_WM_STATE"), Xatom.ATOM, 32,
                                      [conn.intern_atom("_NET_WM_STATE_DEMANDS_ATTENTION")])
            windows[1].set_input_focus(X.RevertToParent, X.CurrentTime)
            conn.sync()
            bridge.WINDOW_READER = WindowReader()
            with patch.object(bridge, "run_text_command", side_effect=AssertionError("unexpected subprocess")):
                self.assertEqual(bridge.get_active_app_payload()["app"], "qq")
                wechat = bridge.find_app_window("wechat")
                self.assertTrue(wechat["attention"])
                self.assertEqual(wechat["title"], "WeChat 新消息")
                self.assertEqual(bridge.find_app_window("qq")["wid"], str(windows[1].id))
        finally:
            for window in windows:
                window.destroy()
            conn.sync()
            conn.close()


if __name__ == "__main__":
    unittest.main()

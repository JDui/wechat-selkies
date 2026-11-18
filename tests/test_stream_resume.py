"""Video start/stop must preserve decoder references and actual capture state."""

import asyncio
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

from tests.test_av1_capture import legacy_settings, server_methods, settings_server
from tests.test_input_queue_decoupling import ScriptedWebSocket, _wait_until
from tests.test_stream_queue_behavior import queue_server
from tests.test_ws_stats_lifecycle import stats_server


def resume_server():
    server = queue_server()
    server.capture_instances.clear()
    server.video_chunk_queues.clear()
    server.capture_loop = asyncio.get_running_loop()
    server._adaptive_sleep_video_active = {}
    server.last_start_video_request_times = {}
    server.display_clients["primary"].update(width=1920, height=1080, video_active=False)
    server.display_layouts = {"primary": {"w": 1920, "h": 1080, "x": 0, "y": 0}}
    server._start_capture_for_display = AsyncMock()
    server._finish_video_metrics = lambda _: None
    server._wm_swap_is_supported = False
    server._is_wm_swapped = False
    server._is_reconfiguring = False
    server._get_current_monitors = AsyncMock(return_value=[])
    server._run_command = AsyncMock()
    server.broadcast_stream_resolution = AsyncMock()
    server.broadcast_display_config = AsyncMock()
    namespace = server.reconfigure_displays.__func__.__globals__
    namespace.update(Av1Capture=type("Av1Capture", (), {}),
                     get_new_res=AsyncMock(return_value=(None, None, ["1920x1080"], None, "screen")))
    return server


async def cancel_pressure(server):
    for state in server.display_clients.values():
        task = state.get("backpressure_task")
        if task:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)


class VideoResumeTests(unittest.IsolatedAsyncioTestCase):
    async def test_duplicate_start_keeps_capture_ack_history_and_decoder_references(self):
        server = resume_server()
        state = server.display_clients["primary"]
        state.update(video_active=True, acknowledged_frame_id=7)
        state["sent_timestamps"][8] = 123.0
        capture = server.capture_instances["primary"] = {"module": object()}
        pressure = state["backpressure_task"] = asyncio.create_task(asyncio.Event().wait())
        try:
            for _ in range(3):
                self.assertTrue(await server._set_display_video_active("primary", state["ws"], True))
            self.assertIs(server.capture_instances["primary"], capture)
            self.assertIs(state["backpressure_task"], pressure)
            self.assertFalse(pressure.done())
            self.assertEqual(state["acknowledged_frame_id"], 7)
            self.assertEqual(list(state["sent_timestamps"]), [8])
            self.assertEqual(server.broadcasts, [], "Duplicate START reset active decoders")
            server._start_capture_for_display.assert_not_awaited()
            server.broadcast_display_config.assert_not_awaited()
        finally:
            await cancel_pressure(server)

    async def test_native_start_returning_without_capture_uses_real_guarded_fallback(self):
        for succeeds in (True, False):
            with self.subTest(fallback_succeeds=succeeds):
                server = resume_server()
                native = SimpleNamespace(start_capture=Mock(side_effect=[RuntimeError("device busy"),
                                                                        None if succeeds else RuntimeError("device busy")]),
                                         stop_capture=Mock())
                methods, _ = server_methods({"_start_capture_for_display"},
                                             ScreenCapture=lambda: native, StripeCallback=lambda callback: callback)
                server._start_capture_for_display = methods._start_capture_for_display.__func__.__get__(server)
                server._get_capture_settings = lambda *_: legacy_settings()
                server._video_chunk_sender = AsyncMock()
                state = server.display_clients["primary"]
                try:
                    result = await asyncio.wait_for(server._set_display_video_active("primary", state["ws"], True), 1)
                    self.assertEqual(result, succeeds)
                    self.assertEqual(native.start_capture.call_count, 2)
                    self.assertEqual("primary" in server.capture_instances, succeeds)
                    if not succeeds:
                        self.assertIsNone(state.get("backpressure_task"))
                    server.broadcast_display_config.assert_awaited_once()
                    self.assertFalse(server._reconfigure_lock.locked())
                finally:
                    await cancel_pressure(server)

    async def test_missing_layout_uses_real_full_reconfiguration(self):
        server = resume_server()
        server.display_layouts.clear()
        state = server.display_clients["primary"]
        native = SimpleNamespace(stop_capture=Mock())
        async def start(**_):
            server.capture_instances["primary"] = {"module": native}
            server.video_chunk_queues["primary"] = asyncio.Queue()
        server._start_capture_for_display.side_effect = start
        try:
            self.assertTrue(await asyncio.wait_for(server._set_display_video_active("primary", state["ws"], True), 1))
            server._start_capture_for_display.assert_awaited_once()
            server.broadcast_display_config.assert_awaited_once()
        finally:
            await cancel_pressure(server)

    async def test_native_start_and_stop_cannot_overlap(self):
        server = resume_server()
        state = server.display_clients["primary"]
        entered, release = asyncio.Event(), asyncio.Event()
        native = SimpleNamespace(stop_capture=Mock())
        async def start(**_):
            entered.set()
            await release.wait()
            server.capture_instances["primary"] = {"module": native}
            server.video_chunk_queues["primary"] = asyncio.Queue()
        server._start_capture_for_display.side_effect = start
        resume = asyncio.create_task(server._set_display_video_active("primary", state["ws"], True))
        await asyncio.wait_for(entered.wait(), 1)
        pause = asyncio.create_task(server._set_display_video_active("primary", state["ws"], False))
        await asyncio.sleep(0)
        self.assertFalse(pause.done())
        native.stop_capture.assert_not_called()
        release.set()
        self.assertTrue(await asyncio.wait_for(resume, 1))
        self.assertFalse(await asyncio.wait_for(pause, 1))
        self.assertNotIn("primary", server.capture_instances)
        self.assertNotIn("primary", server.video_chunk_queues)
        self.assertFalse(state["video_active"])
        native.stop_capture.assert_called_once()

    async def test_queued_start_or_stop_cannot_touch_replacement_connection(self):
        for active in (True, False):
            for replace_state in (True, False):
                with self.subTest(active=active, replace_state=replace_state):
                    server = resume_server()
                    state = server.display_clients["primary"]
                    server._stop_capture_for_display = AsyncMock()
                    await server._reconfigure_lock.acquire()
                    task = asyncio.create_task(server._set_display_video_active("primary", state["ws"], active))
                    await asyncio.sleep(0)
                    if replace_state:
                        server.display_clients["primary"] = dict(state)
                    else:
                        state["ws"] = object()
                    server._reconfigure_lock.release()
                    self.assertIsNone(await asyncio.wait_for(task, 1))
                    server._start_capture_for_display.assert_not_awaited()
                    server._stop_capture_for_display.assert_not_awaited()
                    server.broadcast_display_config.assert_not_awaited()

    async def test_fallback_does_not_restart_a_display_paused_before_it_gets_the_lock(self):
        server = resume_server()
        state = server.display_clients["primary"]
        real_reconfigure = server.reconfigure_displays
        async def reconfigure(**kwargs):
            self.assertFalse(server._reconfigure_lock.locked())
            state["video_active"] = False
            await real_reconfigure(**kwargs)
        server.reconfigure_displays = reconfigure
        self.assertFalse(await server._set_display_video_active("primary", state["ws"], True))
        server._start_capture_for_display.assert_awaited_once()
        server.broadcast_display_config.assert_not_awaited()

    async def test_sleep_retains_requested_preference_without_starting_capture(self):
        server = resume_server()
        state = server.display_clients["primary"]
        server._adaptive_sleeping = True
        self.assertFalse(await server._set_display_video_active("primary", state["ws"], True))
        self.assertTrue(server._adaptive_sleep_video_active["primary"])
        self.assertFalse(await server._set_display_video_active("primary", state["ws"], False))
        self.assertFalse(server._adaptive_sleep_video_active["primary"])
        server._start_capture_for_display.assert_not_awaited()

    async def test_handler_reports_stopped_when_native_resume_did_not_start(self):
        for actual in (True, False, None):
            with self.subTest(actual=actual):
                server, _ = stats_server(display_id="primary", gpus=False)
                websocket = ScriptedWebSocket()
                server.display_clients["primary"] = {"ws": websocket}
                server._set_display_video_active = AsyncMock(return_value=actual)
                handler = asyncio.create_task(server.ws_handler(websocket))
                try:
                    websocket.feed("START_VIDEO", "STOP_VIDEO")
                    await asyncio.wait_for(_wait_until(lambda: server._set_display_video_active.await_count == 2), 1)
                    messages = [call.args[0] for call in websocket.send.call_args_list
                                if call.args[0] in ("VIDEO_STARTED", "VIDEO_STOPPED")]
                    self.assertEqual(messages, [] if actual is None else
                                     ["VIDEO_STARTED" if actual else "VIDEO_STOPPED", "VIDEO_STOPPED"])
                finally:
                    websocket.hang_up()
                    await handler

    async def test_settings_change_uses_guarded_restart_and_preserves_paused_video(self):
        server, _ = settings_server()
        methods = queue_server()
        for name in ("_restart_capture_for_display_settings", "_restart_capture_for_display_settings_locked"):
            setattr(server, name, getattr(methods, name).__func__.__get__(server))
        owner = ScriptedWebSocket()
        state = server.display_clients["primary"]
        state.update(ws=owner, video_active=False)
        server._adaptive_sleeping = False
        server._stream_sleep_requested = lambda: False
        server._stop_capture_for_display = AsyncMock()
        server._start_capture_for_display = AsyncMock()
        server.display_layouts = {"primary": {"w": 1920, "h": 1080, "x": 0, "y": 0}}
        await asyncio.wait_for(server._apply_client_settings(
            owner, {"encoder": "x264enc", "framerate": 45}, False), 1)
        self.assertEqual(state["framerate"], 45)
        self.assertFalse(state["video_active"])
        server._stop_capture_for_display.assert_not_awaited()
        server._start_capture_for_display.assert_not_awaited()
        server.reconfigure_displays.assert_not_awaited()


class SharedVideoResumeTests(unittest.IsolatedAsyncioTestCase):
    async def test_legacy_static_or_striped_refresh_supplies_entry_after_every_local_reset(self):
        for encoder, streaming in (("x264enc", False), ("x264enc-striped", True),
                                   ("x264enc-striped", False)):
            with self.subTest(encoder=encoder, streaming=streaming):
                server = resume_server()
                state = server.display_clients["primary"]
                state.update(encoder=encoder, h264_streaming_mode=streaming, video_active=True)
                native = SimpleNamespace(stop_capture=Mock(), request_idr_frame=Mock())
                server.capture_instances["primary"] = {"module": native}
                state["backpressure_task"] = asyncio.create_task(asyncio.Event().wait())
                async def start(**_):
                    server.capture_instances["primary"] = {"module": native}
                    server.video_chunk_queues["primary"] = asyncio.Queue()
                server._start_capture_for_display.side_effect = start
                viewer = ScriptedWebSocket()
                try:
                    self.assertTrue(await server._sync_shared_viewer(viewer))
                    server._start_capture_for_display.assert_awaited_once()
                    native.stop_capture.assert_called_once()
                    native.request_idr_frame.assert_not_called()
                    self.assertEqual(server.broadcasts, ["PIPELINE_RESETTING primary"])
                    viewer.send.assert_not_awaited()
                    self.assertEqual(state["encoder"], encoder)
                    # A quick hide/show destroys the viewer's decoders and
                    # immediately requests START again. A static capture will
                    # not supply another entry point without another restart.
                    self.assertTrue(await server._sync_shared_viewer(viewer))
                    self.assertEqual(server._start_capture_for_display.await_count, 2)
                    self.assertEqual(native.stop_capture.call_count, 2)
                    self.assertEqual(server.broadcasts, ["PIPELINE_RESETTING primary"] * 2)
                finally:
                    await cancel_pressure(server)

    async def test_default_streaming_configuration_is_respected(self):
        server = resume_server()
        state = server.display_clients["primary"]
        state.update(encoder="x264enc", video_active=True)
        server._initial_h264_streaming_mode = False
        native = SimpleNamespace(stop_capture=Mock(), request_idr_frame=Mock())
        server.capture_instances["primary"] = {"module": native}
        server._restart_capture_for_display_settings_locked = AsyncMock(return_value=None)
        self.assertTrue(await server._sync_shared_viewer(ScriptedWebSocket()))
        server._restart_capture_for_display_settings_locked.assert_awaited_once_with("primary")
        native.request_idr_frame.assert_not_called()

    async def test_streaming_fullframe_hevc_and_av1_keep_lightweight_key_request(self):
        for encoder in ("x264enc", "h265enc", "av1enc"):
            with self.subTest(encoder=encoder):
                server = resume_server()
                state = server.display_clients["primary"]
                state.update(encoder=encoder, h264_streaming_mode=(encoder == "x264enc"), video_active=True)
                native = SimpleNamespace(stop_capture=Mock(), request_idr_frame=Mock())
                server.capture_instances["primary"] = {"module": native}
                viewer = ScriptedWebSocket()
                await server._sync_shared_viewer(viewer)
                viewer.send.assert_awaited_once_with("PIPELINE_RESETTING primary")
                native.request_idr_frame.assert_called_once()
                native.stop_capture.assert_not_called()
                server._start_capture_for_display.assert_not_awaited()

    async def test_legacy_refresh_waiting_for_lock_refreshes_current_capture_but_preserves_pause(self):
        for change in ("capture", "paused", "sleep", "owner", "state"):
            with self.subTest(change=change):
                server = resume_server()
                state = server.display_clients["primary"]
                state.update(encoder="x264enc-striped", video_active=True)
                server.capture_instances["primary"] = {"module": object()}
                server._restart_capture_for_display_settings_locked = AsyncMock(return_value=None)
                await server._reconfigure_lock.acquire()
                task = asyncio.create_task(server._sync_shared_viewer(ScriptedWebSocket()))
                await asyncio.sleep(0)
                if change == "capture":
                    server.capture_instances["primary"] = {"module": object()}
                elif change == "paused":
                    state["video_active"] = False
                elif change == "sleep":
                    server._adaptive_sleeping = True
                elif change == "owner":
                    state["ws"] = object()
                else:
                    server.display_clients["primary"] = dict(state)
                server._reconfigure_lock.release()
                self.assertEqual(await asyncio.wait_for(task, 1), change == "capture")
                if change == "capture":
                    # The replacement may have emitted its only static frame
                    # before this viewer discarded its decoder and sent START.
                    server._restart_capture_for_display_settings_locked.assert_awaited_once_with("primary")
                else:
                    server._restart_capture_for_display_settings_locked.assert_not_awaited()

    async def test_legacy_refresh_queued_during_codec_change_uses_new_codec_entry_point(self):
        server = resume_server()
        state = server.display_clients["primary"]
        state.update(encoder="x264enc-striped", video_active=True)
        server.capture_instances["primary"] = {"module": object()}
        server._restart_capture_for_display_settings_locked = AsyncMock(return_value=None)
        viewer = ScriptedWebSocket()
        await server._reconfigure_lock.acquire()
        task = asyncio.create_task(server._sync_shared_viewer(viewer))
        await asyncio.sleep(0)
        native = SimpleNamespace(request_idr_frame=Mock())
        state["encoder"] = "av1enc"
        server.capture_instances["primary"] = {"module": native}
        server._reconfigure_lock.release()
        await asyncio.wait_for(task, 1)
        server._restart_capture_for_display_settings_locked.assert_not_awaited()
        viewer.send.assert_awaited_once_with("PIPELINE_RESETTING primary")
        native.request_idr_frame.assert_called_once()

    async def test_failed_shared_capture_restart_reports_no_active_stream(self):
        server = resume_server()
        state = server.display_clients["primary"]
        state.update(encoder="x264enc-striped", video_active=True)
        native = SimpleNamespace(stop_capture=Mock(), request_idr_frame=Mock())
        server.capture_instances["primary"] = {"module": native}
        self.assertFalse(await asyncio.wait_for(server._sync_shared_viewer(ScriptedWebSocket()), 1))
        self.assertEqual(server._start_capture_for_display.await_count, 2)
        native.request_idr_frame.assert_not_called()
        self.assertNotIn("primary", server.capture_instances)
        self.assertIsNone(state.get("backpressure_task"))


if __name__ == "__main__":
    unittest.main()

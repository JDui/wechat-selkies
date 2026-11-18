"""Receive-ACK flow control must recover without dropping reference frames."""

import asyncio
import json
import unittest
from collections import OrderedDict, deque
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

from tests.test_input_queue_decoupling import ScriptedWebSocket, _wait_until
from tests.test_stream_queue_behavior import queue_server
from tests.test_ws_stats_lifecycle import stats_server


def clocked_server(now=100.0):
    server = queue_server()
    clock = [now]
    server._record_frame_ack.__func__.__globals__["time"] = SimpleNamespace(monotonic=lambda: clock[0])
    server.clock = clock
    server._restart_capture_for_display_settings_locked = AsyncMock(return_value=None)
    return server


async def pressure_step(server):
    task = asyncio.create_task(server._run_frame_backpressure_logic("primary"))
    try:
        await asyncio.sleep(0.006)
        return server.display_clients["primary"]["backpressure_enabled"]
    finally:
        task.cancel()
        await task


class ReceiveProgressTests(unittest.IsolatedAsyncioTestCase):
    async def test_static_desktop_with_no_pending_frames_never_stalls(self):
        server = clocked_server()
        state = server.display_clients["primary"]
        state.update(acknowledged_frame_id=20, last_sent_frame_id=20,
                     last_ack_update_time=1, last_ack_progress_time=1, backpressure_enabled=False)
        self.assertTrue(await pressure_step(server))
        self.assertEqual(server.broadcasts, [])

    async def test_first_frame_zero_without_any_ack_is_bounded(self):
        server = clocked_server()
        state = server.display_clients["primary"]
        state.update(acknowledged_frame_id=-1, last_sent_frame_id=0)
        state["sent_timestamps"][0] = 95
        self.assertFalse(await pressure_step(server))
        self.assertEqual(len(server.broadcasts), 1)
        self.assertEqual(json.loads(server.broadcasts[0].split(",", 1)[1]),
                         {"kind": "stall", "reason": "ack_timeout", "display_id": "primary"})

    async def test_duplicate_ack_does_not_hide_unconfirmed_receive_stall(self):
        server = clocked_server()
        state = server.display_clients["primary"]
        state.update(acknowledged_frame_id=7, last_sent_frame_id=8, last_ack_progress_time=95)
        state["sent_timestamps"][8] = 95
        self.assertTrue(server._record_frame_ack("primary", state["ws"], 7))
        self.assertEqual(state["last_ack_update_time"], 100)
        self.assertEqual(state["last_ack_progress_time"], 95)
        self.assertFalse(await pressure_step(server))
        self.assertTrue(server._record_frame_ack("primary", state["ws"], 8))
        self.assertEqual(state["last_ack_progress_time"], 100)
        self.assertTrue(await pressure_step(server))

    async def test_wrap_and_skipped_native_ids_use_actual_pending_count(self):
        server = clocked_server()
        state = server.display_clients["primary"]
        state.update(acknowledged_frame_id=2, last_sent_frame_id=0)
        state["sent_timestamps"] = OrderedDict([(100, 99), (50000, 99), (65535, 99), (0, 99)])
        self.assertTrue(await pressure_step(server))
        self.assertTrue(server._record_frame_ack("primary", state["ws"], 65535))
        self.assertEqual(list(state["sent_timestamps"]), [0])
        self.assertTrue(server._record_frame_ack("primary", state["ws"], 0))
        self.assertEqual(list(state["sent_timestamps"]), [])

    async def test_stale_owner_unknown_and_out_of_range_acks_are_ignored(self):
        server = clocked_server()
        state = server.display_clients["primary"]
        state.update(acknowledged_frame_id=7, last_ack_progress_time=90)
        state["sent_timestamps"][8] = 95
        for owner, frame_id in ((object(), 8), (state["ws"], -1),
                                (state["ws"], 65536), (state["ws"], 9)):
            self.assertFalse(server._record_frame_ack("primary", owner, frame_id))
        self.assertEqual(state["acknowledged_frame_id"], 7)
        self.assertEqual(list(state["sent_timestamps"]), [8])
        state["rtt_samples"] = deque(maxlen=20)
        self.assertTrue(server._record_frame_ack("primary", state["ws"], 8))
        self.assertEqual(state["smoothed_rtt"], 5000)
        self.assertFalse(server._record_frame_ack("primary", state["ws"], 7))

    async def test_duplicate_stripe_ack_clears_only_its_repeated_frame(self):
        server = clocked_server()
        state = server.display_clients["primary"]
        state.update(acknowledged_frame_id=7, last_ack_progress_time=90)
        state["sent_timestamps"] = OrderedDict([(7, 95), (8, 96)])
        self.assertTrue(server._record_frame_ack("primary", state["ws"], 7))
        self.assertEqual(list(state["sent_timestamps"]), [8])
        self.assertEqual(state["last_ack_progress_time"], 90)

    async def test_secondary_backpressure_retains_reference_frame_order(self):
        for encoder in ("x264enc", "x264enc-striped", "h265enc", "av1enc"):
            with self.subTest(encoder=encoder):
                server = queue_server()
                websocket = SimpleNamespace(send=AsyncMock())
                state = {"encoder": encoder, "ws": websocket, "backpressure_enabled": False,
                         "sent_timestamps": OrderedDict()}
                server.display_clients["secondary"] = state
                queue = server.video_chunk_queues["secondary"] = asyncio.Queue()
                packets = [b"key", b"reference", b"dependent"]
                for frame_id, packet in zip((65535, 0, 1), packets):
                    queue.put_nowait({"data": packet, "frame_id": frame_id})
                task = asyncio.create_task(server._video_chunk_sender("secondary"))
                try:
                    await asyncio.sleep(0.006)
                    websocket.send.assert_not_awaited()
                    self.assertEqual(queue.qsize(), 3)
                    state["backpressure_enabled"] = True
                    await asyncio.wait_for(queue.join(), 1)
                    self.assertEqual([call.args[0] for call in websocket.send.call_args_list], packets)
                    self.assertEqual(list(state["sent_timestamps"]), [65535, 0, 1])
                finally:
                    task.cancel()
                    await task

    async def test_stream_health_is_display_scoped_rate_limited_and_nonblocking(self):
        server = clocked_server()
        owner = server.display_clients["primary"]["ws"]
        viewer, secondary = object(), object()
        server.clients.update({viewer, secondary})
        server.display_clients["secondary"] = {"ws": secondary}
        delivered = []
        server._notify_stream_health.__func__.__globals__["websockets"].broadcast = (
            lambda recipients, message: delivered.append((recipients, message)))
        server._notify_stream_health("primary", "drop", "video_queue_overflow")
        server._notify_stream_health("primary", "drop", "video_queue_overflow")
        self.assertEqual(len(delivered), 1)
        self.assertEqual(delivered[0][0], {owner, viewer})
        server._notify_stream_health("secondary", "stall", "ack_timeout")
        self.assertEqual(delivered[1][0], {secondary})
        server.clock[0] += 6
        server._adaptive_sleeping = True
        server._notify_stream_health("primary", "drop", "video_queue_overflow")
        self.assertEqual(len(delivered), 2)
        server._adaptive_sleeping = False
        server._stream_sleep_requested = lambda: True
        server._notify_stream_health("primary", "drop", "video_queue_overflow")
        self.assertEqual(len(delivered), 2)
        server._stream_sleep_requested = lambda: False
        def blocked_broadcast(*_):
            raise RuntimeError("transport failure")
        server._notify_stream_health.__func__.__globals__["websockets"].broadcast = blocked_broadcast
        server._notify_stream_health("primary", "drop", "video_queue_overflow")


class RecoveryTests(unittest.IsolatedAsyncioTestCase):
    def stalled(self):
        server = clocked_server()
        state = server.display_clients["primary"]
        state.update(last_ack_progress_time=90, video_active=True)
        state["sent_timestamps"][1] = 90
        capture, queue = server.capture_instances["primary"], server.video_chunk_queues["primary"]
        return server, state, capture, queue

    async def test_extended_stall_recovers_once_without_restarting_audio(self):
        server, state, capture, queue = self.stalled()
        self.assertFalse(await pressure_step(server))
        await capture["ack_recovery_task"]
        server._restart_capture_for_display_settings_locked.assert_awaited_once_with("primary")
        await pressure_step(server)
        self.assertEqual(server._restart_capture_for_display_settings_locked.await_count, 1)

    async def test_pending_recovery_cannot_restart_replacement_capture_or_owner(self):
        for change in ("capture", "queue", "owner", "progress", "stopped", "sleep"):
            with self.subTest(change=change):
                server, state, capture, queue = self.stalled()
                owner = state["ws"]
                await server._reconfigure_lock.acquire()
                task = asyncio.create_task(server._recover_stalled_video("primary", state, capture, queue, owner, 90))
                await asyncio.sleep(0)
                if change == "capture":
                    server.capture_instances["primary"] = {"module": object()}
                elif change == "queue":
                    server.video_chunk_queues["primary"] = asyncio.Queue()
                elif change == "owner":
                    state["ws"] = object()
                elif change == "progress":
                    state["last_ack_progress_time"] = 99
                elif change == "stopped":
                    state["video_active"] = False
                else:
                    server._adaptive_sleeping = True
                server._reconfigure_lock.release()
                self.assertFalse(await task)
                server._restart_capture_for_display_settings_locked.assert_not_awaited()

    async def test_cancelled_recovery_does_not_restart_after_lock_is_released(self):
        server, state, capture, queue = self.stalled()
        await server._reconfigure_lock.acquire()
        task = asyncio.create_task(server._recover_stalled_video("primary", state, capture, queue, state["ws"], 90))
        await asyncio.sleep(0)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        server._reconfigure_lock.release()
        server._restart_capture_for_display_settings_locked.assert_not_awaited()

    async def test_capture_stop_cancels_and_awaits_pending_ack_recovery(self):
        server, state, capture, queue = self.stalled()
        server._ensure_backpressure_task_is_stopped = AsyncMock(return_value=False)
        server._finish_video_metrics = lambda _: None
        server.capture_loop = asyncio.get_running_loop()
        stopped = []
        capture["module"] = SimpleNamespace(stop_capture=lambda: stopped.append(True))
        await server._reconfigure_lock.acquire()
        task = capture["ack_recovery_task"] = asyncio.create_task(
            server._recover_stalled_video("primary", state, capture, queue, state["ws"], 90))
        await asyncio.sleep(0)
        await server._stop_capture_for_display("primary")
        server._reconfigure_lock.release()
        self.assertTrue(task.cancelled())
        self.assertEqual(stopped, [True])
        self.assertNotIn("primary", server.video_chunk_queues)
        server._restart_capture_for_display_settings_locked.assert_not_awaited()

    async def test_overflow_queued_before_stop_cannot_resume_a_stopped_display(self):
        server, state, _, queue = self.stalled()
        await server._reconfigure_lock.acquire()
        task = asyncio.create_task(server._recover_video_queue_overflow("primary", queue))
        await asyncio.sleep(0)
        state["video_active"] = False
        server._reconfigure_lock.release()
        await task
        server._restart_capture_for_display_settings_locked.assert_not_awaited()
        self.assertEqual(server.broadcasts, [])

    async def test_video_only_force_recovery_is_serialized_and_does_not_touch_audio(self):
        server = clocked_server()
        state = server.display_clients["primary"]
        owner = state["ws"]
        server._reset_transient_display_state = lambda _: None
        server._stop_capture_for_display = AsyncMock(return_value=True)
        server._start_capture_for_display = AsyncMock()
        server._start_backpressure_task_if_needed = AsyncMock()
        server._start_pcmflux_pipeline = AsyncMock()
        server._stop_pcmflux_pipeline = AsyncMock()
        server.is_pcmflux_capturing = True
        server.display_layouts = {"primary": {"w": 1920, "h": 1080, "x": 0, "y": 0}}
        await server._force_recover_display("primary", restart_audio=False, expected_websocket=owner)
        server._start_capture_for_display.assert_awaited_once()
        server._start_pcmflux_pipeline.assert_not_awaited()
        server._stop_pcmflux_pipeline.assert_not_awaited()
        server._stop_capture_for_display.reset_mock()
        await server._reconfigure_lock.acquire()
        task = asyncio.create_task(server._force_recover_display("primary", restart_audio=False, expected_websocket=owner))
        await asyncio.sleep(0)
        server._stop_capture_for_display.assert_not_awaited()
        state["ws"] = object()
        server._reconfigure_lock.release()
        await task
        server._stop_capture_for_display.assert_not_awaited()

    async def test_force_reconfigure_fallback_releases_lock_before_calling_it(self):
        server = clocked_server()
        server._reset_transient_display_state = lambda _: None
        server._stop_capture_for_display = AsyncMock(return_value=True)
        checked = []
        async def reconfigure(**_):
            checked.append(server._reconfigure_lock.locked())
        server.reconfigure_displays = reconfigure
        await server._force_recover_display("primary", restart_audio=False)
        self.assertEqual(checked, [False])

    async def test_force_recovery_requires_current_display_owner_and_preserves_legacy_mode(self):
        server, _ = stats_server(display_id="primary", gpus=False)
        websocket = ScriptedWebSocket()
        server.display_clients = {"primary": {"ws": websocket}, "secondary": {"ws": object()}}
        server._force_recover_display = AsyncMock()
        handler = asyncio.create_task(server.ws_handler(websocket))
        try:
            websocket.feed("FORCE_STREAM_RECOVER,secondary,video", "FORCE_STREAM_RECOVER,missing,video",
                           "FORCE_STREAM_RECOVER,primary,video", "FORCE_STREAM_RECOVER,primary")
            await asyncio.wait_for(_wait_until(lambda: server._force_recover_display.await_count == 2), 1)
            calls = server._force_recover_display.call_args_list
            self.assertEqual(calls[0].args, ("primary",))
            self.assertEqual(calls[0].kwargs, {"restart_audio": False, "expected_websocket": websocket})
            self.assertEqual(calls[1].kwargs, {"restart_audio": True, "expected_websocket": websocket})
            server.display_clients["primary"]["ws"] = object()
            websocket.feed("FORCE_STREAM_RECOVER,primary,video", "CLIENT_AWAKE_STATE,1")
            await asyncio.sleep(0.006)
            self.assertEqual(server._force_recover_display.await_count, 2)
        finally:
            websocket.hang_up()
            await handler


class RestartLockTests(unittest.IsolatedAsyncioTestCase):
    def real_restart_server(self, failure):
        server = queue_server()
        namespace = server._restart_capture_for_display_settings.__func__.__globals__
        namespace.update(time=SimpleNamespace(monotonic=lambda: 100.0), IS_WAYLAND=False,
                         Av1Capture=type("Av1Capture", (), {}),
                         get_new_res=AsyncMock(return_value=(None, None, ["1920x1080"], None, "screen")))
        state = server.display_clients["primary"]
        state.update(width=1920, height=1080, video_active=True, last_ack_progress_time=90)
        state["sent_timestamps"][1] = 90
        native = SimpleNamespace(stop_capture=Mock(), request_idr_frame=Mock(side_effect=RuntimeError("key request failed")))
        server.capture_instances["primary"]["module"] = native
        server.capture_loop = asyncio.get_running_loop()
        server._ensure_backpressure_task_is_stopped = AsyncMock(return_value=True)
        server._finish_video_metrics = lambda _: None
        server._reset_frame_ids_and_notify = AsyncMock()
        server._reset_transient_display_state = lambda _: None
        server._start_backpressure_task_if_needed = AsyncMock()
        server._notify_av1_fallback = AsyncMock()
        server._wm_swap_is_supported = False
        server._is_wm_swapped = False
        server._is_reconfiguring = False
        server._get_current_monitors = AsyncMock(return_value=[])
        server._run_command = AsyncMock()
        server.broadcast_stream_resolution = AsyncMock()
        server.broadcast_display_config = AsyncMock()
        if failure != "missing_layout":
            server.display_layouts = {"primary": {"w": 1920, "h": 1080, "x": 0, "y": 0}}
        starts = []
        async def start(**kwargs):
            starts.append(kwargs)
            if len(starts) == 1 and failure == "start_exception":
                raise RuntimeError("native start failed")
            if len(starts) == 1 and failure == "start_without_capture":
                return
            server.capture_instances["primary"] = {"module": native}
            server.video_chunk_queues["primary"] = asyncio.Queue()
        server._start_capture_for_display = start
        return server, state, native, starts

    async def test_all_restart_callers_reconfigure_outside_lock_after_real_failure(self):
        for origin in ("ack", "overflow", "av1", "shared", "dynamic", "force"):
            for failure in ("missing_layout", "start_exception", "start_without_capture"):
                with self.subTest(origin=origin, failure=failure):
                    server, state, native, starts = self.real_restart_server(failure)
                    capture = server.capture_instances["primary"]
                    queue = server.video_chunk_queues["primary"]
                    if origin == "ack":
                        recovery = server._recover_stalled_video("primary", state, capture, queue, state["ws"], 90)
                    elif origin == "overflow":
                        recovery = server._recover_video_queue_overflow("primary", queue)
                    elif origin == "av1":
                        state["encoder"] = "av1enc"
                        recovery = server._fallback_av1_capture("primary", native, RuntimeError("hardware lost"))
                    elif origin == "shared":
                        recovery = server._sync_shared_viewer(SimpleNamespace(send=AsyncMock()))
                    elif origin == "force":
                        recovery = server._force_recover_display("primary", restart_audio=False, expected_websocket=state["ws"])
                    else:
                        recovery = server._restart_capture_for_display_settings("primary")
                    await asyncio.wait_for(recovery, timeout=1)
                    self.assertIn("primary", server.capture_instances, "Full fallback was skipped")
                    self.assertEqual(len(starts), 1 if failure == "missing_layout" else 2)
                    self.assertFalse(server._reconfigure_lock.locked())
                    self.assertFalse(state.get("capture_settings_restart_in_progress", False))
                    server.broadcast_display_config.assert_awaited_once()

    async def test_guarded_fallback_waits_for_lock_and_ignores_replaced_or_stopped_state(self):
        for changed in ("state", "owner", "capture", "queue", "stopped", "sleep"):
            with self.subTest(changed=changed):
                server, state, native, starts = self.real_restart_server("missing_layout")
                request = ("primary", state, state["ws"], server.capture_instances["primary"],
                           server.video_chunk_queues["primary"])
                await server._reconfigure_lock.acquire()
                task = asyncio.create_task(server.reconfigure_displays(expected_display=request))
                await asyncio.sleep(0)
                self.assertFalse(task.done(), "Guarded fallback must wait for the lock")
                if changed == "state":
                    server.display_clients["primary"] = dict(state)
                elif changed == "owner":
                    state["ws"] = object()
                elif changed == "capture":
                    server.capture_instances["primary"] = {"module": native}
                elif changed == "queue":
                    server.video_chunk_queues["primary"] = asyncio.Queue()
                elif changed == "stopped":
                    state["video_active"] = False
                else:
                    server._adaptive_sleeping = True
                server._reconfigure_lock.release()
                await asyncio.wait_for(task, 1)
                self.assertEqual(starts, [])
                native.stop_capture.assert_not_called()
                self.assertFalse(server._is_reconfiguring)


if __name__ == "__main__":
    unittest.main()

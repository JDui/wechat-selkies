import asyncio
import importlib.util
import threading
import time
import unittest
from types import SimpleNamespace
from unittest.mock import Mock

from tests.test_av1_capture import BACKEND, legacy_settings, settings_server
from tests.test_stream_backpressure_progress import clocked_server, pressure_step
from tests.test_input_queue_decoupling import ScriptedWebSocket, _wait_until
from tests.test_ws_stats_lifecycle import stats_server

spec = importlib.util.spec_from_file_location('frame_feedback', BACKEND / 'frame_feedback.py')
feedback_api = importlib.util.module_from_spec(spec)
spec.loader.exec_module(feedback_api)


class FrameFeedbackTests(unittest.IsolatedAsyncioTestCase):
    async def test_restore_saved_modes_only_during_controller_handshake(self):
        server, _ = settings_server()
        server.client_settings_received = asyncio.Event()
        owner = object()
        state = server.display_clients['primary']
        state['ws'] = owner
        settings = server._parse_settings_payload('{"displayId":"primary","encoder":"x264enc","frame_feedback_mode":"observe","live_paint_mode":"false"}')
        await server._apply_client_settings(owner, settings, True)
        self.assertEqual((state['frame_feedback_mode'], state['live_paint_mode']), ('observe', 'false'))
        await server._apply_client_settings(owner, dict(settings, live_paint_mode='true'), False)
        self.assertEqual(state['live_paint_mode'], 'false')
        self.assertNotIn('live_paint_mode', server._parse_settings_payload('{"live_paint_mode":"observe"}'))

    def attach(self):
        server = clocked_server(100)
        owner = server.display_clients['primary']['ws']
        feedback = feedback_api.FrameFeedback('session', 'primary', owner, 30, True)
        feedback.offer()
        module = Mock()
        server.capture_instances['primary'].update(feedback=feedback, module=module)
        server._run_frame_backpressure_logic.__func__.__globals__.update(
            live_call=feedback_api.live_call, client_permissions={owner: {'role': 'controller'}})
        return server, owner, feedback, module

    def report(self, feedback, lag=9):
        return f'CLIENT_QOE,primary,{feedback.token},0,65535,65534,{lag},0,0,10,-1,1,1,1'

    async def test_hysteresis_hot_control_and_expiry_do_not_restart_or_drop(self):
        server, owner, feedback, module = self.attach()
        for now in (99.25, 99.5, 99.75, 100):
            self.assertTrue(feedback.receive(self.report(feedback), owner, now, False))
        await pressure_step(server)
        module.update_framerate.assert_called_once_with(24)
        server.clock[0] = 100.5
        await pressure_step(server)
        self.assertEqual(module.update_framerate.call_count, 1)
        for index in range(14):
            server.clock[0] = 100.75 + index / 4
            feedback.receive(self.report(feedback, 0), owner, server.clock[0], False)
        await pressure_step(server)
        module.update_framerate.assert_called_with(28)
        server.clock[0] += 3
        await pressure_step(server)
        module.update_framerate.assert_called_with(30)
        server._restart_capture_for_display_settings_locked.assert_not_awaited()
        self.assertEqual(server.broadcasts, [])

    async def test_bad_epoch_role_display_ranges_and_burst_cannot_control(self):
        server, owner, feedback, module = self.attach()
        old = self.report(feedback)
        feedback.offer()
        valid = self.report(feedback)
        for text, sender in ((old, owner), (valid, object()), (valid.replace('primary', 'secondary'), owner),
                             (valid + '9' * 200, owner), (valid.replace('65535', '65536'), owner)):
            self.assertFalse(feedback.receive(text, sender, 99, False))
        self.assertTrue(feedback.receive(valid, owner, 99, False))
        self.assertFalse(feedback.receive(valid, owner, 99.05, False))
        await pressure_step(server)
        module.update_framerate.assert_not_called()
        for now in (99.25, 99.5, 99.75):
            feedback.receive(valid, owner, now, False)
        server._run_frame_backpressure_logic.__func__.__globals__['client_permissions'][owner]['role'] = 'viewer'
        await pressure_step(server)
        module.update_framerate.assert_not_called()

    async def test_native_failure_does_not_kill_backpressure(self):
        server, owner, feedback, module = self.attach()
        for now in (99, 99.25, 99.5, 99.75):
            feedback.receive(self.report(feedback), owner, now, False)
        module.update_framerate.side_effect = [RuntimeError('unsupported'), None]
        self.assertTrue(await pressure_step(server))
        self.assertFalse(feedback.adjustable)
        module.update_framerate.assert_called_with(30)

    async def test_websocket_accepts_only_current_controller_without_transport_stats(self):
        server, _ = stats_server(display_id='primary', gpus=False)
        owner = ScriptedWebSocket()
        feedback = feedback_api.FrameFeedback('session', 'primary', owner, 30, True)
        feedback.offer()
        server.display_clients = {'primary': {'ws': owner}}
        server.capture_instances = {'primary': {'feedback': feedback}}
        server.video_chunk_queues = {}
        handler = asyncio.create_task(server.ws_handler(owner))
        try:
            owner.feed(self.report(feedback).replace('primary', 'secondary'), self.report(feedback))
            await asyncio.wait_for(_wait_until(lambda: feedback.sample is not None), 2)
            self.assertEqual(feedback.sample['received_total'], 1)
            self.assertIsNone(feedback.sample['write_buffer_bytes'])
        finally:
            owner.hang_up()
            await handler

    async def test_controller_hot_switch_round_trip_restores_fps_without_restart(self):
        server, _ = stats_server(display_id='primary', gpus=False)
        owner, module = ScriptedWebSocket(), Mock()
        feedback = feedback_api.FrameFeedback('session', 'primary', owner, 30, True, 'false')
        feedback.announce()
        server.display_clients = {'primary': {'ws': owner}}
        capture = {'module': module, 'feedback': feedback}
        server.capture_instances = {'primary': capture}
        namespace = server.ws_handler.__func__.__globals__
        notices = []
        namespace['websockets'].broadcast = lambda sockets, notice: notices.append(notice)
        handler = asyncio.create_task(server.ws_handler(owner))
        try:
            old = feedback.token
            owner.feed(f'SET_QOE_MODE,secondary,{old},true', f'SET_QOE_MODE,primary,{old},true')
            await asyncio.wait_for(_wait_until(lambda: len(notices) == 2), 1)
            self.assertTrue(feedback.adjustable)
            self.assertNotEqual(feedback.token, old)
            feedback.requested = 18
            owner.feed(f'SET_QOE_MODE,primary,{old},false', f'SET_QOE_MODE,primary,{feedback.token},observe')
            await asyncio.wait_for(_wait_until(lambda: len(notices) == 4), 1)
            module.update_framerate.assert_called_once_with(30)
            self.assertEqual(feedback.mode, 'observe')
            self.assertFalse(feedback.adjustable)
            owner.feed(f'SET_QOE_MODE,primary,{feedback.token},false')
            await asyncio.wait_for(_wait_until(lambda: len(notices) == 5), 1)
            self.assertEqual(feedback.mode, 'false')
            self.assertFalse(feedback.receive(self.report(feedback), owner, 100, False))
            self.assertIs(server.capture_instances['primary'], capture)
            server.reconfigure_displays.assert_not_awaited()
        finally:
            owner.hang_up()
            await handler

    async def test_live_paint_is_independent_of_feedback_and_keeps_the_capture(self):
        server, _ = stats_server(display_id='primary', gpus=False)
        owner, module = ScriptedWebSocket(), Mock()
        feedback = feedback_api.FrameFeedback('session', 'primary', owner, 30, True, 'false')
        feedback.paint_mode = 'inherit'
        feedback.announce()
        server.cli_args = SimpleNamespace(use_paint_over_quality=(False, False))
        server._initial_use_paint_over_quality = False
        server._is_low_latency_mode_active = lambda state: state.get('idle')
        state = {'ws': owner, 'use_paint_over_quality': False}
        server.display_clients = {'primary': state}
        capture = {'module': module, 'feedback': feedback}
        server.capture_instances = {'primary': capture}
        notices = []
        namespace = server.ws_handler.__func__.__globals__
        namespace['websockets'].broadcast = lambda sockets, notice: notices.append(notice)
        namespace['live_call'] = feedback_api.live_call
        handler = asyncio.create_task(server.ws_handler(owner))
        async def switch(mode):
            count = len(notices)
            owner.feed(f'SET_PAINT_OVER,primary,{feedback.token},{mode}')
            await asyncio.wait_for(_wait_until(lambda: len(notices) > count), 1)
        try:
            owner.feed('SET_PAINT_OVER,primary,stale,true')
            await switch('true')
            module.update_paint_over.assert_called_once_with(True)
            self.assertTrue(notices[-1].endswith(',true,1'))
            module.update_paint_over.side_effect = RuntimeError('refused')
            await switch('false')
            self.assertTrue(notices[-1].endswith(',paint_failed,true,1'))
            self.assertEqual(state['live_paint_mode'], 'true')
            module.update_paint_over.side_effect = None
            await switch('inherit')
            module.update_paint_over.assert_called_with(False)
            state['idle'] = True
            await switch('true')
            self.assertTrue(notices[-1].endswith(',true,0'))
            self.assertEqual(module.update_paint_over.call_count, 3)
            self.assertEqual(feedback.mode, 'false')
            self.assertIs(server.capture_instances['primary'], capture)
            server.reconfigure_displays.assert_not_awaited()
        finally:
            owner.hang_up()
            await handler

    async def test_failed_restore_retains_confirmed_mode_and_epoch(self):
        _, _, feedback, module = self.attach()
        epoch = feedback.token
        feedback.requested = 15
        module.update_framerate.side_effect = RuntimeError('driver refused')
        with self.assertRaises(RuntimeError):
            await feedback.switch('false', module)
        self.assertEqual((feedback.mode, feedback.token, feedback.requested), ('true', epoch, 15))

    async def test_cancel_waits_for_inflight_native_write(self):
        loop = asyncio.get_running_loop()
        entered, finished = asyncio.Event(), threading.Event()
        def write(value):
            loop.call_soon_threadsafe(entered.set)
            finished.wait(2)
        task = asyncio.create_task(feedback_api.live_call(write, 24))
        await asyncio.wait_for(entered.wait(), 2)
        task.cancel()
        await asyncio.sleep(0)
        self.assertFalse(task.done())
        finished.set()
        with self.assertRaises(asyncio.CancelledError):
            await task

    async def test_quality_only_update_vs_structural_restart(self):
        server, namespace = settings_server(live_call=feedback_api.live_call)
        namespace['SETTING_DEFINITIONS'].append({'name': 'h264_crf', 'type': 'range', 'meta': {'default_value': 24}})
        server.cli_args.h264_crf = (5, 50)
        owner = object()
        settings = {'displayId': 'primary', 'encoder': 'av1enc', 'av1_supported': True, 'h264_crf': 24}
        await server._apply_client_settings(owner, settings, False)
        server._restart_capture_for_display_settings.reset_mock()
        module = Mock()
        server.capture_instances = {'primary': {'module': module, 'feedback': SimpleNamespace(owner=owner, adjustable=True)}}
        server.display_layouts = {'primary': dict(w=320,h=240,x=0,y=0)}
        server._is_low_latency_mode_active = lambda state: False
        legacy = legacy_settings(h264_crf=28)
        server._get_capture_settings = lambda *_: legacy
        await server._apply_client_settings(owner, dict(settings, h264_crf=28), False)
        module.update_quality.assert_called_once_with(legacy)
        server._restart_capture_for_display_settings.assert_not_awaited()
        namespace['time'] = time
        server._video_metrics = {}
        legacy.target_fps = 45
        await server._apply_client_settings(owner, dict(settings, h264_crf=28, framerate=45), False)
        module.update_framerate.assert_called_once_with(45)
        server._restart_capture_for_display_settings.assert_not_awaited()
        await server._apply_client_settings(owner, dict(settings, encoder='x264enc'), False)
        server._restart_capture_for_display_settings.assert_awaited_once()

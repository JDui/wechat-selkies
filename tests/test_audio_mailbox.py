import asyncio
import ctypes
import importlib.util
import threading
import unittest
from pathlib import Path

PATH = Path(__file__).resolve().parents[1] / "root/lsiopy/lib/python3.12/site-packages/selkies/audio_mailbox.py"
SPEC = importlib.util.spec_from_file_location("audio_mailbox", PATH)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class AudioMailboxTests(unittest.IsolatedAsyncioTestCase):
    async def test_blocked_loop_has_only_one_wakeup_and_latest_chunks(self):
        box = MODULE.AudioMailbox(asyncio.get_running_loop(), 3)
        def produce():
            for value in range(10):
                data = ctypes.create_string_buffer(bytes([value]))
                box.push_pointer(data, 1)
        producer = threading.Thread(target=produce)
        producer.start()
        producer.join()
        self.assertEqual(box.wakeups, 1)
        self.assertEqual(box.dropped, 7)
        await asyncio.wait_for(box.ready.wait(), 1)
        self.assertEqual([box.pop(), box.pop(), box.pop()], [bytes([7]), bytes([8]), bytes([9])])
        self.assertIsNone(box.pop())
        self.assertFalse(box.ready.is_set())
        data = ctypes.create_string_buffer(b"a")
        self.assertTrue(box.push_pointer(data, 1))
        await asyncio.wait_for(box.ready.wait(), 1)
        self.assertEqual(box.wakeups, 2)
        self.assertEqual(box.pop(), b"a")
        box.close()

    async def test_closed_generation_rejects_late_callbacks(self):
        loop = asyncio.get_running_loop()
        old = MODULE.AudioMailbox(loop, 2)
        new = MODULE.AudioMailbox(loop, 2)
        old.close()
        data = ctypes.create_string_buffer(b"stale")
        self.assertFalse(old.push_pointer(data, 5))
        self.assertIsNone(old.pop())
        self.assertFalse(new.ready.is_set())
        self.assertEqual(new.wakeups, 0)
        new.close()

    async def test_native_backend_close_serializes_with_producer(self):
        class Native:
            def __init__(self):
                self.entered = threading.Event()
                self.release = threading.Event()
                self.closed = False
                self.dropped = 0
            def push_pointer(self, pointer, size):
                self.entered.set()
                self.release.wait(2)
                if self.closed:
                    raise AssertionError("native use after close")
                return 0
            def close(self):
                self.closed = True
        native = Native()
        box = MODULE.AudioMailbox(asyncio.get_running_loop(), 2, native)
        data = ctypes.create_string_buffer(b"a")
        producer = threading.Thread(target=box.push_pointer, args=(data, 1))
        producer.start()
        self.assertTrue(native.entered.wait(1))
        releaser = threading.Thread(target=native.release.set)
        releaser.start()
        box.close()
        producer.join()
        releaser.join()
        self.assertTrue(native.closed)
        self.assertFalse(box.push_pointer(data, 1))


if __name__ == "__main__":
    unittest.main()

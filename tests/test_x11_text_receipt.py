"""The ordered input worker must wait for the application's selection receipt."""
import ast
import logging
import os
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock


SOURCE = Path(__file__).resolve().parents[1] / "root/lsiopy/lib/python3.12/site-packages/selkies/x11_text_paste.py"
tree = ast.parse(SOURCE.read_text(encoding="utf-8"))
owner_class = next(node for node in tree.body if isinstance(node, ast.ClassDef))
X = SimpleNamespace(SelectionRequest=30, PropertyNotify=28, PropertyDelete=1,
                    PropertyChangeMask=1 << 22, CopyFromParent=0, CurrentTime=0)
namespace = {"X": X, "Xatom": SimpleNamespace(ATOM=4), "CHUNK_BYTES": 4,
             "time": time, "log": logging.getLogger(__name__)}
exec(compile(ast.Module(body=[owner_class], type_ignores=[]), str(SOURCE), "exec"), namespace)


class TextReceiptTests(unittest.TestCase):
    def fixture(self, payload=b"abc", client=0x100001):
        owner = namespace["SelectionOwner"].__new__(namespace["SelectionOwner"])
        events, writes = [], []
        requestor = SimpleNamespace(id=client,
            change_attributes=lambda **kwargs: None,
            change_property=lambda *args: writes.append(args))
        owner.d = SimpleNamespace(
            display=SimpleNamespace(info=SimpleNamespace(resource_id_mask=0xFFFFF)),
            pending_events=lambda: len(events), next_event=lambda: events.pop(0), flush=lambda: None)
        owner.pasting, owner.consumed = True, False
        owner.window = SimpleNamespace(id=100)
        owner.paste_client, owner.text_targets, owner.targets, owner.incr = 0x100000, {10}, 11, 12
        owner.data, owner.transfers, owner.pending_receipts = {10: (10, 8, payload)}, {}, set()

        def delete(window=requestor, prop=20):
            events.append(SimpleNamespace(type=X.PropertyNotify, state=X.PropertyDelete,
                                          window=window, atom=prop))
            owner._event(time.monotonic() + 1)

        return owner, requestor, writes, delete

    def test_delayed_reader_holds_following_enter_until_receipt(self):
        owner, requestor, writes, delete = self.fixture()
        owner._serve(requestor, 10, 20)
        self.assertEqual(writes, [(20, 10, 8, b"abc")])
        self.assertFalse(owner.consumed, "writing the property must not release queued Enter")
        delete(prop=21)
        self.assertFalse(owner.consumed, "unrelated property deletion is not a receipt")
        delete()
        self.assertTrue(owner.consumed)

    def test_clipboard_observer_cannot_acknowledge_paste(self):
        owner, requestor, _, delete = self.fixture(client=0x200001)
        owner._serve(requestor, 10, 20)
        delete()
        self.assertFalse(owner.consumed)

    def test_incremental_transfer_waits_for_terminal_property_receipt(self):
        owner, requestor, writes, delete = self.fixture(payload=b"abcdef")
        owner._serve(requestor, 10, 20)
        for expected in (b"abcd", b"ef", b""):
            delete()
            self.assertEqual(writes[-1][-1], expected)
            self.assertFalse(owner.consumed)
        delete()
        self.assertTrue(owner.consumed)

    def test_late_text_request_cannot_read_restored_image_or_next_commit(self):
        owner, requestor, writes, _ = self.fixture()
        windows, published = [], []

        def create_window(*args, **kwargs):
            window = SimpleNamespace(id=100 + len(windows), destroy=mock.Mock())
            window.set_selection_owner = lambda *args: published.append(window.id)
            windows.append(window)
            return window

        owner.window = create_window()
        owner.selections, owner.retired_windows = {}, []
        owner.clipboard = 99
        owner.d.screen = lambda: SimpleNamespace(root=SimpleNamespace(create_window=create_window))
        owner.d.get_input_focus = lambda: SimpleNamespace(focus=requestor)
        owner.d.sync = lambda: None
        owner.owner = lambda: published[-1] if published else 0
        atoms = {"UTF8_STRING": 10, "text/plain;charset=utf-8": 12, "text/plain": 13, "TEXT": 14}
        owner.atom = atoms.__getitem__
        picture = {50: (50, 8, b"png")}
        owner._snapshot = lambda: picture
        owner._event = lambda deadline: setattr(owner, "consumed", True)
        owner.display_name = ":test"
        with mock.patch.dict(namespace, {"os": os, "subprocess": SimpleNamespace(run=mock.Mock(), DEVNULL=-3)}):
            owner._commit("甲")
            first_text, first_restore = published
            owner._commit("乙")
        second_text, second_restore = published[2:]
        self.assertEqual(len(set(published)), 4, "text and images must not share an owner generation")
        for generation, expected in ((first_text, "甲"), (second_text, "乙")):
            self.assertTrue(owner._serve(requestor, 10, 20, generation))
            self.assertEqual(writes[-1][-1], expected.encode())
            self.assertFalse(owner._serve(requestor, 50, 20, generation), "IME owner must never serve an image")
        for generation in (first_restore, second_restore):
            self.assertTrue(owner._serve(requestor, 50, 20, generation))
            self.assertEqual(writes[-1][-1], b"png", "explicit image clipboard remains intact")
        self.assertFalse(owner._serve(requestor, 10, 20, 99999))
        with mock.patch.object(time, "monotonic", return_value=time.monotonic() + 6):
            owner._collect_retired_windows()
        self.assertFalse(owner._serve(requestor, 10, 20, first_text))
        self.assertTrue(owner._serve(requestor, 50, 20, second_restore))
        self.assertTrue(all(window.destroy.called for window in windows[:-1]))
        self.assertFalse(windows[-1].destroy.called)

    def test_old_incremental_transfer_cannot_acknowledge_new_commit(self):
        owner, requestor, _, delete = self.fixture(payload=b"abcdef")
        owner._serve(requestor, 10, 20)
        owner.window = SimpleNamespace(id=101)
        for _ in range(4):
            delete()
        self.assertFalse(owner.consumed)


if __name__ == "__main__":
    unittest.main()

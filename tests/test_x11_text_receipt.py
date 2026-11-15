"""The ordered input worker must wait for the application's selection receipt."""
import ast
import logging
import time
import unittest
from pathlib import Path
from types import SimpleNamespace


SOURCE = Path(__file__).resolve().parents[1] / "root/lsiopy/lib/python3.12/site-packages/selkies/x11_text_paste.py"
tree = ast.parse(SOURCE.read_text(encoding="utf-8"))
owner_class = next(node for node in tree.body if isinstance(node, ast.ClassDef))
X = SimpleNamespace(SelectionRequest=30, PropertyNotify=28, PropertyDelete=1,
                    PropertyChangeMask=1 << 22)
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


if __name__ == "__main__":
    unittest.main()

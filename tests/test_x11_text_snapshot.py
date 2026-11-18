"""A broken clipboard format must not discard an otherwise valid IME commit."""
import ast
import logging
import os
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import Mock


SOURCE = Path(__file__).resolve().parents[1] / "root/lsiopy/lib/python3.12/site-packages/selkies/x11_text_paste.py"
OWNER = next(node for node in ast.parse(SOURCE.read_text(encoding="utf-8")).body
             if isinstance(node, ast.ClassDef) and node.name == "SelectionOwner")


class ClipboardSnapshotTests(unittest.TestCase):
    def fixture(self):
        clock = SimpleNamespace(now=0.0)
        x = SimpleNamespace(SelectionNotify=31, PropertyNotify=28, PropertyNewValue=0,
                            CopyFromParent=0, PropertyChangeMask=1 << 22,
                            CurrentTime=0, AnyPropertyType=0)
        run = Mock()
        namespace = {"time": SimpleNamespace(monotonic=lambda: clock.now),
                     "X": x, "MAX_BYTES": 32 * 1024 * 1024,
                     "log": logging.getLogger("snapshot-test"), "os": os,
                     "subprocess": SimpleNamespace(run=run, DEVNULL=-3)}
        exec(compile(ast.Module(body=[OWNER], type_ignores=[]), str(SOURCE), "exec"), namespace)
        owner = namespace["SelectionOwner"].__new__(namespace["SelectionOwner"])
        owner.window = SimpleNamespace(id=100)
        owner.targets, owner.clipboard, owner.read_property, owner.incr = 10, 11, 12, 13
        owner.owner = Mock(return_value=200)
        owner.d = SimpleNamespace(flush=Mock(), get_input_focus=lambda: SimpleNamespace(focus=SimpleNamespace(id=400)))
        owner._publish = Mock()
        return owner, clock, namespace, run

    def snapshot_source(self, owner, formats):
        names = {atom: name for atom, name, _ in formats}
        payloads = {atom: payload for atom, _, payload in formats}
        owner.d.get_atom_name = names.__getitem__
        reads = []

        def read(target, deadline):
            reads.append((target, deadline))
            if target == owner.targets:
                return 4, 32, list(names)
            payload = payloads[target]
            if isinstance(payload, Exception):
                raise payload
            return target, 8, payload

        owner._read = read
        return reads

    def test_refused_auxiliary_preserves_text_image_and_html(self):
        owner, _, _, _ = self.fixture()
        text, image, html = "原剪贴板".encode(), b"\x89PNG\r\n", b"<b>clipboard</b>"
        reads = self.snapshot_source(owner, [
            (25, "application/x-broken-auxiliary", RuntimeError("refused")),
            (24, "text/html", html), (23, "image/png", image), (22, "UTF8_STRING", text)])
        with self.assertLogs("snapshot-test", level="WARNING") as messages:
            result = owner._snapshot()
        self.assertEqual(result, {22: (22, 8, text), 23: (23, 8, image), 24: (24, 8, html)})
        self.assertEqual([target for target, _ in reads], [10, 22, 23, 24, 25])
        self.assertIn("application/x-broken-auxiliary", messages.output[0])
        self.assertNotIn("原剪贴板", messages.output[0])
        self.assertNotIn("refused", messages.output[0])

    def test_auxiliary_budget_expiration_keeps_converted_core_data(self):
        owner, clock, _, _ = self.fixture()
        self.snapshot_source(owner, [(22, "UTF8_STRING", b"original")] + [
            (30 + index, "application/x-aux-%s" % index, b"") for index in range(8)])
        original = owner._read
        reads = []

        def read(target, deadline):
            reads.append((target, deadline))
            if target < 30:
                return original(target, deadline)
            self.assertLessEqual(deadline - clock.now, 1)
            self.assertLessEqual(deadline, 5)
            clock.now = deadline
            raise TimeoutError("private clipboard data must not enter logs")

        owner._read = read
        with self.assertLogs("snapshot-test", level="WARNING") as messages:
            self.assertEqual(owner._snapshot(), {22: (22, 8, b"original")})
        self.assertEqual(clock.now, 5)
        self.assertEqual(len(reads), 7)
        self.assertNotIn("private clipboard data", "\n".join(messages.output))

    def test_slow_core_image_keeps_original_shared_budget(self):
        owner, clock, _, _ = self.fixture()
        self.snapshot_source(owner, [(22, "UTF8_STRING", b"caption"), (23, "image/png", b"image-data"),
                                     (24, "text/html", b"<img src='original'>")])
        original = owner._read

        def read(target, deadline):
            if target == 23:
                self.assertEqual(deadline, 5)
                clock.now += 1.2
            return original(target, deadline)

        owner._read = read
        result = owner._snapshot()
        self.assertEqual(result[23], (23, 8, b"image-data"))
        self.assertEqual(result[24], (24, 8, b"<img src='original'>"))

    def test_required_image_failure_does_not_degrade_clipboard_to_text(self):
        owner, _, _, run = self.fixture()
        self.snapshot_source(owner, [(22, "UTF8_STRING", b"caption"), (23, "image/png", TimeoutError())])
        with self.assertLogs("snapshot-test", level="WARNING"):
            with self.assertRaisesRegex(RuntimeError, "cannot be preserved"):
                owner._commit("中文")
        owner._publish.assert_not_called()
        run.assert_not_called()

    def test_budget_exhaustion_with_unread_core_format_aborts(self):
        owner, clock, _, run = self.fixture()
        self.snapshot_source(owner, [(22, "UTF8_STRING", b"text"), (23, "text/html", b"<b>text</b>")])
        original = owner._read

        def read(target, deadline):
            if target == 22:
                clock.now = deadline
            return original(target, deadline)

        owner._read = read
        with self.assertRaisesRegex(TimeoutError, "required formats incomplete"):
            owner._commit("中文")
        owner._publish.assert_not_called()
        run.assert_not_called()

    def test_all_formats_failing_never_takes_clipboard_or_pastes(self):
        owner, _, _, run = self.fixture()
        self.snapshot_source(owner, [(22, "UTF8_STRING", RuntimeError("refused")),
                                     (23, "image/png", TimeoutError())])
        with self.assertLogs("snapshot-test", level="WARNING"):
            with self.assertRaisesRegex(RuntimeError, "cannot be preserved"):
                owner._commit("中文")
        owner._publish.assert_not_called()
        run.assert_not_called()

    def test_new_copy_during_snapshot_is_not_overwritten(self):
        owner, _, _, run = self.fixture()
        self.snapshot_source(owner, [(22, "UTF8_STRING", b"original")])
        original = owner._read

        def read(target, deadline):
            result = original(target, deadline)
            if target == 22:
                owner.owner.return_value = 201
            return result

        owner._read = read
        with self.assertRaisesRegex(RuntimeError, "clipboard changed"):
            owner._commit("中文")
        owner._publish.assert_not_called()
        run.assert_not_called()

    def test_aggregate_limit_still_aborts_before_paste(self):
        owner, _, namespace, run = self.fixture()
        namespace["MAX_BYTES"] = 8
        self.snapshot_source(owner, [(22, "UTF8_STRING", b"12345"), (23, "image/png", b"67890")])
        with self.assertRaisesRegex(RuntimeError, "too large"):
            owner._commit("中文")
        owner._publish.assert_not_called()
        run.assert_not_called()

    def reader_source(self, owner, values):
        readers = []
        properties = list(values)
        allocated, last_id = set(), [300]

        def create(*args, **kwargs):
            # Model python-xlib: start at the most recently allocated ID,
            # immediately reusing it if destroy() has already freed it.
            resource_id = last_id[0]
            while resource_id in allocated:
                resource_id += 1
            last_id[0] = resource_id
            allocated.add(resource_id)
            reader = SimpleNamespace(id=resource_id, convert_selection=Mock(),
                                     destroy=Mock(side_effect=lambda: allocated.remove(resource_id)),
                                     delete_property=Mock(),
                                     get_full_property=Mock(side_effect=lambda *args: properties.pop(0)))
            readers.append(reader)
            return reader

        owner.d.screen = lambda: SimpleNamespace(root=SimpleNamespace(create_window=create))
        return readers

    def test_timeout_reply_cannot_satisfy_next_read_of_same_target(self):
        owner, clock, namespace, _ = self.fixture()
        readers = self.reader_source(owner, [SimpleNamespace(property_type=22, format=8, value=b"current")])

        def timeout(deadline):
            clock.now = deadline
            return None

        owner._event = timeout
        with self.assertRaises(TimeoutError):
            owner._read(22, 1)
        readers[0].destroy.assert_not_called()
        late = SimpleNamespace(type=namespace["X"].SelectionNotify,
                               requestor=readers[0], target=22, selection=owner.clipboard, property=owner.read_property)
        late_failure = SimpleNamespace(type=namespace["X"].SelectionNotify,
                                       requestor=readers[0], target=22, selection=owner.clipboard, property=0)
        events = [late, late_failure, "wrong-selection"]

        def event(deadline):
            if events:
                next_event = events.pop(0)
                if next_event == "wrong-selection":
                    return SimpleNamespace(type=namespace["X"].SelectionNotify, requestor=readers[1],
                                           target=22, selection=999, property=0)
                return next_event
            return SimpleNamespace(type=namespace["X"].SelectionNotify,
                                   requestor=readers[1], target=22, selection=owner.clipboard, property=owner.read_property)

        owner._event = event
        self.assertEqual(owner._read(22, 2), (22, 8, b"current"))
        readers[0].get_full_property.assert_not_called()
        readers[1].get_full_property.assert_called_once()
        self.assertNotEqual(readers[0].id, readers[1].id, "a timed-out requestor ID must not be reused")
        readers[0].destroy.assert_called_once()
        readers[1].destroy.assert_not_called()
        self.assertIs(owner._snapshot_reader, readers[1], "only the latest reader remains alive")
        self.assertEqual(owner.window.id, 100, "snapshot reads must not replace the selection owner")

    def test_incremental_read_ignores_old_reader_properties(self):
        owner, _, namespace, _ = self.fixture()
        readers = self.reader_source(owner, [SimpleNamespace(property_type=owner.incr, format=32, value=[6]),
                                            SimpleNamespace(property_type=22, format=8, value=b"abc"),
                                            SimpleNamespace(property_type=22, format=8, value=b"def"),
                                            SimpleNamespace(property_type=22, format=8, value=b"")])
        events = ["notify", "stale", "chunk", "chunk", "chunk"]

        def event(deadline):
            kind = events.pop(0)
            if kind == "notify":
                return SimpleNamespace(type=namespace["X"].SelectionNotify, requestor=readers[0],
                                       target=22, selection=owner.clipboard, property=owner.read_property)
            return SimpleNamespace(type=namespace["X"].PropertyNotify,
                                   window=SimpleNamespace(id=299) if kind == "stale" else readers[0],
                                   atom=owner.read_property, state=namespace["X"].PropertyNewValue)

        owner._event = event
        self.assertEqual(owner._read(22, 5), (22, 8, b"abcdef"))
        self.assertEqual(readers[0].get_full_property.call_count, 4)
        self.assertEqual(readers[0].delete_property.call_count, 5)
        readers[0].destroy.assert_not_called()

    def test_single_format_size_limit_is_not_downgraded_to_skippable_error(self):
        owner, _, namespace, _ = self.fixture()
        namespace["MAX_BYTES"] = 3
        readers = self.reader_source(owner, [SimpleNamespace(property_type=22, format=8, value=b"1234")])
        owner._event = lambda deadline: SimpleNamespace(type=namespace["X"].SelectionNotify,
            requestor=readers[0], target=22, selection=owner.clipboard, property=owner.read_property)
        with self.assertRaisesRegex(OverflowError, "too large"):
            owner._read(22, 1)
        readers[0].destroy.assert_not_called()
        readers[0].delete_property.assert_called_with(owner.read_property)


if __name__ == "__main__":
    unittest.main()

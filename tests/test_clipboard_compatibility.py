import ast
import asyncio
import io
import logging
import os
import tempfile
from pathlib import Path
from urllib.parse import urlparse, unquote
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock

from PIL import Image

SOURCE = Path(__file__).resolve().parents[1] / "root/lsiopy/lib/python3.12/site-packages/selkies/input_handler.py"


def reader(spawn):
    cls = next(n for n in ast.parse(SOURCE.read_text(encoding="utf-8-sig")).body
               if isinstance(n, ast.ClassDef) and n.name == "WebRTCInput")
    names = {"_get_clipboard_lock", "_clipboard_command", "read_clipboard", "_read_clipboard_unlocked", "_sync_clipboard_if_changed"}
    cls.body = [m for m in cls.body if getattr(m, "name", "") in names]
    module = ast.Module(body=[cls], type_ignores=[])
    scope = dict(asyncio=asyncio, io=io, Image=Image, Path=Path, urlparse=urlparse, unquote=unquote, env_truthy=lambda *_: False,
                 subprocess=SimpleNamespace(create_subprocess_exec=spawn, PIPE=-1),
                 logger_webrtc_input=logging.getLogger("clipboard-test"),
                 CLIPBOARD_TARGET_TIMEOUT=.02, CLIPBOARD_DATA_TIMEOUT=.02, CLIPBOARD_TEXT_TIMEOUT=.02)
    exec(compile(module, str(SOURCE), "exec"), scope)
    obj = scope["WebRTCInput"]()
    obj.is_wayland = False
    obj.test_scope = scope
    return obj


def process(data):
    return SimpleNamespace(returncode=0, communicate=AsyncMock(return_value=(data, b"")))


class ClipboardCompatibility(unittest.IsolatedAsyncioTestCase):
    async def test_mime_only_text_is_read_without_utf8_string(self):
        for target in ("text/plain", "text/plain;charset=utf-8", "UTF8_STRING"):
            obj = reader(AsyncMock(side_effect=[process(target.encode()), process("中文\n".encode())]))
            self.assertEqual(await obj.read_clipboard(), ("中文\n", "text/plain"))

    async def test_image_timeout_reaps_process_and_reads_available_text(self):
        stopped = []
        calls = 0
        async def communicate():
            nonlocal calls
            calls += 1
            if calls == 1:
                await asyncio.sleep(2)
            return b"", b""
        child = SimpleNamespace(returncode=None, communicate=communicate)
        def kill():
            stopped.append(True)
            child.returncode = -9
        child.kill = kill
        obj = reader(AsyncMock(side_effect=[process(b"image/png\ntext/plain"), child, process(b"fallback")]))
        self.assertEqual(await obj.read_clipboard(True), ("fallback", "text/plain"))
        self.assertEqual(stopped, [True])
        self.assertEqual(calls, 2)

    async def test_tiff_is_converted_to_browser_png(self):
        output = io.BytesIO()
        Image.new("RGB", (2, 3), "red").save(output, "TIFF")
        obj = reader(AsyncMock(side_effect=[process(b"image/tiff"), process(output.getvalue())]))
        payload, mime = await obj.read_clipboard(True)
        self.assertEqual(mime, "image/png")
        with Image.open(io.BytesIO(payload)) as result:
            self.assertEqual(result.size, (2, 3))
            self.assertEqual(result.convert("RGB").getpixel((0, 0)), (255, 0, 0))

    async def test_manual_pull_resends_same_content_and_mime_changes_are_not_deduplicated(self):
        obj = reader(AsyncMock())
        obj.enable_binary_clipboard = "true"
        obj.last_clipboard_data_bytes = b"same"
        obj.last_clipboard_mime = "text/plain"
        obj._read_clipboard_unlocked = AsyncMock(return_value=("same", "text/plain"))
        obj.on_clipboard_read = AsyncMock()
        self.assertFalse(await obj._sync_clipboard_if_changed())
        self.assertTrue(await obj._sync_clipboard_if_changed(force=True))
        obj._read_clipboard_unlocked.return_value = (b"same", "image/png")
        self.assertTrue(await obj._sync_clipboard_if_changed())
        self.assertEqual(obj.on_clipboard_read.await_count, 2)

    async def test_file_image_is_local_and_confined_to_config(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "copied.png"
            Image.new("RGB", (2, 2), "blue").save(path)
            obj = reader(AsyncMock(side_effect=[process(b"text/uri-list"), process(path.as_uri().encode())]))
            obj.test_scope["Path"] = lambda value: Path(tmp) if value == "/config" else Path(value.lstrip("/") if os.name == "nt" else value)
            payload, mime = await obj.read_clipboard(True)
            self.assertEqual(mime, "image/png")
            self.assertEqual(payload, path.read_bytes())
            for uri in ("https://example.invalid/image.png", "file:///etc/passwd"):
                obj = reader(AsyncMock(side_effect=[process(b"text/uri-list"), process(uri.encode())]))
                self.assertEqual(await obj.read_clipboard(True), (None, None))


if __name__ == "__main__":
    unittest.main()

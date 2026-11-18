"""Run inside an isolated Xvfb with the image's /lsiopy/bin/python."""
import base64
from collections import deque
import subprocess
import time

from Xlib import X, XK, display, protocol
from selkies.x11_text_paste import SelectionOwner


def exercise(advertise_ping):
    d = display.Display()
    root = d.screen().root
    editor = root.create_window(0, 0, 200, 50, 0, X.CopyFromParent, event_mask=X.KeyPressMask)
    clipboard, targets, png, utf8, prop, ping, protocols = map(d.intern_atom, (
        "CLIPBOARD", "TARGETS", "image/png", "UTF8_STRING", "_TEST_RESULT", "_NET_WM_PING", "WM_PROTOCOLS"))
    if advertise_ping:
        editor.set_wm_protocols([ping])
    editor.map()
    editor.set_input_focus(X.RevertToParent, X.CurrentTime)
    d.sync()

    deferred = deque()

    def read(target):
        editor.convert_selection(clipboard, target, prop, X.CurrentTime)
        d.flush()
        while True:
            event = d.next_event()
            if event.type == X.SelectionNotify:
                assert event.property == prop
                result = editor.get_full_property(prop, X.AnyPropertyType).value
                editor.delete_property(prop)
                d.sync()
                return result
            deferred.append(event)

    picture = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jGQAAAABJRU5ErkJggg==")
    subprocess.run(["xclip", "-selection", "clipboard", "-i", "-t", "image/png"],
                   input=picture, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    assert read(png) == picture
    bridge = SelectionOwner(d.get_display_name())
    try:
        for word in ("开会", "明天见"):
            job = bridge.submit(word)
            inserted = None
            deadline = time.monotonic() + 12
            while (not job.done() or inserted is None) and time.monotonic() < deadline:
                if not deferred and not d.pending_events():
                    if job.done():
                        job.result()
                    time.sleep(.002)
                    continue
                event = deferred.popleft() if deferred else d.next_event()
                if event.type == X.ClientMessage and event.client_type == protocols and event.data[1][0] == ping:
                    if inserted is None:
                        # Reading during the ownership-change callback cannot
                        # acknowledge the upcoming paste shortcut.
                        assert read(utf8) == word.encode()
                    reply = protocol.event.ClientMessage(window=root, client_type=protocols, data=event.data)
                    root.send_event(reply, event_mask=X.StructureNotifyMask | X.SubstructureRedirectMask)
                    d.flush()
                elif event.type == X.KeyPress and event.detail == d.keysym_to_keycode(XK.string_to_keysym("v")):
                    # A text probe and the editor paste use the SAME X client.
                    # The second conversion is addressed to the then-current owner.
                    assert read(utf8) == word.encode()
                    time.sleep(.35 if advertise_ping else .075)
                    inserted = read(png if png in read(targets) else utf8)
            job.result(timeout=1)
            assert inserted == word.encode(), "editor received image or wrong text"
            assert read(png) == picture, "explicit paste must still see the original PNG"
    finally:
        editor.destroy()
        d.close()
    print("PASS consecutive candidates after image copy, WM ping =", advertise_ping)


if __name__ == "__main__":
    exercise(True)
    exercise(False)

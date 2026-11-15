"""Small shared X11 snapshot, using the already-installed python-xlib.

The notification HTTP handler and fallback poller share one connection rather
than spawning xprop/xdotool for every property of every candidate window.
"""
import threading
import time


class WindowReader:
    def __init__(self, ttl=0.3):
        self.ttl = ttl
        self.lock = threading.Lock()
        self.connection = None
        self.atoms = {}
        self.cached = None
        self.expires = 0
        self.retry_at = 0

    def snapshot(self):
        with self.lock:
            now = time.monotonic()
            if self.cached is not None and now < self.expires:
                return self.cached
            if now < self.retry_at:
                return None
            try:
                self.cached = self._read()
                self.expires = time.monotonic() + self.ttl
                return self.cached
            except Exception:
                if self.connection is not None:
                    try:
                        self.connection.close()
                    except Exception:
                        pass
                self.connection = None
                self.atoms.clear()
                self.cached = None
                self.retry_at = time.monotonic() + 2
                return None  # Caller retains the existing command fallback.

    def _read(self):
        from Xlib import X, Xutil, display, error
        if self.connection is None:
            self.connection = display.Display()
        conn = self.connection
        root = conn.screen().root

        def atom(name):
            if name not in self.atoms:
                self.atoms[name] = conn.intern_atom(name)
            return self.atoms[name]

        def prop(window, name):
            value = window.get_full_property(atom(name), X.AnyPropertyType)
            return value.value if value is not None else None

        ids = prop(root, "_NET_CLIENT_LIST")
        if ids is None:
            raise RuntimeError("window manager has no EWMH client list")
        windows = []
        for wid in list(ids):
            try:
                window = conn.create_resource_object("window", int(wid))
                title = prop(window, "_NET_WM_NAME")
                if isinstance(title, bytes):
                    title = title.decode("utf-8", errors="replace")
                if not isinstance(title, str) or not title:
                    title = window.get_wm_name() or ""
                if isinstance(title, bytes):
                    title = title.decode("utf-8", errors="replace")
                states = prop(window, "_NET_WM_STATE")
                types = prop(window, "_NET_WM_WINDOW_TYPE")
                states = set(states) if states is not None else set()
                types = set(types) if types is not None else set()
                hints = window.get_wm_hints()
                # python-xlib returns rq.DictWrapper, which has [] but no .get().
                flags = hints["flags"] if hints is not None else 0
                windows.append({
                    "wid": str(wid), "title": str(title),
                    "wm_class": " ".join(window.get_wm_class() or ()),
                    "visible": atom("_NET_WM_STATE_HIDDEN") not in states,
                    "normal": atom("_NET_WM_WINDOW_TYPE_NORMAL") in types,
                    "transient": bool(window.get_wm_transient_for()),
                    "attention": bool(atom("_NET_WM_STATE_DEMANDS_ATTENTION") in states or
                                      flags & Xutil.UrgencyHint),
                })
            except error.BadWindow:
                continue  # A window closed during this snapshot.
        focused = conn.get_input_focus().focus
        focused_id = getattr(focused, "id", focused)
        by_id = {int(info["wid"]): info for info in windows}
        # Qt/Electron may focus a child instead of the managed top-level window.
        for _ in range(16):
            if focused_id in by_id:
                return {"active": by_id[focused_id], "windows": windows}
            if focused_id in (None, X.NONE, X.PointerRoot, root.id):
                break
            try:
                focused = conn.create_resource_object("window", int(focused_id)).query_tree().parent
                focused_id = getattr(focused, "id", focused)
            except error.BadWindow:
                break
        return {"active": None, "windows": windows}

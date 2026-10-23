#!/usr/bin/env python3
"""Native receiver used by the session auth bridge.

The authenticated manager supplies a short-lived browser geometry lease and
accepts local COPY selections. Idle InputOnly windows have empty input shapes.
"""
import argparse
import json
import os
import select
import stat
import time
from urllib.parse import unquote, urlsplit


def local_files(payload):
    if len(payload) > 65536:
        raise ValueError("uri-list-too-large")
    result = []
    for line in payload.decode("utf-8", errors="strict").splitlines():
        if not line or line.startswith("#"):
            continue
        uri = urlsplit(line)
        if (uri.scheme != "file" or uri.netloc not in ("", "localhost")
                or uri.query or uri.fragment):
            raise ValueError("local-file-uri-required")
        path = unquote(uri.path, errors="strict")
        if (not path.startswith("/") or "\x00" in path
                or ".." in path.split("/")):
            raise ValueError("invalid-path")
        # Probe only. Production must open with O_NOFOLLOW and check fstat,
        # enforce allowed roots, limits and session identity before copying.
        info = os.lstat(path)
        if not stat.S_ISREG(info.st_mode) or not os.access(path, os.R_OK):
            raise ValueError("readable-regular-file-required")
        result.append((path, info.st_size))
        if len(result) > 16:
            raise ValueError("too-many-files")
    if not result:
        raise ValueError("empty-uri-list")
    return result


def map_rect(dock, surface, remote):
    """DOM CSS pixels -> backing pixels, clipped to the streamed surface.

    surface must be the actual rendered canvas, excluding letterboxes. DPR
    is already represented by remote / surface and must not be applied again.
    """
    import math
    x, y, width, height = dock
    sx, sy, sw, sh = surface
    rw, rh = remote
    if min(width, height, sw, sh, rw, rh) <= 0:
        raise ValueError("invalid-geometry")
    left, top = max(x, sx), max(y, sy)
    right, bottom = min(x + width, sx + sw), min(y + height, sy + sh)
    if right <= left or bottom <= top:
        return None
    x0, y0 = math.floor((left - sx) * rw / sw), math.floor((top - sy) * rh / sh)
    x1, y1 = math.ceil((right - sx) * rw / sw), math.ceil((bottom - sy) * rh / sh)
    return x0, y0, x1 - x0, y1 - y0


def run(manager):
    rect = manager.geometry() or [0, 0, 1, 1]
    from Xlib import X, Xatom, display, protocol
    from Xlib.ext import shape

    connection = display.Display()
    root = connection.screen().root
    if not connection.has_extension("SHAPE"):
        raise RuntimeError("X Shape extension required for idle input transparency")
    atoms = {name: connection.intern_atom(name) for name in (
        "XdndAware", "XdndEnter", "XdndPosition", "XdndStatus", "XdndLeave",
        "XdndDrop", "XdndFinished", "XdndSelection", "XdndTypeList",
        "XdndActionCopy", "text/uri-list", "AXI_XDND_PROBE_DATA", "INCR")}
    x, y, width, height = rect
    target = root.create_window(x, y, width, height, 0, 0, X.InputOnly,
                                X.CopyFromParent, override_redirect=True)
    target.change_property(atoms["XdndAware"], Xatom.ATOM, 32, [5])
    target.shape_rectangles(shape.SO.Set, shape.SK.Input, X.Unsorted, 0, 0, [])
    target.change_property(connection.intern_atom("_AXI_DOWNLOAD_TARGET"), Xatom.CARDINAL, 32, [1])
    target.map()
    connection.sync()
    source = None
    source_version = 0
    accepted = False
    armed = False
    awaiting_selection = False
    deadline = 0
    release_grace = 0
    drag_lease = None
    offered = False

    def emit(phase, **fields):
        manager.event(phase, **fields)

    def send(name, data):
        if source:
            source.send_event(protocol.event.ClientMessage(
                window=source.id, client_type=atoms[name], data=(32, data)),
                event_mask=0)
            connection.flush()

    def reset(phase):
        nonlocal source, accepted, awaiting_selection
        source, accepted, awaiting_selection = None, False, False
        emit(phase)

    emit("ready", window=target.id, rect=rect)
    try:
        while True:
            current_rect = manager.geometry()
            if current_rect and list(current_rect) != list(rect):
                rect = current_rect
                x, y, width, height = rect
                target.configure(x=x, y=y, width=width, height=height)
            pointer = root.query_pointer()
            owner = connection.get_selection_owner(atoms["XdndSelection"])
            # Arm at drag start, before the first crossing of the rectangle.
            # Arming only after a pointer enters races a fast button release.
            should_arm = bool(current_rect and owner and pointer.mask & X.Button1Mask)
            if should_arm:
                release_grace = time.monotonic() + .35
            # The source's queued Drop/Position may arrive after ButtonRelease.
            # Removing the input shape in that gap synthesizes a premature Leave.
            should_arm = should_arm or (current_rect and armed and time.monotonic() < release_grace)
            # Retain the target until SelectionNotify after button release.
            should_arm = bool(current_rect and (should_arm or awaiting_selection))
            if should_arm != armed:
                armed = should_arm
                target.shape_rectangles(shape.SO.Set, shape.SK.Input, X.Unsorted,
                                        0, 0, [(0, 0, width, height)] if armed else [])
                if armed:
                    target.configure(stack_mode=X.Above)
                connection.flush()
                emit("armed" if armed else "idle")
            while connection.pending_events():
                event = connection.next_event()
                if event.type == X.ClientMessage and event.data[0] == 32:
                    data = event.data[1]
                    kind = event.client_type
                    if kind == atoms["XdndEnter"]:
                        drag_lease = manager.current()
                        source = connection.create_resource_object("window", data[0])
                        source_version = min(5, data[1] >> 24)
                        offers = list(data[2:5])
                        if data[1] & 1:
                            prop = source.get_property(atoms["XdndTypeList"], Xatom.ATOM, 0, 256)
                            offers = list(prop.value) if prop and not prop.bytes_after else []
                        offered = source_version >= 3 and atoms["text/uri-list"] in offers
                        accepted = False
                        deadline = time.monotonic() + 15
                        emit("enter", uri_list=offered, version=source_version)
                    elif source and data[0] == source.id:
                        if kind == atoms["XdndPosition"]:
                            # Always ask for position updates; accept COPY only.
                            valid = offered and data[4] == atoms["XdndActionCopy"]
                            accepted = valid
                            send("XdndStatus", [target.id, 3 if valid else 2, 0, 0,
                                                atoms["XdndActionCopy"] if valid else 0])
                            deadline = time.monotonic() + 15
                            emit("position", accepted=valid)
                        elif kind == atoms["XdndLeave"]:
                            reset("leave")
                        elif kind == atoms["XdndDrop"]:
                            if accepted:
                                awaiting_selection = True
                                deadline = time.monotonic() + 3
                                target.convert_selection(atoms["XdndSelection"], atoms["text/uri-list"],
                                                         atoms["AXI_XDND_PROBE_DATA"], data[2])
                                connection.flush()
                                emit("drop")
                            else:
                                send("XdndFinished", [target.id, 0, 0, 0, 0])
                                reset("rejected")
                elif event.type == X.SelectionNotify and awaiting_selection:
                    try:
                        if event.property != atoms["AXI_XDND_PROBE_DATA"]:
                            raise ValueError("selection-conversion-failed")
                        prop = target.get_property(event.property, X.AnyPropertyType, 0, 16385, delete=True)
                        if (not prop or prop.property_type != atoms["text/uri-list"]
                                or prop.format != 8 or prop.bytes_after):
                            raise ValueError("unsupported-selection-transfer")
                        files = local_files(bytes(prop.value))
                        manager.submit(files, drag_lease)
                        # Probe has consumed a COPY only; never signal a move.
                        send("XdndFinished", [target.id, 1, atoms["XdndActionCopy"], 0, 0])
                        reset("received")
                    except (ValueError, OSError, UnicodeError) as error:
                        manager.phase, manager.error = "error", "文件来源不受支持、任务已满或会话已失效"
                        send("XdndFinished", [target.id, 0, 0, 0, 0])
                        reset("rejected")
            if source and (time.monotonic() > deadline or (not awaiting_selection and
                          not pointer.mask & X.Button1Mask and time.monotonic() > release_grace)):
                if awaiting_selection:
                    send("XdndFinished", [target.id, 0, 0, 0, 0])
                reset("cancelled")
            select.select([connection.fileno()], [], [], 0.02)
    finally:
        target.destroy()
        connection.flush()
        connection.close()

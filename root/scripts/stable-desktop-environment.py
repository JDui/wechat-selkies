#!/usr/bin/env python3
"""Persist existing OS identifiers across container replacement, before apps start.

Do not rotate identifiers, modify account data, or expose identifiers in logs.
"""
import os
from pathlib import Path
import re
import tempfile
import uuid


def valid_id(path):
    try:
        value = path.read_text(encoding="ascii").strip()
        return value if re.fullmatch(r"[0-9a-fA-F]{32}", value) and int(value, 16) else None
    except (OSError, UnicodeError):
        return None


def atomic_write(path, text, mode=0o644):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp = tempfile.mkstemp(prefix=".identity-", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="ascii") as stream:
            stream.write(text + "\n")
        os.chmod(temp, mode)
        os.replace(temp, path)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def stabilize(root=Path("/")):
    config = root / "config"
    state = config / ".system-identity"
    state.mkdir(mode=0o700, parents=True, exist_ok=True)
    if state.is_symlink():
        raise RuntimeError("identity directory must not be a symlink")
    os.chmod(state, 0o700)
    # Existing installations retain their current identity on first migration.
    # A fresh config gets its own ID instead of an ID baked into the base image.
    existing_install = (config / ".xwechat").exists() or (config / "xwechat_files").exists()
    system_id = None
    for relative, name in (("etc/machine-id", "machine-id"), ("var/lib/dbus/machine-id", "dbus-machine-id")):
        target, saved = root / relative, state / name
        if saved.is_symlink():
            raise RuntimeError("saved identity must not be a symlink")
        value = valid_id(saved)
        if saved.exists() and not value:
            raise RuntimeError("saved identity is invalid; refusing silent rotation")
        initialized = value is None
        if initialized:
            value = (valid_id(target) if existing_install else None) or system_id or uuid.uuid4().hex
            atomic_write(saved, value, 0o600)
        if system_id is None:
            system_id = value
        if valid_id(target) != value:
            # Preserve the usual dbus -> /etc/machine-id symlink if equivalent.
            if target.is_symlink():
                resolved = target.resolve()
                if not resolved.is_relative_to(root.resolve()):
                    raise RuntimeError("identity symlink escapes root")
                atomic_write(resolved, value)
            else:
                atomic_write(target, value)
        print("[desktop-environment] " + name + (" saved" if initialized else " restored"))
    atomic_write(root / "run/selkies-system-identity-ready", "ready")


if __name__ == "__main__":
    if os.getenv("PERSIST_SYSTEM_IDENTITY", "true").lower() not in {"0", "false", "no", "off"}:
        stabilize()

#!/usr/bin/env python3
import os
import pathlib
import sys


DEFAULT_MAX_BYTES = 4 * 1024 * 1024
MIN_MAX_BYTES = 64 * 1024
READ_CHUNK_BYTES = 16 * 1024


def parse_max_bytes(raw):
    try:
        value = int(str(raw).strip())
    except Exception:
        return DEFAULT_MAX_BYTES
    if value < MIN_MAX_BYTES:
        return DEFAULT_MAX_BYTES
    return value


def trim_existing_log(handle, max_bytes, incoming_bytes):
    try:
        handle.seek(0, os.SEEK_END)
        current_size = handle.tell()
    except OSError:
        return
    incoming_size = len(incoming_bytes)
    if incoming_size >= max_bytes:
        handle.seek(0)
        handle.truncate(0)
        return
    if current_size + incoming_size <= max_bytes:
        return

    keep_size = max(0, max_bytes - incoming_size)
    if keep_size > 0:
        handle.seek(max(0, current_size - keep_size), os.SEEK_SET)
        tail = handle.read(keep_size)
    else:
        tail = b""
    handle.seek(0)
    handle.truncate(0)
    if tail:
        handle.write(tail)
    handle.flush()


def main():
    if len(sys.argv) < 2:
        sys.stderr.write("usage: size_limited_log_writer.py LOG_PATH [MAX_BYTES]\n")
        return 2

    log_path = pathlib.Path(sys.argv[1])
    max_bytes = parse_max_bytes(sys.argv[2] if len(sys.argv) > 2 else os.getenv("SIZE_LIMITED_LOG_MAX_BYTES"))
    log_path.parent.mkdir(parents=True, exist_ok=True)

    with log_path.open("a+b", buffering=0) as handle:
        while True:
            chunk = sys.stdin.buffer.read(READ_CHUNK_BYTES)
            if not chunk:
                break
            if len(chunk) > max_bytes:
                chunk = chunk[-max_bytes:]
            trim_existing_log(handle, max_bytes, chunk)
            handle.seek(0, os.SEEK_END)
            handle.write(chunk)
            handle.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

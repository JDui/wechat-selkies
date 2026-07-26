#!/usr/bin/env python3
import json
import os
import pathlib
import signal
import socket
import sys
import time

from lan_discovery_common import (
    SERVICE_TYPE,
    build_identity_payload,
    read_discovery_state,
)


STATE_PATH = pathlib.Path(
    os.getenv("NOTIFICATION_BRIDGE_MODE_PATH", "/config/state/notification-bridge.json")
)
STATUS_PATH = pathlib.Path(
    os.getenv("SELKIES_LAN_DISCOVERY_STATUS_PATH", "/config/state/lan-discovery-status.json")
)
POLL_SECONDS = max(
    0.5,
    min(10.0, float(os.getenv("SELKIES_LAN_DISCOVERY_POLL_SECONDS", "1") or "1")),
)
STOP_REQUESTED = False


def request_stop(_signum=None, _frame=None):
    global STOP_REQUESTED
    STOP_REQUESTED = True


def atomic_write_status(payload):
    try:
        STATUS_PATH.parent.mkdir(parents=True, exist_ok=True)
        tmp = STATUS_PATH.with_suffix(STATUS_PATH.suffix + ".tmp")
        tmp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        tmp.replace(STATUS_PATH)
    except OSError as exc:
        print(f"[lan-discovery] unable to write status: {exc}", flush=True)


def resolve_advertise_address():
    configured = str(os.getenv("SELKIES_LAN_ADVERTISE_ADDRESS", "") or "").strip()
    if configured:
        socket.inet_aton(configured)
        return configured

    probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        # UDP connect selects the host's default LAN route without sending traffic.
        probe.connect(("192.0.2.1", 9))
        address = probe.getsockname()[0]
    finally:
        probe.close()
    if not address or address.startswith("127."):
        raise RuntimeError("no non-loopback IPv4 address is available")
    return address


def build_service_info(ServiceInfo, state, address):
    identity = build_identity_payload(state)
    name = identity["name"]
    properties = {
        b"service": identity["service"].encode("utf-8"),
        b"name": name.encode("utf-8"),
        b"scheme": identity["scheme"].encode("ascii"),
        b"path": identity["path"].encode("utf-8"),
        b"http_port": str(identity["http_port"]).encode("ascii"),
        b"https_port": str(identity["https_port"]).encode("ascii"),
        b"identity": b"/.well-known/axisnsbox",
    }
    return ServiceInfo(
        SERVICE_TYPE,
        f"{name}.{SERVICE_TYPE}",
        addresses=[socket.inet_aton(address)],
        port=identity["https_port"],
        properties=properties,
        server=f"{name.lower()}.local.",
    )


def status_payload(state, running=False, address="", error=""):
    identity = build_identity_payload(state)
    return {
        "ok": not bool(error),
        "configured": identity["enabled"],
        "running": bool(running),
        "name": identity["name"],
        "address": address,
        "port": identity["https_port"],
        "service_type": SERVICE_TYPE,
        "error": str(error or ""),
        "updated_at": int(time.time()),
    }


def run():
    try:
        from zeroconf import IPVersion, ServiceInfo, Zeroconf
    except ImportError as exc:
        state = read_discovery_state(STATE_PATH)
        atomic_write_status(status_payload(state, error=f"zeroconf unavailable: {exc}"))
        raise

    zeroconf = Zeroconf(ip_version=IPVersion.V4Only)
    registered_info = None
    active_key = None
    last_error = ""
    try:
        while not STOP_REQUESTED:
            state = read_discovery_state(STATE_PATH)
            identity = build_identity_payload(state)
            address = ""
            if identity["enabled"]:
                try:
                    address = resolve_advertise_address()
                except Exception as exc:
                    last_error = str(exc)
            desired_key = (
                identity["enabled"],
                identity["name"],
                identity["http_port"],
                identity["https_port"],
                identity["path"],
                address,
            )
            if desired_key != active_key:
                if registered_info is not None:
                    try:
                        zeroconf.unregister_service(registered_info)
                    except Exception as exc:
                        print(f"[lan-discovery] unregister failed: {exc}", flush=True)
                    registered_info = None

                last_error = ""
                if identity["enabled"]:
                    try:
                        if not address:
                            address = resolve_advertise_address()
                        registered_info = build_service_info(ServiceInfo, state, address)
                        zeroconf.register_service(registered_info)
                        print(
                            f"[lan-discovery] advertising {identity['name']} at "
                            f"{address}:{identity['https_port']} ({SERVICE_TYPE})",
                            flush=True,
                        )
                    except Exception as exc:
                        registered_info = None
                        last_error = str(exc)
                        print(f"[lan-discovery] registration failed: {exc}", flush=True)
                else:
                    print("[lan-discovery] broadcasting disabled", flush=True)
                active_key = desired_key if (not identity["enabled"] or registered_info is not None) else None

            atomic_write_status(
                status_payload(
                    state,
                    running=registered_info is not None,
                    address=address if registered_info is not None else "",
                    error=last_error,
                )
            )
            time.sleep(POLL_SECONDS)
    finally:
        if registered_info is not None:
            try:
                zeroconf.unregister_service(registered_info)
            except Exception:
                pass
        zeroconf.close()
        state = read_discovery_state(STATE_PATH)
        atomic_write_status(status_payload(state, running=False))


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, request_stop)
    signal.signal(signal.SIGINT, request_stop)
    try:
        run()
    except Exception as exc:
        print(f"[lan-discovery] fatal error: {exc}", file=sys.stderr, flush=True)
        sys.exit(1)

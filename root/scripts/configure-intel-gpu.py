#!/usr/bin/env python3
"""Select an Intel VA-API device after the base image grants abc DRI access."""
import json
import os
from pathlib import Path
import re
import subprocess

ENV_DIR = Path("/run/s6/container_environment")
STATUS_PATH = Path("/run/selkies-intel-gpu.json")


def enabled(value):
    return value.split("|", 1)[0].strip().lower() in ("true", "1", "yes", "on")


def intel_node(node):
    if not re.fullmatch(r"/dev/dri/renderD\d+", str(node)) or not node.is_char_device():
        return False
    try:
        return (Path("/sys/class/drm") / node.name / "device/vendor").read_text().strip().lower() == "0x8086"
    except OSError:
        return False


def probe(node, driver):
    # Run with the same supplementary groups as the streaming service, not root.
    try:
        result = subprocess.run(
            ["s6-setuidgid", "abc", "env", f"LIBVA_DRIVER_NAME={driver}",
             "vainfo", "--display", "drm", "--device", str(node)],
            capture_output=True, text=True, timeout=8, check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return False, str(exc)
    output = result.stdout + result.stderr
    # The bundled pixelflux H.264 path needs normal EncSlice; decode-only and
    # low-power-only capabilities do not prove this path can create an encoder.
    supported = result.returncode == 0 and bool(re.search(
        r"VAProfileH264\w+\s*:\s*VAEntrypointEncSlice\s*(?:\n|$)", output
    ))
    return supported, output[-4000:]


def select(environ):
    result = {"backend": "cpu", "node": "", "driver": "", "reason": "", "probes": []}
    if enabled(environ.get("SELKIES_DEFAULT_USE_CPU", "false")) or enabled(environ.get("SELKIES_USE_CPU", "false")):
        result["reason"] = "CPU encoding explicitly requested"
        return result
    requested = environ.get("DRI_NODE", "auto").strip() or "auto"
    driver = environ.get("INTEL_VAAPI_DRIVER", "auto").strip() or "auto"
    if driver == "auto":
        driver = environ.get("LIBVA_DRIVER_NAME", "auto").strip() or "auto"
    if driver not in ("auto", "iHD", "i965"):
        result["reason"] = f"Unsupported Intel VA-API driver: {driver}"
        return result
    candidates = sorted(Path("/dev/dri").glob("renderD*")) if requested == "auto" else [Path(requested)]
    nodes = [node for node in candidates if intel_node(node)]
    if not nodes:
        result["reason"] = f"No mapped Intel render node ({requested})"
        return result
    for node in nodes:
        for choice in (("iHD", "i965") if driver == "auto" else (driver,)):
            ok, detail = probe(node, choice)
            result["probes"].append({"node": str(node), "driver": choice, "ok": ok, "detail": detail})
            if ok:
                result.update(backend="intel-vaapi", node=str(node), driver=choice,
                              reason="Intel H.264 EncSlice capability available; live encoding still requires validation")
                return result
    result["reason"] = "Intel H.264 encoding capability probe failed; see probes for driver/permission errors"
    return result


def configure(environ=None, env_dir=ENV_DIR, status_path=STATUS_PATH):
    environ = os.environ if environ is None else environ
    result = select(environ)
    values = {"DRI_NODE": result["node"]}
    if result["backend"] == "intel-vaapi":
        values["LIBVA_DRIVER_NAME"] = result["driver"]
    else:
        # Lock the backend too, so old browser settings cannot undo fallback.
        values.update(SELKIES_USE_CPU="true|locked", SELKIES_DEFAULT_USE_CPU="true")
    env_dir.mkdir(parents=True, exist_ok=True)
    for name, value in values.items():
        (env_dir / name).write_text(value, encoding="utf-8")
    status_path.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(f"[intel-gpu] {result['backend']}: {result['reason']} node={result['node']} driver={result['driver']}", flush=True)
    return result


if __name__ == "__main__":
    configure()

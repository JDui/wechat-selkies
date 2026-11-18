#!/usr/bin/env python3
"""Read-only VA-API preflight, with device access checked as the desktop user."""
import argparse
from datetime import datetime, timezone
import grp
import importlib.metadata
import json
import os
from pathlib import Path
import pwd
import re
import stat
import subprocess
import sys

NODE_PATTERN = re.compile(r"/dev/dri/renderD[0-9]+\Z")
PROFILE_PATTERN = re.compile(r"\b(VAProfile\w+)\s*:\s*(VAEntrypoint\w+)\b")
ENCODE_ENTRIES = {"VAEntrypointEncSlice", "VAEntrypointEncSliceLP"}


def command(argv, timeout=10, environ=None):
    try:
        result = subprocess.run(argv, capture_output=True, text=True, timeout=timeout,
                                check=False, env=environ)
        return {"exit_code": result.returncode, "timeout": False,
                "stdout": result.stdout[-20000:], "stderr": result.stderr[-20000:]}
    except subprocess.TimeoutExpired as exc:
        def text(value):
            return value.decode(errors="replace") if isinstance(value, bytes) else value or ""
        return {"exit_code": None, "timeout": True,
                "stdout": text(exc.stdout)[-20000:], "stderr": text(exc.stderr)[-20000:]}
    except OSError as exc:
        return {"exit_code": None, "timeout": False, "stdout": "", "stderr": str(exc)}


def parse_vainfo(result):
    output = result.get("stdout", "") + "\n" + result.get("stderr", "")
    profiles = sorted(set(PROFILE_PATTERN.findall(output)))
    entries = sorted(entry for profile, entry in profiles if profile == "VAProfileAV1Profile0")
    passed = result.get("exit_code") == 0 and not result.get("timeout")
    return {"profiles": [{"profile": profile, "entrypoint": entry} for profile, entry in profiles],
            "av1_profile0_entries": entries,
            "av1_encode_entry": passed and bool(ENCODE_ENTRIES.intersection(entries)),
            "av1_decode_entry": passed and "VAEntrypointVLD" in entries}


def identity():
    uid, gid = os.geteuid(), os.getegid()
    try:
        name = pwd.getpwuid(uid).pw_name
    except KeyError:
        name = str(uid)
    return {"user": name, "uid": uid, "gid": gid, "supplementary_gids": sorted(os.getgroups())}


def inspect_node(node, driver):
    result = {"node": node, "identity": identity(), "open_read_write": False}
    if not NODE_PATTERN.fullmatch(node):
        return dict(result, reason_code="INVALID_RENDER_NODE")
    try:
        info = os.stat(node)
        try:
            owner = pwd.getpwuid(info.st_uid).pw_name
        except KeyError:
            owner = str(info.st_uid)
        try:
            group = grp.getgrgid(info.st_gid).gr_name
        except KeyError:
            group = str(info.st_gid)
        result["device"] = {"uid": info.st_uid, "gid": info.st_gid, "owner": owner,
                            "group": group, "mode": stat.filemode(info.st_mode),
                            "character_device": stat.S_ISCHR(info.st_mode)}
        if not stat.S_ISCHR(info.st_mode):
            return dict(result, reason_code="NOT_CHARACTER_DEVICE")
        handle = os.open(node, os.O_RDWR | os.O_CLOEXEC)
        os.close(handle)
        result["open_read_write"] = True
    except OSError as exc:
        return dict(result, reason_code="DEVICE_OPEN_FAILED", error=str(exc), errno=exc.errno)
    environment = os.environ.copy()
    environment["LIBVA_DRIVER_NAME"] = driver
    result["vainfo"] = command(["vainfo", "--display", "drm", "--device", node], environ=environment)
    result.update(parse_vainfo(result["vainfo"]))
    if result["vainfo"]["timeout"]:
        code = "VAINFO_TIMEOUT"
    elif result["vainfo"]["exit_code"] != 0:
        code = "VAINFO_FAILED"
    elif not result["av1_encode_entry"]:
        code = "AV1_ENCODE_ENTRY_MISSING"
    else:
        code = "CAPABILITY_AVAILABLE"
    return dict(result, reason_code=code)


def inspect_as_user(node, driver, user):
    try:
        target = pwd.getpwnam(user)
    except KeyError:
        return {"node": node, "reason_code": "DESKTOP_USER_MISSING", "user": user}
    if os.geteuid() == target.pw_uid:
        return inspect_node(node, driver)
    if os.geteuid() != 0:
        return {"node": node, "reason_code": "DESKTOP_USER_MISMATCH", "identity": identity(), "user": user}
    result = command(["s6-setuidgid", user, sys.executable, str(Path(__file__).resolve()),
                      "--worker", "--node", node, "--driver", driver], timeout=14)
    try:
        detail = json.loads(result["stdout"])
        if result["exit_code"] == 0 and detail.get("identity", {}).get("uid") == target.pw_uid:
            return detail
    except (ValueError, TypeError):
        pass
    return {"node": node, "reason_code": "DESKTOP_USER_PROBE_FAILED", "worker": result}


def selected_node():
    try:
        status = json.loads(Path("/run/selkies-amd-gpu.json").read_text())
        if NODE_PATTERN.fullmatch(str(status.get("node", ""))):
            return status["node"]
    except (OSError, ValueError):
        pass
    try:
        value = Path("/run/s6/container_environment/DRI_NODE").read_text().strip()
    except OSError:
        value = os.environ.get("DRI_NODE", "").strip()
    return value if NODE_PATTERN.fullmatch(value) else None


def runtime_versions():
    paths = {"private": ["/opt/selkies-hevc"],
             "legacy": [str(path) for path in Path("/lsiopy/lib").glob("python*/site-packages")]}
    result = {}
    for label, roots in paths.items():
        found = [dist.version for dist in importlib.metadata.distributions(path=roots)
                 if (dist.metadata.get("Name") or "").lower() == "pixelflux"]
        result[label] = found[0] if len(found) == 1 else None
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--node", default="auto", help="Default: the service-selected render node")
    parser.add_argument("--user", default="abc", help="Desktop service account, default abc")
    parser.add_argument("--driver", default="radeonsi")
    parser.add_argument("--worker", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.worker:
        print(json.dumps(inspect_node(args.node, args.driver), ensure_ascii=False))
        return 0
    selected = selected_node()
    target = selected if args.node == "auto" else args.node
    nodes = sorted({str(path) for path in Path("/dev/dri").glob("renderD*")})
    if target and target not in nodes:
        nodes.append(target)
    probes = [inspect_as_user(node, args.driver, args.user) for node in nodes]
    target_probe = next((probe for probe in probes if probe["node"] == target), None)
    passed = bool(target_probe and target_probe.get("reason_code") == "CAPABILITY_AVAILABLE")
    packages = command(["dpkg-query", "-W", "-f=${Package}\t${Version}\n",
                        "mesa-va-drivers", "libva2", "libva-drm2", "vainfo"], timeout=8)
    report = {"schema_version": 1, "generated_at": datetime.now(timezone.utc).isoformat(),
              "service_selected_node": selected, "target_node": target,
              "explicit_node_override": args.node != "auto", "desktop_user": args.user,
              "driver": args.driver, "package_versions": packages,
              "pixelflux_versions": runtime_versions(), "nodes": probes,
              "preflight_passed": passed,
              "reason_code": target_probe.get("reason_code") if target_probe else "SELECTED_NODE_MISSING",
              "live_encoding_verified": False}
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if passed else 2


if __name__ == "__main__":
    raise SystemExit(main())

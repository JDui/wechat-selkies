# WeChat-Selkies 1.28 Stability Validation

Date: 2026-05-29

## Scope

This validation covers the 1.28 inactive-streaming fix, CPU H.264 corruption regression, JPEG and striped encoder compatibility, clipboard notification UI cleanup, watchdog startup, and release packaging.

## Fix Summary

- H.264 inactive mode now restarts capture when entering or leaving the inactive profile instead of send-throttling encoded chunks. This keeps encoded frame order intact for CPU and VAAPI H.264 paths.
- H.264 dynamic inactive send-loop pruning is disabled, so delta/keyframe order is preserved.
- Pipeline reset is emitted once per capture restart and clears frame ID/timestamp state.
- `LOW_LATENCY_STATE` updates now apply FPS, CRF, sample percentage, and paint-over settings, then restart H.264 capture when the effective profile changes.
- Clipboard image paste no longer creates the old top-right toast container. Clipboard warnings/errors are routed into the unified activity surface.
- `/config/logs` is prepared as `abc:abc`, and startup scripts fall back to `/tmp/*.log` if the configured log path is not writable. This restores `process-watchdog.sh` and healthcheck behavior.
- Runtime encoder compatibility accepts both `encoder` and legacy `encoder_rtc` keys.
- s6 `run` scripts are pinned to LF line endings in `.gitattributes`.

## Validation Matrix

| Area | Check | Evidence | Result | Notes |
| --- | --- | --- | --- | --- |
| Static backend | Python compile | `python -m py_compile root/lsiopy/lib/python3.12/site-packages/selkies/selkies.py` | Pass | No syntax errors. |
| Static frontend | JS syntax | Bundled Node `--check` on `selkies-paste-image.js` and `selkies-runtime-overrides.js` | Pass | PATH node was denied on this host; bundled runtime node passed. |
| Whitespace | Patch hygiene | `git diff --check` | Pass | Only local CRLF warnings from Windows checkout. |
| Startup | Watchdog health | `docker exec wechat-selkies-regression /scripts/healthcheck.sh` | Pass | `/config/logs` is `abc:abc`; `process-watchdog.sh` is running. |
| HTTP | Web entrypoint | `Invoke-WebRequest http://localhost:3000/` | Pass | HTTP 200 OK. |
| UI | Browser smoke | In-app browser against final image at `http://127.0.0.1:3020/?final-ui-smoke=1` | Pass | Title `AXi-SNS-Box`, two canvases, activity layer present, no `#selkies-paste-toast-container`. |
| CPU H.264 inactive | Active/inactive transitions | Container logs show `60.0 -> 15.0 -> 60.0 -> 15.0` H.264 CPU FullFrame | Pass | No `Force-recover`, JPEG fallback, `Traceback`, or fatal decoder recovery in checked logs. |
| JPEG | Direct WebSocket settings | Sent `SETTINGS` with `encoder=jpeg` | Pass | Logs show `Mode: JPEG`, capture starts successfully. |
| Striped H.264 | Direct WebSocket settings | Sent `SETTINGS` with `encoder=x264enc-striped` | Pass | Logs show `Mode: H264 (CPU) Striped`, capture starts successfully. |
| Automated matrix | Re-runnable local encoder probes | `powershell -ExecutionPolicy Bypass -File scripts/ops/validate-1.28-encoders.ps1 -Image wechat-selkies:1.28` | Pass | CPU H.264, JPEG, and striped H.264 probes passed against the final image. |
| VAAPI | Host capability | `docker exec ... test -e /dev/dri` and compose device mapping | Not runnable here | This host has no `/dev/dri`, so VAAPI hardware runtime validation must be repeated on a host exposing `/dev/dri/renderD128`. |

## VAAPI Follow-Up Requirement

The code path that previously damaged H.264 inactive mode is now shared: H.264 inactive profiles restart capture and preserve encoded chunk order instead of dropping/pruning encoded frames. That should address VAAPI H.264 as well, but this machine cannot prove VAAPI runtime behavior because it has no DRI render node.

Run this on a VAAPI host before declaring hardware validation complete:

```bash
docker run --rm -d --name wechat-selkies-vaapi-test \
  --device /dev/dri:/dev/dri \
  -p 3000:3000 -p 3001:3001 \
  -e SELKIES_DEFAULT_ENCODER=x264enc \
  -e SELKIES_DEFAULT_USE_CPU=false \
  -e SELKIES_DYNAMIC_LOW_LATENCY=true \
  -e SELKIES_DEFAULT_H264_STREAMING_MODE=true \
  wechat-selkies:1.28
```

Expected log pattern after connecting a browser and going idle/active/idle:

```text
Mode: H264 (VAAPI) FullFrame
Dynamic inactive frame limit enabled
Dynamic inactive frame limit disabled
Dynamic inactive frame limit enabled
```

There should be no `Force-recover`, no JPEG fallback, no `Traceback`, and no repeated decoder crash reloads.

The same VAAPI check can be run through the validation helper:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/ops/validate-1.28-encoders.ps1 -Image wechat-selkies:1.28 -IncludeVaapi
```

With `-IncludeVaapi`, the helper first verifies that Docker can map `/dev/dri` and that a render/card node is visible. Without `-IncludeVaapi`, the helper validates only the CPU/JPEG-compatible matrix and is expected to pass on non-DRI hosts.

## Release Artifact

Image:

```text
wechat-selkies:1.28
wechat-selkies:latest
Image ID: sha256:202b85cc7f7d4eeb9676dad824e3cd7dc5191e05b9a95670af81d73797c0b257
```

Docker save archive:

```text
C:\Users\Muxinzheng\Desktop\Wechat-C\wechat-selkies-1.28.tar
Size: 1609921536 bytes
SHA256: 2028CF68B70BE5EB390A38ADC3FF0E17A54D1F506D4943061F1866F18F8002A8
Manifest tag: wechat-selkies:1.28
```

## Release Commands

```powershell
docker build -t wechat-selkies:1.28 -t wechat-selkies:latest .
docker run --rm --entrypoint /lsiopy/bin/python3 wechat-selkies:1.28 -m py_compile /lsiopy/lib/python3.12/site-packages/selkies/selkies.py
docker save -o wechat-selkies-1.28.tar wechat-selkies:1.28
Get-FileHash wechat-selkies-1.28.tar -Algorithm SHA256
```

## Maintenance Notes

- JPEG can still use send-time throttling; H.264 must preserve encoded order.
- Avoid reintroducing queue pruning or interval skipping for H.264 inactive profiles.
- If healthcheck reports `watchdog process missing`, first inspect `/config/logs` ownership and `WATCHDOG_LOG_PATH`.

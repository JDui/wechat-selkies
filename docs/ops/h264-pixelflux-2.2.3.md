# H.264 full-frame migration to Pixelflux 2.2.3

Branch: `AXiVer`

## Scope

Full-frame `x264enc` now uses the private, pinned Pixelflux 2.2.3 runtime through `selkies/h264_capture.py`, sharing the same runtime loader as HEVC and AV1. H.264 no longer falls back to the old H.264 capture path when the private runtime or hardware encoder fails.

- H.264 hardware encoding is selected through the same VA-API render node used by HEVC/AV1.
- CPU H.264 remains available only when the existing `use_cpu` setting explicitly requests it.
- The adapter emits the existing Selkies 10-byte video header followed by one H.264 Annex-B access unit.
- A new session does not publish delta frames before the first IDR. It buffers a bounded startup sequence and preserves frame order.
- Runtime codec and hardware status are checked before the startup queue is published.
- `update_framerate()` and `update_tunables()` are exposed for the existing adaptive frame feedback and Paint-over controls.
- Quality updates include CRF, Paint-over CRF, burst-frame count and streaming mode.
- Initialization failure is surfaced; there is no silent downgrade to the old H.264 runtime.

## Runtime boundary

The private Pixelflux 2.2.3 wheel is installed under `/opt/selkies-pixelflux`. The loader remains isolated from the base image's `pixelflux` import namespace.

The base image's original Pixelflux package is still used by `x264enc-striped` and JPEG capture, which retain the existing `StripeCallback` ABI. This is not an H.264 full-frame fallback. Removing that remaining dependency requires a separate migration of the striped/JPEG callback and settings adapters.

## Verification

Added `tests/test_h264_capture.py` covering:

- Annex-B IDR detection and existing wire-header layout.
- Codec frame-type validation and frame-ID wrapping.
- First-IDR gating and ordered startup-frame delivery.
- Hardware capability and runtime demotion rejection.
- Missing-IDR timeout and cleanup.
- Live frame-rate, Paint-over and quality updates.
- Server routing of full-frame H.264 to the new adapter while keeping the striped/JPEG path separate.

The repository does not currently run this Python suite automatically on every branch push. Run it in the project build/test environment:

```bash
python -m unittest tests.test_h264_capture tests.test_hevc_capture tests.test_av1_capture tests.test_frame_feedback
python -m py_compile root/lsiopy/lib/python3.12/site-packages/selkies/h264_capture.py
python -m py_compile root/lsiopy/lib/python3.12/site-packages/selkies/hevc_capture.py
python -m py_compile root/lsiopy/lib/python3.12/site-packages/selkies/av1_capture.py
python -m py_compile root/lsiopy/lib/python3.12/site-packages/selkies/selkies.py
git diff --check
```

A successful unit run does not replace AMD VA-API and WebView2 real-device validation. On the target machine, verify that the session reports `codec=h264`, `hardware=true`, and `encoder=VAAPI`; then exercise static text, continuous scrolling, video playback, reconnect, IDR recovery, Paint-over toggling and adaptive FPS changes.

# Real-time pipeline isolation — 2.07

## Changes

- Audio queue is bounded by `SELKIES_AUDIO_QUEUE_MAX_CHUNKS` (default 10, range 2–50). At the 20 ms Opus packet duration this retains at most about 200 ms by default.
- Audio native callbacks use `loop.call_soon_threadsafe()` to schedule a synchronous `put_nowait` operation. This avoids creating one coroutine/future for every 20 ms packet.
- When the audio queue is full, the oldest encoded audio chunk is discarded and the newest is retained. This favors current audio over stale playback.
- Video and audio native capture start/stop operations use a dedicated two-worker `ThreadPoolExecutor`, keeping potentially blocking native lifecycle calls away from the asyncio default executor.
- Notification Bridge and Local Link Bridge run with `nice 10` from the desktop startup script. This lowers their CPU scheduling priority relative to WeChat/QQ and Selkies without changing their functionality.
- Upload remains in the independent Rust Tokio sidecar with its existing Semaphore concurrency limit. It is not moved into the Python asyncio event loop.

## Boundaries

- This does not reserve CPU cores or cap the total CPU time of Electron, X11, VA-API or the Rust sidecar.
- The two-worker capture executor is for native capture lifecycle operations only; Pixelflux still manages its own internal encoding/capture threads.
- Audio queue drops are deliberate under sustained consumer lag. If they occur frequently, inspect WebSocket send pressure and client/network latency rather than increasing the queue indefinitely.
- The sidecar's upload concurrency and 8 MiB chunks are unchanged to avoid reducing NAS transfer throughput without measurements.

## Verification

```bash
python -m unittest tests.test_h264_capture tests.test_hevc_capture tests.test_av1_capture tests.test_frame_feedback
python -m py_compile root/lsiopy/lib/python3.12/site-packages/selkies/selkies.py
bash -n root/scripts/start.sh
docker compose config
git diff --check
```

NAS validation should include idle, simultaneous upload + video, local-link open during active stream, and audio playback under network congestion. Watch audio drop counters, queue occupancy, executor thread count, CPU/RSS per process and video ACK latency.

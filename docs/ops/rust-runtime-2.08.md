# Rust runtime migration — AXiVer 2.08

## Ownership

| Component | Runtime |
|---|---|
| Video capture/encoding | Existing Pixelflux Rust; Python WebSocket and ACK coordination |
| Upload, download cache/copy, download response body | Unified Rust Axum sidecar |
| PIN/session/auth, preferences, sleep, local-link queue | Unified Rust Axum sidecar |
| Audio queue | Rust FFI ring with bounded Python scheduling adapter and bounded fallback |
| Mapped X11 key injection | Rust XTEST FFI, single dedicated executor; existing IME and fallback preserved |
| XDND selection/geometry, diagnostics, discovery, notification | Python integration layer |
| Desktop supervision | s6 and existing watchdog, with obsolete bridge restart removed |

The sidecar runs as abc and binds only to loopback. It must not be exposed directly to external clients: nginx remains the external authentication boundary. Session and sleep state defaults are under /run/selkies-runtime. The retained Python adapter listens on SELKIES_SESSION_AUTH_PORT for XDND state/geometry, discovery and diagnostics, not PIN/auth/preferences.

## Resource boundaries

- 2 Tokio async workers, maximum 16 blocking workers; upload chunk concurrency uses SELKIES_UPLOAD_MAX_CONCURRENCY (default 3).
- Download copy queue retains existing one-preparing-job rule; stream concurrency is independently bounded by SELKIES_DROP_MAX_CONCURRENCY (default 2). The one-time token is reserved atomically and a cancelled response releases its lease. No browser-supplied source-path route is exposed by nginx.
- Upload chunk requests reject capacity overflow with HTTP 429 and time out after 60 s. The existing upload worker retries transient chunk errors. Checksum hashing uses a separate single permit held until the blocking operation actually exits.
- Audio mailbox retains latest SELKIES_AUDIO_QUEUE_MAX_CHUNKS (default 10), with one outstanding producer wakeup and batches of at most 8. The per-viewer WebSocket write-buffer threshold SELKIES_AUDIO_SOCKET_MAX_BYTES defaults to 524288; excess audio packets are skipped rather than adding to network backlog. The audio capture executor is separate from the video capture executor.
- Sleep signals only processes owned by the runtime user. A pre-freeze manifest includes PID start times; wake checks process identity and reports remaining failures. Root-owned infrastructure is not forcibly frozen or elevated.

## Acceptance

Run cargo test --locked and cargo build --locked --release inside upload-sidecar. The Rust Runtime workflow checks the binary and shared library. Runtime Source Checks compiles modified Python, runs adapter and mailbox tests, and validates shell syntax. These checks are not a Docker build or a real-device acceptance test.

On the NAS verify: PIN login/takeover/logout; preferences persistence and separate-display settings; manual/automatic sleep and wake; X11 Chinese IME (including candidate placement and first character); playback/microphone; H.264/H.265/AV1; upload with interrupted retry and concurrent download; one-time download token; external link open. Repeat while uploading/downloading a large file. Measure video ACK latency, audio drops, process RSS/CPU, GPU encoding and transfer rate. Do not assume reduced CPU usage or image size before measurement.

Remaining Python is deliberate: the upstream Selkies WebSocket/control layer, IME, native X11 XDND/notification integration and diagnostics are not replaced by this migration. Moving those without equivalent device regression coverage would increase risk. Video transport remains protocol-compatible; this change does not claim full Rust WebSocket replacement.

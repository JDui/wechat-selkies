# Standalone upload architecture (1.45)

## Confirmed root causes

The legacy browser path wraps `WebSocket.prototype.send`, clones upload buffers with `ArrayBuffer.slice`, and keeps a JavaScript queue next to the Selkies UI. File reads, queue work, progress rendering, input, and video rendering therefore compete on the main thread.

The Selkies data WebSocket carries file chunks together with keyboard, mouse, clipboard, microphone, and control messages. A large buffered upload can delay latency-sensitive control messages.

The Python data WebSocket loop writes file payloads with synchronous `write`, `flush`, and `close` calls. A slow NAS, mechanical disk, or network mount can block the asyncio loop. The page-stall watchdog can then observe stalled frames or event-loop lag and reload the page without preserving a precise cause.

## New data path

```text
/uploader/ window
  -> Dedicated Worker
  -> HTTP PUT chunks
  -> nginx /upload-api/v1/
  -> Rust / Tokio / Axum sidecar
  -> .staging/{task-id}.part + .json
  -> size/checksum validation
  -> atomic rename into the upload root
```

The main Selkies page does not expose a separate uploader button. Its capture-phase bridge intercepts the existing Selkies file input only after the user selects files, prevents the legacy handler from reading them, opens the uploader window from that user gesture, and transfers the `File` objects over `BroadcastChannel`. Drag-and-drop is intercepted the same way: a document-level capture handler prevents the browser from navigating to the dropped file, stops the Selkies bundle's legacy data-channel drop handler from firing, and hands `dataTransfer.files` to the uploader window. The main page otherwise only consumes upload summaries; it does not read or slice file content. The legacy WebSocket upload wrapper is disabled by default and remains available through `SELKIES_LEGACY_UPLOAD_ENABLED=true`.

## API

- `POST /upload-api/v1/sessions` creates a task.
- `GET /upload-api/v1/sessions/{id}` returns uploaded bytes and confirmed chunk indexes.
- `PUT /upload-api/v1/sessions/{id}/chunks/{index}` writes one bounded chunk.
- `POST /upload-api/v1/sessions/{id}/complete` checks size and optional BLAKE3/SHA-256, syncs, and renames.
- `DELETE /upload-api/v1/sessions/{id}` cancels and removes staged state.
- `POST /upload-api/v1/token` is served by the existing PIN auth bridge.

Every sidecar request requires a bearer token. Its signed claims bind session ID, session epoch, expiry, upload root, maximum file size, and overwrite permission. The sidecar rereads the current session state for every request; a PIN takeover changes the epoch and immediately invalidates old tokens and staged-task access.

## Memory, disk, and path boundaries

The sidecar acquires a global semaphore before reading a request body. Each body is capped at the configured chunk size, so body memory is bounded by `chunk_size * max_concurrency` plus small protocol/session overhead.

Targets must be relative paths made only from normal path components. Absolute paths, prefixes, `..`, NUL, symlink parents, and symlink targets are rejected. The configured upload root is canonicalized at startup, `.staging` is on the same filesystem, and completion uses an atomic rename. Optional subdirectory allowlists, maximum file size, and minimum remaining disk space are checked before session creation.

## Diagnostics

The browser records JS heap (where supported), long-task count and maximum duration, aggregate Selkies WebSocket `bufferedAmount`, legacy upload queue length, WebSocket close code/reason, and persisted page reload reason.

The old Python path records slow write duration plus total/max write and flush duration. The sidecar emits structured task ID, file name, elapsed time, average speed, slow write, and error logs. PINs, cookies, bearer tokens, and signing keys are never logged.

## Migration and rollback

The default is `SELKIES_UPLOAD_ENABLED=true` and `SELKIES_LEGACY_UPLOAD_ENABLED=false`. To temporarily restore the old path, enable the legacy flag. To disable the sidecar entirely, disable standalone upload and enable the legacy flag together.

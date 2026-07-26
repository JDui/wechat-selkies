# AXIVER Client — design QA

## Visual target

- Selected direction: 玻璃浮岛
- Reference image:
  `C:\Users\Muxinzheng\.codex\generated_images\019f9dc8-f778-7be1-89d0-802d83badd02\call_abF1CseduumOyhJ5ElQNXmuK.png`
- Final implementation capture: `qa-implementation-final.png`
- Side-by-side comparison: `qa-comparison-final.png`
- Tested state: LAN connected, menu expanded

The implementation was rendered at a CSS viewport of 1440 × 1024 with DPR 1.
The browser capture and the 1487 × 1058 reference were normalized to
1440 × 1024 before comparison.

## Review history

### Pass 1

- P2: the glass panel was undersized and too close to the upper-left edge.
- P2: the three action icons did not match the visual target.
- Fix: resized and repositioned the panel, then replaced provisional assets
  with Microsoft Fluent UI System Icons.

### Final pass

- P0/P1/P2: none remaining.
- P3: the implemented glass surface is slightly darker and the menu labels are
  marginally heavier than the generated reference. This was retained to keep
  controls legible over arbitrary remote pages.
- Readability follow-up: increased the surface opacity, label weight, input
  contrast, icon size, and icon shadow; the expanded LAN-state preview passed
  visual and accessibility-tree checks with all three controls clearly
  distinguishable.
- Result: passed.

## Interaction and console checks

- Menu expand/collapse: passed.
- Collapsed point placement: passed at 8 px from the content area's top and
  left edges.
- Collapsed point drag: passed from `(8, 8)` to `(128, 98)` while remaining
  collapsed; the position is held in Rust memory only and is not written to
  SQLite.
- Refresh action and navigation: passed.
- Status dot rendering for LAN-connected state: passed.
- Browser console errors and warnings: none.
- Rust validation and URL normalization unit tests: passed.
- Advertised LAN scheme/HTTPS-port selection unit test: passed.
- WAN URL SQLite round-trip test: passed.
- Drawer editing regression: a focused WAN field remained open and retained
  its in-progress value for more than six seconds.
- Live LAN fallback: with mDNS unavailable, the client scanned the
  `192.168.31.0/24` subnet, validated `192.168.31.221:3000`, opened the
  `AXi-SNS-Box - PIN` page, and rendered the rainbow LAN state.
- Certificate handling: WebView2 is started with process-local certificate
  errors disabled for both LAN and user-configured WAN targets, as explicitly
  requested. No Windows or external-browser setting is modified.
- Native title behavior: the waiting screen starts as `AXIVER Client`; after
  connection, document-title changes are mirrored to the native window.
- Portable EXE smoke test: the live LAN page loaded, the native title changed
  to `AXi-SNS-Box - PIN`, the window remained responsive, and the exact test
  process closed cleanly.
- Windows PE subsystem: 2 (`WINDOWS_GUI`), so no console window is created.
- SQLite smoke test: `dist/axiver-client.db` was created beside the EXE with
  `broadcast_name=AXISNSBOX-000` and an empty WAN URL.

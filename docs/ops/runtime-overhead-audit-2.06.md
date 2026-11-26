# Runtime overhead audit — 2.06

Branch: `AXiVer`

## Scope and evidence

This is a source-level audit of the Docker Compose topology, startup scripts, s6 services, watchdogs, notification bridge, LAN discovery sidecar and Selkies video capture path.

No NAS process sample or Docker runtime counters were available during this review. Therefore, the changes below reduce known polling and idle service work; they do not claim a measured CPU/RSS reduction.

## Applied low-risk changes

| Area | Previous behavior | 2.06 behavior | Reason |
| --- | --- | --- | --- |
| Process watchdog | Compose interval 10 s | 20 s | Fewer repeated `pgrep`, PulseAudio and X11 probes; still detects failures within a bounded interval |
| Notification fallback | Window/title fallback scan every 1.2 s | 3 s | Avoid repeatedly querying X11/window metadata when native D-Bus notifications are already available |
| Idle defocus | State-file checks every 1 s | 5 s | This action has a 600 s default idle threshold and does not need one-second precision |
| LAN discovery | State/status poll every 1 s | 5 s | Lower config-file polling and status-file atomic replacement frequency |
| LAN discovery disabled | Constructed a Zeroconf instance even when broadcast was off | Zeroconf instance is created only while enabled and closed when disabled | Avoid idle mDNS sockets and library worker threads |
| Notification audio observer | Created a thread which immediately returned when audio detection was disabled | Do not create that thread unless audio detection is enabled | Remove an unnecessary thread |

The Docker healthcheck remains at 30 seconds. It checks the login/wake, desktop and upload service boundaries; it is not a replacement for the longer watchdog recovery interval.

## Findings retained intentionally

- `svc-pulseaudio` is supervised by s6. The watchdog's `pactl info` probe remains as a hung-server check; it is not the primary process supervisor.
- `session_auth_bridge.py`, `notification_bridge.py` and `container_sleep_manager.py` are detached helper services started by `start.sh`; the watchdog restarts them if their process disappears. Removing this supervision would reduce resilience.
- The discovery sidecar still uses the same image tag as the main service. Docker stores shared image layers once, so this does not duplicate the full image on disk; it does retain one small Python process and host-network namespace.
- `mem_limit`, `mem_reservation`, `shm_size`, `pids_limit` and ulimits are limits/capacities, not preallocated memory or CPU workers.
- The WeChat Electron client, X11 desktop, PulseAudio and Selkies WebRTC encoder are the unavoidable core workload. They must be measured before changing codec or desktop behavior.
- The notification fallback remains enabled because it covers window-attention/title notifications when native notification events are unavailable. Its slower cadence can add up to roughly 3 seconds of delay to that fallback path.

## Likely next targets — measure before changing

1. **Notification window scan**: fallback checks WeChat and QQ window state. If this remains a leading CPU consumer, inspect whether `WindowReader` already provides an event-driven change signal before removing fallback behavior.
2. **WeChat logout monitor**: scans `/proc` every 20 seconds. Its load should be tiny, but it is an optional observability helper and can be disabled if the event log is not used.
3. **Desktop watchdogs**: watchdog and Docker healthcheck overlap on some process-presence checks. Keep independent failure recovery until a single health supervisor can cover both desktop and wake/login paths.
4. **GPU statistics**: confirm whether the stats loop polls `GPUtil` every second when no visible stats panel is open. If so, consider demand-driven sampling.
5. **Base image**: inspect actual installed package and process inventory before removing desktop packages. The image includes the full LinuxServer Selkies desktop stack; deleting libraries based only on Dockerfile duplicates risks breaking WeChat/QQ or X11.

## Runtime measurement

Run this inside the NAS after the container has been idle for at least 2 minutes, with the browser connected but no active interaction:

```bash
docker exec wechat-selkies python3 /scripts/idle-resource-probe.py
docker exec wechat-selkies cat /config/logs/idle-resource-probe.json
```

Repeat once while scrolling the desktop and once while playing a QQ/WeChat video. Compare:

- `container_cpu_one_core_percent` and `container_cpu_host_capacity_percent`
- Per-process `cpu_one_core_percent` and `rss_mib`
- `gpu_clients[].engine_busy_percent`
- cgroup `memory.current`, `memory.stat` and `cpu.stat`

This separates desktop baseline cost from idle polling, video encoding and application rendering.

## Verification

Run:

```bash
python -m unittest tests.test_lan_discovery tests.test_notification_bridge_state
python -m unittest tests.test_h264_capture tests.test_hevc_capture tests.test_av1_capture tests.test_frame_feedback
python -m py_compile root/scripts/notification_bridge.py root/scripts/lan_discovery_service.py
docker compose config
git diff --check
```

The source changes are not a substitute for a NAS idle/active sample. Do not remove the notification fallback, PulseAudio recovery or X11 recovery until the measured process list demonstrates that they are material consumers and the replacement path has equivalent failure coverage.

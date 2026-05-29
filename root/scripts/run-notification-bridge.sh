#!/bin/bash
set -euo pipefail

NOTIFICATION_BRIDGE_LOG_PATH="${NOTIFICATION_BRIDGE_LOG_PATH:-/config/logs/notification-bridge.log}"
NOTIFICATION_BRIDGE_RAW_LOG_PATH="${NOTIFICATION_BRIDGE_RAW_LOG_PATH:-/config/logs/notification-bridge-raw.log}"
NOTIFICATION_BRIDGE_LOG_MAX_BYTES="${NOTIFICATION_BRIDGE_LOG_MAX_BYTES:-4194304}"

mkdir -p "$(dirname "$NOTIFICATION_BRIDGE_LOG_PATH")"
mkdir -p "$(dirname "$NOTIFICATION_BRIDGE_RAW_LOG_PATH")"
touch "$NOTIFICATION_BRIDGE_LOG_PATH" "$NOTIFICATION_BRIDGE_RAW_LOG_PATH" 2>/dev/null || true
chmod ug+rw "$NOTIFICATION_BRIDGE_LOG_PATH" "$NOTIFICATION_BRIDGE_RAW_LOG_PATH" 2>/dev/null || true

exec bash -c 'set -o pipefail; python3 -u /scripts/notification_bridge.py 2>&1 | python3 -u /scripts/size_limited_log_writer.py "$1" "$2"' \
    _ "$NOTIFICATION_BRIDGE_LOG_PATH" "$NOTIFICATION_BRIDGE_LOG_MAX_BYTES"

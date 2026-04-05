#!/bin/bash

set -euo pipefail

STATE_PATH="${WECHAT_KEEPALIVE_STATE_PATH:-/config/state/wechat-keepalive.json}"
LOG_PATH="${WECHAT_KEEPALIVE_LOG_PATH:-/config/logs/wechat-idle-keepalive.log}"
DAEMON_PATTERN="/scripts/wechat/wechat-idle-keepalive.sh$"

mkdir -p "$(dirname "$STATE_PATH")" "$(dirname "$LOG_PATH")"

read_state() {
    if [ ! -f "$STATE_PATH" ]; then
        printf 'false\n'
        return 0
    fi
    python3 - "$STATE_PATH" <<'PY'
import json
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
try:
    payload = json.loads(path.read_text(encoding="utf-8"))
except Exception:
    print("false")
    raise SystemExit(0)

enabled = bool(payload.get("enabled", False))
print("true" if enabled else "false")
PY
}

write_state() {
    local enabled="$1"
    python3 - "$STATE_PATH" "$enabled" <<'PY'
import json
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
enabled = sys.argv[2].strip().lower() in {"1", "true", "yes", "on"}
payload = {"enabled": enabled}
tmp = path.with_suffix(path.suffix + ".tmp")
tmp.write_text(json.dumps(payload), encoding="utf-8")
tmp.replace(path)
PY
}

daemon_running() {
    pgrep -af "$DAEMON_PATTERN" >/dev/null 2>&1
}

start_daemon() {
    if daemon_running; then
        return 0
    fi
    nohup /scripts/wechat/wechat-idle-keepalive.sh >>"$LOG_PATH" 2>&1 &
}

stop_daemon() {
    pkill -f "$DAEMON_PATTERN" >/dev/null 2>&1 || true
}

command="${1:-status}"
case "$command" in
    status)
        if [ "$(read_state)" = "true" ]; then
            exit 0
        fi
        exit 1
        ;;
    print)
        read_state
        ;;
    enable)
        write_state true
        start_daemon
        ;;
    disable)
        write_state false
        stop_daemon
        ;;
    sync)
        if [ "$(read_state)" = "true" ]; then
            start_daemon
        else
            stop_daemon
        fi
        ;;
    *)
        echo "usage: $0 {status|print|enable|disable|sync}" >&2
        exit 2
        ;;
esac

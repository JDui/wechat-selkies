#!/bin/bash

set -euo pipefail

is_true() {
    case "${1:-}" in
        true|TRUE|1|yes|YES|on|ON) return 0 ;;
        *) return 1 ;;
    esac
}

# A sleeping upload/desktop process deliberately cannot answer health probes.
# Verify the services needed to display login and wake up instead.
if python3 - <<'PY'
import json, os, sys
try:
    with open(os.getenv("SELKIES_CONTAINER_SLEEP_STATE_PATH", "/run/selkies-container-sleep.json")) as handle:
        state = json.load(handle)
    sleeping = state.get("sleeping") is True and state.get("mode") == "full"
except (OSError, ValueError, AttributeError):
    sleeping = False
sys.exit(0 if sleeping else 1)
PY
then
    pgrep -x nginx >/dev/null
    curl -fsS --max-time 3 "http://127.0.0.1:${SELKIES_SESSION_AUTH_PORT:-38082}/health" >/dev/null
    curl -fsS --max-time 3 "http://127.0.0.1:${SELKIES_CONTAINER_SLEEP_PORT:-38083}/health" >/dev/null
    exit 0
fi

if ! curl -fsS --max-time 3 "http://127.0.0.1:${SELKIES_CONTAINER_SLEEP_PORT:-38083}/health" >/dev/null; then
    echo "container sleep service unavailable"
    exit 1
fi

if ! pgrep -x openbox >/dev/null 2>&1; then
    echo "openbox process missing"
    exit 1
fi

if is_true "${PROCESS_WATCHDOG:-true}"; then
    if ! pgrep -af "/scripts/process-watchdog.sh" >/dev/null 2>&1; then
        echo "watchdog process missing"
        exit 1
    fi
fi

if is_true "${AUTO_START_WECHAT:-true}" && is_true "${WATCHDOG_RESTART_WECHAT:-true}"; then
    if ! pgrep -af '^/usr/bin/[w]echat([[:space:]]|$)' >/dev/null 2>&1; then
        echo "wechat process missing"
        exit 1
    fi
fi

if is_true "${AUTO_START_QQ:-false}" && is_true "${WATCHDOG_RESTART_QQ:-true}"; then
    if ! pgrep -af '^/usr/bin/[q]q([[:space:]]|$)' >/dev/null 2>&1; then
        echo "qq process missing"
        exit 1
    fi
fi

if is_true "${SELKIES_UPLOAD_ENABLED:-true}"; then
    upload_port="${SELKIES_UPLOAD_PORT:-38084}"
    if ! pgrep -af "/usr/local/bin/selkies-upload-sidecar" >/dev/null 2>&1; then
        echo "upload sidecar process missing"
        exit 1
    fi
    if ! curl -fsS --max-time 3 "http://127.0.0.1:${upload_port}/health" >/dev/null; then
        echo "upload sidecar health endpoint failed"
        exit 1
    fi
fi

exit 0

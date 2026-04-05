#!/usr/bin/env bash
set -euo pipefail

RECOVER_UI_SERVICES_LOG_PATH="${RECOVER_UI_SERVICES_LOG_PATH:-/config/logs/recover-ui-services.log}"
SPLIT_FAB_LOG_PATH="${SPLIT_FAB_LOG_PATH:-/config/logs/split-fab.log}"
RECOVER_UI_SERVICES_LOCK_PATH="${RECOVER_UI_SERVICES_LOCK_PATH:-/tmp/recover-ui-services.lock}"
RECOVER_UI_SERVICES_STAMP_PATH="${RECOVER_UI_SERVICES_STAMP_PATH:-/tmp/recover-ui-services.stamp}"
RECOVER_UI_SERVICES_COOLDOWN_SECONDS="${RECOVER_UI_SERVICES_COOLDOWN_SECONDS:-15}"

mkdir -p "$(dirname "$RECOVER_UI_SERVICES_LOG_PATH")" "$(dirname "$SPLIT_FAB_LOG_PATH")"

log() {
    printf '%s %s\n' "$(date '+%F %T')" "$*" >>"$RECOVER_UI_SERVICES_LOG_PATH"
}

is_true() {
    case "${1:-}" in
        true|TRUE|1|yes|YES|on|ON) return 0 ;;
        *) return 1 ;;
    esac
}

validate_cooldown() {
    if [[ "${1:-}" =~ ^[0-9]+$ ]] && [ "$1" -ge 0 ] && [ "$1" -le 300 ]; then
        echo "$1"
    else
        echo "15"
    fi
}

cooldown_seconds="$(validate_cooldown "$RECOVER_UI_SERVICES_COOLDOWN_SECONDS")"

exec 7>"$RECOVER_UI_SERVICES_LOCK_PATH"
if ! flock -n 7; then
    log "skip recovery: another recover-ui-services instance is running"
    exit 0
fi

now_epoch="$(date +%s)"
last_epoch=0
if [ -f "$RECOVER_UI_SERVICES_STAMP_PATH" ]; then
    last_epoch="$(cat "$RECOVER_UI_SERVICES_STAMP_PATH" 2>/dev/null || echo 0)"
fi
if ! [[ "$last_epoch" =~ ^[0-9]+$ ]]; then
    last_epoch=0
fi
if [ "$cooldown_seconds" -gt 0 ] && [ $((now_epoch - last_epoch)) -lt "$cooldown_seconds" ]; then
    log "skip recovery: cooldown active (${now_epoch}-${last_epoch} < ${cooldown_seconds}s)"
    exit 0
fi
echo "$now_epoch" >"$RECOVER_UI_SERVICES_STAMP_PATH"

log "starting ui service recovery"

if pgrep -f "/scripts/split_fab.py" >/dev/null 2>&1; then
    pkill -f "/scripts/split_fab.py" >/dev/null 2>&1 || true
    for _ in 1 2 3 4 5; do
        if ! pgrep -f "/scripts/split_fab.py" >/dev/null 2>&1; then
            break
        fi
        sleep 0.2
    done
    if pgrep -f "/scripts/split_fab.py" >/dev/null 2>&1; then
        pkill -9 -f "/scripts/split_fab.py" >/dev/null 2>&1 || true
        sleep 0.2
        log "force stopped split_fab"
    else
        log "stopped split_fab"
    fi
fi

if is_true "${ENABLE_SPLIT_FAB:-false}"; then
    nohup python3 /scripts/split_fab.py >>"$SPLIT_FAB_LOG_PATH" 2>&1 &
    log "restarted split_fab with pid $!"
else
    log "skip split_fab restart: feature disabled"
fi

if pgrep -x openbox >/dev/null 2>&1; then
    openbox --reconfigure >/dev/null 2>&1 || true
    log "requested openbox reconfigure"
else
    log "skip openbox reconfigure: openbox not running"
fi

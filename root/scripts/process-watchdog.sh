#!/bin/bash

set -euo pipefail

is_true() {
    case "${1:-}" in
        true|TRUE|1|yes|YES|on|ON) return 0 ;;
        *) return 1 ;;
    esac
}

validate_interval() {
    if [[ "${1:-}" =~ ^[0-9]+$ ]] && [ "$1" -ge 5 ]; then
        echo "$1"
    else
        echo "20"
    fi
}

validate_threshold() {
    if [[ "${1:-}" =~ ^[0-9]+$ ]] && [ "$1" -ge 1 ] && [ "$1" -le 20 ]; then
        echo "$1"
    else
        echo "3"
    fi
}

log() {
    printf '%s [watchdog] %s\n' "$(date -Iseconds)" "$*"
}

setup_state_dir() {
    local dir="${WATCHDOG_STATE_DIR:-/config/state/watchdog}"
    if mkdir -p "$dir" 2>/dev/null && [ -w "$dir" ]; then
        printf '%s\n' "$dir"
        return
    fi
    dir="/run/wechat-selkies-watchdog"
    if mkdir -p "$dir" 2>/dev/null && [ -w "$dir" ]; then
        printf '%s\n' "$dir"
        return
    fi
    printf '%s\n' "/tmp"
}

safe_restart() {
    local name="$1"
    local cmd="$2"
    local now
    now="$(date +%s)"
    local min_cooldown=10
    if [ "$name" = "x11-stack" ]; then
        min_cooldown=60
    fi

    local stamp_file="${watchdog_state_dir}/watchdog-${name}.stamp"
    local last=0
    if [ -f "$stamp_file" ]; then
        last="$(cat "$stamp_file" 2>/dev/null || echo 0)"
    fi

    # simple cooldown to avoid tight restart loops
    if [ $((now - last)) -lt "${min_cooldown}" ]; then
        return
    fi

    echo "$now" >"$stamp_file"
    log "restart ${name}"
    nohup bash -lc "$cmd" >/dev/null 2>&1 &
}

chmod 1777 /tmp 2>/dev/null || true

interval="$(validate_interval "${WATCHDOG_INTERVAL:-20}")"
qq_fail_threshold="$(validate_threshold "${QQ_WATCHDOG_FAIL_THRESHOLD:-3}")"
x11_fail_threshold="$(validate_threshold "${X11_WATCHDOG_FAIL_THRESHOLD:-2}")"
watchdog_state_dir="$(setup_state_dir)"
qq_fail_counter_file="${watchdog_state_dir}/watchdog-qq-fail.count"
x11_fail_counter_file="${watchdog_state_dir}/watchdog-x11-fail.count"
lock_file="${watchdog_state_dir}/wechat-selkies-watchdog.lock"

exec 9>"$lock_file"
if ! flock -n 9; then
    log "already running, exit"
    exit 0
fi

log "started interval=${interval}s qq_fail_threshold=${qq_fail_threshold} x11_fail_threshold=${x11_fail_threshold}"

while true; do
    if is_true "${WATCHDOG_TRAY:-true}"; then
        if ! pgrep -x stalonetray >/dev/null 2>&1; then
            safe_restart "tray" "stalonetray --dockapp-mode simple"
        fi
    fi

    if is_true "${WATCHDOG_NOTIFICATIONS:-true}"; then
        if ! pgrep -x dunst >/dev/null 2>&1; then
            safe_restart "dunst" "dunst -config /config/.config/dunst/dunstrc"
        fi
    fi

    if is_true "${AUTO_START_WECHAT:-true}" && is_true "${WATCHDOG_RESTART_WECHAT:-true}"; then
        if ! pgrep -af "/usr/bin/wechat" >/dev/null 2>&1; then
            safe_restart "wechat" "/usr/bin/wechat"
        fi
    fi

    if ! pgrep -f "/scripts/notification_bridge.py" >/dev/null 2>&1; then
        safe_restart "notification-bridge" "/scripts/run-notification-bridge.sh"
    fi

    if ! pgrep -f "/scripts/session_auth_bridge.py" >/dev/null 2>&1; then
        safe_restart "session-auth-bridge" "python3 -u /scripts/session_auth_bridge.py >>\"${SELKIES_SESSION_AUTH_LOG_PATH:-/config/logs/session-auth-bridge.log}\" 2>&1"
    fi

    if is_true "${SELKIES_CONTAINER_SLEEP:-false}"; then
        if ! is_true "${SELKIES_CONTAINER_SLEEP_REQUIRE_PIN:-true}" || [ -n "${PASSWORD:-}" ]; then
            if ! pgrep -f "/scripts/container_sleep_manager.py" >/dev/null 2>&1; then
                safe_restart "container-sleep-manager" "python3 -u /scripts/container_sleep_manager.py >>\"${SELKIES_CONTAINER_SLEEP_LOG_PATH:-/config/logs/container-sleep-manager.log}\" 2>&1"
            fi
        fi
    fi

    if is_true "${WATCHDOG_AUDIO:-true}"; then
        audio_user="${AUDIO_SERVICE_USER:-abc}"
        audio_uid="$(id -u "$audio_user" 2>/dev/null || echo "${PUID:-1000}")"
        runtime_dir="${XDG_RUNTIME_DIR:-/run/user/$audio_uid}"
        pulse_runtime_path="${PULSE_RUNTIME_PATH:-$runtime_dir/pulse}"
        pulse_server="${PULSE_SERVER:-unix:$runtime_dir/pulse/native}"
        if ! XDG_RUNTIME_DIR="$runtime_dir" PULSE_RUNTIME_PATH="$pulse_runtime_path" PULSE_SERVER="$pulse_server" pactl info >/dev/null 2>&1; then
            safe_restart "audio-service" "/scripts/ensure-audio-service.sh >>\"${AUDIO_SERVICE_LOG_PATH:-/config/logs/audio-service.log}\" 2>&1"
        fi
    fi

    if is_true "${AUTO_START_QQ:-false}" && is_true "${WATCHDOG_RESTART_QQ:-true}"; then
        if ! pgrep -af "/usr/bin/qq" >/dev/null 2>&1; then
            echo "0" >"$qq_fail_counter_file"
            safe_restart "qq" "/scripts/qq/qq-launch.sh"
        elif is_true "${QQ_WATCHDOG_HANG_DETECT:-true}"; then
            if /scripts/qq/qq-healthcheck.sh; then
                echo "0" >"$qq_fail_counter_file"
            else
                current_fail_count=0
                if [ -f "$qq_fail_counter_file" ]; then
                    current_fail_count="$(cat "$qq_fail_counter_file" 2>/dev/null || echo 0)"
                fi
                if ! [[ "$current_fail_count" =~ ^[0-9]+$ ]]; then
                    current_fail_count=0
                fi
                current_fail_count=$((current_fail_count + 1))
                echo "$current_fail_count" >"$qq_fail_counter_file"
                log "qq healthcheck failed (${current_fail_count}/${qq_fail_threshold})"
                if [ "$current_fail_count" -ge "$qq_fail_threshold" ]; then
                    echo "0" >"$qq_fail_counter_file"
                    safe_restart "qq" "/scripts/qq/qq-restart.sh"
                fi
            fi
        fi
    fi

    if is_true "${X11_WATCHDOG:-true}"; then
        if /scripts/x11-healthcheck.sh; then
            echo "0" >"$x11_fail_counter_file"
        else
            x11_rc=$?
            x11_fail_count=0
            if [ -f "$x11_fail_counter_file" ]; then
                x11_fail_count="$(cat "$x11_fail_counter_file" 2>/dev/null || echo 0)"
            fi
            if ! [[ "$x11_fail_count" =~ ^[0-9]+$ ]]; then
                x11_fail_count=0
            fi
            x11_fail_count=$((x11_fail_count + 1))
            echo "$x11_fail_count" >"$x11_fail_counter_file"
            log "x11 healthcheck failed rc=${x11_rc} (${x11_fail_count}/${x11_fail_threshold})"
            if [ "$x11_fail_count" -ge "$x11_fail_threshold" ]; then
                if [ "$x11_rc" -eq 2 ] || [ "$x11_rc" -eq 3 ] || [ "$x11_fail_count" -ge $((x11_fail_threshold * 3)) ]; then
                    echo "0" >"$x11_fail_counter_file"
                    safe_restart "x11-stack" "/scripts/recover-xstack.sh"
                else
                    safe_restart "x11-ui" "/scripts/recover-ui-services.sh"
                fi
            fi
        fi
    fi

    sleep "$interval"
done

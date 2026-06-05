#!/bin/bash

is_true() {
    case "${1:-}" in
        true|TRUE|1|yes|YES|on|ON) return 0 ;;
        *) return 1 ;;
    esac
}

ensure_log_dir() {
    local path="$1"
    local dir
    dir="$(dirname "$path")"
    mkdir -p "$dir"
    if [ ! -w "$dir" ]; then
        echo "[start] warning: log directory is not writable: $dir" >&2
        return 1
    fi
}

start_wechat() {
    if [ -x /usr/bin/wechat ]; then
        nohup /usr/bin/wechat >/dev/null 2>&1 &
    fi
}

start_qq() {
    if [ -x /usr/bin/qq ]; then
        nohup /scripts/qq/qq-launch.sh >/dev/null 2>&1 &
    fi
}

start_tray() {
    if ! is_true "${ENABLE_STALONETRAY:-false}"; then
        pkill -x stalonetray >/dev/null 2>&1 || true
        return
    fi
    if ! pgrep -x stalonetray >/dev/null 2>&1; then
        nohup stalonetray --dockapp-mode simple >/dev/null 2>&1 &
    fi
}

sync_notification_theme() {
    mkdir -p /config/.config/dunst
    if [ ! -f /config/.config/dunst/dunstrc ] || ! cmp -s /defaults/dunstrc /config/.config/dunst/dunstrc; then
        cp /defaults/dunstrc /config/.config/dunst/dunstrc
    fi
}

start_notification_daemon() {
    sync_notification_theme
    if pgrep -x dunst >/dev/null 2>&1; then
        return
    fi
    DUNST_LOG_PATH="${DUNST_LOG_PATH:-/config/logs/dunst.log}"
    if ensure_log_dir "$DUNST_LOG_PATH"; then
        nohup dunst -config /config/.config/dunst/dunstrc >>"$DUNST_LOG_PATH" 2>&1 &
    else
        nohup dunst -config /config/.config/dunst/dunstrc >/tmp/dunst.log 2>&1 &
    fi
}

start_local_link_bridge() {
    if ! pgrep -f "/scripts/local_link_bridge.py" >/dev/null 2>&1; then
        LOCAL_LINK_BRIDGE_LOG_PATH="${LOCAL_LINK_BRIDGE_LOG_PATH:-/config/logs/local-link-bridge.log}"
        if ensure_log_dir "$LOCAL_LINK_BRIDGE_LOG_PATH"; then
            nohup python3 -u /scripts/local_link_bridge.py >>"$LOCAL_LINK_BRIDGE_LOG_PATH" 2>&1 &
        else
            nohup python3 -u /scripts/local_link_bridge.py >/tmp/local-link-bridge.log 2>&1 &
        fi
    fi
}

start_notification_bridge() {
    if ! pgrep -f "/scripts/notification_bridge.py" >/dev/null 2>&1; then
        nohup /scripts/run-notification-bridge.sh >/dev/null 2>&1 &
    fi
}

configure_audio_environment() {
    local audio_user uid gid runtime_dir
    chmod 1777 /tmp 2>/dev/null || true
    audio_user="${AUDIO_SERVICE_USER:-abc}"
    uid="$(id -u "$audio_user" 2>/dev/null || echo "${PUID:-1000}")"
    gid="$(id -g "$audio_user" 2>/dev/null || echo "${PGID:-100}")"
    runtime_dir="${XDG_RUNTIME_DIR:-/run/user/$uid}"
    export XDG_RUNTIME_DIR="$runtime_dir"
    export PULSE_RUNTIME_PATH="$runtime_dir/pulse"
    export PULSE_SERVER="unix:$runtime_dir/pulse/native"
    mkdir -p "$runtime_dir" /config/.config/pulse 2>/dev/null || true
    chown -R "$uid:$gid" "$runtime_dir" /config/.config/pulse 2>/dev/null || true
    chmod 700 "$runtime_dir" /config/.config/pulse 2>/dev/null || true
}

start_audio_service() {
    AUDIO_SERVICE_LOG_PATH="${AUDIO_SERVICE_LOG_PATH:-/config/logs/audio-service.log}"
    if ensure_log_dir "$AUDIO_SERVICE_LOG_PATH"; then
        /scripts/ensure-audio-service.sh >>"$AUDIO_SERVICE_LOG_PATH" 2>&1 || true
    else
        /scripts/ensure-audio-service.sh >/tmp/audio-service.log 2>&1 || true
    fi
}

start_session_auth_bridge() {
    if ! pgrep -f "/scripts/session_auth_bridge.py" >/dev/null 2>&1; then
        SELKIES_SESSION_AUTH_LOG_PATH="${SELKIES_SESSION_AUTH_LOG_PATH:-/config/logs/session-auth-bridge.log}"
        if ensure_log_dir "$SELKIES_SESSION_AUTH_LOG_PATH"; then
            nohup python3 -u /scripts/session_auth_bridge.py >>"$SELKIES_SESSION_AUTH_LOG_PATH" 2>&1 &
        else
            nohup python3 -u /scripts/session_auth_bridge.py >/tmp/session-auth-bridge.log 2>&1 &
        fi
    fi
}

reset_local_link_logs() {
    LOCAL_LINK_BRIDGE_LOG_PATH="${LOCAL_LINK_BRIDGE_LOG_PATH:-/config/logs/local-link-bridge.log}"
    SELKIES_LOCAL_LINK_LOG_PATH="${SELKIES_LOCAL_LINK_LOG_PATH:-/config/logs/local-link-open.log}"
    ensure_log_dir "$LOCAL_LINK_BRIDGE_LOG_PATH" || return 0
    ensure_log_dir "$SELKIES_LOCAL_LINK_LOG_PATH" || return 0
    : >"$LOCAL_LINK_BRIDGE_LOG_PATH"
    : >"$SELKIES_LOCAL_LINK_LOG_PATH"
}

start_local_link_log_reset_loop() {
    if ! is_true "${SELKIES_LOCAL_LINK_OPEN:-true}"; then
        return
    fi
    if pgrep -f "/scripts/local-link-log-reset-loop.sh" >/dev/null 2>&1; then
        return
    fi

    LOCAL_LINK_LOG_RESET_INTERVAL_SECONDS="${LOCAL_LINK_LOG_RESET_INTERVAL_SECONDS:-10800}"
    if ! [[ "$LOCAL_LINK_LOG_RESET_INTERVAL_SECONDS" =~ ^[0-9]+$ ]] || [ "$LOCAL_LINK_LOG_RESET_INTERVAL_SECONDS" -lt 300 ]; then
        LOCAL_LINK_LOG_RESET_INTERVAL_SECONDS="10800"
    fi

    cat >/tmp/local-link-log-reset-loop.sh <<'EOF'
#!/bin/bash
set -euo pipefail
LOCAL_LINK_BRIDGE_LOG_PATH="${LOCAL_LINK_BRIDGE_LOG_PATH:-/config/logs/local-link-bridge.log}"
SELKIES_LOCAL_LINK_LOG_PATH="${SELKIES_LOCAL_LINK_LOG_PATH:-/config/logs/local-link-open.log}"
LOCAL_LINK_LOG_RESET_INTERVAL_SECONDS="${LOCAL_LINK_LOG_RESET_INTERVAL_SECONDS:-10800}"
while true; do
    sleep "$LOCAL_LINK_LOG_RESET_INTERVAL_SECONDS"
    : >"$LOCAL_LINK_BRIDGE_LOG_PATH"
    : >"$SELKIES_LOCAL_LINK_LOG_PATH"
done
EOF
    chmod +x /tmp/local-link-log-reset-loop.sh
    nohup /tmp/local-link-log-reset-loop.sh >/dev/null 2>&1 &
}

wait_local_link_bridge_ready() {
    if ! is_true "${SELKIES_LOCAL_LINK_OPEN:-true}"; then
        return 0
    fi
    local port="${LOCAL_LINK_BRIDGE_PORT:-38080}"
    local retries="${LOCAL_LINK_BRIDGE_READY_RETRIES:-20}"
    local delay="${LOCAL_LINK_BRIDGE_READY_DELAY_SECONDS:-0.25}"
    python3 - "$port" "$retries" "$delay" <<'PY'
import json
import sys
import time
import urllib.request

port = int(sys.argv[1])
retries = int(float(sys.argv[2]))
delay = float(sys.argv[3])
url = f"http://127.0.0.1:{port}/health"
for _ in range(max(1, retries)):
    try:
        with urllib.request.urlopen(url, timeout=1.0) as resp:
            data = json.loads(resp.read().decode("utf-8", errors="replace"))
            if data.get("ok"):
                sys.exit(0)
    except Exception:
        time.sleep(delay)
sys.exit(1)
PY
}

start_split_fab() {
    if ! pgrep -f "/scripts/split_fab.py" >/dev/null 2>&1; then
        SPLIT_FAB_LOG_PATH="${SPLIT_FAB_LOG_PATH:-/config/logs/split-fab.log}"
        mkdir -p "$(dirname "$SPLIT_FAB_LOG_PATH")"
        nohup python3 /scripts/split_fab.py >>"$SPLIT_FAB_LOG_PATH" 2>&1 &
    fi
}

reconfigure_openbox() {
    openbox --reconfigure >/dev/null 2>&1 || true
}

patch_openbox_right_click_menu() {
    local target_menu="client-menu"
    if is_true "${ENABLE_RIGHT_CLICK_SPLIT:-true}"; then
        target_menu="window-right-click-menu"
    fi

    if [ -f /config/.config/openbox/rc.xml ]; then
        local result=""
        if result=$(python3 /scripts/patch_openbox_rc.py /config/.config/openbox/rc.xml --target-menu-id "$target_menu" 2>/tmp/patch-openbox-rc.err); then
            if [ "$result" = "changed" ]; then
                reconfigure_openbox
            fi
        else
            echo "[start] patch_openbox_rc failed: $(cat /tmp/patch-openbox-rc.err)" >&2
        fi
        rm -f /tmp/patch-openbox-rc.err
    fi
}

# configure openbox dock mode for stalonetray
if [ ! -f /config/.config/openbox/rc.xml ] || grep -A20 "<dock>" /config/.config/openbox/rc.xml | grep -q "<noStrut>no</noStrut>"; then
    mkdir -p /config/.config/openbox
    [ ! -f /config/.config/openbox/rc.xml ] && cp /etc/xdg/openbox/rc.xml /config/.config/openbox/
    sed -i '/<dock>/,/<\/dock>/s/<noStrut>no<\/noStrut>/<noStrut>yes<\/noStrut>/' /config/.config/openbox/rc.xml
    reconfigure_openbox
fi

# update openbox menu if differs from default
if [ ! -f /config/.config/openbox/menu.xml ] || ! cmp /defaults/menu.xml /config/.config/openbox/menu.xml; then
    mkdir -p /config/.config/openbox
    cp /defaults/menu.xml /config/.config/openbox/menu.xml
    reconfigure_openbox
fi

patch_openbox_right_click_menu

chmod 1777 /tmp 2>/dev/null || true
configure_audio_environment
start_tray
start_audio_service
start_notification_daemon
start_session_auth_bridge
start_notification_bridge

if is_true "${SELKIES_LOCAL_LINK_OPEN:-true}"; then
    reset_local_link_logs
    start_local_link_bridge
    start_local_link_log_reset_loop
    wait_local_link_bridge_ready || echo "[start] warning: local link bridge did not report ready in time" >&2
fi

# start WeChat application in the background if exists and auto-start enabled
if is_true "${AUTO_START_WECHAT:-true}"; then
    start_wechat
fi

# start QQ application in the background if exists and auto-start enabled
if is_true "${AUTO_START_QQ:-false}"; then
    start_qq
fi

# launch process watchdog for long-running stability
if is_true "${PROCESS_WATCHDOG:-true}"; then
    WATCHDOG_LOG_PATH="${WATCHDOG_LOG_PATH:-/config/logs/process-watchdog.log}"
    if ensure_log_dir "$WATCHDOG_LOG_PATH"; then
        nohup /scripts/process-watchdog.sh >>"$WATCHDOG_LOG_PATH" 2>&1 &
    else
        nohup /scripts/process-watchdog.sh >/tmp/process-watchdog.log 2>&1 &
    fi
fi

# start split FAB process for quick left/right tiling when there are >=2 windows
if is_true "${ENABLE_SPLIT_FAB:-false}"; then
    start_split_fab
fi

# !deprecated: start window switcher application in the background
# start window switcher application in the background
# nohup sleep 2 && python /scripts/window_switcher.py > /dev/null 2>&1 &

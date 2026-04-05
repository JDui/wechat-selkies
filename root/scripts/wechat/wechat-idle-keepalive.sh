#!/bin/bash
set -euo pipefail

is_true() {
    case "${1:-}" in
        true|TRUE|1|yes|YES|on|ON) return 0 ;;
        *) return 1 ;;
    esac
}

validate_idle_seconds() {
    if [[ "${1:-}" =~ ^[0-9]+$ ]] && [ "$1" -ge 60 ]; then
        echo "$1"
    else
        echo "900"
    fi
}

validate_random_min() {
    if [[ "${1:-}" =~ ^[0-9]+$ ]] && [ "$1" -ge 60 ]; then
        echo "$1"
    else
        echo "1080"
    fi
}

validate_random_max() {
    local raw="${1:-}"
    local min_val="${2:-1080}"
    if [[ "$raw" =~ ^[0-9]+$ ]] && [ "$raw" -ge "$min_val" ]; then
        echo "$raw"
    else
        echo "1920"
    fi
}

log() {
    printf '%s [wechat-keepalive] %s\n' "$(date -Iseconds)" "$*"
}

is_normal_window() {
    local wid="$1"
    xprop -id "$wid" _NET_WM_WINDOW_TYPE 2>/dev/null | grep -q "_NET_WM_WINDOW_TYPE_NORMAL"
}

is_transient_window() {
    local wid="$1"
    xprop -id "$wid" WM_TRANSIENT_FOR 2>/dev/null | grep -q "window id #"
}

window_title() {
    local wid="$1"
    xdotool getwindowname "$wid" 2>/dev/null || true
}

score_window() {
    local title="$1"
    case "$title" in
        "WeChat Beta"|"WeChat")
            echo 300
            ;;
        *"WeChat"*)
            echo 180
            ;;
        "")
            echo 0
            ;;
        *)
            echo 40
            ;;
    esac
}

get_wechat_main_window() {
    local best_wid=""
    local best_score=-1
    local candidates
    candidates="$(xdotool search --onlyvisible --class 'wechat' 2>/dev/null || true)"
    if [ -z "$candidates" ]; then
        candidates="$(xdotool search --onlyvisible --name 'WeChat Beta|WeChat' 2>/dev/null || true)"
    fi

    local wid
    for wid in $candidates; do
        if ! is_normal_window "$wid"; then
            continue
        fi
        if is_transient_window "$wid"; then
            continue
        fi
        local title score
        title="$(window_title "$wid")"
        score="$(score_window "$title")"
        if [ "$score" -gt "$best_score" ]; then
            best_score="$score"
            best_wid="$wid"
        fi
    done

    echo "$best_wid"
}

next_sleep_seconds() {
    if [ "$random_max" -le "$random_min" ]; then
        echo "$random_min"
        return
    fi
    echo $(( random_min + RANDOM % (random_max - random_min + 1) ))
}

perform_keepalive_action() {
    local current_wid="$1"
    local wechat_wid="$2"

    xdotool windowmap "$wechat_wid" >/dev/null 2>&1 || true
    xdotool windowraise "$wechat_wid" >/dev/null 2>&1 || true
    xdotool windowactivate --sync "$wechat_wid" >/dev/null 2>&1 || true

    local geo shell_w shell_h
    geo="$(xdotool getwindowgeometry --shell "$wechat_wid" 2>/dev/null || true)"
    eval "$geo"
    shell_w="${WIDTH:-1200}"
    shell_h="${HEIGHT:-800}"

    local list_x click_y scroll_steps
    list_x=$(( shell_w / 5 ))
    if [ "$list_x" -lt 160 ]; then list_x=160; fi
    if [ "$list_x" -gt 280 ]; then list_x=280; fi

    click_y=$(( shell_h / 4 + RANDOM % (shell_h / 3) ))
    if [ "$click_y" -lt 170 ]; then click_y=170; fi
    if [ "$click_y" -gt $((shell_h - 120)) ]; then click_y=$((shell_h - 120)); fi

    scroll_steps=$(( 1 + RANDOM % 5 ))

    xdotool mousemove --window "$wechat_wid" "$list_x" "$click_y" >/dev/null 2>&1 || true

    local i
    for ((i=0; i<scroll_steps; i++)); do
        xdotool click --window "$wechat_wid" 5 >/dev/null 2>&1 || true
        sleep 0.12
    done
    sleep 1
    xdotool click --window "$wechat_wid" 1 >/dev/null 2>&1 || true
    sleep 1
    for ((i=0; i<scroll_steps; i++)); do
        xdotool click --window "$wechat_wid" 4 >/dev/null 2>&1 || true
        sleep 0.12
    done

    if [ -n "$current_wid" ] && [ "$current_wid" != "$wechat_wid" ]; then
        xdotool windowraise "$current_wid" >/dev/null 2>&1 || true
        xdotool windowactivate --sync "$current_wid" >/dev/null 2>&1 || true
    fi
}

run_once() {
    if ! pgrep -af "/usr/bin/wechat" >/dev/null 2>&1; then
        log "skip keepalive: wechat process not running"
        return 0
    fi

    local current_wid wechat_wid
    current_wid="$(xdotool getactivewindow 2>/dev/null || true)"
    wechat_wid="$(get_wechat_main_window)"

    if [ -z "$wechat_wid" ]; then
        log "skip keepalive: no visible wechat main window matched"
        return 0
    fi

    perform_keepalive_action "$current_wid" "$wechat_wid"
    log "keepalive action complete wechat_wid=${wechat_wid}"
}

idle_seconds="$(validate_idle_seconds "${WECHAT_KEEPALIVE_IDLE_SECONDS:-900}")"
random_min="$(validate_random_min "${WECHAT_KEEPALIVE_RANDOM_MIN_SECONDS:-1080}")"
random_max="$(validate_random_max "${WECHAT_KEEPALIVE_RANDOM_MAX_SECONDS:-1920}" "$random_min")"
idle_threshold_ms=$((idle_seconds * 1000))

if ! command -v xdotool >/dev/null 2>&1; then
    log "xdotool not found, exit"
    exit 0
fi

if [ "${1:-}" = "--once" ]; then
    exec 8>/tmp/wechat-idle-keepalive-once.lock
    if ! flock -n 8; then
        log "skip keepalive: once task already running"
        exit 0
    fi
    run_once
    exit 0
fi

exec 8>/tmp/wechat-idle-keepalive.lock
if ! flock -n 8; then
    log "already running, exit"
    exit 0
fi

log "started idle_threshold=${idle_seconds}s random_window=${random_min}-${random_max}s"

while true; do
    sleep_for="$(next_sleep_seconds)"

    if ! is_true "${WECHAT_IDLE_KEEPALIVE:-true}"; then
        sleep "$sleep_for"
        continue
    fi

    if ! pgrep -af "/usr/bin/wechat" >/dev/null 2>&1; then
        log "skip keepalive: wechat process not running next_sleep=${sleep_for}s"
        sleep "$sleep_for"
        continue
    fi

    idle_ms=999999999
    if command -v xprintidle >/dev/null 2>&1; then
        idle_raw="$(xprintidle 2>/dev/null || echo 0)"
        if [[ "$idle_raw" =~ ^[0-9]+$ ]]; then
            idle_ms="$idle_raw"
        fi
    fi

    if [ "$idle_ms" -lt "$idle_threshold_ms" ]; then
        sleep "$sleep_for"
        continue
    fi

    run_once
    sleep "$sleep_for"
done


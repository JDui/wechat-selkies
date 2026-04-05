#!/bin/bash

set -euo pipefail

log() {
    printf '%s [x11-recover] %s\n' "$(date -Iseconds)" "$*"
}

display_ready() {
    DISPLAY="${DISPLAY:-:1}" timeout 2s bash -lc '
        if command -v xset >/dev/null 2>&1 && DISPLAY="${DISPLAY}" xset q >/dev/null 2>&1; then
            exit 0
        fi
        if command -v xdpyinfo >/dev/null 2>&1 && DISPLAY="${DISPLAY}" xdpyinfo >/dev/null 2>&1; then
            exit 0
        fi
        if command -v xrandr >/dev/null 2>&1 && DISPLAY="${DISPLAY}" xrandr --current >/dev/null 2>&1; then
            exit 0
        fi
        exit 1
    '
}

wait_for_display_ready() {
    local attempts=0
    while [ "$attempts" -lt 20 ]; do
        if display_ready; then
            log "display is ready"
            return 0
        fi
        attempts=$((attempts + 1))
        sleep 1
    done
    log "display did not become ready in time"
    return 1
}

restart_service() {
    local service_name="$1"
    local service_dir="/run/service/${service_name}"
    if [ ! -d "${service_dir}" ]; then
        return
    fi
    log "restart ${service_name}"
    s6-svc -r "${service_dir}" || true
}

restart_service "svc-xorg"
wait_for_display_ready || exit 1
restart_service "svc-xsettingsd"
restart_service "svc-de"
restart_service "svc-selkies"

exit 0

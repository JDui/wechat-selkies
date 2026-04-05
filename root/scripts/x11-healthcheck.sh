#!/bin/bash

set -euo pipefail

validate_timeout() {
    if [[ "${1:-}" =~ ^[0-9]+$ ]] && [ "$1" -ge 1 ] && [ "$1" -le 10 ]; then
        echo "$1"
    else
        echo "2"
    fi
}

if ! command -v xrandr >/dev/null 2>&1; then
    primary_probe=""
else
    primary_probe="xrandr --current >/dev/null"
fi

if ! command -v timeout >/dev/null 2>&1; then
    exit 0
fi

display_name="${DISPLAY:-:1}"
timeout_s="$(validate_timeout "${X11_HEALTHCHECK_TIMEOUT:-2}")"
err_file="$(mktemp)"

probe() {
    local cmd="$1"
    : >"${err_file}"
    if timeout "${timeout_s}"s bash -lc "DISPLAY='${display_name}' ${cmd}" 2>"${err_file}"; then
        return 0
    fi
    return 1
}

primary_ok=1
if [ -n "${primary_probe}" ]; then
    if probe "${primary_probe}"; then
        rm -f "${err_file}"
        exit 0
    fi
else
    primary_ok=0
fi

err_text="$(cat "${err_file}" 2>/dev/null || true)"

if echo "${err_text}" | grep -qi "Maximum number of clients reached"; then
    rm -f "${err_file}"
    exit 2
fi

if echo "${err_text}" | grep -qi "Can't open display"; then
    rm -f "${err_file}"
    exit 3
fi

if command -v xdpyinfo >/dev/null 2>&1; then
    if probe "xdpyinfo >/dev/null"; then
        rm -f "${err_file}"
        exit 0
    fi
fi

if command -v xset >/dev/null 2>&1; then
    if probe "xset q >/dev/null"; then
        rm -f "${err_file}"
        exit 0
    fi
fi

if command -v xprop >/dev/null 2>&1; then
    if probe "xprop -root _NET_SUPPORTING_WM_CHECK >/dev/null"; then
        rm -f "${err_file}"
        exit 0
    fi
fi

rm -f "${err_file}"

exit 1

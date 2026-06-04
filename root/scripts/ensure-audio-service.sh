#!/bin/bash
set -euo pipefail

LOG_PREFIX="[audio-service]"

is_true() {
    case "${1:-}" in
        true|TRUE|1|yes|YES|on|ON) return 0 ;;
        *) return 1 ;;
    esac
}

fix_runtime_dirs() {
    chmod 1777 /tmp 2>/dev/null || true

    local audio_user uid gid runtime_dir
    audio_user="${AUDIO_SERVICE_USER:-abc}"
    uid="$(id -u "$audio_user" 2>/dev/null || echo "${PUID:-1000}")"
    gid="$(id -g "$audio_user" 2>/dev/null || echo "${PGID:-100}")"
    runtime_dir="${XDG_RUNTIME_DIR:-/run/user/$uid}"
    export XDG_RUNTIME_DIR="$runtime_dir"
    export PULSE_RUNTIME_PATH="$runtime_dir/pulse"
    export PULSE_SERVER="unix:$runtime_dir/pulse/native"

    mkdir -p "$runtime_dir" /config/.config/pulse 2>/dev/null || true
    chown -R "$uid:$gid" "$runtime_dir" /config/.config/pulse 2>/dev/null || true
    chmod 700 "$runtime_dir" 2>/dev/null || true
    chmod 700 /config/.config/pulse 2>/dev/null || true
}

pulse_is_ready() {
    command -v pactl >/dev/null 2>&1 && pactl info >/dev/null 2>&1
}

ensure_null_sink() {
    if ! command -v pactl >/dev/null 2>&1; then
        return 0
    fi
    if pactl list short sinks 2>/dev/null | awk '{print $2}' | grep -qx "selkies_output"; then
        pactl set-default-sink selkies_output >/dev/null 2>&1 || true
        pactl set-default-source selkies_output.monitor >/dev/null 2>&1 || true
        return 0
    fi
    pactl load-module module-null-sink sink_name=selkies_output sink_properties=device.description=Selkies_Output >/dev/null 2>&1 || true
    pactl set-default-sink selkies_output >/dev/null 2>&1 || true
    pactl set-default-source selkies_output.monitor >/dev/null 2>&1 || true
}

if is_true "${SELKIES_DISABLE_AUDIO_SERVICE:-false}"; then
    echo "$LOG_PREFIX disabled by SELKIES_DISABLE_AUDIO_SERVICE"
    exit 0
fi

fix_runtime_dirs

if pulse_is_ready; then
    ensure_null_sink
    echo "$LOG_PREFIX pulseaudio already available"
    exit 0
fi

if ! command -v pulseaudio >/dev/null 2>&1; then
    echo "$LOG_PREFIX pulseaudio binary is not installed"
    exit 0
fi

audio_user="${AUDIO_SERVICE_USER:-abc}"
if command -v s6-svc >/dev/null 2>&1 && [ -e /run/service/svc-pulseaudio ]; then
    s6-svc -u /run/service/svc-pulseaudio >/dev/null 2>&1 || true
fi

for _attempt in 1 2 3 4 5; do
    pulse_is_ready && break
    sleep 0.4
done

if ! pulse_is_ready; then
    if command -v s6-svc >/dev/null 2>&1 && [ -e /run/service/svc-pulseaudio ]; then
        s6-svc -d /run/service/svc-pulseaudio >/dev/null 2>&1 || true
    fi
    pkill -u "$audio_user" pulseaudio >/dev/null 2>&1 || true
    rm -f "$PULSE_RUNTIME_PATH/native" "$PULSE_RUNTIME_PATH/pid" 2>/dev/null || true
    s6-setuidgid "$audio_user" env -u PULSE_SERVER \
        HOME="${HOME:-/config}" \
        XDG_RUNTIME_DIR="$XDG_RUNTIME_DIR" \
        PULSE_RUNTIME_PATH="$PULSE_RUNTIME_PATH" \
        pulseaudio --start --exit-idle-time=-1 >/dev/null 2>&1 || true
fi

for _attempt in 1 2 3 4 5; do
    if pulse_is_ready; then
        ensure_null_sink
        echo "$LOG_PREFIX pulseaudio started"
        exit 0
    fi
    sleep 0.4
done

echo "$LOG_PREFIX pulseaudio did not become ready"
exit 0

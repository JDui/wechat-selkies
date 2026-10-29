#!/bin/bash

set -uo pipefail

app="${1:-}"
case "$app" in
    wechat|qq) shift ;;
    *) echo "usage: run-desktop-app.sh wechat|qq COMMAND [ARGS...]" >&2; exit 2 ;;
esac
if [ "$#" -eq 0 ]; then
    exit 2
fi

if [ "$app" = wechat ]; then
    # Serialize startup, watchdog and manual launch attempts without touching
    # WeChat's own account locks. The fd is held for the application's lifetime.
    launch_state="${DESKTOP_APP_STATE_DIR:-/config/state}"
    mkdir -p "$launch_state" || exit 1
    exec 8>"$launch_state/wechat-launch.lock" || exit 1
    if ! flock -n 8; then
        echo '[wechat-launch] already managed by another launcher' >&2
        exit 0
    fi
    case "${WECHAT_PROXY_MODE:-direct}" in
        direct)
            unset http_proxy https_proxy all_proxy ftp_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY FTP_PROXY
            export no_proxy='*' NO_PROXY='*'
            ;;
        inherit) ;;
        *) echo '[wechat-launch] WECHAT_PROXY_MODE must be direct or inherit' >&2; exit 64 ;;
    esac
fi

# Apply to the app and its children, including launches from the desktop menu
# and watchdog. Never change the NAS host's shared kernel.core_pattern.
case "${DISABLE_CORE_DUMPS:-true}" in
    true|TRUE|1|yes|YES|on|ON)
        ulimit -c 0 || echo "[$app-launch] warning: could not disable core dumps" >&2
        ;;
esac

log_path="${DESKTOP_APP_LOG_DIR:-/config/logs}/${app}-client.log"
if ! mkdir -p "$(dirname "$log_path")" || ! touch "$log_path"; then
    echo "[$app-launch] warning: client log is not writable: $log_path" >&2
    exec "$@"
fi

# Reuse the bounded writer so diagnostic output cannot become another source
# of unbounded disk growth. Keep the actual application exit status.
(
    printf '%s [%s-client] STARTED core_limit=%s\n' "$(date -Iseconds)" "$app" "$(ulimit -c)"
    if [ "$app" = wechat ]; then
        app_version="$(dpkg-query -W -f='${Version}' wechat 2>/dev/null || echo unknown)"
        printf '%s [wechat-client] ENV version=%s proxy_mode=%s timezone=%s identity_persisted=%s\n' \
            "$(date -Iseconds)" "$app_version" "${WECHAT_PROXY_MODE:-direct}" "${TZ:-system}" \
            "$([ -s /run/selkies-system-identity-ready ] && echo true || echo false)"
    fi
    "$@"
    app_status=$?
    printf '%s [%s-client] EXITED status=%s\n' "$(date -Iseconds)" "$app" "$app_status"
    exit "$app_status"
) 2>&1 | python3 -u /scripts/size_limited_log_writer.py "$log_path" "${DESKTOP_APP_LOG_MAX_BYTES:-1048576}"
exit "${PIPESTATUS[0]}"

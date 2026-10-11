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
    "$@"
    app_status=$?
    printf '%s [%s-client] EXITED status=%s\n' "$(date -Iseconds)" "$app" "$app_status"
    exit "$app_status"
) 2>&1 | python3 -u /scripts/size_limited_log_writer.py "$log_path" "${DESKTOP_APP_LOG_MAX_BYTES:-1048576}"
exit "${PIPESTATUS[0]}"

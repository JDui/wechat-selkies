#!/bin/bash
set -euo pipefail

. /scripts/local-link-open-helper.sh

REAL_XDG_OPEN="/usr/bin/xdg-open.real"
if [ ! -x "$REAL_XDG_OPEN" ]; then
    if command -v gio >/dev/null 2>&1; then
        exec gio open "$@"
    fi
    echo "xdg-open fallback not found" >&2
    exit 1
fi

TARGET="$(extract_link_target "$@" || true)"
if [ -z "$TARGET" ]; then
    exec "$REAL_XDG_OPEN" "$@"
fi

if ! is_true "${SELKIES_LOCAL_LINK_OPEN:-true}"; then
    exec "$REAL_XDG_OPEN" "$@"
fi

log_local_link_event "xdg-open invoked: $*"

if bridge_local_link "$TARGET" "xdg-open"; then
    log_local_link_event "xdg-open bridged: $TARGET"
    exit 0
fi

log_local_link_event "xdg-open fallback: $TARGET"

exec "$REAL_XDG_OPEN" "$@"

#!/bin/bash
set -euo pipefail

. /scripts/local-link-open-helper.sh

REAL_GIO="/usr/bin/gio.real"
if [ ! -x "$REAL_GIO" ]; then
    echo "gio fallback not found" >&2
    exit 1
fi

if [ "${1:-}" != "open" ]; then
    exec "$REAL_GIO" "$@"
fi

if ! is_true "${SELKIES_LOCAL_LINK_OPEN:-true}"; then
    exec "$REAL_GIO" "$@"
fi

shift
TARGET="$(extract_link_target "$@" || true)"
if [ -z "$TARGET" ]; then
    exec "$REAL_GIO" open "$@"
fi

log_local_link_event "gio open invoked: $TARGET"

if bridge_local_link "$TARGET" "gio-open"; then
    log_local_link_event "gio open bridged: $TARGET"
    exit 0
fi

log_local_link_event "gio open fallback: $TARGET"
exec "$REAL_GIO" open "$@"

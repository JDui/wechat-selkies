#!/bin/bash

is_true() {
    case "${1:-}" in
        true|TRUE|1|yes|YES|on|ON) return 0 ;;
        *) return 1 ;;
    esac
}

log_local_link_event() {
    local log_path="${SELKIES_LOCAL_LINK_LOG_PATH:-/config/logs/local-link-open.log}"
    mkdir -p "$(dirname "$log_path")" 2>/dev/null || true
    printf '[%s] %s\n' "$(date '+%F %T')" "$*" >>"$log_path" 2>/dev/null || true
}

extract_link_target() {
    local arg=""
    for arg in "$@"; do
        case "$arg" in
            --) continue ;;
            http://*|https://*|mailto:*) printf '%s\n' "$arg"; return 0 ;;
        esac
    done
    return 1
}

bridge_local_link() {
    local url="$1"
    local source="${2:-open}"
    local port="${LOCAL_LINK_BRIDGE_PORT:-38080}"

    python3 - "$url" "$port" "$source" <<'PY'
import json
import sys
import urllib.parse
import urllib.request

url = sys.argv[1]
port = int(sys.argv[2])
source = sys.argv[3]
endpoint = "http://127.0.0.1:%d/push" % port
payload = urllib.parse.urlencode({"url": url, "source": source}).encode("utf-8")
request = urllib.request.Request(endpoint, data=payload, method="POST")
request.add_header("Content-Type", "application/x-www-form-urlencoded")
with urllib.request.urlopen(request, timeout=1.5) as response:
    body = response.read().decode("utf-8", errors="replace")
    parsed = json.loads(body)
    if not parsed.get("ok", False):
        raise RuntimeError("bridge rejected url")
PY
}

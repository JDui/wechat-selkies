#!/bin/bash
set -u
pattern='^/usr/bin/[w]echat([[:space:]]|$)'
pkill -TERM -f "$pattern" 2>/dev/null || true
for attempt in $(seq 1 25); do
    pgrep -f "$pattern" >/dev/null || break
    sleep .2
done
if pgrep -f "$pattern" >/dev/null; then
    pkill -KILL -f "$pattern" 2>/dev/null || true
fi
# Let the previous managed launcher finish writing the final lifecycle record.
state_dir="${DESKTOP_APP_STATE_DIR:-/config/state}"
mkdir -p "$state_dir" || exit 1
flock -w 8 "$state_dir/wechat-launch.lock" true || exit 1
nohup /scripts/wechat/wechat-start.sh >/dev/null 2>&1 &

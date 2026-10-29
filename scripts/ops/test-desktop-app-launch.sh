#!/bin/bash
# Run only in a disposable Linux container with the current /scripts mounted.
set -euo pipefail

task_tmp="$(mktemp -d /tmp/desktop-app-check.XXXXXX)"
trap 'rm -rf -- "$task_tmp"' EXIT
export DESKTOP_APP_LOG_DIR="$task_tmp/logs"
export DESKTOP_APP_STATE_DIR="$task_tmp/state"
export DESKTOP_APP_LOG_MAX_BYTES=65536

set +e
DISABLE_CORE_DUMPS=true bash /scripts/run-desktop-app.sh wechat bash -c \
    'printf "CORE_SOFT=%s CORE_HARD=%s\n" "$(ulimit -Sc)" "$(ulimit -Hc)"; exit 7'
task_status=$?
set -e
test "$task_status" -eq 7
grep -q 'CORE_SOFT=0 CORE_HARD=0' "$task_tmp/logs/wechat-client.log"
grep -q 'EXITED status=7' "$task_tmp/logs/wechat-client.log"

HTTP_PROXY=http://example.invalid http_proxy=http://example.invalid WECHAT_PROXY_MODE=direct \
    bash /scripts/run-desktop-app.sh wechat bash -c 'test -z "${HTTP_PROXY:-}${http_proxy:-}" && test "$NO_PROXY" = "*"'
HTTP_PROXY=http://example.invalid WECHAT_PROXY_MODE=inherit \
    bash /scripts/run-desktop-app.sh wechat bash -c 'test "$HTTP_PROXY" = http://example.invalid'

# The duplicate must finish without executing another app while the first lives.
bash /scripts/run-desktop-app.sh wechat bash -c 'touch "$1"; sleep 2' _ "$task_tmp/first-ready" &
first_launcher=$!
for attempt in $(seq 1 30); do
    [ -e "$task_tmp/first-ready" ] && break
    sleep .05
done
test -e "$task_tmp/first-ready"
bash /scripts/run-desktop-app.sh wechat touch "$task_tmp/duplicate-started"
test ! -e "$task_tmp/duplicate-started"
wait "$first_launcher"

# Exercise the actual QQ launch branch with a tiny mock executable. Never
# start the installed client or alter the container's /usr/bin/qq.
cat >"$task_tmp/mock-qq" <<'EOF'
#!/bin/bash
printf 'started\n' >>"$MOCK_QQ_STARTS"
exit 7
EOF
chmod +x "$task_tmp/mock-qq"
export MOCK_QQ_STARTS="$task_tmp/qq-starts"
sed "s|/usr/bin/qq|$task_tmp/mock-qq|g" /scripts/qq/qq-launch.sh >"$task_tmp/qq-launch.sh"
set +e
QQ_NICE_LEVEL=1 bash "$task_tmp/qq-launch.sh"
task_status=$?
set -e
test "$task_status" -eq 7
test "$(wc -l <"$MOCK_QQ_STARTS")" -eq 1
grep -q 'EXITED status=7' "$task_tmp/logs/qq-client.log"

# A diagnostics failure must not break client stdout or change its exit code.
DESKTOP_APP_LOG_DIR=/dev/null bash /scripts/run-desktop-app.sh qq bash -c 'exit 0'
echo 'desktop app launch checks passed: core limits, exit code, one QQ launch, unwritable log'

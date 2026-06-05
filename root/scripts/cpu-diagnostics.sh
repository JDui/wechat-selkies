#!/bin/bash
set -euo pipefail

echo "== CPU visibility =="
echo "nproc: $(nproc 2>/dev/null || echo unknown)"
if command -v getconf >/dev/null 2>&1; then
  echo "getconf _NPROCESSORS_ONLN: $(getconf _NPROCESSORS_ONLN 2>/dev/null || echo unknown)"
fi
if [ -r /proc/self/status ]; then
  grep -E "Cpus_allowed_list|Mems_allowed_list" /proc/self/status || true
fi

echo
echo "== cgroup cpu limit =="
if [ -r /sys/fs/cgroup/cpu.max ]; then
  cpu_max="$(cat /sys/fs/cgroup/cpu.max)"
  echo "cpu.max: $cpu_max"
  quota="$(printf '%s' "$cpu_max" | awk '{print $1}')"
  period="$(printf '%s' "$cpu_max" | awk '{print $2}')"
  if [ "$quota" = "max" ]; then
    echo "quota cores: unlimited"
  elif [ -n "$quota" ] && [ -n "$period" ] && [ "$period" -gt 0 ] 2>/dev/null; then
    awk -v q="$quota" -v p="$period" 'BEGIN { printf "quota cores: %.2f\n", q / p }'
  fi
elif [ -r /sys/fs/cgroup/cpu/cpu.cfs_quota_us ]; then
  quota="$(cat /sys/fs/cgroup/cpu/cpu.cfs_quota_us)"
  period="$(cat /sys/fs/cgroup/cpu/cpu.cfs_period_us)"
  echo "cpu.cfs_quota_us: $quota"
  echo "cpu.cfs_period_us: $period"
  if [ "$quota" -lt 0 ] 2>/dev/null; then
    echo "quota cores: unlimited"
  elif [ "$period" -gt 0 ] 2>/dev/null; then
    awk -v q="$quota" -v p="$period" 'BEGIN { printf "quota cores: %.2f\n", q / p }'
  fi
else
  echo "cpu cgroup files not found"
fi

echo
echo "== memory =="
if [ -r /sys/fs/cgroup/memory.max ]; then
  echo "memory.max: $(cat /sys/fs/cgroup/memory.max)"
elif [ -r /sys/fs/cgroup/memory/memory.limit_in_bytes ]; then
  echo "memory.limit_in_bytes: $(cat /sys/fs/cgroup/memory/memory.limit_in_bytes)"
fi
free -h 2>/dev/null || true
df -h /dev/shm 2>/dev/null || true

echo
echo "== /dev/dri =="
if [ -d /dev/dri ]; then
  ls -l /dev/dri
else
  echo "/dev/dri not present; H.264 will use CPU unless another encoder is selected"
fi

echo
echo "== process snapshot =="
if command -v ps >/dev/null 2>&1; then
  ps -eLo pid,ppid,tid,psr,pcpu,pmem,comm --sort=-pcpu | head -n 25
fi

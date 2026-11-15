#!/usr/bin/env python3
"""Read-only 8-second CPU/GPU sample. No command arguments or account data."""
import json
import os
import time
from pathlib import Path


def snapshot():
    processes, clients = {}, {}
    for proc in Path('/proc').iterdir():
        if not proc.name.isdigit():
            continue
        try:
            raw = (proc / 'stat').read_text()
            fields = raw[raw.rfind(')') + 2:].split()
            name = raw[raw.find('(') + 1:raw.rfind(')')]
            if name.startswith('python'):
                args = (proc / 'cmdline').read_bytes().split(b'\0')
                name = next((Path(a.decode(errors='replace')).name for a in args if a.endswith(b'.py')), name)
            processes[proc.name] = dict(name=name, ticks=int(fields[11])+int(fields[12]),
                                       start=fields[19], rss_bytes=int(fields[21])*os.sysconf('SC_PAGE_SIZE'))
            for info in (proc / 'fdinfo').iterdir():
                try:
                    values = dict(line.split(':', 1) for line in info.read_text().splitlines() if ':' in line)
                    client = values.get('drm-client-id')
                    if not client:
                        continue
                    key = values.get('drm-pdev', '').strip() + ':' + client.strip()
                    engines = {k[11:]: int(v.strip().split()[0]) for k, v in values.items()
                               if k.startswith('drm-engine-') and v.strip().endswith(' ns')}
                    clients[key] = dict(pid=proc.name, name=name, engines=engines)
                except (OSError, ValueError):
                    pass
        except (OSError, ValueError, IndexError):
            pass
    return processes, clients


def main():
    def cpu_counters():
        cg = dict(line.split() for line in Path('/sys/fs/cgroup/cpu.stat').read_text().splitlines())
        host = [int(x) for x in Path('/proc/stat').read_text().splitlines()[0].split()[1:9]]
        return int(cg['usage_usec']), sum(host), host[3]+host[4]

    counters_start = cpu_counters()
    first, gpu_first = snapshot()
    start = time.monotonic()
    time.sleep(8)
    last, gpu_last = snapshot()
    elapsed = time.monotonic() - start
    counters_end = cpu_counters()
    hz = os.sysconf('SC_CLK_TCK')
    rows = []
    for pid, row in last.items():
        old = first.get(pid)
        if old and old['start'] == row['start']:
            rows.append(dict(pid=int(pid), name=row['name'], rss_mib=round(row['rss_bytes']/1048576, 1),
                             cpu_one_core_percent=round((row['ticks']-old['ticks'])/hz/elapsed*100, 2)))
    gpu = []
    for client, row in gpu_last.items():
        old = gpu_first.get(client)
        if old:
            gpu.append(dict(pid=int(row['pid']), name=row['name'], client=client,
                            engine_busy_percent={k: round(max(0, v-old['engines'].get(k,v))/elapsed/1e7, 2)
                                                 for k,v in row['engines'].items()}))
    result = dict(sample_seconds=round(elapsed,2), cpu_count=os.cpu_count(),
                  processes=sorted(rows,key=lambda r:r['cpu_one_core_percent'], reverse=True)[:30], gpu_clients=gpu)
    result['container_cpu_one_core_percent'] = round((counters_end[0]-counters_start[0])/elapsed/1e4, 2)
    result['container_cpu_host_capacity_percent'] = round(result['container_cpu_one_core_percent']/os.cpu_count(),2)
    result['host_cpu_busy_percent'] = round(100*(1-(counters_end[2]-counters_start[2])/max(1,counters_end[1]-counters_start[1])),2)
    for name in ['memory.current', 'memory.stat', 'cpu.stat']:
        try:
            result[name] = (Path('/sys/fs/cgroup')/name).read_text().strip()
        except OSError:
            pass
    result['sleep_config'] = {k: os.getenv(k) for k in ['SELKIES_CONTAINER_SLEEP','SELKIES_USE_CPU','SELKIES_DEFAULT_USE_CPU']}
    for filename in ['/run/selkies-container-sleep.json','/tmp/selkies-client-awake.json']:
        try:
            result[Path(filename).name] = json.loads(Path(filename).read_text())
        except (OSError, ValueError):
            pass
    output = Path('/config/logs/idle-resource-probe.json')
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2))
    print(str(output))


if __name__ == '__main__':
    main()

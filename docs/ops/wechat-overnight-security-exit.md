# 微信夜间“为了账号安全已退出登录”排查（容器稳定性版）

本方案只做容器侧证据采集与稳态治理，不删除配置文件，不做自动点击/按键模拟。

## 目标

区分两类问题：

1. 容器中断：`pause/restart/oom/kill/die` 或状态异常。
2. 容器持续运行但微信仍退出登录：登录态原因待确认，不能仅凭进程存活判定风控或网络问题。

## 仓库配置与部署核验

仓库 `docker-compose.yml` 当前包含以下配置；它们不代表 NAS 已实际应用，需以运行容器的 `docker inspect` 为准：

- `restart: unless-stopped`（原有）
- `mem_reservation: "2g"`
- `mem_limit: "8g"`
- `shm_size: "2gb"`
- `ulimits.core.soft/hard: 0`

2026-10-11 只读核对的 NAS Compose 使用 `wechat-selkies:1.71`、`shm_size: "1gb"`，未配置上述内存和 core 限制。内存值需结合 NAS 容量选择，不应仅为排查而直接扩大限制。

## 证据采集脚本

### 1) 单次采集

```powershell
powershell -ExecutionPolicy Bypass -File scripts/ops/collect-overnight-evidence.ps1 `
  -ContainerName wechat-selkies `
  -Since "2026-02-01T22:00:00+08:00" `
  -Until "2026-02-02T08:00:00+08:00"
```

默认输出目录：`diagnostics/overnight/<timestamp>/`

输出文件：

- `inspect.json`
- `state-summary.txt`
- `events.log`
- `events.lifecycle.log`
- `container.log`
- `wechat-process.txt`
- `network-check.txt`
- `summary.json`
- `summary.txt`

### 2) 7晚汇总

```powershell
powershell -ExecutionPolicy Bypass -File scripts/ops/summarize-overnight-evidence.ps1 `
  -InputDir diagnostics/overnight `
  -WindowSize 7
```

输出：`diagnostics/overnight/seven-night-report.json`

## 判定规则

### 先判容器是否中断

若任一条件命中，优先按“容器稳定性问题”处理：

- `state.paused=true`
- `state.running=false`
- `events.lifecycle.log` 出现 `pause/unpause/restart/oom/kill/die/stop/start`
- 7晚内 `restartCount` 上升

### 若容器稳定但仍被踢

满足以下条件时，更偏微信风控/网络特征：

- 每晚 `running=true && paused=false`
- `restartCount` 不增长
- 微信仍提示“为了账号安全已退出登录”

这只用于确定下一步调查方向，不是原因证明。普通“已退出”提示后出现扫码页仍保持原因未知。采集脚本的 `wechatLoginState` 为 `unknown`，微信进程存在不能证明账号仍登录。Docker exec / events 采集失败分别保留空值或 `lifecycleEventsCollected=false`，汇总不会把不可观测状态当作验收通过。

## 7晚验收标准

1. 连续 7 晚满足：
   - `running=true`
   - `paused=false`
   - `restartCount` 不增长
2. 若仍退出登录：只有覆盖故障时段且事件采集成功，才可排除已记录的容器生命周期中断；还需核对内部休眠、资源压力、网络与客户端提示。
3. 若发现 pause/restart/oom：先修稳定性，再重新做 7 晚验证。

## 说明

- 本方案不清理 `./config`，不重置 openbox，不清微信缓存。
- 本方案不包含任何自动交互保活行为。

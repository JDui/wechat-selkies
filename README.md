# WeChat Selkies AXiVer

AXiVer 是面向个人服务器与 NAS 的微信 / QQ 远程桌面方案。应用运行在 Docker
容器中，浏览器或 Windows 便携客户端通过 Selkies WebRTC 访问桌面；微信、QQ
数据及上传文件持久化到宿主机。

当前分支：`SNS-Box-Window`

![WeChat Selkies AXiVer 界面](./Demo.png)

## 项目组成

| 组件 | 作用 |
| --- | --- |
| `wechat-selkies` | 运行微信、QQ、桌面、WebRTC、PIN 会话和上传服务 |
| `axisnsbox-discovery` | 通过宿主机网络发布 `_axisnsbox._tcp.local.` mDNS 广播 |
| `axiver-client` | Tauri 2 + Rust 编写的 Windows 便携客户端 |

桌面客户端会优先发现同一局域网内的 AXiVer 容器；找不到时自动连接用户保存的
广域地址。容器仍可直接通过普通浏览器访问。

## 主要能力

- 微信与 QQ Linux 桌面远程访问，支持 AMD64 / ARM64。
- `/config` 持久化、中文字体、本地输入、剪贴板、图片粘贴和大文件上传。
- PIN 接管会话，避免刷新、休眠唤醒和 WebSocket 重连抢占当前会话。
- 微信 / QQ 通知桥接、通知中心、链接本机打开和底部快捷工具栏。
- X11、音频、进程与画面卡顿检测，视频软恢复优先。
- 可选 `/dev/dri` 硬件编码；不可用时可回退 CPU 编码。
- 空闲动态降帧、低占用模式和容器内部休眠。
- mDNS 局域广播、身份端点校验及 Windows 便携客户端自动连接。

## 使用 Docker Compose

### 1. 准备配置

克隆仓库后，按实际宿主机修改 `docker-compose.yml`。建议至少确认：

- `PUID`、`PGID` 与持久化目录权限一致。
- `PASSWORD` 设置为登录 PIN；若不需要 PIN，可保持未设置。
- 没有 `/dev/dri` 的设备删除 `devices` 配置。
- 需要局域网发现时启用广播，并为每个项目设置唯一广播名。

可以在仓库根目录创建 `.env`：

```dotenv
SELKIES_HTTP_PORT=3000
SELKIES_HTTPS_PORT=3001
SELKIES_LAN_DISCOVERY_DEFAULT_ENABLED=true
SELKIES_LAN_DISCOVERY_DEFAULT_NAME=AXISNSBOX-000
SELKIES_LAN_ADVERTISE_ADDRESS=192.168.31.221
```

`SELKIES_LAN_ADVERTISE_ADDRESS` 应填写其他局域网设备能访问到的宿主机 IPv4
地址。留空时服务会尝试自动判断。

### 2. 构建并启动

```bash
docker compose up -d --build
```

默认访问地址：

- HTTP：`http://<宿主机地址>:3000`
- HTTPS：`https://<宿主机地址>:3001`

查看状态与日志：

```bash
docker compose ps
docker compose logs -f wechat-selkies
docker compose logs -f axisnsbox-discovery
```

`axisnsbox-discovery` 使用 `network_mode: host`，让 mDNS 组播能够从宿主机网卡
发出；主业务容器继续使用 bridge 网络。Windows 或 macOS 上的 Docker Desktop
对 host 网络和 mDNS 的行为可能不同，客户端因此还提供同网段身份扫描作为兜底。

## Windows 便携客户端

客户端源码位于 [`axiver-client`](./axiver-client)，使用 Tauri 2、Rust 和
WebView2。它是纯桌面 GUI 程序，不会弹出命令行窗口。

### 连接逻辑

1. 嗅探 `_axisnsbox._tcp.local.` mDNS 服务。
2. 若收不到 UDP 5353 组播，扫描本机私有 IPv4 所在 `/24` 网段的 HTTP 3000
   身份端点。
3. 请求 `/.well-known/axisnsbox`，只接受服务类型和广播名均匹配的实例。
4. 成功时连接身份信息声明的局域地址；未发现时连接已保存的广域地址。
5. 连接成功后，原生窗口标题跟随当前网页标题及其后续变化。

局域和广域地址都是用户主动信任的目标。客户端仅在自己的 WebView2 进程中忽略
证书错误，从而直接打开自签名 HTTPS 页面；不会修改 Windows 或其他浏览器的证书
设置。

### 左上角状态菜单

收纳时菜单显示为可拖动的小圆点，拖动位置仅在本次运行有效：

| 状态 | 含义 |
| --- | --- |
| 红色 | 所有地址均不可连接，或连接已断开 |
| 闪烁黄色 | 正在嗅探局域网广播 |
| 黄色 | 正在连接局域网容器 |
| 闪烁蓝色 | 正在连接广域地址 |
| 蓝色 | 当前页面为广域地址 |
| 彩虹色 | 当前页面为局域地址 |

展开后提供：

- 刷新页面
- 局域广播名设置，默认 `AXISNSBOX-000`
- 广域地址设置

输入框编辑或聚焦时菜单不会自动收纳，也不会被后台连接状态覆盖。文字、图标和
输入区域使用高对比度深色玻璃背景，保证叠加在深浅网页上都可辨认。

### 便携数据与构建

需要 Rust stable、Microsoft C++ Build Tools 和 WebView2 Runtime。在 Windows
PowerShell 中运行：

```powershell
cd axiver-client
.\scripts\build-portable.ps1
```

本地输出为 `axiver-client\dist\AXIVER-Client.exe`。`dist` 是构建产物目录，
已被 Git 忽略，不会随仓库提交。

首次运行时，程序在 EXE 旁创建：

- `axiver-client.db`：保存广播名和广域地址的 SQLite 数据库。
- `axiver-client-data\`：WebView2 Cookie、缓存与会话数据。

移动便携客户端时，若要保留设置与登录状态，请将 EXE、DB 和数据目录一起移动；
只复制 EXE 则会在新位置生成全新数据。

## 常用环境变量

完整默认值以 [`docker-compose.yml`](./docker-compose.yml) 为准。

| 变量 | 说明 | 默认值 |
| --- | --- | --- |
| `PASSWORD` | PIN 登录密码 | 未设置 |
| `PUID` / `PGID` | 容器内用户和组 ID | `1000` / `100` |
| `SELKIES_HTTP_PORT` | 宿主机 HTTP 端口 | `3000` |
| `SELKIES_HTTPS_PORT` | 宿主机 HTTPS 端口 | `3001` |
| `SELKIES_LAN_DISCOVERY_DEFAULT_ENABLED` | 默认启用局域广播 | `false` |
| `SELKIES_LAN_DISCOVERY_DEFAULT_NAME` | 局域广播名 | `AXISNSBOX-000` |
| `SELKIES_LAN_ADVERTISE_ADDRESS` | 对外广播的宿主机地址 | 自动判断 |
| `SELKIES_UPLOAD_ENABLED` | 启用独立上传服务 | `true` |
| `SELKIES_UPLOAD_DIR` | 上传目录 | `/config/uploads` |
| `SELKIES_CONTAINER_SLEEP` | 启用容器内部休眠 | `true` |
| `SELKIES_DYNAMIC_THROTTLE` | 启用空闲动态节流 | `true` |
| `SELKIES_DEFAULT_ENCODER` | 默认视频编码器 | `x264enc` |

## 局域发现排障

先确认服务和身份端点可访问：

```bash
curl http://<宿主机地址>:3000/.well-known/axisnsbox
curl -k https://<宿主机地址>:3001/.well-known/axisnsbox
```

正常响应应包含 `service=wechat-selkies`、项目广播名、协议和端口。若端点正常但
Bonjour 看不到 `_axisnsbox._tcp.local.`：

1. 确认 `axisnsbox-discovery` 正在运行且使用 host 网络。
2. 放行宿主机与客户端防火墙的 UDP 5353。
3. 检查路由器是否开启 AP 隔离、访客网络隔离或组播过滤。
4. 确认客户端与容器宿主机处于同一私有 IPv4 `/24` 网段。

即使 mDNS 被网络设备拦截，Windows 客户端仍会尝试扫描同网段的 HTTP 3000 身份
端点。若服务映射到其他 HTTP 端口，应优先修复 mDNS 或保持默认 3000 端口。

## 数据、升级与备份

- 容器业务数据位于宿主机映射的 `./config`。
- 升级前建议停止容器并备份 `config`。
- `config/state` 保存局域发现等运行状态，不应作为镜像层的一部分。
- 桌面客户端设置和 WebView2 数据独立存放在 EXE 旁，不进入 Git。

## 开发验证

容器：

```bash
docker build -t wechat-selkies:latest .
docker compose up -d
```

桌面客户端：

```powershell
cd axiver-client
cargo test
cargo build --release
.\scripts\build-portable.ps1
```

更详细的客户端说明见 [`axiver-client/README.md`](./axiver-client/README.md)。

## 许可与说明

本项目用于个人学习与自托管场景。微信、QQ、Selkies、WebView2 等名称和软件的
权利归各自所有者；使用前请自行确认当地法律、软件许可和服务条款。

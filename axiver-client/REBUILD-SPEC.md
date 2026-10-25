> 2026-10-25 架构更新：按用户要求改为一个原生主窗口，状态胶囊与本地面板通过独立本地子 WebView 在窗口内呈现。胶囊可拖动，松手 10 秒自动复位。远端权限隔离与便携数据协议继续保留。下文关于独立 Shell / owned 状态窗口的旧规定由本更新取代；当前实现与验证见 axiver-client/design-qa-v3.md（客户端目录内为 design-qa-v3.md）。

# AXIVER Windows Client 重构规格书（Reset / Rebuild）

> 状态：**设计与实施规格，不是已完成的重构**  
> 文档版本：v1.0 / 2026-10-25  
> 范围：`axiver-client/` Windows 便携客户端；服务器仅允许必要的**向后兼容**接口调整。  
> 代码基线：[`JDui/wechat-selkies` / `SNS-Box-Window`](https://github.com/JDui/wechat-selkies/tree/1c4bfa6f4540a11718b885cd343fb073c95d3a47)，审阅 SHA：`1c4bfa6f4540a11718b885cd343fb073c95d3a47`。  
> 目标读者：开发 Agent / Rust + Tauri + Windows WebView2 工程师 / UI 工程师。  
> **执行约束：不创建 Git 分支，不自动提交或推送；推送前必须再次审阅。严禁清空数据库、登录缓存和容器配置。**

## 0. 执行摘要与不可变边界

本次重构针对 **Windows 客户端的界面、前后端通信与状态组织**，不是推翻已有的 Selkies 容器。当前客户端采用 Tauri 2 + Rust + WebView2，在同一远程网页注入 Shadow DOM「玻璃浮岛」，由伪导航 URL 驱动 Rust 操作。重构目标是让本地 UI 成为独立 Shell，让远程网页仅负责远程桌面。

### 必须保留

- mDNS 局域发现、无 mDNS 时的局域网扫描、WAN 备用连接、断线重试。
- WebView2 既有 Cookie、会话、缓存、中文/日文 IME、系统剪贴板以及 Selkies 上传行为。
- 原生下载处理、同源上传弹窗、外部链接打开系统浏览器、浏览器原生文件拖放。
- 配置的 SQLite 兼容读取（已有广播名、WAN URL），便携 EXE 与 EXE 相邻的数据布局。
- 容器端 PIN 验证、通知桥、上传接口、广播配置、远程桌面及容器业务均不重置。
- **兼容已有用户主动接受的证书行为**：现有 WebView2 进程启动参数包括 `--ignore-certificate-errors`；重构不得无提示改变为严格校验而导致既有自签名实例断连。将风险记录为后续可选增强，不应在本次擅自改变既定行为。

### 必须替换

- 把局域/WAN 状态、设置、刷新塞在远程页面上的大型 Shadow DOM 悬浮卡片。
- 通过 `https://axiver-client.invalid/__native/...` 假导航承载本地配置写入与动作。
- 以多处计时器、远程页面生命周期维持本地设置窗口的状态。
- 在真正完成本地持久化之前就显示“已保存”的乐观反馈。

### 非目标

不重写 Selkies WebRTC 编解码链路；不迁移容器内 QQ/微信数据；不改 Docker 暴露端口、PIN、WebSocket 或上传协议；不修改服务器的默认广播名；不以新 UI 为由引入不必要的前端运行时依赖。

---

## 1. 当前仓库与组件地图（事实）

| 文件 / 模块 | 当前职责 | 重构策略 |
|---|---|---|
| `axiver-client/src/main.rs` | SQLite、LAN/WAN 发现、WebView2 窗口、状态刷新、弹窗、下载、IME 注入、原生操作分发 | **拆分保留**，不整体重写 |
| `axiver-client/ui/injected.js` | 玻璃菜单 CSS/DOM、菜单状态、输入框、伪导航操作、IME 保护 | 分割：**移除可见菜单，保留/隔离 IME 兼容部分** |
| `axiver-client/ui/index.html` | 未连接时的本地启动屏 + UI 预览 | 改为本地 Shell/等待页 |
| `axiver-client/tauri.conf.json` | Tauri 配置；当前 `windows: []`，bundle 关闭 | 根据选定架构最小调整 |
| `axiver-client/README.md` | 便携客户端行为说明 | 新旧功能及升级说明 |
| `axiver-client/design-qa.md` | 旧「玻璃浮岛」视觉验证记录 | 存档，另建新 UI 验收记录 |
| `root/scripts/lan_discovery_common.py` | 广播名约束、服务器身份 JSON | **协议兼容基准** |
| `root/scripts/lan_discovery_service.py` | 读取服务器状态并发布 Zeroconf/mDNS | 原则上不动 |
| `root/scripts/notification_bridge.py` | 服务器配置与发现状态接口 | 原则上不动 |
| `root/defaults/default.conf` | 身份接口和通知 API 的 Nginx 路由 | 原则上不动 |
| `root/usr/share/selkies/selkies-dashboard/src/selkies-runtime-overrides.js` | 服务器网页端广播设置、本地存储、Selkies 运行时增强 | **保留，不因客户端 UI 重构删除** |

既有原生主窗：启动标题 `AXIVER Client`，初始内尺寸 `1280 × 820`，最小 `820 × 560`，居中；远程页面成功后，原生标题跟随网页 `document.title`。文件上传专用窗口另建。

---

## 2. 原有数据模型与持久化协议（事实）

### 2.1 本地 SQLite

路径：`<EXE 所在目录>/axiver-client.db`。通过 `rusqlite` 打开，启用 `PRAGMA journal_mode = WAL;`。**实际表结构**：

```sql
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL
);
```

已有键值：

| key | 类型 | 缺省值 | 规则 |
|---|---|---|---|
| `broadcast_name` | `TEXT` | `AXISNSBOX-000` | 去空格、转大写，`^[A-Z0-9][A-Z0-9_-]{0,31}$` |
| `wide_url` | `TEXT` | 空字符串 | 允许为空，否则完整 `http://` 或 `https://` URL、含主机 |

写入使用事务和 `INSERT ... ON CONFLICT DO UPDATE`。历史数据及可能存在的 `axiver-client.db-wal`、`axiver-client.db-shm` 文件都必须正常兼容；备份前关闭客户端并正确完成 SQLite checkpoint，不能在仍有写入时只复制主 DB。

**当前 Rust 结构：**

```rust
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct Settings {
    broadcast_name: String,
    wide_url: String,
}

#[derive(Clone, Copy, Debug, Serialize)]
struct OverlayPosition {
    left: f64,
    top: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TargetKind {
    None,
    Lan,
    Wan,
}

#[derive(Clone, Debug)]
struct Endpoint {
    url: Url,
    socket: SocketAddr,
    kind: TargetKind,
}
```

`Settings` 序列化到前端时为 `{"broadcastName":"AXISNSBOX-000","wideUrl":""}`。`OverlayPosition` 仅存放在 Rust `Arc<Mutex<Option<OverlayPosition>>>` 内存中，刷新/导航后注入恢复，关闭 EXE 后不持久化；**不是 SQLite 列**。

### 2.2 WebView2 用户数据

路径：`<EXE 所在目录>/axiver-client-data/`；存储 Cookie、站点会话、缓存等。升级 EXE 必须原路径重用该目录。不得把 `Cookie`、本地存储或 PIN 会话迁移进不受信任的远端 JavaScript，也不应在 UI 迁移时默认清空浏览数据。

便携版预期结构：

```text
portable-directory/
├── AXIVER-Client.exe
├── axiver-client.db
├── axiver-client.db-wal       # 存在与否取决于 SQLite 运行状态
├── axiver-client.db-shm       # 存在与否取决于 SQLite 运行状态
└── axiver-client-data/
    └── ...                    # WebView2 浏览数据
```

### 2.3 远端容器自身的数据（与客户端数据库不同）

服务器端的广播和其他运行设置来自 `notification_bridge.py` 使用的状态文件：

- 默认 `/config/state/notification-bridge.json`；
- `lan_discovery_enabled`：布尔值；
- `lan_broadcast_name`：字符串，命名规则同上；
- 同一状态文件还包含 `mode`、`idle_focus_seconds`、`adaptive_sleep_enabled`、`adaptive_sleep_idle_seconds`、`adaptive_sleep_idle_seconds_user_set`。

广播守护进程的状态快照默认在 `/config/state/lan-discovery-status.json`：

```json
{
  "ok": true,
  "configured": true,
  "running": true,
  "name": "AXISNSBOX-000",
  "address": "192.168.1.20",
  "port": 3001,
  "service_type": "_axisnsbox._tcp.local.",
  "error": "",
  "updated_at": 1790000000
}
```

以上为**字段结构示例**，不是从用户服务器读取的真实 IP/状态/时间戳。守护进程会轮询配置、重新注册 mDNS。网页端还可能以独立的 `localStorage` 键缓存广播状态：`lan_discovery_enabled`、`lan_broadcast_name`；不是客户端 SQLite 的镜像。

**关键区分：**`客户端 broadcast_name` 是“希望匹配哪个服务器”的选择器；`服务器 lan_broadcast_name` 是“服务器发布什么名字”。更改前者不会自动修改后者。

---

## 3. 旧接口与通讯协议（事实）

### 3.1 局域发现：mDNS / Zeroconf

| 项 | 值 |
|---|---|
| Service Type | `_axisnsbox._tcp.local.` |
| 默认广播名 | `AXISNSBOX-000` |
| 服务识别符 | `wechat-selkies` |
| TXT `service` | `wechat-selkies` |
| TXT `name` | 当前服务器广播名 |
| TXT `scheme` | 默认 `https` |
| TXT `path` | 默认 `/`，支持子路径 |
| TXT `http_port` | 默认 `3000` |
| TXT `https_port` | 默认 `3001` |
| TXT `identity` | `/.well-known/axisnsbox` |
| mDNS SRV 端口 | 实际广告的 HTTPS 端口 |

客户端先浏览 mDNS（一次发现限时约 **4 秒**），匹配广播名/`service`，检查候选 TCP 目标端口可达性（**1.8 秒**探测超时），再打开协议、端口和路径组合的地址。mDNS 路径目前**可以在仅凭广播 TXT 与 TCP 成功时继续连接**；HTTP 身份读取在这一支路中不是严格的硬门槛。后续若要加强验证，需单独设计兼容策略，不能误称旧代码已经进行密码学认证。

### 3.2 HTTP 身份端点

`GET /<可选子路径>/.well-known/axisnsbox`，默认 `GET /.well-known/axisnsbox`。Nginx 映射到通知桥 `GET /discovery`，该 Nginx 路由没有 `auth_request`，用于连接前身份发现。返回 JSON 结构：

```json
{
  "ok": true,
  "service": "wechat-selkies",
  "service_type": "_axisnsbox._tcp.local.",
  "name": "AXISNSBOX-000",
  "enabled": true,
  "scheme": "https",
  "path": "/",
  "http_port": 3000,
  "https_port": 3001
}
```

**原 Rust `LanIdentity` 实际解析的字段**为：

```rust
#[derive(Clone, Debug, Deserialize)]
struct LanIdentity {
    service: String,
    name: String,
    #[serde(default = "default_lan_scheme")]
    scheme: String,
    #[serde(default = "default_lan_path")]
    path: String,
    #[serde(default = "default_http_port")]
    http_port: u16,
    #[serde(default = "default_https_port")]
    https_port: u16,
}
```

`ok`、`service_type`、`enabled` 虽在服务器返回中，却没有被这一 Rust 类型声明为读取字段。原校验检查 HTTP 200、`service == "wechat-selkies"`、广播名（大小写不敏感）；**不是凭据认证，不防止同网段伪造服务**。

### 3.3 局域网扫描兜底

当 mDNS 没找到目标时，扫描活动网卡的私有 IPv4 子网；对较大的网段，按 `max(网卡前缀长度, /24)` 取扫描范围，最多处理 4 个网络，32 个工作线程、每地址约 **280ms** 超时。扫描固定访问候选主机的 **HTTP 3000** 身份端点，而不是任意 mDNS 广告端口；成功后依返回 `scheme/path/http_port/https_port` 构造远端 URL 并验证目标 TCP 端口。保留这一已知限制，不能把“支持自定义端口广播”误写成“兜底扫描支持任意 HTTP 端口”。

### 3.4 WAN 回退与健康检查

当 LAN 未发现，尝试 SQLite 的 `wide_url`。URL 解析后做 DNS + TCP 连接探测（约 **1.8 秒**），随后 WebView2 导航。**已连接状态当前每 8 秒仅验证既有目标 TCP socket 可达，不能证明 HTTPS 握手、PIN 会话、WebRTC 视频帧或音频流处于正常状态。**

旧流程：

```text
start
  -> discover_lan (mDNS)
  -> [not found] scan_lan_subnets (HTTP :3000)
  -> [not found] resolve_wan (configured WAN URL)
  -> [not found] disconnected -> retry after ~5s
  -> [endpoint found] navigate WebView2 -> monitor TCP every 8s
  -> [disconnected] retry loop
```

### 3.5 客户端 UI ↔ Rust 的旧桥接

旧客户端向被加载页面注入 `window.__AXIVER_BOOTSTRAP__`，然后执行 `injected.js`；页面上使用下述方法供 Rust `window.eval(...)` 调用：

```ts
interface LegacyAxiverClient {
  setStatus(next: { state?: string; detail?: string; url?: string }): void;
  syncSettings(next: { broadcastName?: string; wideUrl?: string }): void;
  setPosition(next: { left: number; top: number }): void;
  open(): void;
}

// 页面全局：
// window.__AXIVER_CLIENT__
```

状态值：

| `state` | 意义 | 旧视觉 |
|---|---|---|
| `disconnected` | 都不可连接 / 已断开 | 红 |
| `discovering_lan` | mDNS 或子网搜索 | 闪烁黄 |
| `connecting_lan` | 局域网候选连接中 | 黄 |
| `connecting_wan` | 广域候选连接中 | 闪烁蓝 |
| `wan` | 处于 WAN 页面 | 蓝 |
| `lan` | 处于 LAN 页面 | 彩虹 |

反向调用靠**拦截伪导航 URL**，域名为 `axiver-client.invalid`，路径：

| 旧 URL | 参数 | 行为 |
|---|---|---|
| `https://axiver-client.invalid/__native/settings` | `broadcast`, `wide` | 校验、SQLite 事务保存；有变更时发送 Rust `Reconnect` |
| `https://axiver-client.invalid/__native/position` | `left`, `top` | 仅内存更新悬浮点位置 |
| `https://axiver-client.invalid/__native/reconnect` | 无 | 通知连接工作线程重新连接；该 Rust 路由存在，但旧面板并未以它实现专门的重连按钮 |

旧“刷新页面”实际调用远端 `window.location.reload()`，**与重做 LAN/WAN 发现不等价**。旧前端在导航式保存调用之前就展示“已保存”，无法等待实际数据库写入确认。

### 3.6 服务器管理接口（避免混淆）

| 路由（默认根路径） | 方法 | 用途 | 鉴权 |
|---|---|---|---|
| `/.well-known/axisnsbox` | GET | 匿名局域发现身份 | 当前 Nginx 路由无 `auth_request` |
| `/api/notifications/state` | GET | 服务器广播开关、广播名及通知/休眠状态 | Nginx `auth_request` |
| `/api/notifications/state` | POST JSON | 更新服务器 `lan_discovery_enabled` / `lan_broadcast_name` 等字段 | Nginx `auth_request` |
| `/api/notifications/` 的其他接口 | 依具体子路径 | 通知桥功能 | Nginx `auth_request` |
| `/upload-api/v1/...`、`/auth/...` | 原容器协议 | 上传/PIN | 现有规则原样保留 |

`POST /api/notifications/state` 用于改变**服务器广播配置**，并非客户端专用配置接口。本次客户端重构**不应悄悄从客户端 LAN 设置调用这个 POST**。如以后要支持“管理服务器广播”，必须有单独的显式功能入口和已登录会话。

### 3.7 文件与原生集成协议

- **上传弹窗**：`window.open()` 的 URL 必须与当前远程网页 origin 相同，且路径以 `/uploader/` 结尾（允许子路径）。创建共享 WebView2 环境/会话的第二窗口，维持 Cookie、`BroadcastChannel`、上传器的 opener 关系。原生 Tauri 拖放拦截目前被关闭，远程网页才能获得 HTML5 drop。
- **下载**：Tauri `on_download` 放行。相对目标路径补为 Windows 当前配置的 Downloads 目录，不强制替换浏览器已有绝对路径；继续尊重系统重定向下载文件夹。
- **外部链接**：除内部上传器外，HTTP(S) 弹窗优先交给 `ShellExecuteW` 所代表的系统默认浏览器；非 HTTP(S) 路由不能被当作通用“安全外链”。
- **IME**：`injected.js` 目前保护 Selkies `keyboard-input-assist` 的 `compositionstart/input/compositionend`，对微软拼音 `compositionend.data` 兜底，对日文后续 `input` 去重，仅提交一次 `_typeString`。此逻辑必须在远程页面兼容脚本中独立保留并回归测试。
- **输入框焦点**：旧菜单用 Shadow DOM + Light DOM `<slot>` 和 `allow-native-input` 防止被 Selkies 全局键盘监听误抢；新本地 Shell 从远程 DOM 脱离后仍须验证其焦点与热键隔离。
- **证书**：旧 WebView2 以进程范围 `--ignore-certificate-errors` 禁用证书错误提示。保留兼容并明确记录风险；不要声称 HTTPS 证书得到了认证。

---

## 4. 新架构目标：本地 Shell 与 Remote Session 分离

### 4.1 设计原则

1. **远程桌面是内容，不是客户端 UI 容器。** 客户端状态栏和设置不再注入远程 DOM。
2. **状态有唯一来源。** Rust Connection Manager 是连接状态事实来源；本地 Shell 只订阅和渲染。
3. **动作必须有确认。** `Save` / `Reconnect` / `Refresh` 必须有明确结果、错误码、loading 态；不能静默成功。
4. **协议适配优先于底层重写。** 保持 mDNS、HTTP 身份、上传、Cookie 与 IME 机制的兼容。
5. **无损升级。** 读旧 SQLite、旧 WebView2 profile；能回滚至旧 EXE，不自动迁移删除既有键值。
6. **瘦前端、显式边界。** 不依赖大型框架；本地 Rust IPC 只在可信本地 WebView 启用。

### 4.2 逻辑结构

```text
┌──────────────────────────── Windows native window ────────────────────────────┐
│ Local Shell (trusted local UI)                                               │
│   connection badge / refresh / reconnect / settings / error details          │
│   ^ events                  | typed commands                                 │
│   |                         v                                                │
│   └──────────── Rust App Core / Tauri IPC ────────────────────────────────┐    │
│                 ├─ Settings Repository (SQLite)                          │    │
│                 ├─ Discovery Engine (mDNS + subnet fallback)             │    │
│                 ├─ Connection Manager (state machine + recovery)         │    │
│                 ├─ Session/WebView Controller                             │    │
│                 └─ Download / Popup / External Link Policy               │    │
│                                                                           │    │
│ Remote Session (untrusted web content, independent WebView2) ◄────────────┘    │
│   Selkies / PIN / WebRTC / Clipboard / Upload / IME bridge                     │
└────────────────────────────────────────────────────────────────────────────────┘
              ⇅ existing network protocols / server APIs
┌──────────────────────────── Docker server ────────────────────────────────────┐
│ Nginx + PIN + Selkies + notification_bridge + discovery + upload sidecar       │
└────────────────────────────────────────────────────────────────────────────────┘
```

### 4.3 实现路线与技术闸门（必须执行）

**路线 A（目标形态，需先做可运行 PoC）**：一个 native window 内承载 Local Shell WebView 与 Remote WebView2 子视图，顶部本地命令栏、下方远程画面。Tauri 2 的 `Window::add_child`/child webview **目前需要 `unstable` feature**，Windows 平台在同步命令/事件处理器中创建 webview 还有死锁警告。必须先验证：子 WebView 的创建/销毁、导航、视频渲染、DPI/窗口调整、输入法、上传器 opener、登录数据目录和弹窗事件。只有全部通过才允许纳入主实现。

**路线 B（稳定后备）**：保留一个远程 `WebviewWindow` 全幅显示 Selkies，客户端状态/操作用原生菜单、快捷键、系统托盘或独立**本地设置 WebviewWindow** 提供；不再往远程网页注入大型 UI。主窗内顶部一体化命令栏不作为这一后备方案的必达项。此路线不要求启用不稳定的 child-webview API。

**决策标准**：优先可靠的文件传输、IME、会话保留与远程性能；若 A 的 WebView2 功能或资源消耗存在严重退化，选 B。不得为强行实现漂亮标题栏而牺牲核心能力。

### 4.4 目标模块目录（建议，尚未存在）

```text
axiver-client/
├── src/
│   ├── main.rs                       # app bootstrap / setup only
│   ├── app_state.rs                  # typed state + event dispatch
│   ├── config.rs                     # validation + persistence + migration
│   ├── discovery/
│   │   ├── mod.rs
│   │   ├── mdns.rs
│   │   ├── identity.rs
│   │   └── subnet.rs
│   ├── connection.rs                 # single owner + generation cancellation
│   ├── webview.rs                    # remote session lifecycle
│   ├── platform_windows.rs           # download / popup / shell integration
│   ├── commands.rs                   # trusted IPC
│   └── protocol.rs                   # DTO + shared domain types
├── ui/
│   ├── shell/                        # trusted local frontend
│   ├── remote-compat/                # ONLY Selkies IME/clipboard compatibility
│   └── index.html                    # waiting / local shell entry
├── tests/
│   └── ...                           # integration tests and fixtures
├── README.md
├── REBUILD-SPEC.md
└── design-qa-v2.md
```

仅为职责边界建议，不要在 P0 阶段为了目录形式提前大规模搬动可工作的代码。

---

## 5. 新版本地 IPC 契约（设计提案，旧分支尚不存在）

**禁止把以下接口当成现有实现。** 以下是 Rust `#[tauri::command]` 与受信任 Local Shell 之间拟建立的 typed IPC。远程网页 WebView 不授予本地配置命令权限。

### 5.1 建议的请求/响应类型

```ts
type LinkKind = "none" | "lan" | "wan";
type ConnectionPhase =
  | "idle"
  | "discovering_lan"
  | "scanning_subnet"
  | "connecting_lan"
  | "connecting_wan"
  | "loading_page"
  | "awaiting_auth"
  | "connected"
  | "reconnecting"
  | "disconnected"
  | "error";

interface ClientConfigV1 {
  schemaVersion: 1;
  broadcastName: string;
  wideUrl: string;
}

interface ConnectionSnapshotV1 {
  schemaVersion: 1;
  revision: number;
  phase: ConnectionPhase;
  kind: LinkKind;
  targetUrl: string | null;
  detail: string;
  errorCode: string | null;
  lastCheckedAt: string | null;
  transportReachable: boolean | null;
  pageLoaded: boolean | null;
  sessionVerified: boolean | null;
}

interface CommandResult<T> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string; retryable: boolean };
}
```

`pageLoaded` 表示网页 load 回调，不代表用户已登录或 WebRTC 流已建立；`sessionVerified` 只有具备可靠的、明确授权的会话/媒体检查时才为 `true`，暂无法验证则必须保持 `null`，严禁从 TCP 成功推断。

### 5.2 命令清单

| 命令 | 输入 | 结果 | 特别约束 |
|---|---|---|---|
| `client_get_config` | 无 | `ClientConfigV1` | 只供本地 Shell 使用 |
| `client_update_config` | `{ broadcastName, wideUrl }` | 保存后的配置 | 先 Rust 校验，事务成功后才 `ok=true`；有变更才触发重连 |
| `client_get_connection` | 无 | `ConnectionSnapshotV1` | 启动后先取快照再订阅事件，防竞态 |
| `client_reconnect` | `{ forceRediscover?: boolean }` | 接受任务 / revision | 重做完整发现与回退，不等于 reload |
| `client_refresh_remote` | 无 | 操作结果 | 只刷新当前远程页，不强制切换 LAN/WAN |
| `client_open_settings` | 无 | 操作结果 | 禁止远程网页调用 |
| `client_get_version` | 无 | 版本及构建号 | 诊断用 |

建议 Tauri 事件名：`axiver:connection-status`、`axiver:config-changed`、`axiver:operation-result`。事件为完整快照或携带版本的变更，含**单调递增的 `revision`**；Local Shell 不接受过期事件。命令执行者与事件来源必须由 Rust 严格限定。配置保存失败返回真实错误，不发送成功 toast。

### 5.3 状态机与取消规则

```text
idle
 └─ discover LAN ─> scanning subnet ─> fallback WAN
       ├─ found LAN ─> connecting_lan ─> loading_page ─> connected/awaiting_auth
       └─ no LAN   ─> connecting_wan ─> loading_page ─> connected/awaiting_auth
error/disconnected ─> policy backoff ─> reconnecting ─> discover LAN
```

- 同一时刻只能有一个“当前有效连接任务”；新配置、手动重连和旧任务完成竞争时使用 generation/revision 使旧结果失效。
- 冷启动未连接时显示本地等待 UI，不允许远端加载失败时出现永久白屏。
- 区分 `TCP reachable`、`HTTP identity accepted`、`page loaded`、`session/stream healthy`。
- 断线重试提供明确间隔和取消机制；避免多个后台扫描叠加；记录原因/来源/最近成功时间。
- WAN → LAN 自动抢占属于新增策略，**默认不擅自执行**：保留目前“失联时重新发现”的兼容语义；后续设计可选策略并测试会话中断成本。

---

## 6. 新版界面与交互规范（设计提案）

### 6.1 信息架构

1. **主界面**：远程桌面占最大空间；本地命令栏约 36–42 CSS px（采用 Windows 标准标题栏还是自定义标题栏由架构 PoC 决定）。
2. **状态入口**：紧凑 `LAN 已连接 / WAN 已连接 / 连接中 / 已断开`，点击可看到目标 URL、最新检测时间、错误详情。
3. **操作入口**：刷新网页、重新连接、设置。刷新和重新连接必须分开。
4. **设置页**：广播名、WAN URL、说明/校验错误、保存与取消；编辑时不因后台状态变化重绘输入框。
5. **错误视图**：说明 mDNS 未发现、身份不匹配、TCP 不通、页面加载失败、PIN 待验证等，不把一切失败合并为“网络断开”。

### 6.2 UI 规格

| 元素 | 目标 |
|---|---|
| 语言 | 简体中文为主，字符串集中，预留本地化 |
| 视觉 | Windows Fluent / 中性暗色，不再高饱和度彩虹旋转玻璃浮岛 |
| 默认模式 | 与系统深浅色一致；保留清晰的深色模式 |
| 状态色 | 成功绿、连接中蓝/中性、错误红；始终辅以文字/图标 |
| 控件点击区 | 主要交互目标至少约 32×32 CSS px，键盘可达 |
| UI 文案 | 文本不依赖颜色，状态可复制诊断信息 |
| 动画 | 短且节制，尊重系统减少动态效果设置 |
| 对比度 | 正文/重要状态目标满足 WCAG AA 4.5:1（适用时） |
| 窗口缩放 | 100%、125%、150%、200% DPI；小窗口与多屏移动正确布局 |
| 折叠 | 只对非关键辅助面板折叠；**设置正在编辑时不自动关闭** |
| 面板定位 | 依据窗口真实可用空间定位；不得超出屏幕或遮挡系统按钮 |

新 Shell 不对远程画面注入 z-index `2147483647` 的全尺寸设置层。若短期仍需要兼容旧客户端悬浮点，必须默认关闭，限定位置并允许用户主动启用；只保留最小可访问入口，不能与新 Shell 同时抢输入。

### 6.3 设计上需要修复的既有缺陷

| 问题 | 已核对到的旧行为 | 新行为 |
|---|---|---|
| 状态信息隐藏 | `.summary-detail { display:none; }` | 状态详情可按需展开 |
| 右侧展开越界 | 悬浮点按约 42px 约束，而面板可达 560px | 使用 popover 边界碰撞与方向切换，优先改为非覆盖式本地 Shell |
| 自动收纳不确定 | 多处 900/1800/2600/5200ms 计时 | 明确打开/关闭/失焦规则，编辑期不计时 |
| 保存成功假象 | `showSaved()` 在实际 Native 操作前执行 | Rust 成功返回后显示保存成功 |
| 无提示输入错误 | 旧 `.hint` 默认隐藏 | 字段下即时校验 + 错误文本 |
| 不合理状态色 | `LAN` 彩虹转圈 | 有语义、低干扰、色彩无障碍 |
| 配置输入与远程输入相互争用 | 依赖 Shadow slot/`allow-native-input` 规避 | 本地输入与远端输入隔离；IME 仍回归 |
| 连接成功的定义过于宽泛 | 页面加载和 TCP 检查 | 连接状态分层，不能伪报会话/画面健康 |

---

## 7. 安全与兼容约束

- **信任边界**：Selkies 页面及其打开的远程 HTTP(S) 内容均视为**不可信 Web 内容**，不能访问 `client_update_config`、`client_open_settings` 或任意原生文件/系统接口。Tauri IPC capabilities 应仅授权本地 Shell 对应 label/origin；**不要**为了方便给所有 webview 配置宽泛权限。
- **导航策略**：原实现在主 WebView `on_navigation` 允许所有 HTTP(S)/tauri/about，并将最近导航的 HTTP origin 当作潜在上传器 origin。新版本应将主远程导航限定到明确的当前可信目标及必要的同源路径/重定向，并以实际会话绑定的 origin 判断上传器；跨站链接交由默认浏览器。PIN、上传器相关重定向需回归测试，不能盲目封死。
- **身份验证边界**：mDNS TXT、匿名 identity JSON 和 TCP 建连都不足以证明服务器真实身份。保留旧兼容行为，同时把“待增强验证”作为独立安全工作项；不得把匹配广播名宣传为可靠身份认证。
- **证书风险**：继续兼容现有进程级忽略证书错误的行为，但在文档/诊断中显式标记其安全风险；后续可提供可选的严格证书验证/指纹信任模式（需要产品决策与迁移方案）。
- **输入法**：从 `injected.js` 提取的兼容代码必须使用明确 origin/page guard 和幂等安装，避免在本地 Shell 或上传器不必要地安装。
- **本地数据**：配置不存储 PIN 凭据；不要日志打印敏感 Cookie、PIN、URL 内的认证参数。诊断导出要先脱敏。
- **网络**：保留 DNS/TCP 超时及扫描并发上限；不要在 UI 线程执行阻塞扫描。

---

## 8. 数据迁移、目录兼容与回滚

### P0 数据迁移约束

1. 启动时先读取**原有** `settings` 表的 `broadcast_name`、`wide_url`，不要求用户重新配置。
2. 继续使用 EXE 同级 `axiver-client.db` 与 `axiver-client-data/`；不得更改 profile 位置造成登录失效。
3. 如要保存窗口尺寸、主题等新配置，优先通过兼容的 `settings` KV 新增命名空间键（如 `ui.theme`、`ui.window_width`），或设计带 schema version 的新表；**不要把旧表重建为不兼容结构**。
4. 第一次写入前做完整事务备份/可恢复备份，并测试旧版本恢复读取。备份不能丢失 WAL 内的未 checkpoint 事务。
5. 从新版本切回旧 EXE 时，旧版至少仍能读取广播名、WAN URL 并使用同一 WebView2 profile；不保证新 UI 偏好在旧版显示，但不能破坏旧版核心功能。

### 推荐的配置升级伪流程

```text
read old settings table
  -> validate broadcast_name and wide_url
  -> populate new typed config with backwards-compatible defaults
  -> preserve unknown old keys
  -> save only on explicit user action
  -> transactional write -> ack -> UI success
```

---

## 9. 分阶段开发计划（Agent 执行顺序）

> 每完成一个阶段，更新文档末尾「实施进度」中的结果、风险和测试证据。一个阶段未通过，**停止进入下一阶段**，先修复或回滚；不得为了实现 UI 快速删除可工作的旧功能。

### P0 — 基线与保护

- [ ] 确认工作区分支、dirty 状态和实际 HEAD；只读检查并记录 SHA。
- [ ] 跑旧分支 `cargo test`，收集结果；记录旧版运行屏幕、初始连接、设置、断线、文件上传/下载与 IME 行为。
- [ ] 用测试副本检查现有数据库键值与 WebView2 profile 目录，不操作用户真实 PIN/缓存。
- [ ] 创建可回退的本地旧版构建副本，**不覆盖实际用户的可运行 EXE**。
- [ ] 写一份接口与数据模型的自动化契约测试；参照第 2–3 节。

### P1 — 最小拆分

- [ ] 抽离 Rust `config`、`discovery`、`connection`、`webview` 逻辑；保持行为与配置结构完全不变。
- [ ] 将远端 IME/剪贴板兼容脚本与可见菜单拆离，保证中文/日文输入的所有旧回归用例通过。
- [ ] 定义状态 DTO 与事件，接入单一 Connection Manager，修复旧任务与新任务竞争问题。
- [ ] 保留旧 Shell 作为临时可回滚实现，不在此阶段同时动 UI 风格、网络协议与窗口结构。

### P2 — 架构 PoC / 路线决策

- [ ] 验证路线 A 的 child WebView 创建、调整尺寸、非 UI 阻塞、WebView2 配置与数据目录复用。
- [ ] 在实际 Windows 便携 EXE 上验证 PIN、登录、输入法、视频帧/音频、上传 popup、`BroadcastChannel`、拖放、下载。
- [ ] 测多屏与 DPI、最小窗口、长时间挂机、反复打开设置与重连。
- [ ] 如有关键退化，采用路线 B，并在进度里写明理由；不要无期限卡在 `unstable` 实现。

### P3 — 新 UI

- [ ] 实现中性 Windows Shell、状态详情、刷新、重连与设置页。
- [ ] 原生 IPC 数据校验 + 持久化确认 + 失败处理；错误文案清晰可复制。
- [ ] 不允许远程网页访问本地设置命令；建立正确 capabilities/origin 边界。
- [ ] 删除旧视觉层及多余定时器，保留必要的远端兼容脚本。
- [ ] 检查长 URL、最小窗口、不同主题和各档 DPI。

### P4 — 兼容验收与发布

- [ ] `cargo fmt --check`、`cargo clippy`（按项目允许的 warnings 策略）、`cargo test`。
- [ ] 构建可运行 Windows GUI EXE（不得出现控制台窗口），验证真实机器启动。
- [ ] 复用**旧数据库、旧 WebView2 目录**，验证 WAN/LAN 自动回退、会话不丢失。
- [ ] IME、剪贴板、原生拖放上传、弹窗、系统 Downloads、外链、PIN/登录全部通过。
- [ ] 无明显内存泄漏或重复后台连接任务；不同 DPI/主题及远程画面下可读。
- [ ] 复审 diff：没有意外修改 Docker 端口、PIN、容器目录、服务器 API。
- [ ] 更新 README、开发文档、设计 QA、已知限制与回滚步骤。
- [ ] **未经用户明确授权不提交、不推送**；获得推送授权后先再次审阅最终 diff；不创建新分支（除非用户另行指示）。

---

## 10. 验收测试矩阵

| ID | 场景 | 验收标准 |
|---|---|---|
| T01 | 旧 DB 升级 | 广播名与 WAN URL 保持不变；无破坏性迁移 |
| T02 | 旧 WebView2 profile | Cookie 与 PIN 相关会话未因换版主动清除 |
| T03 | mDNS 成功 | 连接广播声明的 scheme/path/端口与期望名称 |
| T04 | 禁止 UDP 5353 | 扫描 HTTP 3000 身份端点可回退到 LAN |
| T05 | LAN 不可用 | 正确尝试 WAN，不进入无意义的循环白屏 |
| T06 | LAN/WAN 都失败 | 显示可理解错误、重试与详情入口 |
| T07 | WAN URL 设置失败 | 显示 Rust 实际失败原因，原配置不丢失 |
| T08 | 主动刷新 | 刷新远程网页，不误触发配置保存 |
| T09 | 主动重连 | 重新发现/选择端点，过期工作任务不能覆盖新结果 |
| T10 | 中文拼音/日文 IME | 上屏正确，候选不提前提交，不重复 |
| T11 | `Ctrl+C/X/V` | 本地设置与远端输入分别生效，互不抢焦点 |
| T12 | 内部上传器 popup | 同源、共享会话、`BroadcastChannel`、拖放可用 |
| T13 | 文件下载 | 使用 Windows 当前实际 Downloads 目录，文件名/内容正确 |
| T14 | 外部 HTTP(S) 链接 | 系统默认浏览器打开；客户端不生成空白幽灵窗口 |
| T15 | 100–200% DPI / 最小窗 | 不遮挡、文字不裁切、可键盘操作 |
| T16 | 自签名 HTTPS 旧配置 | 维持当前兼容行为，风险文案清楚 |
| T17 | 长时间运行/断线恢复 | 无重复连接线程/无限递增窗口/明显资源泄漏 |
| T18 | 从新版回滚旧 EXE | 旧版仍可启动，旧 SQLite 配置与 WebView2 数据可读 |
| T19 | 本地 IPC 授权 | 远端网页无法调用配置/本地系统级命令 |
| T20 | 连接阶段信息 | 不将 TCP 可达误报为 PIN/WebRTC 会话健康 |

**测试证据格式：**`ID / 日期 / 构建 SHA / 环境 / 步骤 / 期望 / 实际 / 通过与否 / 日志或截图路径`。测试截图不得暴露私人聊天、PIN、Cookie 或敏感 URL 参数。

---

## 11. 实施进度（2026-10-25 执行记录）

实施位置：`SNSBox/axiver-client/`（父仓库工作区中不存在 `axiver-client/`，基线源码取自
`git archive 1c4bfa6…`，解压于 `SNSBox/reference/old-client-1c4bfa6/`；全程未改动父级目录，
未执行任何 Git 写操作）。

| 阶段 | 状态 | 证据 / 备注 |
|---|---|---|
| P0 基线与保护 | ✅ 通过 | `SNSBox/p0-legacy-cargo-test.log`：基线 `cargo test` 12/12 通过后再动工；未删除任何旧文件 |
| P1 代码职责拆分 | ✅ 通过 | `src/{protocol,config,connection,webview,commands,app_state,platform_windows}.rs` + `src/discovery/{mod,mdns,identity,subnet}.rs`；旧 1289 行 main.rs 全部行为迁移；新 lib 单测 24 通过 |
| P2 双 WebView PoC / 路线决策 | ✅ 通过（路线 B） | 见下方「路线决策」；`tests/` 契约测试 11 项通过；真机启动 PID 存活、真实嗅探到 `https://192.168.31.235:3001/` 并加载 PIN 页 |
| P3 新 Shell UI | ✅ 通过 | `ui/shell.{html,css,js}` + `ui/waiting.html`；截图 `SNSBox/screenshots/shell-panel.png`、`remote-pin-page.png`、`shell-running.png`；`ui/injected.js`（Shadow DOM 遮罩）与 `https://axiver-client.invalid/__native/...` 伪导航已彻底移除（contract_manifest.rs 断言其不得回归） |
| P4 兼容验收与发布 | ✅ 自动化部分通过 | `cargo test` 36/36（含 14:05 用户反馈修复回归）；`cargo build --release` 零警告；`dist/AXIVER-Client.exe` 冒烟 + 真实鼠标/键盘点击验收（保存/隐藏实测生效）。T13–T20 中依赖真人交互的项待用户验收（见 design-qa-v2.md） |

### 路线决策（规格书 4.3 技术闸门）

- 路线 A（`unstable` child-webview 内嵌 Shell）需要真机逐项验证 PIN 输入、WebRTC 画面、
  IME 候选窗与上传器 opener 弹窗，本次环境无法完成该项人工验证。
- 按规格书决策规则（稳定性优先）采用**路线 B**：完整远端 `WebviewWindow`（label `remote`，
  无任何 IPC capability）+ 独立本地 Shell `WebviewWindow`（label `shell`，432×512 无边框，
  仅它持有 `core:default`）+ 系统托盘。信任边界由 `capabilities/default.json` 与 Rust 侧
  `ensure_trusted_caller`（校验 `webview.label() == "shell"`）双层强制。
- 远端页面唯一注入脚本为 `ui/remote-compat/ime-guard.js`（仅 IME 组合保护，逐字移植自旧
  `injected.js` 641–698 行，含 `stopImmediatePropagation` 与 `finalInputSeen` 延迟提交；
  不含任何 UI/IPC/伪导航）。

### 测试证据

- `SNSBox/p0-legacy-cargo-test.log` — P0 基线 12/12。
- 新工程 `cargo test`：24 单测 + 13 集成契约测试 = 37/37 通过
  （`tests/contract_{manifest,discovery,ime_compat,storage}.rs`；含 withGlobalTauri
  回归锁定与状态点非注入锁定测试）。
- 截图（`SNSBox/screenshots/`）：`shell-panel.png`（Shell 面板，已连接·当前连接：局域网）、
  `remote-pin-page.png`（远端窗口加载真实 PIN 页，标题同步 `AXi-SNS-Box - PIN`）。
  全屏原图因包含桌面其它窗口（私人会话）按 §10 隐私要求已删除，仅保留两个窗口区域裁图。
- `cargo clippy` 未安装于 stable 工具链，未执行；`cargo check --all-targets` 零警告替代。

### 工作记录

- `2026-10-25`：根据目标分支源码创建重构规格书；未实施代码变更、未运行真实 Windows 客户端测试。
- `2026-10-25 13:00–14:10 | P0–P4 | 新建 SNSBox/axiver-client/ 全量（src、ui、tests、scripts、icons、tauri.conf.json、capabilities） | 35/35 测试通过、release 构建成功、dist 冒烟与真实局域网设备连通成功 | clippy 缺失；T13–T20 人工项待用户 | 交付 README / REBUILD-SPEC 副本 / design-qa-v2 与最终报告`
- `2026-10-25 14:05–14:20 | P4 缺陷修复（用户真机反馈） | tauri.conf.json（+withGlobalTauri）、src/connection.rs（Shell 标题同步状态）、tests/contract_manifest.rs（新回归测试）、design-qa-v2.md | 根因：未开启 withGlobalTauri 导致 Shell window.__TAURI__ 缺失，保存/隐藏/刷新全部静默失效（状态卡因 eval 推送通道独立而掩盖故障）；修复后真实鼠标/键盘点击实测：Enter 保存出绿色「已保存」、页脚版本填充、隐藏生效且远端 PIN 页无遮挡完整渲染；36/36 测试通过 | 教训：UI 冒烟必须真点击，不能只看进程存活 | 用户继续 T10/T12/T13/T14 真人验收`
- `2026-10-25 14:20 | 功能新增（用户反馈） | src/{main,protocol,connection,app_state,commands,webview}.rs、capabilities/default.json、ui/dot.{html,css,js}、tests/contract_manifest.rs | 主窗口左上角本地状态点：owned window 非注入，实时状态 + 单击开合面板；真实鼠标点击实测两向切换、停靠精确；37/37 测试通过、release 零警告 | 状态点原生标题不随 document.title 更新（owned window 不进任务栏/Alt+Tab，无影响） | 用户复验状态点与真人项`
- 后续记录格式：`YYYY-MM-DD HH:mm | 阶段 | 修改路径 | 结果 | 失败/风险 | 下步`。

---

## 12. 源码依据与官方 API 参考

基线均为指定 SHA：`1c4bfa6f4540a11718b885cd343fb073c95d3a47`。

- [Windows 客户端 Rust 入口、数据结构与状态机](https://github.com/JDui/wechat-selkies/blob/1c4bfa6f4540a11718b885cd343fb073c95d3a47/axiver-client/src/main.rs)
- [旧 Shadow DOM 菜单、原生导航、IME 兼容](https://github.com/JDui/wechat-selkies/blob/1c4bfa6f4540a11718b885cd343fb073c95d3a47/axiver-client/ui/injected.js)
- [Tauri 配置](https://github.com/JDui/wechat-selkies/blob/1c4bfa6f4540a11718b885cd343fb073c95d3a47/axiver-client/tauri.conf.json)
- [旧客户端行为说明](https://github.com/JDui/wechat-selkies/blob/1c4bfa6f4540a11718b885cd343fb073c95d3a47/axiver-client/README.md)
- [旧视觉 QA](https://github.com/JDui/wechat-selkies/blob/1c4bfa6f4540a11718b885cd343fb073c95d3a47/axiver-client/design-qa.md)
- [LAN 身份结构与规则](https://github.com/JDui/wechat-selkies/blob/1c4bfa6f4540a11718b885cd343fb073c95d3a47/root/scripts/lan_discovery_common.py)
- [mDNS 广播守护程序](https://github.com/JDui/wechat-selkies/blob/1c4bfa6f4540a11718b885cd343fb073c95d3a47/root/scripts/lan_discovery_service.py)
- [通知桥服务器状态与 REST 路由](https://github.com/JDui/wechat-selkies/blob/1c4bfa6f4540a11718b885cd343fb073c95d3a47/root/scripts/notification_bridge.py)
- [Nginx HTTP 接口入口](https://github.com/JDui/wechat-selkies/blob/1c4bfa6f4540a11718b885cd343fb073c95d3a47/root/defaults/default.conf)
- [Tauri 官方 Webview API：child webview `unstable` 限制](https://v2.tauri.app/reference/javascript/api/namespacewebview/)
- [Tauri Rust `Window::add_child` 文档](https://docs.rs/tauri/latest/tauri/window/struct.Window.html)

## 13. Agent 交付指令

1. 先阅读**整份规格书**和引用的源码，逐条核查现有行为；发现文档与 HEAD 不一致时以当前待修改工作区源码为准，并记录差异。
2. 先确认目标：**替换 Windows Client UI 和前端通信方式，保留服务器、持久数据及运行时能力**。
3. 严格按 P0 → P4 工作；每个阶段写进度、差异、风险与可复现测试结果。
4. 如需碰 Docker 服务、PIN、网络端口或证书策略，暂停该改动并单独请求用户明确批准。
5. 在任何 Git 推送前完整自检与审阅，未经用户允许不推送，默认不建分支。
6. 实施完成时提供：模块变更清单、关键接口文档、迁移/回滚说明、测试矩阵结果、最终 UI 截图及尚存风险。

**完成定义：旧用户数据无损、LAN/WAN/输入法/上传下载全部可用，Windows 客户端 UI 与远程网页解耦，所有 T01–T20 验收项通过或有经用户批准的明确例外。**

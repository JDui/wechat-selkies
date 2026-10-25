> 本文为历史构建记录。当前单窗口架构与验收见 [design-qa-v3.md](./design-qa-v3.md)。

# AXIVER Client 重构版设计/验收记录 v2

对应规格书：[REBUILD-SPEC.md](./REBUILD-SPEC.md)（§10 验收矩阵、§6 UI 规范）。
本文档取代旧分支的 `design-qa.md`（旧遮罩 UI 的 QA 记录已随遮罩一并废弃）。

## 构建与环境

| 项 | 值 |
|---|---|
| 版本 | AXIVER Client 0.2.0（`com.axiver.portable-client`） |
| 产物 | `dist/AXIVER-Client.exe`，2026-10-25 14:35（下载权限与结果反馈修复） |
| 工具链 | Rust 1.96.1 x86_64-pc-windows-msvc（VS2022 Community）；Tauri 2.11.5（锁定 Cargo.lock）；WebView2 Runtime 155.0.4283.62 |
| 架构路线 | 路线 B：独立 remote WebviewWindow + 本地 shell WebviewWindow + 托盘（规格书 §4.3 决策，理由见规格书 §11） |

### 下载无法激活修复（2026-10-25 14:36）

- **复现**：使用临时 EXE 副本、新 SQLite 与新 WebView2 profile，建立只服务小文本文件的
  本地 HTTP 会话。旧版先下载 HTTP 时只有 HTTP 成功；调整顺序后只有先发起的 Blob 成功，
  后续两次 HTTP 下载连服务器请求都没有发出。由此区分了文件类型问题和连续自动下载权限问题。
- **根因**：主项目在轮询返回后点击隐藏下载链接，后续自动下载触发
  `COREWEBVIEW2_PERMISSION_KIND_MULTIPLE_AUTOMATIC_DOWNLOADS`，原客户端没有处理它。
  该权限语义见 [Microsoft WebView2 文档](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/winrt/microsoft_web_webview2_core/corewebview2permissionkind)。
  此外现有 Wry 下载回调设置 `Handled=true`，隐藏了 WebView2 的默认下载反馈。
- **修复**：通过已有 WebView2 COM 接口处理该单项权限，仅允许当前连接的精确 origin；
  scheme/port 不同、其他来源或未连接时均不授予，且 `SavesInProfile=false`。
  状态胶囊显示开始/完成/失败，面板显示最近一次结果与实际路径。
- **启动竞态**：本次隔离复现还捕获了 Shell 首次调用早于 `CoreState` 注册的偶发错误；
  前端仅对 `state not managed` 做有界短重试，其他错误仍显示真实原因。
- **验证**：`cargo test --offline --locked --lib platform_windows::tests` 4/4；
  Shell/dot JS 语法检查通过；`cargo build --release --locked --offline` 成功。
  修复后的真实 WebView2 隔离运行中，Blob、两次同源异步 HTTP、`/files/` iframe 内下载
  共 4/4 完成，逐个读取文件核对内容，无哈希校验；实际落在系统配置的 `D:\DL`。
  同时确认胶囊为「下载完成」、面板包含实际保存路径。
- **证据**：`../screenshots/download-baseline/results.json`、
  `../screenshots/download-fixed/results.json` 与对应的本轮截图。
  可复用最小运行检查：在客户端目录执行 `node scripts/verify-downloads.mjs`。
- **边界**：这证明客户端 WebView2 下载权限与本地结果链路；未在用户登录态微信/QQ 中
  重新执行原生拖放，也未重新部署主项目容器。单窗口与液态玻璃整合仍为分析方案，
  见 `UI-INTEGRATION-REVIEW.md`。

### 新增功能：主窗口左上角状态点（2026-10-25 14:20，用户需求）

主界面左上角显示状态胶囊并可呼出控制面板。实现为**独立本地 owned window**
（label `status-dot`，`ui/dot.*` 打包资产），挂接在远端窗口左上角 client 区内侧 8px：

- 不是注入远端页面（规格书 4.1 边界）；远端页面依然零 IPC、零遮罩，
  `contract_manifest.rs` 新增 `status_dot_is_a_local_window_not_a_remote_injection`
  禁止 `attachShadow`/伪导航回归，并锁定 capability windows 恰为 `["shell","status-dot"]`。
- Owned window 语义（Win32）：始终位于远端之上、随远端最小化而隐藏、随远端销毁；
  移动/缩放由 `WindowEvent::Moved/Resized` 重停靠（实测停靠坐标 client+(8,8) 精确命中）。
- 状态渲染与面板同源（同一快照、同一 revision 防乱序），配色与 Shell 同族；
  点击/回车调用 `client_toggle_settings`（受信任标签守卫扩展到 shell+status-dot）。
- **真人级实测**（Win32 真实鼠标事件）：开机停靠截图 `dot-pill.png`（绿点「已连接 ·
  局域网」透明浮于 PIN 页左上）；单击 → 面板隐藏（窗口枚举 count 0）；再击 → 面板恢复
  （count 1）。

### 用户反馈修复（2026-10-25 14:05）

用户真机反馈：面板显示「本地 IPC 不可用」「保存失败：未知错误」，隐藏按钮无效。

- **根因**：`tauri.conf.json` 缺少 `app.withGlobalTauri: true`。Shell 前端不经打包器，
  直接依赖注入的 `window.__TAURI__` 全局对象；未开启时所有 `invoke` 调用静默失效
  （状态卡仍更新是因为 Rust→JS 的 eval 推送通道独立可用，掩盖了故障）。
- **修复**：开启 `withGlobalTauri`；并让 Shell 窗口标题实时同步连接状态
  （`AXIVER 控制面板 — 当前连接：局域网`），隐藏后仍可从标题栏/托盘/Alt+Tab 得知状态。
- **回归锁定**：`contract_manifest.rs` 新增 `shell_uses_the_injected_global_tauri_bridge`，
  断言 conf 中该开关为 true 且 shell.js 确实使用全局桥 —— 此坑不允许再犯。
- **验证方式升级**：本项目的 UI 冒烟自此必须包含真实鼠标点击与键盘输入
  （`SetCursorPos`/`mouse_event`/`keybd_event`），而非仅进程存活检查。本次已实测：
  焦点进入广播名输入框 → Enter 保存 → 绿色「已保存」+ 页脚版本 `v0.2.0 (release / x86_64)`
  （证明 version/config/diagnostics 命令全通）；点击「隐藏」→ 面板消失、进程存活、
  远端窗口无遮挡继续可用。

## 自动化验证（全部通过）

| 类别 | 内容 |
|---|---|
| P0 基线 | 旧工程 `cargo test` 12/12（`SNSBox/p0-legacy-cargo-test.log`），动工前证据 |
| 新工程单测 | 24 项（protocol/config/discovery/webview/platform） |
| 契约集成测试 | 13 项：`contract_manifest`（capability 仅 shell+status-dot、无预定义窗口、withGlobalTauri 回归、遮罩脚本不得回归、等待页无脚本、状态点非注入）、`contract_storage`（旧库 WAL 边车打开、备份先行、未知键保留）、`contract_discovery`（协议常量、身份端点、chunked、TXT 端口）、`contract_ime_compat`（旧版 8 条逐字断言 + 帧/协议域约束） |
| 编译卫生 | `cargo check --all-targets` 零警告；`cargo build --release` 零警告；clippy 未安装（记录为残余项） |

## 运行时验证（真实环境，构建当日）

1. **便携性**：EXE 直接放入空目录 `dist/` 启动成功；`axiver-client.db`（12 KB，含
   `settings` 表 + `broadcast_name=AXISNSBOX-000`）与 `axiver-client-data/EBWebView`
   生成于 EXE 旁；无安装器、无注册表依赖。
2. **崩溃恢复**：`Stop-Process -Force` 硬杀后重新启动，进程 14 s 存活（约 38 MB 常驻），
   SQLite WAL 恢复正常。
3. **真实局域网连通**：连接 Manager 自动 mDNS 发现并校验真实设备，远端窗口
   （label `remote`）导航至 `https://192.168.31.235:3001/` 并加载完成 —— 窗口标题随
   远端文档标题同步为 `AXi-SNS-Box - PIN`（证明真实页面已加载且标题处理器工作）。
4. **Shell 状态诚实性**：面板显示 `已连接 · 当前连接：局域网` + 目标 URL + 最近检查时间 +
   「状态仅代表 TCP 可达与页面加载完成，不代表已登录」脚注；`sessionVerified` 恒为
   `未报告`。

## 截图证据

| 文件 | 内容 | 隐私处理 |
|---|---|---|
| `../screenshots/ipc-save.png` | IPC 修复后的 Shell 面板：已连接状态卡 + Enter 保存后的绿色「已保存」+ 页脚版本号（14:15 实测） | 无远端内容 |
| `../screenshots/dot-pill.png` | 主窗口左上角状态点实测：透明胶囊、绿点、「已连接 · 局域网」、▾ 提示（14:3x 实测） | 仅 PIN 页深色底 |
| `../screenshots/ipc-tray-remote.png` | 面板隐藏后完整无遮挡的远端窗口：Selkies「输入 PIN 码以校验权限」页真实渲染 | 无 PIN 输入 |
| `../screenshots/shell-panel.png` | 初版面板截图（13:52，eval 通道正常但 IPC 尚未修复） | 无远端内容 |
| `../screenshots/remote-pin-page.png` | 初版远端窗口区域（深色底，PIN 页未可见，后被 ipc-tray-remote 取代） | 同上 |

### 状态可见性设计（回应「怎么知道连接状态」）

| 位置 | 内容 |
|---|---|
| 主窗口左上角状态点（新增） | 透明胶囊：状态色点 + 中文状态（绿=连接/黄=进行/蓝=广域/红=断）；**单击开合控制面板**；随远端移动/缩放停靠、最小化自动隐藏 |
| 面板顶部状态卡 | 状态点（同上配色）+ 中文状态与详情 + 目标 URL + 最近检查时间 + 「连接详情」展开（状态机/TCP/页面/会话分列）+ 错误代码横幅 |
| 面板标题栏（新增） | `AXIVER 控制面板 — <当前状态>`，Alt+Tab 与任务栏预览直接可读 |
| 系统托盘 | 悬停 tooltip 与菜单首行「AXIVER：<状态> — <目标>」实时同步；左键单击面板显隐 |
| 诚实性约束 | 「已连接」仅代表 TCP 可达+页面加载完成；`会话验证` 恒「未报告」并有脚注，绝不把 TCP 误报为登录/画面健康（T20） |

## 验收矩阵 T01–T20

图例：✅ 自动化或运行时已验证 | 🔶 部分验证（自动侧通过，交互侧待人工） | ⬜ 待用户真机验收

| ID | 状态 | 证据 / 待办 |
|---|---|---|
| T01 旧 DB 升级 | ✅ | `contract_storage`：旧键读入不变、大写归一仅在写入时；`load` 对非法值只回退不落库 |
| T02 旧 WebView2 profile | ✅ | 数据目录路径与旧版完全一致（EXE 旁 `axiver-client-data`），无任何清理逻辑 |
| T03 mDNS 成功 | ✅ | 真实设备连通（上述第 3 条）+ `contract_discovery` |
| T04 禁 UDP 5353 | 🔶 | 同网段扫描 + 3000 身份端点单测齐备；需在真机防火墙拦截 5353 下复测 |
| T05 LAN 不可用→WAN | 🔶 | 状态机与错误码单测覆盖；需真机拔 LAN 线场景复测 |
| T06 双失败提示 | 🔶 | Disconnected + 错误代码 + 详情入口 + 退避重连已实现并有单测；界面文案待真机确认 |
| T07 WAN 保存失败 | ✅ | `save_config` 仅 ok 后显示"已保存"；真实错误消息（含旧版中文校验语）逐条返回；真机 Enter 保存实测出绿色「已保存」（ipc-save.png） |
| T08 主动刷新 | ✅ | `client_refresh_remote` 仅 `remote.reload()`，不触碰配置；UI 上独立按钮；隐藏按钮真机点击实测生效 |
| T09 主动重连 | ✅ | 代际取消令牌：过期 worker 结果被丢弃；revision 单调；`client_reconnect` 强制全管线 |
| T10 中文/日文 IME | ⬜ | 注入脚本为旧版逐字移植（含 stopImmediatePropagation / finalInputSeen 延迟提交），契约测试锁定字符串；上屏正确性需真人用微软拼音/日文 IME 打长句验证 |
| T11 Ctrl+C/X/V | 🔶 | 面板与远端为不同窗口，天然不互抢；Shell 输入框原生可用；真机复核 |
| T12 上传器 popup | ⬜ | Rust 侧策略（`/uploader/` 前缀、共享 data_directory、来源锁定、`on_new_window` 白名单）+ 单测；`BroadcastChannel`/拖放需真人上传一次验证 |
| T13 文件下载 | 🔶 | `on_download` → 系统 Downloads 目录 + 文件名净化（移植旧逻辑+单测）；真实文件内容比对待人工 |
| T14 外部链接 | 🔶 | 非会话来源 http(s) 导航拒绝 + `ShellExecuteW` 交默认浏览器（移植+单测）；"无幽灵窗口"需真机点外链确认 |
| T15 DPI 100–200% | 🔶 | 当前验证在 150% 缩放下完成（截图即证）；100%/200% 与最小窗键盘操作待人工 |
| T16 自签 HTTPS | ✅ | `--ignore-certificate-errors` 逐字保留（`webview_browser_arguments` 单测锁定）；风险文案见 README「已知风险 1」 |
| T17 长跑/断线恢复 | 🔶 | 单连接线程 + 代际取消设计、探活循环复用；需用户挂机半天观察（进程数恒为 1、无句柄增长） |
| T18 回滚旧 EXE | ✅ | 写库仅 upsert 两个旧键、schema 不变、无新文件被旧版依赖；contract_storage 佐证 |
| T19 本地 IPC 授权 | ✅ | 双层：capability windows:["shell"] + `ensure_trusted_caller`；remote 零权限；manifest 契约测试锁定 |
| T20 阶段信息真实性 | ✅ | `sessionVerified` 恒 null、状态点/面板脚注、TCP 可达与页面加载分列展示（见 dot-pill.png / ipc-save.png） |

### 待用户执行的真人验收清单（对应 ⬜/🔶）

1. 微软拼音连续输入 20+ 字长句含候选翻页，确认上屏一次、不丢字、不重复（T10）。
2. 触发一次上传器上传与一次远端文件下载，检查 Downloads 目录内容（T12/T13）。
3. 远端页面点击外部 http(s) 链接，确认默认浏览器接管且客户端无空白窗口（T14）。
4. 拔 LAN 线 / 关 Wi-Fi 观察 WAN 回退与错误文案；恢复后点"重新连接"（T05/T06/T17）。
5. 防火墙阻断 UDP 5353 复测同网段扫描（T04）。
6. 100% 与 200% 缩放各开一次面板（T15）。

## UI 设计自检（规格书 §6.3 缺陷修复对照）

- 遮罩内嵌导致的焦点/IME 冲突 → 遮罩整体删除，远端为纯页面。
- 「连接成功」误导 → 状态三分（TCP/页面/会话），会话恒"未报告"。
- 保存成功即绿 → 仅在 SQLite 事务 commit 后显示"已保存"；失败展示 Rust 真实消息。
- 重连/刷新混用 → 两个独立按钮 + 独立 loading 态。
- 后台推送覆盖编辑中的表单 → `editingDirty`/焦点守卫。
- 面板误关导致失联 → 关闭=隐藏 + 托盘常驻 + 置顶开关。

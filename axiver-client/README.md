# AXIVER Windows Client

Tauri 2 + Rust + WebView2 便携客户端，连接 AXIVER / wechat-selkies，支持局域网与广域地址并行探测。

## 单窗口界面

- 只有一个原生主窗口。远程桌面占据内容区，本地状态胶囊与控制面板均为窗口内部的子视图。
- 默认只显示左上角紧凑状态胶囊；点击展开「连接 / 下载 / 设置」，面板按当前内容调整高度，不挤压远程桌面。
- 状态胶囊可拖动，位移限制在窗口内。拖动不会触发点击；松手后 **10 秒自动归位**，再次拖动重新计时。设置页提供立即归位，胶囊聚焦后也可按 Home。归位使用约640ms的弹簧过渡，可被再次拖动打断。
- 「连接」提供刷新、重新连接、按需展开的诊断；「下载」显示最近结果与实际路径；「设置」提供广播名、广域地址及主窗口置顶。
- Esc 或「收起」关闭窗口内面板；实际点击面板/药丸以外的区域（包括远程视图和其他应用），也会自动收纳为药丸；内部点击、切换页签、输入聚焦或单纯失焦不会收纳，约500ms后再回到点，且不抢回外部焦点。关闭主窗口退出程序；托盘用于恢复主窗口。
- 状态胶囊高度26px，宽度随文字自适应，无箭头。胶囊复用主项目 Bar 的灰色半透明底色、高光描边与柔和投影，药丸与控制面板分别采用等效7.2px、12px模糊，由预处理的小尺寸画布提供同族磨砂材质。开合、页签、详情、状态文字、按钮与进度均有动效，并尊重系统减少动态效果偏好。
- 等待页、标题栏、托盘和EXE使用同一份 `ui/brand-mark.svg` 设计。用 `node scripts/build-brand-assets.cjs [sharp模块路径]` 更新各尺寸PNG和ICO资源。
  构建脚本监听 `icons/` 以同步重建Windows资源，避免EXE继续使用缓存旧图标。

本地与远端仍为不同 WebView。只有打包的 `shell` 子视图拥有 IPC；配置命令同时验证子视图标签与本地来源。远端不注入设置遮罩，唯一兼容脚本仍为 IME 组合保护。

IME 兼容脚本在旧服务端上于选词结束时立即提交文字，避免快速回车先发送、下一轮选词覆盖上一词；候选词确认键留给本地输入法。若服务端已提供完整输入队列（`selkiesRecoverPendingInput`），则由服务端统一处理。针对性事件顺序回归可运行 `node tests/ime-guard.cjs`；它不代表真实输入法与微信的端到端验收。

磨砂背景来自 WebView2 CapturePreview 对当前远程内容的内存采样；仅裁剪控件周围的区域，复用逐级缩小的 mipmap 画布，在约四分之一分辨率做小半径高斯模糊后交给 CSS 显示。采样不包括其他应用和本地控制层，不保存截图文件。面板展开时约6次/秒，收起为点时约2次/秒，最小化或隐藏时暂停。

## 连接与文件传输

- 单一连接管理器同时推进 mDNS、已缓存内网候选的身份验证、同网段扫描与已填写的广域地址探测。内网结果立即采用；外网先返回时最多保留250ms的内网优先窗口。连接后取消其他探测，版本号拒绝过期状态；不再提供手动切换跳转按钮。
- 上次成功的内网目标保存在 `axiver-client-data/last-lan.json`，使用前重新验证 service/name 与当前端口。已填写的私有 IPv4 广域地址也可成为内网候选。
- 阶段耗时记录在 `axiver-client-data/connection-timing.jsonl`，约1MiB封顶，不记录页面内容、Cookie或广域地址；计时不包含进程启动和创建WebView2。
- 「已连接」仅表示网络可达与页面加载完成，会话登录状态继续标为未报告。
- 刷新只刷新页面；重新连接重新发现目标。断线保留退避恢复逻辑。
- 主项目的内嵌上传器和文件浏览器继续使用原有会话。旧服务器的 `/uploader/` 弹窗请求也在主窗口内的工具子视图显示，并可从连接页返回桌面，使用共享 profile 与 BroadcastChannel。
- 连续自动下载只对当前服务器精确 origin 授权，不写入持久权限。状态胶囊提示等待确认/下载/完成/失败，最近下载保留本次运行的记录，点击已完成项可在资源管理器中选中文件。
- 下载中显示实时接收量、总大小、百分比和速度（B/s、KB/s、MB/s）；速度采用约1秒滑动窗口，不计算等待确认的时间。服务器不提供总大小时显示流动进度条及真实接收量/速度，完成后以落盘大小更新记录。
- 跨站 HTTP(S) 外链交给系统浏览器；危险协议拒绝。

## 下载模式

设置页可切换并保存：

- **默认位置**（初始模式）：在磨砂控制面板内确认是否下载；确认后保存到默认目录，取消则放弃。同名文件自动改名保留，不覆盖已有文件。
- **每次询问**：直接打开系统保存位置选择框，没有额外的“是否下载”确认；取消保存框即放弃。

默认目录初始采用系统配置的 Downloads，可通过设置页更改。模式和显式选择的目录保存在 EXE 旁的 `download-settings.json`，不改变原SQLite结构。设置只影响后续新任务；已收到的请求保持原模式。系统保存窗口按队列逐个显示，原下载请求、Cookie和一次性凭证保留，不重新抓取文件。

## 便携数据与构建

EXE 旁的 `axiver-client.db`、`axiver-client-data/` 和 `backups/` 沿用原有格式。SQLite 仍只写 `broadcast_name`、`wide_url` 两个键，未知键保留，写入前先备份。界面临时位置不写入配置数据库。

```powershell
cargo build --release --locked --offline
```

便携产物：`dist/AXIVER-Client.exe`。替换正在使用的版本时先关闭旧进程，是否保留回滚副本按当次授权处理；2026-11-17已按用户要求直接替换并重启，未创建EXE备份。

最小隔离运行检查（创建临时 EXE/profile/DB，不使用用户登录态）：

```powershell
$env:AXIVER_CHECK_UI='1'
node scripts/verify-downloads.mjs target/release/axiver-client.exe ../screenshots/progress-brand-release-final
```

并行连接、自动收纳与mipmap磨砂的本机计时及验收见 [2026-11-17记录](../docs/client/connection-frost-2026-11-17.md)。针对性原生检查可运行 `node scripts/verify-connection-frost.mjs`。

浮窗展开、切页和移动时短暂失去模糊、出现黑边的修复及验证边界见 [2026-11-19记录](../docs/client/frost-loading-fix-2026-11-19.md)。异步材质回归运行 `node tests/frost-lifetime.cjs`；浏览器材质回归运行 `node scripts/verify-frost-headless.mjs`。

进度、品牌和Bar风格验收见 [design-qa-v5.md](./design-qa-v5.md)，此前磨砂与模式记录见 [design-qa-v4.md](./design-qa-v4.md)，设计分析见 [UI-INTEGRATION-REVIEW.md](./UI-INTEGRATION-REVIEW.md)。旧版架构记录保留在 `design-qa-v2.md`。

原有进程级 `--ignore-certificate-errors` 策略继续保留以兼容自签部署；本次不改变证书策略。真实中文/日文输入、登录后的微信/QQ 拖放与长时间远程会话仍需在实际环境中验证。

## 分支与目录

当前维护分支为 `JDui/wechat-selkies:AXIVER-Client`，替代旧 `SNS-Box-Window`。本分支以服务端 `AXiVer` 当前代码为基线，旧客户端分支作为合并父提交保留，客户端源码由现有重构工程导入；服务端源码与部署配置沿用基线。

源码与文档原先位于本地 `SNSBox/axiver-client/`，现位于仓库根目录的 `axiver-client/`；验收截图位于 `screenshots/`，旧版基线测试日志归档于 `docs/client/p0-legacy-cargo-test.log`。历史记录中的 `SNSBox/...` 表示迁移前路径，`reference/` 为保留在原工作区的本地回滚快照。

构建产物、便携数据库、WebView2 profile、下载设置和回滚副本不进入 Git。此次迁移只进行文件一致性、Cargo 清单和 JavaScript 语法检查，已有运行验收结果保留原记录，不代表迁移时重新运行验收。
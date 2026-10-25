# AXIVER Windows Client

Tauri 2 + Rust + WebView2 便携客户端，连接 AXIVER / wechat-selkies，支持局域网发现与广域回退。

## 单窗口界面

- 只有一个原生主窗口。远程桌面占据内容区，本地状态胶囊与控制面板均为窗口内部的子视图。
- 默认只显示左上角紧凑状态胶囊；点击展开「连接 / 下载 / 设置」，面板按当前内容调整高度，不挤压远程桌面。
- 状态胶囊可拖动，位移限制在窗口内。拖动不会触发点击；松手后 **10 秒自动归位**，再次拖动重新计时。设置页提供立即归位，胶囊聚焦后也可按 Home。归位使用约640ms的弹簧过渡，可被再次拖动打断。
- 「连接」提供刷新、重新连接、按需展开的诊断；「下载」显示最近结果与实际路径；「设置」提供广播名、广域地址及主窗口置顶。
- Esc 或「收起」关闭窗口内面板；关闭主窗口退出程序；托盘用于恢复主窗口。
- 状态胶囊高度26px，宽度随文字自适应，无箭头。胶囊复用主项目 Bar 的灰色半透明底色、高光描边与柔和投影，背景模糊从9px减至7.2px；控制面板使用同族磨砂材质。开合、页签、详情、状态文字、按钮与进度均有动效，并尊重系统减少动态效果偏好。
- 等待页、标题栏、托盘和EXE使用同一份 `ui/brand-mark.svg` 设计。用 `node scripts/build-brand-assets.cjs [sharp模块路径]` 更新各尺寸PNG和ICO资源。
  构建脚本监听 `icons/` 以同步重建Windows资源，避免EXE继续使用缓存旧图标。

本地与远端仍为不同 WebView。只有打包的 `shell` 子视图拥有 IPC；配置命令同时验证子视图标签与本地来源。远端不注入设置遮罩，唯一兼容脚本仍为 IME 组合保护。

磨砂背景来自 WebView2 CapturePreview 对当前远程内容的内存采样，再在本地材质内实际模糊；采样不包括其他应用和本地控制层，不保存截图文件。面板展开时最高4次/秒，收起后降低采样频率，最小化时暂停。

## 连接与文件传输

- 单一连接管理器推进 mDNS → HTTP 身份验证 → 同网段扫描 → WAN 回退 → 导航与探活；版本号拒绝过期状态。
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

便携产物：`dist/AXIVER-Client.exe`。当前环境中的真实 EXE 若正在运行，不直接替换；保留回滚副本。

最小隔离运行检查（创建临时 EXE/profile/DB，不使用用户登录态）：

```powershell
$env:AXIVER_CHECK_UI='1'
node scripts/verify-downloads.mjs target/release/axiver-client.exe ../screenshots/progress-brand-release-final
```

进度、品牌和Bar风格验收见 [design-qa-v5.md](./design-qa-v5.md)，此前磨砂与模式记录见 [design-qa-v4.md](./design-qa-v4.md)，设计分析见 [UI-INTEGRATION-REVIEW.md](./UI-INTEGRATION-REVIEW.md)。旧版架构记录保留在 `design-qa-v2.md`。

原有进程级 `--ignore-certificate-errors` 策略继续保留以兼容自签部署；本次不改变证书策略。真实中文/日文输入、登录后的微信/QQ 拖放与长时间远程会话仍需在实际环境中验证。

## 分支与目录

当前维护分支为 `JDui/wechat-selkies:AXIVER-Client`，替代旧 `SNS-Box-Window`。本分支以服务端 `AXiVer` 当前代码为基线，旧客户端分支作为合并父提交保留，客户端源码由现有重构工程导入；服务端源码与部署配置沿用基线。

源码与文档原先位于本地 `SNSBox/axiver-client/`，现位于仓库根目录的 `axiver-client/`；验收截图位于 `screenshots/`，旧版基线测试日志归档于 `docs/client/p0-legacy-cargo-test.log`。历史记录中的 `SNSBox/...` 表示迁移前路径，`reference/` 为保留在原工作区的本地回滚快照。

构建产物、便携数据库、WebView2 profile、下载设置和回滚副本不进入 Git。此次迁移只进行文件一致性、Cargo 清单和 JavaScript 语法检查，已有运行验收结果保留原记录，不代表迁移时重新运行验收。
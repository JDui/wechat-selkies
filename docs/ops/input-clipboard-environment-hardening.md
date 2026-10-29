# 输入、剪贴板与微信运行环境加固

更新：2026-10-30。源码已修改，未构建发布镜像，未更新或重启 NAS。

## 中文整段提交

X11 的 `co,end` 只要包含非 ASCII 字符，就通过 `x11_text_paste.py` 提供整段文本并触发目标应用粘贴；纯 ASCII 和 Wayland 保留原有输入方式。移除了中文逐字符临时键位映射，因此不再依赖应用在 200 ms 内消费键盘事件。

选择提供方复用 python-xlib，无新增 Python 包。它在独立线程处理 X11 selection 协议：

- 注入前保存原剪贴板的数据格式和内容，包括 HTML、图片，以及 INCR 分块数据；默认快照合计上限 32 MiB，快照失败时不夺取剪贴板。
- 使用默认 `Ctrl+V`，等焦点窗口所属 X 客户端读取文字后恢复原内容，并通知格式恢复；其它客户端提前读取不会确认本次提交。
- 监控、手动读取、客户端写入和文本提交共享锁，内部提交文本不会被监控同步回本机。
- 若另一个应用取得了剪贴板，保留它的新内容；不覆盖用户后续复制。
- 应用不读取、焦点变化、快照失败等情况显示“文字提交未完成”，不自动补发，以免重复输入。
- 连接取消会等待在途 selection 事务收尾；X server 重建后清理旧连接，下次提交重新建立服务。

“应用请求并收到文本”仍不是微信输入框内容的读回确认；需要部署后用登录态微信 / QQ 验收。配置默认针对聊天应用：只接受粘贴的目标输入框可使用此路径。终端通常需要设置 `SELKIES_IME_PASTE_SHORTCUT=shift+Insert` 或 `ctrl+shift+v`；不支持粘贴的输入控件会提示失败。

## 剪贴板兼容

- 文本按 `UTF8_STRING`、两种 UTF-8 MIME、`text/plain`、UTF-8 `TEXT`、Latin-1 `STRING` 尝试；保留原有换行。
- 常见 PNG/JPEG/WebP/BMP/TIFF/PPM 以及可解码的 Qt 图像数据，复用已有 Pillow 转为浏览器可写入的 PNG。
- 单个本地图片 URI 支持 `text/uri-list` 与 `x-special/gnome-copied-files`，只读取解析后位于 `/config` 内的本地图片，不请求网络 URL、不读取其它目录。多文件仍由文件传输功能处理。
- 每个 target 独立超时，失败后尝试下一个格式；完整一次读取有 8 秒预算，取消和超时会终止并回收读取子进程。
- 手动收取会再次发送相同内容；自动监控同时比较内容与 MIME，避免格式变更被误判成无变化。
- 格式列表变化会记录 target 元数据；`SELKIES_CLIPBOARD_DIAGNOSTICS=true` 可临时打开逐次格式记录。日志不保存复制内容。

不自动读取 PRIMARY：单纯选中文字不应触发客户端剪贴板覆盖。实际微信若仍失败，可从新日志直接区分格式不支持、提供方超时和后续传输问题。

## 微信环境加固

- `PERSIST_SYSTEM_IDENTITY=true`：启动阶段保存 OS machine-id 与 D-Bus machine-id 到 `/config/.system-identity`，后续容器替换恢复这些值。已有微信目录时，首次采用当前容器现有值；全新配置生成独立标识。保存值损坏时停止初始化并报错，避免静默轮换。
- `WECHAT_PROXY_MODE=direct`：仅对微信进程清除 HTTP/HTTPS/ALL/FTP 代理环境变量，设置 no_proxy；`inherit` 保留调用环境。它不改变路由器、TUN、VPN 或透明代理，也不声称控制微信内部的所有网络代理实现。
- 微信启动使用进程生命周期锁，避免启动脚本和 watchdog 竞争拉起重复实例。
- 手动重启先发 TERM 并等待退出，超时后才 KILL；等待原启动器释放锁再拉起，保留正常关闭机会。
- `wechat-client.log` 增加实际安装包版本、代理模式、时区及标识持久化状态，不输出代理地址或设备标识本身。

这些措施没有修改微信账号数据库、恢复随机点击保活、修改路由器、或尝试绕过服务端安全验证；不能保证解除账号级安全会话撤销。

### 首次升级的迁移边界

新容器无法自动读取已删除旧容器的 `/etc/machine-id`。若需要严格保留 NAS 旧容器身份，应在替换前由旧容器保存这两个文件到 `/config/.system-identity/machine-id` 和 `dbus-machine-id`，保留权限，并在升级后核对初始化日志。不要用另一台机器或另一份镜像中的 ID 代替。

NAS 实际使用独立的 `X:\Docker\wechat\docker-compose.yml`，本轮未修改该文件或它的账号数据。部署时如需环境代理，应明确配置 `WECHAT_PROXY_MODE=inherit`；默认行为为 direct。

## 定向验证

复用本地 `wechat-selkies:1.75` 的隔离容器，复制本轮源文件进行验证，无网络、无 NAS 挂载：

- 目标暂停 300 ms：`中ab` 完整保留；暂停 500 ms：`中文` 完整保留。
- 中文短句和中英混合提交通过；示例 11 字中文提交约 0.09 秒。
- 两次提交后恢复相同的 224,796 字节 PNG，包括 INCR 接收/发送；第三方剪贴板消费者先行读取也没有提前结束提交。
- 目标暂停 4.3 秒时，24 字提交完整，42 个视频 ACK 正常处理，最大延迟约 5.9 ms；键位映射保持不变。
- 首次焦点、追加已有文本、按住空格/数字四个旧边界场景通过。
- 真正的 xclip 格式探针中，之前失败的两种 `text/plain` 格式现在均读取成功；PNG 和 UTF8_STRING 保持正常。
- 单元检查覆盖图像转换、文件 URI 范围、单 target 超时回收、重复收取、输入队列，以及标识跨替换保存和损坏保护。启动脚本检查覆盖 direct/inherit、重复启动互斥、退出码和日志失败降级。

运行入口：

```powershell
python -m unittest tests.test_text_injection tests.test_clipboard_compatibility tests.test_stable_desktop_environment tests.test_input_queue_decoupling
python -X utf8 tests/ime_xtest_container_probe.py --image wechat-selkies:1.75
python -m unittest tests.test_ime_first_character
```

xterm 原生探针使用其 Shift+Insert 粘贴绑定；微信/QQ 的默认 Ctrl+V 与真实操作仍需部署后验收。微信是否连续多夜保持登录尚未验证。

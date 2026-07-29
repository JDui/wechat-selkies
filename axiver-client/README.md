# AXIVER 便携客户端

这是一个面向 AXIVER 的 Windows 桌面浏览器客户端，使用 Tauri 2 + Rust。

## 行为

- 启动后嗅探 mDNS 服务 `_axisnsbox._tcp.local.`；若 UDP 5353 组播不可见，
  自动扫描当前电脑私有 IPv4 同网段的 HTTP 3000 身份端点。
- 仅连接广播名与设置一致的实例，默认名为 `AXISNSBOX-000`。
- 使用 HTTP 身份端点校验 `/.well-known/axisnsbox`，随后按项目广播的协议
  和端口打开页面。
- 未发现可用局域网容器时，自动回退到保存的广域地址。
- 已连接后每 8 秒探测一次目标；断线后自动重新开始局域网嗅探和广域回退。
- 左上角悬浮点展示红、黄、蓝和彩虹状态，并自动收纳。
- 收纳后的状态点可按住拖动；位置只在本次运行中保留，不写入数据库，
  下次启动会回到左上角。
- 抽屉在鼠标停留或输入框聚焦时不会自动收纳；连接重试不会主动打开抽屉，
  后台状态刷新也不会覆盖正在编辑的内容。
- 两个设置输入框通过轻 DOM 插槽接收文字和剪贴板事件，远端 Selkies 的全局
  键盘、IME 与 `Ctrl+C/X/V` 监听不会抢走焦点或截获菜单内的本地编辑操作。
- 客户端会保护 Selkies 隐藏输入框的中文 IME 组合事件，候选期间保留临时文本，
  并兼容 WebView2 仅通过 `compositionend.data` 返回候选词的情况；选中候选词后
  仅提交最终中文一次，即使容器页面尚未更新也能生效。
- Selkies 上传器在同源、共享 WebView2 环境的独立窗口中打开，因此登录状态、
  `BroadcastChannel` 和文件传递保持可用；同时放行网页原生拖放上传事件。
- 下载请求会明确放行，并尊重 Windows 重定向后的系统“下载”目录；若 WebView2
  只给出相对文件名，客户端会将其补成该目录下的绝对路径。
- 除上传器外的 HTTP/HTTPS 弹窗与 `target="_blank"` 链接通过 Windows
  `ShellExecuteW` 交给默认浏览器，失败时才回退到 WebView2 默认行为。
- 启动和等待连接时窗口标题为 `AXIVER Client`；连接成功后跟随当前网页
  的标题，并响应网页后续的标题变化。

## 便携数据

发布文件为单独的 `AXIVER-Client.exe`，不需要安装器。首次启动时会在可执行文件旁创建：

- `axiver-client.db`：SQLite 设置数据库，保存广播名和广域地址。
- `axiver-client-data/`：WebView2 的 Cookie、缓存和会话数据。

因此移动客户端时，请把 EXE、DB 和数据目录一起移动。

## 编译

需要 Rust stable、Microsoft C++ Build Tools 和 WebView2 Runtime。

```powershell
.\scripts\build-portable.ps1
```

输出文件位于 `dist\AXIVER-Client.exe`。Release 与 Debug 均使用 Windows GUI subsystem，不会弹出命令行窗口。

如果 Windows 防火墙或路由器阻止 UDP 5353，客户端会先执行同网段身份扫描，
仍未找到项目时才尝试已配置的广域地址。

客户端按用户要求把所连接的局域和广域地址都视为主动信任目标。Windows
WebView2 仅在本客户端进程内使用 `--ignore-certificate-errors`，不会显示
TLS 证书警告页，也不会修改 Windows 或其他浏览器的证书设置。

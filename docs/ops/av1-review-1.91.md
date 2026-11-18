# 1.91 AV1 审查整改与可观测性

日期：2026-11-18（Asia/Shanghai）。基线：`AXiVer` / `6502d130ff9913ba3ab6cebbe9faa39135feb5e1`（1.90）。本轮按 13 条外部审查建议核查源码、修复确定问题并提供目标机器验收工具。没有在当前开发环境模拟填写 Mesa、GPU 硬编或客户端硬解的实机结果。

## 逐项结论

| 建议 | 核查和处理 | 验证状态 |
| --- | --- | --- |
| A1 编码器列表 | 发现实际遗漏：Compose 缺少 AV1，README 示例及变量表缺少 HEVC / AV1。现统一为 `x264enc,h265enc,av1enc,x264enc-striped,jpeg`，加入一致性回归 | 源码及测试通过 |
| A2 Mesa / VA-API | 新增镜像内只读预检，保存包版本、vainfo 原始结果、profile 和编码入口；同时认可 EncSlice 与 EncSliceLP | 工具已测试，目标镜像待执行 |
| A3 设备权限 | 以桌面用户 abc 的实际身份检查设备属主、组、模式及 O_RDWR 打开；启动能力检查也验证真实权限 | 权限拒绝等回归通过，目标设备待执行 |
| B4 启动能力快照 | 记录选中节点、执行用户、hardware_encoders、hardware_formats、探测结果及配置允许状态 | 服务端方法测试通过 |
| B5 回退原因 | 初始化、首关键帧超时、运行中退软件、码流异常与客户端解码错误使用独立代码 | 服务端与前端测试通过 |
| B6 会话指标 | 增加原生编码、服务端传输及客户端解码三个不同测量点的有界统计 | 计数及生命周期回归通过，实际性能待测 |
| C7 关键帧序列头 | 上游每个强制关键帧都会重新提交序列参数；驱动实际输出增加序列头检查，缺失明确回退 | 固定源码核查及码流反例通过 |
| C8 裁切 / 坐标 | 覆盖 1080→1088、1440→1472、768→768，以及 DPR 2、主控 / 共享、中心 / 边缘坐标 | 真实序列头和实际前端函数回归通过 |
| C9 选项显示 | 同时要求服务器能力、允许列表和浏览器支持；重连清除旧服务器能力 | 前后端测试通过 |
| D10 同机基线 | 提供使用同一运行容器的 H.264 / HEVC / AV1 采样命令，核查实际 codec 和会话 | 工具已测试，实机未跑 |
| D11 固定操作 / 录屏 | 5 秒预热、20 秒静态、20 秒滚动、20 秒混合；性能轮与录屏画质轮分开 | 时间线及结果校验通过，图形实测待执行 |
| E12 回滚 | 按正在运行的镜像 ID 保存标签，用只覆盖 image 的 Compose 文件回滚，复用原配置与 /config | 流程已提供，未操作 NAS |
| E13 默认及偏好 | 默认仍为 H.264；不支持或失败的 AV1 偏好保存为 H.264，换登录 query 和新本地存储仍恢复 H.264 | 实际偏好拦截器回归通过 |

768 本身是 64 的倍数，在本轮几何测试中作为对照尺寸。模拟解码器的裁切与坐标测试不等于浏览器实际解码验收。

## 能力探测和菜单

服务监听启动前，以实际桌面进程身份调用 `probe_capability()`，检查选中的 render 节点是否为字符设备、能否读写打开、私有运行库 API、AV1 编码器及 `420-8` 格式。节点索引沿用现有约定：`0` 对应 `/dev/dri/renderD128`。

探测日志的标识为 `Video capability snapshot`。快照的 `hardware_verified=false` 表示这一阶段仅检查能力，没有执行真实编码。实际 AV1 启动仍再次检查能力、首个关键帧及原生 `stream_info()`，处理探测后设备或驱动状态改变的情况。

WebSocket `server_settings` 增加顶层 `av1_capability`，只包含 `available` 与 `reason_code`；设备 UID、组和原生细节留在服务器日志。探测不通过时，`settings.encoder.allowed` 移除 `av1enc`。前端还同时要求浏览器支持，不从默认菜单兜底露出 AV1。

若旧偏好仍为 AV1，当前连接的服务端或浏览器不支持时，会更新实际传输选择并持久保存 H.264。Token 模式等待角色确认，避免共享观看者替主控写全局偏好。

## 稳定错误码

服务端通知保留 `AV1_ENCODER_FALLBACK,` 前缀，后缀改为 JSON：

```text
AV1_ENCODER_FALLBACK,{"code":"first_keyframe_timeout","message":"AV1 encoder produced no key frame within 8 seconds"}
```

前端兼容旧纯文本通知，并保留服务端小写原因码；客户端上报仍限定为大写枚举，避免把服务端回退再次当成客户端故障。主要分类如下：

| 阶段 | 代表代码 |
| --- | --- |
| 配置 / 能力 | `encoder_not_allowed`、`cpu_mode`、`device_missing`、`device_permission_denied`、`runtime_unavailable`、`av1_encoder_missing`、`av1_format_unsupported` |
| 初始化 | `encoder_init_failed`、`first_keyframe_timeout`、`initial_hardware_mismatch` |
| 运行状态 | `runtime_software_fallback`、`runtime_codec_changed`、`runtime_format_changed`、`runtime_info_unavailable` |
| 码流 | `sequence_header_missing`、`obu_invalid`、`native_geometry_invalid`、`startup_queue_overflow` |
| 客户端 | `CLIENT_DECODE_FAILED`、`CLIENT_FIRST_FRAME_TIMEOUT`、`CLIENT_OUTPUT_TIMEOUT`、`CLIENT_QUEUE_OVERFLOW` 等有限枚举 |

客户端只向当前主控连接发送 `AV1_CLIENT_ERROR,<枚举码>`，不发送原始错误全文、URL 或视频内容。服务端要求 controller 角色、当前显示器连接所有者、当前 AV1 状态，并限制为每 5 秒最多一次。共享观看者不能使用该消息控制编码；服务端回退通知不会被客户端再次回传。

回退通知最多等待 1 秒。连接关闭、背压或通知失败不能阻止捕获器清理和 H.264 恢复。初始化错误后，原生 stop 的二次错误不会覆盖最初的失败码。

## 强制关键帧与序列头

固定 pixelflux 2.2.3 的标签对应提交 `5c78910e524539a2b801433303ee61dd04f42a51`。其 [VA-API encode_surface](https://github.com/selkies-project/pixelflux/blob/5c78910e524539a2b801433303ee61dd04f42a51/pixelflux/src/encoders/vaapi/mod.rs) 把 `force_idr` 纳入关键帧条件，并在每个 key 上调用 `arm.sequence()`；[AV1 sequence](https://github.com/selkies-project/pixelflux/blob/5c78910e524539a2b801433303ee61dd04f42a51/pixelflux/src/encoders/vaapi/av1.rs) 每次提交序列参数，驱动支持 packed sequence 时同时提交 Sequence Header OBU。

没有发现只在首帧提交序列参数的源码缺口，因此没有拼接缓存的旧序列头。本轮适配器检查每个实际关键帧，要求首个 frame / frame-header OBU 之前存在有效的非空序列 OBU，允许前置 Temporal Delimiter / metadata，并限制数量、长度和 LEB128。驱动输出缺头时使用 `sequence_header_missing` 处理，不能把源码提交意图当成驱动已输出的证据。

同一上游实现会尝试 `VAEntrypointEncSliceLP` 与 `VAEntrypointEncSlice`。预检因此接受两种编码入口；只有 VLD、vainfo 失败或超时均不能通过。[libva 入口定义](https://intel.github.io/libva/group__api__core.html)区分了解码和两类编码入口。

## 统计口径

| 测量点 | 数据 | 限制 |
| --- | --- | --- |
| AV1 原生适配器 | 首关键帧耗时、编码帧 / payload 字节、关键帧间隔和请求次数、最近一秒及平均 / 峰值码率 | 统计已通过适配器检查的编码输出；不是输入到显示延迟 |
| 服务端传输 | 所有编码使用相同的帧 / 字节计数、首包时间、采样帧率、平均 / 峰值码率 | 在分发给多观看者前计数，包含应用视频头，不含 WebSocket / TLS / TCP；不证明客户端实际解码 |
| 客户端 AV1 | 首次出帧时间、解码帧数、解码 FPS、接收 payload 码率、关键帧间隔、队列当前值和峰值 | WebCodecs 模式与硬件使用状态分开；`hardwareVerified=false` 不等于软件解码 |

服务端每秒原子更新 `/run/selkies-video/diagnostics.json`，只保留当前或最近一轮会话，没有历史数组或视频载荷。目录由初始化脚本创建为 `abc:abc / 0750`，文件为 `0600`。无活动会话且停止快照成功写入后停止重复写盘；暂时写入失败会重试。AV1 日志每 30 秒摘要一次，并在结束时记录统计，不逐帧输出。

服务端峰值采用实际采样间隔，附带 `peak_bitrate_window_seconds`，不能把因调度延迟形成的较长窗口硬说成精确一秒。AV1 原生和客户端各自的一秒窗口属于不同测量点，不应混用。

统计读取、计数和写盘故障独立处理，不能中断视频发送或原生捕获清理；旧实例的异步结果不会写入新会话。能力探测期间关闭服务，也不会在探测返回后重新创建后台任务。

旧 pixelflux 1.6.2 的 [ScreenCapture API](https://github.com/selkies-project/pixelflux/blob/1.6.2/pixelflux/__init__.py) 没有实际编码器 / hardware 状态读取接口，因此 H.264 的 `hardware` 保持 `null`。关闭 CPU 开关只能说明请求，H.264 硬编基线仍需结合真实 GPU 编码活动或可核实的日志证据。

## 验证与部署边界

本轮定向验证命令：

```bash
python -m unittest tests.test_av1_capture tests.test_av1_observability tests.test_video_diagnostics tests.test_av1_validation_tools tests.test_hevc_capture tests.test_stream_queue_behavior tests.test_stream_freeze_regressions tests.test_sleep_preferences tests.test_amd_gpu_config tests.test_ws_stats_lifecycle tests.test_input_queue_decoupling
node tests/test_av1_client.js
node tests/test_video_preferences_client.js
node tests/test_toolbox_layout.js
node tests/test_sidebar_scroll_render.js
node tests/test_ime_reconnect.js
node tests/test_ime_recovery_copy.js
node tests/test_preferences_client.js
node tests/test_runtime_polling_bounds.js
git diff --check
```

上述定向回归共通过 104 项 Python 测试和 8 个 JavaScript 测试脚本。服务端小写原因码修正后再次通过 AV1 和视频偏好两个前端脚本；语法及差异格式检查也通过。

原生接口、码流、状态机、权限、故障注入和配置一致性测试与真实 GPU 测试分别记录。实际执行当前环境的预检，结果为退出码 `2`、`SELECTED_NODE_MISSING`、可见节点数 `0`。这只能说明当前环境不具备目标设备，不能据此判断 NAS 上的 780M 不支持 AV1。

源码和示例版本更新到 `1.91`。镜像构建、NAS 的 Mesa / VA-API、设备访问、Tk 图形展示、780M 编码和 Windows 客户端硬解仍待目标机器验收。完整操作命令、65 秒对照脚本及镜像回滚见 [AV1 实机验收](av1-validation.md)。现有镜像发布工作流由 tag 或手动触发，分支推送不代表镜像已发布或 NAS 已部署。

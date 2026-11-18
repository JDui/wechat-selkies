# X11 视频反馈：实现、证据与 780M 验收

2026-11-19，AXiVer，基线 1.93。**结论：可进入隔离实机试验，不应默认启用。** 已验证软件 HEVC 能在线改变实际出帧率，但没有 EVO4PRO H255 上的延迟、清晰度、VCN 或功耗对照。用户此前观察到的 H.264 / AV1 / H.265 活跃 GPU 占用约 10% / 16% / 20% 是背景数据，不是本次基线或独立编码引擎占用。

## 实施与边界

- **侧边栏 → 动态节流 → 视频帧反馈（当前连接）**：主控可以实时选择「关闭」「仅观测」「自适应帧率」。无需刷新、重启容器或重建采集；控件显示服务端确认的模式。退出自适应时先恢复用户目标帧率；恢复失败不假报已关闭。观看者和不支持该协议的旧服务端不能切换。
- `SELKIES_FRAME_FEEDBACK` 是新连接的默认值，而非强制锁。`false`（默认）只发送一次模式通知，不产生周期反馈、额外原生统计或热调；`observe` 仅观测；`true` 在支持的私有 X11 HEVC/AV1 会话开放热调。常规流式 H.264 最高仅观测；JPEG、条带模式和 Wayland 沿用原路径。只有单活动显示器且没有其他低延迟策略接管时才会自动限帧。界面选择随当前连接保留，换主控或重连后按服务端默认值重新开始；不修改 Compose 或浏览器存储。
- 接收 ACK 保持原语义；新报告另列进入视频处理的帧、有效 WebCodecs 输出、成功 `drawImage` 的帧 ID，以及两段积压、解码队列和接收到绘制耗时。Canvas 提交不等于屏幕已扫描显示。排障时先看服务端待 ACK / RTT / 发送队列，再看客户端两段进度；只凭反馈变旧不能断言丢包或冻结。
- 复用客户端 250 ms 健康检查和服务端原背压任务；有活动才发，最多 4 条/秒，不按帧发 WS 消息。固定字段、长度和取值上限，只接受当前主控的 socket、显示器、采集会话和协商代次。旧 decoder 的票据不会推进新窗口。页面隐藏、暂停或事件循环长暂停重置采样；静止不触发恢复。红紫状态点不变，不记录文本或像素。
- 仅连续报告 ≥0.75 秒的解码/绘制或发送积压才降低未来的采集帧率；步幅约 20%，下限约用户目标的一半，低目标不被反向调高。连续健康 ≥3 秒逐级恢复，两次常规调节至少隔 2 秒。超过 2 秒无反馈恢复用户目标，不把静止当故障。RTT 用于诊断及既有背压，不单独触发降帧。既有低延迟策略优先；休眠不写原生参数，不改变主控所选编码器。
- 没有新服务、监听端口、视频包类型、持久化设置或像素扫描器。原 PIN、登录卷、剪贴板、文件传输与输入顺序未作为优化对象。保留工作区其他未提交的 IME 修改，不能把那些改动算成此次视频优化。

### Pixelflux 审计

依据：1.93 镜像实际 Python 扩展、项目的 Dockerfile/捕获适配器，以及 selkies-project/pixelflux **2.2.3** 的 `pixelflux/src/lib.rs`、`x11/mod.rs`、`pipeline.rs` 和编码后端。两套原生模块不可混用。下表的“有”是运行版本暴露绑定，不代表驱动已经执行命令。

| 原生方法 | 公共 H.264 1.6.2 | 私有 HEVC/AV1 2.2.3 | 本次使用与限制 |
|---|---|---|---|
| `update_framerate` | 有 | 有 | 只热写私有模块；X11 改采集节奏，VA-API 实现也可能重新打开编码上下文，不能承诺无关键帧或无瞬时停顿。 |
| `update_video_bitrate` | 有 | 有 | 私有路径当前为质量模式，默认不是 CBR。没有启用可验证的目标码率模式，不把改数值当成有效控码。 |
| `update_tunables` | 无 | 有 | 传当前采集配置，仅改质量、补绘质量/帧数/开关；不热改编码格式、色度、RC 模式或设备。驱动实际画质需实测。 |
| `update_link_rate` | 无 | 有 | 表示链路容量，供相应码控下静态清理使用；采样视频吞吐并非可用容量，不据此写入。 |
| `stream_stats` | 无 | 有 | 读取累计帧、字节、编码及采集到编码完成耗时；窗口峰值读取会清零，沿用一个诊断读取者。无计时证据返回空，而非 0 ms。 |
| `request_idr_frame` | 有 | 有 | 保留既有入会、恢复和无限 GOP 重同步，不用它追赶每次短时积压。 |
| `invalidate_reference` | 无 | 有 | 不调用。未证实 780M、驱动、实际编码参数对相应参考槽的行为。 |
| `acknowledge_reference` | 无 | 有 | 不调用。接收或主控绘制不证明所有观看者持有同一参考图。 |

原生热写是向运行中的采集循环交付控制量，并非同步的 VA-API 生效回执。Python 用原重配置锁串行化写入、在工作线程调用原生方法。协程取消会等待已启动的写入结束，再释放锁。自动调节异常：尝试恢复用户 FPS，本会话停用自动调节，不重启；主控明确修改不支持的参数才走原受保护重建。原生后台若仅记录错误、没有抛异常，需通过帧数、关键帧和画面确认，不能从“请求值”推断成功。

### 内容调度与 P2 决策

2.2.3 的 X11 路径从 XDamage/XFixes 收集并裁剪 damage；全帧编码的 `decide_hw_fullframe` 和 `paint_over_improves` 已按运动、质量余量与静止时长决定是否发帧、是否补绘。小范围变化不是要传输的独立位图，整帧预测链保持完整。保留现有 Turbo/按需语义：连续推流并不保证静止时零帧，缺少扩展也不能假定 damage 可用。

输入、滚动和视频引起的画面变化继续走正常视频路径；没有另设必须先完成的补绘队列。静止文字/图片可沿用既有有界补绘，微小变化不等于需要反复全屏刷新。**不承诺按键能撤销已提交的 GPU 编码，也不把 8-bit 4:2:0 补绘称作无损或 4:4:4。** 未引入文字识别、AI 分类或按 GPU 百分比换 codec。

| 方案 | 结论与证据门槛 |
|---|---|
| Dirty Rect | 原生已用变化区指导编码；先量化静态/滚动差异。没有理由在 Python 复制全屏像素再次找变化区。 |
| CopyRect / SurfaceToSurface | Canvas 复制不会修改 WebCodecs 内部参考帧，但也不能替代预测链里的一帧。合成表面可能和服务端不一致；部分遮挡、惯性滚动、DPI 和缩放都要处理。没有滚动净收益数据，不上线。 |
| 无损小块 / Bitmap Cache | 如彩色小字确有残留，先在合成文字场景离线比较。若实施需独立覆盖层、会话/代次/基帧/坐标约束、内存预算和淘汰；新帧、重连、缩放及分辨率变化须清除旧块并恢复完整画面。没有证据支持维护第二套协议。 |

## 验证结果

| 证据 | 基线 | 候选版 | 能证明什么 |
|---|---|---|---|
| 同一 1.93 Docker 运行环境，针对性 Python 测试 | 63 通过 | 69 通过 | 基线业务源取自未修改 HEAD；双方共用确定性背压任务步进，避免用几毫秒睡眠猜任务是否已运行。新增用例覆盖短突发、持续积压/恢复、过期、角色/显示器/代次边界、WS 缺少缓冲统计、取消和原生拒绝、热调与结构性重建。 |
| 浏览器逻辑（Node 模拟） | stream-health 22 组 | 23 组；另通过 AV1、解码恢复、WS/DOM 运行时及 26 项 IME partial-commit 检查 | 覆盖有界队列、迟到回调、实际调用绘制、重新连接、事件循环停顿、角色与暂停。不是 Chromium / WebView2 实机运行。 |
| 实际原生编码，隔离 Docker + Xvfb 320×240、软件 HEVC | 三个 2 秒窗 48 / 48 / 48 帧 | 同样三个窗 48 / 24 / 48 帧 | 同一 2.2.3、同一合成变化源；B 请求 24→12→24 FPS，同时 CRF 请求 24→26→24，各窗前留 0.35 秒稳定。会话未重建，实际出帧率服从热写。不是自适应净收益实验，也不能证明 CRF 画质、GPU 或能耗。 |
| 真实 Edge 157.0.4341.60 无头 WebCodecs + Canvas，仓库 AV1 码流 | 生产硬件偏好拒绝该序列；显式软件偏好绘制 3 个连续帧和 1 个静态帧 | 同一硬件偏好同样拒绝；软件偏好同样绘制 4 帧，合并反馈累计接收/解码/绘制均为 4 | 使用真实浏览器 decoder 和 Canvas，反馈接收端是测试替身；不证明 WebView2、GPU 硬解或端到端 WS 性能。软件偏好只在测试进程覆写。 |
| EVO4PRO / 780M、真实交互客户端和 Windows WebView2 | 未在本轮测量 | 未在本轮测量 | 无目标机 P50/P95、画质、功耗或冻结率结论；未改线上容器。 |

### 在目标 NAS 上复现 A/B

仅在**隔离测试实例**执行；项目 Compose 有固定容器名、端口和相对 `./config`，不要从另一目录直接启动一份与生产碰撞的实例，更不要让两份容器共写登录配置。准备可丢弃且参数相同的测试配置，保留原镜像标签。需要参考设备、权限、GPU 预检时见同目录 `av1-validation.md`。

```sh
# 在隔离测试机的仓库根目录；已有 1.93 基线，不覆盖该标签
docker image inspect wechat-selkies:1.93 >/dev/null || exit 1
docker build -t wechat-selkies:qoe-candidate . || exit 1
cat > compose.qoe-bench.override.yml <<'YAML'
services:
  wechat-selkies:
    image: ${QOE_IMAGE:?choose a test image}
    environment:
      SELKIES_FRAME_FEEDBACK: ${QOE_MODE:-false}
YAML
# A；B 改为 qoe-candidate / true，诊断对照用 qoe-candidate / observe
QOE_IMAGE=wechat-selkies:1.93 QOE_MODE=false docker compose -f docker-compose.yml -f compose.qoe-bench.override.yml up -d --no-build --no-deps wechat-selkies
docker cp scripts/ops/codec-benchmark.py wechat-selkies:/tmp/codec-benchmark.py
# 浏览器已选好对应硬编、1920×1080、30 FPS；每轮更换 r1/r2/r3
codec=av1; variant=baseline; round=r1
docker exec wechat-selkies with-contenv s6-setuidgid abc /usr/bin/python3 /tmp/codec-benchmark.py --codec "$codec" --variant "$variant" --fps 30 --output "/config/logs/codec-bench/$variant-$codec-$round"
```

1. 用同一浏览器版本、同一台客户端、固定缩放和画布分辨率、GPU 节点、网络、画质、补绘、动态节流设置。三种 codec 分别用 `h264` / `h265` / `av1`，A 与 B 各至少三轮，交错顺序。每次容器切换后重复制脚本并刷新浏览器；`--variant` 仅标记结果，不配置服务端。不要同时改变 Turbo、Paint-over 或 CBR 来归因于反馈。
2. 默认每轮预热 5 秒，静态中文小字、连续滚动、图片/UI 混合各 20 秒。只在**合成窗口**截相同静态区域，保留原始像素倍率，对比同色小字、彩边和细线；`chinese_text=false` 不得用于中文验收。静态资源测试期间不要动鼠标、输入或打开监控侧栏。
3. 另跑带 `--input-marker` 的同配置轮次，聚焦合成窗口。在**持有 `window.__selkiesStreamHealth` 的控制页面/iframe** 执行 `scripts/ops/codec-client-probe.js`（DevTools Snippet），静止阶段逐次按键或点按，留约一秒间隔；用 `stopCodecProbe()` 导出，或等待 80 秒。用相同采样窗比较 A/B，报告 n、平均/P50/P95、过期/合并数；重连、后台或 `valid=false` 作废，不将超时省略为成功。该值是同一客户端时钟的可信输入事件到下一次 Canvas 绘制，非像素回读、非物理显示延迟，也不能证明动态背景的下一帧就是该次输入的结果。不要在真实聊天中运行。
4. JSON 保留每秒样本：容器 cgroup CPU 秒数与单核口径百分比，`/proc/stat` 可见主机的 busy 秒数和全核口径百分比，所见 DRM fdinfo 的各引擎占用、原生编码/采集至编码耗时、帧数、服务端扇出前视频字节与平均/峰值码率。服务端广播不是送达；客户端探针另记包和绘制。QoE 会话的 `received/decoded/drawn` 速率是成功回报样本，缓冲拥塞可能少报。解码队列看 `decode_queue`，ACK/写缓冲看 `pending_acks`/`write_buffer_bytes`；没有数据记 `null`。旧版无原生耗时/阶段反馈时不要补零，另以 `observe` 作同仪器对照。GPU 总利用率不可冒充 VCN；整机功耗需外部功率计或可信整机遥测。
5. 异常测试与正常轮次分开：在测试客户端短时施加网络限速/延迟及 CPU 降速，解除后记录恢复到正常积压/帧率所需时间；断开重连、丢关键帧场景看现有 decoder 重同步/IDR 和恢复日志。再分别测无限 GOP、三 codec 循环切换、主控与只读观看、标签页切换、长静止、普通/深度休眠、分屏和分辨率变化。对照同长窗口的停顿/丢弃**事件**、关键帧请求及捕获会话 ID 变化；关键帧总数不是重建或丢包次数。WebSocket 上无法从帧号缺口确证 IP 丢包。
6. 在 Windows WebView2 和桌面浏览器分别验登录保持、PIN 接管、中文组合输入、图片/文本剪贴板、拖拽与文件上下行、通知/快捷栏、手动和自动恢复。若出现新冻结或输入异常即停止试验。回滚时用上面的 A 镜像和 `false` 重建**同一测试服务**并刷新页面；不执行 `down -v`，不改 PIN 或挂载。

### 风险与下一步

浏览器对照可用 `node tests/frame_feedback_av1_browser_probe.js`（保持生产偏好）和 `node tests/frame_feedback_av1_browser_probe.js --software`（仅诊断）复现；需要已安装的 Edge 与 Playwright，`CODEX_NODE_MODULES` 可指定依赖目录。用 `QOE_PROBE_ROOT` 指向未修改基线源码可复跑同一夹具。硬件偏好失败不能用软件通过替代。

| 风险 | 约束 / 未决事项 |
|---|---|
| 帧序、参考图、恢复竞争 | 不删预测帧、不写参考反馈、不新增恢复任务；原有 IDR、溢出保护和重配置锁继续负责。须实测 VA-API 重新打开编码器与无限 GOP 的组合。 |
| 原生调参导致花屏或频繁关键帧 | 迟滞、限幅、观察模式；软件实验证实 FPS，未证明 VA-API 生效或 CRF 净收益。 |
| PIN 与共享隔离 | 所有反馈检查当前主控身份与显示器；共享观看者不能改全局 FPS。真实接管/多屏与登录状态仍需冒烟。 |
| 后台开销、浏览器 | 活跃窗口才发控制包，无新增常驻定时器；解码票据依附原有有界队列。未做全天 RSS/CPU/GPU 或 WebView2 挂机测试。 |
| 配置和回滚 | 默认关闭，旧客户端无需升级即可走原路径；未改数据卷。新前端使用版本化资源 URL，A/B 切换后刷新。 |

优先顺序：**第一**，先测 780M 三轮对照和 WebView2 真实延迟（成本低，决定是否值得开放限帧）；**第二**，仅当静态中文截图仍差时，单独比较相同 FPS 下的 Paint-over 质量/带宽成本（中等）；**第三**，只有已验证码控模式确有带宽瓶颈时，才试热码率与恢复。无实测净收益前，不开启默认策略，不开发 CopyRect/缓存协议。

### 变更导航

- `selkies/frame_feedback.py`：协议校验、控制器隔离、迟滞与可取消的热写；`selkies/selkies.py`：协商、原任务集成、诊断与 SETTINGS 回退。
- `selkies/hevc_capture.py`、`selkies/av1_capture.py`：共用私有原生热调薄封装；`docker-compose.yml`：唯一新增配置开关。
- Dashboard `src/selkies-stream-health.js`、`src/selkies-runtime-overrides.js`、`src/selkies-av1.js`、`assets/index-CzFxBFXa.js`、`index.html`：生命周期、帧追踪、绘制完成回报与资源版本。
- `scripts/ops/codec-benchmark.py`、`scripts/ops/codec-client-probe.js`：同负载 A/B、可选输入标记及客户端测量；`tests/test_frame_feedback.py`、`test_stream_health_client.js`、`test_stream_backpressure_progress.py`、`test_av1_capture.py`、`test_av1_validation_tools.py`：新增覆盖与现有夹具适配。

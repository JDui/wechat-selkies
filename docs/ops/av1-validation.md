# AV1 实机预检、固定对照与回滚

本流程用于实际部署机器，日期为 2026-11-18。当前开发环境没有 Docker、`/dev/dri` 或 Windows WebView2；新增工具的解析与核算测试通过，以下硬件与图形操作尚未在目标机器执行。

## 1. 保留当前镜像和配置

在 NAS 的现有 Compose 目录操作。以下步骤只给正在运行的镜像增加一个本地回滚标签，不改容器参数或 `/config`：

```bash
previous_image_id="$(docker inspect --format '{{.Image}}' wechat-selkies)"
docker image tag "$previous_image_id" wechat-selkies:rollback-before-av1-review
docker image inspect wechat-selkies:rollback-before-av1-review --format '{{.Id}} {{index .Config.Labels "org.opencontainers.image.version"}}'
```

如果当前运行的是 1.90，该标签保留的就是该镜像；以镜像 ID 和版本标签输出为准，不能只根据本地标签名称推断内容。原有 `wechat-selkies:1.90` 标签也可以保留。不要执行 image prune 清理这一回滚镜像。

保留现有 Compose 的网络、端口、密码、设备、用户和卷设置。对照测试使用该配置构建的镜像和同一个实际运行容器，不另造一个参数不同的测试容器。检查当前 Compose 显式设置的 `SELKIES_ENCODER` 是否包含 `x264enc,h265enc,av1enc`；显式环境变量会覆盖镜像默认值。

## 2. 在镜像内以桌面用户核验 GPU

部署包含诊断脚本的镜像后执行：

```bash
docker exec wechat-selkies with-contenv python3 /scripts/av1-host-diagnostics.py > av1-preflight.json
diagnostic_exit_code=$?
printf 'diagnostic_exit_code=%s\n' "$diagnostic_exit_code"
```

脚本读取服务启动时实际选定的节点，列出容器内所有 `renderD*`。默认以 `abc` 桌面服务用户的实际 UID、GID 和附加组检查设备，root 执行诊断时会通过 `s6-setuidgid abc` 降权后打开节点并运行 `vainfo`。不会用 root 成功访问的结果替代桌面用户权限检查。

输出包括：

- 选定节点、各设备属主 / 组 / 模式和实际执行身份。
- `O_RDWR` 打开设备的结果与 errno；不执行写入或编码操作。
- Mesa VA 驱动、libva、vainfo 的包版本，以及固定私有 / 原有 pixelflux 包版本。
- `vainfo --display drm --device ...` 的 profile 与 entrypoint 列表、原始 stdout / stderr、退出码和超时状态。
- `preflight_passed` 与稳定原因码，另保留 `live_encoding_verified: false`。

| 结果 | 后续动作 |
| --- | --- |
| `SELECTED_NODE_MISSING` | 检查设备映射及 AMD 初始化结果，先确认服务实际选择了哪个节点 |
| `DEVICE_OPEN_FAILED` | 根据 errno、设备组和 abc 的附加组修复权限；不要以直接改成 root 运行桌面代替排查 |
| `VAINFO_TIMEOUT` / `VAINFO_FAILED` | 检查驱动加载、libva / Mesa 配套及原始错误输出 |
| 只有 `VAProfileAV1Profile0 : VAEntrypointVLD` | 仅证明解码入口，停止 AV1 硬编测试，先修复驱动或镜像能力 |
| `VAEntrypointEncSlice` 或 `VAEntrypointEncSliceLP` | 具有 AV1 编码入口，进入 pixelflux 和实际流初始化验证 |
| `CAPABILITY_AVAILABLE`、退出码 0 | VA-API / 权限预检通过，仍需确认实际流 `codec=av1`、`hardware=true` |

**`EncSliceLP` 也属于编码入口。** libva 分别定义普通和低功耗编码入口；本项目固定 pixelflux 的 VA-API 选择会考虑两种入口，不能把只有 `EncSliceLP` 的设备判成解码专用。[1][2]

默认不选择一个“看起来更好”的其他 GPU。仅用于排查指定节点时，可以显式运行 `--node /dev/dri/renderD129`；输出会标记 `explicit_node_override: true`，它不证明主服务也使用这个节点。

## 3. 为同一套操作设置对照条件

先完成 H.264，再完成 HEVC、AV1。每个编码建议跑三轮，保持以下条件相同并记入结果说明：

| 条件 | 建议基线 |
| --- | --- |
| 分辨率 | 先 1920×1080，再单独覆盖 2560×1440、1366×768 |
| 帧率上限 | 30 FPS；高帧率另开一组 |
| 客户端 | 同一台电脑、同一 WebView2 / 浏览器、窗口前台可见、相同缩放 |
| 内容 | 下方脚本固定三段：静态小字、聊天式滚动、纹理图片与滚动混合 |
| 节流与休眠 | 本轮临时关闭动态节流、自动静息 / 深度休眠，测试后恢复原设置 |
| CPU 编码 | 主控界面关闭 CPU 编码，核查真实硬件证据；只看开关不算验证 |
| 画质设置 | 记录每种编码的 CRF / QP、补绘、全色彩等值；同一个 CRF 数字不代表相同画质 |
| 背景负载 | 避免下载、媒体转码、额外远程观看者和其他 GPU 测试同时运行 |

脚本会展示一个独立的全屏 Tk 测试窗口并在结束时关闭，不向微信 / QQ 注入按键、滚轮或消息，也不修改编码器和分辨率。按 Escape 可提前结束，结果会标记未完成。窗口暂时取得焦点，运行期间不要在远端输入个人消息。

测试图使用固定程序纹理，不读取个人照片或网络图片。字体优先选择容器里的 Noto CJK；找不到中文字体时自动改用英文并在结果里记录，避免口口口影响观察。不同编码必须使用同一字体结果。

## 4. 运行固定工作负载并采样

`python3-tk` 已包含在项目 Dockerfile 中。使用系统 `/usr/bin/python3` 执行图形脚本，而不是不一定安装 Tk 的私有 `/lsiopy` Python。

在仓库根目录将唯一脚本复制进当前容器：

```bash
docker cp scripts/ops/codec-benchmark.py wechat-selkies:/tmp/codec-benchmark.py
```

先在现有远程客户端中选择 **H.264 / GPU、1920×1080、30 FPS**，等待画面稳定，再执行：

```bash
docker exec wechat-selkies with-contenv s6-setuidgid abc /usr/bin/python3 /tmp/codec-benchmark.py --codec h264 --width 1920 --height 1080 --fps 30 --output /config/logs/codec-bench/h264-1080p30-r1
```

完成后在同一客户端切换 HEVC、等待稳定，执行：

```bash
docker exec wechat-selkies with-contenv s6-setuidgid abc /usr/bin/python3 /tmp/codec-benchmark.py --codec h265 --width 1920 --height 1080 --fps 30 --output /config/logs/codec-bench/hevc-1080p30-r1
```

AV1 预检通过后，在同一客户端切换 AV1、等待稳定，执行：

```bash
docker exec wechat-selkies with-contenv s6-setuidgid abc /usr/bin/python3 /tmp/codec-benchmark.py --codec av1 --width 1920 --height 1080 --fps 30 --output /config/logs/codec-bench/av1-1080p30-r1
```

每轮是 5 秒预热和三个各 20 秒阶段，总计约 65 秒。重复时将输出末尾改为 `r2`、`r3`，避免覆盖结果。测试不读取命令行中的 `--codec` 就认定实际编码：它读取 `/run/selkies-video/diagnostics.json`，核验实际 codec、请求编码、分辨率、目标帧率、三秒以内的新鲜快照及未变化的会话 ID。配置不符时在创建测试窗口前退出；中途回退、重启或停止会使结果无效。

如果 X11 连接失败，检查服务现有的 DISPLAY / Xauthority 设置；不要更改 X11 访问控制来强行通过。脚本不会自行开启显示服务、改变分辨率或重新登录。

每轮生成同名 `.json` 与 `.csv`，可在 NAS 的 `/config/logs/codec-bench` 对应卷目录取回，或执行：

```bash
docker cp wechat-selkies:/config/logs/codec-bench ./codec-bench-results
```

### 指标如何解释

- `valid_run`：该次固定工作负载完整、实际 codec / 尺寸 / FPS / 会话均符合条件；不是画质或硬编认证。
- `hardware_evidence`：`verified` / `software` / `unknown`。旧 H.264 运行库若没有可核实的实际硬件状态，保留 `unknown`；仍记录 CPU / 码率，但 `hardware_comparison_ready=false`。
- `cpu_one_core_percent`：整个容器的 CPU 时间增量，100% 表示一个逻辑核心满载。包含采集、编码、测试窗口和容器其他进程，不能叫作“编码器 CPU”。
- `wire_video`：服务实际发送的视频包计数和字节增量，包含视频包头，不含音频、输入、TCP / TLS 开销。三个编码采用同一计数来源。
- `gpu_engine_percent`：从容器可读的 DRM fdinfo 计算按设备 / 引擎的活动，重复 FD 按 DRM client ID 去重，并处理引擎容量。未导出该指标或无权限读取时是 `null`；不会用 GPU 渲染百分比替代编码百分比。[3]
- `framesDecoded` 和客户端解码队列：通过同一远端 WebView 的 `window.selkiesAv1.diagnostics()` 另行记录。这份容器端采样不假装取得了 Windows 客户端 GPU / CPU 数据。

平均与峰值 CPU、线上的平均 / 峰值码率应与 JSON 中相同阶段的样本一起分析。静态阶段可能只发送少量帧，这是按需采集行为；目标上限 30 FPS 不意味着静态页面每秒必须编码 30 张相同图片。

`metadata.draw_updates_by_phase` 记录滚动和混合阶段实际提交的画面更新次数。系统过载可能拖慢测试窗口；三种编码间该数值明显不同时，需先排除负载差异或降低目标帧率，不能假定已经显示了完全相同数量的画面。

## 5. 固定录屏与画质比对流程

性能轮先关闭录屏，以免额外编码器占用影响 CPU / GPU 指标。画质轮另跑完全相同的脚本：

1. 同一个客户端保持原始显示分辨率、相同窗口大小和系统缩放。在客户端使用同一录屏工具、同一画布、帧率和质量设置，只捕获远端桌面区域。
2. 在运行工作负载前开始录屏；保留 5 秒 Warmup 画面作为同步标记。依次截取后续三个各 20 秒阶段。
3. 每次只切换推流编码及明确记录的质量参数；文件按 `h264-1080p30-r1`、`hevc-1080p30-r1`、`av1-1080p30-r1` 命名，并记录录屏工具版本与参数。
4. 对比静态阶段中的 9～12 号小字和细线，滚动阶段中的字形与残影，以及混合阶段的彩色纹理。先比较同码率画面，再调整各编码的质量参数比较相近画质下的带宽。

录屏本身会再编码，不能单凭它判断细节完全相同。静态质量核查同时保留同一客户端、同一阶段的原始截图；录屏轮 CPU / GPU 数据单独标记，不能混入无录屏性能基线。当前版本不自动启动录屏器或安装额外依赖。

## 6. 回滚

可连接时先把编码选回 H.264，让偏好保存完成。随后在现有 Compose 目录新建 `compose.rollback-av1.yml`，只覆盖需要回滚的桌面服务镜像：

```yaml
services:
  wechat-selkies:
    image: wechat-selkies:rollback-before-av1-review
```

保留原 Compose 为第一份配置，执行：

```bash
docker compose -f docker-compose.yml -f compose.rollback-av1.yml up -d --no-build --pull never --no-deps wechat-selkies
```

命令重建桌面服务，复用原有端口、环境、网络和卷；不删除 `/config`，不执行 `down -v`，也不启动其他测试服务。若原 Compose 文件名或服务名不同，应使用实际名称。镜像回滚不撤销 `/config` 内应用自身的数据变更；本轮新增能力诊断和采样不迁移账户数据。

## 开发环境已验证范围

```bash
python -m unittest tests.test_av1_validation_tools
python root/scripts/av1-host-diagnostics.py --help
python scripts/ops/codec-benchmark.py --help
```

11 项定向测试覆盖编码 / 解码入口区别、`EncSliceLP`、失败及超时的部分输出、设备权限拒绝、真实执行身份校验、过期会话、实际 codec / 会话不符、DRM 单位与重复计数规则、计数器回退、固定阶段时间线、无视频进展拒绝及缺失指标保留。目标机器上的 vainfo、Tk 图形窗口、硬编流与 Windows 硬解尚未实测。

## 依据

1. [libva VAEntrypoint 定义](https://github.com/intel/libva/blob/master/va/va.h)。
2. [固定 pixelflux 2.2.3 VA-API 编码实现](https://github.com/selkies-project/pixelflux/tree/2.2.3/pixelflux/src/encoders/vaapi)。
3. [Linux DRM client usage stats](https://docs.kernel.org/gpu/drm-usage-stats.html)：DRM client ID 去重、引擎时间单位、引擎容量和计数器短暂回退处理。

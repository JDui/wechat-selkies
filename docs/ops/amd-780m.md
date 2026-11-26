# AMD H255 / Radeon 780M

2026-11-17：切换前工作区已提交并推送，`_intel` 保存完整 Intel 基线。新改动继续在 `AXiVer`；镜像标签为 `wechat-selkies:1.85`，与 Intel 1.84 区分。780M 真机编码与部署尚待验收。

## 本次适配

- 复用全帧 H.264 VA-API 路径，界面协议名称仍为 `x264enc`。关闭 CPU 编码且设备可用时调用硬件，CPU 编码也统一走全帧 H.264，不再提供分片 / JPEG 编码模式。
- amd64 镜像安装 Ubuntu Mesa 的 `mesa-va-drivers`、`libdrm-amdgpu1` 和 `vainfo`，使用 `radeonsi`。删除复用 Intel 镜像时遗留的 Intel APT 源和 pin，不再安装 Intel 专用媒体驱动。已有驱动包不强制卸载或降级。
- `configure-amd-gpu.py` 按 sysfs 厂商 ID `0x1002` 筛选字符设备，不假定 AMD 位于 `renderD128`。自动模式逐个探测 AMD 节点，显式路径只检测指定节点。
- 在基础镜像 `init-video` 配置权限之后，以实际桌面用户 `abc` 探测 H.264 普通 `EncSlice`，每个节点超时 8 秒。驱动固定为 `radeonsi`，不受旧 `INTEL_VAAPI_DRIVER=iHD` 或 `LIBVA_DRIVER_NAME=iHD` 干扰。
- 探测失败清空 `DRI_NODE`，锁定 `SELKIES_USE_CPU=true|locked` 并启用前端 CPU 默认值。诊断写入 `/run/selkies-amd-gpu.json`，可由 `/scripts/cpu-diagnostics.sh` 查看。
- 保留 s6 服务名 `init-intel-gpu`，实际调用已改为 AMD 脚本。这让复用旧镜像应用层时仍只有一个初始化入口，保持既有依赖顺序。

本次不改变帧率、量化参数或空闲节流策略，避免在缺少新 NAS 实测时同时改变画质和带宽基线。能力探测成功只说明驱动宣称支持编码，不能代替真实出帧验收。

## 构建与迁移

NAS 内核须能驱动 780M（`amdgpu` 与对应固件），并暴露 `/dev/dri/renderD*`。容器只能安装用户态 Mesa，不能补足宿主机内核或固件支持。

保留原配置卷、PIN 和端口，使用当前 Compose：

```bash
docker compose build
docker compose up -d
```

如果本机已保留同架构的项目 1.84 镜像，可复用其微信 / QQ 安装层：

```bash
docker compose build --build-arg RUNTIME_BASE=wechat-selkies:1.84
docker compose up -d
```

复用构建仍需安装 Mesa、构建上传组件并覆盖当前源码，不能把旧镜像直接改名视为完成适配。无 GPU 的主机需先移除 Compose 的 `/dev/dri` 映射，否则 Docker 会在容器启动前拒绝创建。ARM64 维持 CPU 兼容路径，不属于本次 780M 目标。

迁移的关键配置：

```yaml
devices:
  - /dev/dri:/dev/dri
environment:
  - DRI_NODE=auto
  - SELKIES_DEFAULT_ENCODER=x264enc
  - SELKIES_DEFAULT_USE_CPU=false
```

移除旧的 `INTEL_VAAPI_DRIVER` / `LIBVA_DRIVER_NAME=iHD` 配置；即使保留，AMD 探测和成功后的服务环境也会使用 `radeonsi`。如果旧配置显式强制 `SELKIES_USE_CPU=true|locked`，需移除它才能启用硬件。浏览器原有 CPU 编码偏好也应关闭。

## 最小真机验收

在 NAS 宿主机执行（若已进入容器终端，直接运行 `cat` / `s6-setuidgid`）：

```bash
docker exec wechat-selkies cat /run/selkies-amd-gpu.json
docker exec wechat-selkies s6-setuidgid abc env LIBVA_DRIVER_NAME=radeonsi vainfo --display drm --device /dev/dri/renderD128
docker logs wechat-selkies 2>&1 | grep -E 'amd-gpu|Mode: H264|VAAPI'
```

将示例 `renderD128` 换成状态文件实际选择的节点。期望看到 `backend: amd-vaapi`、`driver: radeonsi`；连接浏览器、选择全帧 H.264 并关闭 CPU 编码后，应有正常画面和 `Mode: H264 (VAAPI) FullFrame` 日志，再确认一次休眠唤醒。

AMD 初始化阶段已完成 8 项设备选择 / 探测 / 回退定向测试。后续已构建 H.265 开发镜像并在本地无 GPU 容器完成浏览器联调；780M 实际硬编、NAS 部署和功耗仍未验收。

## H.265 前后端支持

2026-11-17：`AXiVer` 已加入可选 `h265enc`，默认仍为 H.264。复用上游 [pixelflux 2.2.3](https://github.com/selkies-project/pixelflux/tree/2.2.3)，通过升级基础 Pixelflux 安装包提供 H.264、H.265 和 AV1 共用的 2.2.3 API；不再安装第二份私有 wheel，也不保留旧 H.264 ABI。无需新增独立 FFmpeg 推流进程。

- 后端提供 X11 全帧 HEVC Main、8-bit、4:2:0；继续使用原有视频队列、ACK、背压、空闲节流与恢复逻辑。HEVC Annex-B 帧使用独立类型 5，与 H.264 类型 4 区分。
- 浏览器先用 WebCodecs 探测 HEVC，再根据首个关键帧 SPS 的真实 profile / level 配置解码器。不按浏览器名称猜测能力。
- 关闭“CPU 编码”时检查所选渲染节点的 HEVC 编码能力，并验证实际首帧后的编码器状态；硬编失败回退 H.264。仅在明确选中 CPU 编码时允许软件 H.265。无 GPU 环境原有 CPU 锁定策略仍生效。
- 浏览器不支持或解码失败时，在页面内切回 H.264，提示原因类别并保留其他画质设置，不触发重新登录。
- 共享观看复用主控码流，不为每个观看者单独转码；不支持 HEVC 的观看者会提示主控切换 H.264，不改写主控偏好。
- H.265 下禁用“全彩 4:4:4”，H.264 的全彩偏好仍保留。当前不提供 HEVC 10-bit、4:4:4 或 Wayland 支持。

视频面板的编码器、帧率、视频 CRF、静态区域 CRF、静态区域优化开关、Turbo、全彩和 CPU 编码均保存到 `/config/state/ui-preferences.json`，浏览器同时保留路径稳定的缓存；主屏和副屏分别保存。加载服务器偏好完成后再初始化面板和码流，换浏览器或登录参数也能恢复。服务器锁定值和支持范围仍优先。移除了旧代码定时强制关闭静态区域优化的行为，并合并连续快速操作产生的设置更新，避免防抖丢失前一项修改。

构建示例（开发标签，不代表发布或已部署）：

```bash
docker build --build-arg RUNTIME_BASE=wechat-selkies:1.85 -t wechat-selkies:hevc-dev .
```

如访问 PyPI 困难，可添加 `--build-arg HEVC_PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple`。在 NAS 选择 `h265enc`、关闭 CPU 编码，并检查容器日志中的实际编码器状态及浏览器画面；如果回退，先查看该节点是否提供 HEVC Main 编码能力。

本地已验证：真实软件 H.265 出帧 → WebSocket → Chrome WebCodecs 解码；45 FPS / CRF 24 / 静态优化开启 / Turbo 关闭在刷新并重新登录后恢复；不支持 HEVC 的客户端回退 H.264 且不丢设置。另有持久化重启、参数校验、协商字段解析、GPU 缺少编码器与队列顺序的定向测试。没有用无 GPU 容器的结果替代 780M 硬编验收。

## 画质、带宽和性能

收益判断：

| 关注项 | 判断 |
| --- | --- |
| 相同画质的带宽 | H.265 通常更有优势，尤其是动态图像和较高分辨率；不能把通用压缩比承诺为微信桌面的实测结果。 |
| 相同码率的画质 | 有改善空间；实际取决于硬件编码器、码率控制与延迟约束。不能直接比较 H.264 / H.265 的同一个 CRF 数值。 |
| CPU / GPU 占用和功耗 | 两者均硬编时不保证 H.265 更低；客户端也应硬解。软件回退可能增加负载，必须实测。 |
| 文字清晰度 | 还取决于色度采样、量化和缩放。H.265 Main 仍为 4:2:0，换编码格式不会自动获得 4:4:4 彩色文字精度。 |
| 静止聊天页面 | 已有空闲节流会降低基线流量；预计切换编码的收益更依赖滚动、图片或视频场景，需用同内容比较。 |
| 浏览器兼容性 | 不能只看能否播放 HEVC 视频文件。当前 WebCodecs 路径需探测实际 profile / 分辨率配置，再验证首帧、连续解码与重连；失败返回 H.264。 |

[MDN 编码说明](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Formats/Video_codecs#hevc_h.265) 说明了 HEVC 的压缩优势及 Main profile 色度限制。[W3C HEVC WebCodecs 注册](https://www.w3.org/TR/webcodecs-hevc-codec-registration/) 明确不要求浏览器实现 HEVC；应使用 `VideoDecoder.isConfigSupported()` 并实际解码，不能按浏览器名字硬编码支持。

当前保留 H.264 默认值。下一步在 780M 上用同一组聊天滚动 / 图片场景比较带宽、文字质量、端到端延迟和两端负载，再决定是否改默认值。

# 1.89 小工具分组与 780M 编码评估

日期：2026-11-18（Asia/Shanghai）。基线：`AXiVer` / `83b652ec2518c8eb9a07e66bc275dcba07d60b74`（1.88）。

## 小工具布局

原“妙妙小工具”的构造代码含 17 个交互控件，其中历史微信提示音测试会被既有清理脚本移除。此次保留现有可用功能，按用途收纳为四个原生 `details` 分组，沿用原有选择器和事件处理：

| 分组 | 默认状态 | 内容 |
| --- | --- | --- |
| 界面与操作 | 展开 | 自动分屏、网速与往返延迟、底部栏剪板按钮、快捷 Bar 位置 |
| 通知 | 收起 | 穿透式消息推送、通知侧边栏、QQ 失焦时间 |
| 休眠与连接 | 收起 | 自适应休眠、待机时间、进入休眠、局域网广播、广播名 |
| 输入与维护 | 收起 | 复制未发送文字、输入采样增幅、旧版上传回退、推送测试 |

各组可以同时展开，使用既有存储辅助函数保存当前浏览器的展开状态；这不是同步到所有访问端的共享偏好。六秒周期更新复用原 DOM，不重新生成分组，也不覆盖正在编辑的广播名。动态节流仍是独立卡片，沿用现有侧栏滚动保护。

“复制未发送文字”放在输入与维护组首项，折叠标题提供“复制文字 · 检测”提示。检测操作集中显示，保留完整说明和五秒触发提示；单个检测按钮占满可用宽度，兼容旧提示音测试的清理行为。原生 `summary` 纳入本地控件识别，避免输入法焦点恢复抢走分组标题焦点；工具箱容器增加上游约定的 `allow-native-input` 类，让 Enter、空格和 Tab 留给本地界面处理。

## 编码结论

**AV1 硬编码是 780M 下一步最值得适配、实测的方案。** 这是根据硬件能力和当前代码作出的工程建议，尚无本机端到端数据证明它必然比 HEVC 更省 CPU、功耗更低或延迟更短。本版只调整小工具布局，未开放 AV1、改变视频协议或编码默认值。

### 硬件支持与取舍

AMD 的 [H 255 官方规格](https://www.amd.com/zh-cn/products/processors/laptop/ryzen/200-series/amd-ryzen-7-h-255.html) 明确列出 Radeon 780M 和 8/10-bit AV1 编码能力。[AMD 媒体硬件能力表](https://github.com/GPUOpen-LibrariesAndSDKs/AMF/wiki/GPU-and-APU-HW-Features-and-Support) 则区分 VCN 的编码、解码能力，并说明所列视频路径采用 4:2:0。

| 编码 | 780M 硬件编码依据 | 在本项目中的定位 |
| --- | --- | --- |
| H.264 / AVC | 官方列出支持 | 当前默认和兼容回退；全帧硬编是否启用以实际会话为准 |
| H.265 / HEVC | 官方列出支持 | 已接入的可选编码，作为 AV1 的实测对照 |
| AV1 | 官方列出 8/10-bit 编码 | 优先适配候选，首版宜限定硬编、8-bit、4:2:0、全帧 |
| VP9 | 官方表有解码，无相应编码入口 | 不适合作为 780M 的低占用服务端编码方向 |
| VVC / H.266、AV2 | 官方表没有对应硬件编码能力 | 当前不作为该设备的低占用推流方案 |

[AV2 规范](https://av2.aomedia.org/) 已于 2026 年发布，但新标准的存在不代表 780M 可以硬件编码它。

服务端需要编码，访问端需要解码。NAS 的硬件解码格式列表不能代替服务端编码能力判断。RTX 4090 的 [官方规格](https://www.nvidia.com/en-us/geforce/graphics-cards/40-series/rtx-4090/) 列有 AV1 硬解；其他手机、平板仍需按型号和浏览器实际探测。WebKit 在 [Safari 17.5 说明](https://webkit.org/blog/15383/webkit-features-in-safari-17-5/) 中明确，AV1 WebCodecs 支持要求可用的硬件解码器，不能笼统保证所有 iPad 可用。

### 当前代码已具备什么，还缺什么

`Dockerfile` 已将 `pixelflux==2.2.3` 安装到 `/opt/selkies-hevc`，与旧 H.264 运行时隔离。审计时该标签对应提交 `5c78910e524539a2b801433303ee61dd04f42a51`，其中的 [VA-API AV1 实现](https://github.com/selkies-project/pixelflux/blob/2.2.3/pixelflux/src/encoders/vaapi/av1.rs) 已存在。因此接入 AV1 可以复用现有私有运行时，不需要先引入另一个 FFmpeg 推流进程或替换全局旧 ABI。

当前项目的 `hevc_capture.py`、`selkies-hevc.js`、后端编码白名单与前端视频菜单仅完成 HEVC 扩展。新增 AV1 仍需：

1. 扩展私有编码适配层，探测实际渲染节点的 AV1 编码能力，并确认真实首帧和 `stream_info()` 中的 codec / hardware。硬编不可用时回退现有路径，避免静默转为高负载软件 AV1。
2. 处理 AV1 帧类型和序列信息。AV1 使用 OBU，不能复用 HEVC 的 NAL / SPS 解析。上游 2.2.3 的原生帧头包含 codec 和关键帧标志，可据此适配当前传输协议；不能把上游视频包类型 4 当成本项目旧 H.264 消息类型 4。
3. 增加 `av01...` 解码配置、能力协商、首个关键帧等待及失败回退，并覆盖共享观看者。配置接受和真正出画面必须分别验证。
4. 扩展偏好保存、视频队列顺序、ACK / 背压、重连、休眠唤醒、改分辨率等路径，保留现有 H.264 / HEVC 回退能力。

上游 Python API 与帧头定义分别见 [lib.rs](https://github.com/selkies-project/pixelflux/blob/2.2.3/pixelflux/src/lib.rs) 和 [codec.rs](https://github.com/selkies-project/pixelflux/blob/2.2.3/pixelflux/src/encoders/codec.rs)。当前启动脚本 `configure-amd-gpu.py` 只探测 H.264；它的成功结果不能作为 AV1 已可用的证据。

### 如何评价“高画质、低占用”

- **文字清晰度**：4:2:0 仍可能损失彩色细字与线条的色度细节。AV1 和 10-bit 都不等于 4:4:4。比较时应保留原生分辨率，并检查静止后的文字补绘效果。
- **CPU 与功耗**：编码硬件化只覆盖一部分工作，采集、像素格式转换、内存上传和浏览器渲染仍可能占用资源。`stream_info()` 可辅助核查捕获路径、是否零拷贝及回退原因。
- **浏览器硬解**：[W3C WebCodecs 规范](https://www.w3.org/TR/webcodecs/#hardware-acceleration) 明确 `prefer-hardware` 是可被忽略的提示。`isConfigSupported()` 成功不等于已使用硬解，需要结合实际出帧、解码器状态、CPU 和视频引擎活动判断。
- **带宽与延迟**：固定分辨率、帧率和操作场景，先比较同码率画面，再比较相近视觉质量的码率。不能用相同 CRF / QP 数字直接认定画质相同，也不应在实测前承诺固定百分比收益。

建议覆盖中文小字、彩色文字、聊天滚动、图片和视频混合画面，采集编码及解码耗时、输入到呈现延迟、丢帧、带宽和两端 CPU。上游 `stream_stats()` 的帧数、字节数、编码与管线耗时可用于增量采样。另需检查 1920×1080 等尺寸的编码对齐、可见区域和鼠标坐标一致性。

## 验证与部署范围

以下 8 个定向脚本全部通过：

- `tests/test_toolbox_layout.js`：执行真实工具箱构造、渲染、清理及上游键盘处理器；检查分组、绑定、展开状态、周期更新、本地按键与焦点恢复。
- `tests/test_sidebar_scroll_render.js`：21 项侧栏滚动回归。
- `tests/test_preferences_client.js`、`tests/test_input_sampling_sampler.js`、`tests/test_dock_network_monitor.js`：偏好保存、输入采样与快捷 Bar 监测。
- `tests/test_ime_recovery_copy.js`、`tests/test_ime_activity.js`、`tests/test_ime_reconnect.js`：未发送文字复制、输入活动与重连隔离。

JavaScript 语法检查与 `git diff --check` 通过。以上是脚本级验证；当前执行环境无法启动原生 Chromium，因此未取得新布局的浏览器截图，尚未在 NAS 上部署或进行 780M AV1 硬编测试。

源码版本、Compose 示例标签与前端缓存版本已更新到 1.89。使用现有配置构建并重建容器后，浏览器强制刷新即可加载新布局。当前镜像工作流仅由 tag 或手动运行触发，推送分支不表示镜像仓库已发布 1.89。

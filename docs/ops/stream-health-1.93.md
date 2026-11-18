# 1.93 卡顿恢复补强

日期：2026-11-18（Asia/Shanghai）。基线：`AXiVer` / `4ecde1e7e3b4bf09f6d8c88792ef36ae52e3fd2f`（1.92）。

本轮继续检查“偶发画面卡住”的失败路径，使用实际发布函数和可控故障复现后修正。最左侧变色状态条的上红、下紫提示点延续 1.92 布局；没有增加新的常驻面板。

## 确认的问题与修复

| 触发情况 | 原来的失败结果 | 1.93 行为 |
| --- | --- | --- |
| 已在推流时重复收到 `START_VIDEO` | 捕获跳过重启，却重新停止背压任务并重置前端解码器；无限 GOP 下可能等不到新关键帧 | 已有有效捕获与背压任务保持不变，重复启动不清空 ACK 或解码参考帧 |
| 从暂停恢复时，原生捕获启动记录错误后直接返回 | 无捕获实例仍发 `VIDEO_STARTED` | 检查实际实例，必要时进入带身份快照的全量回退；仍失败则发 `VIDEO_STOPPED` 并记录 `capture_start_failed` |
| 开始、暂停、设置重建在相邻时刻发生 | 未统一持锁的路径可能交错，旧请求作用于替换连接 | 通过已有捕获锁和当前 owner 检查串行处理；设置重建复用受保护路径 |
| 两次条带解码错误发生在 5 秒冷却期内 | 第二次关闭解码器后直接退出；另一条带仍在刷新，缺失条带可一直卡住 | 合并尚未恢复的条带，保留一个冷却结束后的恢复请求；所有受影响条带输出后才取消它 |
| 主线程停顿前收到最后一帧，但没有画出来 | 事件循环延迟处理清掉待绘制记录，之后没有新包便不再检测冻结 | 保留待绘制元数据，只给 3 秒新宽限；仍无输出便继续累计停滞 |
| JPEG 解码 Promise 在管线重置后才完成 | 旧图像可重新入队并覆盖新画面；失败时解码资源未及时关闭 | 以 JPEG 周期识别过期结果，丢弃并关闭旧图像；成功与失败均关闭 ImageDecoder |
| 手动修复只收到“视频已启动”或较早的一次绘制 | 可能提前显示恢复成功 | 只有最新重置后的实际绘制能确认恢复 |
| 刷新倒计时中切换连接、暂停或进入后台 | 旧倒计时可能刷新新会话或已主动暂停的页面 | 刷新绑定原连接、显示器和恢复周期；回调再次核验当前状态，过期即取消 |

自动解码恢复仍只作用于视频：主控发送当前显示器的 `FORCE_STREAM_RECOVER,<display>,video`，共享观看请求 `START_VIDEO`。延后请求不形成周期性重启定时器，连接、编码、角色、显示器、暂停或前后台状态变化后取消过期请求。手动完整修复的音频 / 输入处理保留既有语义；已发 STOP 的手动序列不会仅因短暂隐藏页面就丢掉配对 START。

## 旧 H.264 库的共享观看限制

项目固定的 pixelflux 1.6.2 标签对应源码提交：

`cf4f52757c0b7346a3556ef5c9bc23e41cae57bf`

核对 [Python 包装层](https://github.com/selkies-project/pixelflux/blob/cf4f52757c0b7346a3556ef5c9bc23e41cae57bf/pixelflux/__init__.py) 与 [C++ 捕获实现](https://github.com/selkies-project/pixelflux/blob/cf4f52757c0b7346a3556ef5c9bc23e41cae57bf/pixelflux/screen_capture_module.cpp) 后，确认：

- `ScreenCapture.request_idr_frame()` 存在。问题不是该 API 在固定版本中缺失。
- 非持续推流模式决定是否编码时先检查画面变化、damage block 与 paint-over，不检查请求关键帧的标志。因此已经静止的桌面不保证立即产生一帧。
- CPU 条带编码在逐条带循环内读取并清除同一个强制 IDR 标志，第一条带之后的条带不保证得到关键帧；各条带又使用无限 GOP。

新建或重置后的 WebCodecs VideoDecoder 需要从关键帧开始，持续收到 delta 帧不能恢复缺失的参考状态，见 [WebCodecs 的 configure / decode 定义](https://www.w3.org/TR/webcodecs/#videodecoder-interface)。

因此共享观看加入或恢复时按实际模式处理：

| 主控模式 | 恢复方式 |
| --- | --- |
| `x264enc` 且 `h264_streaming_mode=true` | 保留轻量 `request_idr_frame()` |
| `x264enc` 且 `h264_streaming_mode=false` | 受保护地重建主屏视频捕获，确保静态画面也有初始帧 |
| `x264enc-striped` | 受保护地重建主屏视频捕获，让所有条带获得初始关键帧 |
| `h265enc` / `av1enc` | 保留对应适配器的关键帧请求 |

旧模式的捕获重建会让同一主屏上的其他观看者短暂重新同步，保留主控编码选择、音频与输入。共享窗口切回前台时可能已经释放本地解码器，因此即使两次请求非常接近，也不能仅凭时间间隔忽略后一请求。短时间内重复加入或恢复可能发生多次视频同步；默认持续全帧 H.264、HEVC 与 AV1 不使用这条捕获重建路径。

如果原生 H.264 后端运行中异常退出硬编，其旧包装层没有可靠的实际后端查询接口。本轮不把关键帧方法返回当成已恢复，也不声称完成该硬件故障路径的实机验证。

## 红点与紫点的口径

- **上方红点**继续表示能够确认的视频丢弃或异常断流，不把 RTT、帧号跳跃当作 IP 丢包。
- **下方紫点**继续表示解码、绘制、接收 ACK 或主线程停顿等卡顿证据。本轮避免主线程恢复执行时遗忘未呈现的最后一帧。
- 页面隐藏、主动暂停与已完成的静态画面不因经过较长时间而自动判为冻结。

故障发生时可在当前页面开发者工具读取：

```javascript
window.__selkiesStreamHealth.diagnostics()
```

`framesRendered` 统计成功绘制回调，条带画面一次编码帧可能产生多个回调；它不是完整画面 FPS，也不能单独证明每个条带都恢复。1.93 的条带恢复请求另行跟踪受影响区域。

## 回归与部署边界

新增与扩展的行为测试：

```bash
python -m unittest tests.test_stream_resume tests.test_stream_backpressure_progress tests.test_stream_queue_behavior tests.test_av1_capture
node tests/test_video_decode_recovery.js
node tests/test_stream_health_client.js
node tests/test_stream_health_runtime.js
node tests/test_stream_recovery_lifecycle.js
node tests/test_av1_client.js
```

测试覆盖原生启动失败、普通恢复误报、重复主控 START、开始 / 暂停竞争、排队期间 owner 替换、静态与条带共享恢复、共享窗口快速再次请求完整画面、第二次解码错误落在冷却期、只恢复一个条带、过期 JPEG 结果、事件循环停顿后的最后一帧、手动修复与页面刷新定时器的旧状态隔离。

定向集成验证通过 137 项 Python 测试、19 个 JavaScript 测试脚本，以及已修改源文件的语法和差异检查。健康状态模块包含 22 组行为回归，新增普通 / 共享恢复模块包含 15 项 Python 测试及其子场景。

这些回归执行实际生产函数，以可控连接、时间、Canvas 和原生 API 故障验证行为。当前开发环境没有 Docker、目标 NAS 的 `/dev/dri` 或 Windows WebView2，未进行真实浏览器故障注入，也没有完成 780M 编解码实机验收。

部署新构建的 1.93 镜像并刷新页面后，重点观察：普通静置、前后台切换、暂停 / 恢复、共享加入、CPU 条带模式与连续快速重连。红紫点的故障证据与实际画面应一致；静态画面不应持续触发重建。AV1 能力、性能对照与镜像回退仍按 [AV1 实机验收流程](av1-validation.md) 执行。

1.93 只更新源码、前端缓存版本与示例镜像标签；推送分支不代表镜像已经构建、发布或部署。端口、密码、网络、设备映射和 `/config` 卷不在本轮改动范围内。

# IME 极端用例反馈

本报告保留首次只收集测试反馈的结果：Luna Max 子线程新增了 `tests/test_text_injection_extreme.py` 并执行以下检查；父线程构建 `tests/test_ime_extreme.js`，将原有 fixture 提取到 `tests/helpers/ime_fixture.js` 复用。当时没有继续修改生产代码，也未构建或部署。后续修复状态见文末。

## 定向测试结果

| 命令 | 结果 |
|---|---|
| `node tests/test_ime_delivery.js` | 退出码 0，基线回归通过；约 0.5 秒。 |
| `node tests/test_ime_extreme.js` | 退出码 1；42 项中 36 通过、6 失败；4 个固定种子生成的 1000 次提交序列全部通过；约 0.5 秒。 |
| `python -m unittest tests.test_text_injection tests.test_text_injection_extreme` | 退出码 1；运行 11 个测试方法，1 个方法中的 2 个子用例失败，其余方法通过。现有基线 3 个方法通过；新增极端测试 7 个方法通过，空/截断消息测试的 2 个子用例失败；约 1.6 秒。 |

失败数按根因归并如下。前端 6 项不是 6 个独立缺陷：4 项属于同文重复抑制，2 项属于丢失 `compositionend` 后状态未恢复。Python 的 2 项是同一方法中的空正文和缺分隔符两种输入。

## 发现

### P2：提交后独立插入相同文字会被去重逻辑吞掉

前端极端套件有 4 项失败：`insertFromPaste`、`insertReplacementText`、`insertText` 三个同文插入变体，以及同文插入前更换 assist 元素的变体。共同结果是预期 `"中文中文"`，实际只有 `"中文"`。核心可复现序列是：

1. 开始拼音组合，`compositionend(data="中文")`；当前 guard 已发送第一份“中文”。
2. 推进零延迟清理计时器。
3. 在 assist 输入框右键粘贴同一段“中文”，产生没有 `keydown` 的 `input`，`inputType="insertFromPaste"`、`data=null`、输入框值为“中文”。
4. 预期发送第二份粘贴文字；实际没有新发送。

这是独立的第二次输入，不是 composition 的尾随 `input`。`input` 处理器在 [selkies-runtime-overrides.js](../../root/usr/share/selkies/selkies-dashboard/src/selkies-runtime-overrides.js) 的 8552–8555 行只要 `value === commit.text` 就把事件当作前次提交的回声并返回；即使零延迟清理已将 `commit.cleared` 置为真，该相等判断仍生效。对应失败用例在 `tests/test_ime_extreme.js` 的 “independent same-text insertion after end-only commit” 和 “remounted assist does not inherit old same-text duplicate marker”。

右键粘贴是现实可用的操作：图片粘贴处理器在 `selkies-paste-image.js` 214 行会对可编辑目标直接返回，因此不接管普通文本粘贴。该代码路径没有证实具体浏览器一定会发出上述事件属性；本轮没有用真实浏览器验证菜单入口。`insertReplacementText` 和 `insertText` 两个变体也只在 harness 中验证，不能据此声称真实 IME 已触发。该发现针对同文独立插入，不证明连续拼音选词本身会丢字。

### P3：缺少 `compositionend` 时，后续普通输入仍被当成预编辑丢弃

前端极端套件有 2 项失败，归为同一故障恢复缺口。测试故意开始 composition、输入预编辑，然后注入“没有收到 `compositionend`”的 blur/focus 或 assist 元素替换，再发出普通 `insertText` 输入。预期后续明确的普通文字被接收，实际发送内容为空，因为 `assistComposing` 仍为真，`input` 处理器在 8549 行直接返回。

这两条是故障注入顺序，不是已证实的正常浏览器 IME 顺序。测试能说明 guard 在 `compositionend` 丢失后无法自行恢复，不能证明此路径就是连续拼音漏字的成因。用例见 `tests/test_ime_extreme.js` 中标记为 `lost-event-recovery` 的两个 “interrupted composition” 测试。

### P3：空或截断 `co,end` 消息仍启动空文字注入

Python 新测试中的两个失败子用例分别发送 `co,end,` 与缺少正文分隔符的 `co,end`，并预期不启动子进程。实际两者都调用一次 `create_subprocess_exec`，正文参数为空。后端 [input_handler.py](../../root/lsiopy/lib/python3.12/site-packages/selkies/input_handler.py) 的 2176–2181 行只检查 `toks[1] == "end"`，随后固定从 `msg[7:]` 取正文，所以长度为 6 的 `co,end` 也会变成空串。

前端 `flushAssistInput` 在 8429 行会在待发送文字为空时直接返回，因此这不是当前前端会产生的消息，也不会解释已提交文字消失；空注入只是多启动一个无正文的外部命令。将其保留为低优先级协议健壮性问题，不作为吞字缺陷。

## 通过的边界

- 后端非提交 `co` 消息不会启动注入器；长 Unicode、补充平面字符、组合附加符、ZWJ、换行和逗号保持为单一进程参数。
- 创建子进程失败、非零退出和通信异常都不会把测试正文写入日志；通信异常会 kill/reap 子进程。
- 长输入的超时参数被截顶到 30 秒；取消与 kill 同时遇到 `ProcessLookupError` 的模拟竞态仍执行 `communicate()` 清理。
- 前端固定种子生成序列共 1000 次提交通过；发送失败、背压、替换连接保留未发送后缀、Unicode 分块和连续重复 composition 的其他既有极端项通过。

## 模拟边界

- JS harness 从生产脚本中截取实际 guard 运行于 Node `vm`，模拟 DOM 值、事件顺序和 socket `send()`；它没有浏览器、原生中文输入法、真实右键菜单或远端 WeChat/QQ。`tick()` 是手动执行当前计时器批次，不模拟真实的 0ms 或 120ms 调度。
- Python harness 通过 AST fixture 执行生产 `on_message` 方法，但 subprocess、`returncode`、kill 竞态和 `communicate()` 都是 mock；没有实际运行 `xdotool` / `wtype`，也不证明操作系统进程在真实取消时的时序。
- socket `send()` 被接受只证明传输层接受了消息，不证明远端应用最终显示了文字。本轮不是构建、部署或真实 IME/应用验收。

## 后续修复状态

以上结果保留为首次测试记录。2026-10-25 用户要求根据高延迟与 CPU 压力结果修改代码后，前端原先 6 个失败断言已修复；额外补齐 DOM 重建早于清理计时器的前缀检查后，当前极端套件为 43/43，通过 1000 次生成提交。高延迟队列修复与真实 WebSocket 检查见 [高延迟测试与修复](ime-latency-hardening.md)，真实限 CPU 容器试验另见 [容器压力记录](ime-container-stress-feedback.md)。

# Larva 0.8.7

修复 Pi subagent Timeline 在 assistant 生成过程中没有正文、完成后才出现的问题。

- assistant text delta 立即更新当前消息的一行 Timeline；已有工具或隐藏 thinking 行不会再遮住生成中的正文。
- 生成中的单条正文保留最新 1200 个 Unicode code points，超过预算后显示省略标记并继续更新尾部。Output 的 4000 字符尾部与 Timeline 的 80 项上限保持不变。
- 使用 native 消息边界和最终消息身份，将实时行替换为异步 Worker 读取的持久化消息，保留工具前后顺序，避免同一消息重复显示。连续消息独立保留；缺少或存在歧义的身份不会触发按预览文本删除，未确认实时行显示 `persistence pending`。
- 现有滚动、暂停/End 恢复跟随、工具状态、thinking/tool argument 隐私过滤、watchdog、最终结果与 callback 来源保持不变。

## 安装与交付

Python `larva` 发布到 PyPI；private Pi extension 由 GitHub `v0.8.7` 的源码交付。Python wheel 不包含 Pi extension，升级 Python 包不会替换用户已安装的 Pi extension。本次没有 npm 发布，也不更改用户的 Pi 设置。

获取 `v0.8.7` 源码后，可在该源码目录执行：

```bash
uv tool install --upgrade larva==0.8.7
npm --prefix contrib/pi-extension ci
export LARVA_CLI_ARGV_JSON='["/absolute/path/to/larva"]'
pi install /absolute/path/to/larva/contrib/pi-extension
```

替换为实际路径，重启 Pi 加载新 extension。Python/private extension 版本均为 0.8.7；开发依赖锁仍为 Pi 0.85.1，运行时不按 Pi 版本拒绝加载。

## 验证范围

现有 Worker 与 UX 回归覆盖分块更新、持久化滞后/提前、连续同文消息、1200/80 项预算、隐私和 reset。现有 `installed-panel` runner 通过真实 Pi loader 与 RPC 子进程、受控 loopback 流式输入，验证正文在 native 持久化/结束之前可见、长输出更新同一行、完成后无重复，以及原有工具事件和 fullscreen/regular 导航。输入不调用真实模型，不修改用户配置。

发布流程继续使用完整 GitHub CI 和现有 trusted PyPI workflow。实际发布状态、安装版本与 fresh unpinned uvx CLI 检查由发布执行结果确认。

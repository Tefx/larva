# Larva 0.8.5

本次补丁修复 Pi subagent 面板的实时工具状态、输出预览与 Timeline 跟随行为。

- 按 native Pi 的 `partialResult`、`result` 和 `isError` 更新工具行；连续 partial 覆盖同一行，最终结果清除旧预览。工具失败与子任务最终执行状态分别显示。
- 工具预览限制为 1200 个 Unicode code points；省略图片及其他非文本内容，不向面板暴露 details 或图片数据。超大 RPC 事件保留 native 状态与有界提示。
- 运行中 assistant 输出显示最新 4000 个 code points。Timeline 默认跟随末尾，向上滚动暂停跟随，End 或滚回底部恢复。
- thinking 和工具参数接收更新活动时间，同时隐藏正文；准确区分工具结束、agent_settled、子任务结果与 callback delivery。修正 callback 关联及面板 repaint 失败后的交付状态。
- CI 完整执行 Invar，并在隔离 fixture 中验证 native MCP；开发依赖锁保持 Pi 0.85.1，不增加运行时版本限制。

## 安装与升级

Python 包提供 persona 数据后端；Pi extension 由本 release 源码中的独立 package 交付。升级 Python wheel 不会替换已安装的 Pi extension。

在本 release 源码根目录执行：

```bash
uv tool install --upgrade larva==0.8.5
npm --prefix contrib/pi-extension ci
export LARVA_CLI_ARGV_JSON='["/absolute/path/to/larva"]'
pi install /absolute/path/to/larva/contrib/pi-extension
```

请将路径替换为实际的 CLI 和本版本源码路径；重启 Pi 加载更新。extension package metadata 为 0.8.5，保持 private；本次不新增 npm 发布，也不将 Pi payload 塞入 Python wheel。

## 发布前验证

现有 tracked `scripts/mcp-release-smoke.py` 验证构建 wheel 的隔离安装、MCP 启动及 13 个工具。
安装后的 panel 检查复用现有 fixture 和 native journey：

```bash
PI_BIN=/absolute/path/to/real/pi/cli.js node scripts/pi-native-journeys.mjs \
  --scenario installed-panel --output /owned/path/installed-panel.json
```

该检查从当前源码执行本地 `npm pack`，解包 manifest payload，在临时 agent state 中通过真实 `pi install` 与 loader 加载；同一安装 entry 启动真实子 Pi，验证 native 工具 partial、成功/失败结果、snapshot、TUI render 和 delivered callback。仅使用 loopback provider，无真实模型、全局安装或用户配置改写。父 panel API 为 headless，渲染使用开发锁的 TUI；子进程和安装控制使用所选真实 Pi 的 loader。版本信息作为观察上下文。

# Larva 0.8.6

本次补丁交付 Pi subagent Timeline 的滚轮路由、窗口缩小与事件保留修复。

- fullscreen 面板接收 Pi 的 normalized `handleMouse` wheel 事件，每次输入只滚动一次；普通模式保留原有 SGR 输入。上、下方向键继续逐行移动。
- 每次 render 根据当前终端高度计算 viewport。窗口从 42 行缩小到 14 行后，仍可到达最新内容。
- Timeline 按事件到达顺序保留最近 80 项，再单独计算显示分组。持续新消息通过异步 Worker 追上时，旧事件按到达顺序淘汰，最新工具和消息仍可见。
- 向上滚动暂停跟随；新活动继续到达并显示提示，End 或滚回底部恢复跟随。Output、选择、reset、隐私过滤、callback、watchdog 与 prefix 行为保持不变。

这些修复对应已复现的三个缺陷；现有证据无法证明它们解释所有现场会话异常。

## 安装与升级

Python `larva` 提供 persona 数据后端；native Pi extension 通过本 release 的 GitHub 源码独立交付。升级 Python wheel 不会替换 Pi 已安装的 extension。

发布后，获取 `v0.8.6` 对应的源码，在其根目录执行：

```bash
uv tool install --upgrade larva==0.8.6
npm --prefix contrib/pi-extension ci
export LARVA_CLI_ARGV_JSON='["/absolute/path/to/larva"]'
pi install /absolute/path/to/larva/contrib/pi-extension
```

将路径替换为实际 CLI 与本版本源码路径，重启 Pi 加载更新。private extension metadata 与 Python 版本均为 0.8.6；没有 npm 发布或 Python wheel 内的 Pi payload。开发锁保持 Pi 0.85.1，运行时不按版本拒绝用户的 Pi。

## 交付检查与边界

`scripts/mcp-release-smoke.py` 检查构建 wheel 的隔离安装、MCP 启动和工具列表。Pi 交付使用已有 tracked runner：

```bash
PI_BIN=/absolute/path/to/real/pi/cli.js node scripts/pi-native-journeys.mjs \
  --scenario installed-panel --source-root /absolute/path/to/release-source \
  --output /owned/path/installed-panel.json
```

`--source-root` 指向已核实 release tag/commit 的独立源码；省略时检查当前 checkout。runner 从所选源码执行本地 `npm pack`，解包 manifest payload，在临时 agent state 中通过真实 `pi install` 与 loader 加载。同一安装 entry 启动真实子 Pi，检查工具 partial、成功/失败结果、snapshot、render 与 callback；随后在实际 fullscreen/regular PTY 中执行 wheel、方向键、42→14 resize、跨越 80 项的 Worker 更新及暂停/恢复检查，直接使用该安装 entry。

工具事件部分的父 API 为 headless，使用开发依赖 TUI；导航部分使用所选真实 Pi 的 native host。确定性 loopback provider 只供应工具事件输入，不调用真实模型；导航部分不发送模型请求。检查结束会回收临时会话、Worker 与进程，不更改用户配置。准备阶段观察使用 Pi 1.2.0 / Node 26.10.0，版本仅作上下文。

本文件说明候选版本内容与检查方法。实际 GitHub/PyPI 发布、完整远程 CI、fresh unpinned uvx latest 的版本及真实 `--help`、发布源码的隔离 Pi 安装验证，由后续发布步骤核实；本地准备结果不证明这些外部状态。

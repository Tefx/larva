# Larva 0.8.10

Subagent 活动面板与工作台提供实时运行信息，并兼容 Pi 1.4.0 Responses 请求中的工具更新。

- MCP subagent activity panel 展示实时运行遥测，便于查看子任务进度与活动。
- 重新设计 subagent widget 和 activity workbench，统一运行摘要、活动与详情展示。
- 限制 inline drawer 占用空间，并在切换显示模式时保留 panel workbench 状态。
- 展示完整任务 prompt，统一响应式 subagent inspector，便于查看委派上下文。
- 预加载 persona mentions，减少首次查询等待；已完成的 inline widget 停止轮询。
- 修复 Pi 1.4.0 `openai-responses` / `azure-openai-responses` 的身份指令投影：保留开头的 `additional_tools`，在其后的首条指令消息中更新 persona，保持对话中途的工具更新和末尾 `configuration_update` 顺序不变。

## 安装与使用

Python `larva` 0.8.10 通过 PyPI 交付；private Pi extension 和 Codex plugin 通过 GitHub `v0.8.10` 源码交付。Python wheel 不包含 Pi extension，升级 Python 包不会替换已安装的 extension。本次不发布 npm 包。

```bash
uv tool install --upgrade larva==0.8.10
```

已有 Codex 安装可能继续使用本地 plugin cache。确认 marketplace 指向本次源码后，使用 Codex CLI 刷新同一插件：

```bash
codex plugin remove larva-subagent@larva
codex plugin add larva-subagent@larva
```

刷新后需重新启动 Codex 客户端以加载更新；发布流程不会代替用户重启。完整安装配置见 `contrib/codex-plugin/README.md`。

## 验证范围

发布检查覆盖 idle callback identity、system prompt resolver 和 MCP subagent server 的 Node runtime 测试、Python plugin contract、schema validation 与 validator、Invar 全量检查、wheel/sdist 构建及隔离 wheel MCP smoke。Codex plugin 的五个 runtime 文件与 Pi extension 源文件保持字节一致。

Responses 回归覆盖 string/array 指令内容、persona 切换、无 persona 时的旧标记清理、缺少首条指令时的注入、连续 `additional_tools`、保留 `configuration_update` 和畸形指令的拒绝路径。验证不构成自动化 Codex UI 测试，也未验证实际模型委派或模型路由行为。远程 CI、PyPI 发布及本地缓存刷新结果以对应 workflow 和发布验收记录为准。

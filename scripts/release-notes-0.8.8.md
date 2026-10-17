# Larva 0.8.8

新增跨 harness subagent MCP 入口与自包含 Codex plugin，并改进 Pi 子进程启动、全屏交互和热重载。

- `larva-pi-subagent` stdio MCP server 提供 9 个工具，按需加载 Pi runtime；初始化、工具发现和无效请求不触发 runtime 加载。
- Codex plugin 自带 5 个 runtime 文件，通过 Strategy B 路由调用 subagent；支持 Pi Managed Installer 自动发现，无需依赖仓库外的 runtime 副本。
- child RPC 初始 readiness 独立等待最多 60 秒；超时诊断包含命令、阶段、首帧、子进程状态和耗时，后续普通 RPC deadline 保持不变。
- subagent overlay 打开与关闭时保留 Fullscreen mouse tracking，避免破坏父界面的鼠标交互。
- native `/reload` 在同一进程内交接运行中的 subagent、task handle、事件游标与 watchdog；交接期间的结果等待新 callback surface 绑定。结束 session 或直接触发 synthetic `reload` 仍执行 teardown，不提供进程重启恢复。
- 修复现有 contract 测试的参数与文档锚点兼容性；callback 完成或失败不会覆盖已被标记为 suppressed 的终态。

## 安装与交付

Python `larva` 版本更新为 0.8.8；private Pi extension 与 Codex plugin 通过 GitHub `v0.8.8` 源码交付。Python wheel 不包含 Pi extension，升级 Python 包不会替换已安装的 extension。本次没有 npm 发布，也不修改用户的 Pi 设置。

发布后可从 `v0.8.8` 源码目录安装：

```bash
uv tool install --upgrade larva==0.8.8
npm --prefix contrib/pi-extension ci
export LARVA_CLI_ARGV_JSON='["/absolute/path/to/larva"]'
pi install /absolute/path/to/larva/contrib/pi-extension
```

Codex plugin 配置与安装方式见 `contrib/codex-plugin/README.md`。依赖锁用于复现本地构建，不限制用户安装的 Pi 版本。

## 验证范围

候选验证覆盖 Pi/Codex contract、stdio MCP server、reload handoff、native launch context、Python wheel/sdist 构建、wheel MCP smoke 与 Invar guard。离线测试使用隔离 fixture，不调用真实模型或修改用户配置。实际发布、远端 CI 与安装验收由后续发布步骤确认；本准备步骤不推送、打 tag 或发布。

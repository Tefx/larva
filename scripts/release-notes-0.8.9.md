# Larva 0.8.9

Codex Composer 支持搜索并选择 Larva Persona，减少委派前的手动发现步骤。

- MCP `openai/mentions` 能力通过只读、app-only `search_mentions` 提供最多 30 个排序后的 persona resource links；空查询列出候选。
- 新增 `resources/list`、`resources/read` 和 `resources/templates/list`，提供 persona ID、模型、描述与委派指引。
- 初始化 `instructions` 与 Codex skill 指引：选中或明确写出 `@larva:<persona_id>` / `@persona:<persona_id>` 后直接调用 `larva_subagent`；仅提及 `@Larva Subagents` 时先调用 `larva_personas`。
- Pi extension 与自包含 Codex plugin 的 MCP server 保持一致；初始化、工具发现和无效参数请求仍不加载 runtime。

## 安装与使用

Python `larva` 0.8.9 通过 PyPI 交付；private Pi extension 和 Codex plugin 通过 GitHub `v0.8.9` 源码交付。Python wheel 不包含 Pi extension，升级 Python 包不会替换已安装的 extension。本次不发布 npm 包。

```bash
uv tool install --upgrade larva==0.8.9
```

Codex Composer 操作：输入 `@larva` → 高亮 `Larva Subagents` → 按 `Tab` → 搜索并选择 persona。

已有 Codex 安装可能继续使用本地 plugin cache。确认 marketplace 指向本次源码后，使用 Codex CLI 刷新同一插件：

```bash
codex plugin remove larva-subagent@larva
codex plugin add larva-subagent@larva
```

刷新后需重新启动 Codex 客户端以加载新能力；发布流程不会代替用户重启。完整安装配置见 `contrib/codex-plugin/README.md`。

## 验证范围

用户已在刷新本地缓存并重启客户端后确认 Persona 搜索 UI 可用。协议测试覆盖初始化能力、app-only 工具元数据、搜索结果与查询规范化、persona resources、无效输入和缓存插件启动；发布检查覆盖版本一致性、Node runtime 测试、Python plugin contract、Invar、wheel/sdist 构建及隔离 wheel MCP smoke。

这些检查不构成自动化 Composer UI 测试，也未验证实际模型委派或模型路由行为。远端 CI、PyPI 发布及安装结果以对应发布 workflow 和发布验收记录为准。

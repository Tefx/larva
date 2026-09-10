# Larva 请求级系统指令解析接口设计

## 状态与范围

本文件是请求级系统指令解析的详细设计。用户已授权更新本文并创建 Vectl 实施计划，将该增量排在现有任务之后；本轮不启动实现、安装或运行时验收。

实施范围由 `plan.yaml` 中的 `pi_system_prompt_resolution` 阶段、`pi-system-prompt.deliver-resolver` 步骤承载，依赖现有末端 `pi-native.accept-repository`。实现、行为测试、集成文档及该增量的最终验收属于同一个完整交付；不修改或抢占现有 claim。Plan 仅通过 Vectl 管理，实施者不得直接编辑。

采用一个共享的纯指令组合边界，通过 Pi 公开 `pi.events` 提供同步、只读、请求级解析。保留 `before_agent_start` 和 `before_provider_request`，后二者与新接口使用相同的组合语义。

产品范围为 Larva Pi 扩展、对应行为测试及集成文档。不修改 Pi core、已安装 Pi 包、Pi 私有运行时状态、Nunc 源码、persona 内容、PersonaSpec、回调持久化或任务调度。纯组合逻辑保留在 TypeScript 扩展内，无需迁入 Python Core 或增加服务、注册中心、后台任务。

`pi-nunc` 已收到方案，其授权仍为仅接收，不启动调查、评审、实施、计划变更或组合验证。本次 Larva 建计划不改变该限制。Nunc 接入与端到端容量/receipt 验证不属于本次 Larva 交付的完成声明。

原生 Pi 改造尚未验收不妨碍接口设计。用户要求的执行顺序通过上述依赖保证；方案文档中的私有布局建议不升级为额外验收条件。
## 设计依据

当前 `contrib/pi-extension/larva.ts` 中：

- `replaceLarvaWatermark()` 重建 identity policy 和 active persona，但没有将 continuation 纳入同一受管组合边界。
- `before_agent_start()` 在该结果后追加 continuation；`composeProviderSystemText()` 再次移除并重建 persona，保留原 continuation。因此同一状态可能出现段落移动。
- `before_agent_start()` 与 `before_provider_request()` 在 `state.envelope` 为空时直接退出，不能处理已初始化无 persona 状态中的遗留片段。
- `agentPersonaSwitchPromptGuidance()` 还依赖 `agentPersonaSwitchMode`；仅比较 persona ID 或 digest 无法判定最终指令是否相同。
- `sessionInitializationPromise` 被保存后并不清空，不能以它是否非空判断初始化是否仍在进行。
- `test-idle-callback-identity-runtime.mjs` 的 continuation 回归检查数量和内容保留，未要求第二次 provider 投影为 `unchanged`。

已只读核实安装的 Pi 0.85.1：

- `docs/extensions.md` 公开 `pi.events`、`session_start`、`session_shutdown` 与 `ctx.reload()` 生命周期。
- `dist/core/event-bus.d.ts` 声明 `emit(...): void`，`on(...): () => void`。
- `dist/core/event-bus.js` 使用同步 EventEmitter 分发。虽然安全包装器是 async，调用用户 handler 发生在第一个 await 让出执行之前，因此同步 handler 能在 emit 返回前调用 reply。
- `dist/core/extensions/loader.js` 跟踪 `pi.events.on()` 订阅并在旧 runtime 失效时注销。
- `examples/extensions/event-bus.ts` 展示公开扩展间通信入口。

以上为源码和文档证据；本次没有执行运行时测试。产品代码只能使用公开 ExtensionAPI，不能导入上述内部实现来建立运行依赖。

## 一、所有权与依赖方向

| 数据或行为 | 唯一所有者 | 解析接口的权限 |
|---|---|---|
| 传入基础系统指令 | 当前请求的调用方 | 读取该字符串，不重新构造 Pi 基础指令 |
| 已加载 persona envelope | Larva 现有运行时 | 读取已提交结果，不 list/resolve/refresh |
| switch mode、lease、restore 状态 | Larva 现有切换与恢复入口 | 读取，不创建、续期、清除或恢复 lease |
| continuation 的有效期及内容 | Larva 现有 continuation 生命周期 | 读取，不消费、调度或重建触发消息 |
| 当前会话解析就绪状态 | Larva 扩展实例 | 由状态变更入口维护，查询不写入 |
| 请求 Context、容量准入、usage receipt | Nunc | Larva 不维护 receipt，也不决定压缩策略 |
| 消息、会话记录、全局 systemPrompt | Pi 及既有调用路径 | 新接口不读写会话历史、不写回全局 prompt |

依赖方向为：三个入口分别读取当前状态，调用共享组合逻辑；provider 适配层额外负责文本槽映射。组合逻辑不依赖 Pi API、文件、环境变量、网络、时钟、随机数或任务队列。

概念上的组合输入包括基础字符串、当前 envelope 或明确的 none、switch mode、有效 lease 信息和有效 continuation 内容。私有参数类型、辅助函数名称、是否复制成只读快照由实现者决定，不新增供 Nunc 导入的内部状态类型。

## 二、纯组合合同

令 `C(S, B)` 表示状态 S 下对字符串 B 的组合结果。S 包含所有影响指令文本的已加载状态，而不局限于 persona ID。

成功结果必须满足：

- 固定状态与输入：`C(S, B)` 每次返回相同字符串。
- 固定点：`C(S, C(S, B)) = C(S, B)`，按完整字符串相等判断。
- 状态更新：对已组合输入应用新状态后，其可识别受管内容只表达新状态。
- persona、identity policy、有效 continuation 各至多一份；无 persona 时不生成 persona 或 identity policy；无有效 continuation 时不生成 continuation。
- 非 Larva 正文的内容、相对顺序及原有重复次数保留。不得对基础正文去重、重写、做 Unicode 规范化或全局空白压缩。
- 不修改任何传入对象或运行时状态，不产生 I/O、消息、审计、日志、会话记录、定时器或微任务。

### 受管内容及排列

识别现有 `larva:identity-policy`、`larva:active-persona` 成对边界、`larva-spec` 标记及 continuation 成对边界；保留对现有完整旧 watermark 形式的识别。persona 正文、现有身份策略文字及切换指导文字保持现有内容语义，不在此次重写。

推荐维持当前 `before_agent_start` 的排列：identity policy、基础正文、active persona、continuation。要求三个入口选择相同且稳定的布局；具体私有文本构造方法不构成新公共 API。Nunc 不得依赖此排列或自行解析标记。

continuation 必须参与完整的受管内容替换，不能通过“字符串里已经有 begin 标记”来决定保留旧内容，也不能在统一组合结果之外再次追加。

Larva 自己插入的分隔换行必须有确定的接缝规则，避免每次删除和添加受管段落都累积空行。不得用全局 `trim()` 掩盖正文丢失。对于历史格式，只处理能够归属于已知受管格式的分隔符；不声称恢复旧版本已经删除的原始空白。

### 遗留及损坏输入

完整、边界明确的旧受管块可整体替换或删除。孤立且明确的 Larva 标记可按已有兼容语义清理，但不能根据 persona 名称、普通句子或提示词关键词推测正文归属。

标记类型必须正确配对，不能将 identity-policy 的 begin 与 active-persona 的 end 当作一对。对于缺失边界、交叉边界或正文示例造成的歧义，如果无法同时证明非 Larva 正文保留和旧身份片段已清除，组合失败；新接口返回 `unavailable`。不得任意吞掉后续正文，也不得把不能确定来源的旧身份正文静默当成成功结果。

此处明确收紧“损坏输入必定修复成功”的假设；入口仍保留。正常及完整历史格式必须成功，损坏格式允许显式失败。现有残缺块测试若与此规则冲突，应保留不丢正文的约束，并明确其结果为失败而非伪造成功修复。

### continuation 和借用状态

- continuation 有效性来自运行时已加载状态；`continuation_running` 才进入当前输出，`awaiting_agent_end` 不提前进入输出。
- continuation 必须仍属于当前 active persona；关联的临时 lease 若存在，也必须仍有效。free 模式的 continuation 允许没有 lease。
- 生命周期结束、手动切换清除 continuation 或当前关联失效后，下次组合删除输入中的旧 continuation；查询本身不清除 pending 对象。
- 查询不从 `Continue.`、输入字符串中的标记或当前时间推断有效期。
- 借用恢复完成后以真实提交的 envelope 为准，不从 lease.originPersonaId 自行加载或合成 origin persona。
- lease 消失本身不等于 envelope 为空。尤其不得借此次改动重新定义“从无 persona 借用后的恢复”语义。
- continuation 内容中合法提及 origin persona 是上下文数据；“旧身份被移除”的断言针对旧指令块，不能要求 origin ID 在整个字符串里完全消失。

## 三、公开事件接口

事件名固定为 `larva:resolve-system-prompt:v1`，仅经当前 Pi 运行时的公开 `pi.events` 使用。

```typescript
type ResolveSystemPromptResult =
  | { status: "ok"; systemPrompt: string }
  | { status: "unavailable"; reason: string };

type ResolveSystemPromptRequest = {
  scope: "main";
  systemPrompt: string;
  reply: (result: ResolveSystemPromptResult) => void;
};
```

这是进程内、同步回调协议，不是 JSON/RPC/MCP 协议，不注册模型工具。无需 request ID、响应事件、Promise、轮询、跨请求缓存或公开版本计数器。

### 请求与回复语义

- `scope` 必须为精确的 `"main"`，`systemPrompt` 必须为字符串，`reply` 必须可调用。空字符串是有效输入，不做强制 trim 或类型转换。v1 不引入额外请求字段或兼容别名。
- `scope` 表达调用方声明的主会话请求用途，不是授权凭据。维护/压缩请求不得调用该接口；Larva 不通过提示词内容猜测用途。子会话不作为本接口的新消费者，既有子会话 hooks 保持工作。
- 已注册且未销毁的监听器对每个有效请求，在同一次 emit 调用栈内调用 reply 恰好一次；不 await，不延迟到 Promise continuation、定时器或后续事件。
- 组合成功即返回 `ok`，即使输出与输入相同。`ok` 仅表示当前状态下指令可确定，不表示容量足够、模型可用或 receipt 已建立。
- 未就绪、恢复失败导致身份不确定、输入结构无法安全解析或组合异常，返回 `unavailable`，不附带旧 prompt 作为备用结果。
- 对带可调用 reply 的无效请求，同步返回 `unavailable`；没有可调用 reply 时不尝试回复，也不产生副作用。
- `reason` 是非空诊断字符串。调用方按 status 分支，不解析 reason 文案建立控制逻辑；reason 不包含完整 prompt、persona 正文、文件路径或原始异常堆栈。
- reply 自身抛错时，Larva 隔离该异常，不尝试第二次回复或另发 unavailable。一次回复的定义为一次调用尝试；调用方负责其回调行为。
- Larva 不保留请求对象或 reply，不修改请求对象，不把结果写回 Pi 全局 systemPrompt。

### 无监听器的边界

Larva 未加载、旧版本无该事件或扩展已销毁时，事件总线可以零回复。此时不存在能履行回复承诺的 Larva 监听器。消费者应在 emit 返回时识别零回复为接口不可用，不等待异步回复、不复用上一请求的结果。

重复回复属于协议错误，消费者不能选择第一份或最后一份身份假装成功。不同扩展不得同时实现同一 Larva 响应事件。

## 四、状态就绪与一致性

“无 persona”必须与“身份未确定”分开：

| 当前状态 | 查询结果 |
|---|---|
| 正在加载扩展、会话尚未初始化 | unavailable |
| 初始化成功且明确无 persona | ok；清理遗留受管内容，保留基础正文 |
| 初始化成功且 persona 状态完整 | ok；组合当前状态 |
| 身份相关状态变更尚未提交或恢复尚未完成 | unavailable，不等待变更完成 |
| 切换失败且已完整回滚到有效旧状态 | 可对该真实旧状态返回 ok |
| 恢复失败、当前身份不能作为有效结果确认 | unavailable，保持既有故障状态 |
| 会话关闭或旧实例失效 | 不再提供旧身份回复 |

就绪状态由现有初始化、commit/rollback、lease 恢复及生命周期写入边界维护。查询不能调用 `ensureSessionInitialized()`、`resolvePersona()`、`listPersonas()`、工具刷新或状态恢复来使自己“就绪”。

只在整组影响指令的变更完成后发布可读状态。一次操作涉及 envelope、mode、lease、continuation 时，不能在中间 await 暴露混合状态；尤其不能仅凭 `commitPersonaInternal()` 已赋值 envelope 就宣布外层借用/continuation 操作全部完成。实现可使用扩展实例内的短暂就绪标记或完整只读视图，不要求新增调度器、状态持久化或全局锁。

同步组合读取同一份当前状态。结果代表回复时的快照，不冻结后续状态；后续 provider 投影仍读取当时真实状态。允许真实状态变化使已准入 Context 需要末端修正，本接口没有跨请求事务或身份预留语义。

## 五、三个入口的职责

### before_agent_start

保留既有初始化等待、请求链边界处理、必要的 lease 恢复及工具曝光刷新。这些副作用属于现有 hook，不属于组合函数。

在既有状态处理完成后，使用事件传入的 chained systemPrompt 和同一当前状态执行组合。即使 envelope 为空，也要处理遗留块。完成组合后不得再次追加 continuation。

组合失败不能被当成“已正确组合”。不能仅依赖抛出 hook 错误阻止请求，因为 Pi 会捕获部分扩展错误并继续；后续 provider 校验仍须保留。

### 同步解析监听器

只负责请求校验、读取已加载状态、组合及一次 reply。不得调用 `before_agent_start()`，因为该入口会变更请求链、工具和恢复状态；不得通过伪造 hook 来获得 prompt。

### before_provider_request

保留现有 API 选择及 payload 形状适配，使用同一组合逻辑处理承载主 systemPrompt 的文本槽：

| provider API | 当前适配位置 |
|---|---|
| openai-completions / mistral-conversations | 首个 system/developer message 的目标文本 |
| openai-responses / azure-openai-responses | input 开头的 system/developer 文本 |
| openai-codex-responses | instructions |
| anthropic-messages | 当前适配的非 OAuth 身份 system 文本块 |
| bedrock-converse-stream | system 文本块 |
| google-generative-ai / google-vertex | config.systemInstruction |
| pi-messages | context.systemPrompt |

目标文本相同时，投影结果为 `unchanged`，hook 返回 `undefined`，不制造等值替代 payload。有差异时仅替换相关文本，保留 messages、tools、角色、其他文本块、cache_control 和其他 provider 元数据，不原地修改输入 payload。

无 persona 不再是跳过检查的理由。已知槽里有旧 Larva 内容时清理；没有旧内容时保持 unchanged；没有指令槽且也无待注入指令时，不为 Larva 创建空槽。

已知 API 在需要注入且容器支持时仍可创建指令槽。存在投影义务却遇到未知 API、无法安全处理的槽或组合失败时，保留既有取消请求和诊断路径，不猜测 payload 结构。`ctx.abort()` 表达取消请求；不得无运行时证据声称所有 transport 都保证未发送。

不得增加 `bridgeCalled`、已解析标志、全局 lastResolvedPrompt 或消费令牌来跳过校验。

### 一致性的比较边界

设 `T_a` 为 Pi 对 API a 的正常序列化，`P_a` 为 Larva provider 投影。在当前支持的正常槽映射及相同状态下：

`P_a(T_a(C(S, B)), S)` 必须为 `unchanged`。

新接口返回 Larva 处理后的 Context 系统指令字符串，不返回整个 provider payload。Anthropic OAuth 身份、角色映射和空输入时的 provider 默认文案由 Pi/provider 拥有，不算 Larva 新增指令。验收应同时比较目标文本和投影是否改写，避免把宿主附加内容误计成 Larva 不一致。

该保证不覆盖解析之后其他扩展再次改写指令或改变 payload 结构的情况，也不承诺任意第三方扩展加载顺序的全局最终字符串一致。

## 六、初始化、reload 与 teardown

监听器通过唯一的 `pi.events.on()` 订阅，不沿用为旧接口枚举 `pi.events`、`pi.eventBus`、`ctx.events`、`pi.on` 等候选注册面的做法。

- 扩展注册阶段同步建立监听器，此时可回复 unavailable；不等到异步 persona 初始化完成才首次提供响应。
- 同一扩展实例重复 setup 必须保持一个有效订阅。注销函数归该实例所有。
- `session_start` 根据当前会话初始化结果建立就绪状态；重新进入初始化时不得使用旧实例身份作为回退。
- `session_shutdown` 的同步部分先使解析状态失效并注销该监听器，再进行既有异步清理。重复清理安全，不调用总线 clear 或清除其他扩展的监听器。
- 使用 Pi 0.85.1 公开的 `session_shutdown` reason 与新的 `session_start` reason 处理 reload/new/resume/fork；不靠臆测的独立 `reload` 事件。
- reload 后新实例拥有新状态和订阅。旧实例尚未完成的异步初始化不得使其重新就绪或重新注册。
- Pi 的自动订阅失效是宿主保障；Larva 仍负责自身就绪状态和显式清理。产品不得调用 loader 内部 invalidate 或访问其订阅集合。

## 七、Nunc 集成边界说明

以下定义未来消费者应遵循的合同，不是对接收方的执行指令。

主模型请求的请求级 Context 应使用本次同步返回的 systemPrompt 进行容量准入，并让同一个 Context 进入 provider 序列化和 usage receipt 关联。若容量检查使用解析前字符串，而发送使用解析后字符串，此接口无法提供所需一致性。

调用位置应在该次请求可见的 prompt 变更完成之后、容量检查之前。工具循环、重试和 idle callback 所触发的每次主模型请求均按本次状态解析，不能只在用户输入或 before_agent_start 时解析一次。

unavailable、无回复或协议错误均不允许复用上次解析值；具体拒绝本次请求还是保守降级由 Nunc 自身产品合同决定。若降级依赖末端身份修正，Nunc 必须继续按实际输入变化判定 receipt 可用性，不能宣称已获得稳定输入。

maintenance/压缩请求保持自己的系统指令，不调用此 main 接口。收到方案不授权 Nunc 修改代码、运行上述流程或建立计划。

## 八、行为验收边界

测试调用真实组合逻辑和实际注册的公开监听器。测试数据可使用短 persona fixture，但验证对象为完整输出、投影结果、状态转换和副作用观测；标记数量只能作为辅助断言。

| 场景 | 必须观察的结果 |
|---|---|
| 同 persona，无 continuation | 完整字符串固定点，第二次 provider 投影 unchanged |
| 同 persona，有运行中 continuation | before_agent_start、事件解析、provider 目标文本一致；无段落移动；第二次投影 unchanged |
| A 借用 B 后恢复 A | 以真实切换和 agent_end 驱动；B 指令块删除，输出等于当前 A 组合结果 |
| continuation 尚未开始、结束或被手动切换清除 | 不提前注入；结束后解析旧输入会删除旧 continuation，且后续为固定点 |
| 已初始化无 persona | 清理旧 persona、identity policy、continuation；纯基础输入原样保留 |
| 基础正文保留 | 前后及受管块之间的正文、内部空白、Unicode 和有意重复段落不丢失或额外复制 |
| 解析后发生真实 persona/mode/continuation 变化 | provider 仍投影成新状态，不受先前接口调用影响 |
| 同步回复及错误 | emit 返回当场回复数为一；未就绪/组合失败为 unavailable；微任务后无第二次回复 |
| reply 抛错或再次发起独立解析 | 每个有效请求一次调用尝试，异常隔离，无跨请求回调混淆 |
| 只读 | 稳定状态下多次解析前后，lease、continuation、切换计数、消息队列和会话记录不变；不触发 CLI/文件/网络/工具刷新 |
| 初始化和恢复交错 | 中间不完整状态返回 unavailable；完成后返回当前完整状态 |
| reload/new/resume/fork/teardown | 旧监听器消失，新实例只回复一次；旧异步完成不恢复旧身份；其他扩展订阅存活 |
| provider 适配回归 | 各现有 API 正常槽满足 unchanged；非目标 payload 字段保持；未知/损坏槽不被猜测性改写 |
| 损坏受管边界 | 能明确处理的兼容形式不丢正文；有歧义时显式失败 |

同步性需覆盖 Pi 实际 EventBus，不能只用会 await handler 的假总线。生命周期需有真实 Pi reload 的扩展集成证据；可使用隔离会话及受控 provider，不需要外部模型服务或修改已安装包。

相关现有测试位置为 `contrib/pi-extension/test-idle-callback-identity-runtime.mjs`、`contrib/pi-extension/test-agent-persona-switch-policy-runtime.mjs` 及对应 `tests/shell/test_pi_*.py` 包装。可新增专用 resolver 行为测试；文件名和私有测试辅助接口由实现者选择。

后续实现的验证应包含受影响的 Node 行为测试、公开事件及生命周期集成测试和仓库要求的 Invar 检查。完整测试矩阵与具体执行记录属于实现交付证据；本文件不将这些待验证项报告为已通过。

## 九、兼容性与交付说明

未接入接口的环境继续使用两个原有 hooks。接入方无需直接导入 `larva.ts`，不依赖标记、私有函数或内部状态。无 persona 清理以及过期 continuation 删除是本次有意改变的行为；不能保留旧 early return 来满足旧测试。

建议实现文件仍为 `contrib/pi-extension/larva.ts`，对应行为测试随代码更新，`contrib/pi-extension/README.md` 描述公共事件、同步回复、不可用结果、生命周期及 main-only 边界。本设计文件提供详细理由，不替代简明消费者文档。

不新增持久化格式，不改写历史会话、不修改 registry 或共享 PersonaSpec，不对 Pi 做补丁。也不增加跨请求缓存、状态锁服务、请求令牌、Nunc 专属跳过开关或新的任务调度机制。

当前交付为设计文档和其后的 Vectl 实施计划，未启动源代码实现。后续实现的完成证据必须说明公共接口、实际修改文件、实际运行的测试与结果，以及尚未执行的 Nunc 组合验证。Orchestrator 在同一步完成程序中判断该增量的最终集成候选是否满足第八节全部适用要求；必要行为未证明或检查失败时，不得宣称该增量完成。

尚未执行 Larva 新实现测试，也未执行 Nunc 的容量准入、usage receipt、长工具循环、maintenance 隔离或自动压缩组合验证。预期收益是消除状态不变时由 Larva 末端重复组合造成的输入变化；不得据此宣称所有 CAPACITY 或自动压缩问题已经解决。

前次文档写入后运行的 `invar_guard(path="/Users/tefx/Projects/larva", changed=true)` 结果为 passed、`files_checked=0`，CrossHair 与 property tests 因无适用代码变更跳过。该证据仅涉及文档阶段，不构成新接口或行为测试通过的证据。
# Core 开发日志

## 2026-06-12 (Phase 5 §5B 检索质量评估 + §5C 写作闭环完成)

- 目标：完成 Phase 5 全部剩余工作——检索质量量化指标和完整写作闭环验证。
- 触达层级：检索管线（ContextAnalyzer/RelevantFactRetriever/FactRenderer）+ 写作闭环（NarrativeAgent + DeepSeek + Core）。
- §5C 实现内容：
  - `tests/integration/writing-loop.test.ts`（新建，9 个测试，7 个场景）：世界观构建、剧情推进、新角色登场、状态查询、手动确认、多轮协商、端到端一致性
  - 每个场景独立 Agent 实例，避免跨场景状态污染
  - 使用真实 DeepSeek API，默认在有 API key 时运行
- §5B 实现内容：
  - `tests/integration/retrieval-quality.test.ts`（新建，7 个测试）：6 个自然语言查询 + 汇总报告
  - 14 条 ground truth 标注，Recall@K + MRR 指标自动计算
  - 基准结果：R@3=0.60, R@5=0.92, R@10=1.00, MRR=0.76, 宏观召回=100%
  - 设置回归阈值（低于基准 20-30% 安全边际）
- 期间修复的关键问题（§5C + §5B 累计 8 个）：
  1. DeepSeek 思考模式 `reasoning_content` 未回传 → 400 错误
  2. `tool_call_id` 与 assistant 消息 `tool_calls[].id` 不匹配 → 400
  3. `call_id` 同一毫秒内重复 → 加随机后缀
  4. `commit_event` 成功后 pending 未清理 → `handleToolSuccess` 新增参数
  5. LLM 误调用 `commit_schema_extension` → 系统提示词禁止
  6. 跨场景状态污染 → 每个场景独立 Agent 实例
  7. 语义搜索用实体 ID 做 embedding → 新增 `ContextSignals.searchText` 传递自然语言
  8. LanceDB filter 兼容性降级 → 无过滤器重试策略
- 变更文件：`tests/integration/writing-loop.test.ts`、`tests/integration/retrieval-quality.test.ts`、`src/core/context-analyzer.ts`、`src/core/relevant-fact-retriever.ts`、`src/types/llm.ts`、`src/adapters/llm/deepseek-client.ts`、`src/agent/types.ts`、`src/agent/narrative-agent.ts`、`docs/phase5-development-plan.md`、`docs/core-development-log.md`。
- 验证结果：
  - `npm run typecheck` 零错误
  - `npm test`（不含 writing-loop）全部通过（23 文件，379 测试）
  - `npm test -- --run tests/integration/writing-loop.test.ts` 全部通过（9/9，耗时 3.5 分钟）
  - `npm test -- --run tests/integration/retrieval-quality.test.ts` 全部通过（7/7）
- Phase 5 状态：✅ 全部完成。NarrativeOS Core v0.1 所有计划功能均已实现并通过验证。

## 2026-06-12 (Phase 5 §5A Push 模式验证完成)

- 目标：验证 Phase 4 检索管线在真实多章节叙事场景中的正确性。
- 触达层级：ContextAnalyzer → RelevantFactRetriever → FactRenderer 六段管线端到端验证。
- 实现内容：
  - `tests/integration/push-mode-validation.test.ts`（新建，360+ 行，16 个测试）：
    - §5A-1 ContextAnalyzer 信号正确性（4 测试）：主要实体识别、邻近实体发现、多实体分组、空上下文降级
    - §5A-2 六段管线去重（2 测试）：所有 Fact ID 唯一、快照中 predicate 不重复
    - §5A-3 知识感知过滤（3 测试）：韩立视角过滤墨老 secret、无 POV 过滤返回完整结果、POV 不影响线索注入
    - §5A-4 空上下文降级（2 测试）：空数据库不崩溃、不存在实体不崩溃
    - §5A-5 FactRenderer 输出格式（2 测试）：Markdown 含中文实体名和章节信息、多实体渲染
    - §5A-6 多章节叙事场景检索相关性（3 测试）：诛仙剑相关检索、天劫场景近期 Fact 优先、最新状态快照
  - 测试数据：7 个实体（韩立/南宫婉/墨老/青云门/古修士洞府/诛仙剑/天劫洞），6 章叙事推进，22 条 Fact，完整 Knowledge 设置
- 关键发现：
  - 直接使用 `factStore.assert()` 写入不会自动创建 sync_queue 条目，需要在测试中手动通过 `consumer.insertEntry()` 补写
  - POV 知识过滤正确工作：韩立视角不泄漏墨老的 secret，无 POV 过滤时完整返回
  - 语义检索需向量已同步到 LanceDB 才能返回结果
- 变更文件：`tests/integration/push-mode-validation.test.ts`、`docs/phase5-development-plan.md`、`docs/core-development-log.md`。
- 验证结果：
  - `npm run typecheck` 零错误
  - `npm test -- --run tests/integration/push-mode-validation.test.ts` 通过（16/16）
  - `npm test` 全量通过（22 个测试文件，372 个测试，零回归）
- 剩余工作：
  - Phase 5 §5B：检索质量评估（Recall@K/MRR/同步延迟指标）
  - Phase 5 §5C：完整 Writing Loop 验证（端到端作者→Agent→Core→作者闭环）
  - Phase 5 §6C：MCP Server（将 ToolRouter 暴露为 MCP 兼容协议）
  - 性能基准（检索延迟 < 500ms）后置到 §5B 指标采集

## 2026-06-12 (NarrativeAgent v0.1 实现完成 + 主入口导出 + live-agent-session)

- 目标：完成 NarrativeAgent v0.1 全部代码实现（4 个源文件 + SQLite 持久化 + Mock 测试），将 Agent 层导出到主入口，创建真实 LLM 集成验证脚本。
- 触达层级：Agent 层（src/agent/）+ SQLite 持久化（src/adapters/sqlite/agent-store.ts）+ 主入口导出 + 集成验证。
- 实现内容：
  - `src/agent/types.ts`（332 行）：NarrativeAgentRuntimeState、AgentWorkingDraft、AgentPlan、AgentMemoryState、AgentMessage、AgentTraceRecord、AgentFailureReflection、AgentLongTermMemory、AgentContextSummary、CommitAuthority、UserIntent 等全部类型定义。
  - `src/agent/narrative-agent.ts`（1070 行）：NarrativeAgent 主类，实现完整 ReAct 循环（Reason→Act→Observe→Reflect）、意图检测（规则匹配中文关键词）、确认识别（CONFIRM_KEYWORDS/REVISE_KEYWORDS）、失败诊断（按错误码分类 + 重复失败升级为 abort_turn）、草案生命周期管理（collecting→revising→proposed→ready_to_commit→committed/abandoned）、提交主权（explicit_user_confirmation/agent_authorized_for_task/agent_authorized_for_session）、工具循环监管（maxToolSteps + maxRepeatedToolFailure）、上下文构建（注入长期记忆 + 压缩摘要 + 草案状态 + pending proposal）。
  - `src/agent/memory-manager.ts`（305 行）：MemoryManager 类，跨会话长期记忆管理——getActiveMemories/getMemorySummaryForLlm/hasMemory/addMemory/extractFromCompletedDraft/extractPreference/archiveOldMemories/supersedeMemories。v0.1 使用规则匹配（正则提取中文偏好表达），后续可升级为 LLM 语义提取。
  - `src/agent/context-compressor.ts`（263 行）：ContextCompressor 类，自动上下文压缩——maybeCompress/shouldCompress/executeCompression。策略：消息数 ≥30 或字符估算超 token 预算时触发，压缩 earliest 到 latest-5 的消息范围，提取关键决策和未解决问题生成摘要，标记原消息 compressed=true（visibleToLlm=false，但原文仍保留）。
  - `src/adapters/sqlite/agent-store.ts`（636 行）：SQLiteAgentStoreAdapter 类，7 张表（agent_sessions/agent_turns/agent_working_drafts/agent_traces/agent_messages/agent_context_summaries/agent_memories）完整 CRUD，含外键约束和全覆盖索引。
  - `tests/agent/mock-llm.ts`（76 行）：MockLLMClient，按序返回预设响应，记录所有调用历史供测试断言。
  - `tests/agent/narrative-agent.test.ts`（518 行）：13 个集成测试，覆盖 12 个验收场景（纯文本/状态查询/多轮草案/未确认提交/确认提交/授权自动提交/工具失败/重复失败/确认识别/Trace 审计/空数据库降级/会话生命周期/Draft 管理）。
- 设计决策：
  - NarrativeAgent 不直接读写 Core 内部表，不绕过 ToolRouter 修改世界状态——所有写入必须通过 propose_event → commit_event 通道。
  - 提交主权归用户：默认 explicit_user_confirmation，只有用户明确确认或 agent_authorized_for_session 模式下才自动提交。
  - 工具失败后必须先反思再继续：diagnoseFailure 按错误码分类（SCHEMA_VALIDATION_FAILED/ENTITY_NOT_FOUND/FACT_NOT_FOUND/PROPOSAL_NOT_FOUND/STATE_VERSION_CONFLICT/RULE_VIOLATION 等），生成确定性诊断和修复建议。
  - 重复失败升级：同一工具连续失败 3 次触发 abort_turn，防止无限重试。
  - Agent trace 写入项目数据库（agent_traces 表），只记录关键步骤的可审计摘要，不保存完整隐藏推理链。
  - 长期记忆只记录协作偏好和项目决策，不替代 Core Fact——角色/地点/事件的正式状态仍必须写入 Core。
- 变更文件：`src/agent/types.ts`、`src/agent/narrative-agent.ts`、`src/agent/memory-manager.ts`、`src/agent/context-compressor.ts`、`src/adapters/sqlite/agent-store.ts`、`tests/agent/mock-llm.ts`、`tests/agent/narrative-agent.test.ts`、`tests/live-agent-session.ts`、`src/index.ts`、`package.json`、`docs/core-development-log.md`。
- 验证结果：
  - `npm run typecheck` 零错误
  - `npm test` 全量通过（21 个测试文件，356 个测试，零回归）
  - `npm test -- --run tests/agent/narrative-agent.test.ts` 通过（13/13）
- 剩余工作：
  - Phase 5 §5A：Push 模式端到端验证（验证 Phase 4 检索管线 + LLMClient 集成）
  - Phase 5 §5B：检索质量评估（Recall@K/MRR 指标）
  - Phase 5 §5C：完整 Writing Loop 验证（端到端作者→Agent→Core→作者闭环）
  - Phase 5 §6C：MCP Server（将 ToolRouter 暴露为 MCP 兼容协议）

## 2026-06-12 (NarrativeAgent 智能体设计定稿)

- 目标：将“Core 之上的智能体会话层”从临时 live 脚本和 ProjectSession 概念混用中独立出来，形成可实现的 NarrativeAgent 内部设计文档。
- 触达层级：LLM bridge 之上的 Agent 设计层；本次只写设计文档，不改 Core 运行时代码。
- 设计决策：
  - 智能体层统一命名为 `NarrativeAgent`；保留现有 `ProjectSession` 作为 Core 内部上下文对象，避免概念冲突。
  - NarrativeAgent 采用内部 ReAct 循环：Reason / Act / Observe / Reflect / Respond，但对用户只输出自然语言，不暴露完整思维链。
  - 提交主权归用户；`commit_event` 是受授权动作，默认 `explicit_user_confirmation`，live 验证可使用 `agent_authorized_for_session`。
  - 明确区分 `draft`、`proposal`、`committed`：多轮协商先维护 working draft，只有用户确认或授权后才提交为正式世界状态。
  - 工具失败后必须先反思再继续，反思由确定性诊断和 LLM 语义修复共同完成。
  - Agent trace 写入项目 SQLite 数据库并跟随项目，只保存行为、观察、反思、决策和结构化细节摘要，不保存完整隐藏推理链。
  - 旧的 `docs/Agent-Orchestration-Layer.md` 保留为历史草稿 / v0.2 参考，不作为 v0.1 实现主线；其中 L1/L2/L3 熔断、retrieval-aware 策略和多智能体设想后续可按需吸收。
  - v0.1 目标从“基础工具循环”提升为“完整单智能体闭环”：在不做 MCP/UI/多 Agent 的前提下，必须覆盖动态计划、跨 turn 草案演化、确认识别、提交授权、失败反思、trace 审计和 live 授权自动提交。
  - 完整消息原文持久化、自动上下文压缩、跨会话长期记忆纳入 v0.1 必做范围：消息原文用于恢复，压缩摘要用于控制上下文窗口，长期记忆仅记录协作偏好和项目决策，不替代 Core Fact。
  - 明确实现边界：NarrativeAgent 不写入 `src/core`，应位于 `src/agent`；agent_* 表可以作为同项目 SQLite 数据库中的 sidecar metadata，但 Core 内核、规则引擎和事件提交不得依赖这些表。
- 变更文件：`docs/NarrativeAgent-Design.md`、`docs/Agent-Orchestration-Layer.md`、`docs/core-development-log.md`。
- 验证结果：文档变更，无运行时代码；未运行测试。
- 剩余风险 / 下一依赖：下一步应按该文档实现 `NarrativeAgent` v0.1，并为 trace 表、工具循环、失败反思、pending proposal 和提交授权补充 Mock LLM 测试。

## 2026-06-12 (live Agent 行为验收收紧)

- 目标：根据真实 `npm run live` 输出修复会话验证脚本的伪绿风险：重复同一工具错误、未提交 proposal、摘要 `[object Object]` 都不能被静默吞掉。
- 触达层级：LLM bridge 验证脚本 / Agent 行为雏形，不触碰 Core 写入语义。
- 设计决策：
  - 工具失败现在会注入 `correction_hint`，要求 LLM 不要原样重复失败参数；同一工具错误累计 3 次会记为 fatal failure。
  - live 维护 `pendingProposalIds`，每次 `propose_event` 成功加入待提交集合，`commit_event` 成功后移除；结束时若仍有未提交 proposal，则 live 失败。
  - `MAX_TOOL_TURNS` 提升到 32，符合“业务上不限制工具轮次”的方向，但仍保留运行时防失控安全阀。
  - 任何工具错误都会让 live 最终判定失败；只有零工具错误、零未提交 proposal、手工闭环成功时才输出“验证完成 ✅”。
  - 会话总结使用 `formatLiveFactValue` 渲染对象值，避免 EntityRef 或复杂值显示为 `[object Object]`。
- 变更文件：`tests/live-session.ts`、`docs/core-development-log.md`。
- 验证结果：
  - `npm run typecheck` 通过。
  - `npm test -- --run tests/integration/deepseek-client.test.ts tests/integration/tool-router.test.ts` 通过（2 个测试文件，31 个测试）。
  - `npm run live` 联网真实 DeepSeek 会话通过：全程无工具警告，所有 `propose_event` 均提交，最终 21 条当前 Fact，摘要无 `[object Object]`。
- 剩余风险 / 下一依赖：这些机制仍在 live 验证脚本里；下一步应抽象为正式 `ProjectSession` / Agent 编排层，统一管理消息、工具循环、纠错提示、pending proposal 与验收策略。

## 2026-06-12 (live 会话输出与验收诚实性修复)

- 目标：修复 `npm run live` 在纯文本回复回合吞掉 assistant 内容的问题，避免第 3 轮状态确认直接跳到第 4 轮；同时让 live 验证在手工闭环失败时返回失败，而不是继续打印“验证完成”。
- 触达层级：LLM bridge 验证脚本输出层，不触碰 Core 状态写入语义。
- 设计决策：
  - 对非流式 `chatWithTools` 返回增加 `printAssistantContent`，当 LLM 直接返回文本而非 tool call 时立即打印内容；流式路径仍由 token 回调实时输出。
  - live 脚本记录 `register_entity` 返回的主角实体 ID，手工闭环优先使用真实 `protagonistId`，避免模型传中文名时生成 `ent_韩立` 后，脚本仍硬编码 `ent_hanli` 造成外键失败。
  - 记录工具调用警告与手工闭环 fatal failure；若手工 `propose_event/commit_event` 失败，最终输出“验证失败”并设置 `process.exitCode = 1`。
- 变更文件：`tests/live-session.ts`、`docs/core-development-log.md`。
- 验证结果：
  - `npm run typecheck` 通过。
  - `npm test -- --run tests/integration/deepseek-client.test.ts tests/integration/tool-router.test.ts` 通过（2 个测试文件，31 个测试）。
  - `npm run live` 联网真实 DeepSeek 会话通过：第 3 轮文本已正常打印，手工 Core 闭环使用真实主角 ID 成功提交，最终输出“验证完成 ✅”。
- 剩余风险 / 下一依赖：live 脚本仍是验证脚本，不是正式会话编排器；后续 ProjectSession 层应把“纯文本输出不可吞、工具失败不可伪绿、实体 ID 必须从 Core 返回值传递”固化为通用协议。

## 2026-06-12 (npm 配置警告清理)

- 目标：消除 `npm warn Unknown project config "shamefully-hoist"` 噪音，避免测试输出长期混入非错误警告。
- 触达层级：项目包管理配置，不触碰 Core 运行时。
- 设计决策：`shamefully-hoist` 是 pnpm 配置，不应放在 npm 会读取的 `.npmrc` 中；将其迁移为 `pnpm-workspace.yaml` 的 `shamefullyHoist: true`，保留 pnpm hoist 行为，同时删除 `.npmrc`。
- 变更文件：`pnpm-workspace.yaml`、`.npmrc`、`docs/core-development-log.md`。
- 验证结果：
  - `npm run typecheck` 通过，且不再输出 `shamefully-hoist` 警告。
  - `npm test -- --run tests/integration/deepseek-client.test.ts tests/integration/tool-router.test.ts` 通过（2 个测试文件，31 个测试），且不再输出该警告。
- 剩余风险 / 下一依赖：未运行全量测试；本次仅配置清理，功能风险低。

## 2026-06-12 (DeepSeek 复杂参数 Tool Calling 修复)

- 目标：修复真实 LLM 集成中 `propose_event` 被错误归因于 DeepSeek“不支持复杂参数”的问题，将 Tool Interface 从字符串化 JSON 恢复为结构化数组输入。
- 触达层级：LLM bridge / Tool Router / 写入流入口契约。
- 设计决策：
  - `propose_event` 的 LLM-facing schema 改为优先暴露 `fact_changes: FactChangeInput[]`，每个元素用 JSON Schema 描述 `change_id/op/target_fact_id/subject/predicate/value` 等字段，降低模型手写转义 JSON 的负担。
  - `ToolRouter.execute` 保留旧版 `changes` JSON 字符串兼容路径，但新 schema 的 required 字段改为 `fact_changes`，避免 live prompt 继续教模型使用坏契约。
  - `DeepSeekLLMClientAdapter` 新增 DSML 文本工具调用兜底解析：当 DeepSeek 未返回原生 `message.tool_calls`，而是在正文中输出 `<｜｜DSML｜｜tool_calls>` 时，适配器统一转换成 `toolCalls`，调用方无需关心退化格式。
  - `tests/live-session.ts` 的 system prompt 与手工闭环改为传结构化 `fact_changes` 数组，并将续答改成工具循环；每个 assistant tool_call 都会收到 tool 响应，避免下一轮触发 DeepSeek/OpenAI 协议 400。
- 变更文件：`src/adapters/llm/deepseek-client.ts`、`src/core/tool-router.ts`、`tests/integration/deepseek-client.test.ts`、`tests/integration/tool-router.test.ts`、`tests/live-session.ts`、`docs/core-development-log.md`。
- 验证结果：
  - `npm run typecheck` 通过
  - `npm test -- --run tests/integration/tool-router.test.ts tests/integration/deepseek-client.test.ts` 通过（2 个测试文件，31 个测试）
  - `npm test` 联网重跑通过（20 个测试文件，342 个测试）
  - `npm run live` 联网真实 DeepSeek 会话通过：DeepSeek 实际完成 `get_context_slice → propose_event(fact_changes 数组) → commit_event` 多轮写入闭环，最终 23 条当前 Fact。
- 剩余风险 / 下一依赖：
  - DeepSeek 仍可能把参数名写成近义别名（如 `event_summary`），当前仅对 `event_description` 做最小别名兼容；后续 ProjectSession 层应增加更系统的工具参数纠错回合。
  - live 脚本现在能验证闭环，但还不是正式会话编排器；后续 MCP/ProjectSession 层应复用同样的“工具调用必须闭合”协议约束。

## 2026-06-12 (Phase 3/4 状态同步 + 开发序列规划)

- 目标：同步计划文件与实际代码状态，消除 Phase 3/4 计划文件中"未开始"标记与已完成实现的错位。
- 触达层级：Phase 3/4 两个开发计划文件的全面状态更新。
- 发现：
  - Phase 3 计划文件标记 Tool 6/9/10 为"未实现"，但实际上 ProposalManager.resolveThread（Tool 6）和 SchemaExtensionManager（Tool 9/10）已全部实现并通过测试。
  - Phase 3 计划文件标记 Phase 3C（Tool 接入 FactRenderer）三个步骤全部"未开始"，但 ToolService 已完整实现 getContextSlice/getOpenThreads，均已接入 FactRenderer。
  - Phase 4 计划文件标题注明"4A-D 已完成，4E 进行中"，但所有子步骤状态标记仍为"⬜ 未开始"，且 end-to-end.test.ts 已存在并通过。
- 执行动作：
  - `docs/phase3-development-plan.md`：更新头部为"✅ 全部完成"，Tool 表格 10 个全部标记完成，Phase 3C 三步状态 + 验收条件全部更新，完成标准全部勾选。
  - `docs/phase4-development-plan.md`：更新头部为"✅ 全部完成"，4A-4E 共 6 个 Step 全部从"⬜ 未开始"→"✅ 已完成"，补充实现文件引用和完成标准章节。
  - `docs/core-development-log.md`：新增本条记录。
- 验证结果：
  - `npm run typecheck` 通过
  - `npm test` 全量通过（18 个测试文件，312 个测试）
- 当前结论：Phase 0-4 全部完成。剩余工作：Phase 5 LLM 集成（DeepSeek LLMClient + ProjectSession + MCP 工具暴露 + 完整写作循环）。
- 下一阶段：Phase 5A LLMClient 适配器（DeepSeek API 实现 `LLMClient` 接口）。

## 2026-06-11 (架构审计修复)

- 目标：修复 Phase 0-2 架构交叉验证中发现的 4 个 ❌ 项 + 3 个 ⚠️ 项。
- 触达层级：RuleEngine.validateConsistency 后验校验、commitEvent Phase B 流程、DDL 索引补齐、RetconEngine 跨作用域上下文 & BFS 启发式 & 系统事件 params。
- 设计决策：
  - validateConsistency 实现为诊断性后验审计（非阻塞）：重新运行约束规则并检查已死亡实体仍有活跃 Fact 的矛盾。违规写入 audit_log（severity='warning'），commitEvent 不因此回滚——真正的约束检查已在 Phase A 沙盒推演完成。
  - commitEvent Phase B 新增 Step 4.5（Knowledge → validateConsistency → dependencies），对齐架构文档 §10.1 数据流。
  - DDL 补齐 3 个索引：idx_knowledge_confidence、idx_threads_related_entities (json_extract)、idx_threads_upstream_fact (json_extract)。后两者为 OBSOLETE 批量扫描和关联实体查询预留。
  - RetconEngine.crossScopeScan：targetContext 从硬编码 'global' 改为使用 targetEvent.context——当 Retcon 目标在非 global 作用域时，跨作用域基线正确。
  - BFS 兜底路径新增 `evt.params.subject === fact.subject` 客户端二次校验。
  - retcon 系统事件 params 新增 retconProposalId/contestedFactIds；Thread 处理后通过 json_set 补充 reactivatedThreadIds。
- 变更文件：`src/types.ts`（+ValidationReport/ConsistencyViolation）、`src/core/rule-engine.ts`（+validateConsistency）、`src/core/proposal-manager.ts`（+Step 4.5 后验校验）、`src/adapters/sqlite/fact-store.ts`（+3 DDL 索引）、`src/core/retcon-engine.ts`（4 处修复 + 死代码清理）。

## 2026-06-11 (Phase 2F Retcon)

- 目标：Phase 2F Retcon（世界状态回溯变更）—— 实现 propose_retcon（BFS 级联遍历 + 影响报告）和 commit_retcon（Phase B 级联标记事务）。
- 触达层级：RetconEngine 核心类（bfsCascade + proposeRetcon + commitRetcon）、FactStore 新增 markContested/updateCertainty、EventStore BFS 查询链、Thread 恢复/废弃、cognitive_dissonance 生成、跨作用域扫描。
- 设计决策：
  - RetconEngine 为独立类(不依赖 ProposalManager)，与 commit_event 职责完全分离——前者处理历史修改的级联标记，后者处理新事件的 Fact 写入。
  - BFS 优先路径走 event_dependencies 显式依赖声明（EventStore.getByDependentFactIds），兜底路径走 subject + predicate + context 三重过滤启发式搜索。BFS 在作用域边界硬停止（`evt.context !== fact.context`）。
  - commit_retcon Phase B 使用 factStore.getDatabase() + 原始 SQL 直接访问 event_dependencies / audit_log / sync_queue，与 ProposalManager.commitEvent 采用相同模式。
  - cognitive_dissonance Thread 上限 50 条，按 confidence 降序排列——高确信度的 Knowledge 优先生成认知冲突线索。上限原因：Retcon 第 1 章初始设定可能产生 1000+ 受影响 Knowledge，全部生成 Thread 会淹没作者通知队列。
  - markContested 只更新 certainty='canonical' 的 Fact，已 contested/orphaned 的不重复标记——返回实际更新行数供调用方验证。
  - Thread reactivation：FILLED(retroactive) → UNFILLED, RESOLVED(progressive) → PLANTED，同时清除 closed_by。upstreamFactIds 匹配的未关闭 Thread → OBSOLETE。
  - 跨作用域扫描分离为报告生成阶段的操作（非 BFS 主循环）：优先路径走 event_dependencies 精确查找（🔴 deterministic），兜底路径走 subject + predicate 模糊匹配（🟡 heuristic）。
  - sync_queue 写入 `next_retry_at = datetime('now', '+2 seconds')`，与 ProposalManager 保持一致的 outbox 格式。
  - 线程里程碑（thread_milestones）独立表不存在——milestones 是 threads 表的 JSON 列，reactivation 通过 UPDATE threads SET closed_by = NULL 清除关闭事件引用。
  - getStateVersion / tryUpdateStateVersion 的 this 绑定问题：不提取方法引用（会丢失 this 上下文），直接通过 `factStore.method?.()` 调用。
- 变更文件：`src/core/retcon-engine.ts`（新建，570+ 行）、`src/adapters/sqlite/fact-store.ts`（新增 markContested + updateCertainty）、`src/types.ts`（FactStore 接口新增 contested 方法）、`docs/phase2-development-plan.md`（Phase 2F 详细 6 步骤）、`tests/integration/retcon-engine.test.ts`（新建，20 个测试）、`docs/core-development-log.md`。
- 验证结果：
  - `npm run typecheck` 通过
  - `npm test -- --run tests/integration/retcon-engine.test.ts` 通过（20/20）
  - `npm test` 全量通过（12 个测试文件，257 个测试，零回归）
- 剩余风险 / 下一依赖：
  - 跨作用域扫描的兜底路径（启发式匹配）精度有限——subject + predicate 相同即匹配，不检查 value 语义，结果仅供作者参考。优先路径（event_dependencies）是确定性的。
  - 启发式 BFS 的"语义依赖但结构无痕"漏判仍然存在（如：李四因搜魂得知戒指存在→派兵去洞穴，但事件参数里无 `holds_item`）。完整 DependencyGraph（CausalTracer）是 Retcon 精度提升的下一个里程碑。
  - LanceDB certainty 更新（sync_queue outbox）当前仅写入队列，后台 worker 消费尚未实现——存在"幽灵检索"风险窗口（contested Fact 的向量未被更新为 contested）。内存级 contested 黑名单也未实现（Phase 3 引入）。
  - 级联报告的跨作用域区块展示的是 Fact ID，未调用 FactRenderer 渲染为可读文本——Phase 3 FactRenderer 接入后改善。
  - Phase 2F Retcon 完成标志着 Phase 2 全部完成。下一步：Phase 3 FactRenderer → 10 个 LLM Tool Interface。

## 2026-06-10

- 目标：基础审查修补 + Phase 2B ThreadResolver 核心判定引擎实现。
- 触达层级：KnowledgeStore SQL 查询安全、FactStore 查询语义修补、类型系统去重、ThreadResolver 四方法 + 状态机校验。
- 设计决策：
  - KnowledgeStore getKnownFacts / getActiveKnowledge / getKnowersOfFact 三个方法的"取最新"查询从 MAX(known_since)+MAX(rowid) 自连接改为关联子查询 `ORDER BY known_since DESC, rowid DESC LIMIT 1`。原方案中两个 MAX 独立计算可能选出不存在于同一行的组合，导致空结果。新方案保证选出的确实是同一条记录。
  - FactStore.query() 在未传 atChapter 时补充 `valid_to IS NULL` 条件，使默认行为（只返回当前有效 Fact）与注释一致。此前无 atChapter 的调用会返回所有历史 Fact。
  - 删除 proposal-manager.ts 中本地定义的 KnowledgeHint / KnowledgeBroadcast 接口（source 字段类型为 string），统一使用 types.ts 的导出版（source 字段类型为 KnowledgeSource），消除类型精度降级和维护分叉风险。
  - ThreadResolver 实现为纯逻辑组件（I-9 不变式：不调用 FactStore/KnowledgeStore/ThreadStore 写入方法），四个核心方法接收已加载的数据做判定：
    - isThreadClosable：逐项检查 closeCondition（requiredEventType / withinChapters / minHints / customRule），customRule 固定返回 false 只能显式关闭。
    - resolveThreads：双通道关闭（自动 isThreadClosable + 显式 thread_resolutions），去重合并，返回 ThreadResolutionAction[] 供调用方操作 ThreadStore。
    - getExpiringThreads：回溯型线索 deadline 预警，默认窗口 5 章。
    - getHintableThreads：渐进型 PLANTED/HINTED 线索与事件关联实体的交集判定。
    - validateTransition：基于回溯型/渐进型两张转换表校验状态机合法性，HINTED→HINTED（多次暗示）为唯一允许的同状态转换。
  - ThreadResolutionAction 包含 channel / newStatus / needsMilestone / milestoneChapter 等字段，调用方（ProposalManager.commitEvent）凭此直接操作 ThreadStore，无需重复计算。
- 变更文件：`src/adapters/sqlite/knowledge-store.ts`、`src/adapters/sqlite/fact-store.ts`、`src/core/proposal-manager.ts`、`src/core/thread-resolver.ts`（新建）、`tests/integration/thread-resolver.test.ts`（新建）、`docs/core-development-log.md`。
- 验证结果：
  - `npm run typecheck` 通过
  - `npm test -- --run tests/integration/thread-resolver.test.ts` 通过（50/50）
  - `npm test` 全量通过（10 个测试文件，221 个测试）
- 剩余风险 / 下一依赖：
  - Phase 2C：将 ThreadResolver + ThreadStore 接入 ProposalManager.commitEvent 的 Phase B 事务（Thread 持久化 + 自动/显式关闭）。
  - Phase 2D：知识传播合并优先级（knowledge_hints > knowledge_broadcast > propagation > subject_auto）。
  - Phase 2E：QueryEngine.findThreads 接入。

## 2026-06-10

- 目标：Phase 2C commit_event 集成 ThreadResolver + ThreadStore——完成 Thread 生成、双通道关闭、知识四梯队合并、findThreads 查询、真实场景测试。
- 触达层级：ProposalManager Phase B 事务扩展（Thread 创建→ThreadResolver 双通道→Knowledge 四梯队合并）、QueryEngine findThreads/getExpiringThreads、6 个真实修仙叙事场景端到端验证。
- 设计决策：
  - Phase B 事务执行顺序：乐观锁 → Event → FactGroup → Thread 创建 → ThreadResolver 双通道 → Knowledge 四梯队合并 → 依赖边 → audit → sync_queue。Thread 创建在 FactGroup 之后、ThreadResolver 之前；ThreadResolver 在 Knowledge 写入之前（保证新创建的线索不参与本轮关闭）。
  - 双通道关闭：ThreadResolver.resolveThreads 返回 ThreadResolutionAction[]，commitEvent 遍历执行 updateStatus/addMilestone。自动通道 isThreadClosable 匹配 closeCondition；显式通道参数 thread_resolutions 跳过 closeCondition 直接关闭。两条通道去重合并（自动优先）。
  - 修复 `threadResolutions` 参数未传递到 event.resolvedThreads 的 bug（原先 `resolvedThreads: []` 硬编码为空数组，导致显式关闭通道失效）。
  - knowledgeHints / knowledgeBroadcast 在 proposeEvent 时保存到 ProposalResult，commitEvent 时解析为 ProposedKnowledge。
  - 四梯队合并：knowledge_hints(3) 先 push → knowledge_broadcast(2) 次之 → propagation(1) 最后。mergeKnowledgeByPriority 使用 Map + first-wins 策略（先到先占 → 高 tier 优先级自然保证）。
  - buildHintKnowledge：factIndex 精确匹配或省略时全量应用到所有 assert/update change。buildBroadcastKnowledge：Phase 1 MVP 只支持 explicit_entities visibility。
  - findThreads 薄封装 ThreadStore.getByFilters；getExpiringThreads 调用 ThreadResolver.getExpiringThreads。未注入时抛出 THREAD_QUERY_UNSUPPORTED 错误（向后兼容）。
  - 真实场景测试覆盖 6 个修仙叙事场景：渡劫突破（Fact 更新 + Knowledge 传播）、同场景目击（witness_propagation）、死亡实体违规（RuleEngine Thread 生成）、伏笔自动关闭（ThreadResolver 双通道）、记忆封印/恢复（knowledge_changes seal/restore）、知识广播与细粒度覆盖（四梯队合并）。场景使用完整引擎栈（FactStore + KnowledgeStore + EventStore + ThreadStore + ThreadResolver + RuleEngine + ProposalManager）。
- 变更文件：`src/core/proposal-manager.ts`（Thread 创建/关闭 + 知识合并 + 3 个新方法）、`src/core/query-engine.ts`（findThreads + getExpiringThreads）、`src/types.ts`（ProposalResult 新增 hints/broadcast、QueryEngine 新增 findThreads）、`tests/integration/proposal-commit.test.ts`（+6 测试）、`tests/integration/query-engine.test.ts`（+3 测试）、`tests/integration/real-world-scenarios.test.ts`（新建，7 个真实场景测试）、`docs/phase2-development-plan.md`、`docs/core-development-log.md`。
- 验证结果：
  - `npm run typecheck` 通过
  - `npm test` 全量通过（11 个测试文件，237 个测试，+16 新增）
  - 11 个测试文件：types(18) + lancedb-schema(22) + fact-store(35) + knowledge-store(28) + proposal-commit(25) + query-engine(11) + rule-engine(15) + thread-resolver(50) + thread-store(39) + real-world-scenarios(7) + spike2(8)
- 剩余风险 / 下一依赖：
  - Phase 2F 决策点：先做 Retcon（依赖完整 DependencyGraph）还是跳到 Phase 3（FactRenderer → 10 个 LLM Tool Interface）
  - knowledgeBroadcast 的 faction_members / scene_participants visibility 需阵营成员表和场景参与者数据（Phase 3+）
  - ProposalManager 的 stateVersion 硬编码 projectId='default'，多项目支持需把 projectId 作为构造参数
- 触达层级：逐项核验六个接口方法、ID 生成策略、cst_ 兼容、JSON 安全反序列化、relatedEntity 精确匹配、I-9 边界。
- 验证结果：
  - `npm run typecheck` 通过
  - `npm test -- --run tests/integration/thread-store.test.ts` 通过（39/39）
  - `npm test` 全量通过（9 个测试文件，171 个测试）
  - 六个方法完整覆盖：create / getById / updateStatus / addMilestone / getOpen / getByFilters
  - 构造函数接收共享 better-sqlite3 Database 实例，复用 FactStore 同库连接
  - ID 生成：thr_{slug}_{chapter}[_{seq}]，优先 tags[0]，否则 type，碰撞追序号
  - cst_ 兼容：getById / updateStatus / addMilestone 支持 cst_ → thr_ 自动映射
  - updateStatus 仅传入 closedBy 时更新 closed_by，未传入时保留已有值
  - addMilestone 联动 status / hint_count / closed_by；HINTED 递增 hint_count，FILLED/RESOLVED+eventId 设置 closed_by
  - getOpen 只返回 UNFILLED / PLANTED / HINTED / PARTIALLY_REVEALED，稳定排序
  - getByFilters 支持 direction / type / severity / status / nearChapter+window / closedByEvent / relatedEntity / arcTag / excludeArcTags
  - relatedEntity 通过反序列化后 includes() 精确匹配，不使用 SQL LIKE
  - JSON 反序列化失败抛出包含字段名和 thread id 的可读错误
  - 测试覆盖 create+getById 往返、cst_ 兼容、updateStatus 关闭线索、addMilestone 全联动、getOpen 排除终态、getByFilters 全维度、I-9 边界
- 变更文件：`docs/core-development-log.md`（仅本日志更新）
- 剩余风险：
  - addMilestone 不校验状态转换合法性（如 FILLED 回到 PLANTED），应在 ThreadResolver 层校验
  - ThreadResolver、Retcon 级联关闭、Rule Engine 自动关闭、语义检索、LLM 逻辑、QueryEngine.findThreads 不在本阶段范围
  - codex-with-cc finalize implementer `finalize-thread-store` 已完成，RunId `20260610_235410_156_7fe15a14` 通过 `verify_delegate_run`
  - codex-with-cc workflow `phase2a-thread-store-finalize` 尚未正式通过 `verify_delegate_workflow`：用户已明确允许外部 Claude 审查委派，但租户安全策略仍拒绝 spec / quality reviewer 与 final-verifier 将私有工作区代码发送给未验证外部目的地；当前由主线程本地复核与测试兜底

- 目标：实现 Phase 2A SQLiteThreadStoreAdapter 最小生命周期存储——create / getById / updateStatus / addMilestone / getOpen / getByFilters。
- 触达层级：threads 表的写入/读取适配器、ID 生成策略、cst_ 前缀兼容、JSON 字段安全反序列化、里程碑状态联动、I-9 不变式边界验证。
- 设计决策：
  - ID 生成采用 `thr_{slug}_{chapter}[_{seq}]` 格式，优先使用 tags[0]，否则使用 type 作为 slug 片段，对非字母数字字符做下划线清洗。同 base ID 已存在时追加递增序号，与 KnowledgeStore 的消歧策略一致。
  - cst_ 前缀兼容：getById / updateStatus / addMilestone 先尝试原始 ID，若不存在且为 cst_ 前缀则自动映射为 thr_ 再查。新建 ID 永远使用 thr_ 前缀。
  - addMilestone 在追加里程碑时联动更新 Thread 的 status、hint_count（HINTED 递增）和 closed_by（FILLED/RESOLVED 且带 eventId 时设置）。里程碑 ID 格式为 `ms_{threadRef}_{seq}`。
  - JSON 字段反序列化使用 parseJsonField 辅助方法，解析失败时抛出包含字段名和 thread id 的可读错误，不静默返回错误对象。
  - getByFilters 的 relatedEntity 过滤先走普通 SQL 条件缩小候选集，再反序列化 `related_entities` 后用数组 `includes` 精确匹配，避免 SQL LIKE 中 `_` / `%` 通配符造成实体 ID 误匹配；这一点由主线程验收复核时补强。
  - getOpen 使用硬编码的 OPEN_STATUSES 常量（UNFILLED / PLANTED / HINTED / PARTIALLY_REVEALED），确保终态排除逻辑集中维护。
- 变更文件：`src/adapters/sqlite/thread-store.ts`、`tests/integration/thread-store.test.ts`、`src/index.ts`、`docs/core-development-log.md`。
- 验证结果：
  - `npm run typecheck` 通过
  - `npm test -- --run tests/integration/thread-store.test.ts` 通过（39/39）
  - `npm test` 全量通过（9 个测试文件，171 个测试）
  - codex-with-cc implementer `implement-thread-store` 已完成，RunId `20260610_141054_156_c46cbea3` 通过 `verify_delegate_run`
  - codex-with-cc workflow `phase2a-thread-store` 尚未正式通过 `verify_delegate_workflow`：spec / quality reviewer 因外部 Claude 审查委派的数据外传风险被审批器拒绝，当前由主线程执行本地复核与测试兜底
- 剩余风险 / 下一依赖：
  - ThreadResolver、Retcon 级联关闭、Rule Engine 自动关闭逻辑、语义检索、LLM 逻辑和 QueryEngine.findThreads 不在本阶段范围。
  - addMilestone 没有校验状态转换合法性（如从 FILLED 回到 PLANTED），这个校验应在 ThreadResolver 层而非存储层。
  - 完整 codex-with-cc workflow gate 当前受租户安全策略限制：即使用户明确批准，外部 Claude spec / quality reviewer 与 final-verifier 仍被拒绝；后续需要受信内部 reviewer 或不会外传私有代码的审查路径。

- 目标：归档 Phase 1.5A Query Layer 阶段验收状态，明确它已经作为 Phase 2 前的稳定只读读取层完成。
- 触达层级：query/state reader、Knowledge 当前态读取语义、阶段边界验收。
- 设计决策：Phase 1.5A 已完成并通过验收，当前提供 `findFacts / findKnowledge / findEvents / findEntities` 四个只读入口。`findKnowledge` 已按最终冻结语义执行：先按身份与时间条件取候选记录，再按 `(entityId, factId)` 选择 `knownSince DESC + rowid DESC` 的最新认知，最后统一应用 `includeSealed / minConfidence` 可见性过滤，避免封印记录被预过滤后旧认知错误复活。`includeHistory` 明确为历史视图，返回匹配历史记录且不做最新态去重。
- 变更文件：`src/core/query-engine.ts`、`src/types.ts`、`tests/integration/query-engine.test.ts`、`docs/core-development-log.md`。
- 验证结果：
  - `npm run typecheck` 通过
  - `npm test -- --run tests/integration/query-engine.test.ts` 通过（8/8）
  - `npm test` 全量通过（8 个测试文件，132 个测试）
  - codex-with-cc workflow `phase15a-query-hardening` 已完成 implementer、spec review、quality review、final-verifier，并通过 `verify_delegate_workflow`
- 阶段结论：Phase 1.5A 是可验收状态，可以作为进入 Phase 2 的读取层基础；`findThreads`、ThreadResolver、ThreadStore、Retcon 完整提交链、语义检索与 LLM Query 仍不属于 Phase 1.5A，后置到 Phase 2 或后续阶段。
- 剩余风险 / 下一依赖：未传 `entityId/factId` 时 Knowledge 查询可能返回较多记录；这是当前已知非阻塞风险。下一主线应进入 Phase 2 的 ThreadResolver / ThreadStore，而不是继续扩张 Phase 1.5A。

- 目标：Phase 1.5A Query Layer 覆盖补强——补齐质量审查指出的两个非阻塞缺口。
- 触达层级：`tests/integration/query-engine.test.ts` 新增组合参数测试、`src/types.ts` 的 `NarrativeKnowledgeFilter` JSDoc 澄清。
- 设计决策：新增 `entityId + factId + minConfidence` 三参数组合测试，覆盖 `getLatestKnowledge` 在同时传入两个 ID 时的交叉过滤路径（按 entityId 查 Store，再由 `pickLatestByEntityAndFact` 按 factId 过滤），确保封印记录仍被正确识别为最新态。`includeHistory` 的 JSDoc 现在明确说明：history 模式返回全部匹配记录、不做 (entityId, factId) 去重、封印可见性仍由 `includeSealed` 控制。
- 变更文件：`tests/integration/query-engine.test.ts`、`src/types.ts`、`docs/core-development-log.md`。
- 验证结果：
  - `npm run typecheck` 通过
  - `npm test -- --run tests/integration/query-engine.test.ts` 全部 8 个测试通过（含 1 个新增三参数组合测试）
  - `npm test` 全量通过（8 个测试文件，132 个测试）
- 剩余风险 / 下一依赖：同前次 `query-hardening-impl` 报告，无新增风险。

- 目标：Phase 1.5A Query Layer 补强——修复 Knowledge 最新态查询中 `minConfidence` 预过滤导致封印记录被误排除的缺陷。
- 触达层级：query-engine.ts 的 findKnowledge 默认语义、getLatestKnowledge 候选记录获取策略、pickLatestByEntityAndFact 可见性过滤时序。
- 设计决策：`findKnowledge` 的执行顺序必须是（1）按时间/身份条件从 Store 取候选记录 →（2）对每个 (entityId, factId) 取 knownSince DESC + rowid DESC 最新记录 →（3）最后统一应用 includeSealed / minConfidence 可见过滤。`minConfidence` 绝不能在步骤 1 传入 Store 的 SQL WHERE 条件——否则同一 Fact 的较新封印记录（confidence=0）会被 SQL 过滤掉，然后旧的正确信心记录被错误地当成当前认知返回。同理，history 路径也不再在 Store 层传递 `minConfidence`，而是统一由 `findKnowledge` 外层过滤器处理。封印记录（confidence <= 0）的可见性只由 `includeSealed` 控制，不受 `minConfidence` 影响。
- 变更文件：`src/core/query-engine.ts`、`tests/integration/query-engine.test.ts`、`docs/core-development-log.md`。
- 验证结果：
  - `npm run typecheck` 通过
  - `npm test -- --run tests/integration/query-engine.test.ts` 全部 7 个测试通过（含 3 个新增封印/恢复/minConfidence 语义测试）
  - `npm test` 全量通过（7 个测试文件，127 个测试）
- 剩余风险 / 下一依赖：
  - 当既无 `entityId` 又无 `factId` 时，`getLatestKnowledge` 走 else 分支只按 source/atChapter 查询，可能返回大量记录——这是现有行为，本次未改动。
  - `includeHistory` 路径不做"取最新"选择，直接返回 Store 查询结果；如果需要 history 模式也按 (entityId, factId) 去重，需后续迭代。
  - Phase 2 ThreadResolver / ThreadStore / Retcon 提交链不在此范围。

- 目标：完成 Phase 1 收尾与 Phase 1.5 启动门槛定义，冻结写入语义并收窄 Query Layer 范围。
- 触达层级：query/state reader、事件引擎验收、文档化架构边界。
- 设计决策：新增 `docs/phase-1-acceptance.md` 作为 Phase 1 验收与 Phase 1.5 启动门槛。Phase 1.5A 只实现 `findFacts / findKnowledge / findEvents / findEntities` 四个只读查询；`findThreads` 后置到 Phase 2 的 ThreadStore / ThreadResolver 起步后接入。Query Layer 不引入 LLM、Embedding、语义检索、Thread 生命周期或 Retcon 推理。
- 变更文件：`docs/phase-1-acceptance.md`、`docs/Narrative-OS-Core-Architecture.md`、`docs/core-development-log.md`。
- 验证：`npm run typecheck` 通过；`npm test` 全量通过（7 个测试文件，124 个测试）。
- 剩余风险 / 下一依赖：Phase 1.5A 实现前需要补轻量 Entity 查询能力；Thread 查询必须等 Phase 2 的 Thread 生命周期系统可用后再暴露。

- 目标：补齐 Phase 1 的基础逻辑防线，避免“测试通过但错误状态仍可入库”。
- 触达层级：事件引擎、事件时间语义、FactStore 写入校验、轻量依赖追踪、Rule Engine 提交门槛。
- 设计决策：`propose_event` 在 Phase A 增加硬校验：业务事件必须有 `subject`，`change_id` 必填/唯一/格式受限，`update/retract` 目标 Fact 必须存在、当前有效且与事件 context 一致，`dependent_fact_ids` 必须在事件章节可见。`commit_event` 拒绝 `isSafeToCommit=false` 的提案。`applyFactGroup` 不再使用 `unknown`、空字符串或第 1 章兜底，缺少基础字段直接失败；`update` 改为完整新 Fact 语义，允许 payload 覆盖 subject/predicate/value。
- 追加决策：`exit_scope` 在 Phase A 自动扫描被退出作用域中同 `subject + predicate` 的当前 canonical Fact，并将原始 Fact ID 注入 `dependentFactIds`；自动注入的依赖来源记录为 `system_exit_scope`，Phase B 写入 `event_dependencies.source`，用于后续 Retcon 跨作用域级联追踪。
- 追加决策：`knowledge_changes` 最小闭环进入 Phase 1：`ProposalResult` 保存显式认知操作，`commit_event` 在自动传播 Knowledge 之后写入 `seal/restore/decay/soul_read/implant` 产生的新 Knowledge 记录，依靠 `rowid DESC` 保证显式操作覆盖同章节自动传播。
- 变更文件：`src/types.ts`、`src/core/proposal-manager.ts`、`src/adapters/sqlite/fact-store.ts`、`src/adapters/sqlite/knowledge-store.ts`、`tests/integration/proposal-commit.test.ts`、`tests/integration/fact-store.test.ts`、`docs/Narrative-OS-Core-Architecture.md`。
- 验证：`npm run typecheck` 通过；`npm test` 全量通过（7 个测试文件，124 个测试）。
- 剩余风险 / 下一依赖：`knowledge_changes` 目前是最小写入闭环；更复杂的广播合并策略、高级 scope、实体认知能力校验仍需补强。ThreadResolver 生命周期合并仍是下一阶段重点。

## 2026-06-09

- 目标：深度检查 Phase 1 与架构文档的一致性，并修复提交链路中已发现的落盘缺口。
- 触达层级：事件引擎、EventLog / Temporal Validity、Knowledge 写入编排、轻量依赖追踪。
- 设计决策：`propose_event` 在 Phase A 保存完整 `proposedEvent`、归一化后的 `FactChange[]`、`expectedStateVersion` 与 `dependentFactIds`；`commit_event` 只消费这些已保存上下文，不再从 `proposal_id` 反推事件信息。`FactChangeInput` 未提供时间时，默认以事件章节作为 `validFrom/validTo`。`dependentFactIds` 在 Phase B 写入 `event_dependencies` 边表，`events.dependencies_json` 只作为审计冗余。
- 变更文件：`src/types.ts`、`src/core/proposal-manager.ts`、`src/adapters/sqlite/event-store.ts`、`tests/integration/proposal-commit.test.ts`、`docs/Narrative-OS-Core-Architecture.md`。
- 验证：`npm run typecheck` 通过；`npm test -- --run tests/integration/proposal-commit.test.ts` 通过。
- 剩余风险 / 下一依赖：`commit_event` 的显式 `knowledge_changes`、`exit_scope` 自动依赖注入、ThreadResolver 生命周期合并仍在 Phase 2 或后续 Phase 中，需要继续按附录 C 顺序推进。

## 2026-06-13

- 目标：Phase 7 CLI 及其下全部既有代码的全面审核与交叉审核（逐行），修复所有实际问题（P0–P3，不含误报/文档/设计权衡）。
- 触达层级：CLI 层、CoreBridge 写作层回写与访问控制、Writing Store 持久化与状态机、Core 提交管线（ID 持久化 / tags / 事务原子性 / 错误码可重试）、Core 规则/检索/retcon（推理去重 / N+1 / sync-queue 原子抢占）、Adapters（依赖注入 / LLM-embedding 超时 / embedding 失败抛错 / FactStore 类型对齐）。
- 关键修复：
  - CLI：`/auto` 死代码移除、LLM 调用加 AbortController 超时、实体 ID 正则收窄。
  - CoreBridge：消除绕过审核直接置终态的访问控制面（`_markRegistered` / `_markCommitted` 内化），失败统一标 `commit_failed`。
  - Writing Store：软删除事务化 + 查询过滤、状态机接入 service 层。
  - Core 提交：`factSeqCounters` 内存计数器改 DB COUNT（消除重启后主键冲突）、实体 `tags_json` 列、`register_entity` 事务原子化、`STALE_PROPOSAL` 纳入可重试错误码。
  - Core 检索/retcon：规则推理去重、`context-analyzer` N+1 查询消除、`sync-queue-consumer` 用 `UPDATE ... RETURNING` 原子抢占 pending→processing 并修复索引错位 bug。
  - Adapters：DeepSeek/embedding 调用加超时、embedding 失败由"静默零向量"改为抛错（避免污染 ANN 检索）、`assert` 签名与 `FactStore` 接口对齐。
- 验证期回归修复：`assert` 类型对齐时曾误将 `embeddingText` 留空 `''`，导致 sync_queue consumer 兜底拼接裸 ID 文本、push-mode §5A-6 第 5 章语义召回失败。已按架构 §3.1.2 / §2214 在 `assert` 内部生成 embeddingText（解析 `entities.name` 显示名），并补回归测试。
- 变更文件：`src/cli/**`、`src/writing/**`、`src/core/tool-router.ts`、`src/core/query-engine.ts`、`src/core/rule-engine.ts`、`src/core/context-analyzer.ts`、`src/core/sync-queue-consumer.ts`、`src/core/retcon-engine.ts`、`src/adapters/sqlite/fact-store.ts`、`src/adapters/llm/deepseek-client.ts`、`src/adapters/embedding/siliconflow-embedder.ts`、`src/types/**`、`tests/**`、`CLAUDE.md`。
- 验证：`npx tsc --noEmit` 通过（exit 0）；全量 `npx vitest run` 454 个测试中 453 确定性通过。唯一波动为 `tests/integration/writing-loop.test.ts`（真实 DeepSeek API，`describeIf` 门控）——跨三次运行分别失败场景 F / 通过 / 失败场景 E，属 LLM 非确定性 flakiness，非代码回归。
- 剩余风险 / 下一依赖：(1) LanceDB 向量存储在 Writing/Agent 层的完整接线为 Phase 7 待办（非审核 bug）；(2) 完整 FactEmbedder + WorldPackage（谓词中文名/描述增强）待后续 Phase 接入，当前 `assert` 用字段组合降级实现；(3) writing-loop 集成测试依赖真实 LLM，本质非确定，建议后续引入 LLM mock 或录制回放以稳定 CI。

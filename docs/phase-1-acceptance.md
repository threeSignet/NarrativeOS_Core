# Phase 1 验收与 Phase 1.5 启动门槛

本文档用于冻结 Phase 1 的基础写入语义，并定义 Phase 1.5 Query Layer 的最小启动范围。它不是新架构来源；权威设计仍以 `docs/Narrative-OS-Core-Architecture.md` 为准。

## Phase 1 验收结论

Phase 1 已达到进入 Phase 1.5 的最低门槛：Core 已具备可验证的写入闭环，能够把事件、事实、认知、审计、向量同步 outbox 与轻量依赖边放入同一个确定性提交流程。

已完成能力：

- `propose_event` 在 Phase A 归一化事件上下文、Fact 时间、依赖声明与显式认知操作。
- `commit_event` 在 Phase B 原子写入 `events`、`facts`、`knowledge`、`audit_log`、`sync_queue`、`event_dependencies`。
- `FactStore` 支持 `assert / retract / update / applyFactGroup / query / getSnapshot / getFactsByEvent / getById / getRelationsTargeting`。
- `KnowledgeStore` 支持基础写入与查询，并已接入 `knowledge_changes` 最小闭环。
- `EventStore` 支持按 ID、章节、主体、类型、依赖 Fact 查询事件。
- `dependent_fact_ids` 已落盘到 `event_dependencies`，并区分 `llm` 与 `system_exit_scope` 来源。
- `exit_scope` 会自动把原始作用域 Fact 注入依赖边，避免跨作用域 Retcon 断链。
- `knowledge_changes` 最小闭环已支持 `seal / restore / decay / soul_read / implant`，显式操作晚于自动传播写入。

## 已冻结的 Phase 1 写入语义

- 普通业务事件必须有 `subject`；系统事件后续另行定义。
- `fact_changes[].change_id` 必填、唯一，且只允许 `^[a-zA-Z0-9_-]+$`。
- `FactChangeInput` 不暴露 `valid_from`；默认 `assert/update.validFrom = NarrativeEvent.chapter`，`retract.validTo = NarrativeEvent.chapter`。
- `update/retract` 的目标 Fact 必须存在、当前有效，并且与事件 `context` 一致。
- `commit_event` 拒绝 `isSafeToCommit=false` 的 Proposal。
- `applyFactGroup` 不使用 `unknown`、空字符串或第 1 章作为缺失字段兜底。
- Knowledge 遵循 Event Sourcing：不删除、不原地修改，只追加新的 Knowledge 记录。
- 同一章节内自动 Knowledge 与显式 Knowledge 发生覆盖时，以后写入的显式操作为准，查询依赖 `known_since DESC, rowid DESC`。

## Phase 1 已知限制

这些限制不阻塞 Phase 1.5A，但必须在后续阶段持续跟踪：

- `knowledge_changes` 目前是最小写入闭环；高级合并策略、实体认知能力校验、高级 scope 仍待补强。
- `ThreadStore` 仍为占位；`ThreadResolver` 和 NarrativeThread 生命周期管理属于 Phase 2 主体。
- `Retcon` 完整提交链尚未实现；当前只具备轻量依赖边和跨作用域依赖追踪基础。
- `EntityStore` 尚未抽象为独立接口；当前只有 SQLite `entities` 表。
- 自然语言查询、语义检索、Query V2 不属于 Phase 1.5A。

## Phase 1.5A 最小范围

Phase 1.5A 只实现薄查询层，不引入推理、自然语言翻译、语义检索或 Thread 生命周期逻辑。

建议先实现：

- `findFacts`：封装 `FactStore.query()`，默认查询当前有效 Fact。
- `findKnowledge`：封装 `KnowledgeStore`，默认返回最新且 `confidence > 0` 的有效认知；历史查询需显式开启。
- `findEvents`：封装 `EventStore`，默认只查 `business` 事件。
- `findEntities`：先以 SQLite `entities` 表实现轻量查询，支持 `id / name / kind`。

暂缓实现：

- `findThreads`：等 Phase 2 的 `SQLiteThreadStoreAdapter` 与 `ThreadResolver` 起步后接入。

## Phase 1.5 查询默认语义

- Fact 默认 `mode='current'`，不返回已 `validTo` 的历史 Fact，除非显式指定历史模式。
- Fact 查询指定非 `global` context 时，默认允许继承 `global`；若要只查本作用域，需显式关闭继承。
- Knowledge 默认返回当前有效认知，过滤 `confidence <= 0` 的封印/遗忘状态。
- Knowledge 历史查询必须显式请求，避免把旧认知误读为当前认知。
- Event 默认只返回 `business`，系统事件需要显式指定。
- Entity 查询不推导实体状态；实体状态仍通过 Fact 查询获得。
- Thread 查询在 Phase 1.5A 不承诺，避免把未实现的生命周期系统伪装成可用能力。

## Phase 1.5 启动条件

开始实现 Query Layer 前必须满足：

- `npm run typecheck` 通过。
- `npm test` 全量通过。
- 本文档与 `docs/core-development-log.md` 保持同步。
- 新增 Query API 不修改 Phase 1 写入语义。
- 新增 Query API 不依赖 LLM、Embedding 或 LanceDB。

## Phase 1.5 验收标准

- 查询层只读，不产生任何 Fact、Knowledge、Event、Thread 副作用。
- 查询结果与底层 Store 语义一致，不做隐式推理。
- 每个 find 方法至少覆盖一个当前态查询和一个边界查询。
- `findThreads` 若暂未实现，必须明确返回 unsupported 或不暴露该方法，而不是返回误导性的空结果。

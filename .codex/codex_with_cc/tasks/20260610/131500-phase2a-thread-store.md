# Phase 2A SQLite ThreadStore Minimal Lifecycle Storage

Goal
实现 NarrativeOS Core Phase 2A 的最小 `SQLiteThreadStoreAdapter`，让 NarrativeThread 可以在 SQLite `threads` 表中创建、读取、状态更新、追加生命周期里程碑和按过滤条件查询。你是执行者，不是架构决策者；如发现范围外问题，只在报告中列为风险，不要自行扩展到 Phase 2 后续功能。

Allowed Scope
- `src/adapters/sqlite/thread-store.ts`
- `tests/integration/thread-store.test.ts`
- `src/index.ts` 仅当需要从包主入口导出 `SQLiteThreadStoreAdapter` 时可以修改
- `docs/core-development-log.md`
- 只允许读取必要的相邻文件来理解现有接口和测试风格，例如 `src/types.ts`、`src/adapters/sqlite/fact-store.ts`、`src/adapters/sqlite/event-store.ts`、`src/adapters/sqlite/knowledge-store.ts`、`tests/integration/*.test.ts`、`docs/Narrative-OS-Core-Architecture.md`

Forbidden Actions
- 不要实现或修改 `ThreadResolver`、Retcon、`commit_event` 提交链、Rule Engine 自动关闭逻辑、语义检索、LLM 逻辑或 QueryEngine `findThreads`。
- 不要让 ThreadStore 写入或修改 `facts`、`knowledge`、`events`、`event_dependencies`、`sync_queue`、`audit_log` 或 `project_state`；测试夹具为了满足外键而插入 `entities/events/facts` 可以。
- 不要把 NarrativeThread 作为 Fact/Knowledge/Event 推理输入；必须保持 I-9：Thread Never Has Causal Power。
- 不要修改 Codex 插件配置、`.codex/codex_with_cc/claude-delegate` 产物、`node_modules`、锁文件或 package 脚本。
- 不要删除或回滚他人已有改动。
- 不要引入新依赖。

Acceptance Criteria
- `SQLiteThreadStoreAdapter` 构造函数接收共享的 `better-sqlite3` `Database.Database` 实例，复用 `SQLiteFactStoreAdapter.getDatabase()` 创建出的同库连接。
- `create(thread)` 必须：
  - 自动生成 `thr_` 前缀 ID，格式遵循 `thr_{tagOrType}_{chapter}[_{seq}]` 的精神；优先使用 `thread.tags[0]`，否则使用 `thread.type`，并对片段做稳定清洗。
  - 若同一 base 已存在，追加稳定序号，保证不会碰撞。
  - 把 `closeCondition`、`relatedEntities`、`upstreamFactIds`、`milestones`、`tags` 正确序列化到 JSON 字段。
  - 返回完整 `NarrativeThread` 对象。
- `getById(threadId)` 必须支持旧 ID 前缀兼容：传入 `cst_foo` 时应按 `thr_foo` 查询；新建 ID 永远使用 `thr_`。
- `updateStatus(threadId, status, closedBy?)` 必须：
  - 支持 `cst_` 到 `thr_` 的查询兼容。
  - 更新 `status`。
  - 仅当传入 `closedBy` 时更新 `closed_by`；未传入时保留已有 `closed_by`。
  - 找不到记录时抛出可读错误。
- `addMilestone(threadId, milestone)` 必须：
  - 生成稳定的里程碑 ID。
  - 追加到 `milestones` JSON 数组并持久化。
  - 把 Thread 当前 `status` 更新为该 milestone 的 `status`。
  - 当 milestone status 为 `HINTED` 时递增 `hint_count`。
  - 当 milestone status 为 `FILLED` 或 `RESOLVED` 且 milestone 带 `eventId` 时，设置 `closed_by` 为该事件。
  - 找不到记录时抛出可读错误。
- `getOpen()` 必须只返回 `UNFILLED`、`PLANTED`、`HINTED`、`PARTIALLY_REVEALED`，排除 `FILLED`、`RESOLVED`、`ABANDONED`、`OBSOLETE`，并使用稳定排序。
- `getByFilters(filters)` 必须支持：
  - `direction`
  - `type`
  - `severity`
  - `status`
  - `nearChapter` + `window`，语义为 `createdAtChapter` 落在 `[nearChapter-window, nearChapter+window]`
  - `closedByEvent`
  - `relatedEntity`
  - `arcTag`
  - `excludeArcTags`
- JSON 字段反序列化失败时不要静默返回错误对象；应抛出包含字段名和 thread id 的可读错误。
- 测试必须覆盖：
  - create + getById 往返，包含 `closeCondition`、`relatedEntities`、`upstreamFactIds`、`milestones`、`tags`、`arcTag`。
  - `cst_` 兼容查询或更新。
  - `updateStatus` 关闭线索并记录 `closedBy`。
  - `addMilestone` 追加里程碑、更新状态、递增 `hint_count`，并在解决线索时记录 `closedBy`。
  - `getOpen` 排除所有终态。
  - `getByFilters` 至少覆盖 SQL 字段过滤、`relatedEntity`、`arcTag`、`excludeArcTags`、`nearChapter/window`。
  - I-9 边界：ThreadStore 操作不得新增或修改 Fact/Knowledge/Event 行数。
- 更新 `docs/core-development-log.md`，说明 Phase 2A ThreadStore 的设计决策、验证结果和剩余风险。

Verification
- `npm run typecheck`
- `npm test -- --run tests/integration/thread-store.test.ts`
- `npm test`

Report Requirements
- 最终报告必须包含以下标题，且标题文字必须完全一致：
  - Status
  - Role
  - Summary
  - Changed Files
  - Verification
  - Findings
  - Final Result
  - Risks Or Follow-ups
- `Status` 和 `Final Result` 必须一致，只能使用 `DONE`、`DONE_WITH_CONCERNS`、`NEEDS_CONTEXT`、`BLOCKED` 或 `FAIL`。
- `Verification` 必须逐条列出实际运行的命令和结果；如果没有运行某条命令，说明原因。

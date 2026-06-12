# Phase 2A ThreadStore Finalize Implementer

Goal
接管并验证当前最终版 Phase 2A SQLiteThreadStoreAdapter。当前代码已经包含主线程复核期间补强的 `relatedEntity` 精确匹配逻辑；你的任务是检查当前实现是否满足 Phase 2A 最终接受标准，必要时只做最小修正，并运行验证。你是执行者，不是架构决策者；如发现范围外问题，只在报告中列为风险，不要自行扩展到 Phase 2 后续功能。

Allowed Scope
- `src/adapters/sqlite/thread-store.ts`
- `tests/integration/thread-store.test.ts`
- `src/index.ts` 仅当 ThreadStore 导出注释需要同步时可以修改
- `docs/core-development-log.md`
- 只允许读取必要相邻文件来理解接口和测试风格，例如 `src/types.ts`、`src/adapters/sqlite/fact-store.ts`、`src/adapters/sqlite/event-store.ts`、`src/adapters/sqlite/knowledge-store.ts`、`docs/Narrative-OS-Core-Architecture.md`

Forbidden Actions
- 不要实现或修改 `ThreadResolver`、Retcon、`commit_event` 提交链、Rule Engine 自动关闭逻辑、语义检索、LLM 逻辑或 QueryEngine `findThreads`。
- 不要让 ThreadStore 写入或修改 `facts`、`knowledge`、`events`、`event_dependencies`、`sync_queue`、`audit_log` 或 `project_state`；测试夹具为了满足外键而插入 `entities/events/facts` 可以。
- 不要把 NarrativeThread 作为 Fact/Knowledge/Event 推理输入；必须保持 I-9：Thread Never Has Causal Power。
- 不要修改 Codex 插件配置、`.codex/codex_with_cc/claude-delegate` 既有产物、`node_modules`、锁文件或 package 脚本。
- 不要删除或回滚他人已有改动。
- 不要引入新依赖。

Acceptance Criteria
- `SQLiteThreadStoreAdapter` 覆盖 `ThreadStore` 接口六个方法：`create`、`updateStatus`、`addMilestone`、`getOpen`、`getById`、`getByFilters`。
- 构造函数接收共享的 `better-sqlite3` `Database.Database` 实例，复用 `SQLiteFactStoreAdapter.getDatabase()` 创建出的同库连接。
- `create(thread)` 自动生成 `thr_` 前缀 ID，优先使用 `thread.tags[0]`，否则使用 `thread.type`，同 base ID 碰撞时追加稳定序号，并正确序列化 `closeCondition`、`relatedEntities`、`upstreamFactIds`、`milestones`、`tags`。
- `getById`、`updateStatus`、`addMilestone` 支持旧 `cst_` 前缀映射到 `thr_` 查询；新建 ID 永远使用 `thr_`。
- `updateStatus(threadId, status, closedBy?)` 仅在传入 `closedBy` 时更新 `closed_by`，未传入时保留已有 `closed_by`；找不到记录时抛出可读错误。
- `addMilestone(threadId, milestone)` 生成里程碑 ID，追加到 `milestones`，更新当前 `status`；`HINTED` 递增 `hint_count`；`FILLED` 或 `RESOLVED` 且带 `eventId` 时设置 `closed_by`。
- `getOpen()` 只返回 `UNFILLED`、`PLANTED`、`HINTED`、`PARTIALLY_REVEALED`，排除所有终态，并使用稳定排序。
- `getByFilters(filters)` 支持 `direction`、`type`、`severity`、`status`、`nearChapter + window`、`closedByEvent`、`relatedEntity`、`arcTag`、`excludeArcTags`。
- `relatedEntity` 必须通过反序列化后的 `relatedEntities.includes(entityId)` 精确匹配，不能使用 SQL `LIKE` 作为最终匹配条件，避免 `_` / `%` 通配符造成误判。
- JSON 字段反序列化失败时不要静默返回错误对象；应抛出包含字段名和 thread id 的可读错误。
- 测试必须覆盖：
  - create + getById 往返，包含 JSON 字段。
  - `cst_` 兼容查询或更新。
  - `updateStatus` 关闭线索并记录 `closedBy`。
  - `addMilestone` 追加里程碑、更新状态、递增 `hint_count`，并在解决线索时记录 `closedBy`。
  - `getOpen` 排除所有终态。
  - `getByFilters` 覆盖 SQL 字段过滤、`relatedEntity` 精确匹配、`arcTag`、`excludeArcTags`、`nearChapter/window`。
  - I-9 边界：ThreadStore 操作不得新增或修改 Fact/Knowledge/Event 行数。
- 更新或确认 `docs/core-development-log.md` 已记录 Phase 2A 最终验证结果和剩余风险。

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

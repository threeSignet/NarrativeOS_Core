# Phase 1.5A Query Layer Hardening

Goal
补强 NarrativeOS Core Phase 1.5A Query Layer 的基础读取语义，重点修复并验证 Knowledge 最新态查询不能被 `minConfidence` 预过滤破坏。你是执行者，不是架构决策者；如发现范围外问题，只在报告中列为风险，不要自行扩展到 Phase 2。

Allowed Scope
- `src/core/query-engine.ts`
- `tests/integration/query-engine.test.ts`
- `docs/core-development-log.md`
- 只允许读取必要的相邻文件来理解现有接口，例如 `src/types.ts`、`src/adapters/sqlite/knowledge-store.ts`、`src/adapters/sqlite/event-store.ts`、`src/adapters/sqlite/fact-store.ts`、`docs/phase-1-acceptance.md`

Forbidden Actions
- 不要实现或修改 Phase 2 ThreadResolver、ThreadStore、Retcon 提交链、语义检索或 LLM 逻辑。
- 不要修改 Codex 插件配置、`.codex/codex_with_cc/claude-delegate` 产物、`node_modules`、锁文件或 package 脚本。
- 不要删除或回滚他人已有改动。
- 不要把 Query Layer 改成推理层；它必须保持只读，不写入状态。
- 不要引入新依赖。

Acceptance Criteria
- `findKnowledge` 默认语义必须是：先按 `entityId/factId/source/atChapter` 等时间与身份条件取候选记录，再按 `(entityId, factId)` 选择 `knownSince DESC, rowid DESC` 的最新记录，最后再应用 `includeSealed` 和 `minConfidence` 等可见性过滤。
- 特别要避免这个错误：同一 Fact 的较新 `memory_seal confidence=0` 被 `minConfidence` 预过滤掉，然后旧的 `self_action confidence=1` 被当成当前认知返回。
- 新增或调整测试覆盖：
  - 同章节先自动认知、后显式封印时，默认 `findKnowledge` 返回空，`includeSealed` 返回封印记录。
  - 较新封印记录存在时，即使传入 `minConfidence: 0.5`，默认查询也不能返回旧的正确信心记录。
  - 同章节封印后再恢复时，rowid 仲裁应返回恢复记录。
  - `includeHistory + includeSealed` 应能返回该实体对该 Fact 的历史认知记录，且包含封印记录。
- 如实现无需改动也要用测试证明；如需要改动，保持改动最小。
- 更新 `docs/core-development-log.md`，说明 Phase 1.5A Query Layer 的设计决策、验证结果和剩余风险。

Verification
- `npm run typecheck`
- `npm test -- --run tests/integration/query-engine.test.ts`
- 如果你修改了共享类型或 Store 行为，再运行 `npm test`

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

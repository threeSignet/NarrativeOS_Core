# Phase 1.5A Query Coverage Polish

Goal
补齐质量审查指出的两个非阻塞但低成本的覆盖/文档缺口：增加 `entityId + factId + minConfidence` 组合测试，并澄清 `includeHistory` 的历史语义。你只执行这个小范围补强，不要重构 Query Layer。

Allowed Scope
- `src/types.ts`
- `tests/integration/query-engine.test.ts`
- `docs/core-development-log.md`
- 可读取 `src/core/query-engine.ts`、`src/adapters/sqlite/knowledge-store.ts` 理解现有语义

Forbidden Actions
- 不要修改 `src/core/query-engine.ts`，除非测试暴露出真实 bug；如果暴露 bug，先在报告中说明，不要自行扩大实现。
- 不要修改 Phase 2 Thread、Retcon、LLM、Embedding、插件配置或依赖。
- 不要删除/回滚已有改动。
- 不要创建嵌套委派。

Acceptance Criteria
- 新增测试明确覆盖：同时传入 `entityId`、`factId`、`minConfidence` 时，如果该实体对该 Fact 的最新记录是较新的 `memory_seal confidence=0`，默认查询不能返回旧的 `confidence=1` 记录。
- 测试应直接使用现有 SQLite stores 与 `CoreNarrativeQueryEngine`，保持 Phase 1.5A 集成测试风格。
- `NarrativeKnowledgeFilter.includeHistory` 的 JSDoc 或邻近注释应说明：history 模式返回历史记录，不做 `(entityId, factId)` 最新态去重；封印记录是否出现仍由 `includeSealed` 控制。
- 更新 `docs/core-development-log.md`，补充本次 coverage polish 的验证结果。

Verification
- `npm run typecheck`
- `npm test -- --run tests/integration/query-engine.test.ts`

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
- `Verification` 必须逐条列出实际运行命令和结果。

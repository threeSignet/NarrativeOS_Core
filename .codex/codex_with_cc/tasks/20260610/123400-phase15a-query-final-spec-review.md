# Phase 1.5A Query Final Spec Review

Goal
审查 Phase 1.5A Query Layer 当前最终状态是否满足规格。范围包括 `query-hardening-impl` 和 `query-coverage-polish-impl` 两轮结果。你只做规格一致性审查，不要修改文件。

Allowed Scope
- `src/core/query-engine.ts`
- `src/types.ts`
- `tests/integration/query-engine.test.ts`
- `docs/core-development-log.md`
- `.codex/codex_with_cc/claude-delegate` 中与 `phase15a-query-hardening` workflow 相关的报告与状态文件
- 可读取 `docs/phase-1-acceptance.md`、`src/adapters/sqlite/knowledge-store.ts` 辅助判断

Forbidden Actions
- 不要修改任何项目文件。
- 不要创建嵌套委派。
- 不要审查或要求实现 Phase 2 ThreadResolver、Retcon、LLM、Embedding 或语义检索。
- 不要把测试通过当作唯一结论；必须审查基础逻辑顺序是否正确。

Acceptance Criteria
- 确认 `findKnowledge` 是否满足最终规格：先按 `entityId/factId/source/atChapter` 等身份与时间条件取候选记录，再按 `(entityId, factId)` 选择最新记录，最后应用 `includeSealed` 与 `minConfidence` 可见性过滤。
- 确认 `minConfidence` 不会在候选查询阶段过滤掉较新的 `memory_seal confidence=0`，从而误返回旧高 confidence 记录。
- 确认同章节 `rowid` 仲裁、封印后恢复、`includeHistory + includeSealed`、`entityId + factId + minConfidence` 组合测试均存在且语义正确。
- 确认 `NarrativeKnowledgeFilter.includeHistory` 的文档说明了 history 模式返回历史记录且不做最新态去重。
- 确认 Query Layer 仍然只读，未引入推理、Thread、Retcon、LLM、Embedding 或新依赖。
- 输出明确结论：accepted 或 rejected；如 rejected，列出阻塞项。

Verification
- 读取实现报告与相关文件。
- 如需运行命令，只允许运行只读检查或测试命令；不要修改文件。

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
- `Findings` 必须明确列出 accepted/rejected；如果 rejected，列出必须返工的具体点。

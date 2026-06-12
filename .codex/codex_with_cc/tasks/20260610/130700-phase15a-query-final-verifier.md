# Phase 1.5A Query Layer Final Verifier

Goal
对 `phase15a-query-hardening` workflow 做最终验收。请检查实现任务、coverage polish、spec review、quality review、验证证据和剩余风险，判断 Phase 1.5A Query Layer 补强是否可以接受。你只做最终验收，不要修改文件。

Allowed Scope
- `src/core/query-engine.ts`
- `src/types.ts`
- `tests/integration/query-engine.test.ts`
- `docs/core-development-log.md`
- `.codex/codex_with_cc/claude-delegate` 中 `phase15a-query-hardening` workflow 的报告、状态与 workflow JSON
- 可读取 `docs/phase-1-acceptance.md` 辅助判断阶段边界

Forbidden Actions
- 不要修改任何项目文件。
- 不要创建嵌套委派。
- 不要要求实现 Phase 2 ThreadResolver、Retcon、LLM、Embedding 或语义检索。
- 不要把旧的 `DONE_WITH_CONCERNS` review 当成当前阻塞项；请以补强后的 accepted spec/quality review 和最终文件状态为准。

Acceptance Criteria
- 确认两个 implementer 任务均完成：
  - `query-hardening-impl`
  - `query-coverage-polish-impl`
- 确认每个 implementer 任务均已有 accepted spec review 和 accepted quality review。
- 确认 `findKnowledge` 当前最终语义正确：候选查询不传 `minConfidence`，先按 `(entityId, factId)` 取最新，再应用 `includeSealed/minConfidence`。
- 确认测试覆盖当前风险点：封印、恢复、同章节 rowid 仲裁、history、`entityId + factId + minConfidence` 组合。
- 确认 `NarrativeKnowledgeFilter.includeHistory` 文档说明 history 不做最新态去重。
- 确认 Query Layer 仍然只读，未越界到 Thread/Retcon/LLM/Embedding。
- 确认验证证据包含：
  - `npm run typecheck`
  - `npm test -- --run tests/integration/query-engine.test.ts`
  - `npm test`
- 输出最终结论：accepted 或 rejected；如果 rejected，列出必须返工项。

Verification
- 读取 workflow 产物、实现报告、review 报告和当前相关文件。
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

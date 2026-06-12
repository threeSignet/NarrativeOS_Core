# Phase 1.5A Query Layer Spec Review

Goal
对 `query-hardening-impl` 的实现结果做规格一致性审查。你只判断它是否满足 Phase 1.5A Query Layer 的边界和任务文件验收标准，不要修改文件。

Allowed Scope
- `src/core/query-engine.ts`
- `tests/integration/query-engine.test.ts`
- `docs/core-development-log.md`
- `.codex/codex_with_cc/claude-delegate` 中与 `phase15a-query-hardening` workflow 相关的报告与状态文件
- 可读取 `docs/phase-1-acceptance.md`、`src/types.ts`、`src/adapters/sqlite/knowledge-store.ts` 辅助判断

Forbidden Actions
- 不要修改任何项目文件。
- 不要运行实现任务，不要创建嵌套委派。
- 不要审查 Phase 2 ThreadResolver、Retcon 或 LLM/Embedding 方案，除非实现误触这些范围。
- 不要把测试通过当成唯一结论；必须审查基础逻辑是否符合规格。

Acceptance Criteria
- 确认 `findKnowledge` 是否按正确顺序执行：先取得候选记录，按 `(entityId, factId)` 取最新，再应用 `includeSealed/minConfidence` 等可见性过滤。
- 确认实现没有把 `minConfidence` 传入候选查询从而复活旧记录。
- 确认测试覆盖同章节 rowid 仲裁、封印后 minConfidence 不复活旧记录、封印后恢复、history 包含封印记录。
- 确认 Query Layer 仍然只读，没有引入推理、Thread、Retcon、LLM、Embedding 或新依赖。
- 输出明确结论：accepted 或 rejected，并列出阻塞项。

Verification
- 读取实现报告与相关文件。
- 如需要，可运行只读命令检查文件内容；不要运行会修改项目状态的命令。

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

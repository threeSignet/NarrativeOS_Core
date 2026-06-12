# Phase 1.5A Query Final Quality Review

Goal
审查 Phase 1.5A Query Layer 当前最终状态的质量、维护性、测试充分性和剩余风险。范围包括 `query-hardening-impl` 和 `query-coverage-polish-impl` 两轮结果。你只做质量审查，不要修改文件。

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
- 不要要求大重构作为必须项，除非当前实现有明确行为 bug。
- 不要把 Phase 2 的 Thread、Retcon、语义检索、LLM 能力纳入本次质量门。

Acceptance Criteria
- 审查实现是否保持最小改动：核心实现只改 QueryEngine 的 Knowledge 过滤顺序，coverage polish 只补测试、类型注释和日志。
- 审查新增测试是否覆盖真实 bug 路径，而不是只覆盖 happy path。
- 审查 `includeHistory`、`includeSealed`、`minConfidence` 组合语义是否清晰；如果仍有歧义，说明是否阻塞 Phase 1.5A。
- 审查开发日志是否用中文记录设计决策、验证结果和剩余风险。
- 输出明确结论：accepted 或 rejected，并列出阻塞项或非阻塞风险。

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
- `Findings` 必须明确列出 accepted/rejected；如发现风险，请标注是否阻塞 Phase 1.5A 验收。

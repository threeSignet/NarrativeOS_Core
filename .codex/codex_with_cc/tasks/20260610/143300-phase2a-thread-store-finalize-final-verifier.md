# Phase 2A ThreadStore Finalize Final Verifier

Goal
对 `phase2a-thread-store-finalize` workflow 做最终验收审查。你是 final-verifier，只做只读验收，不修改文件。重点确认 implementer、spec reviewer、quality reviewer 的报告、验证证据、当前代码状态和剩余风险是否足以接受 Phase 2A ThreadStore。

Allowed Scope
- 读取 `.codex/codex_with_cc/tasks/20260610/143000-phase2a-thread-store-finalize-implementer.md`
- 读取 `.codex/codex_with_cc/tasks/20260610/143100-phase2a-thread-store-finalize-spec-review.md`
- 读取 `.codex/codex_with_cc/tasks/20260610/143200-phase2a-thread-store-finalize-quality-review.md`
- 读取 workflow artifacts 中本 workflow 的 implementer / reviewer 报告
- 读取 `src/adapters/sqlite/thread-store.ts`
- 读取 `tests/integration/thread-store.test.ts`
- 读取 `docs/core-development-log.md`

Forbidden Actions
- 不要修改任何文件。
- 不要实现新功能。
- 不要把 ThreadResolver、Retcon、QueryEngine.findThreads、Rule Engine 自动关闭、LLM 或语义检索纳入本阶段验收。
- 不要删除或回滚他人已有改动。

Acceptance Criteria
- 确认 implementer 报告 Status / Final Result 一致且为可接受状态。
- 确认 spec reviewer 和 quality reviewer 均已接受 `finalize-thread-store`，且没有阻塞项。
- 确认所有声明的验证命令都有实际结果：
  - `npm run typecheck`
  - `npm test -- --run tests/integration/thread-store.test.ts`
  - `npm test`
- 确认当前代码满足 Phase 2A：SQLite ThreadStore 最小生命周期存储、I-9 边界、relatedEntity 精确匹配、日志记录。
- 确认剩余风险只属于后续 Phase 2 依赖，不阻塞 Phase 2A 接受。

Verification
- `npm test -- --run tests/integration/thread-store.test.ts`

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
- `Role` 必须是 `final-verifier`。
- `Verification` 必须列出实际运行的命令和结果；如果没有运行命令，说明原因。

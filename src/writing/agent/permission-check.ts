// =============================================================================
// Agent 写作层权限矩阵（Phase 7 桥接层 · W2-b）
// =============================================================================
// 设计依据：Phase7-Refinement.md §8.3.2（AgentCapability 五级 + AGENT_PERMISSIONS 矩阵）、§8.4。
//
// 与 W1（tool-permissions.ts）的关系——两道独立的安全门：
//   - W1 门控：拦截 Agent **ReAct 工具循环**里 LLM 直接发起的 commit_event tool call
//     （narrative-agent.ts 的 isToolForbiddenForAgent chokepoint）。粒度=工具名。
//   - W2 本模块：声明 Agent 对**写作层 service 方法**的调用能力，并在"作者确认通道"
//     之外的调用点强制禁止 COMMIT_FORBIDDEN 方法。粒度=ServiceName.method。
//   两者互补：W1 管 tool，W2 管 service；作者确认通道（handlePendingDecisions /
//   applyDecisionConfirm / CoreBridge.commit*）经 caller 标记豁免本模块，但仍不经 W1 chokepoint。
//
// 矩阵修正说明（相对 spec §8.3.2 原表的 9 处偏差，均经 grep 核实真实代码）：
//   重命名（spec 用了不存在的方法名，真实类里是另一个名）：
//     1. ProjectService.getProjectSettings → getProject（project-service.ts）
//     2. DraftService.getDraftEditorView   → getDraft（draft-service.ts）
//     3. EntityService.getEntityProfileView → getEntitySketch（entity-service.ts）
//   删除幽灵方法（spec 列出但代码中根本不存在，编码即造永不命中的死条目）：
//     4. DraftService._markCommitted
//     5. EntityService._markRegistered
//     6. CoreBridgeService.commitReviewedThreadChange
//     7. CoreBridgeService.commitReviewedKnowledgeChange
//     8. CoreBridgeService.commitReviewedWorldPackageChange
//   新增（真实存在且语义属 COMMIT_FORBIDDEN，spec 原表遗漏）：
//     9. ProjectService.transitionProjectStatus —— 该方法 docstring 明确写
//        "Agent 可调用：否（COMMIT_FORBIDDEN）"，与 setWorkspaceMode/archiveProject 同级
//        （项目生命周期元操作，仅作者直接驱动）。
//   建议后续在 Phase7-Refinement §8.3.2 加勘误注记，使文档与代码一致。
//
// 强制策略（assertAgentMayCall）：
//   - 带 AUTHOR_CONFIRM_CHANNEL caller 标记 → 一律放行（作者确认通道是经授权的合法写入入口）。
//   - 无 caller 标记 + COMMIT_FORBIDDEN：
//       registerReviewedEntity → 抛 AGENT_REGISTER_FORBIDDEN（实体注册须走审核通道）
//       其余 → 抛 AGENT_COMMIT_FORBIDDEN（提交须走 Proposal Review 通道）
//     retryable=false（权限策略非可修复错误，重试同调用必被拒）。
//   - 无 caller 标记 + 低层级（READ/LOW_RISK/CANDIDATE/REVIEW_CREATE）→ 放行。
//   - 未收录在矩阵 → 放行（防御性：新 service 方法不被误拦致回归）。
// =============================================================================

import { WritingError, WritingErrorCode } from '../errors/error-codes.js';

/**
 * Agent 对写作层接口的能力分级（§8.3.2）
 *
 * 从低到高五级。assertAgentMayCall 只在 COMMIT_FORBIDDEN 上抛错；低层级均放行
 * （它们是 Agent 正常推理/草拟/审核创建的合法操作，提交主权由更上层保证）。
 */
export enum AgentCapability {
  /** 只读查询：读取项目、正文、Core 投影 */
  READ_QUERY = 'read_query',
  /** 低风险写入：保存灵感、创建草案 */
  LOW_RISK_WRITE = 'low_risk_write',
  /** 候选写入：创建候选实体/关系 */
  CANDIDATE_WRITE = 'candidate_write',
  /** 审核创建：创建 Proposal Review（推演后自动建审核，不自动提交） */
  REVIEW_CREATE = 'review_create',
  /** 禁止：正式提交 Core / 注册实体 / 关闭审核门——只能经作者确认通道调用 */
  COMMIT_FORBIDDEN = 'commit_forbidden',
}

/**
 * 作者确认通道的 caller 标记。
 *
 * 带此标记的 assertAgentMayCall 调用一律放行——它标识"此调用来自经用户授权的确认通道"
 * （handlePendingDecisions / applyDecisionConfirm / autoApprovePendingDecisions 内的
 * commit/register/resolve 调用）。这与 §8.0"换调用者"一致：commit 不消失，只是改由
 * 经授权的通道发起。裸 Agent 自动路径不带此标记，故 COMMIT_FORBIDDEN 调用必被拦。
 */
export const AUTHOR_CONFIRM_CHANNEL = 'author_confirm_channel';

/**
 * Agent 对各写作层 service 方法的权限映射（§8.3.2，已按 9 处偏差修正——见文件头注释）。
 *
 * key 格式：'ServiceClassName.methodName'（与 assertAgentMayCall 的 qualifiedName 入参一致）。
 * 仅收录 COMMIT_FORBIDDEN 时抛错有意义；低层级条目主要作"Agent 可调用能力"的声明文档，
 * 同时被纯矩阵测试覆盖，防止未来误把某只读方法标错层级或遗漏。
 */
export const AGENT_PERMISSIONS: Readonly<Record<string, AgentCapability>> = {
  // =========================================================================
  // 只读查询（Agent 可自由调用）
  // =========================================================================
  'ProjectService.getProjectHomeView': AgentCapability.READ_QUERY,
  'ProjectService.getProject': AgentCapability.READ_QUERY, // 修正：原 spec 为 getProjectSettings（不存在）
  'ProjectService.listAuthorGoals': AgentCapability.READ_QUERY,
  'IdeaService.listIdeaCards': AgentCapability.READ_QUERY,
  'IdeaService.getIdeaDetail': AgentCapability.READ_QUERY,
  'DraftService.getDraft': AgentCapability.READ_QUERY, // 修正：原 spec 为 getDraftEditorView（不存在）
  'DraftService.listDrafts': AgentCapability.READ_QUERY,
  'EntityService.getEntitySketch': AgentCapability.READ_QUERY, // 修正：原 spec 为 getEntityProfileView（不存在）
  'EntityService.listCandidateQueue': AgentCapability.READ_QUERY,
  'BlueprintService.getActiveBlueprint': AgentCapability.READ_QUERY,
  'BlueprintService.getBlueprintEvolution': AgentCapability.READ_QUERY,
  'WorkflowService.listPendingDecisions': AgentCapability.READ_QUERY,
  'WorkflowService.getDecisionHistory': AgentCapability.READ_QUERY,
  'AuditService.query': AgentCapability.READ_QUERY,
  // 新增（G2）：list 是 query 的扩展（带 result 过滤），同属只读审计查询
  'AuditService.list': AgentCapability.READ_QUERY,
  // E2：正文只读查询
  'ProseService.listDocuments': AgentCapability.READ_QUERY,
  'ProseService.getDocumentWithBlocks': AgentCapability.READ_QUERY,
  'CoreBridgeService.readCurrentWorldSnapshot': AgentCapability.READ_QUERY,
  'CoreBridgeService.explainCoreFailure': AgentCapability.READ_QUERY,
  // 新增：findRegisteredEntities 是只读查询（按名称找已注册实体），供 /entity 命令用
  'EntityService.findRegisteredEntities': AgentCapability.READ_QUERY,

  // =========================================================================
  // 低风险写入（Agent 在作者明确要求时可调用）
  // =========================================================================
  'ProjectService.createProject': AgentCapability.LOW_RISK_WRITE,
  'ProjectService.updateAuthorGoal': AgentCapability.LOW_RISK_WRITE,
  'ProjectService.pauseAuthorGoal': AgentCapability.LOW_RISK_WRITE,
  'ProjectService.archiveAuthorGoal': AgentCapability.LOW_RISK_WRITE,
  'IdeaService.captureIdea': AgentCapability.LOW_RISK_WRITE,
  'IdeaService.classifyIdea': AgentCapability.LOW_RISK_WRITE,
  'IdeaService.discardIdea': AgentCapability.LOW_RISK_WRITE,
  'IdeaService.restoreIdea': AgentCapability.LOW_RISK_WRITE,
  'DraftService.createDraft': AgentCapability.LOW_RISK_WRITE,
  'DraftService.updateDraftContent': AgentCapability.LOW_RISK_WRITE,
  'DraftService.abandonDraft': AgentCapability.LOW_RISK_WRITE,
  'EntityService.deprecateEntitySketch': AgentCapability.LOW_RISK_WRITE,
  'WorkflowService.createPendingDecision': AgentCapability.LOW_RISK_WRITE,
  // E2：正文写入（追加块，不修改/删除已有内容）
  'ProseService.addBlock': AgentCapability.LOW_RISK_WRITE,
  'ProseService.createDocument': AgentCapability.LOW_RISK_WRITE,
  // rejectBlueprintChange 仅把 suggestion 标 dismissed，不改蓝图结构（entityTypes/relationTypes），
  // 危害性与 discardIdea 相当；与 acceptBlueprintChange（COMMIT_FORBIDDEN，落地结构变更）不对称。
  'BlueprintService.rejectBlueprintChange': AgentCapability.LOW_RISK_WRITE,

  // =========================================================================
  // 候选写入（Agent 触发，需作者确认后才生效）
  // =========================================================================
  'IdeaService.promoteIdeaToDraft': AgentCapability.CANDIDATE_WRITE,
  'IdeaService.promoteIdeaToBlueprintCandidate': AgentCapability.CANDIDATE_WRITE,
  'EntityService.promoteHintToSketch': AgentCapability.CANDIDATE_WRITE,
  'EntityService.approveCandidate': AgentCapability.CANDIDATE_WRITE,
  'EntityService.mergeSketches': AgentCapability.CANDIDATE_WRITE,
  'BlueprintService.proposeBlueprintChange': AgentCapability.CANDIDATE_WRITE,

  // =========================================================================
  // 审核创建（Agent 生成审核视图/推演，不能直接提交）
  // =========================================================================
  'BlueprintService.generateBlueprintDraft': AgentCapability.REVIEW_CREATE,
  'DraftService.markReadyForSimulation': AgentCapability.REVIEW_CREATE,
  'DraftService.simulateDraft': AgentCapability.REVIEW_CREATE,
  'CoreBridgeService.simulateDraftAsEvent': AgentCapability.REVIEW_CREATE,
  'CoreBridgeService.simulateProposal': AgentCapability.REVIEW_CREATE,
  'EntityService.detectEntityHints': AgentCapability.REVIEW_CREATE,

  // =========================================================================
  // 禁止 — Agent 自动路径绝对不能调用（仅作者确认通道经 caller 标记豁免）
  // =========================================================================
  'ProjectService.setWorkspaceMode': AgentCapability.COMMIT_FORBIDDEN,
  'ProjectService.archiveProject': AgentCapability.COMMIT_FORBIDDEN,
  // 新增：项目生命周期状态推进，docstring 明确 COMMIT_FORBIDDEN（与 setWorkspaceMode 同级）
  'ProjectService.transitionProjectStatus': AgentCapability.COMMIT_FORBIDDEN,
  // 新增：项目元信息修改（title/premise），与 setWorkspaceMode 同级（作者层元操作）
  'ProjectService.updateProjectMeta': AgentCapability.COMMIT_FORBIDDEN,
  'BlueprintService.acceptBlueprintDraft': AgentCapability.COMMIT_FORBIDDEN,
  'BlueprintService.acceptBlueprintChange': AgentCapability.COMMIT_FORBIDDEN,
  'WorkflowService.resolvePendingDecision': AgentCapability.COMMIT_FORBIDDEN,
  'CoreBridgeService.commitReviewedProposal': AgentCapability.COMMIT_FORBIDDEN,
  // E2：正文破坏性操作禁止 Agent 调用（全量替换/删除块只能由作者触发）
  'ProseService.ingestText': AgentCapability.COMMIT_FORBIDDEN,
  'ProseService.deleteBlock': AgentCapability.COMMIT_FORBIDDEN,
  'CoreBridgeService.registerReviewedEntity': AgentCapability.COMMIT_FORBIDDEN,
  // 注：spec 原表还列了 DraftService._markCommitted / EntityService._markRegistered /
  //     CoreBridgeService.commitReviewedThreadChange / commitReviewedKnowledgeChange /
  //     commitReviewedWorldPackageChange——这 5 个方法在真实代码中不存在（幽灵条目），已删除。
  //     保留它们会让"幽灵方法不在矩阵"的不变式测试失效，且给读者错误印象（以为有这些方法）。
};

/** 实体注册类禁止方法——抛 AGENT_REGISTER_FORBIDDEN（区别于提交类的 AGENT_COMMIT_FORBIDDEN） */
const REGISTER_FORBIDDEN_METHODS: ReadonlySet<string> = new Set<string>([
  'CoreBridgeService.registerReviewedEntity',
]);

/**
 * 断言 Agent 是否可调用某写作层 service 方法（§8.3.2 强制点）。
 *
 * 调用约定：
 *   - 作者确认通道调用点必须传 `{ caller: AUTHOR_CONFIRM_CHANNEL }`，否则会被误拦。
 *   - 裸 Agent 自动路径（ReAct 内部）调用 COMMIT_FORBIDDEN 方法会抛错——这正是本断言的
 *     防回归价值：当前 Agent 自动路径对 COMMIT_FORBIDDEN 调用为零，未来若误增即被此门拦下。
 *
 * @param qualifiedName 'ServiceClassName.methodName'（如 'CoreBridgeService.commitReviewedProposal'）
 * @param opts.caller   调用来源标记；AUTHOR_CONFIRM_CHANNEL 表示经授权的作者确认通道（豁免）
 * @throws {WritingError} 无 caller 标记且命中 COMMIT_FORBIDDEN 时抛 AGENT_COMMIT_FORBIDDEN /
 *                         AGENT_REGISTER_FORBIDDEN（retryable 由 WritingError 默认，恢复映射引导到审核页）
 */
export function assertAgentMayCall(
  qualifiedName: string,
  opts?: { caller?: string },
): void {
  // 作者确认通道：经用户授权的合法写入入口，一律放行（§8.0 换调用者）
  if (opts?.caller === AUTHOR_CONFIRM_CHANNEL) {
    return;
  }

  const capability = AGENT_PERMISSIONS[qualifiedName];

  // 未收录在矩阵 → 放行（防御性：新 service 方法不被误拦，避免回归）
  if (capability === undefined) {
    return;
  }

  // 仅 COMMIT_FORBIDDEN 抛错；低层级（READ/LOW_RISK/CANDIDATE/REVIEW_CREATE）放行
  if (capability !== AgentCapability.COMMIT_FORBIDDEN) {
    return;
  }

  // 区分实体注册 vs 提交，抛对应错误码（激活 AGENT_REGISTER_FORBIDDEN 死码）
  if (REGISTER_FORBIDDEN_METHODS.has(qualifiedName)) {
    throw new WritingError(
      WritingErrorCode.AGENT_REGISTER_FORBIDDEN,
      `Agent 不得直接调用 ${qualifiedName}：实体注册须经作者在实体审核通道确认后由系统执行。`,
    );
  }
  throw new WritingError(
    WritingErrorCode.AGENT_COMMIT_FORBIDDEN,
    `Agent 不得直接调用 ${qualifiedName}：提交/关闭审核须经作者在 Proposal Review 通道确认后由系统执行。`,
  );
}

// =============================================================================
// CoreBridgeService — Core 写入唯一通道
// =============================================================================
// 写作层所有 Core 交互的唯一出口。Agent 可以调用 simulate 和 read 方法，
// 但不能调用 commit/register 方法——这些只能由 CLI 确认通道或 Proposal Review
// 流程调用。
//
// 设计要点：
//   - 推演类方法（simulate*）Agent 可调用
//   - 提交类方法（commit* / register*）Agent 禁止
//   - 所有提交方法必须有审核来源
//   - Phase 7 只实现 event 和 entity_registration 通道
//
// 对应设计文档：Phase7-Refinement.md §7.7
// =============================================================================

/**
 * Core 错误的人话解释
 */
export interface CoreErrorExplanation {
  errorCode: string;
  humanMessage: string;
  suggestedActions: string[];
  isRecoverable: boolean;
  technicalDetail?: string; // 仅调试模式可见
}

/**
 * CoreBridge 推演返回结果
 */
export interface SimulationResult {
  proposalId: string;
  isSafeToCommit: boolean;
  report: string;
}

/**
 * CoreBridge 提交返回结果
 */
export interface CommitResult {
  success: boolean;
  coreEventId?: string;
  error?: CoreErrorExplanation;
}

/**
 * CoreBridge 注册实体返回结果
 */
export interface RegisterEntityResult {
  success: boolean;
  coreEntityId?: string;
  coreKind?: string;
  error?: CoreErrorExplanation;
}

/**
 * CoreBridgeService 接口
 *
 * 实现类分别有：MockCoreBridge（测试用）和 RealCoreBridge（生产用，包装 ToolRouter）。
 */
export interface CoreBridgeService {
  // =========================================================================
  // 沙盒/只读（Agent 可调用）
  // =========================================================================

  /** 草案沙盒推演——只调用 propose_event，不提交 Core */
  simulateDraftAsEvent(
    projectId: string,
    params: {
      draftId: string;
      eventDescription: string;
      eventType: string;
      chapter: number;
      factChanges: unknown[];
    },
  ): Promise<SimulationResult>;

  /** 重新推演审核中的提案 */
  simulateProposal(
    projectId: string,
    proposalViewId: string,
  ): Promise<SimulationResult>;

  /** 读取当前世界状态快照 */
  readCurrentWorldSnapshot(projectId: string): Promise<unknown>;

  /** 解释 Core 错误 */
  explainCoreFailure(error: unknown): CoreErrorExplanation;

  // =========================================================================
  // 写入（仅审核流程触发，Agent 禁止直接调用）
  // =========================================================================

  /** 提交已审核提案 */
  commitReviewedProposal(
    projectId: string,
    proposalViewId: string,
  ): Promise<CommitResult>;

  /** 注册已审核实体 */
  registerReviewedEntity(
    projectId: string,
    sketchId: string,
  ): Promise<RegisterEntityResult>;
}

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

import type { WritingRequestContext } from '../services/context.js';

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
 * 推演后果中的叙事线索（违规/伏笔产生的）——只保留 Proposal Review 投影所需字段
 *
 * Core 的 NarrativeThread 携带大量内部字段（id/relatedEntities/upstreamFactIds…），
 * 这里只取 severity/type/description 三项透出给写作层，避免把 Core 内部结构
 * 漫进 SimulationResult。severity 是 ruleWarnings 分级（blocker/warning/info）的唯一依据。
 */
export interface SimulatedThread {
  severity: 'minor' | 'major' | 'critical';
  type: string;
  description: string;
}

/**
 * CoreBridge 推演返回结果
 */
export interface SimulationResult {
  proposalId: string;
  isSafeToCommit: boolean;
  report: string;
  /** W7：结构化推演后果——叙事线索（severity/type/description），供 Proposal Review 投影 ruleWarnings */
  consequenceThreads: SimulatedThread[];
  /** W7：非阻塞警告原文（Core 给 LLM 的提示信息），供 ruleWarnings 投影为 info 级 */
  consequenceWarnings: string[];
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
 * 对账恢复结果（§7.11.5 两阶段提交恢复）
 *
 * - recovered：本次成功恢复的写作对象 ID 列表（proposalViewId / sketchId）
 * - inspected：本次检查到的孤儿态对象总数（含未能恢复的）
 *
 * 幂等：已恢复的对象下次不再出现在 author_approved/approved 孤儿集合中，
 * 故连续调用 recovered 会收敛到空。
 */
export interface ReconcileResult {
  recovered: string[];
  inspected: number;
}

/**
 * 世界快照中单个实体的状态档案（W8）
 *
 * 这是数据层结构（非 ViewModel）——供 Agent（READ_QUERY 能力）读取原始实体状态。
 * coreEntityId / factIndex 保留原始 Core 标识，因为 Agent 需要它们执行后续 update/retract；
 * 面向作者展示时由 buildWorldSnapshotView 投影为 WorldSnapshotViewModel（§9.1 过滤）。
 */
export interface WorldSnapshotEntity {
  /** 实体草图（写作层）的显示名，便于 Agent 在档案外定位实体 */
  displayName: string;
  /** 实体类型标签（角色/势力/地点…），来自 entity sketch.typeLabel */
  typeLabel: string;
  /** Core 实体 ID（ent_ 前缀）——数据层保留，ViewModel 投影时剥离 */
  coreEntityId: string;
  /** Core get_context_slice 渲染的实体档案（Markdown，人话） */
  profileMarkdown: string;
  /** 当前有效的 Fact 索引（供 Agent 后续 update/retract 取 target_fact_id） */
  factIndex: Array<{ factId: string; predicate: string; value: string }>;
  /** 该实体读取失败时的人话错误（非空表示此实体档案不可用，但不阻断其余实体聚合） */
  error?: string;
}

/**
 * 世界状态快照（W8，§7.7 readCurrentWorldSnapshot 的返回）
 *
 * 聚合方案：写作层枚举已注册实体（status='registered' 且 coreEntityId 已回填），
 * 逐一调 Core get_context_slice 聚合。**不新增 Core 全局快照接口**（Phase 7 最小侵入 Core）。
 *
 * currentChapter 来源优先级：调用方显式传入 > 写作层推导（已存在 draft 的最大 chapter，默认 1）。
 * Core 的 project_state.current_chapter 是规范来源，但无 Core 读工具暴露它——读取它需新增
 * Core 接口，违背"最小侵入 Core"原则，故 Phase 7 从写作层推导。
 */
export interface WorldSnapshot {
  /** 本次快照所用的章节号（决定各实体档案的 atChapter 视角） */
  currentChapter: number;
  /** 聚合的实体总数（含读取失败的） */
  totalEntities: number;
  /** 各实体档案（顺序按 entity sketch 更新时间倒序） */
  entities: WorldSnapshotEntity[];
}

/**
 * CoreBridgeService 接口
 *
 * 实现类：RealCoreBridge（生产用，包装 ToolRouter）。
 * 注：设计早期曾规划 MockCoreBridge，但 2026-06-13 决定不实现——Core 是自有代码而非外部 API，
 * 所有测试一律使用真实 Core（:memory: SQLite + 真实 ToolRouter）。
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

  /**
   * 读取当前世界状态快照（§7.7）
   *
   * 聚合方案：枚举已注册实体 + 逐一 get_context_slice（不新增 Core 全局快照接口）。
   *
   * @param projectId 项目 ID
   * @param options.currentChapter 可选——显式指定快照章节视角；省略则写作层推导
   *        （已存在 draft 的最大 chapter，默认 1）
   */
  readCurrentWorldSnapshot(
    projectId: string,
    options?: { currentChapter?: number },
  ): Promise<WorldSnapshot>;

  /** 解释 Core 错误 */
  explainCoreFailure(error: unknown): CoreErrorExplanation;

  // =========================================================================
  // 写入（仅审核流程触发，Agent 禁止直接调用）
  // =========================================================================
  // 这两个方法接收完整 ctx 而非裸 projectId：提交/注册是写入 Core 的关键操作，
  // 必须在 RealCoreBridge 内部落地审计（§7.7 4d/5b），审计需要 ctx 的 trigger/requestId/sessionId
  // 才能追溯。由此保证「任何调用方提交都会被审计」，而非依赖每个调用方各自记审计。

  /** 提交已审核提案 */
  commitReviewedProposal(
    ctx: WritingRequestContext,
    proposalViewId: string,
  ): Promise<CommitResult>;

  /** 注册已审核实体 */
  registerReviewedEntity(
    ctx: WritingRequestContext,
    sketchId: string,
  ): Promise<RegisterEntityResult>;

  // =========================================================================
  // 对账恢复（§7.11.5 两阶段提交恢复——初始化时调用）
  // =========================================================================
  // commit/register 在 Core 写入成功但写作层回写失败（result='partial'）时，写作对象会停留
  // 在提交前状态（author_approved / approved），而 Core 已持久化对应 event/entity。这组方法
  // 在启动时扫描这类孤儿并通过审计日志回写恢复。详见 RealCoreBridge 实现。

  /**
   * 对账恢复孤儿提案——将"Core 已提交但 PV 仍 author_approved"的对象回写为 committed。
   * 在 CoreBridge 初始化时调用。
   */
  reconcileCommittedProposals(): ReconcileResult;

  /**
   * 对账恢复孤儿实体——将"Core 已注册但草图仍 approved"的对象回写为 registered。
   * 在 CoreBridge 初始化时调用。
   */
  reconcileRegisteredEntities(): ReconcileResult;

  /** 组合入口：依次对账提案与实体，返回各自结果。CLI 启动时调用。 */
  reconcile(): { proposals: ReconcileResult; entities: ReconcileResult };
}

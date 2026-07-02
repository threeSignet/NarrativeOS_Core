// =============================================================================
// StateMachine — 写作层状态跳转校验函数
// =============================================================================
// 每个服务在执行状态变更前调用校验函数。校验不通过抛出 StateMachineError。
//
// 设计要点：
//   - 存储层不管状态合法性——所有校验在服务层入口处
//   - 每个对象的合法跳转以常量表定义，一目了然
//   - 错误信息包含当前状态、目标状态、对象类型和 ID
//
// 对应设计文档：Phase7-Refinement.md §5, §17
// =============================================================================

import { WritingErrorCode } from '../errors/error-codes.js';

/**
 * 状态机校验错误——状态跳转不允许时抛出
 */
export class StateMachineError extends Error {
  constructor(
    public code: string,
    public currentStatus: string,
    public targetStatus: string,
    public objectType: string,
    public objectId: string,
  ) {
    super(
      `[${code}] 状态跳转禁止: ${objectType}#${objectId} ` +
      `"${currentStatus}" → "${targetStatus}"`,
    );
    this.name = 'StateMachineError';
  }
}

// =============================================================================
// WritingProject 状态跳转
// =============================================================================

const PROJECT_TRANSITIONS: Record<string, string[]> = {
  'planning':  ['drafting', 'reviewing', 'paused', 'archived'],
  'drafting':  ['reviewing', 'paused', 'archived'],
  'reviewing': ['drafting', 'paused', 'archived'],
  'paused':    ['planning', 'drafting', 'reviewing', 'archived'],
  'archived':  [],
};

export function validateProjectTransition(
  currentStatus: string,
  targetStatus: string,
  projectId: string,
): void {
  // 注：project/idea/blueprint 不加 self-loop 豁免——它们的状态字段（status/maturity）
  // 本身就是业务语义，self-loop（如 active→active）意味着"原地踏步"，业务上应拒
  // （如 idea ready_for_draft→ready_for_draft 是 promoteIdeaToDraft 的幂等陷阱）。
  // draft/entitySketch/proposalView 才有 self-loop 豁免（status 与业务字段解耦）。
  const allowed = PROJECT_TRANSITIONS[currentStatus];
  if (!allowed || !allowed.includes(targetStatus)) {
    throw new StateMachineError(
      WritingErrorCode.INVALID_STATUS_TRANSITION,
      currentStatus, targetStatus, 'WritingProject', projectId,
    );
  }
}

// =============================================================================
// IdeaCard 成熟度跳转
// =============================================================================

const IDEA_TRANSITIONS: Record<string, string[]> = {
  'raw':             ['candidate', 'archived'],
  'candidate':       ['structured', 'ready_for_draft', 'archived'],
  'structured':      ['ready_for_draft', 'archived'],
  'ready_for_draft': ['archived'],
  'archived':        ['raw'],
};

export function validateIdeaTransition(
  currentMaturity: string,
  targetMaturity: string,
  ideaId: string,
): void {
  // 不加 self-loop 豁免（见 validateProjectTransition 注释）
  const allowed = IDEA_TRANSITIONS[currentMaturity];
  if (!allowed || !allowed.includes(targetMaturity)) {
    throw new StateMachineError(
      WritingErrorCode.INVALID_STATUS_TRANSITION,
      currentMaturity, targetMaturity, 'IdeaCard', ideaId,
    );
  }
}

// =============================================================================
// ProjectBlueprint 成熟度跳转
// =============================================================================

const BLUEPRINT_TRANSITIONS: Record<string, string[]> = {
  'implicit':   ['drafted', 'archived'],
  'drafted':    ['reviewed', 'active', 'archived'],
  'reviewed':   ['active', 'evolving', 'drafted', 'archived'],
  'active':     ['evolving', 'archived'],
  'evolving':   ['active', 'drafted', 'archived'],
  'archived':   [],
  'superseded': [],
};

export function validateBlueprintTransition(
  currentMaturity: string,
  targetMaturity: string,
  blueprintId: string,
): void {
  // 不加 self-loop 豁免（见 validateProjectTransition 注释）
  const allowed = BLUEPRINT_TRANSITIONS[currentMaturity];
  if (!allowed || !allowed.includes(targetMaturity)) {
    throw new StateMachineError(
      WritingErrorCode.INVALID_STATUS_TRANSITION,
      currentMaturity, targetMaturity, 'ProjectBlueprint', blueprintId,
    );
  }
}

// =============================================================================
// WritingDraft 状态跳转
// =============================================================================

const DRAFT_TRANSITIONS: Record<string, string[]> = {
  // drafting→simulated：允许跳过 ready_to_simulate 的快速推演路径（测试/Agent 直接 simulate）
  'drafting':             ['ready_to_simulate', 'simulated', 'archived'],
  'ready_to_simulate':    ['simulated', 'drafting', 'archived'],
  'simulated':            ['committed', 'drafting', 'archived'],
  // Phase 12 §19.1：已提交草案可进入 revising（作者开始追改流程，正式状态变更仍走 Retcon）
  'committed':            ['revising'],
  'revising':             ['committed', 'drafting', 'archived'],
  'archived':             ['drafting'],
  'error':                ['drafting', 'archived'],
};

export function validateDraftTransition(
  currentStatus: string,
  targetStatus: string,
  draftId: string,
): void {
  // self-loop 豁免：更新字段但状态不变（如改 content 但 status 仍 drafting）是合法幂等更新
  if (currentStatus === targetStatus) return;
  const allowed = DRAFT_TRANSITIONS[currentStatus];
  if (!allowed || !allowed.includes(targetStatus)) {
    throw new StateMachineError(
      WritingErrorCode.INVALID_STATUS_TRANSITION,
      currentStatus, targetStatus, 'WritingDraft', draftId,
    );
  }
}

// =============================================================================
// WritingEntitySketch 状态跳转
// =============================================================================

const ENTITY_SKETCH_TRANSITIONS: Record<string, string[]> = {
  'hint':       ['candidate', 'deprecated'],
  'candidate':  ['approved', 'deprecated', 'merged'],
  'approved':   ['registered', 'deprecated', 'candidate', 'error'],
  // registered 已被 Core 引用，普通状态机不可达任何状态；
  // 废弃/合并必须经 Retcon 通道（独立于本状态机），故此处为空数组。
  // 此修正消除与 EntityService.deprecateEntitySketch 业务规则的双重真相源矛盾。
  'registered': [],
  'deprecated': ['candidate'],
  'merged':     [],
  'error':      ['candidate', 'approved', 'deprecated'],
};

export function validateEntitySketchTransition(
  currentStatus: string,
  targetStatus: string,
  sketchId: string,
): void {
  if (currentStatus === targetStatus) return; // self-loop 豁免（幂等更新）
  const allowed = ENTITY_SKETCH_TRANSITIONS[currentStatus];
  if (!allowed || !allowed.includes(targetStatus)) {
    throw new StateMachineError(
      WritingErrorCode.INVALID_STATUS_TRANSITION,
      currentStatus, targetStatus, 'WritingEntitySketch', sketchId,
    );
  }
}

// =============================================================================
// WritingProposalView 状态跳转
// =============================================================================

const PROPOSAL_VIEW_TRANSITIONS: Record<string, string[]> = {
  'open':              ['author_approved', 'author_rejected', 'expired'],
  // 'expired' 用于 §7.11.6：提交时 Core 返回 PROPOSAL_NOT_FOUND（proposal 跨会话内存丢失，
  // 已不可恢复）——区别于 'commit_failed'（可重试/可重新审核的技术失败）。
  // 'open' 放行：materializeProposalView 复用同草案的活跃 PV 时，若 PV 已是 author_approved
  // （作者曾批准，但提案内容因 Agent 重推而变更、产生新 proposalId），需回到 open 重新审核。
  // 这是合法的"重审"流转——旧批准针对旧内容，新内容必须重新走审核。此放行让状态机表
  // （§5.5/§17 真相源）与 narrative-agent 的实际行为一致，而非"绕过校验的静默违规"。
  'author_approved':   ['open', 'committed', 'commit_failed', 'expired'],
  'author_rejected':   ['superseded'],
  'committed':         [],
  'commit_failed':     ['open'],
  'expired':           ['superseded'],
  'superseded':        [],
};

export function validateProposalViewTransition(
  currentStatus: string,
  targetStatus: string,
  viewId: string,
): void {
  if (currentStatus === targetStatus) return; // self-loop 豁免（幂等更新）
  const allowed = PROPOSAL_VIEW_TRANSITIONS[currentStatus];
  if (!allowed || !allowed.includes(targetStatus)) {
    throw new StateMachineError(
      WritingErrorCode.INVALID_STATUS_TRANSITION,
      currentStatus, targetStatus, 'WritingProposalView', viewId,
    );
  }
}

// =============================================================================
// 复合校验
// =============================================================================

/**
 * 提交前校验：确保 ProposalView 状态为 author_approved，
 * 且来源草案未被修改、来源实体仍存在。
 *
 * 删除检查独立于 status：getDraft 过滤 deleted_at（软删 → 返回 undefined → status 为空），
 * 若把删除判断塞进 `if (sourceDraftStatus)` 块内，status 为空时会整块跳过、漏检已删草案。
 * 故先查删除，再查修改态。
 */
export function validateCommitReadiness(params: {
  proposalViewStatus: string;
  sourceDraftStatus?: string;
  sourceDraftDeleted?: boolean;
}): { valid: boolean; reason?: string } {
  if (params.proposalViewStatus !== 'author_approved') {
    return { valid: false, reason: '提案尚未获得作者批准' };
  }
  if (params.sourceDraftDeleted) {
    return { valid: false, reason: '来源草案已被删除' };
  }
  if (
    params.sourceDraftStatus === 'drafting' ||
    params.sourceDraftStatus === 'ready_to_simulate'
  ) {
    return { valid: false, reason: '来源草案在审核期间被修改，需要重新推演' };
  }
  return { valid: true };
}

/**
 * 推演前校验：Draft 必须有内容、不能是 committed/archived。
 */
export function validateDraftSimulationReadiness(params: {
  status: string;
  content: string;
}): { valid: boolean; reason?: string } {
  if (params.status === 'committed') return { valid: false, reason: '草案已提交' };
  if (params.status === 'archived') return { valid: false, reason: '草案已归档' };
  if (!params.content || params.content.trim().length < 10) {
    return { valid: false, reason: '草案内容过短（至少需要 10 个字符）' };
  }
  return { valid: true };
}

// ===========================================================================
// Phase 8：关系候选状态机校验
// ===========================================================================

const RELATION_CANDIDATE_TRANSITIONS_SM: Record<string, string[]> = {
  candidate: ['drafted', 'submitted', 'rejected', 'archived'],  // 允许直接提交（简化路径）
  drafted: ['submitted', 'rejected', 'archived', 'candidate'],
  submitted: ['committed', 'rejected', 'archived', 'drafted'],
  committed: [],
  rejected: ['archived'],
  archived: ['candidate'],
};

export function validateRelationCandidateTransition(
  currentStatus: string, targetStatus: string, relationId: string,
): void {
  if (currentStatus === targetStatus) return;
  const allowed = RELATION_CANDIDATE_TRANSITIONS_SM[currentStatus];
  if (!allowed || !allowed.includes(targetStatus)) {
    throw new StateMachineError(
      WritingErrorCode.INVALID_STATUS_TRANSITION,
      currentStatus, targetStatus, 'WritingRelationCandidate', relationId,
    );
  }
}

// ===========================================================================
// Phase 9：空间节点成熟度 + 空间边状态机
// ===========================================================================

/** 空间节点成熟度转换：hint→candidate→confirmed→registered（单向递进） */
const SPATIAL_NODE_MATURITY_TRANSITIONS: Record<string, string[]> = {
  hint: ['candidate'],
  candidate: ['confirmed'],
  confirmed: ['registered'],
  registered: [],
};

export function validateSpatialNodeMaturity(
  currentMaturity: string, targetMaturity: string, nodeId: string,
): void {
  if (currentMaturity === targetMaturity) return;
  const allowed = SPATIAL_NODE_MATURITY_TRANSITIONS[currentMaturity];
  if (!allowed || !allowed.includes(targetMaturity)) {
    throw new StateMachineError(
      WritingErrorCode.INVALID_STATUS_TRANSITION,
      currentMaturity, targetMaturity, 'WritingSpatialNode', nodeId,
    );
  }
}

/** 空间边状态转换 */
const SPATIAL_EDGE_STATUS_TRANSITIONS: Record<string, string[]> = {
  candidate: ['confirmed', 'archived'],
  confirmed: ['submitted', 'archived'],
  submitted: ['committed', 'archived'],
  committed: [],
  archived: [],
};

export function validateSpatialEdgeStatus(
  currentStatus: string, targetStatus: string, edgeId: string,
): void {
  if (currentStatus === targetStatus) return;
  const allowed = SPATIAL_EDGE_STATUS_TRANSITIONS[currentStatus];
  if (!allowed || !allowed.includes(targetStatus)) {
    throw new StateMachineError(
      WritingErrorCode.INVALID_STATUS_TRANSITION,
      currentStatus, targetStatus, 'WritingSpatialEdge', edgeId,
    );
  }
}

// ===========================================================================
// Phase 10：章节规划 + 场景规划状态机
// ===========================================================================

/** 章节规划状态转换 */
const CHAPTER_PLAN_STATUS_TRANSITIONS: Record<string, string[]> = {
  planned: ['drafting'],
  drafting: ['written', 'planned'],
  written: ['revising', 'planned'],
  revising: ['written', 'done'],
  done: ['revising'],
};

export function validateChapterPlanStatus(
  currentStatus: string, targetStatus: string, chapterId: string,
): void {
  if (currentStatus === targetStatus) return;
  const allowed = CHAPTER_PLAN_STATUS_TRANSITIONS[currentStatus];
  if (!allowed || !allowed.includes(targetStatus)) {
    throw new StateMachineError(
      WritingErrorCode.INVALID_STATUS_TRANSITION,
      currentStatus, targetStatus, 'ChapterPlan', chapterId,
    );
  }
}

/** 场景规划状态转换 */
const SCENE_PLAN_STATUS_TRANSITIONS: Record<string, string[]> = {
  planned: ['drafting'],
  drafting: ['written', 'planned', 'cut'],
  written: ['reviewing', 'planned', 'cut'],
  reviewing: ['done', 'written', 'cut'],
  done: ['revising', 'cut'],
  cut: ['planned'],
};

export function validateScenePlanStatus(
  currentStatus: string, targetStatus: string, sceneId: string,
): void {
  if (currentStatus === targetStatus) return;
  const allowed = SCENE_PLAN_STATUS_TRANSITIONS[currentStatus];
  if (!allowed || !allowed.includes(targetStatus)) {
    throw new StateMachineError(
      WritingErrorCode.INVALID_STATUS_TRANSITION,
      currentStatus, targetStatus, 'ScenePlan', sceneId,
    );
  }
}

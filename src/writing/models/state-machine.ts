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
  'drafting':             ['ready_to_simulate', 'archived'],
  'ready_to_simulate':    ['simulated', 'drafting', 'archived'],
  'simulated':            ['committed', 'drafting', 'archived'],
  'committed':            [],
  'archived':             ['drafting'],
  'error':                ['drafting', 'archived'],
};

export function validateDraftTransition(
  currentStatus: string,
  targetStatus: string,
  draftId: string,
): void {
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
  'approved':   ['registered', 'deprecated', 'candidate'],
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
  'author_approved':   ['committed', 'commit_failed'],
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
 */
export function validateCommitReadiness(params: {
  proposalViewStatus: string;
  sourceDraftStatus?: string;
  sourceDraftDeleted?: boolean;
}): { valid: boolean; reason?: string } {
  if (params.proposalViewStatus !== 'author_approved') {
    return { valid: false, reason: '提案尚未获得作者批准' };
  }
  if (params.sourceDraftStatus) {
    if (
      params.sourceDraftStatus === 'drafting' ||
      params.sourceDraftStatus === 'ready_to_simulate'
    ) {
      return { valid: false, reason: '来源草案在审核期间被修改，需要重新推演' };
    }
    if (params.sourceDraftDeleted) {
      return { valid: false, reason: '来源草案已被删除' };
    }
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

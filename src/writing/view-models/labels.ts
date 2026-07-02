// =============================================================================
// ViewModel 标签映射——内部枚举 → 面向作者的人话标签（§9.2）
// =============================================================================
// 写作层向 UI（CLI/WebUI）输出的 ViewModel 只含人话字段，绝不暴露英文枚举值。
// 本模块集中维护枚举→中文标签的映射，供各 ViewModel 投影复用。
//
// 标签取值对齐 §9.2 示例（"构思中/写作中/审核中"、"规划/写作/审核"、
// "起草中/可推演/已提交"、"实体注册/提案审核"）；示例未列出的枚举值按同义原则补全。
// 未知枚举值降级为原始字符串——既不崩、又可追溯（避免静默吞掉新枚举）。
// =============================================================================

import type {
  ProjectStatus,
  WorkspaceMode,
  DraftStatus,
  DecisionKind,
} from '../models/types.js';

/** ProjectStatus → 项目状态标签（§9.2） */
const PROJECT_STATUS_LABELS: Record<ProjectStatus, string> = {
  planning: '构思中',
  drafting: '写作中',
  reviewing: '审核中',
  paused: '已暂停',
  archived: '已归档',
};

/** WorkspaceMode → 工作区模式标签（§9.2） */
const WORKSPACE_MODE_LABELS: Record<WorkspaceMode, string> = {
  planning: '规划',
  writing: '写作',
  reviewing: '审核',
  analysis: '分析',
  importing: '导入',
};

/** DraftStatus → 草案状态标签（§9.2） */
const DRAFT_STATUS_LABELS: Record<DraftStatus, string> = {
  drafting: '起草中',
  ready_to_simulate: '可推演',
  simulated: '已推演',
  committed: '已提交',
  revising: '追改中',
  archived: '已归档',
  error: '出错',
};

/** DecisionKind → 决策类型标签（§9.2；'general' 为兜底类，无专属审核页） */
const DECISION_KIND_LABELS: Record<DecisionKind, string> = {
  confirm_entity: '实体注册',
  confirm_draft: '草案确认',
  confirm_proposal: '提案审核',
  confirm_retcon: '修订审核',
  confirm_blueprint: '蓝图确认',
  confirm_rule: '规则确认',
  general: '通用事项',
};

/** 枚举→标签的通用降级：命中映射取中文，未命中回退原始字符串 */
function labelOf<T extends string>(map: Record<T, string>, value: string): string {
  return (map as Record<string, string>)[value] ?? value;
}

export function projectStatusLabel(status: string): string {
  return labelOf(PROJECT_STATUS_LABELS, status);
}

export function workspaceModeLabel(mode: string): string {
  return labelOf(WORKSPACE_MODE_LABELS, mode);
}

export function draftStatusLabel(status: string): string {
  return labelOf(DRAFT_STATUS_LABELS, status);
}

export function decisionKindLabel(kind: string): string {
  return labelOf(DECISION_KIND_LABELS, kind);
}

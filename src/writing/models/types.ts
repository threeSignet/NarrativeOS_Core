// =============================================================================
// Writing Layer — 领域对象类型定义
// =============================================================================
// Phase 7 写作层全部领域对象类型。与 writing-store.ts 的 DDL 和行类型
// 严格对齐，字段命名使用 camelCase（与 Agent 类型保持一致）。
//
// 设计要点：
//   - 每个对象有明确的 status 字段，状态跳转由 §17 校验函数守卫
//   - 所有对象都有 sourceRefs，追溯来源（§4 SourceRef 模型）
//   - Core 引用使用 coreEntityId / coreEventId 等字段，Core 不是真相源
//   - 对应 Feature Spec §30 Phase 7 数据模型与状态机细化
// =============================================================================

import type { SourceRef } from './source-ref.js';

// =============================================================================
// WritingProject（§3.1 创建作品）
// =============================================================================

export type ProjectStatus =
  | 'planning'
  | 'drafting'
  | 'reviewing'
  | 'paused'
  | 'archived';

export type WorkspaceMode =
  | 'planning'
  | 'writing'
  | 'reviewing'
  | 'analysis'
  | 'importing';

export interface WritingProject {
  id: string;
  title: string;
  premise?: string;
  status: ProjectStatus;
  activeBlueprintId?: string;
  currentDraftId?: string;
  workspaceMode: WorkspaceMode;
  sourceRefs: SourceRef[];
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

// =============================================================================
// AuthorGoal（§3.2 编辑作品目标）
// =============================================================================

export type GoalKind = 'goal' | 'avoid' | 'style' | 'reader_experience';
export type GoalPriority = 'low' | 'normal' | 'high';
export type GoalScope = 'project' | 'volume' | 'chapter' | 'character' | 'thread';
export type GoalStatus = 'active' | 'paused' | 'archived';

export interface AuthorGoal {
  id: string;
  projectId: string;
  text: string;
  kind: GoalKind;
  priority: GoalPriority;
  scope: GoalScope;
  status: GoalStatus;
  sourceRefs: SourceRef[];
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

// =============================================================================
// IdeaCard（§5.1 捕捉灵感）
// =============================================================================

export type IdeaKind =
  | 'premise'
  | 'character'
  | 'location'
  | 'faction'
  | 'item'
  | 'mechanism'
  | 'theme'
  | 'style'
  | 'reference'
  | 'dialogue'
  | 'scene_image'
  | 'event'
  | 'other';

export type IdeaMaturity =
  | 'raw'
  | 'candidate'
  | 'structured'
  | 'ready_for_draft'
  | 'archived';

export type IdeaSource =
  | 'manual'
  | 'chat'
  | 'import'
  | 'prose_selection'
  | 'agent_suggestion';

export type AnalysisPolicy = 'normal' | 'quiet' | 'do_not_analyze';

export interface IdeaCard {
  id: string;
  projectId: string;
  content: string;
  summary?: string;
  kind: IdeaKind;
  maturity: IdeaMaturity;
  tags: string[];
  source: IdeaSource;
  analysisPolicy: AnalysisPolicy;
  sourceRefs: SourceRef[];
  linkedDraftIds: string[];
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

// =============================================================================
// ProjectBlueprint（§4 ProjectBlueprint）
// =============================================================================

export type BlueprintMaturity =
  | 'implicit'
  | 'drafted'
  | 'reviewed'
  | 'active'
  | 'evolving'
  | 'archived'
  | 'superseded';

export type BlueprintTypeDefStatus = 'candidate' | 'accepted' | 'deprecated' | 'merged';

export interface BlueprintTypeDef {
  id: string;
  label: string;
  description?: string;
  parentTypeId?: string;
  aliases: string[];
  examples: string[];
  properties?: Record<string, unknown>;
  status: BlueprintTypeDefStatus;
  sourceRefs: SourceRef[];
  coreMapping?: BlueprintCoreMapping;
}

/** 蓝图类型到 Core 的映射——低置信度时不自动使用，需作者确认 */
export interface BlueprintCoreMapping {
  entityKind?: string;
  predicate?: string;
  relationKind?: string;
  confidence: number;
  explanation: string;
  requiresWorldPackageExtension?: boolean;
}

export interface BlueprintChangeSuggestion {
  id: string;
  kind: 'entity_type' | 'relation_type' | 'spatial_type' | 'view' | 'workflow';
  naturalLanguageSummary: string;
  reason: string;
  examples: string[];
  confidence: number;
  status: 'suggested' | 'accepted' | 'modified' | 'dismissed' | 'muted';
  sourceRefs: SourceRef[];
}

export interface ProjectBlueprint {
  id: string;
  projectId: string;
  version: number;
  maturity: BlueprintMaturity;
  entityTypes: BlueprintTypeDef[];
  relationTypes: BlueprintTypeDef[];
  spatialNodeTypes: BlueprintTypeDef[];
  spatialEdgeTypes: BlueprintTypeDef[];
  workflowPresets: string[];
  graphViewPresets: string[];
  sourceRefs: SourceRef[];
  changeSuggestions: BlueprintChangeSuggestion[];
  supersededBy?: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

// =============================================================================
// WritingDraft（§6 草案系统）
// =============================================================================

export type DraftKind =
  | 'concept'
  | 'setting'
  | 'scene'
  | 'chapter'
  | 'act'
  | 'event'
  | 'prose'
  | 'rule'
  | 'thread';

export type DraftStatus =
  | 'drafting'
  | 'ready_to_simulate'
  | 'simulated'
  | 'committed'
  | 'archived'
  | 'error';

export interface WritingDraft {
  id: string;
  projectId: string;
  kind: DraftKind;
  chapter: number;
  title?: string;
  content: string;
  summary?: string;
  status: DraftStatus;
  sourceRefs: SourceRef[];
  linkedProposalViewId?: string;
  versionGroupId?: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

// =============================================================================
// WritingEntitySketch（§7 实体系统）
// =============================================================================

export type EntitySketchStatus =
  | 'hint'
  | 'candidate'
  | 'approved'
  | 'registered'
  | 'deprecated'
  | 'merged'
  | 'error';

export interface WritingEntitySketch {
  id: string;
  projectId: string;
  displayName: string;
  typeLabel: string;
  summary?: string;
  aliases: string[];
  tags: string[];
  status: EntitySketchStatus;
  sourceRefs: SourceRef[];
  coreEntityId?: string;
  coreKind?: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

// =============================================================================
// PendingDecisionItem（§33.8 WorkflowService 契约）
// =============================================================================

export type DecisionKind =
  | 'confirm_entity'
  | 'confirm_draft'
  | 'confirm_proposal'
  | 'confirm_retcon'
  | 'confirm_blueprint'
  | 'confirm_rule'
  | 'general';

export type DecisionStatus = 'open' | 'resolved' | 'dismissed' | 'expired';

export interface PendingDecisionItem {
  id: string;
  projectId: string;
  kind: DecisionKind;
  title: string;
  description?: string;
  sourceRefs: SourceRef[];
  linkedObjectId?: string;
  linkedObjectType?: string;
  status: DecisionStatus;
  resolvedAt?: string;
  resolutionNote?: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

// =============================================================================
// WritingProposalView（§34 Proposal Review 视图模型）
// =============================================================================

export type ProposalType =
  | 'event'
  | 'entity_registration'
  | 'thread'
  | 'knowledge'
  | 'schema_extension'
  | 'retcon';

export type ProposalViewStatus =
  | 'open'
  | 'author_approved'
  | 'author_rejected'
  | 'committed'
  | 'commit_failed'
  | 'expired'
  | 'superseded';

export interface FactDiffEntry {
  op: 'new' | 'updated' | 'retracted';
  humanDescription: string;
  entityName: string;
  predicateLabel: string;
  newValue: string;
  oldValue?: string;
  coreFactId?: string;
}

export interface RuleWarning {
  level: 'info' | 'warning' | 'blocker';
  message: string;
  sourceRuleId?: string;
}

export interface WritingProposalView {
  id: string;
  projectId: string;
  sourceDraftId?: string;
  sourceEntitySketchId?: string;
  proposalType: ProposalType;
  coreProposalId?: string;
  coreBridgeResult?: unknown;
  status: ProposalViewStatus;
  humanSummary?: string;
  factDiff: FactDiffEntry[];
  involvedEntityIds: string[];
  ruleWarnings: RuleWarning[];
  authorDecision?: string;
  authorDecisionAt?: string;
  coreEventId?: string;
  commitError?: unknown;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

// =============================================================================
// WritingAuditLog（§33.10 AuditService 契约）
// =============================================================================

export type AuditTrigger =
  | 'author_action'
  | 'agent_suggestion'
  | 'editor_cursor_feedback'
  | 'draft_conversion'
  | 'import_analysis'
  | 'review_decision'
  | 'system_recovery';

export type AuditResult = 'success' | 'failure' | 'partial';

export interface WritingAuditLog {
  id: string;
  projectId: string;
  action: string;
  targetType?: string;
  targetId?: string;
  triggerSource: AuditTrigger;
  result: AuditResult;
  detail?: unknown;
  errorCode?: string;
  requestId?: string;
  sessionId?: string;
  createdAt: string;
}

// =============================================================================
// WritingCoreRef（§27.4 CoreReferenceIndex）
// =============================================================================

export type WritingObjectType =
  | 'project'
  | 'draft'
  | 'entity_sketch'
  | 'proposal_view'
  | 'blueprint'
  | 'idea_card'
  | 'pending_decision';

export type CoreObjectType =
  | 'entity'
  | 'event'
  | 'fact'
  | 'thread'
  | 'knowledge'
  | 'proposal';

export type RefStatus = 'active' | 'stale' | 'broken';

export interface WritingCoreRef {
  id: string;
  projectId: string;
  writingObjectType: WritingObjectType;
  writingObjectId: string;
  coreObjectType: CoreObjectType;
  coreObjectId: string;
  refStatus: RefStatus;
  lastVerifiedAt?: string;
  createdAt: string;
}

// =============================================================================
// WritingJob（§41 异步任务）
// =============================================================================

export type JobStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'needs_attention';

export type JobCreator = 'author' | 'agent' | 'system';

export interface WritingJob {
  id: string;
  projectId: string;
  jobType: string;
  status: JobStatus;
  progress: number;
  summary?: string;
  inputRefs: string[];
  outputRefs: string[];
  error?: unknown;
  createdBy: JobCreator;
  createdAt: string;
  updatedAt: string;
}

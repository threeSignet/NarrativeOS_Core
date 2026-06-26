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
  version: number;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

// =============================================================================
// WorkspaceLayout（§3.1 默认工作台布局 / §22.1 工作台布局容器）
// =============================================================================
// 项目级工作台布局状态容器（与项目 1:1）。Phase 7 写作层只持久化「面板布局 JSON 快照」+
// 乐观锁版本号；Feature-Spec §22.1 描述的多面板拖拽、聚焦历史、保存预设、按工作模式切换面板
// 组合等交互行为属 PC 端 UI 层职责（不在 Phase 7 写作层范围）。此处的 JSON 容器为 UI 层预留
// 持久化落点——UI 把当前面板排列序列化存入 panelLayout，写作层只负责可靠存取 + 并发版本控制，
// 不解析其结构（故类型为 unknown，结构契约由 UI 层定义）。
export interface WorkspaceLayout {
  id: string;
  projectId: string;
  /** 面板布局快照（UI 层自由结构：可见面板、尺寸、排列等）。创建时为 {} */
  panelLayout: unknown;
  /** 乐观锁版本号——每次更新 +1，updateWorkspaceLayout 以此做并发冲突检测 */
  version: number;
  createdAt: string;
  updatedAt: string;
}

// =============================================================================
// ProjectPreferenceProfile（§3.1 项目级作者偏好容器）
// =============================================================================
// 项目级作者偏好聚合容器（与项目 1:1），承载类型/关系/空间/视图/工作流等「创作工作偏好」。
// Phase 7 在 createProject 时初始化为空容器（preferences = {}），随作者表达偏好逐步填充。
// 与 §18 StyleGuide 正交：StyleGuide 是「语言风格」（人称/节奏/句式/禁用表达），属行文层；
// 本容器是「创作工作偏好」，属项目元数据层，两者各自独立持久化。结构契约由消费层定义，故
// 类型为 unknown。
export interface ProjectPreferenceProfile {
  id: string;
  projectId: string;
  /** 项目级作者偏好聚合（UI/服务层自由结构）。创建时为 {} */
  preferences: unknown;
  /** 乐观锁版本号——每次更新 +1，updateProjectPreferenceProfile 以此做并发冲突检测 */
  version: number;
  createdAt: string;
  updatedAt: string;
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
  /** 乐观锁版本号——每次更新 +1，updateDraft 以此做并发冲突检测 */
  version: number;
  sourceRefs: SourceRef[];
  linkedProposalViewId?: string;
  /** 版本链分组 ID（同名/同事件的草案修订链），与乐观锁 version 是两个概念 */
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
  version: number;
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

/**
 * 一次沙盒推演的原始输入（W9）
 *
 * simulateDraftAsEvent 接收这些参数调 propose_event；为支持「重新推演」（simulateProposal），
 * 它们被持久化到 ProposalView，以便对审核中的提案用相同输入重跑 propose_event、对照最新 Core 状态
 * 产出新鲜后果。factChanges 是 Agent 传入的 snake_case DSL 原文（含 ent_ 主体、change_id）——
 * 注意它是内部存储字段（非 ViewModel），§9.1 过滤在投影层（buildProposalReviewData）完成。
 */
export interface SimulationInputs {
  /** 事件描述（草案 summary/title 兜底） */
  eventDescription: string;
  /** 事件类型（draft.kind，event→custom） */
  eventType: string;
  /** 章节号 */
  chapter: number;
  /** 事实变更 DSL 原文（snake_case，Agent 传入） */
  factChanges: unknown[];
}

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
  /**
   * W14：PV 来源追溯（§4 SourceRef 模型）——本 PV 由哪个草案/灵感/蓝图触发。
   * 与 sourceDraftId 互补：sourceDraftId 是结构化 FK（单源），sourceRefs 是可扩展来源链（可含多源）。
   */
  sourceRefs: SourceRef[];
  proposalType: ProposalType;
  coreProposalId?: string;
  coreBridgeResult?: unknown;
  status: ProposalViewStatus;
  humanSummary?: string;
  factDiff: FactDiffEntry[];
  involvedEntityIds: string[];
  ruleWarnings: RuleWarning[];
  /**
   * W9：本次推演的原始输入（持久化以支持重新推演 simulateProposal）。
   * 仅 simulateDraft 产出的 PV 携带；实体注册等其它来源的 PV 为 undefined。
   */
  simulationInputs?: SimulationInputs;
  authorDecision?: string;
  authorDecisionAt?: string;
  coreEventId?: string;
  commitError?: unknown;
  version: number;
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
  /**
   * W14：审计来源追溯——本次动作由哪个创作对象（草案/灵感/蓝图）触发。
   * 与 triggerSource（谁触发：作者/Agent/系统）互补，记录"触发对象"而非"触发者"。
   */
  sourceRefs: SourceRef[];
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

// =============================================================================
// Phase 8：实体关系与图谱
// =============================================================================

/** 关系层级——决定关系能否进入 Proposal Review（仅 world 层可提交 Core） */
export type RelationLayer = 'world' | 'authoring' | 'analysis' | 'view' | 'reader_model';

/** 关系方向 */
export type RelationDirection = 'directed' | 'bidirectional' | 'undirected' | 'hierarchical';

/** 关系候选状态机：candidate → drafted → submitted → committed（或 rejected/archived） */
export type RelationCandidateStatus =
  | 'candidate' | 'drafted' | 'submitted' | 'committed' | 'rejected' | 'archived';

/**
 * 写作对象引用——关联关系可指向非实体对象（章节/草案/伏笔/灵感）
 */
export interface WritingObjectRef {
  objectType: 'entity' | 'chapter' | 'draft' | 'thread' | 'idea';
  objectId: string;
}

/** Core 关系引用——候选关系提交到 Core 后回写的 Fact 引用 */
export interface CoreRelationRef {
  factId: string;
  predicate: string;
  relationKind: string;
}

/** 关系时间范围 */
export interface RelationTemporalScope {
  fromChapter?: number;
  toChapter?: number;
  validAtChapters?: number[];
}

/**
 * 关系候选（WritingRelationCandidate）——正式世界关系候选
 * world 层候选可经 Proposal Review 提交到 Core。设计依据：Feature-Spec §8.4
 */
export interface WritingRelationCandidate {
  id: string;
  projectId: string;
  sourceEntityId: string;
  targetEntityId: string;
  relationTypeId: string;
  layer: RelationLayer;
  direction: RelationDirection;
  strength?: number;
  temporalScope?: RelationTemporalScope;
  sourceRefs: SourceRef[];
  status: RelationCandidateStatus;
  coreRefs?: CoreRelationRef[];
  version: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * 创作关联（AuthoringAssociation）——作者手动标注，不进 Core
 * 设计依据：Feature-Spec §8.3
 */
export interface AuthoringAssociation {
  id: string;
  projectId: string;
  sourceRef: WritingObjectRef;
  targetRef: WritingObjectRef;
  label: string;
  kind: 'reference' | 'echo' | 'theme' | 'draft_link' | 'evidence' | 'note' | 'manual';
  sourceRefs: SourceRef[];
  status: 'active' | 'archived';
  createdAt: string;
  updatedAt: string;
}

/**
 * 关系检测提示（RelationDetectionHint）——系统/Agent 检测到的潜在关系
 * 不自动成为候选。设计依据：Feature-Spec §8.1
 */
export interface RelationDetectionHint {
  id: string;
  projectId: string;
  sourceEntityId: string;
  targetEntityId: string;
  relationTypeId?: string;
  summary: string;
  sourceRefs: string[];
  confidence: number;
  possibleLayer: RelationLayer;
  status: 'new' | 'ignored' | 'merged' | 'converted_to_candidate';
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// GraphView 数据模型（Feature-Spec §10.1）
// ---------------------------------------------------------------------------

export type GraphViewMode = 'world' | 'relationship' | 'spatial' | 'timeline' | 'thread' | 'proposal' | 'custom';
export type GraphSourceLayer = 'committed' | 'candidate' | 'draft' | 'hint' | 'association' | 'spatial' | 'view';

export interface GraphNodeView {
  id: string;
  label: string;
  objectRef: WritingObjectRef;
  sourceLayer: GraphSourceLayer;
  projectTypeLabel: string;
  statusLabel: string;
  /** Core 实体 ID（ent_xxx），已注册实体才有——供前端导航到实体档案 */
  coreEntityId?: string;
  /** 实体描述/摘要（entity sketch.summary） */
  summary?: string;
  /** 实体标签（entity sketch.tags） */
  tags?: string[];
  /** 从 Core Fact 投影的关键属性（如 realm=筑基期、location=废弃站台） */
  attributes?: Array<{ predicate: string; value: string }>;
}

export interface GraphEdgeView {
  id: string;
  label: string;
  sourceNodeId: string;
  targetNodeId: string;
  objectRef?: WritingObjectRef;
  sourceLayer: GraphSourceLayer;
  direction: RelationDirection;
}

export interface GraphFilterState {
  layers?: RelationLayer[];
  relationTypes?: string[];
  entityTypes?: string[];
  statusFilter?: string[];
}

export interface GraphLayoutState {
  positions: Record<string, { x: number; y: number }>;
  layoutType: 'force' | 'hierarchy' | 'manual';
}

/**
 * 完整图谱视图——Phase 8 核心数据产物
 * 合并 Core Fact + 关系候选 + 创作关联 + 检测提示，投影成统一节点+边结构
 */
export interface GraphView {
  id: string;
  projectId: string;
  label: string;
  mode: GraphViewMode;
  nodes: GraphNodeView[];
  edges: GraphEdgeView[];
  filters: GraphFilterState;
  layout: GraphLayoutState;
}

// =============================================================================
// Phase 9：空间节点 / 空间边 / 空间视图（Feature-Spec §9.2-§9.4）
// =============================================================================

/** 空间节点成熟度（hint→candidate→confirmed→registered） */
export type SpatialNodeMaturity = 'hint' | 'candidate' | 'confirmed' | 'registered';

/** 空间节点状态 */
export type SpatialNodeStatus = 'active' | 'deprecated' | 'merged';

/** 空间边状态（candidate→confirmed→submitted→committed 或 archived） */
export type SpatialEdgeStatus = 'candidate' | 'confirmed' | 'submitted' | 'committed' | 'archived';

/** 空间边分层（对齐 RelationLayer 模式） */
export type SpatialEdgeLayer = 'world' | 'authoring' | 'analysis' | 'view';

/** 空间边方向 */
export type SpatialEdgeDirection = 'directed' | 'bidirectional' | 'undirected' | 'hierarchical';

/** 空间通行规则（可选） */
export interface SpatialTraversalRule {
  passable: boolean;
  condition?: string;
}

/**
 * 写作层空间节点——地点/空间层/区域/房间/宇宙分支/舰船舱段/梦境层等
 * 空间类型由 ProjectBlueprint.spatialNodeTypes 定义，不硬编码
 *
 * Feature-Spec §9.2
 */
export interface WritingSpatialNode {
  id: string;
  projectId: string;
  label: string;
  /** 引用 ProjectBlueprint.spatialNodeTypes[].id */
  typeId: string;
  aliases: string[];
  description?: string;
  sourceRefs: SourceRef[];
  maturity: SpatialNodeMaturity;
  status: SpatialNodeStatus;
  /** 可选注册 Core Entity（confirmed 后可注册） */
  coreEntityId?: string;
  properties: Record<string, unknown>;
  version: number;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

/**
 * 写作层空间边——空间节点之间的关系
 * 空间边类型由 ProjectBlueprint.spatialEdgeTypes 定义
 *
 * Feature-Spec §9.3
 */
export interface WritingSpatialEdge {
  id: string;
  projectId: string;
  sourceNodeId: string;
  targetNodeId: string;
  /** 引用 ProjectBlueprint.spatialEdgeTypes[].id */
  typeId: string;
  layer: SpatialEdgeLayer;
  direction: SpatialEdgeDirection;
  traversal?: SpatialTraversalRule;
  sourceRefs: SourceRef[];
  status: SpatialEdgeStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

/**
 * 空间视图——布局状态，不写 Core
 * 支持多种视图模式：graph/tree/plane/layered
 *
 * Feature-Spec §9.4
 */
export interface SpatialView {
  id: string;
  projectId: string;
  name: string;
  rootSpatialNodeId?: string;
  layerIds: string[];
  mode: 'graph' | 'tree' | 'plane' | 'layered';
  positions: Record<string, { x: number; y: number; z?: number }>;
  filters: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

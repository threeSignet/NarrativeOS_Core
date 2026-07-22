// =============================================================================
// SQLiteWritingStore — 写作层持久化适配器
// =============================================================================
// Phase 7 写作层持久化：11 张表（writing_projects / writing_author_goals /
// writing_idea_cards / writing_blueprints / writing_drafts /
// writing_entity_sketches / writing_pending_decisions /
// writing_proposal_views / writing_audit_logs / writing_core_refs /
// writing_jobs）。
//
// 设计要点：
//   - 与 FactStore / AgentStore 共享同一 SQLite 连接（同库不同表）
//   - DDL 幂等：使用 CREATE TABLE IF NOT EXISTS
//   - 所有写入使用 prepared statement
//   - JSON 字段使用 JSON.stringify / JSON.parse 序列化
//   - ID 格式：{prefix}_{timestamp}_{random}
//   - 软删除：deleted_at TEXT（NULL = 活跃，非 NULL = 已删除）
//   - 外键约束：关联 writing_projects
//   - 查询自动过滤 deleted_at IS NOT NULL
//
// 与现有代码的关系：
//   - agent-store.ts：同库同模式，writing_* 表与 agent_* 表平级
//   - fact-store.ts：共享 Database 实例，通过 getDatabase() 获取
//   - 写入流：Core 表由 Core 引擎写，writing_* 表由 Writing Layer 写
//
// 对应设计文档：
//   Phase7-Refinement.md §3（DDL）+ §6（类型）+ §16（CRUD）
//   Writing-Layer-Feature-Spec.md §30（数据模型）
// =============================================================================

import type Database from 'better-sqlite3';
import type {
  WritingProject, ProjectStatus, WorkspaceMode,
  WorkspaceLayout, ProjectPreferenceProfile,
  AuthorGoal, GoalKind, GoalPriority, GoalScope, GoalStatus,
  IdeaCard, IdeaKind, IdeaMaturity, IdeaSource, AnalysisPolicy,
  ProjectBlueprint, BlueprintMaturity, BlueprintTypeDef, BlueprintChangeSuggestion,
  WritingDraft, DraftKind, DraftStatus,
  WritingEntitySketch, EntitySketchStatus,
  PendingDecisionItem, DecisionKind,
  WritingProposalView, ProposalType, ProposalViewStatus,
  FactDiffEntry, RuleWarning, SimulationInputs,
  WritingAuditLog, AuditTrigger, AuditResult,
  WritingCoreRef, WritingObjectType, CoreObjectType, RefStatus,
  WritingJob, JobStatus, JobCreator,
  WritingRelationCandidate, RelationLayer, RelationDirection, RelationCandidateStatus,
  AuthoringAssociation, RelationDetectionHint,
  WritingObjectRef, CoreRelationRef, RelationTemporalScope,
  WritingSpatialNode, SpatialNodeMaturity, SpatialNodeStatus,
  WritingSpatialEdge, SpatialEdgeStatus, SpatialEdgeLayer, SpatialEdgeDirection, SpatialTraversalRule,
  SpatialView,
  ChapterPlan, ChapterPlanStatus,
  ScenePlan, ScenePlanStatus, ScenePurpose,
  ReaderAudienceProfile, ReaderAudienceKind,
  ReaderKnowledgeState, ReaderKnowledgeStateValue,
  ForeshadowingPlan, ForeshadowingPlanStatus, ForeshadowingKind,
  HintOccurrence, HintIntensity, HintVisibility, HintOccurrenceStatus,
  PayoffPlan, PayoffPlanStatus, PayoffKind,
  RevealPlan, RevealPlanStatus, RevealMilestone, RevealMilestoneKind,
  // Phase 12：正文 / 风格 / 修订 / Retcon视图 / 导入
  ProseDocument, ProseBlock, ProseBlockKind, ProseDocumentMode,
  StyleGuide, StyleExample, StyleExampleKind, BannedExpression,
  NarrativePerson, NarrativeDistance, PacingPreference, DescriptionPreference, StyleGuideStatus,
  RevisionRecord, RevisionTargetType, RevisionAction,
  RetconImpactReport, RetconReportStatus, RetconAffectedNode, RetconAffectedEdge, WritingArtifactRecheckItem,
  ImportBatch, ImportType, ImportBatchStatus,
  // 起草工作台：设定集文档树
  WritingDocument, WritingDocumentKind, WritingDocumentTemplate,
  DocumentContentFormat, WritingDocumentStatus,
} from '../models/types.js';
import type { SourceRef } from '../models/source-ref.js';
import { WritingError, WritingErrorCode } from '../errors/error-codes.js';
import {
  validateProjectTransition,
  validateIdeaTransition,
  validateBlueprintTransition,
  validateDraftTransition,
  validateEntitySketchTransition,
  validateProposalViewTransition,
  validateRelationCandidateTransition,
  validateSpatialNodeMaturity,
  validateSpatialEdgeStatus,
  validateChapterPlanStatus,
  validateScenePlanStatus,
} from '../models/state-machine.js';

// =============================================================================
// DDL — 13 张写作层表（W12 新增 writing_workspace_layouts / writing_project_preferences）
// =============================================================================

export const WRITING_DDL = `
-- W.1 writing_projects：作品项目根容器
CREATE TABLE IF NOT EXISTS writing_projects (
  id                   TEXT PRIMARY KEY,
  title                TEXT NOT NULL,
  premise              TEXT,
  status               TEXT NOT NULL DEFAULT 'planning'
                       CHECK(status IN ('planning','drafting','reviewing','paused','archived')),
  -- active_blueprint_id：作者手动标注引用，非系统真相源（§6 不变式，见 Phase7-Refinement.md）。
  -- 当前蓝图真相走 getActiveBlueprint() 的 maturity 派生；本列仅给未来 /project set 手动 pin 用，默认 NULL
  active_blueprint_id  TEXT,
  current_draft_id     TEXT,
  workspace_mode       TEXT NOT NULL DEFAULT 'planning'
                       CHECK(workspace_mode IN ('planning','writing','reviewing','analysis','importing')),
  version              INTEGER NOT NULL DEFAULT 1,
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at           TEXT
);
CREATE INDEX IF NOT EXISTS idx_wp_status ON writing_projects(status);
CREATE INDEX IF NOT EXISTS idx_wp_blueprint ON writing_projects(active_blueprint_id);

-- W.2 writing_author_goals：作者目标与禁用方向
CREATE TABLE IF NOT EXISTS writing_author_goals (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL,
  text             TEXT NOT NULL,
  kind             TEXT NOT NULL DEFAULT 'goal'
                   CHECK(kind IN ('goal','avoid','style','reader_experience')),
  priority         TEXT NOT NULL DEFAULT 'normal'
                   CHECK(priority IN ('low','normal','high')),
  scope            TEXT NOT NULL DEFAULT 'project'
                   CHECK(scope IN ('project','volume','chapter','character','thread')),
  status           TEXT NOT NULL DEFAULT 'active'
                   CHECK(status IN ('active','paused','archived')),
  source_refs_json TEXT NOT NULL DEFAULT '[]',
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at       TEXT,
  FOREIGN KEY (project_id) REFERENCES writing_projects(id)
);
CREATE INDEX IF NOT EXISTS idx_wag_project ON writing_author_goals(project_id, status);

-- W.3 writing_idea_cards：灵感与原始想法
CREATE TABLE IF NOT EXISTS writing_idea_cards (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL,
  content          TEXT NOT NULL,
  summary          TEXT,
  kind             TEXT NOT NULL DEFAULT 'other'
                   CHECK(kind IN ('premise','character','location','faction','item','mechanism','theme','style','reference','dialogue','scene_image','event','other')),
  maturity         TEXT NOT NULL DEFAULT 'raw'
                   CHECK(maturity IN ('raw','candidate','structured','ready_for_draft','archived')),
  tags_json        TEXT NOT NULL DEFAULT '[]',
  source           TEXT NOT NULL DEFAULT 'manual'
                   CHECK(source IN ('manual','chat','import','prose_selection','agent_suggestion')),
  analysis_policy  TEXT NOT NULL DEFAULT 'normal'
                   CHECK(analysis_policy IN ('normal','quiet','do_not_analyze')),
  source_refs_json TEXT NOT NULL DEFAULT '[]',
  linked_draft_ids_json TEXT NOT NULL DEFAULT '[]',
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at       TEXT,
  FOREIGN KEY (project_id) REFERENCES writing_projects(id)
);
CREATE INDEX IF NOT EXISTS idx_wic_project ON writing_idea_cards(project_id, maturity);
CREATE INDEX IF NOT EXISTS idx_wic_kind ON writing_idea_cards(project_id, kind);

-- W.4 writing_blueprints：项目柔性创作蓝图
CREATE TABLE IF NOT EXISTS writing_blueprints (
  id                     TEXT PRIMARY KEY,
  project_id             TEXT NOT NULL,
  version                INTEGER NOT NULL DEFAULT 1,
  maturity               TEXT NOT NULL DEFAULT 'implicit'
                         CHECK(maturity IN ('implicit','drafted','reviewed','active','evolving','archived','superseded')),
  entity_types_json      TEXT NOT NULL DEFAULT '[]',
  relation_types_json    TEXT NOT NULL DEFAULT '[]',
  spatial_node_types_json TEXT NOT NULL DEFAULT '[]',
  spatial_edge_types_json TEXT NOT NULL DEFAULT '[]',
  workflow_presets_json  TEXT NOT NULL DEFAULT '[]',
  graph_view_presets_json TEXT NOT NULL DEFAULT '[]',
  source_refs_json       TEXT NOT NULL DEFAULT '[]',
  change_suggestions_json TEXT NOT NULL DEFAULT '[]',
  superseded_by          TEXT,
  created_at             TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at             TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at             TEXT,
  FOREIGN KEY (project_id) REFERENCES writing_projects(id)
);
CREATE INDEX IF NOT EXISTS idx_wb_project ON writing_blueprints(project_id, maturity);
CREATE INDEX IF NOT EXISTS idx_wb_active ON writing_blueprints(project_id)
  WHERE maturity IN ('active', 'evolving');

-- W.5 writing_drafts：草案与事件草稿
CREATE TABLE IF NOT EXISTS writing_drafts (
  id                      TEXT PRIMARY KEY,
  project_id              TEXT NOT NULL,
  kind                    TEXT NOT NULL DEFAULT 'scene'
                          CHECK(kind IN ('concept','setting','scene','chapter','act','event','prose','rule','thread')),
  chapter                 INTEGER NOT NULL DEFAULT 1,
  title                   TEXT,
  content                 TEXT NOT NULL DEFAULT '',
  summary                 TEXT,
  status                  TEXT NOT NULL DEFAULT 'drafting'
                          CHECK(status IN ('drafting','ready_to_simulate','simulated','committed','revising','archived','error')),
  version                 INTEGER NOT NULL DEFAULT 1,
  source_refs_json        TEXT NOT NULL DEFAULT '[]',
  linked_proposal_view_id TEXT,
  version_group_id        TEXT,
  created_at              TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at              TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at              TEXT,
  FOREIGN KEY (project_id) REFERENCES writing_projects(id)
);
CREATE INDEX IF NOT EXISTS idx_wd_project ON writing_drafts(project_id, status);
CREATE INDEX IF NOT EXISTS idx_wd_proposal ON writing_drafts(linked_proposal_view_id);

-- W.6 writing_entity_sketches：候选实体与 Core 注册链接
CREATE TABLE IF NOT EXISTS writing_entity_sketches (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL,
  display_name     TEXT NOT NULL,
  type_label       TEXT NOT NULL DEFAULT 'unknown',
  summary          TEXT,
  aliases_json     TEXT NOT NULL DEFAULT '[]',
  tags_json        TEXT NOT NULL DEFAULT '[]',
  status           TEXT NOT NULL DEFAULT 'candidate'
                   CHECK(status IN ('hint','candidate','approved','registered','deprecated','merged','error')),
  source_refs_json TEXT NOT NULL DEFAULT '[]',
  core_entity_id   TEXT,
  core_kind        TEXT,
  version          INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at       TEXT,
  FOREIGN KEY (project_id) REFERENCES writing_projects(id)
);
CREATE INDEX IF NOT EXISTS idx_wes_project ON writing_entity_sketches(project_id, status);
CREATE INDEX IF NOT EXISTS idx_wes_core ON writing_entity_sketches(core_entity_id);
CREATE INDEX IF NOT EXISTS idx_wes_name ON writing_entity_sketches(project_id, display_name);

-- W.7 writing_pending_decisions：待确认事项
CREATE TABLE IF NOT EXISTS writing_pending_decisions (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL,
  kind             TEXT NOT NULL
                   CHECK(kind IN ('confirm_entity','confirm_draft','confirm_proposal','confirm_retcon','confirm_blueprint','confirm_rule','general')),
  title            TEXT NOT NULL,
  description      TEXT,
  source_refs_json TEXT NOT NULL DEFAULT '[]',
  linked_object_id TEXT,
  linked_object_type TEXT,
  status           TEXT NOT NULL DEFAULT 'open'
                   CHECK(status IN ('open','resolved','dismissed','expired')),
  resolved_at      TEXT,
  resolution_note  TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at       TEXT,
  FOREIGN KEY (project_id) REFERENCES writing_projects(id)
);
CREATE INDEX IF NOT EXISTS idx_wpend_project ON writing_pending_decisions(project_id, status);

-- W.8 writing_proposal_views：Proposal Review 视图状态
CREATE TABLE IF NOT EXISTS writing_proposal_views (
  id                     TEXT PRIMARY KEY,
  project_id             TEXT NOT NULL,
  source_draft_id        TEXT,
  source_entity_sketch_id TEXT,
  source_refs_json        TEXT NOT NULL DEFAULT '[]',
  proposal_type          TEXT NOT NULL DEFAULT 'event'
                         CHECK(proposal_type IN ('event','entity_registration','thread','knowledge','schema_extension','retcon')),
  core_proposal_id       TEXT,
  core_bridge_result_json TEXT NOT NULL DEFAULT '{}',
  status                 TEXT NOT NULL DEFAULT 'open'
                         CHECK(status IN ('open','author_approved','author_rejected','committed','commit_failed','expired','superseded')),
  human_summary          TEXT,
  fact_diff_json         TEXT NOT NULL DEFAULT '[]',
  involved_entity_ids_json TEXT NOT NULL DEFAULT '[]',
  rule_warnings_json     TEXT NOT NULL DEFAULT '[]',
  -- W9：本次推演的原始输入（eventDescription/eventType/chapter/factChanges），供重新推演 simulateProposal 重放
  simulation_inputs_json TEXT,
  author_decision        TEXT,
  author_decision_at     TEXT,
  core_event_id          TEXT,
  commit_error_json      TEXT,
  version                INTEGER NOT NULL DEFAULT 1,
  created_at             TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at             TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at             TEXT,
  FOREIGN KEY (project_id) REFERENCES writing_projects(id)
);
CREATE INDEX IF NOT EXISTS idx_wpv_project ON writing_proposal_views(project_id, status);
CREATE INDEX IF NOT EXISTS idx_wpv_core ON writing_proposal_views(core_proposal_id);

-- W.9 writing_audit_logs：操作与提交审计
CREATE TABLE IF NOT EXISTS writing_audit_logs (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL,
  action          TEXT NOT NULL,
  target_type     TEXT,
  target_id       TEXT,
  trigger_source  TEXT NOT NULL DEFAULT 'author_action',
  result          TEXT NOT NULL DEFAULT 'success'
                  CHECK(result IN ('success','failure','partial')),
  detail_json      TEXT NOT NULL DEFAULT '{}',
  source_refs_json TEXT NOT NULL DEFAULT '[]',
  error_code       TEXT,
  request_id       TEXT,
  session_id      TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (project_id) REFERENCES writing_projects(id)
);
CREATE INDEX IF NOT EXISTS idx_wal_project ON writing_audit_logs(project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_wal_target ON writing_audit_logs(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_wal_target_id ON writing_audit_logs(target_id);
CREATE INDEX IF NOT EXISTS idx_wal_action ON writing_audit_logs(project_id, action);

-- W.10 writing_core_refs：写作层对象到 Core ID 的引用索引
CREATE TABLE IF NOT EXISTS writing_core_refs (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL,
  writing_object_type TEXT NOT NULL,
  writing_object_id   TEXT NOT NULL,
  core_object_type    TEXT NOT NULL
                      CHECK(core_object_type IN ('entity','event','fact','thread','knowledge','proposal')),
  core_object_id      TEXT NOT NULL,
  ref_status          TEXT NOT NULL DEFAULT 'active'
                      CHECK(ref_status IN ('active','stale','broken')),
  last_verified_at    TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at          TEXT,
  FOREIGN KEY (project_id) REFERENCES writing_projects(id)
);
CREATE INDEX IF NOT EXISTS idx_wcr_writing ON writing_core_refs(writing_object_type, writing_object_id);
CREATE INDEX IF NOT EXISTS idx_wcr_core ON writing_core_refs(core_object_type, core_object_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_wcr_unique ON writing_core_refs(writing_object_type, writing_object_id, core_object_type, core_object_id);

-- W.11 writing_jobs：异步任务
CREATE TABLE IF NOT EXISTS writing_jobs (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL,
  job_type        TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'queued'
                  CHECK(status IN ('queued','running','succeeded','failed','cancelled','needs_attention')),
  progress        REAL NOT NULL DEFAULT 0.0,
  summary         TEXT,
  input_refs_json TEXT NOT NULL DEFAULT '[]',
  output_refs_json TEXT NOT NULL DEFAULT '[]',
  error_json      TEXT,
  created_by      TEXT NOT NULL DEFAULT 'system'
                  CHECK(created_by IN ('author','agent','system')),
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at      TEXT,
  FOREIGN KEY (project_id) REFERENCES writing_projects(id)
);
CREATE INDEX IF NOT EXISTS idx_wj_project ON writing_jobs(project_id, status);
CREATE INDEX IF NOT EXISTS idx_wj_type ON writing_jobs(project_id, job_type, status);

-- W.12 writing_workspace_layouts：工作台布局容器（§3.1 / §22.1，与项目 1:1）
-- project_id UNIQUE 保证一项目一布局。Phase 7 写作层只持久化面板布局 JSON 快照 + 乐观锁版本号；
-- 多面板拖拽/聚焦历史/保存预设/按工作模式切换面板组合等交互属 PC 端 UI 层（不在 Phase 7 范围），
-- 此处 panel_layout_json 为 UI 层预留自由结构落点。deleted_at 生命周期跟随项目（softDeleteProject 级联）。
CREATE TABLE IF NOT EXISTS writing_workspace_layouts (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL UNIQUE,
  panel_layout_json TEXT NOT NULL DEFAULT '{}',
  version           INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at        TEXT,
  FOREIGN KEY (project_id) REFERENCES writing_projects(id)
);
CREATE INDEX IF NOT EXISTS idx_wlay_project ON writing_workspace_layouts(project_id);

-- W.13 writing_project_preferences：项目级作者偏好容器（§3.1，与项目 1:1）
-- project_id UNIQUE 保证一项目一容器。createProject 时初始化为空 {}，随作者表达偏好逐步填充。
-- 承载类型/关系/空间/视图/工作流等「创作工作偏好」（与 §18 StyleGuide「语言风格」正交）。
CREATE TABLE IF NOT EXISTS writing_project_preferences (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL UNIQUE,
  preferences_json TEXT NOT NULL DEFAULT '{}',
  version          INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at       TEXT,
  FOREIGN KEY (project_id) REFERENCES writing_projects(id)
);
CREATE INDEX IF NOT EXISTS idx_wpref_project ON writing_project_preferences(project_id);

-- W.14 writing_relations：关系候选（Phase 8）
CREATE TABLE IF NOT EXISTS writing_relations (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL,
  source_entity_id    TEXT NOT NULL,
  target_entity_id    TEXT NOT NULL,
  relation_type_id    TEXT NOT NULL,
  layer               TEXT NOT NULL DEFAULT 'world',
  direction           TEXT NOT NULL DEFAULT 'directed',
  strength            REAL,
  temporal_scope_json TEXT DEFAULT '{}',
  source_refs_json    TEXT NOT NULL DEFAULT '[]',
  status              TEXT NOT NULL DEFAULT 'candidate',
  core_refs_json      TEXT DEFAULT '[]',
  version             INTEGER NOT NULL DEFAULT 1,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at          TEXT,
  FOREIGN KEY (project_id) REFERENCES writing_projects(id)
);
CREATE INDEX IF NOT EXISTS idx_wrel_project ON writing_relations(project_id, status);
CREATE INDEX IF NOT EXISTS idx_wrel_source ON writing_relations(source_entity_id);
CREATE INDEX IF NOT EXISTS idx_wrel_target ON writing_relations(target_entity_id);

-- W.15 writing_associations：创作关联（Phase 8）
CREATE TABLE IF NOT EXISTS writing_associations (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL,
  source_ref_json  TEXT NOT NULL,
  target_ref_json  TEXT NOT NULL,
  label            TEXT NOT NULL,
  kind             TEXT NOT NULL DEFAULT 'manual',
  source_refs_json TEXT NOT NULL DEFAULT '[]',
  status           TEXT NOT NULL DEFAULT 'active',
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_wassoc_project ON writing_associations(project_id, status);

-- W.16 writing_relation_hints：关系检测提示（Phase 8）
CREATE TABLE IF NOT EXISTS writing_relation_hints (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL,
  source_entity_id TEXT NOT NULL,
  target_entity_id TEXT NOT NULL,
  relation_type_id TEXT,
  summary          TEXT NOT NULL,
  source_refs_json TEXT NOT NULL DEFAULT '[]',
  confidence       REAL NOT NULL DEFAULT 0.5,
  possible_layer   TEXT NOT NULL DEFAULT 'world',
  status           TEXT NOT NULL DEFAULT 'new',
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_wrhint_project ON writing_relation_hints(project_id, status);

-- W.17 writing_spatial_nodes：空间节点（Phase 9）
CREATE TABLE IF NOT EXISTS writing_spatial_nodes (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL,
  label            TEXT NOT NULL,
  type_id          TEXT NOT NULL,
  aliases_json     TEXT NOT NULL DEFAULT '[]',
  description      TEXT,
  source_refs_json TEXT NOT NULL DEFAULT '[]',
  maturity         TEXT NOT NULL DEFAULT 'hint',
  status           TEXT NOT NULL DEFAULT 'active',
  core_entity_id   TEXT,
  properties_json  TEXT NOT NULL DEFAULT '{}',
  version          INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at       TEXT,
  FOREIGN KEY (project_id) REFERENCES writing_projects(id)
);
CREATE INDEX IF NOT EXISTS idx_wsnode_project ON writing_spatial_nodes(project_id, status);

-- W.18 writing_spatial_edges：空间边（Phase 9）
CREATE TABLE IF NOT EXISTS writing_spatial_edges (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL,
  source_node_id   TEXT NOT NULL,
  target_node_id   TEXT NOT NULL,
  type_id          TEXT NOT NULL,
  layer            TEXT NOT NULL DEFAULT 'world',
  direction        TEXT NOT NULL DEFAULT 'directed',
  traversal_json   TEXT DEFAULT '{}',
  source_refs_json TEXT NOT NULL DEFAULT '[]',
  status           TEXT NOT NULL DEFAULT 'candidate',
  version          INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at       TEXT,
  FOREIGN KEY (project_id) REFERENCES writing_projects(id)
);
CREATE INDEX IF NOT EXISTS idx_wsed_project ON writing_spatial_edges(project_id, status);

-- W.19 writing_spatial_views：空间视图（Phase 9）
CREATE TABLE IF NOT EXISTS writing_spatial_views (
  id                    TEXT PRIMARY KEY,
  project_id            TEXT NOT NULL,
  name                  TEXT NOT NULL,
  root_spatial_node_id  TEXT,
  layer_ids_json        TEXT NOT NULL DEFAULT '[]',
  mode                  TEXT NOT NULL DEFAULT 'graph',
  positions_json        TEXT NOT NULL DEFAULT '{}',
  filters_json          TEXT NOT NULL DEFAULT '{}',
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at            TEXT,
  FOREIGN KEY (project_id) REFERENCES writing_projects(id)
);
CREATE INDEX IF NOT EXISTS idx_wsv_project ON writing_spatial_views(project_id);

-- W.20 writing_chapter_plans：章节规划（Phase 10）
CREATE TABLE IF NOT EXISTS writing_chapter_plans (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL,
  sort_order          INTEGER NOT NULL DEFAULT 0,
  title               TEXT NOT NULL,
  goals_json          TEXT NOT NULL DEFAULT '[]',
  pov_entity_id       TEXT,
  linked_scene_ids_json  TEXT NOT NULL DEFAULT '[]',
  linked_thread_ids_json TEXT NOT NULL DEFAULT '[]',
  linked_draft_ids_json  TEXT NOT NULL DEFAULT '[]',
  prose_document_id   TEXT,
  status              TEXT NOT NULL DEFAULT 'planned',
  version             INTEGER NOT NULL DEFAULT 1,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at          TEXT,
  FOREIGN KEY (project_id) REFERENCES writing_projects(id)
);
CREATE INDEX IF NOT EXISTS idx_wcplan_project ON writing_chapter_plans(project_id, status);

-- W.21 writing_scene_plans：场景规划（Phase 10）
CREATE TABLE IF NOT EXISTS writing_scene_plans (
  id                    TEXT PRIMARY KEY,
  project_id            TEXT NOT NULL,
  chapter_id            TEXT NOT NULL,
  sort_order            INTEGER NOT NULL DEFAULT 0,
  title                 TEXT NOT NULL,
  purpose_json          TEXT NOT NULL DEFAULT '[]',
  pov_entity_id         TEXT,
  spatial_node_id       TEXT,
  temporal_ref          TEXT,
  participants_json     TEXT NOT NULL DEFAULT '[]',
  expected_outcome      TEXT,
  linked_prose_block_ids_json TEXT NOT NULL DEFAULT '[]',
  status                TEXT NOT NULL DEFAULT 'planned',
  version               INTEGER NOT NULL DEFAULT 1,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at            TEXT,
  FOREIGN KEY (project_id) REFERENCES writing_projects(id),
  FOREIGN KEY (chapter_id) REFERENCES writing_chapter_plans(id)
);
CREATE INDEX IF NOT EXISTS idx_wsplan_chapter ON writing_scene_plans(chapter_id, status);

-- W.22 writing_reader_audiences：读者群体配置（Phase 11）
CREATE TABLE IF NOT EXISTS writing_reader_audiences (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL,
  label       TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'target_reader',
  enabled     INTEGER NOT NULL DEFAULT 1,
  notes       TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at  TEXT,
  FOREIGN KEY (project_id) REFERENCES writing_projects(id)
);
CREATE INDEX IF NOT EXISTS idx_wra_project ON writing_reader_audiences(project_id);

-- W.23 writing_reader_knowledge_states：读者认知状态（Phase 11）
CREATE TABLE IF NOT EXISTS writing_reader_knowledge_states (
  id               TEXT PRIMARY KEY,
  audience_id      TEXT NOT NULL,
  narrative_position_type TEXT NOT NULL,
  narrative_position_id   TEXT NOT NULL,
  subject_ref      TEXT NOT NULL,
  state            TEXT NOT NULL DEFAULT 'unknown',
  confidence       REAL NOT NULL DEFAULT 0.5,
  source_refs_json TEXT NOT NULL DEFAULT '[]',
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (audience_id) REFERENCES writing_reader_audiences(id)
);
CREATE INDEX IF NOT EXISTS idx_wrks_audience ON writing_reader_knowledge_states(audience_id);

-- W.24 writing_foreshadowing_plans：伏笔计划（Phase 11）
CREATE TABLE IF NOT EXISTS writing_foreshadowing_plans (
  id                    TEXT PRIMARY KEY,
  project_id            TEXT NOT NULL,
  label                 TEXT NOT NULL,
  kind                  TEXT NOT NULL,
  target_reader_effect  TEXT NOT NULL DEFAULT '',
  linked_entity_refs_json TEXT NOT NULL DEFAULT '[]',
  linked_thread_id      TEXT,
  reveal_plan_id        TEXT,
  status                TEXT NOT NULL DEFAULT 'planned',
  version               INTEGER NOT NULL DEFAULT 1,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at            TEXT,
  FOREIGN KEY (project_id) REFERENCES writing_projects(id)
);
CREATE INDEX IF NOT EXISTS idx_wfp_project ON writing_foreshadowing_plans(project_id, status);

-- W.25 writing_hint_occurrences：暗示节点（Phase 11）
CREATE TABLE IF NOT EXISTS writing_hint_occurrences (
  id                    TEXT PRIMARY KEY,
  foreshadowing_plan_id TEXT NOT NULL,
  anchor_json           TEXT,
  chapter_id            TEXT,
  scene_id              TEXT,
  intensity             TEXT NOT NULL DEFAULT 'moderate',
  visibility            TEXT NOT NULL DEFAULT 'reader_visible',
  status                TEXT NOT NULL DEFAULT 'planned',
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (foreshadowing_plan_id) REFERENCES writing_foreshadowing_plans(id)
);
CREATE INDEX IF NOT EXISTS idx_who_plan ON writing_hint_occurrences(foreshadowing_plan_id);

-- W.26 writing_payoff_plans：回收计划（Phase 11）
CREATE TABLE IF NOT EXISTS writing_payoff_plans (
  id                    TEXT PRIMARY KEY,
  foreshadowing_plan_id TEXT NOT NULL,
  reveal_plan_id        TEXT,
  kind                  TEXT NOT NULL,
  target_chapter_id     TEXT,
  target_scene_id       TEXT,
  status                TEXT NOT NULL DEFAULT 'planned',
  notes                 TEXT,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (foreshadowing_plan_id) REFERENCES writing_foreshadowing_plans(id)
);
CREATE INDEX IF NOT EXISTS idx_wpp_plan ON writing_payoff_plans(foreshadowing_plan_id);

-- W.27 writing_reveal_plans：揭示计划（Phase 11 §16.3）
CREATE TABLE IF NOT EXISTS writing_reveal_plans (
  id                    TEXT PRIMARY KEY,
  project_id            TEXT NOT NULL,
  label                 TEXT NOT NULL,
  subject_description   TEXT NOT NULL DEFAULT '',
  linked_thread_id      TEXT,
  target_reader_effect  TEXT,
  status                TEXT NOT NULL DEFAULT 'planned',
  version               INTEGER NOT NULL DEFAULT 1,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at            TEXT,
  FOREIGN KEY (project_id) REFERENCES writing_projects(id)
);
CREATE INDEX IF NOT EXISTS idx_wrp_project ON writing_reveal_plans(project_id, status);

-- W.28 writing_reveal_milestones：揭示里程碑（Phase 11 §16.3）
CREATE TABLE IF NOT EXISTS writing_reveal_milestones (
  id              TEXT PRIMARY KEY,
  reveal_plan_id  TEXT NOT NULL,
  kind            TEXT NOT NULL,
  chapter_id      TEXT,
  scene_id        TEXT,
  description     TEXT NOT NULL DEFAULT '',
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (reveal_plan_id) REFERENCES writing_reveal_plans(id)
);
CREATE INDEX IF NOT EXISTS idx_wrm_plan ON writing_reveal_milestones(reveal_plan_id);

-- =============================================================================
-- Phase 12：正文 / 风格 / 修订 / Retcon视图 / 导入（Feature-Spec §13/§18/§19/§10.5/§20）
-- 数据层闭环。每张表遵循 W.N 编号 + 标准列 + CHECK + 索引约定。
-- =============================================================================

-- W.29 writing_prose_documents：正文文档（§13.8）。块级正文的容器。
CREATE TABLE IF NOT EXISTS writing_prose_documents (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL,
  title         TEXT NOT NULL DEFAULT '',
  version_id    TEXT NOT NULL,
  mode          TEXT NOT NULL DEFAULT 'edit'
                CHECK(mode IN ('edit','preview','split')),
  draft_id      TEXT,
  version       INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at    TEXT,
  FOREIGN KEY (project_id) REFERENCES writing_projects(id)
);
CREATE INDEX IF NOT EXISTS idx_wpd_project ON writing_prose_documents(project_id, deleted_at);

-- W.30 writing_prose_blocks：正文块（§13.8）。段落/对白/标题/注释/分隔，稳定 blockId。
CREATE TABLE IF NOT EXISTS writing_prose_blocks (
  id                TEXT PRIMARY KEY,
  document_id       TEXT NOT NULL,
  kind              TEXT NOT NULL DEFAULT 'paragraph'
                    CHECK(kind IN ('chapter_title','scene_heading','paragraph','dialogue','note','separator')),
  order_index       INTEGER NOT NULL DEFAULT 0,
  text              TEXT NOT NULL DEFAULT '',
  scene_id          TEXT,
  source_refs_json  TEXT NOT NULL DEFAULT '[]',
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (document_id) REFERENCES writing_prose_documents(id)
);
CREATE INDEX IF NOT EXISTS idx_wpb_doc ON writing_prose_blocks(document_id, order_index);
CREATE INDEX IF NOT EXISTS idx_wpb_scene ON writing_prose_blocks(scene_id);

-- W.31 writing_style_guides：风格指南（§18.1）。1:1 容器（项目默认指南，scope=default）。
CREATE TABLE IF NOT EXISTS writing_style_guides (
  id                            TEXT PRIMARY KEY,
  project_id                    TEXT NOT NULL,
  name                          TEXT NOT NULL DEFAULT '默认风格',
  narrative_person              TEXT NOT NULL DEFAULT 'unspecified'
                                CHECK(narrative_person IN ('first','third','omniscient','mixed','unspecified')),
  narrative_distance            TEXT NOT NULL DEFAULT 'variable'
                                CHECK(narrative_distance IN ('close','medium','distant','variable')),
  pacing_preference             TEXT NOT NULL DEFAULT 'balanced'
                                CHECK(pacing_preference IN ('tight','balanced','slow_burn','variable')),
  description_preference_json   TEXT NOT NULL DEFAULT '[]',
  banned_expression_ids_json    TEXT NOT NULL DEFAULT '[]',
  example_ids_json              TEXT NOT NULL DEFAULT '[]',
  scope                         TEXT NOT NULL DEFAULT 'default'
                                CHECK(scope IN ('default','variant')),
  scope_note                    TEXT,
  status                        TEXT NOT NULL DEFAULT 'draft'
                                CHECK(status IN ('draft','active','archived')),
  version                       INTEGER NOT NULL DEFAULT 1,
  created_at                    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at                    TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at                    TEXT,
  FOREIGN KEY (project_id) REFERENCES writing_projects(id)
);
CREATE INDEX IF NOT EXISTS idx_wsg_project ON writing_style_guides(project_id, scope, status);

-- W.32 writing_style_examples：风格示例（§18.2）。正向/反向样本文本。
CREATE TABLE IF NOT EXISTS writing_style_examples (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL,
  kind            TEXT NOT NULL DEFAULT 'positive'
                  CHECK(kind IN ('positive','negative')),
  text            TEXT NOT NULL DEFAULT '',
  note            TEXT,
  source_block_id TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at      TEXT,
  FOREIGN KEY (project_id) REFERENCES writing_projects(id)
);
CREATE INDEX IF NOT EXISTS idx_wse_project ON writing_style_examples(project_id, kind);

-- W.33 writing_banned_expressions：禁用表达（§18.3）。
CREATE TABLE IF NOT EXISTS writing_banned_expressions (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL,
  pattern     TEXT NOT NULL DEFAULT '',
  reason      TEXT,
  category    TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at  TEXT,
  FOREIGN KEY (project_id) REFERENCES writing_projects(id)
);
CREATE INDEX IF NOT EXISTS idx_wbe_project ON writing_banned_expressions(project_id);

-- W.34 writing_revision_records：通用修订记录（§19.1）。覆盖所有写作层对象版本历史。
CREATE TABLE IF NOT EXISTS writing_revision_records (
  id                    TEXT PRIMARY KEY,
  project_id            TEXT NOT NULL,
  target_type           TEXT NOT NULL,
  target_id             TEXT NOT NULL,
  action                TEXT NOT NULL,
  summary               TEXT NOT NULL DEFAULT '',
  before_snapshot_json  TEXT,
  after_snapshot_json   TEXT,
  version_group_id      TEXT NOT NULL,
  operator              TEXT NOT NULL DEFAULT 'author'
                        CHECK(operator IN ('author','agent')),
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at            TEXT,
  FOREIGN KEY (project_id) REFERENCES writing_projects(id)
);
CREATE INDEX IF NOT EXISTS idx_wrr_target ON writing_revision_records(target_type, target_id, created_at);
CREATE INDEX IF NOT EXISTS idx_wrr_group ON writing_revision_records(version_group_id);

-- W.35 writing_retcon_reports：Retcon 影响报告（§10.5/§19.4）。从 Core propose_retcon 结果投影。
CREATE TABLE IF NOT EXISTS writing_retcon_reports (
  id                       TEXT PRIMARY KEY,
  project_id               TEXT NOT NULL,
  retcon_proposal_id       TEXT NOT NULL,
  status                   TEXT NOT NULL DEFAULT 'pending'
                           CHECK(status IN ('pending','confirmed','rejected','superseded')),
  affected_nodes_json      TEXT NOT NULL DEFAULT '[]',
  affected_edges_json      TEXT NOT NULL DEFAULT '[]',
  recheck_list_json        TEXT NOT NULL DEFAULT '[]',
  summary                  TEXT NOT NULL DEFAULT '',
  created_at               TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at               TEXT NOT NULL DEFAULT (datetime('now')),
  confirmed_at             TEXT,
  deleted_at               TEXT,
  FOREIGN KEY (project_id) REFERENCES writing_projects(id)
);
CREATE INDEX IF NOT EXISTS idx_wrrp_proposal ON writing_retcon_reports(retcon_proposal_id);
CREATE INDEX IF NOT EXISTS idx_wrrp_project ON writing_retcon_reports(project_id, status);

-- W.36 writing_import_batches：导入批次（§20.1）。记录原始文本快照与切分结果。
CREATE TABLE IF NOT EXISTS writing_import_batches (
  id                         TEXT PRIMARY KEY,
  project_id                 TEXT NOT NULL,
  source_filename            TEXT,
  import_type                TEXT NOT NULL DEFAULT 'mixed'
                             CHECK(import_type IN ('prose','draft','setting_collection','chapter_fragment','mixed')),
  status                     TEXT NOT NULL DEFAULT 'pending'
                             CHECK(status IN ('pending','imported','cancelled','failed')),
  raw_snapshot               TEXT NOT NULL DEFAULT '',
  metadata_json              TEXT NOT NULL DEFAULT '{}',
  generated_document_ids_json TEXT NOT NULL DEFAULT '[]',
  created_at                 TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at                 TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at               TEXT,
  deleted_at                 TEXT,
  FOREIGN KEY (project_id) REFERENCES writing_projects(id)
);
CREATE INDEX IF NOT EXISTS idx_wib_project ON writing_import_batches(project_id, status);

-- W.37 writing_documents：设定集文档树节点（起草工作台）。文档树 + 富文本设定，
-- 不写 Core。与 W.29 writing_prose_documents 不同：prose 是章节正文的块级精细模型，
-- documents 是设定集的文档树组织载体。
CREATE TABLE IF NOT EXISTS writing_documents (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL,
  parent_id         TEXT,
  kind              TEXT NOT NULL DEFAULT 'document',
  template          TEXT NOT NULL DEFAULT 'freeform',
  title             TEXT NOT NULL,
  icon              TEXT,
  content           TEXT,
  content_format    TEXT DEFAULT 'tiptap',
  chapter_plan_id   TEXT,
  draft_id          TEXT,
  sort_order        INTEGER NOT NULL DEFAULT 0,
  template_fields_json TEXT,
  word_count        INTEGER DEFAULT 0,
  tags_json         TEXT NOT NULL DEFAULT '[]',
  status            TEXT NOT NULL DEFAULT 'active',
  version           INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at        TEXT,
  FOREIGN KEY (project_id) REFERENCES writing_projects(id),
  FOREIGN KEY (parent_id) REFERENCES writing_documents(id)
);
CREATE INDEX IF NOT EXISTS idx_wdoc_project ON writing_documents(project_id, status);
CREATE INDEX IF NOT EXISTS idx_wdoc_parent ON writing_documents(parent_id, sort_order);
`;

// =============================================================================
// ID 生成（与 agent-store.ts 模式一致）
// =============================================================================

/** 写作层 ID 前缀 */
const PREFIX = {
  project:          'wprj',
  author_goal:      'wagl',
  idea_card:        'wicd',
  blueprint:        'wblp',
  draft:            'wdft',
  entity_sketch:    'wesk',
  pending_decision: 'wpdc',
  proposal_view:    'wpvw',
  audit_log:        'waul',
  core_ref:         'wcref',
  job:              'wjob',
  // W12 §3.1 组合初始化：工作台布局 + 项目级偏好容器（均与项目 1:1）
  workspace_layout: 'wlay',
  project_preference: 'wpref',
  // Phase 12：正文 / 风格 / 修订 / Retcon视图 / 导入
  prose_document:    'wpd',
  prose_block:       'wpb',
  style_guide:       'wsg',
  style_example:     'wsty',
  banned_expression: 'wbe',
  revision_record:   'wrev',
  retcon_report:     'wrr',
  import_batch:      'wib',
} as const;

function makeId(prefix: string): string {
  const ts = Date.now();
  const rnd = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${ts}_${rnd}`;
}

// =============================================================================
// JSON 序列化辅助（与 agent-store.ts 模式一致）
// =============================================================================

function safeStringify(value: unknown): string {
  return JSON.stringify(value);
}

function safeParseJson<T = unknown>(text: string, id: string, field: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`writing-store: JSON 解析失败 — ${field} in record ${id}`);
  }
}

// =============================================================================
// 行类型（数据库返回的原始格式，snake_case）
// =============================================================================

export interface ProjectRow {
  id: string;
  title: string;
  premise: string | null;
  status: string;
  active_blueprint_id: string | null;
  current_draft_id: string | null;
  workspace_mode: string;
  version: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface AuthorGoalRow {
  id: string;
  project_id: string;
  text: string;
  kind: string;
  priority: string;
  scope: string;
  status: string;
  source_refs_json: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface IdeaCardRow {
  id: string;
  project_id: string;
  content: string;
  summary: string | null;
  kind: string;
  maturity: string;
  tags_json: string;
  source: string;
  analysis_policy: string;
  source_refs_json: string;
  linked_draft_ids_json: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface BlueprintRow {
  id: string;
  project_id: string;
  version: number;
  maturity: string;
  entity_types_json: string;
  relation_types_json: string;
  spatial_node_types_json: string;
  spatial_edge_types_json: string;
  workflow_presets_json: string;
  graph_view_presets_json: string;
  source_refs_json: string;
  change_suggestions_json: string;
  superseded_by: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface DraftRow {
  id: string;
  project_id: string;
  kind: string;
  chapter: number;
  title: string | null;
  content: string;
  summary: string | null;
  status: string;
  version: number;
  source_refs_json: string;
  linked_proposal_view_id: string | null;
  version_group_id: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface EntitySketchRow {
  id: string;
  project_id: string;
  display_name: string;
  type_label: string;
  summary: string | null;
  aliases_json: string;
  tags_json: string;
  status: string;
  source_refs_json: string;
  core_entity_id: string | null;
  core_kind: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface PendingDecisionRow {
  id: string;
  project_id: string;
  kind: string;
  title: string;
  description: string | null;
  source_refs_json: string;
  linked_object_id: string | null;
  linked_object_type: string | null;
  status: string;
  resolved_at: string | null;
  resolution_note: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface ProposalViewRow {
  id: string;
  project_id: string;
  source_draft_id: string | null;
  source_entity_sketch_id: string | null;
  source_refs_json: string;
  proposal_type: string;
  core_proposal_id: string | null;
  core_bridge_result_json: string;
  status: string;
  human_summary: string | null;
  fact_diff_json: string;
  involved_entity_ids_json: string;
  rule_warnings_json: string;
  simulation_inputs_json: string | null;
  author_decision: string | null;
  author_decision_at: string | null;
  core_event_id: string | null;
  commit_error_json: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface AuditLogRow {
  id: string;
  project_id: string;
  action: string;
  target_type: string | null;
  target_id: string | null;
  trigger_source: string;
  result: string;
  detail_json: string;
  source_refs_json: string;
  error_code: string | null;
  request_id: string | null;
  session_id: string | null;
  created_at: string;
}

// CoreReferenceIndex（writing_core_refs）是纯指针/索引表：ref 本身即"写作对象→Core 对象"的来源链接
// （writing_object_type/id 已捕获来源）。Feature-Spec §30.1 验收标准措辞为"所有**可追溯**对象都有来源字段"，
// 指针基础设施不属"可追溯创作对象"范畴——加 sourceRefs 即死列（无写入方/读取方）。故有意不加，避免死代码。
// （W14 范围决策，2026-06-14 用户确认排除 CoreReferenceIndex）
export interface CoreRefRow {
  id: string;
  project_id: string;
  writing_object_type: string;
  writing_object_id: string;
  core_object_type: string;
  core_object_id: string;
  ref_status: string;
  last_verified_at: string | null;
  created_at: string;
}

export interface JobRow {
  id: string;
  project_id: string;
  job_type: string;
  status: string;
  progress: number;
  summary: string | null;
  input_refs_json: string;
  output_refs_json: string;
  error_json: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface WorkspaceLayoutRow {
  id: string;
  project_id: string;
  panel_layout_json: string;
  version: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface ProjectPreferenceProfileRow {
  id: string;
  project_id: string;
  preferences_json: string;
  version: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

// =============================================================================
// 行 → 领域对象转换（snake_case → camelCase）
// =============================================================================

function rowToProject(row: ProjectRow): WritingProject {
  return {
    id: row.id,
    title: row.title,
    premise: row.premise ?? undefined,
    status: row.status as ProjectStatus,
    activeBlueprintId: row.active_blueprint_id ?? undefined,
    currentDraftId: row.current_draft_id ?? undefined,
    workspaceMode: row.workspace_mode as WorkspaceMode,
    sourceRefs: [], // Project 的 sourceRefs 在服务层构建，不在此层
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at ?? undefined,
  };
}

function rowToWorkspaceLayout(row: WorkspaceLayoutRow): WorkspaceLayout {
  return {
    id: row.id,
    projectId: row.project_id,
    // JSON 列解析为对象（UI 层自由结构）；解析失败抛错（与其它 JSON 列处理一致）
    panelLayout: safeParseJson(row.panel_layout_json, row.id, 'panel_layout_json'),
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToProjectPreferenceProfile(row: ProjectPreferenceProfileRow): ProjectPreferenceProfile {
  return {
    id: row.id,
    projectId: row.project_id,
    preferences: safeParseJson(row.preferences_json, row.id, 'preferences_json'),
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToGoal(row: AuthorGoalRow): AuthorGoal {
  return {
    id: row.id,
    projectId: row.project_id,
    text: row.text,
    kind: row.kind as GoalKind,
    priority: row.priority as GoalPriority,
    scope: row.scope as GoalScope,
    status: row.status as GoalStatus,
    sourceRefs: safeParseJson<SourceRef[]>(row.source_refs_json, row.id, 'source_refs_json'),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at ?? undefined,
  };
}

function rowToIdeaCard(row: IdeaCardRow): IdeaCard {
  return {
    id: row.id,
    projectId: row.project_id,
    content: row.content,
    summary: row.summary ?? undefined,
    kind: row.kind as IdeaKind,
    maturity: row.maturity as IdeaMaturity,
    tags: safeParseJson<string[]>(row.tags_json, row.id, 'tags_json'),
    source: row.source as IdeaSource,
    analysisPolicy: row.analysis_policy as AnalysisPolicy,
    sourceRefs: safeParseJson<SourceRef[]>(row.source_refs_json, row.id, 'source_refs_json'),
    linkedDraftIds: safeParseJson<string[]>(row.linked_draft_ids_json, row.id, 'linked_draft_ids_json'),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at ?? undefined,
  };
}

function rowToBlueprint(row: BlueprintRow): ProjectBlueprint {
  return {
    id: row.id,
    projectId: row.project_id,
    version: row.version,
    maturity: row.maturity as BlueprintMaturity,
    entityTypes: safeParseJson<BlueprintTypeDef[]>(row.entity_types_json, row.id, 'entity_types_json'),
    relationTypes: safeParseJson<BlueprintTypeDef[]>(row.relation_types_json, row.id, 'relation_types_json'),
    spatialNodeTypes: safeParseJson<BlueprintTypeDef[]>(row.spatial_node_types_json, row.id, 'spatial_node_types_json'),
    spatialEdgeTypes: safeParseJson<BlueprintTypeDef[]>(row.spatial_edge_types_json, row.id, 'spatial_edge_types_json'),
    workflowPresets: safeParseJson<string[]>(row.workflow_presets_json, row.id, 'workflow_presets_json'),
    graphViewPresets: safeParseJson<string[]>(row.graph_view_presets_json, row.id, 'graph_view_presets_json'),
    sourceRefs: safeParseJson<SourceRef[]>(row.source_refs_json, row.id, 'source_refs_json'),
    changeSuggestions: safeParseJson<BlueprintChangeSuggestion[]>(row.change_suggestions_json, row.id, 'change_suggestions_json'),
    supersededBy: row.superseded_by ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at ?? undefined,
  };
}

function rowToDraft(row: DraftRow): WritingDraft {
  return {
    id: row.id,
    projectId: row.project_id,
    kind: row.kind as DraftKind,
    chapter: row.chapter,
    title: row.title ?? undefined,
    content: row.content,
    summary: row.summary ?? undefined,
    status: row.status as DraftStatus,
    version: row.version,
    sourceRefs: safeParseJson<SourceRef[]>(row.source_refs_json, row.id, 'source_refs_json'),
    linkedProposalViewId: row.linked_proposal_view_id ?? undefined,
    versionGroupId: row.version_group_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at ?? undefined,
  };
}

function rowToEntitySketch(row: EntitySketchRow): WritingEntitySketch {
  return {
    id: row.id,
    projectId: row.project_id,
    displayName: row.display_name,
    typeLabel: row.type_label,
    summary: row.summary ?? undefined,
    aliases: safeParseJson<string[]>(row.aliases_json, row.id, 'aliases_json'),
    tags: safeParseJson<string[]>(row.tags_json, row.id, 'tags_json'),
    status: row.status as EntitySketchStatus,
    sourceRefs: safeParseJson<SourceRef[]>(row.source_refs_json, row.id, 'source_refs_json'),
    coreEntityId: row.core_entity_id ?? undefined,
    coreKind: row.core_kind ?? undefined,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at ?? undefined,
  };
}

function rowToDecision(row: PendingDecisionRow): PendingDecisionItem {
  return {
    id: row.id,
    projectId: row.project_id,
    kind: row.kind as DecisionKind,
    title: row.title,
    description: row.description ?? undefined,
    sourceRefs: safeParseJson<SourceRef[]>(row.source_refs_json, row.id, 'source_refs_json'),
    linkedObjectId: row.linked_object_id ?? undefined,
    linkedObjectType: row.linked_object_type ?? undefined,
    status: row.status as 'open' | 'resolved' | 'dismissed' | 'expired',
    resolvedAt: row.resolved_at ?? undefined,
    resolutionNote: row.resolution_note ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at ?? undefined,
  };
}

function rowToProposalView(row: ProposalViewRow): WritingProposalView {
  return {
    id: row.id,
    projectId: row.project_id,
    sourceDraftId: row.source_draft_id ?? undefined,
    sourceEntitySketchId: row.source_entity_sketch_id ?? undefined,
    // W14：PV 来源追溯（§4 SourceRef）——记录本 PV 由哪个草案/灵感/蓝图触发，与 sourceDraftId 互补
    // （sourceDraftId 是结构化 FK，sourceRefs 是可扩展的来源链，可含 idea/blueprint 等多源）
    sourceRefs: safeParseJson<SourceRef[]>(row.source_refs_json, row.id, 'source_refs_json'),
    proposalType: row.proposal_type as ProposalType,
    coreProposalId: row.core_proposal_id ?? undefined,
    coreBridgeResult: safeParseJson<unknown>(row.core_bridge_result_json, row.id, 'core_bridge_result_json'),
    status: row.status as ProposalViewStatus,
    humanSummary: row.human_summary ?? undefined,
    factDiff: safeParseJson<FactDiffEntry[]>(row.fact_diff_json, row.id, 'fact_diff_json'),
    involvedEntityIds: safeParseJson<string[]>(row.involved_entity_ids_json, row.id, 'involved_entity_ids_json'),
    ruleWarnings: safeParseJson<RuleWarning[]>(row.rule_warnings_json, row.id, 'rule_warnings_json'),
    // W9：simulation_inputs_json 可空（实体注册等来源的 PV 无推演输入）
    simulationInputs: row.simulation_inputs_json
      ? safeParseJson<SimulationInputs>(row.simulation_inputs_json, row.id, 'simulation_inputs_json')
      : undefined,
    authorDecision: row.author_decision ?? undefined,
    authorDecisionAt: row.author_decision_at ?? undefined,
    coreEventId: row.core_event_id ?? undefined,
    commitError: row.commit_error_json ? safeParseJson<unknown>(row.commit_error_json, row.id, 'commit_error_json') : undefined,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at ?? undefined,
  };
}

function rowToAuditLog(row: AuditLogRow): WritingAuditLog {
  return {
    id: row.id,
    projectId: row.project_id,
    action: row.action,
    targetType: row.target_type ?? undefined,
    targetId: row.target_id ?? undefined,
    triggerSource: row.trigger_source as AuditTrigger,
    result: row.result as AuditResult,
    detail: safeParseJson<unknown>(row.detail_json, row.id, 'detail_json'),
    // W14：审计来源追溯——记录"本次审计动作由哪个草案/灵感触发"，与 triggerSource（谁触发）互补
    sourceRefs: safeParseJson<SourceRef[]>(row.source_refs_json, row.id, 'source_refs_json'),
    errorCode: row.error_code ?? undefined,
    requestId: row.request_id ?? undefined,
    sessionId: row.session_id ?? undefined,
    createdAt: row.created_at,
  };
}

function rowToCoreRef(row: CoreRefRow): WritingCoreRef {
  return {
    id: row.id,
    projectId: row.project_id,
    writingObjectType: row.writing_object_type as WritingObjectType,
    writingObjectId: row.writing_object_id,
    coreObjectType: row.core_object_type as CoreObjectType,
    coreObjectId: row.core_object_id,
    refStatus: row.ref_status as RefStatus,
    lastVerifiedAt: row.last_verified_at ?? undefined,
    createdAt: row.created_at,
  };
}

function rowToJob(row: JobRow): WritingJob {
  return {
    id: row.id,
    projectId: row.project_id,
    jobType: row.job_type,
    status: row.status as JobStatus,
    progress: row.progress,
    summary: row.summary ?? undefined,
    inputRefs: safeParseJson<string[]>(row.input_refs_json, row.id, 'input_refs_json'),
    outputRefs: safeParseJson<string[]>(row.output_refs_json, row.id, 'output_refs_json'),
    error: row.error_json ? safeParseJson<unknown>(row.error_json, row.id, 'error_json') : undefined,
    createdBy: row.created_by as 'author' | 'agent' | 'system',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// =============================================================================
// SQLiteWritingStore
// =============================================================================

export class SQLiteWritingStore {
  private db: Database.Database;

  /**
   * @param db 共享的 better-sqlite3 Database 实例（与 FactStore / AgentStore 同库）
   *           调用 createTables() 或在初始化时执行 WRITING_DDL 建表
   */
  constructor(db: Database.Database) {
    this.db = db;
  }

  /** 执行 DDL 创建所有 writing_* 表（幂等：使用 IF NOT EXISTS） */
  createTables(): void {
    this.db.exec(WRITING_DDL);
  }

  /** 获取底层 Database 实例（供 NarrativeAgent 校验用） */
  getDatabase(): Database.Database {
    return this.db;
  }

  /**
   * 在单一事务内执行多个写操作（better-sqlite3 同步事务）。任一操作抛错则整体回滚。
   * 用于跨多表的原子性场景——如 ProjectService.createProject §3.1 组合初始化需一次创建
   * 项目 + 隐式蓝图 + 前提灵感 + 默认布局 + 偏好容器，任一失败不应留下部分创建的悬挂态。
   * better-sqlite3 的 transaction 支持嵌套（内层用 savepoint），故内部各 create* 方法即便
   * 自身不显式开事务也安全。
   */
  runInTransaction<T>(fn: () => T): T {
    const txn = this.db.transaction(fn);
    return txn();
  }

  // =========================================================================
  // writing_projects
  // =========================================================================

  createProject(title: string, premise?: string): WritingProject {
    const id = makeId(PREFIX.project);
    this.db.prepare(
      'INSERT INTO writing_projects (id, title, premise) VALUES (?, ?, ?)'
    ).run(id, title, premise ?? null);
    return this.getProject(id)!;
  }

  getProject(projectId: string): WritingProject | undefined {
    const row = this.db.prepare(
      'SELECT * FROM writing_projects WHERE id = ? AND deleted_at IS NULL'
    ).get(projectId) as ProjectRow | undefined;
    return row ? rowToProject(row) : undefined;
  }

  listProjects(): WritingProject[] {
    const rows = this.db.prepare(
      'SELECT * FROM writing_projects WHERE deleted_at IS NULL ORDER BY updated_at DESC'
    ).all() as ProjectRow[];
    return rows.map(rowToProject);
  }

  updateProject(projectId: string, updates: {
    title?: string;
    premise?: string | null;
    status?: ProjectStatus;
    activeBlueprintId?: string | null;
    currentDraftId?: string | null;
    workspaceMode?: WorkspaceMode;
  }, expectedVersion?: number): void {
    const parts: string[] = [];
    const values: unknown[] = [];

    // 状态机校验：若更新含 status，先查当前状态并 validate（运行时强制，与 draft/entitySketch/proposalView 对齐）
    if (updates.status !== undefined) {
      const current = this.db.prepare('SELECT status FROM writing_projects WHERE id = ?')
        .get(projectId) as { status: string } | undefined;
      if (current) {
        validateProjectTransition(current.status, updates.status, projectId);
      }
    }

    // 将 camelCase 字段映射到 snake_case 列名
    const fieldMap: Record<string, string> = {
      title: 'title',
      premise: 'premise',
      status: 'status',
      activeBlueprintId: 'active_blueprint_id',
      currentDraftId: 'current_draft_id',
      workspaceMode: 'workspace_mode',
    };

    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined) {
        const col = fieldMap[key]; if (!col) throw new Error(`未知更新字段: ${String(key)}`);
        parts.push(`${col} = ?`);
        values.push(value);
      }
    }
    if (parts.length === 0) return;

    parts.push("version = version + 1");
    parts.push("updated_at = datetime('now')");
    if (expectedVersion !== undefined) {
      // 乐观锁：传了 expectedVersion 时加 WHERE version = ? 条件
      values.push(projectId, expectedVersion);
      const result = this.db.prepare(`UPDATE writing_projects SET ${parts.join(', ')} WHERE id = ? AND version = ?`).run(...values);
      if (result.changes === 0) {
        const row = this.db.prepare('SELECT version FROM writing_projects WHERE id = ?').get(projectId) as { version: number } | undefined;
        if (!row) throw new WritingError(WritingErrorCode.WRITING_OBJECT_NOT_FOUND, `项目不存在: ${projectId}`);
        throw new WritingError(WritingErrorCode.VERSION_CONFLICT, `项目版本冲突: 期望 ${expectedVersion}，实际 ${row.version}`, { expected: expectedVersion, actual: row.version });
      }
    } else {
      // 无乐观锁（向后兼容，内部调用如 reconcile 不传 version）
      values.push(projectId);
      this.db.prepare(`UPDATE writing_projects SET ${parts.join(', ')} WHERE id = ?`).run(...values);
    }
  }

  /** 级联软删除项目及其所有子表记录（audit_logs 除外） */
  softDeleteProject(projectId: string): void {
    const now = "datetime('now')";
    const childTables = [
      'writing_author_goals',
      'writing_idea_cards',
      'writing_blueprints',
      'writing_drafts',
      'writing_entity_sketches',
      'writing_pending_decisions',
      'writing_proposal_views',
      'writing_core_refs',
      'writing_jobs',
      // W12 §3.1：1:1 容器表，生命周期跟随项目
      'writing_workspace_layouts',
      'writing_project_preferences',
      // Phase 8（W.14/W.15/W.16）：关系候选/创作关联/检测提示，生命周期跟随项目。
      // 修复：此前遗漏会导致删除项目后留下孤儿行，破坏数据完整性。
      'writing_relations',
      'writing_associations',
      'writing_relation_hints',
      // Phase 9（W.17/W.18/W.19）：空间节点/空间边/空间视图，生命周期跟随项目。
      'writing_spatial_nodes',
      'writing_spatial_edges',
      'writing_spatial_views',
      // Phase 10（W.20/W.21）：章节规划/场景规划，生命周期跟随项目。
      'writing_chapter_plans',
      'writing_scene_plans',
      // Phase 11（W.22-W.26）：读者模型/伏笔/暗示/回收，生命周期跟随项目。
      'writing_reader_audiences',
      'writing_foreshadowing_plans',
      'writing_reveal_plans',
      // Phase 12（W.29-W.36）：正文/风格/修订/Retcon视图/导入，生命周期跟随项目。
      // 注意：writing_prose_blocks 无 project_id（通过 document_id 关联），不在此列；
      // 它随 writing_prose_documents 级联由 ProseService 显式清理。
      'writing_prose_documents',
      'writing_style_guides',
      'writing_style_examples',
      'writing_banned_expressions',
      'writing_revision_records',
      'writing_retcon_reports',
      'writing_import_batches',
      // 起草工作台（W.37）：设定集文档树，生命周期跟随项目。
      'writing_documents',
    ];
    // 注意：writing_audit_logs 不级联删除，审计记录永久保留
    // P1-2 修复：全部级联软删除包裹在单一事务内，保证原子性（§7.11.1）
    // 任一子表 UPDATE 失败则整体回滚，避免出现部分子表已删、部分未删的孤儿软删除态
    const txn = this.db.transaction(() => {
      for (const table of childTables) {
        this.db.prepare(
          `UPDATE ${table} SET deleted_at = ${now}, updated_at = ${now} WHERE project_id = ? AND deleted_at IS NULL`
        ).run(projectId);
      }
      this.db.prepare(
        `UPDATE writing_projects SET deleted_at = ${now}, updated_at = ${now} WHERE id = ?`
      ).run(projectId);
    });
    txn();
  }

  // =========================================================================
  // writing_workspace_layouts（§3.1/§22.1 工作台布局容器，与项目 1:1）
  // =========================================================================

  /** 创建工作台布局容器（默认空面板布局）。一项目一布局（DDL project_id UNIQUE 约束） */
  createWorkspaceLayout(projectId: string, panelLayout?: unknown): WorkspaceLayout {
    const id = makeId(PREFIX.workspace_layout);
    this.db.prepare(
      `INSERT INTO writing_workspace_layouts (id, project_id, panel_layout_json)
       VALUES (?, ?, ?)`
    ).run(id, projectId, safeStringify(panelLayout ?? {}));
    return this.getWorkspaceLayout(projectId)!;
  }

  /** 按项目取工作台布局（1:1，未创建则 undefined） */
  getWorkspaceLayout(projectId: string): WorkspaceLayout | undefined {
    const row = this.db.prepare(
      'SELECT * FROM writing_workspace_layouts WHERE project_id = ? AND deleted_at IS NULL'
    ).get(projectId) as WorkspaceLayoutRow | undefined;
    return row ? rowToWorkspaceLayout(row) : undefined;
  }

  /**
   * 更新工作台布局（乐观锁：expectedVersion 校验并发冲突）。
   * @throws {WritingError} VERSION_CONFLICT（版本过期）/ WRITING_OBJECT_NOT_FOUND（不存在）
   */
  updateWorkspaceLayout(
    projectId: string,
    expectedVersion: number,
    updates: { panelLayout?: unknown },
  ): { newVersion: number } {
    const fieldMap: Record<string, string> = { panelLayout: 'panel_layout_json' };
    const parts: string[] = [];
    const values: unknown[] = [];
    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined) {
        const col = fieldMap[key]; if (!col) throw new Error(`未知更新字段: ${String(key)}`);
        parts.push(`${col} = ?`);
        values.push(safeStringify(value));
      }
    }
    // 无字段变更：不写库，版本不推进（无丢失更新风险），直接回显调用方声明的版本
    if (parts.length === 0) return { newVersion: expectedVersion };
    parts.push("updated_at = datetime('now')");
    parts.push('version = version + 1'); // 乐观锁：每次更新推进版本号
    // WHERE 同时校验 project_id 与版本：版本不匹配即并发冲突，0 行命中
    const result = this.db.prepare(
      `UPDATE writing_workspace_layouts SET ${parts.join(', ')} WHERE project_id = ? AND version = ?`,
    ).run(...values, projectId, expectedVersion);
    if (result.changes === 0) {
      // 0 行命中：要么不存在，要么版本过期——查一次以区分，给出准确错误码
      const existing = this.getWorkspaceLayout(projectId);
      if (!existing) {
        throw new WritingError(WritingErrorCode.WRITING_OBJECT_NOT_FOUND, `找不到工作台布局: ${projectId}`);
      }
      throw new WritingError(
        WritingErrorCode.VERSION_CONFLICT,
        `工作台布局版本冲突: 期望 ${expectedVersion}，实际 ${existing.version}`,
        { expected: expectedVersion, actual: existing.version, projectId },
      );
    }
    return { newVersion: expectedVersion + 1 };
  }

  // =========================================================================
  // writing_project_preferences（§3.1 项目级作者偏好容器，与项目 1:1）
  // =========================================================================

  /** 创建项目级偏好容器（默认空 {}）。一项目一容器（DDL project_id UNIQUE 约束） */
  createProjectPreferenceProfile(projectId: string, preferences?: unknown): ProjectPreferenceProfile {
    const id = makeId(PREFIX.project_preference);
    this.db.prepare(
      `INSERT INTO writing_project_preferences (id, project_id, preferences_json)
       VALUES (?, ?, ?)`
    ).run(id, projectId, safeStringify(preferences ?? {}));
    return this.getProjectPreferenceProfile(projectId)!;
  }

  /** 按项目取偏好容器（1:1，未创建则 undefined） */
  getProjectPreferenceProfile(projectId: string): ProjectPreferenceProfile | undefined {
    const row = this.db.prepare(
      'SELECT * FROM writing_project_preferences WHERE project_id = ? AND deleted_at IS NULL'
    ).get(projectId) as ProjectPreferenceProfileRow | undefined;
    return row ? rowToProjectPreferenceProfile(row) : undefined;
  }

  /**
   * 更新项目级偏好容器（乐观锁：expectedVersion 校验并发冲突）。
   * @throws {WritingError} VERSION_CONFLICT（版本过期）/ WRITING_OBJECT_NOT_FOUND（不存在）
   */
  updateProjectPreferenceProfile(
    projectId: string,
    expectedVersion: number,
    updates: { preferences?: unknown },
  ): { newVersion: number } {
    const fieldMap: Record<string, string> = { preferences: 'preferences_json' };
    const parts: string[] = [];
    const values: unknown[] = [];
    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined) {
        const col = fieldMap[key]; if (!col) throw new Error(`未知更新字段: ${String(key)}`);
        parts.push(`${col} = ?`);
        values.push(safeStringify(value));
      }
    }
    if (parts.length === 0) return { newVersion: expectedVersion };
    parts.push("updated_at = datetime('now')");
    parts.push('version = version + 1');
    const result = this.db.prepare(
      `UPDATE writing_project_preferences SET ${parts.join(', ')} WHERE project_id = ? AND version = ?`,
    ).run(...values, projectId, expectedVersion);
    if (result.changes === 0) {
      const existing = this.getProjectPreferenceProfile(projectId);
      if (!existing) {
        throw new WritingError(WritingErrorCode.WRITING_OBJECT_NOT_FOUND, `找不到项目偏好容器: ${projectId}`);
      }
      throw new WritingError(
        WritingErrorCode.VERSION_CONFLICT,
        `项目偏好容器版本冲突: 期望 ${expectedVersion}，实际 ${existing.version}`,
        { expected: expectedVersion, actual: existing.version, projectId },
      );
    }
    return { newVersion: expectedVersion + 1 };
  }

  // =========================================================================
  // writing_author_goals
  // =========================================================================

  createGoal(projectId: string, text: string, kind: GoalKind,
    priority?: GoalPriority, scope?: GoalScope, sourceRefs?: SourceRef[]): AuthorGoal {
    const id = makeId(PREFIX.author_goal);
    this.db.prepare(
      `INSERT INTO writing_author_goals (id, project_id, text, kind, priority, scope, source_refs_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(id, projectId, text, kind, priority ?? 'normal', scope ?? 'project', safeStringify(sourceRefs ?? []));
    return this.getGoal(id)!;
  }

  getGoal(goalId: string): AuthorGoal | undefined {
    const row = this.db.prepare(
      'SELECT * FROM writing_author_goals WHERE id = ? AND deleted_at IS NULL'
    ).get(goalId) as AuthorGoalRow | undefined;
    return row ? rowToGoal(row) : undefined;
  }

  listGoals(projectId: string, status?: GoalStatus): AuthorGoal[] {
    let sql = 'SELECT * FROM writing_author_goals WHERE project_id = ? AND deleted_at IS NULL';
    const params: unknown[] = [projectId];
    if (status) {
      sql += ' AND status = ?';
      params.push(status);
    }
    sql += ' ORDER BY created_at DESC';
    return (this.db.prepare(sql).all(...params) as AuthorGoalRow[]).map(rowToGoal);
  }

  updateGoal(goalId: string, updates: {
    text?: string; kind?: GoalKind; priority?: GoalPriority;
    scope?: GoalScope; status?: GoalStatus;
  }): void {
    const fieldMap: Record<string, string> = { text: 'text', kind: 'kind', priority: 'priority', scope: 'scope', status: 'status' };
    const parts: string[] = [];
    const values: unknown[] = [];
    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined) {
        { const col = fieldMap[key]; if (!col) throw new Error(`未知更新字段: ${String(key)}`); parts.push(`${col} = ?`); }
        values.push(value);
      }
    }
    if (parts.length === 0) return;
    parts.push("updated_at = datetime('now')");
    values.push(goalId);
    this.db.prepare(`UPDATE writing_author_goals SET ${parts.join(', ')} WHERE id = ?`).run(...values);
  }

  // =========================================================================
  // writing_idea_cards
  // =========================================================================

  createIdeaCard(projectId: string, params: {
    content: string;
    kind?: IdeaKind;
    tags?: string[];
    source?: IdeaSource;
    analysisPolicy?: AnalysisPolicy;
    sourceRefs?: SourceRef[];
  }): IdeaCard {
    const id = makeId(PREFIX.idea_card);
    this.db.prepare(
      `INSERT INTO writing_idea_cards (id, project_id, content, kind, tags_json, source, analysis_policy, source_refs_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, projectId, params.content, params.kind ?? 'other',
      safeStringify(params.tags ?? []), params.source ?? 'manual',
      params.analysisPolicy ?? 'normal', safeStringify(params.sourceRefs ?? []));
    return this.getIdeaCard(id)!;
  }

  getIdeaCard(ideaId: string): IdeaCard | undefined {
    const row = this.db.prepare(
      'SELECT * FROM writing_idea_cards WHERE id = ? AND deleted_at IS NULL'
    ).get(ideaId) as IdeaCardRow | undefined;
    return row ? rowToIdeaCard(row) : undefined;
  }

  listIdeaCards(projectId: string, filter?: {
    maturity?: IdeaMaturity; kind?: IdeaKind;
  }): IdeaCard[] {
    let sql = 'SELECT * FROM writing_idea_cards WHERE project_id = ? AND deleted_at IS NULL';
    const params: unknown[] = [projectId];
    if (filter?.maturity) { sql += ' AND maturity = ?'; params.push(filter.maturity); }
    if (filter?.kind) { sql += ' AND kind = ?'; params.push(filter.kind); }
    sql += ' ORDER BY updated_at DESC';
    return (this.db.prepare(sql).all(...params) as IdeaCardRow[]).map(rowToIdeaCard);
  }

  updateIdeaCard(ideaId: string, updates: {
    content?: string; summary?: string | null;
    kind?: IdeaKind; maturity?: IdeaMaturity;
    tags?: string[]; analysisPolicy?: AnalysisPolicy;
    linkedDraftIds?: string[];
  }): void {
    const fieldMap: Record<string, string> = {
      content: 'content', summary: 'summary', kind: 'kind',
      maturity: 'maturity', tags: 'tags_json',
      analysisPolicy: 'analysis_policy', linkedDraftIds: 'linked_draft_ids_json',
    };
    const parts: string[] = [];
    const values: unknown[] = [];

    // 状态机校验：若更新含 maturity，先查当前成熟度并 validate（运行时强制）
    if (updates.maturity !== undefined) {
      const current = this.db.prepare('SELECT maturity FROM writing_idea_cards WHERE id = ?')
        .get(ideaId) as { maturity: string } | undefined;
      if (current) {
        validateIdeaTransition(current.maturity, updates.maturity, ideaId);
      }
    }

    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined) {
        const col = fieldMap[key]; if (!col) throw new WritingError(WritingErrorCode.WRITING_STORE_ERROR, `未知更新字段: ${String(key)}`);
        // 数组字段序列化
        parts.push(`${col} = ?`);
        values.push(Array.isArray(value) ? safeStringify(value) : value);
      }
    }
    if (parts.length === 0) return;
    parts.push("updated_at = datetime('now')");
    values.push(ideaId);
    this.db.prepare(`UPDATE writing_idea_cards SET ${parts.join(', ')} WHERE id = ?`).run(...values);
  }

  // =========================================================================
  // writing_blueprints
  // =========================================================================

  createBlueprint(projectId: string, params?: {
    entityTypes?: BlueprintTypeDef[];
    relationTypes?: BlueprintTypeDef[];
    maturity?: BlueprintMaturity;
    sourceRefs?: SourceRef[];
  }): ProjectBlueprint {
    const id = makeId(PREFIX.blueprint);
    this.db.prepare(
      `INSERT INTO writing_blueprints (id, project_id, entity_types_json, relation_types_json, maturity, source_refs_json)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(id, projectId, safeStringify(params?.entityTypes ?? []),
      safeStringify(params?.relationTypes ?? []),
      params?.maturity ?? 'drafted', safeStringify(params?.sourceRefs ?? []));
    return this.getBlueprint(id)!;
  }

  getBlueprint(blueprintId: string): ProjectBlueprint | undefined {
    const row = this.db.prepare(
      'SELECT * FROM writing_blueprints WHERE id = ? AND deleted_at IS NULL'
    ).get(blueprintId) as BlueprintRow | undefined;
    return row ? rowToBlueprint(row) : undefined;
  }

  /**
   * 当前活跃蓝图——【系统真相源】（§6 activeBlueprintId 不变式，见 Phase7-Refinement.md）。
   *
   * 按 maturity 派生（'active'|'evolving'，version 降序取最新），绝不读 project.active_blueprint_id
   * 指针。所有"当前蓝图"判断（DraftService/CoreBridge/CLI /blueprint/Agent）都必须经此方法，
   * 不允许写 `project.activeBlueprintId ? X : getActiveBlueprint()` 分叉——那会造出与派生真相
   * 并存的第二条真相，违背世界状态一致性。
   */
  getActiveBlueprint(projectId: string): ProjectBlueprint | undefined {
    const row = this.db.prepare(
      `SELECT * FROM writing_blueprints
       WHERE project_id = ? AND maturity IN ('active','evolving') AND deleted_at IS NULL
       ORDER BY version DESC LIMIT 1`
    ).get(projectId) as BlueprintRow | undefined;
    return row ? rowToBlueprint(row) : undefined;
  }

  /**
   * 查询项目的最新蓝图（含 implicit 种子）。
   *
   * 与 getActiveBlueprint 的区别：active 只返回 active/evolving；
   * 此方法还包含 implicit（createProject 建的初始种子），供 /blueprint 命令
   * 展示"项目已有潜在结构"——即使还没正式激活蓝图。
   */
  getLatestBlueprint(projectId: string): ProjectBlueprint | undefined {
    const row = this.db.prepare(
      `SELECT * FROM writing_blueprints
       WHERE project_id = ? AND deleted_at IS NULL
       ORDER BY CASE maturity WHEN 'active' THEN 0 WHEN 'evolving' THEN 1 ELSE 2 END, version DESC LIMIT 1`
    ).get(projectId) as BlueprintRow | undefined;
    return row ? rowToBlueprint(row) : undefined;
  }

  listBlueprints(projectId: string): ProjectBlueprint[] {
    const rows = this.db.prepare(
      'SELECT * FROM writing_blueprints WHERE project_id = ? AND deleted_at IS NULL ORDER BY version DESC'
    ).all(projectId) as BlueprintRow[];
    return rows.map(rowToBlueprint);
  }

  /**
   * 更新蓝图（乐观锁）
   *
   * @param expectedVersion 调用方读取该蓝图时拿到的 version；仅当库中 version 与之一致才写入，
   *                        写入成功后 version 自动 +1。
   * @returns 写入后的新版本号（= expectedVersion + 1）
   * @throws {WritingError} VERSION_CONFLICT（版本过期）/ WRITING_OBJECT_NOT_FOUND（不存在）
   */
  updateBlueprint(
    blueprintId: string,
    expectedVersion: number,
    updates: {
      maturity?: BlueprintMaturity;
      entityTypes?: BlueprintTypeDef[];
      relationTypes?: BlueprintTypeDef[];
      spatialNodeTypes?: BlueprintTypeDef[];
      spatialEdgeTypes?: BlueprintTypeDef[];
      changeSuggestions?: BlueprintChangeSuggestion[];
      supersededBy?: string | null;
    },
  ): { newVersion: number } {
    const fieldMap: Record<string, string> = {
      maturity: 'maturity', entityTypes: 'entity_types_json',
      relationTypes: 'relation_types_json',
      spatialNodeTypes: 'spatial_node_types_json',
      spatialEdgeTypes: 'spatial_edge_types_json',
      changeSuggestions: 'change_suggestions_json',
      supersededBy: 'superseded_by',
    };
    const parts: string[] = [];
    const values: unknown[] = [];

    // 状态机校验：若更新含 maturity，先查当前成熟度并 validate（运行时强制）
    if (updates.maturity !== undefined) {
      const current = this.db.prepare('SELECT maturity FROM writing_blueprints WHERE id = ? AND version = ?')
        .get(blueprintId, expectedVersion) as { maturity: string } | undefined;
      if (current) {
        validateBlueprintTransition(current.maturity, updates.maturity, blueprintId);
      }
    }

    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined) {
        const col = fieldMap[key]; if (!col) throw new WritingError(WritingErrorCode.WRITING_STORE_ERROR, `未知更新字段: ${String(key)}`);
        parts.push(`${col} = ?`);
        values.push(Array.isArray(value) ? safeStringify(value) : value);
      }
    }
    // 无字段变更：不写库，版本不推进（无丢失更新风险），直接回显调用方声明的版本
    if (parts.length === 0) return { newVersion: expectedVersion };
    parts.push("updated_at = datetime('now')");
    parts.push('version = version + 1'); // 乐观锁：每次更新推进版本号
    // WHERE 同时校验 id 与版本：版本不匹配即并发冲突，0 行命中
    const result = this.db.prepare(
      `UPDATE writing_blueprints SET ${parts.join(', ')} WHERE id = ? AND version = ?`,
    ).run(...values, blueprintId, expectedVersion);
    if (result.changes === 0) {
      // 0 行命中：要么不存在，要么版本过期——查一次以区分，给出准确错误码
      const existing = this.getBlueprint(blueprintId);
      if (!existing) {
        throw new WritingError(WritingErrorCode.WRITING_OBJECT_NOT_FOUND, `找不到蓝图: ${blueprintId}`);
      }
      throw new WritingError(
        WritingErrorCode.VERSION_CONFLICT,
        `蓝图版本冲突: 期望 ${expectedVersion}，实际 ${existing.version}`,
        { expected: expectedVersion, actual: existing.version, blueprintId },
      );
    }
    return { newVersion: expectedVersion + 1 };
  }

  // supersedeBlueprint 已移除：acceptBlueprintDraft 改用 updateBlueprint（自带乐观锁 version
  // 守卫 + 推进）在事务内完成 supersede + activate，消除裸 UPDATE 无 version 守卫的隐患。
  // 原 supersedeBlueprint 无其他调用方（仅 acceptBlueprintDraft 使用），故安全移除。

  // =========================================================================
  // writing_drafts
  // =========================================================================

  createDraft(projectId: string, params: {
    kind: DraftKind;
    chapter?: number;
    title?: string;
    content?: string;
    sourceRefs?: SourceRef[];
  }): WritingDraft {
    const id = makeId(PREFIX.draft);
    this.db.prepare(
      `INSERT INTO writing_drafts (id, project_id, kind, chapter, title, content, source_refs_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(id, projectId, params.kind, params.chapter ?? 1, params.title ?? null,
      params.content ?? '', safeStringify(params.sourceRefs ?? []));
    return this.getDraft(id)!;
  }

  getDraft(draftId: string): WritingDraft | undefined {
    const row = this.db.prepare(
      'SELECT * FROM writing_drafts WHERE id = ? AND deleted_at IS NULL'
    ).get(draftId) as DraftRow | undefined;
    return row ? rowToDraft(row) : undefined;
  }

  listDrafts(projectId: string, filter?: {
    status?: DraftStatus; kind?: DraftKind;
  }): WritingDraft[] {
    let sql = 'SELECT * FROM writing_drafts WHERE project_id = ? AND deleted_at IS NULL';
    const params: unknown[] = [projectId];
    if (filter?.status) { sql += ' AND status = ?'; params.push(filter.status); }
    if (filter?.kind) { sql += ' AND kind = ?'; params.push(filter.kind); }
    sql += ' ORDER BY updated_at DESC';
    return (this.db.prepare(sql).all(...params) as DraftRow[]).map(rowToDraft);
  }

  /**
   * 推导项目当前章节（W8）
   *
   * Core 的 `project_state.current_chapter` 是规范来源，但无 Core 读工具暴露它——读取它需新增
   * Core 接口，违背"Phase 7 最小侵入 Core"原则。故从写作层推导：取该项目所有草案（含已提交）
   * 的最大 chapter，作为"作者已触及的最远章节"。无草案时回落到 1。
   *
   * 语义：世界快照需要"as of 哪一章"的视角，草案的 chapter 字段反映了写作进度，取其上界即可。
   */
  getCurrentChapter(projectId: string): number {
    const row = this.db.prepare(
      'SELECT MAX(chapter) AS max_chapter FROM writing_drafts WHERE project_id = ? AND deleted_at IS NULL',
    ).get(projectId) as { max_chapter: number | null } | undefined;
    const max = row?.max_chapter;
    return typeof max === 'number' && max > 0 ? max : 1;
  }

  /**
   * 更新草案（乐观锁）
   *
   * @param expectedVersion 调用方读取该草案时拿到的 version；仅当库中 version 与之一致才写入，
   *                        写入成功后 version 自动 +1。
   * @returns 写入后的新版本号（= expectedVersion + 1）
   * @throws {WritingError} VERSION_CONFLICT（版本过期）/ WRITING_OBJECT_NOT_FOUND（不存在）
   */
  updateDraft(
    draftId: string,
    expectedVersion: number,
    updates: {
      content?: string; summary?: string | null; title?: string | null;
      chapter?: number; status?: DraftStatus; linkedProposalViewId?: string | null;
    },
  ): { newVersion: number } {
    const fieldMap: Record<string, string> = {
      content: 'content', summary: 'summary', title: 'title',
      chapter: 'chapter', status: 'status', linkedProposalViewId: 'linked_proposal_view_id',
    };
    const parts: string[] = [];
    const values: unknown[] = [];

    // 状态机校验：若更新含 status，先查当前状态并 validate（运行时强制）
    if (updates.status !== undefined) {
      const current = this.db.prepare('SELECT status FROM writing_drafts WHERE id = ? AND version = ?')
        .get(draftId, expectedVersion) as { status: string } | undefined;
      if (current) {
        validateDraftTransition(current.status, updates.status, draftId);
      }
    }

    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined) {
        { const col = fieldMap[key]; if (!col) throw new WritingError(WritingErrorCode.WRITING_STORE_ERROR, `未知更新字段: ${String(key)}`); parts.push(`${col} = ?`); }
        values.push(value);
      }
    }
    // 无字段变更：不写库，版本不推进（无丢失更新风险），直接回显调用方声明的版本
    if (parts.length === 0) return { newVersion: expectedVersion };
    parts.push("updated_at = datetime('now')");
    parts.push('version = version + 1'); // 乐观锁：每次更新推进版本号
    // WHERE 同时校验 id 与版本：版本不匹配即并发冲突，0 行命中
    const result = this.db.prepare(
      `UPDATE writing_drafts SET ${parts.join(', ')} WHERE id = ? AND version = ?`,
    ).run(...values, draftId, expectedVersion);
    if (result.changes === 0) {
      // 0 行命中：要么不存在，要么版本过期——查一次以区分，给出准确错误码
      const existing = this.getDraft(draftId);
      if (!existing) {
        throw new WritingError(WritingErrorCode.WRITING_OBJECT_NOT_FOUND, `找不到草案: ${draftId}`);
      }
      throw new WritingError(
        WritingErrorCode.VERSION_CONFLICT,
        `草案版本冲突: 期望 ${expectedVersion}，实际 ${existing.version}`,
        { expected: expectedVersion, actual: existing.version, draftId },
      );
    }
    return { newVersion: expectedVersion + 1 };
  }

  // =========================================================================
  // writing_entity_sketches
  // =========================================================================

  createEntitySketch(projectId: string, params: {
    displayName: string;
    typeLabel?: string;
    status?: EntitySketchStatus;
    sourceRefs?: SourceRef[];
  }): WritingEntitySketch {
    const id = makeId(PREFIX.entity_sketch);
    this.db.prepare(
      `INSERT INTO writing_entity_sketches (id, project_id, display_name, type_label, status, source_refs_json)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(id, projectId, params.displayName, params.typeLabel ?? 'unknown',
      params.status ?? 'hint', safeStringify(params.sourceRefs ?? []));
    return this.getEntitySketch(id)!;
  }

  getEntitySketch(sketchId: string): WritingEntitySketch | undefined {
    const row = this.db.prepare(
      'SELECT * FROM writing_entity_sketches WHERE id = ? AND deleted_at IS NULL'
    ).get(sketchId) as EntitySketchRow | undefined;
    return row ? rowToEntitySketch(row) : undefined;
  }

  listEntitySketches(projectId: string, filter?: {
    status?: EntitySketchStatus; typeLabel?: string;
  }): WritingEntitySketch[] {
    let sql = 'SELECT * FROM writing_entity_sketches WHERE project_id = ? AND deleted_at IS NULL';
    const params: unknown[] = [projectId];
    if (filter?.status) { sql += ' AND status = ?'; params.push(filter.status); }
    if (filter?.typeLabel) { sql += ' AND type_label = ?'; params.push(filter.typeLabel); }
    sql += ' ORDER BY updated_at DESC';
    return (this.db.prepare(sql).all(...params) as EntitySketchRow[]).map(rowToEntitySketch);
  }

  /** 按名称查找候选实体（合并检测用） */
  findEntitySketchesByName(projectId: string, displayName: string): WritingEntitySketch[] {
    const rows = this.db.prepare(
      `SELECT * FROM writing_entity_sketches
       WHERE project_id = ? AND display_name = ? AND deleted_at IS NULL
       AND status NOT IN ('deprecated','merged')
       ORDER BY updated_at DESC`
    ).all(projectId, displayName) as EntitySketchRow[];
    return rows.map(rowToEntitySketch);
  }

  updateEntitySketch(sketchId: string, updates: {
    displayName?: string; typeLabel?: string;
    summary?: string | null; status?: EntitySketchStatus;
    coreEntityId?: string | null; coreKind?: string | null;
    aliases?: string[]; tags?: string[];
  }, expectedVersion?: number): void {
    const fieldMap: Record<string, string> = {
      displayName: 'display_name', typeLabel: 'type_label',
      summary: 'summary', status: 'status',
      coreEntityId: 'core_entity_id', coreKind: 'core_kind',
      aliases: 'aliases_json', tags: 'tags_json',
    };
    const parts: string[] = [];
    const values: unknown[] = [];

    // 状态机校验：若更新含 status，先查当前状态并 validate（运行时强制）
    if (updates.status !== undefined) {
      const current = this.db.prepare('SELECT status FROM writing_entity_sketches WHERE id = ?')
        .get(sketchId) as { status: string } | undefined;
      if (current) {
        validateEntitySketchTransition(current.status, updates.status, sketchId);
      }
    }

    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined) {
        const col = fieldMap[key]; if (!col) throw new WritingError(WritingErrorCode.WRITING_STORE_ERROR, `未知更新字段: ${String(key)}`);
        parts.push(`${col} = ?`);
        values.push(Array.isArray(value) ? safeStringify(value) : value);
      }
    }
    if (parts.length === 0) return;
    parts.push("version = version + 1");
    parts.push("updated_at = datetime('now')");
    if (expectedVersion !== undefined) {
      values.push(sketchId, expectedVersion);
      const result = this.db.prepare(`UPDATE writing_entity_sketches SET ${parts.join(', ')} WHERE id = ? AND version = ?`).run(...values);
      if (result.changes === 0) {
        const row = this.db.prepare('SELECT version FROM writing_entity_sketches WHERE id = ?').get(sketchId) as { version: number } | undefined;
        if (!row) throw new WritingError(WritingErrorCode.WRITING_OBJECT_NOT_FOUND, `实体草图不存在: ${sketchId}`);
        throw new WritingError(WritingErrorCode.VERSION_CONFLICT, `实体草图版本冲突: 期望 ${expectedVersion}，实际 ${row.version}`, { expected: expectedVersion, actual: row.version });
      }
    } else {
      values.push(sketchId);
      this.db.prepare(`UPDATE writing_entity_sketches SET ${parts.join(', ')} WHERE id = ?`).run(...values);
    }
  }

  /**
   * 合并实体：source 标记为 merged。
   *
   * 状态机校验：source 当前状态必须能合法转 merged。EntityService.mergeSketches 在
   * service 层已做 validateEntitySketchTransition，store 层再校验一次（防御纵深）。
   */
  mergeEntitySketches(sourceId: string, targetId: string): void {
    void targetId; // target 的别名合并在 updateEntitySketch 单独处理
    const current = this.db.prepare('SELECT status FROM writing_entity_sketches WHERE id = ?')
      .get(sourceId) as { status: string } | undefined;
    if (current) {
      validateEntitySketchTransition(current.status, 'merged', sourceId);
    }
    this.db.prepare(
      "UPDATE writing_entity_sketches SET status = 'merged', updated_at = datetime('now') WHERE id = ?"
    ).run(sourceId);
  }

  // =========================================================================
  // writing_pending_decisions
  // =========================================================================

  createDecision(projectId: string, params: {
    kind: DecisionKind;
    title: string;
    description?: string;
    linkedObjectId?: string;
    linkedObjectType?: string;
    sourceRefs?: SourceRef[];
  }): PendingDecisionItem {
    const id = makeId(PREFIX.pending_decision);
    this.db.prepare(
      `INSERT INTO writing_pending_decisions (id, project_id, kind, title, description, linked_object_id, linked_object_type, source_refs_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, projectId, params.kind, params.title, params.description ?? null,
      params.linkedObjectId ?? null, params.linkedObjectType ?? null,
      safeStringify(params.sourceRefs ?? []));
    return this.getDecision(id)!;
  }

  getDecision(decisionId: string): PendingDecisionItem | undefined {
    const row = this.db.prepare(
      'SELECT * FROM writing_pending_decisions WHERE id = ? AND deleted_at IS NULL'
    ).get(decisionId) as PendingDecisionRow | undefined;
    return row ? rowToDecision(row) : undefined;
  }

  listPendingDecisions(projectId: string): PendingDecisionItem[] {
    const rows = this.db.prepare(
      `SELECT * FROM writing_pending_decisions
       WHERE project_id = ? AND status = 'open' AND deleted_at IS NULL
       ORDER BY created_at ASC`
    ).all(projectId) as PendingDecisionRow[];
    return rows.map(rowToDecision);
  }

  resolveDecision(decisionId: string, status: 'resolved' | 'dismissed' | 'expired', resolutionNote?: string): void {
    // 乐观锁：仅在 status='open' 时更新，防止并发重复处理
    const result = this.db.prepare(
      `UPDATE writing_pending_decisions
       SET status = ?, resolved_at = datetime('now'), resolution_note = ?, updated_at = datetime('now')
       WHERE id = ? AND status = 'open'`
    ).run(status, resolutionNote ?? null, decisionId);
    if (result.changes === 0) {
      // W14：领域状态违规走结构化错误码（INVALID_STATUS_TRANSITION），经 ERROR_RECOVERY_MAP 出人话；
      // 此前为裸 Error，调用方无法按码分流恢复动作
      throw new WritingError(
        WritingErrorCode.INVALID_STATUS_TRANSITION,
        `writing-store: Decision ${decisionId} 不是 open 状态（已被并发处理或已过期）`,
      );
    }
  }

  // =========================================================================
  // writing_proposal_views
  // =========================================================================

  createProposalView(projectId: string, params: {
    proposalType: ProposalType;
    sourceDraftId?: string;
    sourceEntitySketchId?: string;
    sourceRefs?: SourceRef[];
  }): WritingProposalView {
    const id = makeId(PREFIX.proposal_view);
    this.db.prepare(
      `INSERT INTO writing_proposal_views (id, project_id, proposal_type, source_draft_id, source_entity_sketch_id, source_refs_json)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(id, projectId, params.proposalType,
      params.sourceDraftId ?? null, params.sourceEntitySketchId ?? null,
      safeStringify(params.sourceRefs ?? []));
    return this.getProposalView(id)!;
  }

  getProposalView(viewId: string): WritingProposalView | undefined {
    const row = this.db.prepare(
      'SELECT * FROM writing_proposal_views WHERE id = ? AND deleted_at IS NULL'
    ).get(viewId) as ProposalViewRow | undefined;
    return row ? rowToProposalView(row) : undefined;
  }

  listProposalViews(projectId: string, filter?: {
    status?: ProposalViewStatus;
  }): WritingProposalView[] {
    let sql = 'SELECT * FROM writing_proposal_views WHERE project_id = ? AND deleted_at IS NULL';
    const params: unknown[] = [projectId];
    if (filter?.status) { sql += ' AND status = ?'; params.push(filter.status); }
    sql += ' ORDER BY updated_at DESC';
    return (this.db.prepare(sql).all(...params) as ProposalViewRow[]).map(rowToProposalView);
  }

  updateProposalView(viewId: string, updates: {
    coreProposalId?: string | null; coreBridgeResult?: unknown;
    status?: ProposalViewStatus; humanSummary?: string | null;
    factDiff?: FactDiffEntry[]; involvedEntityIds?: string[];
    ruleWarnings?: RuleWarning[]; simulationInputs?: SimulationInputs; authorDecision?: string | null;
    coreEventId?: string | null; commitError?: unknown | null;
  }, expectedVersion?: number): void {
    const fieldMap: Record<string, string> = {
      coreProposalId: 'core_proposal_id', coreBridgeResult: 'core_bridge_result_json',
      status: 'status', humanSummary: 'human_summary',
      factDiff: 'fact_diff_json', involvedEntityIds: 'involved_entity_ids_json',
      ruleWarnings: 'rule_warnings_json', simulationInputs: 'simulation_inputs_json', authorDecision: 'author_decision',
      coreEventId: 'core_event_id', commitError: 'commit_error_json',
    };
    const parts: string[] = [];
    const values: unknown[] = [];

    // 状态机校验：若更新含 status，先查当前状态并 validate（运行时强制，杜绝绕过）
    if (updates.status !== undefined) {
      const current = this.db.prepare('SELECT status FROM writing_proposal_views WHERE id = ?')
        .get(viewId) as { status: string } | undefined;
      if (current) {
        validateProposalViewTransition(current.status, updates.status, viewId);
      }
    }

    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined) {
        // P1-2 修复：未知字段直接报错（杜绝列名注入面），不再回退到原始 key
        const col = fieldMap[key];
        if (!col) throw new WritingError(WritingErrorCode.WRITING_STORE_ERROR, `updateProposalView 未知更新字段: ${String(key)}`);
        parts.push(`${col} = ?`);
        // P1-2 修复：null 直接存 SQL NULL，对象/数组才序列化（避免 null → 字符串 "null"）
        values.push(value === null ? null
          : (Array.isArray(value) || typeof value === 'object') ? safeStringify(value) : value);
      }
    }
    if (parts.length === 0) return;
    parts.push("version = version + 1");
    parts.push("updated_at = datetime('now')");
    if (expectedVersion !== undefined) {
      values.push(viewId, expectedVersion);
      const result = this.db.prepare(`UPDATE writing_proposal_views SET ${parts.join(', ')} WHERE id = ? AND version = ?`).run(...values);
      if (result.changes === 0) {
        const row = this.db.prepare('SELECT version FROM writing_proposal_views WHERE id = ?').get(viewId) as { version: number } | undefined;
        if (!row) throw new WritingError(WritingErrorCode.WRITING_OBJECT_NOT_FOUND, `审核视图不存在: ${viewId}`);
        throw new WritingError(WritingErrorCode.VERSION_CONFLICT, `审核视图版本冲突: 期望 ${expectedVersion}，实际 ${row.version}`, { expected: expectedVersion, actual: row.version });
      }
    } else {
      values.push(viewId);
      this.db.prepare(`UPDATE writing_proposal_views SET ${parts.join(', ')} WHERE id = ?`).run(...values);
    }
  }

  /**
   * 来源草案修改导致审核过期。
   *
   * 只对 open/author_approved 状态的 PV 过期（这俩状态在 PROPOSAL_VIEW_TRANSITIONS 中
   * 合法转 expired）。终态（committed/commit_failed/expired/author_rejected）不动——
   * 它们要么已提交要么已失败，草案修改不该回溯影响。
   */
  expireProposalView(viewId: string): void {
    this.db.prepare(
      "UPDATE writing_proposal_views SET status = 'expired', updated_at = datetime('now') WHERE id = ? AND status IN ('open','author_approved')"
    ).run(viewId);
  }

  /** 找到某草案关联的活跃审核视图 */
  getActiveProposalViewForDraft(draftId: string): WritingProposalView | undefined {
    const row = this.db.prepare(
      `SELECT * FROM writing_proposal_views
       WHERE source_draft_id = ? AND status IN ('open','author_approved') AND deleted_at IS NULL
       ORDER BY created_at DESC LIMIT 1`
    ).get(draftId) as ProposalViewRow | undefined;
    return row ? rowToProposalView(row) : undefined;
  }

  /** 找到某实体草图关联的活跃审核视图（实体类 PV 经 sourceEntitySketchId 关联） */
  getActiveProposalViewForEntitySketch(sketchId: string): WritingProposalView | undefined {
    const row = this.db.prepare(
      `SELECT * FROM writing_proposal_views
       WHERE source_entity_sketch_id = ? AND status IN ('open','author_approved') AND deleted_at IS NULL
       ORDER BY created_at DESC LIMIT 1`
    ).get(sketchId) as ProposalViewRow | undefined;
    return row ? rowToProposalView(row) : undefined;
  }

  // =========================================================================
  // writing_audit_logs
  // =========================================================================

  recordAudit(params: {
    projectId: string; action: string;
    targetType?: string; targetId?: string;
    triggerSource?: AuditTrigger; result?: AuditResult;
    detail?: unknown; errorCode?: string;
    sourceRefs?: SourceRef[];
    requestId?: string; sessionId?: string;
  }): WritingAuditLog {
    const id = makeId(PREFIX.audit_log);
    this.db.prepare(
      `INSERT INTO writing_audit_logs (id, project_id, action, target_type, target_id, trigger_source, result, detail_json, source_refs_json, error_code, request_id, session_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, params.projectId, params.action, params.targetType ?? null, params.targetId ?? null,
      params.triggerSource ?? 'author_action', params.result ?? 'success',
      safeStringify(params.detail ?? {}), safeStringify(params.sourceRefs ?? []),
      params.errorCode ?? null,
      params.requestId ?? null, params.sessionId ?? null);
    return this.getAuditLog(id)!;
  }

  getAuditLog(logId: string): WritingAuditLog | undefined {
    const row = this.db.prepare(
      'SELECT * FROM writing_audit_logs WHERE id = ?'
    ).get(logId) as AuditLogRow | undefined;
    return row ? rowToAuditLog(row) : undefined;
  }

  queryAuditLogs(projectId: string, filter?: {
    action?: string; targetType?: string; targetId?: string; limit?: number;
  }): WritingAuditLog[] {
    let sql = 'SELECT * FROM writing_audit_logs WHERE project_id = ?';
    const params: unknown[] = [projectId];
    if (filter?.action) { sql += ' AND action = ?'; params.push(filter.action); }
    if (filter?.targetType) { sql += ' AND target_type = ?'; params.push(filter.targetType); }
    if (filter?.targetId) { sql += ' AND target_id = ?'; params.push(filter.targetId); }
    sql += ' ORDER BY created_at DESC';
    if (filter?.limit) { sql += ' LIMIT ?'; params.push(filter.limit); }
    return (this.db.prepare(sql).all(...params) as AuditLogRow[]).map(rowToAuditLog);
  }

  /**
   * 列出审计日志（G2 补全，CLI `/audit` 的数据源）
   *
   * 与 queryAuditLogs 的区别：新增 `result` 过滤维度（success/failure/partial），
   * limit 默认 30（CLI-Layer-Design §4.10）。保留 queryAuditLogs 不动以免破坏既有调用方。
   *
   * 设计文档：CLI-Layer-Design.md §6 G2（行 333）、§4.10（行 289-295）。
   */
  listAuditLogs(projectId: string, filter?: {
    limit?: number; result?: AuditResult;
    action?: string; targetType?: string; targetId?: string;
  }): WritingAuditLog[] {
    let sql = 'SELECT * FROM writing_audit_logs WHERE project_id = ?';
    const params: unknown[] = [projectId];
    if (filter?.result) { sql += ' AND result = ?'; params.push(filter.result); }
    if (filter?.action) { sql += ' AND action = ?'; params.push(filter.action); }
    if (filter?.targetType) { sql += ' AND target_type = ?'; params.push(filter.targetType); }
    if (filter?.targetId) { sql += ' AND target_id = ?'; params.push(filter.targetId); }
    sql += ' ORDER BY created_at DESC';
    sql += ' LIMIT ?'; params.push(filter?.limit ?? 30);
    return (this.db.prepare(sql).all(...params) as AuditLogRow[]).map(rowToAuditLog);
  }

  // =========================================================================
  // writing_core_refs
  // =========================================================================

  createCoreRef(projectId: string, params: {
    writingObjectType: WritingObjectType; writingObjectId: string;
    coreObjectType: CoreObjectType; coreObjectId: string;
  }): WritingCoreRef {
    // P1-2 修复：先查是否已存在相同引用，存在则仅刷新 ref_status（保留原 id/created_at）。
    // INSERT OR REPLACE 会删旧行重建，丢失历史 created_at 且使外部持有的 coreRefId 失效。
    const existing = this.db.prepare(
      `SELECT id FROM writing_core_refs
       WHERE writing_object_type = ? AND writing_object_id = ? AND core_object_type = ? AND core_object_id = ? AND deleted_at IS NULL`
    ).get(params.writingObjectType, params.writingObjectId,
      params.coreObjectType, params.coreObjectId) as { id: string } | undefined;

    if (existing) {
      this.db.prepare(
        `UPDATE writing_core_refs SET ref_status = 'active', updated_at = datetime('now') WHERE id = ?`
      ).run(existing.id);
      return this.getCoreRef(existing.id)!;
    }

    const id = makeId(PREFIX.core_ref);
    this.db.prepare(
      `INSERT INTO writing_core_refs (id, project_id, writing_object_type, writing_object_id, core_object_type, core_object_id, ref_status)
       VALUES (?, ?, ?, ?, ?, ?, 'active')`
    ).run(id, projectId, params.writingObjectType, params.writingObjectId,
      params.coreObjectType, params.coreObjectId);
    return this.getCoreRef(id)!;
  }

  getCoreRef(refId: string): WritingCoreRef | undefined {
    // P1-2 修复：过滤已软删除（级联 archive 后不应再查出）
    const row = this.db.prepare(
      'SELECT * FROM writing_core_refs WHERE id = ? AND deleted_at IS NULL'
    ).get(refId) as CoreRefRow | undefined;
    return row ? rowToCoreRef(row) : undefined;
  }

  getCoreRefsByWritingObject(writingObjectType: string, writingObjectId: string): WritingCoreRef[] {
    const rows = this.db.prepare(
      'SELECT * FROM writing_core_refs WHERE writing_object_type = ? AND writing_object_id = ? AND ref_status = ? AND deleted_at IS NULL'
    ).all(writingObjectType, writingObjectId, 'active') as CoreRefRow[];
    return rows.map(rowToCoreRef);
  }

  getCoreRefsByCoreObject(coreObjectType: string, coreObjectId: string): WritingCoreRef[] {
    const rows = this.db.prepare(
      'SELECT * FROM writing_core_refs WHERE core_object_type = ? AND core_object_id = ? AND deleted_at IS NULL'
    ).all(coreObjectType, coreObjectId) as CoreRefRow[];
    return rows.map(rowToCoreRef);
  }

  markCoreRefStale(coreRefId: string): void {
    this.db.prepare(
      "UPDATE writing_core_refs SET ref_status = 'stale', last_verified_at = datetime('now') WHERE id = ?"
    ).run(coreRefId);
  }

  markCoreRefBroken(coreRefId: string): void {
    this.db.prepare(
      "UPDATE writing_core_refs SET ref_status = 'broken', last_verified_at = datetime('now') WHERE id = ?"
    ).run(coreRefId);
  }

  // =========================================================================
  // writing_jobs（Phase 7 最小实现——只支持创建和状态查询）
  // =========================================================================

  createJob(projectId: string, jobType: string, createdBy?: JobCreator): WritingJob {
    const id = makeId(PREFIX.job);
    this.db.prepare(
      `INSERT INTO writing_jobs (id, project_id, job_type, created_by) VALUES (?, ?, ?, ?)`
    ).run(id, projectId, jobType, createdBy ?? 'system');
    return this.getJob(id)!;
  }

  getJob(jobId: string): WritingJob | undefined {
    // P1-2 修复：过滤已软删除
    const row = this.db.prepare(
      'SELECT * FROM writing_jobs WHERE id = ? AND deleted_at IS NULL'
    ).get(jobId) as JobRow | undefined;
    return row ? rowToJob(row) : undefined;
  }

  listJobs(projectId: string, filter?: { status?: JobStatus }): WritingJob[] {
    // P1-2 修复：过滤已软删除
    let sql = 'SELECT * FROM writing_jobs WHERE project_id = ? AND deleted_at IS NULL';
    const params: unknown[] = [projectId];
    if (filter?.status) { sql += ' AND status = ?'; params.push(filter.status); }
    sql += ' ORDER BY created_at DESC';
    return (this.db.prepare(sql).all(...params) as JobRow[]).map(rowToJob);
  }

  updateJobStatus(jobId: string, status: JobStatus, progress?: number): void {
    const parts = ["status = ?", "updated_at = datetime('now')"];
    const values: unknown[] = [status];
    if (progress !== undefined) { parts.push('progress = ?'); values.push(progress); }
    values.push(jobId);
    this.db.prepare(`UPDATE writing_jobs SET ${parts.join(', ')} WHERE id = ?`).run(...values);
  }

  // ===========================================================================
  // Phase 8：关系候选 / 创作关联 / 检测提示（CRUD）
  // ===========================================================================

  // ---- 关系候选 ----

  createRelationCandidate(projectId: string, params: {
    sourceEntityId: string; targetEntityId: string; relationTypeId: string;
    layer?: string; direction?: string; strength?: number;
    temporalScope?: Record<string, unknown>; sourceRefs?: SourceRef[];
  }): WritingRelationCandidate {
    const id = makeId('wrel');
    this.db.prepare(`INSERT INTO writing_relations
      (id, project_id, source_entity_id, target_entity_id, relation_type_id, layer, direction, strength, temporal_scope_json, source_refs_json)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
      id, projectId, params.sourceEntityId, params.targetEntityId, params.relationTypeId,
      params.layer ?? 'world', params.direction ?? 'directed', params.strength ?? null,
      safeStringify(params.temporalScope ?? {}),
      safeStringify(params.sourceRefs ?? []),
    );
    return this.getRelationCandidate(id)!;
  }

  getRelationCandidate(id: string): WritingRelationCandidate | undefined {
    const row = this.db.prepare('SELECT * FROM writing_relations WHERE id = ? AND deleted_at IS NULL').get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToRelationCandidate(row) : undefined;
  }

  listRelationCandidates(projectId: string, filter?: { status?: string; layer?: string }): WritingRelationCandidate[] {
    let sql = 'SELECT * FROM writing_relations WHERE project_id = ? AND deleted_at IS NULL';
    const vals: unknown[] = [projectId];
    if (filter?.status) { sql += ' AND status = ?'; vals.push(filter.status); }
    if (filter?.layer) { sql += ' AND layer = ?'; vals.push(filter.layer); }
    sql += ' ORDER BY created_at DESC';
    return (this.db.prepare(sql).all(...vals) as Record<string, unknown>[]).map(r => this.rowToRelationCandidate(r));
  }

  updateRelationCandidate(id: string, expectedVersion: number, updates: Partial<WritingRelationCandidate>): void {
    const fieldMap: Record<string, string> = {
      status: 'status', layer: 'layer', direction: 'direction', strength: 'strength',
      relationTypeId: 'relation_type_id', sourceEntityId: 'source_entity_id',
      targetEntityId: 'target_entity_id',
    };
    // 状态机校验
    if (updates.status !== undefined) {
      const current = this.db.prepare('SELECT status FROM writing_relations WHERE id = ? AND version = ?')
        .get(id, expectedVersion) as { status: string } | undefined;
      if (current) validateRelationCandidateTransition(current.status, updates.status, id);
    }
    const parts: string[] = []; const vals: unknown[] = [];
    for (const [k, v] of Object.entries(updates)) {
      if (v !== undefined && fieldMap[k]) { parts.push(`${fieldMap[k]} = ?`); vals.push(v); }
    }
    if (updates.temporalScope !== undefined) { parts.push('temporal_scope_json = ?'); vals.push(safeStringify(updates.temporalScope)); }
    if (updates.coreRefs !== undefined) { parts.push('core_refs_json = ?'); vals.push(safeStringify(updates.coreRefs)); }
    if (updates.sourceRefs !== undefined) { parts.push('source_refs_json = ?'); vals.push(safeStringify(updates.sourceRefs)); }
    if (parts.length === 0) return;
    parts.push("version = version + 1", "updated_at = datetime('now')");
    vals.push(id, expectedVersion);
    // P1 修复（A1）：此前 UPDATE 不检查 changes，版本不匹配时静默成功（0 行更新但无错误），
    // 导致并发冲突被吞掉。对齐 updateProposalView 范式：检查 changes===0，区分"不存在"与"版本冲突"。
    const result = this.db.prepare(`UPDATE writing_relations SET ${parts.join(', ')} WHERE id = ? AND version = ?`).run(...vals);
    if (result.changes === 0) {
      const row = this.db.prepare('SELECT version FROM writing_relations WHERE id = ?').get(id) as { version: number } | undefined;
      if (!row) throw new WritingError(WritingErrorCode.WRITING_OBJECT_NOT_FOUND, `关系候选不存在: ${id}`, { objectType: 'relation_candidate', objectId: id });
      throw new WritingError(WritingErrorCode.VERSION_CONFLICT, `关系候选版本冲突: 期望 ${expectedVersion}，实际 ${row.version}`, { expected: expectedVersion, actual: row.version });
    }
  }

  private rowToRelationCandidate(row: Record<string, unknown>): WritingRelationCandidate {
    const rid = row['id'] as string;
    return {
      id: rid, projectId: row['project_id'] as string,
      sourceEntityId: row['source_entity_id'] as string, targetEntityId: row['target_entity_id'] as string,
      relationTypeId: row['relation_type_id'] as string,
      layer: row['layer'] as RelationLayer, direction: row['direction'] as RelationDirection,
      strength: row['strength'] as number | null ?? undefined,
      temporalScope: safeParseJson(row['temporal_scope_json'] as string, rid, 'temporal_scope') as RelationTemporalScope,
      sourceRefs: safeParseJson(row['source_refs_json'] as string, rid, 'source_refs') as SourceRef[],
      status: row['status'] as RelationCandidateStatus,
      coreRefs: safeParseJson(row['core_refs_json'] as string, rid, 'core_refs') as CoreRelationRef[],
      version: row['version'] as number,
      createdAt: row['created_at'] as string, updatedAt: row['updated_at'] as string,
    };
  }

  // ---- 创作关联 ----

  createAssociation(projectId: string, params: {
    sourceRef: WritingObjectRef; targetRef: WritingObjectRef; label: string;
    kind?: string; sourceRefs?: SourceRef[];
  }): AuthoringAssociation {
    const id = makeId('wasc');
    this.db.prepare(`INSERT INTO writing_associations
      (id, project_id, source_ref_json, target_ref_json, label, kind, source_refs_json)
      VALUES (?,?,?,?,?,?,?)`).run(
      id, projectId, safeStringify(params.sourceRef), safeStringify(params.targetRef),
      params.label, params.kind ?? 'manual', safeStringify(params.sourceRefs ?? []),
    );
    return this.getAssociation(id)!;
  }

  getAssociation(id: string): AuthoringAssociation | undefined {
    const row = this.db.prepare('SELECT * FROM writing_associations WHERE id = ? AND deleted_at IS NULL').get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToAssociation(row) : undefined;
  }

  listAssociations(projectId: string): AuthoringAssociation[] {
    return (this.db.prepare('SELECT * FROM writing_associations WHERE project_id = ? AND deleted_at IS NULL ORDER BY created_at DESC').all(projectId) as Record<string, unknown>[]).map(r => this.rowToAssociation(r));
  }

  updateAssociation(id: string, updates: { label?: string; kind?: string; status?: string }): void {
    const parts: string[] = []; const vals: unknown[] = [];
    if (updates.label) { parts.push('label = ?'); vals.push(updates.label); }
    if (updates.kind) { parts.push('kind = ?'); vals.push(updates.kind); }
    if (updates.status) { parts.push('status = ?'); vals.push(updates.status); }
    if (parts.length === 0) return;
    parts.push("updated_at = datetime('now')");
    vals.push(id);
    this.db.prepare(`UPDATE writing_associations SET ${parts.join(', ')} WHERE id = ?`).run(...vals);
  }

  private rowToAssociation(row: Record<string, unknown>): AuthoringAssociation {
    const aid = row['id'] as string;
    return {
      id: aid, projectId: row['project_id'] as string,
      sourceRef: safeParseJson(row['source_ref_json'] as string, aid, 'source_ref') as WritingObjectRef,
      targetRef: safeParseJson(row['target_ref_json'] as string, aid, 'target_ref') as WritingObjectRef,
      label: row['label'] as string, kind: row['kind'] as AuthoringAssociation['kind'],
      sourceRefs: safeParseJson(row['source_refs_json'] as string, aid, 'source_refs') as SourceRef[],
      status: row['status'] as 'active' | 'archived',
      createdAt: row['created_at'] as string, updatedAt: row['updated_at'] as string,
    };
  }

  // ---- 关系检测提示 ----

  createRelationHint(projectId: string, params: {
    sourceEntityId: string; targetEntityId: string; relationTypeId?: string;
    summary: string; confidence?: number; possibleLayer?: string; sourceRefs?: string[];
  }): RelationDetectionHint {
    const id = makeId('wrht');
    this.db.prepare(`INSERT INTO writing_relation_hints
      (id, project_id, source_entity_id, target_entity_id, relation_type_id, summary, confidence, possible_layer, source_refs_json)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(
      id, projectId, params.sourceEntityId, params.targetEntityId,
      params.relationTypeId ?? null, params.summary, params.confidence ?? 0.5,
      params.possibleLayer ?? 'world', safeStringify(params.sourceRefs ?? []),
    );
    return this.getRelationHint(id)!;
  }

  getRelationHint(id: string): RelationDetectionHint | undefined {
    const row = this.db.prepare('SELECT * FROM writing_relation_hints WHERE id = ? AND deleted_at IS NULL').get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToRelationHint(row) : undefined;
  }

  listRelationHints(projectId: string, filter?: { status?: string }): RelationDetectionHint[] {
    let sql = 'SELECT * FROM writing_relation_hints WHERE project_id = ? AND deleted_at IS NULL';
    const vals: unknown[] = [projectId];
    if (filter?.status) { sql += ' AND status = ?'; vals.push(filter.status); }
    sql += ' ORDER BY created_at DESC';
    return (this.db.prepare(sql).all(...vals) as Record<string, unknown>[]).map(r => this.rowToRelationHint(r));
  }

  updateRelationHint(id: string, updates: { status?: string; relationTypeId?: string }): void {
    const parts: string[] = []; const vals: unknown[] = [];
    if (updates.status) { parts.push('status = ?'); vals.push(updates.status); }
    if (updates.relationTypeId) { parts.push('relation_type_id = ?'); vals.push(updates.relationTypeId); }
    if (parts.length === 0) return;
    parts.push("updated_at = datetime('now')");
    vals.push(id);
    this.db.prepare(`UPDATE writing_relation_hints SET ${parts.join(', ')} WHERE id = ?`).run(...vals);
  }

  private rowToRelationHint(row: Record<string, unknown>): RelationDetectionHint {
    const hid = row['id'] as string;
    return {
      id: hid, projectId: row['project_id'] as string,
      sourceEntityId: row['source_entity_id'] as string, targetEntityId: row['target_entity_id'] as string,
      relationTypeId: (row['relation_type_id'] as string) ?? undefined,
      summary: row['summary'] as string,
      sourceRefs: safeParseJson(row['source_refs_json'] as string, hid, 'source_refs') as string[],
      confidence: row['confidence'] as number,
      possibleLayer: row['possible_layer'] as RelationLayer,
      status: row['status'] as RelationDetectionHint['status'],
      createdAt: row['created_at'] as string, updatedAt: row['updated_at'] as string,
    };
  }

  // ===========================================================================
  // Phase 9：空间节点 CRUD（W.17）
  // ===========================================================================

  createSpatialNode(projectId: string, input: {
    label: string; typeId: string; aliases?: string[];
    description?: string; sourceRefs?: SourceRef[];
    properties?: Record<string, unknown>;
  }): WritingSpatialNode {
    const id = `wsnode_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    this.db.prepare(
      `INSERT INTO writing_spatial_nodes (id, project_id, label, type_id, aliases_json, description, source_refs_json, properties_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id, projectId, input.label, input.typeId,
      JSON.stringify(input.aliases ?? []),
      input.description ?? null,
      JSON.stringify(input.sourceRefs ?? []),
      JSON.stringify(input.properties ?? {}),
    );
    return this.getSpatialNode(id)!;
  }

  getSpatialNode(id: string): WritingSpatialNode | undefined {
    const row = this.db.prepare(
      'SELECT * FROM writing_spatial_nodes WHERE id = ? AND deleted_at IS NULL'
    ).get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToSpatialNode(row) : undefined;
  }

  listSpatialNodes(projectId: string, options?: {
    maturity?: SpatialNodeMaturity; status?: SpatialNodeStatus; typeId?: string;
  }): WritingSpatialNode[] {
    let sql = 'SELECT * FROM writing_spatial_nodes WHERE project_id = ? AND deleted_at IS NULL';
    const params: unknown[] = [projectId];
    if (options?.maturity) { sql += ' AND maturity = ?'; params.push(options.maturity); }
    if (options?.status) { sql += ' AND status = ?'; params.push(options.status); }
    if (options?.typeId) { sql += ' AND type_id = ?'; params.push(options.typeId); }
    sql += ' ORDER BY created_at DESC';
    return (this.db.prepare(sql).all(...params) as Record<string, unknown>[]).map(r => this.rowToSpatialNode(r));
  }

  updateSpatialNode(id: string, expectedVersion: number, updates: Partial<{
    label: string; typeId: string; aliases: string[];
    description: string; sourceRefs: SourceRef[];
    maturity: SpatialNodeMaturity; status: SpatialNodeStatus;
    coreEntityId: string; properties: Record<string, unknown>;
  }>): { newVersion: number } {
    const parts: string[] = []; const vals: unknown[] = [];
    if (updates.label !== undefined) { parts.push('label = ?'); vals.push(updates.label); }
    if (updates.typeId !== undefined) { parts.push('type_id = ?'); vals.push(updates.typeId); }
    if (updates.aliases !== undefined) { parts.push('aliases_json = ?'); vals.push(JSON.stringify(updates.aliases)); }
    if (updates.description !== undefined) { parts.push('description = ?'); vals.push(updates.description); }
    if (updates.sourceRefs !== undefined) { parts.push('source_refs_json = ?'); vals.push(JSON.stringify(updates.sourceRefs)); }
    if (updates.maturity !== undefined) {
      const current = this.db.prepare('SELECT maturity FROM writing_spatial_nodes WHERE id = ?').get(id) as { maturity: string } | undefined;
      if (current) validateSpatialNodeMaturity(current.maturity, updates.maturity, id);
      parts.push('maturity = ?'); vals.push(updates.maturity);
    }
    if (updates.status !== undefined) { parts.push('status = ?'); vals.push(updates.status); }
    if (updates.coreEntityId !== undefined) { parts.push('core_entity_id = ?'); vals.push(updates.coreEntityId); }
    if (updates.properties !== undefined) { parts.push('properties_json = ?'); vals.push(JSON.stringify(updates.properties)); }
    if (parts.length === 0) return { newVersion: expectedVersion };
    parts.push("version = version + 1", "updated_at = datetime('now')");
    vals.push(id, expectedVersion);
    const result = this.db.prepare(
      `UPDATE writing_spatial_nodes SET ${parts.join(', ')} WHERE id = ? AND version = ?`
    ).run(...vals);
    if (result.changes === 0) {
      const row = this.db.prepare('SELECT version FROM writing_spatial_nodes WHERE id = ?').get(id) as { version: number } | undefined;
      if (!row) throw new WritingError(WritingErrorCode.WRITING_OBJECT_NOT_FOUND, `空间节点不存在: ${id}`, { objectType: 'spatial_node', objectId: id });
      throw new WritingError(WritingErrorCode.VERSION_CONFLICT, `空间节点版本冲突: 期望 ${expectedVersion}，实际 ${row.version}`, { expected: expectedVersion, actual: row.version });
    }
    return { newVersion: expectedVersion + 1 };
  }

  private rowToSpatialNode(row: Record<string, unknown>): WritingSpatialNode {
    return {
      id: row['id'] as string, projectId: row['project_id'] as string,
      label: row['label'] as string, typeId: row['type_id'] as string,
      aliases: safeParseJson(row['aliases_json'] as string, row['id'] as string, 'aliases') as string[],
      description: (row['description'] as string) ?? undefined,
      sourceRefs: safeParseJson(row['source_refs_json'] as string, row['id'] as string, 'source_refs') as SourceRef[],
      maturity: row['maturity'] as SpatialNodeMaturity,
      status: row['status'] as SpatialNodeStatus,
      coreEntityId: (row['core_entity_id'] as string) ?? undefined,
      properties: safeParseJson(row['properties_json'] as string, row['id'] as string, 'properties') as Record<string, unknown>,
      version: row['version'] as number,
      createdAt: row['created_at'] as string, updatedAt: row['updated_at'] as string,
      deletedAt: (row['deleted_at'] as string) ?? undefined,
    };
  }

  // ===========================================================================
  // Phase 9：空间边 CRUD（W.18）
  // ===========================================================================

  createSpatialEdge(projectId: string, input: {
    sourceNodeId: string; targetNodeId: string; typeId: string;
    layer?: SpatialEdgeLayer; direction?: SpatialEdgeDirection;
    traversal?: SpatialTraversalRule; sourceRefs?: SourceRef[];
  }): WritingSpatialEdge {
    const id = `wsed_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    this.db.prepare(
      `INSERT INTO writing_spatial_edges (id, project_id, source_node_id, target_node_id, type_id, layer, direction, traversal_json, source_refs_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id, projectId, input.sourceNodeId, input.targetNodeId, input.typeId,
      input.layer ?? 'world', input.direction ?? 'directed',
      JSON.stringify(input.traversal ?? {}),
      JSON.stringify(input.sourceRefs ?? []),
    );
    return this.getSpatialEdge(id)!;
  }

  getSpatialEdge(id: string): WritingSpatialEdge | undefined {
    const row = this.db.prepare(
      'SELECT * FROM writing_spatial_edges WHERE id = ? AND deleted_at IS NULL'
    ).get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToSpatialEdge(row) : undefined;
  }

  listSpatialEdges(projectId: string, options?: {
    status?: SpatialEdgeStatus; layer?: SpatialEdgeLayer; sourceNodeId?: string; targetNodeId?: string;
  }): WritingSpatialEdge[] {
    let sql = 'SELECT * FROM writing_spatial_edges WHERE project_id = ? AND deleted_at IS NULL';
    const params: unknown[] = [projectId];
    if (options?.status) { sql += ' AND status = ?'; params.push(options.status); }
    if (options?.layer) { sql += ' AND layer = ?'; params.push(options.layer); }
    if (options?.sourceNodeId) { sql += ' AND source_node_id = ?'; params.push(options.sourceNodeId); }
    if (options?.targetNodeId) { sql += ' AND target_node_id = ?'; params.push(options.targetNodeId); }
    sql += ' ORDER BY created_at DESC';
    return (this.db.prepare(sql).all(...params) as Record<string, unknown>[]).map(r => this.rowToSpatialEdge(r));
  }

  updateSpatialEdge(id: string, expectedVersion: number, updates: Partial<{
    typeId: string; layer: SpatialEdgeLayer; direction: SpatialEdgeDirection;
    traversal: SpatialTraversalRule; sourceRefs: SourceRef[]; status: SpatialEdgeStatus;
  }>): { newVersion: number } {
    const parts: string[] = []; const vals: unknown[] = [];
    if (updates.typeId !== undefined) { parts.push('type_id = ?'); vals.push(updates.typeId); }
    if (updates.layer !== undefined) { parts.push('layer = ?'); vals.push(updates.layer); }
    if (updates.direction !== undefined) { parts.push('direction = ?'); vals.push(updates.direction); }
    if (updates.traversal !== undefined) { parts.push('traversal_json = ?'); vals.push(JSON.stringify(updates.traversal)); }
    if (updates.sourceRefs !== undefined) { parts.push('source_refs_json = ?'); vals.push(JSON.stringify(updates.sourceRefs)); }
    if (updates.status !== undefined) {
      const current = this.db.prepare('SELECT status FROM writing_spatial_edges WHERE id = ?').get(id) as { status: string } | undefined;
      if (current) validateSpatialEdgeStatus(current.status, updates.status, id);
      parts.push('status = ?'); vals.push(updates.status);
    }
    if (parts.length === 0) return { newVersion: expectedVersion };
    parts.push("version = version + 1", "updated_at = datetime('now')");
    vals.push(id, expectedVersion);
    const result = this.db.prepare(
      `UPDATE writing_spatial_edges SET ${parts.join(', ')} WHERE id = ? AND version = ?`
    ).run(...vals);
    if (result.changes === 0) {
      const row = this.db.prepare('SELECT version FROM writing_spatial_edges WHERE id = ?').get(id) as { version: number } | undefined;
      if (!row) throw new WritingError(WritingErrorCode.WRITING_OBJECT_NOT_FOUND, `空间边不存在: ${id}`, { objectType: 'spatial_edge', objectId: id });
      throw new WritingError(WritingErrorCode.VERSION_CONFLICT, `空间边版本冲突: 期望 ${expectedVersion}，实际 ${row.version}`, { expected: expectedVersion, actual: row.version });
    }
    return { newVersion: expectedVersion + 1 };
  }

  private rowToSpatialEdge(row: Record<string, unknown>): WritingSpatialEdge {
    return {
      id: row['id'] as string, projectId: row['project_id'] as string,
      sourceNodeId: row['source_node_id'] as string, targetNodeId: row['target_node_id'] as string,
      typeId: row['type_id'] as string,
      layer: row['layer'] as SpatialEdgeLayer,
      direction: row['direction'] as SpatialEdgeDirection,
      traversal: (() => { const t = safeParseJson(row['traversal_json'] as string, row['id'] as string, 'traversal') as Record<string, unknown>; return (t && Object.keys(t).length > 0) ? t as unknown as SpatialTraversalRule : undefined; })(),
      sourceRefs: safeParseJson(row['source_refs_json'] as string, row['id'] as string, 'source_refs') as SourceRef[],
      status: row['status'] as SpatialEdgeStatus,
      version: row['version'] as number,
      createdAt: row['created_at'] as string, updatedAt: row['updated_at'] as string,
      deletedAt: (row['deleted_at'] as string) ?? undefined,
    };
  }

  // ===========================================================================
  // Phase 9：空间视图 CRUD（W.19）
  // ===========================================================================

  createSpatialView(projectId: string, input: {
    name: string; rootSpatialNodeId?: string; layerIds?: string[];
    mode?: SpatialView['mode']; positions?: Record<string, { x: number; y: number; z?: number }>;
    filters?: Record<string, unknown>;
  }): SpatialView {
    const id = `wsv_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    this.db.prepare(
      `INSERT INTO writing_spatial_views (id, project_id, name, root_spatial_node_id, layer_ids_json, mode, positions_json, filters_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id, projectId, input.name,
      input.rootSpatialNodeId ?? null,
      JSON.stringify(input.layerIds ?? []),
      input.mode ?? 'graph',
      JSON.stringify(input.positions ?? {}),
      JSON.stringify(input.filters ?? {}),
    );
    return this.getSpatialView(id)!;
  }

  getSpatialView(id: string): SpatialView | undefined {
    const row = this.db.prepare(
      'SELECT * FROM writing_spatial_views WHERE id = ? AND deleted_at IS NULL'
    ).get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToSpatialView(row) : undefined;
  }

  listSpatialViews(projectId: string): SpatialView[] {
    return (this.db.prepare(
      'SELECT * FROM writing_spatial_views WHERE project_id = ? AND deleted_at IS NULL ORDER BY created_at DESC'
    ).all(projectId) as Record<string, unknown>[]).map(r => this.rowToSpatialView(r));
  }

  updateSpatialView(id: string, updates: Partial<{
    name: string; rootSpatialNodeId: string; layerIds: string[];
    mode: SpatialView['mode']; positions: Record<string, { x: number; y: number; z?: number }>;
    filters: Record<string, unknown>;
  }>): void {
    const parts: string[] = []; const vals: unknown[] = [];
    if (updates.name !== undefined) { parts.push('name = ?'); vals.push(updates.name); }
    if (updates.rootSpatialNodeId !== undefined) { parts.push('root_spatial_node_id = ?'); vals.push(updates.rootSpatialNodeId); }
    if (updates.layerIds !== undefined) { parts.push('layer_ids_json = ?'); vals.push(JSON.stringify(updates.layerIds)); }
    if (updates.mode !== undefined) { parts.push('mode = ?'); vals.push(updates.mode); }
    if (updates.positions !== undefined) { parts.push('positions_json = ?'); vals.push(JSON.stringify(updates.positions)); }
    if (updates.filters !== undefined) { parts.push('filters_json = ?'); vals.push(JSON.stringify(updates.filters)); }
    if (parts.length === 0) return;
    parts.push("updated_at = datetime('now')");
    vals.push(id);
    this.db.prepare(`UPDATE writing_spatial_views SET ${parts.join(', ')} WHERE id = ?`).run(...vals);
  }

  private rowToSpatialView(row: Record<string, unknown>): SpatialView {
    return {
      id: row['id'] as string, projectId: row['project_id'] as string,
      name: row['name'] as string,
      rootSpatialNodeId: (row['root_spatial_node_id'] as string) ?? undefined,
      layerIds: safeParseJson(row['layer_ids_json'] as string, row['id'] as string, 'layer_ids') as string[],
      mode: row['mode'] as SpatialView['mode'],
      positions: safeParseJson(row['positions_json'] as string, row['id'] as string, 'positions') as Record<string, { x: number; y: number; z?: number }>,
      filters: safeParseJson(row['filters_json'] as string, row['id'] as string, 'filters') as Record<string, unknown>,
      createdAt: row['created_at'] as string, updatedAt: row['updated_at'] as string,
    };
  }

  // ===========================================================================
  // Phase 10：章节规划 CRUD（W.20）
  // ===========================================================================

  createChapterPlan(projectId: string, input: {
    order: number; title: string; goals?: string[];
    povEntityId?: string; linkedSceneIds?: string[];
    linkedThreadIds?: string[]; linkedDraftIds?: string[];
  }): ChapterPlan {
    const id = `wcplan_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    this.db.prepare(
      `INSERT INTO writing_chapter_plans (id, project_id, sort_order, title, goals_json, pov_entity_id, linked_scene_ids_json, linked_thread_ids_json, linked_draft_ids_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id, projectId, input.order, input.title,
      JSON.stringify(input.goals ?? []),
      input.povEntityId ?? null,
      JSON.stringify(input.linkedSceneIds ?? []),
      JSON.stringify(input.linkedThreadIds ?? []),
      JSON.stringify(input.linkedDraftIds ?? []),
    );
    return this.getChapterPlan(id)!;
  }

  getChapterPlan(id: string): ChapterPlan | undefined {
    const row = this.db.prepare(
      'SELECT * FROM writing_chapter_plans WHERE id = ? AND deleted_at IS NULL'
    ).get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToChapterPlan(row) : undefined;
  }

  listChapterPlans(projectId: string): ChapterPlan[] {
    return (this.db.prepare(
      'SELECT * FROM writing_chapter_plans WHERE project_id = ? AND deleted_at IS NULL ORDER BY sort_order ASC'
    ).all(projectId) as Record<string, unknown>[]).map(r => this.rowToChapterPlan(r));
  }

  updateChapterPlan(id: string, expectedVersion: number, updates: Partial<{
    order: number; title: string; goals: string[];
    povEntityId: string; linkedSceneIds: string[];
    linkedThreadIds: string[]; linkedDraftIds: string[];
    proseDocumentId: string;
    status: ChapterPlanStatus;
  }>): { newVersion: number } {
    const parts: string[] = []; const vals: unknown[] = [];
    if (updates.order !== undefined) { parts.push('sort_order = ?'); vals.push(updates.order); }
    if (updates.title !== undefined) { parts.push('title = ?'); vals.push(updates.title); }
    if (updates.goals !== undefined) { parts.push('goals_json = ?'); vals.push(JSON.stringify(updates.goals)); }
    if (updates.povEntityId !== undefined) { parts.push('pov_entity_id = ?'); vals.push(updates.povEntityId); }
    if (updates.linkedSceneIds !== undefined) { parts.push('linked_scene_ids_json = ?'); vals.push(JSON.stringify(updates.linkedSceneIds)); }
    if (updates.linkedThreadIds !== undefined) { parts.push('linked_thread_ids_json = ?'); vals.push(JSON.stringify(updates.linkedThreadIds)); }
    if (updates.linkedDraftIds !== undefined) { parts.push('linked_draft_ids_json = ?'); vals.push(JSON.stringify(updates.linkedDraftIds)); }
    if (updates.proseDocumentId !== undefined) { parts.push('prose_document_id = ?'); vals.push(updates.proseDocumentId); }
    if (updates.status !== undefined) {
      const current = this.db.prepare('SELECT status FROM writing_chapter_plans WHERE id = ?').get(id) as { status: string } | undefined;
      if (current) validateChapterPlanStatus(current.status, updates.status, id);
      parts.push('status = ?'); vals.push(updates.status);
    }
    if (parts.length === 0) return { newVersion: expectedVersion };
    parts.push("version = version + 1", "updated_at = datetime('now')");
    vals.push(id, expectedVersion);
    const result = this.db.prepare(`UPDATE writing_chapter_plans SET ${parts.join(', ')} WHERE id = ? AND version = ?`).run(...vals);
    if (result.changes === 0) {
      const row = this.db.prepare('SELECT version FROM writing_chapter_plans WHERE id = ?').get(id) as { version: number } | undefined;
      if (!row) throw new WritingError(WritingErrorCode.WRITING_OBJECT_NOT_FOUND, `章节规划不存在: ${id}`, { objectType: 'chapter_plan', objectId: id });
      throw new WritingError(WritingErrorCode.VERSION_CONFLICT, `章节规划版本冲突: 期望 ${expectedVersion}，实际 ${row.version}`, { expected: expectedVersion, actual: row.version });
    }
    return { newVersion: expectedVersion + 1 };
  }

  private rowToChapterPlan(row: Record<string, unknown>): ChapterPlan {
    return {
      id: row['id'] as string, projectId: row['project_id'] as string,
      order: row['sort_order'] as number, title: row['title'] as string,
      goals: safeParseJson(row['goals_json'] as string, row['id'] as string, 'goals') as string[],
      povEntityId: (row['pov_entity_id'] as string) ?? undefined,
      linkedSceneIds: safeParseJson(row['linked_scene_ids_json'] as string, row['id'] as string, 'linked_scene_ids') as string[],
      linkedThreadIds: safeParseJson(row['linked_thread_ids_json'] as string, row['id'] as string, 'linked_thread_ids') as string[],
      linkedDraftIds: safeParseJson(row['linked_draft_ids_json'] as string, row['id'] as string, 'linked_draft_ids') as string[],
      proseDocumentId: (row['prose_document_id'] as string) ?? undefined,
      status: row['status'] as ChapterPlanStatus,
      version: row['version'] as number,
      createdAt: row['created_at'] as string, updatedAt: row['updated_at'] as string,
      deletedAt: (row['deleted_at'] as string) ?? undefined,
    };
  }

  // ===========================================================================
  // Phase 10：场景规划 CRUD（W.21）
  // ===========================================================================

  createScenePlan(projectId: string, input: {
    chapterId: string; order: number; title: string;
    purpose?: ScenePurpose[]; povEntityId?: string;
    spatialNodeId?: string; temporalRef?: string;
    participants?: string[]; expectedOutcome?: string;
    linkedProseBlockIds?: string[];
  }): ScenePlan {
    const id = `wsplan_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    this.db.prepare(
      `INSERT INTO writing_scene_plans (id, project_id, chapter_id, sort_order, title, purpose_json, pov_entity_id, spatial_node_id, temporal_ref, participants_json, expected_outcome, linked_prose_block_ids_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id, projectId, input.chapterId, input.order, input.title,
      JSON.stringify(input.purpose ?? []),
      input.povEntityId ?? null,
      input.spatialNodeId ?? null,
      input.temporalRef ?? null,
      JSON.stringify(input.participants ?? []),
      input.expectedOutcome ?? null,
      JSON.stringify(input.linkedProseBlockIds ?? []),
    );
    return this.getScenePlan(id)!;
  }

  getScenePlan(id: string): ScenePlan | undefined {
    const row = this.db.prepare(
      'SELECT * FROM writing_scene_plans WHERE id = ? AND deleted_at IS NULL'
    ).get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToScenePlan(row) : undefined;
  }

  listScenePlans(projectId: string, options?: { chapterId?: string }): ScenePlan[] {
    let sql = 'SELECT * FROM writing_scene_plans WHERE project_id = ? AND deleted_at IS NULL';
    const params: unknown[] = [projectId];
    if (options?.chapterId) { sql += ' AND chapter_id = ?'; params.push(options.chapterId); }
    sql += ' ORDER BY sort_order ASC';
    return (this.db.prepare(sql).all(...params) as Record<string, unknown>[]).map(r => this.rowToScenePlan(r));
  }

  updateScenePlan(id: string, expectedVersion: number, updates: Partial<{
    order: number; title: string; purpose: ScenePurpose[];
    povEntityId: string; spatialNodeId: string; temporalRef: string;
    participants: string[]; expectedOutcome: string;
    linkedProseBlockIds: string[]; status: ScenePlanStatus;
  }>): { newVersion: number } {
    const parts: string[] = []; const vals: unknown[] = [];
    if (updates.order !== undefined) { parts.push('sort_order = ?'); vals.push(updates.order); }
    if (updates.title !== undefined) { parts.push('title = ?'); vals.push(updates.title); }
    if (updates.purpose !== undefined) { parts.push('purpose_json = ?'); vals.push(JSON.stringify(updates.purpose)); }
    if (updates.povEntityId !== undefined) { parts.push('pov_entity_id = ?'); vals.push(updates.povEntityId); }
    if (updates.spatialNodeId !== undefined) { parts.push('spatial_node_id = ?'); vals.push(updates.spatialNodeId); }
    if (updates.temporalRef !== undefined) { parts.push('temporal_ref = ?'); vals.push(updates.temporalRef); }
    if (updates.participants !== undefined) { parts.push('participants_json = ?'); vals.push(JSON.stringify(updates.participants)); }
    if (updates.expectedOutcome !== undefined) { parts.push('expected_outcome = ?'); vals.push(updates.expectedOutcome); }
    if (updates.linkedProseBlockIds !== undefined) { parts.push('linked_prose_block_ids_json = ?'); vals.push(JSON.stringify(updates.linkedProseBlockIds)); }
    if (updates.status !== undefined) {
      const current = this.db.prepare('SELECT status FROM writing_scene_plans WHERE id = ?').get(id) as { status: string } | undefined;
      if (current) validateScenePlanStatus(current.status, updates.status, id);
      parts.push('status = ?'); vals.push(updates.status);
    }
    if (parts.length === 0) return { newVersion: expectedVersion };
    parts.push("version = version + 1", "updated_at = datetime('now')");
    vals.push(id, expectedVersion);
    const result = this.db.prepare(`UPDATE writing_scene_plans SET ${parts.join(', ')} WHERE id = ? AND version = ?`).run(...vals);
    if (result.changes === 0) {
      const row = this.db.prepare('SELECT version FROM writing_scene_plans WHERE id = ?').get(id) as { version: number } | undefined;
      if (!row) throw new WritingError(WritingErrorCode.WRITING_OBJECT_NOT_FOUND, `场景规划不存在: ${id}`, { objectType: 'scene_plan', objectId: id });
      throw new WritingError(WritingErrorCode.VERSION_CONFLICT, `场景规划版本冲突: 期望 ${expectedVersion}，实际 ${row.version}`, { expected: expectedVersion, actual: row.version });
    }
    return { newVersion: expectedVersion + 1 };
  }

  private rowToScenePlan(row: Record<string, unknown>): ScenePlan {
    return {
      id: row['id'] as string, projectId: row['project_id'] as string,
      chapterId: row['chapter_id'] as string, order: row['sort_order'] as number,
      title: row['title'] as string,
      purpose: safeParseJson(row['purpose_json'] as string, row['id'] as string, 'purpose') as ScenePurpose[],
      povEntityId: (row['pov_entity_id'] as string) ?? undefined,
      spatialNodeId: (row['spatial_node_id'] as string) ?? undefined,
      temporalRef: (row['temporal_ref'] as string) ?? undefined,
      participants: safeParseJson(row['participants_json'] as string, row['id'] as string, 'participants') as string[],
      expectedOutcome: (row['expected_outcome'] as string) ?? undefined,
      linkedProseBlockIds: safeParseJson(row['linked_prose_block_ids_json'] as string, row['id'] as string, 'linked_prose_block_ids') as string[],
      status: row['status'] as ScenePlanStatus,
      version: row['version'] as number,
      createdAt: row['created_at'] as string, updatedAt: row['updated_at'] as string,
      deletedAt: (row['deleted_at'] as string) ?? undefined,
    };
  }

  // ===========================================================================
  // Phase 11：读者群体 CRUD（W.22）
  // ===========================================================================

  createReaderAudience(projectId: string, input: {
    label: string; kind: ReaderAudienceKind; notes?: string;
  }): ReaderAudienceProfile {
    const id = `wra_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    this.db.prepare(
      `INSERT INTO writing_reader_audiences (id, project_id, label, kind, notes) VALUES (?, ?, ?, ?, ?)`
    ).run(id, projectId, input.label, input.kind, input.notes ?? null);
    return this.rowToReaderAudience(this.db.prepare('SELECT * FROM writing_reader_audiences WHERE id = ?').get(id) as Record<string, unknown>);
  }

  listReaderAudiences(projectId: string): ReaderAudienceProfile[] {
    return (this.db.prepare('SELECT * FROM writing_reader_audiences WHERE project_id = ?').all(projectId) as Record<string, unknown>[]).map(r => this.rowToReaderAudience(r));
  }

  /** DB snake_case 行 → camelCase ReaderAudienceProfile（修复 projectId 等字段丢失 bug） */
  private rowToReaderAudience(row: Record<string, unknown>): ReaderAudienceProfile {
    return {
      id: row['id'] as string,
      projectId: row['project_id'] as string,
      label: row['label'] as string,
      kind: row['kind'] as ReaderAudienceKind,
      enabled: Boolean(row['enabled']),
      notes: (row['notes'] as string) ?? undefined,
    };
  }

  // ===========================================================================
  // Phase 11：读者认知状态 CRUD（W.23）
  // ===========================================================================

  createReaderKnowledgeState(input: {
    audienceId: string; subjectRef: string;
    state: ReaderKnowledgeStateValue; confidence?: number;
    narrativePositionType: string; narrativePositionId: string;
    sourceRefs?: string[];
  }): ReaderKnowledgeState {
    const id = `wrks_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    this.db.prepare(
      `INSERT INTO writing_reader_knowledge_states (id, audience_id, narrative_position_type, narrative_position_id, subject_ref, state, confidence, source_refs_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, input.audienceId, input.narrativePositionType, input.narrativePositionId, input.subjectRef, input.state, input.confidence ?? 0.5, JSON.stringify(input.sourceRefs ?? []));
    return this.rowToReaderKnowledgeState(this.db.prepare('SELECT * FROM writing_reader_knowledge_states WHERE id = ?').get(id) as Record<string, unknown>);
  }

  listReaderKnowledgeStates(audienceId: string): ReaderKnowledgeState[] {
    return (this.db.prepare('SELECT * FROM writing_reader_knowledge_states WHERE audience_id = ?').all(audienceId) as Record<string, unknown>[]).map(r => this.rowToReaderKnowledgeState(r));
  }

  /** DB snake_case 行 → camelCase ReaderKnowledgeState（修复 subjectRef 等字段丢失 bug） */
  private rowToReaderKnowledgeState(row: Record<string, unknown>): ReaderKnowledgeState {
    return {
      id: row['id'] as string,
      audienceId: row['audience_id'] as string,
      narrativePositionRef: {
        objectType: (row['narrative_position_type'] as string) as WritingObjectRef['objectType'],
        objectId: row['narrative_position_id'] as string,
      },
      subjectRef: row['subject_ref'] as string,
      state: row['state'] as ReaderKnowledgeStateValue,
      confidence: row['confidence'] as number,
      sourceRefs: safeParseJson(row['source_refs_json'] as string, row['id'] as string, 'source_refs') as string[],
      createdAt: row['created_at'] as string,
      updatedAt: row['updated_at'] as string,
    };
  }

  updateReaderKnowledgeState(id: string, updates: { state: ReaderKnowledgeStateValue; confidence?: number; sourceRefs?: string[] }): void {
    const parts: string[] = ['state = ?']; const vals: unknown[] = [updates.state];
    if (updates.confidence !== undefined) { parts.push('confidence = ?'); vals.push(updates.confidence); }
    if (updates.sourceRefs !== undefined) { parts.push('source_refs_json = ?'); vals.push(JSON.stringify(updates.sourceRefs)); }
    parts.push("updated_at = datetime('now')");
    vals.push(id);
    this.db.prepare(`UPDATE writing_reader_knowledge_states SET ${parts.join(', ')} WHERE id = ?`).run(...vals);
  }

  // ===========================================================================
  // Phase 11：伏笔计划 CRUD（W.24）
  // ===========================================================================

  createForeshadowingPlan(projectId: string, input: {
    label: string; kind: ForeshadowingKind; targetReaderEffect: string;
    linkedEntityRefs?: string[]; linkedThreadId?: string;
  }): ForeshadowingPlan {
    const id = `wfp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    this.db.prepare(
      `INSERT INTO writing_foreshadowing_plans (id, project_id, label, kind, target_reader_effect, linked_entity_refs_json, linked_thread_id) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(id, projectId, input.label, input.kind, input.targetReaderEffect, JSON.stringify(input.linkedEntityRefs ?? []), input.linkedThreadId ?? null);
    return this.db.prepare('SELECT * FROM writing_foreshadowing_plans WHERE id = ?').get(id) as ForeshadowingPlan;
  }

  getForeshadowingPlan(id: string): ForeshadowingPlan | undefined {
    return this.db.prepare('SELECT * FROM writing_foreshadowing_plans WHERE id = ? AND deleted_at IS NULL').get(id) as ForeshadowingPlan | undefined;
  }

  listForeshadowingPlans(projectId: string): ForeshadowingPlan[] {
    return this.db.prepare('SELECT * FROM writing_foreshadowing_plans WHERE project_id = ? AND deleted_at IS NULL').all(projectId) as ForeshadowingPlan[];
  }

  updateForeshadowingPlan(id: string, updates: Partial<{ status: ForeshadowingPlanStatus; revealPlanId: string; linkedThreadId: string }>): void {
    const parts: string[] = []; const vals: unknown[] = [];
    if (updates.status !== undefined) { parts.push('status = ?'); vals.push(updates.status); }
    if (updates.revealPlanId !== undefined) { parts.push('reveal_plan_id = ?'); vals.push(updates.revealPlanId); }
    if (updates.linkedThreadId !== undefined) { parts.push('linked_thread_id = ?'); vals.push(updates.linkedThreadId); }
    if (parts.length === 0) return;
    parts.push("version = version + 1", "updated_at = datetime('now')");
    vals.push(id);
    this.db.prepare(`UPDATE writing_foreshadowing_plans SET ${parts.join(', ')} WHERE id = ?`).run(...vals);
  }

  // ===========================================================================
  // Phase 11：暗示节点 CRUD（W.25）
  // ===========================================================================

  createHintOccurrence(input: {
    foreshadowingPlanId: string; chapterId?: string; sceneId?: string;
    intensity: HintIntensity; visibility: HintVisibility;
    anchor?: { paragraphIndex: number; sentenceIndex?: number; excerpt?: string };
  }): HintOccurrence {
    const id = `who_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    this.db.prepare(
      `INSERT INTO writing_hint_occurrences (id, foreshadowing_plan_id, anchor_json, chapter_id, scene_id, intensity, visibility) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(id, input.foreshadowingPlanId, input.anchor ? JSON.stringify(input.anchor) : null, input.chapterId ?? null, input.sceneId ?? null, input.intensity, input.visibility);
    return this.db.prepare('SELECT * FROM writing_hint_occurrences WHERE id = ?').get(id) as HintOccurrence;
  }

  listHintOccurrences(foreshadowingPlanId: string): HintOccurrence[] {
    return this.db.prepare('SELECT * FROM writing_hint_occurrences WHERE foreshadowing_plan_id = ?').all(foreshadowingPlanId) as HintOccurrence[];
  }

  // ===========================================================================
  // Phase 11：回收计划 CRUD（W.26）
  // ===========================================================================

  createPayoffPlan(input: {
    foreshadowingPlanId: string; kind: PayoffKind;
    targetChapterId?: string; targetSceneId?: string; notes?: string;
  }): PayoffPlan {
    const id = `wpp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    this.db.prepare(
      `INSERT INTO writing_payoff_plans (id, foreshadowing_plan_id, kind, target_chapter_id, target_scene_id, notes) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(id, input.foreshadowingPlanId, input.kind, input.targetChapterId ?? null, input.targetSceneId ?? null, input.notes ?? null);
    return this.db.prepare('SELECT * FROM writing_payoff_plans WHERE id = ?').get(id) as PayoffPlan;
  }

  listPayoffPlans(foreshadowingPlanId: string): PayoffPlan[] {
    return this.db.prepare('SELECT * FROM writing_payoff_plans WHERE foreshadowing_plan_id = ?').all(foreshadowingPlanId) as PayoffPlan[];
  }

  // ===========================================================================
  // Phase 11：揭示计划 CRUD（W.27/W.28）
  // ===========================================================================

  createRevealPlan(projectId: string, input: {
    label: string; subjectDescription: string; linkedThreadId?: string; targetReaderEffect?: string;
  }): RevealPlan {
    const id = `wrp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    this.db.prepare(
      `INSERT INTO writing_reveal_plans (id, project_id, label, subject_description, linked_thread_id, target_reader_effect) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(id, projectId, input.label, input.subjectDescription, input.linkedThreadId ?? null, input.targetReaderEffect ?? null);
    return this.db.prepare('SELECT * FROM writing_reveal_plans WHERE id = ?').get(id) as RevealPlan;
  }

  getRevealPlan(id: string): RevealPlan | undefined {
    return this.db.prepare('SELECT * FROM writing_reveal_plans WHERE id = ? AND deleted_at IS NULL').get(id) as RevealPlan | undefined;
  }

  listRevealPlans(projectId: string): RevealPlan[] {
    return this.db.prepare('SELECT * FROM writing_reveal_plans WHERE project_id = ? AND deleted_at IS NULL').all(projectId) as RevealPlan[];
  }

  updateRevealPlan(id: string, updates: Partial<{ status: RevealPlanStatus }>): void {
    const parts: string[] = []; const vals: unknown[] = [];
    if (updates.status !== undefined) { parts.push('status = ?'); vals.push(updates.status); }
    if (parts.length === 0) return;
    parts.push("version = version + 1", "updated_at = datetime('now')");
    vals.push(id);
    this.db.prepare(`UPDATE writing_reveal_plans SET ${parts.join(', ')} WHERE id = ?`).run(...vals);
  }

  createRevealMilestone(input: {
    revealPlanId: string; kind: RevealMilestoneKind; description: string;
    chapterId?: string; sceneId?: string;
  }): RevealMilestone {
    const id = `wrm_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    this.db.prepare(
      `INSERT INTO writing_reveal_milestones (id, reveal_plan_id, kind, chapter_id, scene_id, description) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(id, input.revealPlanId, input.kind, input.chapterId ?? null, input.sceneId ?? null, input.description);
    return this.db.prepare('SELECT * FROM writing_reveal_milestones WHERE id = ?').get(id) as RevealMilestone;
  }

  listRevealMilestones(revealPlanId: string): RevealMilestone[] {
    return this.db.prepare('SELECT * FROM writing_reveal_milestones WHERE reveal_plan_id = ?').all(revealPlanId) as RevealMilestone[];
  }

  // ===========================================================================
  // 起草工作台：设定集文档树 CRUD（W.37 writing_documents）
  // ===========================================================================

  /** 创建文档节点。sortOrder 由调用方决定（通常取父节点下 max+1）。 */
  createDocument(projectId: string, input: {
    parentId: string | null; kind: WritingDocumentKind;
    template?: WritingDocumentTemplate; title: string; icon?: string;
    content?: string; contentFormat?: DocumentContentFormat;
    sortOrder: number; tags?: string[];
    templateFields?: Record<string, string>;
    chapterPlanId?: string; draftId?: string;
    wordCount?: number;
  }): WritingDocument {
    const id = `wdoc_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    this.db.prepare(
      `INSERT INTO writing_documents
       (id, project_id, parent_id, kind, template, title, icon, content, content_format,
        chapter_plan_id, draft_id, sort_order, template_fields_json, tags_json, word_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id, projectId, input.parentId, input.kind,
      input.template ?? 'freeform', input.title, input.icon ?? null,
      input.content ?? null, input.contentFormat ?? 'tiptap',
      input.chapterPlanId ?? null, input.draftId ?? null,
      input.sortOrder,
      input.templateFields ? JSON.stringify(input.templateFields) : null,
      JSON.stringify(input.tags ?? []),
      input.wordCount ?? 0,
    );
    return this.getDocument(id)!;
  }

  getDocument(id: string): WritingDocument | undefined {
    const row = this.db.prepare(
      'SELECT * FROM writing_documents WHERE id = ? AND deleted_at IS NULL'
    ).get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToDocument(row) : undefined;
  }

  /** 列出项目下全部文档（一次拉全树，由前端组装；项目级文档量通常不大）。 */
  listDocuments(projectId: string): WritingDocument[] {
    return (this.db.prepare(
      'SELECT * FROM writing_documents WHERE project_id = ? AND deleted_at IS NULL ORDER BY sort_order ASC'
    ).all(projectId) as Record<string, unknown>[]).map(r => this.rowToDocument(r));
  }

  /** 仅列出某父节点下的直接子节点（用于增量加载或拖拽落点校验）。 */
  listDocumentsByParent(projectId: string, parentId: string | null): WritingDocument[] {
    if (parentId === null) {
      return (this.db.prepare(
        'SELECT * FROM writing_documents WHERE project_id = ? AND parent_id IS NULL AND deleted_at IS NULL ORDER BY sort_order ASC'
      ).all(projectId) as Record<string, unknown>[]).map(r => this.rowToDocument(r));
    }
    return (this.db.prepare(
      'SELECT * FROM writing_documents WHERE project_id = ? AND parent_id = ? AND deleted_at IS NULL ORDER BY sort_order ASC'
    ).all(projectId, parentId) as Record<string, unknown>[]).map(r => this.rowToDocument(r));
  }

  /**
   * 更新文档（乐观锁）。
   * 覆盖更新：title/icon/content/contentFormat/sortOrder/parentId/tags/templateFields。
   * 改 parentId 不在此做循环校验（由 DocumentService 层负责防循环）。
   */
  updateDocument(id: string, expectedVersion: number, updates: Partial<{
    parentId: string | null; title: string; icon: string;
    content: string; contentFormat: DocumentContentFormat;
    sortOrder: number; tags: string[];
    templateFields: Record<string, string>; wordCount: number;
    status: WritingDocumentStatus;
  }>): { newVersion: number } {
    const parts: string[] = []; const vals: unknown[] = [];
    if (updates.parentId !== undefined) { parts.push('parent_id = ?'); vals.push(updates.parentId); }
    if (updates.title !== undefined) { parts.push('title = ?'); vals.push(updates.title); }
    if (updates.icon !== undefined) { parts.push('icon = ?'); vals.push(updates.icon); }
    if (updates.content !== undefined) { parts.push('content = ?'); vals.push(updates.content); }
    if (updates.contentFormat !== undefined) { parts.push('content_format = ?'); vals.push(updates.contentFormat); }
    if (updates.sortOrder !== undefined) { parts.push('sort_order = ?'); vals.push(updates.sortOrder); }
    if (updates.tags !== undefined) { parts.push('tags_json = ?'); vals.push(JSON.stringify(updates.tags)); }
    if (updates.templateFields !== undefined) {
      parts.push('template_fields_json = ?');
      vals.push(updates.templateFields ? JSON.stringify(updates.templateFields) : null);
    }
    if (updates.wordCount !== undefined) { parts.push('word_count = ?'); vals.push(updates.wordCount); }
    if (updates.status !== undefined) { parts.push('status = ?'); vals.push(updates.status); }
    if (parts.length === 0) return { newVersion: expectedVersion };
    parts.push("version = version + 1", "updated_at = datetime('now')");
    vals.push(id, expectedVersion);
    const result = this.db.prepare(`UPDATE writing_documents SET ${parts.join(', ')} WHERE id = ? AND version = ?`).run(...vals);
    if (result.changes === 0) {
      const row = this.db.prepare('SELECT version FROM writing_documents WHERE id = ?').get(id) as { version: number } | undefined;
      if (!row) throw new WritingError(WritingErrorCode.WRITING_OBJECT_NOT_FOUND, `文档不存在: ${id}`, { objectType: 'document', objectId: id });
      throw new WritingError(WritingErrorCode.VERSION_CONFLICT, `文档版本冲突: 期望 ${expectedVersion}，实际 ${row.version}`, { expected: expectedVersion, actual: row.version });
    }
    return { newVersion: expectedVersion + 1 };
  }

  /** 软删除（归档）单个文档节点。子节点的级联归档由 DocumentService 负责。 */
  archiveDocument(id: string): void {
    this.db.prepare(
      "UPDATE writing_documents SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND deleted_at IS NULL"
    ).run(id);
  }

  /**
   * 查询某节点全部后代 id（含多层，不含自身）。
   * 用递归 CTE：anchor 取 parent_id = id 的直接子节点，再逐层向下展开。
   * DocumentService.move 用它做防循环校验；archive 用它做级联归档。
   */
  listDescendantIds(id: string): string[] {
    const rows = this.db.prepare(
      `WITH RECURSIVE descendants(id) AS (
         SELECT id FROM writing_documents WHERE parent_id = ? AND deleted_at IS NULL
         UNION ALL
         SELECT d.id FROM writing_documents d
         JOIN descendants ON d.parent_id = descendants.id
         WHERE d.deleted_at IS NULL
       )
       SELECT id FROM descendants`
    ).all(id) as { id: string }[];
    return rows.map(r => r.id);
  }

  private rowToDocument(row: Record<string, unknown>): WritingDocument {
    return {
      id: row['id'] as string,
      projectId: row['project_id'] as string,
      parentId: (row['parent_id'] as string) ?? null,
      kind: row['kind'] as WritingDocumentKind,
      template: row['template'] as WritingDocumentTemplate,
      title: row['title'] as string,
      icon: (row['icon'] as string) ?? undefined,
      content: (row['content'] as string) ?? undefined,
      contentFormat: (row['content_format'] as DocumentContentFormat) ?? undefined,
      chapterPlanId: (row['chapter_plan_id'] as string) ?? undefined,
      draftId: (row['draft_id'] as string) ?? undefined,
      sortOrder: row['sort_order'] as number,
      templateFields: row['template_fields_json']
        ? safeParseJson(row['template_fields_json'] as string, row['id'] as string, 'template_fields') as Record<string, string>
        : undefined,
      wordCount: (row['word_count'] as number) ?? undefined,
      tags: safeParseJson(row['tags_json'] as string, row['id'] as string, 'tags') as string[],
      status: row['status'] as WritingDocumentStatus,
      version: row['version'] as number,
      createdAt: row['created_at'] as string,
      updatedAt: row['updated_at'] as string,
      deletedAt: (row['deleted_at'] as string) ?? undefined,
    };
  }

  // ===========================================================================
  // Phase 12 · 正文文档 / 正文块（§13.8）
  // ===========================================================================

  createProseDocument(projectId: string, input: { title: string; draftId?: string }): ProseDocument {
    const id = makeId(PREFIX.prose_document);
    const versionId = `wpdv_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    this.db.prepare(
      `INSERT INTO writing_prose_documents (id, project_id, title, version_id, draft_id) VALUES (?, ?, ?, ?, ?)`,
    ).run(id, projectId, input.title, versionId, input.draftId ?? null);
    return this.getProseDocument(id)!;
  }

  getProseDocument(id: string): ProseDocument | undefined {
    const row = this.db.prepare(
      'SELECT * FROM writing_prose_documents WHERE id = ? AND deleted_at IS NULL',
    ).get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToProseDocument(row) : undefined;
  }

  listProseDocuments(projectId: string): ProseDocument[] {
    const rows = this.db.prepare(
      'SELECT * FROM writing_prose_documents WHERE project_id = ? AND deleted_at IS NULL ORDER BY created_at',
    ).all(projectId) as Record<string, unknown>[];
    return rows.map(r => this.rowToProseDocument(r));
  }

  updateProseDocument(id: string, updates: Partial<{ title: string; mode: ProseDocumentMode; draftId: string }>): void {
    const parts: string[] = []; const vals: unknown[] = [];
    if (updates.title !== undefined) { parts.push('title = ?'); vals.push(updates.title); }
    if (updates.mode !== undefined) { parts.push('mode = ?'); vals.push(updates.mode); }
    if (updates.draftId !== undefined) { parts.push('draft_id = ?'); vals.push(updates.draftId); }
    if (parts.length === 0) return;
    parts.push("version = version + 1", "updated_at = datetime('now')");
    vals.push(id);
    this.db.prepare(`UPDATE writing_prose_documents SET ${parts.join(', ')} WHERE id = ?`).run(...vals);
  }

  /** 结构变更 bump versionId（正文锚点失效判断依据，§13.8） */
  private bumpProseVersion(documentId: string): void {
    const newVersionId = `wpdv_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    this.db.prepare(
      `UPDATE writing_prose_documents SET version_id = ?, version = version + 1, updated_at = datetime('now') WHERE id = ?`,
    ).run(newVersionId, documentId);
  }

  getProseBlocks(documentId: string): ProseBlock[] {
    const rows = this.db.prepare(
      'SELECT * FROM writing_prose_blocks WHERE document_id = ? ORDER BY order_index',
    ).all(documentId) as Record<string, unknown>[];
    return rows.map(r => this.rowToProseBlock(r));
  }

  addProseBlock(input: { documentId: string; kind: ProseBlockKind; text: string; sceneId?: string; sourceRefs?: string[] }): ProseBlock {
    const id = makeId(PREFIX.prose_block);
    const maxOrder = this.db.prepare(
      'SELECT COALESCE(MAX(order_index), -1) AS m FROM writing_prose_blocks WHERE document_id = ?',
    ).get(input.documentId) as { m: number };
    const orderIndex = maxOrder.m + 1;
    this.db.prepare(
      `INSERT INTO writing_prose_blocks (id, document_id, kind, order_index, text, scene_id, source_refs_json) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, input.documentId, input.kind, orderIndex, input.text, input.sceneId ?? null, safeStringify(input.sourceRefs ?? []));
    this.bumpProseVersion(input.documentId);
    const row = this.db.prepare('SELECT * FROM writing_prose_blocks WHERE id = ?').get(id) as Record<string, unknown>;
    return this.rowToProseBlock(row);
  }

  updateProseBlock(id: string, updates: Partial<{ kind: ProseBlockKind; text: string; sceneId: string }>): void {
    const parts: string[] = []; const vals: unknown[] = [];
    if (updates.kind !== undefined) { parts.push('kind = ?'); vals.push(updates.kind); }
    if (updates.text !== undefined) { parts.push('text = ?'); vals.push(updates.text); }
    if (updates.sceneId !== undefined) { parts.push('scene_id = ?'); vals.push(updates.sceneId); }
    if (parts.length === 0) return;
    parts.push("updated_at = datetime('now')");
    vals.push(id);
    this.db.prepare(`UPDATE writing_prose_blocks SET ${parts.join(', ')} WHERE id = ?`).run(...vals);
    const docRow = this.db.prepare('SELECT document_id FROM writing_prose_blocks WHERE id = ?').get(id) as { document_id: string } | undefined;
    if (docRow) this.bumpProseVersion(docRow.document_id);
  }

  /** 移动块到新位置（reorder）。targetOrderIndex 为插入后的目标序号。 */
  moveProseBlock(id: string, targetOrderIndex: number): void {
    const docRow = this.db.prepare('SELECT document_id FROM writing_prose_blocks WHERE id = ?').get(id) as { document_id: string } | undefined;
    if (!docRow) return;
    const documentId = docRow.document_id;
    const txn = this.db.transaction(() => {
      const blocks = this.getProseBlocks(documentId);
      const moved = blocks.find(b => b.id === id);
      if (!moved) return;
      const rest = blocks.filter(b => b.id !== id);
      const clamped = Math.max(0, Math.min(targetOrderIndex, rest.length));
      rest.splice(clamped, 0, moved);
      rest.forEach((b, idx) => {
        this.db.prepare("UPDATE writing_prose_blocks SET order_index = ?, updated_at = datetime('now') WHERE id = ?").run(idx, b.id);
      });
      this.bumpProseVersion(documentId);
    });
    txn();
  }

  deleteProseBlock(id: string): void {
    const docRow = this.db.prepare('SELECT document_id FROM writing_prose_blocks WHERE id = ?').get(id) as { document_id: string } | undefined;
    if (!docRow) return;
    const documentId = docRow.document_id;
    const txn = this.db.transaction(() => {
      this.db.prepare('DELETE FROM writing_prose_blocks WHERE id = ?').run(id);
      const blocks = this.getProseBlocks(documentId);
      blocks.forEach((b, idx) => {
        this.db.prepare('UPDATE writing_prose_blocks SET order_index = ? WHERE id = ?').run(idx, b.id);
      });
      this.bumpProseVersion(documentId);
    });
    txn();
  }

  private rowToProseDocument(row: Record<string, unknown>): ProseDocument {
    return {
      id: row['id'] as string,
      projectId: row['project_id'] as string,
      title: row['title'] as string,
      versionId: row['version_id'] as string,
      mode: row['mode'] as ProseDocumentMode,
      draftId: (row['draft_id'] as string) ?? undefined,
      version: row['version'] as number,
      createdAt: row['created_at'] as string,
      updatedAt: row['updated_at'] as string,
      deletedAt: (row['deleted_at'] as string) ?? undefined,
    };
  }

  private rowToProseBlock(row: Record<string, unknown>): ProseBlock {
    return {
      id: row['id'] as string,
      documentId: row['document_id'] as string,
      kind: row['kind'] as ProseBlockKind,
      orderIndex: row['order_index'] as number,
      text: row['text'] as string,
      sceneId: (row['scene_id'] as string) ?? undefined,
      sourceRefs: safeParseJson<string[]>(row['source_refs_json'] as string, row['id'] as string, 'source_refs_json'),
      createdAt: row['created_at'] as string,
      updatedAt: row['updated_at'] as string,
    };
  }

  // ===========================================================================
  // Phase 12 · 风格指南 / 示例 / 禁用表达（§18）
  // ===========================================================================

  getOrCreateDefaultStyleGuide(projectId: string): StyleGuide {
    const row = this.db.prepare(
      'SELECT * FROM writing_style_guides WHERE project_id = ? AND scope = ? AND status != ? AND deleted_at IS NULL',
    ).get(projectId, 'default', 'archived') as Record<string, unknown> | undefined;
    if (row) return this.rowToStyleGuide(row);
    const id = makeId(PREFIX.style_guide);
    this.db.prepare(
      `INSERT INTO writing_style_guides (id, project_id, name, scope, status) VALUES (?, ?, '默认风格', 'default', 'draft')`,
    ).run(id, projectId);
    return this.rowToStyleGuide(this.db.prepare('SELECT * FROM writing_style_guides WHERE id = ?').get(id) as Record<string, unknown>);
  }

  getStyleGuide(id: string): StyleGuide | undefined {
    const row = this.db.prepare('SELECT * FROM writing_style_guides WHERE id = ? AND deleted_at IS NULL').get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToStyleGuide(row) : undefined;
  }

  listStyleGuides(projectId: string): StyleGuide[] {
    const rows = this.db.prepare(
      'SELECT * FROM writing_style_guides WHERE project_id = ? AND deleted_at IS NULL ORDER BY scope, created_at',
    ).all(projectId) as Record<string, unknown>[];
    return rows.map(r => this.rowToStyleGuide(r));
  }

  updateStyleGuide(id: string, updates: Partial<{
    name: string; narrativePerson: NarrativePerson; narrativeDistance: NarrativeDistance;
    pacingPreference: PacingPreference; descriptionPreference: DescriptionPreference[];
    bannedExpressionIds: string[]; exampleIds: string[]; status: StyleGuideStatus; scopeNote: string;
  }>): void {
    const parts: string[] = []; const vals: unknown[] = [];
    if (updates.name !== undefined) { parts.push('name = ?'); vals.push(updates.name); }
    if (updates.narrativePerson !== undefined) { parts.push('narrative_person = ?'); vals.push(updates.narrativePerson); }
    if (updates.narrativeDistance !== undefined) { parts.push('narrative_distance = ?'); vals.push(updates.narrativeDistance); }
    if (updates.pacingPreference !== undefined) { parts.push('pacing_preference = ?'); vals.push(updates.pacingPreference); }
    if (updates.descriptionPreference !== undefined) { parts.push('description_preference_json = ?'); vals.push(safeStringify(updates.descriptionPreference)); }
    if (updates.bannedExpressionIds !== undefined) { parts.push('banned_expression_ids_json = ?'); vals.push(safeStringify(updates.bannedExpressionIds)); }
    if (updates.exampleIds !== undefined) { parts.push('example_ids_json = ?'); vals.push(safeStringify(updates.exampleIds)); }
    if (updates.status !== undefined) { parts.push('status = ?'); vals.push(updates.status); }
    if (updates.scopeNote !== undefined) { parts.push('scope_note = ?'); vals.push(updates.scopeNote); }
    if (parts.length === 0) return;
    parts.push("version = version + 1", "updated_at = datetime('now')");
    vals.push(id);
    this.db.prepare(`UPDATE writing_style_guides SET ${parts.join(', ')} WHERE id = ?`).run(...vals);
  }

  createStyleExample(projectId: string, input: { kind: StyleExampleKind; text: string; note?: string; sourceBlockId?: string }): StyleExample {
    const id = makeId(PREFIX.style_example);
    this.db.prepare(
      `INSERT INTO writing_style_examples (id, project_id, kind, text, note, source_block_id) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, projectId, input.kind, input.text, input.note ?? null, input.sourceBlockId ?? null);
    return this.rowToStyleExample(this.db.prepare('SELECT * FROM writing_style_examples WHERE id = ?').get(id) as Record<string, unknown>);
  }

  listStyleExamples(projectId: string): StyleExample[] {
    const rows = this.db.prepare(
      'SELECT * FROM writing_style_examples WHERE project_id = ? AND deleted_at IS NULL ORDER BY created_at',
    ).all(projectId) as Record<string, unknown>[];
    return rows.map(r => this.rowToStyleExample(r));
  }

  createBannedExpression(projectId: string, input: { pattern: string; reason?: string; category?: string }): BannedExpression {
    const id = makeId(PREFIX.banned_expression);
    this.db.prepare(
      `INSERT INTO writing_banned_expressions (id, project_id, pattern, reason, category) VALUES (?, ?, ?, ?, ?)`,
    ).run(id, projectId, input.pattern, input.reason ?? null, input.category ?? null);
    return this.rowToBannedExpression(this.db.prepare('SELECT * FROM writing_banned_expressions WHERE id = ?').get(id) as Record<string, unknown>);
  }

  listBannedExpressions(projectId: string): BannedExpression[] {
    const rows = this.db.prepare(
      'SELECT * FROM writing_banned_expressions WHERE project_id = ? AND deleted_at IS NULL ORDER BY created_at',
    ).all(projectId) as Record<string, unknown>[];
    return rows.map(r => this.rowToBannedExpression(r));
  }

  private rowToStyleGuide(row: Record<string, unknown>): StyleGuide {
    const id = row['id'] as string;
    return {
      id, projectId: row['project_id'] as string, name: row['name'] as string,
      narrativePerson: row['narrative_person'] as NarrativePerson,
      narrativeDistance: row['narrative_distance'] as NarrativeDistance,
      pacingPreference: row['pacing_preference'] as PacingPreference,
      descriptionPreference: safeParseJson<DescriptionPreference[]>(row['description_preference_json'] as string, id, 'description_preference_json'),
      bannedExpressionIds: safeParseJson<string[]>(row['banned_expression_ids_json'] as string, id, 'banned_expression_ids_json'),
      exampleIds: safeParseJson<string[]>(row['example_ids_json'] as string, id, 'example_ids_json'),
      scope: row['scope'] as 'default' | 'variant',
      scopeNote: (row['scope_note'] as string) ?? undefined,
      status: row['status'] as StyleGuideStatus,
      version: row['version'] as number,
      createdAt: row['created_at'] as string,
      updatedAt: row['updated_at'] as string,
      deletedAt: (row['deleted_at'] as string) ?? undefined,
    };
  }

  private rowToStyleExample(row: Record<string, unknown>): StyleExample {
    return {
      id: row['id'] as string, projectId: row['project_id'] as string,
      kind: row['kind'] as StyleExampleKind, text: row['text'] as string,
      note: (row['note'] as string) ?? undefined,
      sourceBlockId: (row['source_block_id'] as string) ?? undefined,
      createdAt: row['created_at'] as string, updatedAt: row['updated_at'] as string,
    };
  }

  private rowToBannedExpression(row: Record<string, unknown>): BannedExpression {
    return {
      id: row['id'] as string, projectId: row['project_id'] as string,
      pattern: row['pattern'] as string,
      reason: (row['reason'] as string) ?? undefined,
      category: (row['category'] as string) ?? undefined,
      createdAt: row['created_at'] as string, updatedAt: row['updated_at'] as string,
    };
  }

  // ===========================================================================
  // Phase 12 · 修订记录（§19.1）
  // ===========================================================================

  createRevisionRecord(projectId: string, input: {
    targetType: RevisionTargetType; targetId: string; action: RevisionAction; summary: string;
    beforeSnapshot?: Record<string, unknown>; afterSnapshot?: Record<string, unknown>;
    versionGroupId?: string; operator?: 'author' | 'agent';
  }): RevisionRecord {
    const id = makeId(PREFIX.revision_record);
    const versionGroupId = input.versionGroupId ?? `${input.targetType}_${input.targetId}`;
    this.db.prepare(
      `INSERT INTO writing_revision_records (id, project_id, target_type, target_id, action, summary, before_snapshot_json, after_snapshot_json, version_group_id, operator) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, projectId, input.targetType, input.targetId, input.action, input.summary,
      input.beforeSnapshot ? safeStringify(input.beforeSnapshot) : null,
      input.afterSnapshot ? safeStringify(input.afterSnapshot) : null,
      versionGroupId, input.operator ?? 'author');
    return this.rowToRevisionRecord(this.db.prepare('SELECT * FROM writing_revision_records WHERE id = ?').get(id) as Record<string, unknown>);
  }

  listRevisionsByTarget(projectId: string, targetType: RevisionTargetType, targetId: string): RevisionRecord[] {
    const rows = this.db.prepare(
      'SELECT * FROM writing_revision_records WHERE project_id = ? AND target_type = ? AND target_id = ? ORDER BY created_at DESC',
    ).all(projectId, targetType, targetId) as Record<string, unknown>[];
    return rows.map(r => this.rowToRevisionRecord(r));
  }

  /** 列出项目全部修订记录（按时间倒序，D2 修订历史查看器用） */
  listAllRevisionsByProject(projectId: string, limit?: number): RevisionRecord[] {
    const sql = limit
      ? 'SELECT * FROM writing_revision_records WHERE project_id = ? ORDER BY created_at DESC LIMIT ?'
      : 'SELECT * FROM writing_revision_records WHERE project_id = ? ORDER BY created_at DESC';
    const rows = (limit
      ? this.db.prepare(sql).all(projectId, limit)
      : this.db.prepare(sql).all(projectId)) as Record<string, unknown>[];
    return rows.map(r => this.rowToRevisionRecord(r));
  }

  listRevisionsByGroup(versionGroupId: string): RevisionRecord[] {
    const rows = this.db.prepare(
      'SELECT * FROM writing_revision_records WHERE version_group_id = ? ORDER BY created_at DESC',
    ).all(versionGroupId) as Record<string, unknown>[];
    return rows.map(r => this.rowToRevisionRecord(r));
  }

  getRevisionRecord(id: string): RevisionRecord | undefined {
    const row = this.db.prepare('SELECT * FROM writing_revision_records WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToRevisionRecord(row) : undefined;
  }

  private rowToRevisionRecord(row: Record<string, unknown>): RevisionRecord {
    const id = row['id'] as string;
    return {
      id, projectId: row['project_id'] as string,
      targetType: row['target_type'] as RevisionTargetType,
      targetId: row['target_id'] as string,
      action: row['action'] as RevisionAction,
      summary: row['summary'] as string,
      beforeSnapshot: row['before_snapshot_json'] ? safeParseJson(row['before_snapshot_json'] as string, id, 'before_snapshot_json') : undefined,
      afterSnapshot: row['after_snapshot_json'] ? safeParseJson(row['after_snapshot_json'] as string, id, 'after_snapshot_json') : undefined,
      versionGroupId: row['version_group_id'] as string,
      operator: row['operator'] as 'author' | 'agent',
      createdAt: row['created_at'] as string,
    };
  }

  // ===========================================================================
  // Phase 12 · Retcon 影响报告（§10.5/§19.4）
  // ===========================================================================

  createRetconReport(projectId: string, input: {
    retconProposalId: string; affectedNodes: RetconAffectedNode[];
    affectedEdges: RetconAffectedEdge[]; recheckList: WritingArtifactRecheckItem[]; summary: string;
  }): RetconImpactReport {
    const id = makeId(PREFIX.retcon_report);
    this.db.prepare(
      `INSERT INTO writing_retcon_reports (id, project_id, retcon_proposal_id, affected_nodes_json, affected_edges_json, recheck_list_json, summary) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, projectId, input.retconProposalId,
      safeStringify(input.affectedNodes), safeStringify(input.affectedEdges),
      safeStringify(input.recheckList), input.summary);
    return this.rowToRetconReport(this.db.prepare('SELECT * FROM writing_retcon_reports WHERE id = ?').get(id) as Record<string, unknown>);
  }

  getRetconReport(id: string): RetconImpactReport | undefined {
    const row = this.db.prepare('SELECT * FROM writing_retcon_reports WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToRetconReport(row) : undefined;
  }

  getRetconReportByProposal(retconProposalId: string): RetconImpactReport | undefined {
    // rowid 是 SQLite 隐式自增，保证同 created_at 毫秒时按插入顺序取最新（id 时间戳在并发下不可靠）
    const row = this.db.prepare(
      'SELECT * FROM writing_retcon_reports WHERE retcon_proposal_id = ? ORDER BY rowid DESC LIMIT 1',
    ).get(retconProposalId) as Record<string, unknown> | undefined;
    return row ? this.rowToRetconReport(row) : undefined;
  }

  listRetconReports(projectId: string): RetconImpactReport[] {
    const rows = this.db.prepare(
      'SELECT * FROM writing_retcon_reports WHERE project_id = ? ORDER BY created_at DESC',
    ).all(projectId) as Record<string, unknown>[];
    return rows.map(r => this.rowToRetconReport(r));
  }

  updateRetconReportStatus(id: string, status: RetconReportStatus): void {
    if (status === 'confirmed' || status === 'rejected') {
      this.db.prepare("UPDATE writing_retcon_reports SET status = ?, confirmed_at = datetime('now') WHERE id = ?").run(status, id);
    } else {
      this.db.prepare('UPDATE writing_retcon_reports SET status = ? WHERE id = ?').run(status, id);
    }
  }

  private rowToRetconReport(row: Record<string, unknown>): RetconImpactReport {
    const id = row['id'] as string;
    return {
      id, projectId: row['project_id'] as string,
      retconProposalId: row['retcon_proposal_id'] as string,
      status: row['status'] as RetconReportStatus,
      affectedNodes: safeParseJson<RetconAffectedNode[]>(row['affected_nodes_json'] as string, id, 'affected_nodes_json'),
      affectedEdges: safeParseJson<RetconAffectedEdge[]>(row['affected_edges_json'] as string, id, 'affected_edges_json'),
      recheckList: safeParseJson<WritingArtifactRecheckItem[]>(row['recheck_list_json'] as string, id, 'recheck_list_json'),
      summary: row['summary'] as string,
      createdAt: row['created_at'] as string,
      confirmedAt: (row['confirmed_at'] as string) ?? undefined,
    };
  }

  // ===========================================================================
  // Phase 12 · 导入批次（§20.1）
  // ===========================================================================

  createImportBatch(projectId: string, input: {
    sourceFilename?: string; importType: ImportType; rawSnapshot: string;
    metadata?: Record<string, unknown>;
  }): ImportBatch {
    const id = makeId(PREFIX.import_batch);
    this.db.prepare(
      `INSERT INTO writing_import_batches (id, project_id, source_filename, import_type, status, raw_snapshot, metadata_json) VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
    ).run(id, projectId, input.sourceFilename ?? null, input.importType, input.rawSnapshot, safeStringify(input.metadata ?? {}));
    return this.rowToImportBatch(this.db.prepare('SELECT * FROM writing_import_batches WHERE id = ?').get(id) as Record<string, unknown>);
  }

  getImportBatch(id: string): ImportBatch | undefined {
    const row = this.db.prepare('SELECT * FROM writing_import_batches WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToImportBatch(row) : undefined;
  }

  listImportBatches(projectId: string): ImportBatch[] {
    const rows = this.db.prepare(
      'SELECT * FROM writing_import_batches WHERE project_id = ? ORDER BY created_at DESC',
    ).all(projectId) as Record<string, unknown>[];
    return rows.map(r => this.rowToImportBatch(r));
  }

  completeImportBatch(id: string, status: ImportBatchStatus, generatedDocumentIds: string[]): void {
    this.db.prepare(
      `UPDATE writing_import_batches SET status = ?, generated_document_ids_json = ?, completed_at = datetime('now') WHERE id = ?`,
    ).run(status, safeStringify(generatedDocumentIds), id);
  }

  private rowToImportBatch(row: Record<string, unknown>): ImportBatch {
    const id = row['id'] as string;
    return {
      id, projectId: row['project_id'] as string,
      sourceFilename: (row['source_filename'] as string) ?? undefined,
      importType: row['import_type'] as ImportType,
      status: row['status'] as ImportBatchStatus,
      rawSnapshot: row['raw_snapshot'] as string,
      metadata: safeParseJson(row['metadata_json'] as string, id, 'metadata_json'),
      generatedDocumentIds: safeParseJson<string[]>(row['generated_document_ids_json'] as string, id, 'generated_document_ids_json'),
      createdAt: row['created_at'] as string,
      completedAt: (row['completed_at'] as string) ?? undefined,
    };
  }
}

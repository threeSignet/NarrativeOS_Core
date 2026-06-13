# Phase 7 写作层设计细化

**最后更新**：2026-06-13
**状态**：细化进行中，从 Feature Spec 向可编码规格收敛
**依赖文档**：
- `docs/Writing-Layer-Feature-Spec.md`（完整功能规格）
- `docs/Writing-Layer-Roadmap.md`（总体蓝图）
- `docs/Narrative-OS-Core-Architecture.md`（Core 架构宪法）
- `docs/NarrativeAgent-Design.md`（Agent 当前设计）

---

## 细化策略

Feature Spec 覆盖了 26 个模块、51 个章节、15866 行。本文档不重复全量，而是：

1. **做决策**：把 §51 待澄清问题逐个关闭
2. **定接口**：把 §33 的服务契约变成精确 TypeScript 签名
3. **定状态机**：把 §30 的通用层级变成每个对象的精确跳转图
4. **定边界**：明确 NarrativeAgent 在 Phase 7 中的改造范围
5. **定代码结构**：把 §42 的包结构变成实际文件路径

---

## 1. 存储方案 ★已决策

**决策**：同库 `writing_*` 前缀表，与 Core 表、Agent 表共享同一 SQLite 连接。

**理由**：
- Agent 表（`agent_*`）已有先例，模式一致
- 单文件备份/迁移，项目自包含
- 写作层引用 Core ID 可在同库内 JOIN
- 逻辑隔离通过前缀保证，Core 引擎不依赖 `writing_*` 表

**DQ-1 待澄清** → **已关闭**

---

## 2. SourceRef 数据模型 ★已决策

**决策**：统一 JSON 字段 `source_refs_json`，不建独立表。

**理由**：
- SourceRef 是"证据链"，不需要独立查询（不需要按来源反查所有对象）
- Feature Spec 定义的 SourceRef 结构简单（kind + id + excerpt）
- JSON 字段与 Agent 表风格一致（`detail_json` / `key_decisions_json` 等）
- 需要来源追溯时通过 `id` 引用查询对应表即可，不需要 JOIN source_refs 表

**DQ-8 待澄清** → **已关闭**

**精确类型**：
```ts
interface SourceRef {
  kind: 'idea' | 'draft' | 'prose' | 'proposal' | 'user_decision' | 'agent_observation' | 'import' | 'chat';
  id: string;
  excerpt?: string;
}
```

---

## 3. Phase 7 数据表 DDL

### 3.1 设计原则

- 与 `agent-store.ts` 风格一致：`CREATE TABLE IF NOT EXISTS` + 外键约束 + 索引
- ID 格式：`{prefix}_{timestamp}_{random}`，与 Core 的 `fct_` / `evt_` / `ent_` 对齐
- 时间字段使用 `TEXT ... DEFAULT (datetime('now'))`
- JSON 字段使用 `TEXT NOT NULL DEFAULT '[]'`（与 agent 表 `detail_json` 一致）
- 软删除使用 `deleted_at TEXT`（NULL = 活跃）

### 3.2 建表 SQL（11 张表）

```sql
-- =============================================================================
-- Phase 7 写作层表（11 张），与 Core 表 / Agent 表同库
-- =============================================================================

-- W.1 writing_projects：作品项目根容器
CREATE TABLE IF NOT EXISTS writing_projects (
  id                   TEXT PRIMARY KEY,
  title                TEXT NOT NULL,
  premise              TEXT,
  status               TEXT NOT NULL DEFAULT 'planning'
                       CHECK(status IN ('planning','drafting','reviewing','paused','archived')),
  active_blueprint_id  TEXT,
  current_draft_id     TEXT,
  workspace_mode       TEXT NOT NULL DEFAULT 'planning'
                       CHECK(workspace_mode IN ('planning','writing','reviewing','analysis','importing')),
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
                          CHECK(status IN ('drafting','ready_to_simulate','simulated','committed','archived','error')),
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
  author_decision        TEXT,
  author_decision_at     TEXT,
  core_event_id          TEXT,
  commit_error_json      TEXT,
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
  detail_json     TEXT NOT NULL DEFAULT '{}',
  error_code      TEXT,
  request_id      TEXT,
  session_id      TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (project_id) REFERENCES writing_projects(id)
);
CREATE INDEX IF NOT EXISTS idx_wal_project ON writing_audit_logs(project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_wal_target ON writing_audit_logs(target_type, target_id);
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
  FOREIGN KEY (project_id) REFERENCES writing_projects(id)
);
CREATE INDEX IF NOT EXISTS idx_wj_project ON writing_jobs(project_id, status);
CREATE INDEX IF NOT EXISTS idx_wj_type ON writing_jobs(project_id, job_type, status);
```

### 3.3 表数量决策说明

DQ-9 `CoreReferenceIndex` 是否独立建表 → **是，独立建表 `writing_core_refs`**。
理由：Core 引用需要在两个方向上查询（按写作对象查 Core ID → 验证引用有效性；按 Core ID 查写作对象 → Retcon 影响分析）。JSON 字段不支持反向索引。

DQ-10 `WritingDomainEvent` 是否持久化 → **Phase 7 作为内存事件 + 审计日志组合**。
持久化领域事件表留到后续阶段（需要事件溯源/重放能力时再建表）。

---

## 4. 通用 SourceRef 类型

```ts
// src/writing/models/source-ref.ts

/** 来源引用——每个写作层对象都必须能追溯来源 */
export interface SourceRef {
  /** 来源类型 */
  kind: 'idea' | 'draft' | 'prose' | 'proposal' | 'user_decision'
      | 'agent_observation' | 'import' | 'chat';
  /** 来源对象 ID */
  id: string;
  /** 来源原文摘录（可选） */
  excerpt?: string;
}

/** 带来源引用的对象通用字段 */
export interface SourceTracked {
  sourceRefs: SourceRef[];
}
```

---

## 5. 状态机细化

### 5.0 通用状态层级（7 层）

```
hint ──────→ candidate ──────→ review ──────→ committed
  │              │                │               │
  └──→ archive   └──→ archive    └──→ archive    │
                                    │             │
                              draft ──→ review    │
                                │                 │
                                └──→ archive      │
                                                  │
              error ←── (任意失败但可恢复) ←────────┘
```

禁止跳转：
- `hint → review`（跳过候选确认）
- `draft → committed`（跳过审核）
- `candidate → committed`（跳过审核和 CoreBridge）
- `hint → committed`（发现提示不能直接提交）
- 前端直接改 status 字段（必须通过服务层）

### 5.1 WritingProject 状态机

```
planning ──→ drafting ──→ reviewing ──→ paused
   │             │              │            │
   └──→ archived ←──────────────┴────────────┘
```

- `planning`：项目创建后初始状态，可修改标题/目标/蓝图
- `drafting`：已有草案，可创建更多草案、候选实体
- `reviewing`：有待审核事项（Proposal Review 中）
- `paused`：作者暂停写作
- `archived`：归档，停止主动分析

### 5.2 IdeaCard 成熟度流转

```
raw ──→ candidate ──→ structured ──→ ready_for_draft
  │         │              │               │
  └──→ archived ←──────────┴───────────────┘
```

- `raw`：原始输入，系统不分析（analysis_policy 可覆盖）
- `candidate`：系统整理过，有摘要和标签
- `structured`：有明确结构，可链接到草案/实体
- `ready_for_draft`：可转为 WritingDraft（需作者确认）
- `archived`：废弃但保留原文

### 5.3 WritingDraft 状态机

```
drafting ──→ ready_to_simulate ──→ simulated ──→ committed
   │               │                    │              │
   │               └──→ drafting ←──────┘              │
   │               (修改内容后重回)                      │
   └──→ archived ←─────────────────────────────────────┘
                                              │
                                error ←────────┘
                                
审核生命周期由 ProposalView.status 管理：
  ProposalView: open → author_approved → committed
```

关键约束：
- `drafting → committed`：❌ 禁止（必须经过 sim+review）
- `drafting → review`：❌ 禁止（必须先推演）
- `ready_to_simulate → simulated`：由 CoreBridge.simulateDraftAsEvent() 触发
- `simulated → review`：由 DraftService.createProposalFromDraft() 触发
- `simulated → committed`：由 CoreBridge.commitReviewedProposal() 成功后回写
- `review → drafting`：作者拒绝或要求修改
- `committed → *`：不可逆，修改已提交状态走 Retcon

### 5.4 WritingEntitySketch 状态机

```
hint ──→ candidate ──→ approved ──→ registered
  │         │              │             │
  │         │              │             ├──→ merged（被合并）
  │         │              │             │
  └──→ deprecated ←────────┴─────────────┘
```

- `hint`：系统发现提示，作者未确认
- `candidate`：作者确认候选，可编辑、合并
- `approved`：作者批准注册（进入注册审核）
- `registered`：CoreBridge 注册成功，已关联 coreEntityId
- `deprecated`：废弃（不删除，保留引用）
- `merged`：被合并到另一个实体
- `error`：CoreBridge 注册失败，可恢复

关键约束：
- `hint → candidate`：必须作者确认
- `candidate → registered`：❌ 禁止跳过 approved
- `registered` 只表示 EntityRecord 创建，不表示属性 Fact 已提交
- 合并（`merged`）由 EntityService 执行，不能直接写状态字段

### 5.5 WritingProposalView 状态机

```
open ──→ author_approved ──→ committed
  │              │               │
  │              ├──→ commit_failed ──→ open（修复后重试）
  │              │
  ├──→ author_rejected ──→ superseded（新版本替代）
  │
  └──→ expired（来源草案已修改）
```

- `open`：审核视图创建，展示给作者
- `author_approved`：作者点击确认，CoreBridge 准备提交
- `committed`：CoreBridge 提交成功，已关联 coreEventId
- `commit_failed`：提交失败，展示错误和修复建议
- `author_rejected`：作者拒绝，可保留为新草案起点
- `expired`：来源草案已修改，需重新推演
- `superseded`：被新 Proposal View 替代

---

## 6. 领域对象 TypeScript 类型

```ts
// src/writing/models/types.ts

import type { SourceRef } from './source-ref.js';

// =========================================================================
// Phase 7 写作层领域对象（精确类型，与 DDL 对齐）
// =========================================================================

// --- WritingProject ---
export type ProjectStatus = 'planning' | 'drafting' | 'reviewing' | 'paused' | 'archived';
export type WorkspaceMode = 'planning' | 'writing' | 'reviewing' | 'analysis' | 'importing';

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

// --- AuthorGoal ---
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

// --- IdeaCard ---
export type IdeaKind = 'premise' | 'character' | 'location' | 'faction' | 'item'
  | 'mechanism' | 'theme' | 'style' | 'reference' | 'dialogue' | 'scene_image'
  | 'event' | 'other';
export type IdeaMaturity = 'raw' | 'candidate' | 'structured' | 'ready_for_draft' | 'archived';
export type IdeaSource = 'manual' | 'chat' | 'import' | 'prose_selection' | 'agent_suggestion';
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

// --- ProjectBlueprint ---
export type BlueprintMaturity = 'implicit' | 'drafted' | 'reviewed' | 'active'
  | 'evolving' | 'archived' | 'superseded';
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

// --- WritingDraft ---
export type DraftKind = 'concept' | 'setting' | 'scene' | 'chapter' | 'act'
  | 'event' | 'prose' | 'rule' | 'thread';
export type DraftStatus = 'drafting' | 'ready_to_simulate' | 'simulated'
  | 'committed' | 'archived' | 'error';

export interface WritingDraft {
  id: string;
  projectId: string;
  kind: DraftKind;
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

// --- WritingEntitySketch ---
export type EntitySketchStatus = 'hint' | 'candidate' | 'approved'
  | 'registered' | 'deprecated' | 'merged' | 'error';

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

// --- PendingDecisionItem ---
export type DecisionKind = 'confirm_entity' | 'confirm_draft' | 'confirm_proposal'
  | 'confirm_retcon' | 'confirm_blueprint' | 'confirm_rule' | 'general';
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

// --- WritingProposalView ---
export type ProposalType = 'event' | 'entity_registration' | 'thread'
  | 'knowledge' | 'schema_extension' | 'retcon';
export type ProposalViewStatus = 'open' | 'author_approved' | 'author_rejected'
  | 'committed' | 'commit_failed' | 'expired' | 'superseded';

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

// --- WritingAuditLog ---
export type AuditTrigger = 'author_action' | 'agent_suggestion' | 'editor_cursor_feedback'
  | 'draft_conversion' | 'import_analysis' | 'review_decision' | 'system_recovery';
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

// --- CoreReference ---
export type WritingObjectType = 'project' | 'draft' | 'entity_sketch'
  | 'proposal_view' | 'blueprint' | 'idea_card' | 'pending_decision';
export type CoreObjectType = 'entity' | 'event' | 'fact' | 'thread' | 'knowledge' | 'proposal';
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

// --- WritingJob ---
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'needs_attention';
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
```

---

## 7. 服务层完整设计

### 7.0 服务架构原则

```
六大原则：

1. 服务 = 可靠代码。Agent 是 LLM，不可靠。服务层是 TypeScript，必须可靠。
   所有状态校验、副作用触发、审计记录由服务层执行，不依赖 Agent 自觉。

2. 一个入口，多种副作用。每个 Command 方法在完成主操作后自动触发：
   - 审计日志（AuditService）
   - 待确认事项（WorkflowService，当需要用户确认时）
   - Core 引用（CoreRef，当涉及 Core 对象时）
   - 过期相关审核视图（当来源对象被修改时）

3. 状态机校验在服务层，不在存储层。WritingStore 只管 CRUD，不判断
   状态跳转合法性。所有 validate*Transition 调用在服务方法入口处。

4. Core 写入只有一条路。所有 Core 写入操作必须经过 CoreBridgeService。
   没有一个服务能绕过 CoreBridge 直接调 ToolRouter 或写 Core 表。

5. 服务间依赖单向。DraftService 可以依赖 WorkflowService，
   WorkflowService 不能依赖 DraftService。不允许循环依赖。

6. 内部回写方法以 _ 开头。_markCommitted / _markRegistered 等方法
   只由 CoreBridge 在提交成功/失败后调用，Agent 和 CLI 通道不能直接调。
```

**服务依赖图**：

```
                    ┌─────────────┐
                    │ AuditService│  ← 所有服务都依赖它
                    └──────┬──────┘
                           │
  ┌────────────────────────┼────────────────────────┐
  │                        │                        │
  ▼                        ▼                        ▼
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│ProjectService│  │ IdeaService  │  │BlueprintSvc  │
│  (无其他依赖) │  │  (无其他依赖) │  │  (无其他依赖) │
└──────────────┘  └──────────────┘  └──────────────┘
                           │
  ┌────────────────────────┼────────────────────────┐
  │                        │                        │
  ▼                        ▼                        ▼
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│ DraftService │  │EntityService │  │WorkflowSvc   │
│ 依赖:        │  │ 依赖:        │  │ 依赖:        │
│ WorkflowSvc  │  │ WorkflowSvc  │  │ (仅Storage)  │
│ CoreBridge   │  │ CoreBridge   │  └──────────────┘
└──────┬───────┘  └──────┬───────┘
       │                 │
       ▼                 ▼
┌─────────────────────────────────────┐
│           CoreBridgeService         │
│  依赖: ToolRouter (Core)            │
│  回写: DraftService._markCommitted  │
│        EntityService._markRegistered│
└─────────────────────────────────────┘
```

### 7.1 通用请求上下文

```ts
// src/writing/services/context.ts

export interface WritingRequestContext {
  projectId: string;          // 当前作品项目 ID
  authorId: string;           // 当前作者标识
  sessionId: string;          // 当前写作会话 ID
  trigger: AuditTrigger;      // 触发来源（author_action / agent_suggestion / ...）
  sourceRefs: SourceRef[];    // 来源引用（谁触发了这个操作）
  requestId: string;          // 幂等和追踪 ID
  visibilityMode: 'normal' | 'debug';  // 决定 ViewModel 是否展示技术字段
}
```

---

### 7.2 ProjectService — 项目与目标管理

**依赖**：WritingStore, AuditService
**职责**：项目 CRUD、作者目标管理、工作模式切换、归档
**复杂度**：低——纯写作层状态，不接触 Core

#### createProject

```
Agent 可调用：是（LOW_RISK_WRITE）

createProject(ctx, { title, premise? }):

  前置条件:
    - title 非空字符串

  主流程:
    1. WritingStore.createProject(title, premise)
       → status='planning', workspaceMode='planning'

  副作用:
    2. AuditService.record({
         action: 'create_project', targetType: 'project',
         targetId: project.id, result: 'success'
       })

  错误路径:
    - WritingStore 写入失败 → 抛 WRITING_STORE_ERROR，不创建任何对象

  返回: WritingProject
```

#### updateAuthorGoal

```
Agent 可调用：是（LOW_RISK_WRITE）

updateAuthorGoal(ctx, { goalId?, text, kind, priority?, scope? }):

  前置条件:
    - text 非空
    - kind 合法枚举值

  主流程:
    1. 如果 goalId 存在:
       a. WritingStore.getGoal(goalId) → 检查存在
       b. WritingStore.updateGoal(goalId, updates)
    2. 如果 goalId 不存在:
       a. WritingStore.createGoal(projectId, text, kind, priority, scope, ctx.sourceRefs)

  副作用:
    3. AuditService.record({ action: 'update_goal' | 'create_goal', ... })

  错误路径:
    - goalId 存在但找不到 → WRITING_OBJECT_NOT_FOUND

  返回: AuthorGoal（新的或更新后的）
```

#### pauseAuthorGoal / archiveAuthorGoal

```
Agent 可调用：是

pauseAuthorGoal(ctx, goalId):
  1. WritingStore.getGoal(goalId) → 检查存在
  2. WritingStore.updateGoal(goalId, { status: 'paused' })
  3. AuditService.record({ action: 'pause_goal', ... })

archiveAuthorGoal(ctx, goalId):
  1. WritingStore.getGoal(goalId) → 检查存在
  2. 状态机校验: goal.status 必须是 active 或 paused
  3. WritingStore.updateGoal(goalId, { status: 'archived' })
  4. AuditService.record({ action: 'archive_goal', ... })
```

#### setWorkspaceMode

```
Agent 可调用：否（仅供 CLI/用户直接操作）

setWorkspaceMode(ctx, mode):
  1. WritingStore.getProject(projectId) → 检查存在
  2. WritingStore.updateProject(projectId, { workspaceMode: mode })
  3. AuditService.record({ action: 'set_workspace_mode', ... })
```

#### archiveProject

```
Agent 可调用：否（高风险操作）

archiveProject(ctx):
  前置条件:
    - 项目存在且 status != 'archived'
    - 所有 open PendingDecision 已解决或过期（防止丢失待确认事项）

  主流程:
    1. 检查: WorkflowService.listPendingDecisions(projectId).length === 0
       如果有未解决决策 → 抛 INVALID_STATUS_TRANSITION，附带决策列表
    2. WritingStore.softDeleteProject(projectId)
    3. AuditService.record({ action: 'archive_project', ... })

  错误路径:
    - 有未解决决策 → 返回决策列表，要求先处理
```

#### 查询方法

```
getProjectHomeView(ctx):
  1. WritingStore.getProject(projectId)
  2. WorkflowService.listPendingDecisions(projectId)  → 待确认数量
  3. DraftService.listDrafts(projectId, { limit: 5 })  → 最近草案
  4. EntityService.listCandidateQueue(projectId)         → 候选实体数
  5. 组装 ProjectHomeViewModel，应用 visibilityMode 过滤

listAuthorGoals(ctx):
  1. WritingStore.listGoals(projectId, status?)
  2. 应用 visibilityMode: 'normal' → 过滤技术字段
```

---

### 7.3 IdeaService — 灵感收集与管理

**依赖**：WritingStore, AuditService
**职责**：灵感捕捉、分类、成熟度推进、转草案/蓝图候选
**复杂度**：低——纯写作层状态，不接触 Core

#### captureIdea

```
Agent 可调用：是（LOW_RISK_WRITE）

captureIdea(ctx, { content, kind?, tags?, analysisPolicy? }):

  前置条件:
    - content 非空

  主流程:
    1. WritingStore.createIdeaCard(projectId, {
         content, kind: kind ?? 'other',
         tags: tags ?? [],
         source: ctx.trigger === 'agent_suggestion' ? 'agent_suggestion' : 'chat',
         analysisPolicy: analysisPolicy ?? 'normal',
         sourceRefs: ctx.sourceRefs
       })
       → maturity='raw'

  副作用:
    2. AuditService.record({
         action: 'capture_idea', targetType: 'idea_card',
         targetId: idea.id, result: 'success'
       })

  返回: IdeaCard
```

#### classifyIdea

```
Agent 可调用：是

classifyIdea(ctx, ideaId, { kind?, tags?, summary? }):

  前置条件:
    - idea 存在且未被删除

  主流程:
    1. WritingStore.getIdeaCard(ideaId) → 检查存在
    2. 如果 maturity === 'raw', 自动推进到 'candidate'
       （第一次分类意味着作者认为这个灵感值得保留）
    3. WritingStore.updateIdeaCard(ideaId, {
         kind, tags, summary,
         maturity: current === 'raw' ? 'candidate' : current
       })

  副作用:
    4. AuditService.record({ action: 'classify_idea', ... })

  返回: IdeaCard
```

#### promoteIdeaToDraft

```
Agent 可调用：是（CANDIDATE_WRITE — 需要作者确认意图）

promoteIdeaToDraft(ctx, ideaId, { draftKind, title? }):

  前置条件:
    - idea 存在且 maturity 为 'structured' 或 'ready_for_draft'
    - 如果 maturity 是 'raw' → 抛 INVALID_STATUS_TRANSITION（先分类再转草案）

  主流程:
    1. WritingStore.getIdeaCard(ideaId) → 检查存在 + maturity
    2. 调用 DraftService.createDraft(subCtx, {
         kind: draftKind,
         title: title ?? idea.summary,
         content: idea.content,
         sourceRefs: [{ kind: 'idea', id: ideaId, excerpt: idea.summary }]
       })
       → 创建新草案
    3. WritingStore.updateIdeaCard(ideaId, {
         linkedDraftIds: [...existing, draft.id],
         maturity: 'ready_for_draft'  // 如果还不是
       })

  副作用:
    4. AuditService.record({
         action: 'promote_idea_to_draft',
         targetType: 'idea_card', targetId: ideaId,
         detail: { draftId: draft.id }
       })

  返回: { idea: IdeaCard, draft: WritingDraft }
```

#### promoteIdeaToBlueprintCandidate

```
Agent 可调用：是（CANDIDATE_WRITE）

promoteIdeaToBlueprintCandidate(ctx, ideaId, { typeLabel, description? }):

  前置条件:
    - idea 存在

  主流程:
    1. WritingStore.getIdeaCard(ideaId) → 检查存在
    2. 获取当前活跃蓝图: WritingStore.getActiveBlueprint(projectId)
       如果无活跃蓝图 → 先 createBlueprint(projectId, { maturity: 'evolving' })
    3. 创建变更建议:
       WritingStore.updateBlueprint(bp.id, {
         changeSuggestions: [...existing, {
           id: makeId('blp_change'),
           kind: 'entity_type',  // 或根据 typeLabel 推断
           naturalLanguageSummary: `${typeLabel}: ${idea.summary ?? idea.content}`,
           reason: `来自灵感卡 ${ideaId}`,
           examples: [idea.content],
           confidence: 0.7,
           status: 'suggested',
           sourceRefs: [{ kind: 'idea', id: ideaId }]
         }]
       })

  副作用:
    4. AuditService.record({ action: 'promote_idea_to_blueprint_candidate', ... })

  返回: BlueprintChangeSuggestion
```

#### discardIdea / restoreIdea

```
discardIdea(ctx, ideaId):
  1. WritingStore.getIdeaCard(ideaId) → 检查存在
  2. WritingStore.updateIdeaCard(ideaId, { maturity: 'archived' })
  3. AuditService.record({ action: 'discard_idea', ... })

restoreIdea(ctx, ideaId):
  1. WritingStore.getIdeaCard(ideaId) → 检查存在（包括已归档的）
     注意：getIdeaCard 默认过滤 deleted_at，已归档的仍然可见（只是 maturity='archived'）
  2. 状态机校验: maturity === 'archived'
  3. WritingStore.updateIdeaCard(ideaId, { maturity: 'raw' })
  4. AuditService.record({ action: 'restore_idea', ... })
```

---

### 7.4 BlueprintService — 创作蓝图管理

**依赖**：WritingStore, AuditService
**职责**：蓝图草案生成、接受/拒绝变更、蓝图生命周期
**复杂度**：中——蓝图演化涉及多版本并存、旧蓝图 supersede

#### generateBlueprintDraft

```
Agent 可调用：是（REVIEW_CREATE — 生成后需用户确认）

generateBlueprintDraft(ctx, { naturalLanguageDescription }):

  前置条件:
    - naturalLanguageDescription 非空

  主流程:
    1. 创建新蓝图草案:
       WritingStore.createBlueprint(projectId, {
         entityTypes: [],  // 初始为空，由 Agent/LLM 后续填充
         relationTypes: [],
         maturity: 'drafted',
         sourceRefs: [...ctx.sourceRefs, {
           kind: 'chat', id: ctx.requestId,
           excerpt: naturalLanguageDescription
         }]
       })

    2. 如果已有旧 active 蓝图，不自动 supersede
       （蓝图生成是增量建议，不是强制替换）

  副作用:
    3. AuditService.record({
         action: 'generate_blueprint_draft',
         targetType: 'blueprint', targetId: bp.id
       })

  注意: 蓝图内容的实际填充（entityTypes / relationTypes）由 Agent 在后续
        proposeBlueprintChange 中完成，不在本方法内。本方法只创建容器。

  返回: ProjectBlueprint (maturity='drafted', 内容为空)
```

#### acceptBlueprintDraft

```
Agent 可调用：否（需要用户明确确认）

acceptBlueprintDraft(ctx, blueprintId):

  前置条件:
    - blueprint 存在且 maturity 为 'drafted' 或 'reviewed'

  主流程:
    1. WritingStore.getBlueprint(blueprintId) → 检查存在
    2. 状态机校验: maturity ∈ {drafted, reviewed}
    3. 找到当前 active 蓝图（如果有）:
       active = WritingStore.getActiveBlueprint(projectId)
    4. 如果有 active 蓝图:
       a. WritingStore.supersedeBlueprint(active.id, blueprintId)
          → 旧蓝图 maturity='superseded', supersededBy=blueprintId
    5. WritingStore.updateBlueprint(blueprintId, { maturity: 'active' })

  副作用:
    6. AuditService.record({ action: 'accept_blueprint', ... })

  错误路径:
    - maturity 不是 drafted/reviewed → INVALID_STATUS_TRANSITION

  返回: ProjectBlueprint (maturity='active')
```

#### proposeBlueprintChange

```
Agent 可调用：是（CANDIDATE_WRITE）

proposeBlueprintChange(ctx, suggestion):

  前置条件:
    - suggestion.naturalLanguageSummary 非空

  主流程:
    1. 获取当前 active/evolving 蓝图:
       bp = WritingStore.getActiveBlueprint(projectId)
       如果无 → 先 createBlueprint('evolving')
    2. 追加 changeSuggestion:
       WritingStore.updateBlueprint(bp.id, {
         changeSuggestions: [...existing, { ...suggestion, id: makeId('blp_change'), status: 'suggested' }],
         maturity: bp.maturity === 'active' ? 'evolving' : bp.maturity
         // active 蓝图有新建议 → 进入 evolving 状态
       })

  副作用:
    3. AuditService.record({ action: 'propose_blueprint_change', ... })

  返回: BlueprintChangeSuggestion
```

#### acceptBlueprintChange / rejectBlueprintChange

```
acceptBlueprintChange(ctx, suggestionId):

  前置条件:
    - suggestion 存在且 status 为 'suggested'

  主流程:
    1. 找到包含此 suggestion 的蓝图
    2. 更新 suggestion.status = 'accepted'
    3. 将 suggestion 中的 type 加入蓝图的 entityTypes/relationTypes
       （如果 suggestion.kind === 'entity_type' → 加入 entityTypes）
    4. WritingStore.updateBlueprint(bp.id, {
         entityTypes: [...updated],
         changeSuggestions: [...updated]
       })

  副作用:
    5. AuditService.record({ action: 'accept_blueprint_change', ... })

rejectBlueprintChange(ctx, suggestionId):
  类似，但:
    2. suggestion.status = 'dismissed'
    3-4. 不修改 entityTypes/relationTypes，只更新 changeSuggestions
```

---

### 7.5 DraftService — 草案管理与沙盒推演

**依赖**：WritingStore, AuditService, CoreBridgeService, WorkflowService
**职责**：草案 CRUD、状态流转、沙盒推演、转审核
**复杂度**：高——是主闭环的核心服务，跨 4 个依赖

#### createDraft

```
Agent 可调用：是（LOW_RISK_WRITE）

createDraft(ctx, { kind, title?, content?, sourceIdeaIds? }):

  前置条件:
    - kind 合法枚举值

  主流程:
    1. 如果 sourceIdeaIds 有值，构建 sourceRefs:
       sourceRefs = sourceIdeaIds.map(id => ({ kind: 'idea' as const, id }))
    2. WritingStore.createDraft(projectId, {
         kind, title, content: content ?? '',
         sourceRefs: [...ctx.sourceRefs, ...sourceRefs]
       })
       → status='drafting'

  副作用:
    3. AuditService.record({
         action: 'create_draft', targetType: 'draft', targetId: draft.id,
         detail: { kind, hasSourceIdeas: !!sourceIdeaIds?.length }
       })

  返回: WritingDraft
```

#### updateDraftContent

```
Agent 可调用：是（LOW_RISK_WRITE）

updateDraftContent(ctx, draftId, content):

  前置条件:
    - draft 存在且 status ∈ {drafting, ready_to_simulate, simulated}
    - draft.status 不能是 committed 或 archived

  主流程:
    1. WritingStore.getDraft(draftId) → 检查存在
    2. 状态机校验: status ∈ {drafting, ready_to_simulate, simulated}
       如果 status === 'simulated' → 草案已推演，修改后自动重置为 'drafting'
       （推演结果基于旧内容，修改后需重新推演）
    3. 检查是否有活跃的审核视图:
       activePV = WritingStore.getActiveProposalViewForDraft(draftId)
       如果存在 → WritingStore.expireProposalView(activePV.id)
       → 旧审核视图标记为 'expired'（来源草案已修改）

       同时过期关联的 PendingDecision:
       如果 activePV 存在:
         linkedDecisions = 查找 linkedObjectId === activePV.id 且 status='open' 的 PendingDecision
         对每个 linkedDecision:
           WritingStore.resolveDecision(decision.id, 'expired',
             '来源草案已修改，审核自动过期')
       → 防止 CLI 确认通道继续展示已失效的确认请求
    4. WritingStore.updateDraft(draftId, {
         content,
         status: currentStatus === 'simulated' ? 'drafting' : currentStatus
       })

  副作用:
    5. AuditService.record({ action: 'update_draft_content', ... })
    6. 如果 expired 了 ProposalView → 额外 audit: 'expire_proposal_view'

  错误路径:
    - status === 'committed' → INVALID_STATUS_TRANSITION
      "已提交的草案不能直接修改。如需变更，请使用 Retcon。"

  返回: WritingDraft（更新后）
```

#### markReadyForSimulation

```
Agent 可调用：是（REVIEW_CREATE）

markReadyForSimulation(ctx, draftId):

  前置条件:
    - draft 存在且 status === 'drafting'
    - draft.content 非空（至少 10 个字符，避免空草案推演）

  主流程:
    1. WritingStore.getDraft(draftId) → 检查存在
    2. 状态机校验: status === 'drafting'
    3. 内容校验: validateDraftSimulationReadiness(draft)
    4. WritingStore.updateDraft(draftId, { status: 'ready_to_simulate' })

  副作用:
    5. AuditService.record({ action: 'mark_draft_ready_for_simulation', ... })

  错误路径:
    - status !== 'drafting' → INVALID_STATUS_TRANSITION
    - content 为空 → DRAFT_NOT_READY_FOR_SIMULATION

  返回: WritingDraft (status='ready_to_simulate')
```

#### simulateDraft ★核心方法

```
Agent 可调用：是（REVIEW_CREATE — 推演后自动创建审核，不自动提交）

simulateDraft(ctx, draftId):

  前置条件:
    - draft 存在且 status === 'ready_to_simulate'
    - 有活跃的 CoreBridge 实例（非 mock 模式下需真实 Core）

  主流程:
    ┌─────────────────────────────────────────────────────┐
    │ 1. 获取和校验草案                                    │
    │    draft = WritingStore.getDraft(draftId)            │
    │    状态机校验: status === 'ready_to_simulate'        │
    │    内容校验: content.trim().length >= 10             │
    ├─────────────────────────────────────────────────────┤
    │ 2. 提取事件信息（从草案内容中）                       │
    │    eventDescription = draft.summary ?? draft.title   │
    │    eventType = draft.kind === 'event' ? 'custom'     │
    │               : draft.kind                           │
    │    chapter = 从 draft.sourceRefs 或默认 1            │
    │    factChanges = []  ← 此阶段不自动提取，由 Agent    │
    │      在调用前通过其他方式构建。DraftService 只负责   │
    │      将草案内容传递给 CoreBridge。                    │
    │                                                      │
    │    注意：factChanges 的构建是 Agent 的责任。          │
    │    DraftService 不做 NLP 提取。                      │
    ├─────────────────────────────────────────────────────┤
    │ 3. 调用 CoreBridge 沙盒推演                          │
    │    result = CoreBridgeService.simulateDraftAsEvent(  │
    │      ctx, {                                          │
    │        draftId,                                      │
    │        eventDescription,                             │
    │        eventType,                                    │
    │        chapter,                                      │
    │        factChanges  ← 由调用方（Agent）构建          │
    │      }                                               │
    │    )                                                 │
    │    → { proposalId, isSafeToCommit, report }          │
    │                                                      │
    │    如果 CoreBridge 抛异常:                            │
    │      → 不创建 ProposalView                           │
    │      → 不修改 draft 状态                             │
    │      → 记录审计: result='failure'                    │
    │      → 抛 WritingError(COREBRIDGE_SIMULATE_FAILED)   │
    ├─────────────────────────────────────────────────────┤
    │ 4. 更新草案状态                                      │
    │    WritingStore.updateDraft(draftId, {               │
    │      status: 'simulated'                             │
    │    })                                                │
    ├─────────────────────────────────────────────────────┤
    │ 5. 自动创建审核视图（副作用，不依赖 Agent 自觉）      │
    │    proposalView = WritingStore.createProposalView(    │
    │      projectId, {                                    │
    │        proposalType: 'event',                        │
    │        sourceDraftId: draftId                        │
    │      }                                               │
    │    )                                                 │
    │    WritingStore.updateProposalView(proposalView.id, {│
    │      coreProposalId: result.proposalId,              │
    │      coreBridgeResult: result,                       │
    │      humanSummary: eventDescription,                 │
    │      status: 'open'  // 始终创建审核（有警告也展示）        │
    │      // 即使有警告也创建审核，让作者看到警告后决定    │
    │    })                                                │
    ├─────────────────────────────────────────────────────┤
    │ 6. 自动创建待确认事项（副作用）                       │
    │    decision = WorkflowService.createPendingDecision(  │
    │      subCtx, {                                       │
    │        kind: 'confirm_proposal',                     │
    │        title: `确认提交事件: ${eventDescription}`,    │
    │        description: isSafeToCommit                   │
    │          ? '推演通过，可以提交'                       │
    │          : '推演发现警告，请查看后决定',              │
    │        linkedObjectId: proposalView.id,              │
    │        linkedObjectType: 'proposal_view'             │
    │      }                                               │
    │    )                                                 │
    ├─────────────────────────────────────────────────────┤
    │ 7. 审计                                              │
    │    AuditService.record({                             │
    │      action: 'simulate_draft',                       │
    │      targetType: 'draft', targetId: draftId,         │
    │      result: 'success',                              │
    │      detail: { proposalId: result.proposalId }       │
    │    })                                                │
    └─────────────────────────────────────────────────────┘

  副作用汇总:
    - proposalView 创建（WritingStore）
    - pendingDecision 创建（WorkflowService）
    - audit log 写入（AuditService）
    - draft 状态更新（WritingStore）

  错误路径:
    - draft 不存在 → WRITING_OBJECT_NOT_FOUND
    - status !== 'ready_to_simulate' → INVALID_STATUS_TRANSITION
    - content 为空 → DRAFT_NOT_READY_FOR_SIMULATION
    - CoreBridge 调用失败 → COREBRIDGE_SIMULATE_FAILED
      （draft 状态不变，proposalView 不创建，只记录 audit failure）

  返回: { draft: WritingDraft, proposalView: WritingProposalView }
```

#### abandonDraft

```
Agent 可调用：是

abandonDraft(ctx, draftId):

  前置条件:
    - draft 存在且 status ≠ 'committed'（已提交的不能废弃）

  主流程:
    1. WritingStore.getDraft(draftId) → 检查存在
    2. 状态机校验: status ≠ 'committed'
    3. 如果有活跃 ProposalView → expireProposalView
       同时过期关联的 PendingDecision（与 updateDraftContent 一致）
    4. WritingStore.updateDraft(draftId, { status: 'archived' })

  副作用:
    5. AuditService.record({ action: 'abandon_draft', ... })

  错误路径:
    - status === 'committed' → INVALID_STATUS_TRANSITION
      "已提交的草案不能废弃。如需修改，请使用 Retcon 通道。"

  返回: void
```

#### _markCommitted / _markCommitFailed

```
内部方法（CoreBridge 专用，Agent 禁止调用）:

_markCommitted(draftId, coreEventId):
  1. WritingStore.updateDraft(draftId, { status: 'committed' })
  2. 不写审计（由 CoreBridge 统一写审计）

_markCommitFailed(draftId, error):
  1. WritingStore.updateDraft(draftId, { status: 'error' })
  2. 不写审计（由 CoreBridge 统一写审计）
```

---

### 7.6 EntityService — 实体发现与管理

**依赖**：WritingStore, AuditService, CoreBridgeService, WorkflowService
**职责**：实体发现提示、候选确认、注册审核、合并去重
**复杂度**：中——涉及 Core 注册、重复检测、状态流转

#### detectEntityHints

```
Agent 可调用：是（READ_QUERY — 虽然是写入 hint，但来自文本分析）

detectEntityHints(ctx, text):

  前置条件:
    - text 非空字符串

  主流程:
    1. 对 text 进行实体发现（Phase 7 最简实现：基于规则的正则匹配 + Blueprint 类型提示）
       注意：这不是 NLP 服务。实际实现中由 Agent 在 ReAct 循环中提取，
       EntityService 只负责保存。此方法接收已提取的实体列表。

       更准确的职责描述：此方法接收 Agent 已经提取好的实体名称和类型，
       创建 WritingEntitySketch(status='hint')。

       参数应为:
         hints: Array<{ displayName: string; typeLabel: string; excerpt?: string }>

    2. 逐个创建 hint:
       WritingStore.createEntitySketch(projectId, {
         displayName: hint.displayName,
         typeLabel: hint.typeLabel,
         status: 'hint',
         sourceRefs: [{ kind: 'chat', id: ctx.requestId, excerpt: hint.excerpt }]
       })

    3. 查重检测（可选，轻量）:
       对每个 hint，检查 WritingStore.findEntitySketchesByName(name)
       如果已有同名实体（candidate/approved/registered）:
         → 该 hint 的状态保持 'hint'，但在返回值中标记为 'duplicate_suspected'

  副作用:
    4. AuditService.record({
         action: 'detect_entity_hints',
         detail: { count: hints.length }
       })
       （不逐个记录，太多噪音）

  返回: WritingEntitySketch[] (全部 status='hint')
```

#### promoteHintToSketch

```
Agent 可调用：是（CANDIDATE_WRITE — 需要作者确认）

promoteHintToSketch(ctx, hintId, { displayName, typeLabel }):

  前置条件:
    - hint 存在且 status === 'hint'

  主流程:
    1. WritingStore.getEntitySketch(hintId) → 检查存在
    2. 状态机校验: validateEntitySketchTransition('hint', 'candidate', hintId)
    3. 重名检测:
       duplicates = WritingStore.findEntitySketchesByName(projectId, displayName)
       如果 duplicates.length > 1（排除自身）:
         → 记录到 audit，但不阻止（由作者决定是否合并）
    4. WritingStore.updateEntitySketch(hintId, {
         displayName, typeLabel, status: 'candidate'
       })

  副作用:
    5. AuditService.record({
         action: 'promote_hint_to_candidate',
         targetType: 'entity_sketch', targetId: hintId,
         detail: { displayName, hasDuplicates: duplicates.length > 1 }
       })

  错误路径:
    - status !== 'hint' → INVALID_STATUS_TRANSITION
    - 如果已经是 candidate → 抛错（不能重复 promote）

  返回: WritingEntitySketch (status='candidate')
```

#### approveCandidate

```
Agent 可调用：是（CANDIDATE_WRITE）

approveCandidate(ctx, sketchId):

  前置条件:
    - sketch 存在且 status === 'candidate'
    - sketch.typeLabel 已映射到 Core EntityKind（或留空使用默认 'entity'）

  主流程:
    1. WritingStore.getEntitySketch(sketchId) → 检查存在
    2. 状态机校验: validateEntitySketchTransition('candidate', 'approved', sketchId)
    3. WritingStore.updateEntitySketch(sketchId, { status: 'approved' })
    4. 自动创建待确认事项:
       WorkflowService.createPendingDecision(subCtx, {
         kind: 'confirm_entity',
         title: `确认登记实体: ${sketch.displayName}`,
         description: `将 "${sketch.displayName}" 登记为正式设定对象`,
         linkedObjectId: sketchId,
         linkedObjectType: 'entity_sketch'
       })

  副作用:
    5. AuditService.record({
         action: 'approve_entity_candidate',
         targetType: 'entity_sketch', targetId: sketchId
       })

  错误路径:
    - status !== 'candidate' → INVALID_STATUS_TRANSITION
    - typeLabel 未映射 → 不阻止，使用默认 'entity' 作为 coreKind

  返回: WritingEntitySketch (status='approved')
```

#### deprecateEntitySketch

```
Agent 可调用：是（LOW_RISK_WRITE）

deprecateEntitySketch(ctx, sketchId, reason?):

  前置条件:
    - sketch 存在且 status ∈ {hint, candidate, approved}
    - 已注册的实体（status='registered'）不能通过此方法废弃
      （已注册实体修改需走 Retcon）

  主流程:
    1. WritingStore.getEntitySketch(sketchId) → 检查存在
    2. 状态机校验: status ∈ {hint, candidate, approved}
       （禁止从 registered 直接到 deprecated — 已注册实体需 Retcon）
    3. WritingStore.updateEntitySketch(sketchId, { status: 'deprecated' })
    4. 如果此实体有活跃的审核视图:
       找到并 expire 关联的 ProposalView + PendingDecision

  副作用:
    5. AuditService.record({
         action: 'deprecate_entity',
         targetType: 'entity_sketch', targetId: sketchId,
         detail: { reason }
       })

  错误路径:
    - status === 'registered' → INVALID_STATUS_TRANSITION
      "已注册实体不能直接废弃。如需修改，请使用 Retcon 通道。"
    - status === 'merged' → INVALID_STATUS_TRANSITION（终态）

  返回: void
```

#### mergeSketches

```
Agent 可调用：是（CANDIDATE_WRITE）

mergeSketches(ctx, sourceId, targetId):

  前置条件:
    - source 和 target 都存在
    - source.status ∈ {hint, candidate}（已注册的不能合并）
    - source !== target

  主流程:
    1. source = WritingStore.getEntitySketch(sourceId) → 检查存在
    2. target = WritingStore.getEntitySketch(targetId) → 检查存在
    3. 状态机校验: source.status ∈ {hint, candidate}
       （已注册实体合并必须走 Retcon，不能通过写作层 merge）
    4. 合并 source 的 aliases 到 target:
       mergedAliases = [...target.aliases, source.displayName, ...source.aliases]
    5. WritingStore.updateEntitySketch(targetId, { aliases: mergedAliases })
    6. WritingStore.mergeEntitySketches(sourceId, targetId)
       → source.status = 'merged'

  副作用:
    7. AuditService.record({
         action: 'merge_entities',
         detail: { sourceId, targetId }
       })

  返回: void
```

#### _markRegistered / _markRegistrationFailed

```
内部方法（CoreBridge 专用）:

_markRegistered(sketchId, coreEntityId, coreKind):
  1. WritingStore.updateEntitySketch(sketchId, {
       status: 'registered', coreEntityId, coreKind
     })

_markRegistrationFailed(sketchId, error):
  1. WritingStore.updateEntitySketch(sketchId, { status: 'error' })
```

---

### 7.7 CoreBridgeService — Core 写入唯一通道

**依赖**：WritingStore, AuditService, ToolRouter (Core), DraftService, EntityService
**职责**：所有 Core 交互的唯一出口。推演/提交/注册/错误解释。
**复杂度**：高——写作层和 Core 的边界守门人。

**访问控制**：

| 方法 | Agent 可调 | CLI 通道可调 | 触发条件 |
|------|:--:|:--:|------|
| simulateDraftAsEvent | ✅ | ✅ | 无限制 |
| simulateProposal | ✅ | ✅ | 无限制 |
| readCurrentWorldSnapshot | ✅ | ✅ | 无限制 |
| explainCoreFailure | ✅ | ✅ | 无限制 |
| commitReviewedProposal | ❌ | ✅ | ProposalView.status === 'author_approved' |
| registerReviewedEntity | ❌ | ✅ | EntitySketch.status === 'approved' |
| commitReviewedThreadChange | ❌ | ✅ | 同 commitReviewedProposal |
| commitReviewedKnowledgeChange | ❌ | ✅ | 同 commitReviewedProposal |
| commitReviewedWorldPackageChange | ❌ | ✅ | 同 commitReviewedProposal |

#### simulateDraftAsEvent ★核心方法

```
Agent 可调用：是

simulateDraftAsEvent(ctx, { draftId, eventDescription, eventType, chapter, factChanges }):

  前置条件:
    - Core 连接可用
    - factChanges 格式合法（至少一条，或明确为空数组）

  主流程:
    1. 调用 Core ToolRouter:
       result = toolRouter.handle('propose_event', {
         event_type: eventType,
         event_description: eventDescription,
         chapter,
         fact_changes: factChanges,
         context: 'global'  // Phase 7 默认 global 作用域
       })

    2. 解析 Core 返回:
       proposalId = result.proposal_id
       isSafeToCommit = result.is_safe_to_commit
       report = result.simulation_report_markdown

    3. 返回: { proposalId, isSafeToCommit, report }

  错误路径:
    - Core 连接失败 → 抛异常，由 DraftService.simulateDraft 捕获
    - factChanges 格式错误 → Core 返回 SCHEMA_VALIDATION_FAILED
    - 约束冲突 → isSafeToCommit = false（不是异常，正常返回）

  返回: { proposalId: string, isSafeToCommit: boolean, report: string }
```

#### commitReviewedProposal ★核心方法

```
Agent 可调用：禁止（COMMIT_FORBIDDEN）
调用者：CLI 确认通道、Proposal Review 流程

commitReviewedProposal(ctx, proposalViewId):

  前置条件:
    - proposalView 存在且 status === 'author_approved'
    - 来源草案未被修改（validateCommitReadiness）
    - proposalView.coreProposalId 存在（必须有推演结果）

  主流程:
    ┌─────────────────────────────────────────────────────┐
    │ 1. 加载和校验审核视图                                │
    │    pv = WritingStore.getProposalView(proposalViewId) │
    │    if !pv → WRITING_OBJECT_NOT_FOUND                 │
    │    if pv.status !== 'author_approved' →              │
    │      PROPOSAL_NOT_IN_REVIEW                          │
    ├─────────────────────────────────────────────────────┤
    │ 2. 校验来源对象有效性                                │
    │    if pv.sourceDraftId:                              │
    │      draft = WritingStore.getDraft(pv.sourceDraftId) │
    │      readiness = validateCommitReadiness(pv, draft)  │
    │      if !readiness.valid → 抛错 + 详细原因           │
    │    if pv.sourceEntitySketchId:                       │
    │      sketch = WritingStore.getEntitySketch(...)      │
    │      类似检查                                        │
    ├─────────────────────────────────────────────────────┤
    │ 3. 调用 Core 正式提交                                │
    │    result = toolRouter.handle('commit_event', {      │
    │      proposal_id: pv.coreProposalId                  │
    │    })                                                │
    │                                                      │
    │    如果 Core 返回失败:                                │
    │      → 不更新 ProposalView 为 committed              │
    │      → 进入错误路径（见下方）                         │
    ├─────────────────────────────────────────────────────┤
    │ 4. Core 成功 → 回写写作层                            │
    │    a. WritingStore.updateProposalView(pv.id, {       │
    │         status: 'committed',                         │
    │         coreEventId: result.committed_event_id       │
    │       })                                             │
    │    b. 创建 Core 引用:                                │
    │       WritingStore.createCoreRef(projectId, {        │
    │         writingObjectType: 'proposal_view',          │
    │         writingObjectId: pv.id,                      │
    │         coreObjectType: 'event',                     │
    │         coreObjectId: result.committed_event_id      │
    │       })                                             │
    │    c. 回写来源草案:                                  │
    │       if pv.sourceDraftId:                           │
    │         DraftService._markCommitted(                 │
    │           pv.sourceDraftId, result.committed_event_id│
    │         )                                            │
    │       注意: entity_registration 类型的提案不通过      │
    │       commitReviewedProposal 提交，而是通过           │
    │       registerReviewedEntity 独立通道。               │
    │       sourceEntitySketchId 字段仅用于溯源，           │
    │       不作为提交目标。                                │
    │    d. 审计:                                          │
    │       AuditService.record({                          │
    │         action: 'commit_proposal',                   │
    │         targetType: 'proposal_view',                 │
    │         targetId: pv.id,                             │
    │         result: 'success',                           │
    │         detail: { coreEventId: result... }           │
    │       })                                             │
    └─────────────────────────────────────────────────────┘

  错误路径:
    - Core 返回失败:
      5a. WritingStore.updateProposalView(pv.id, {
            status: 'commit_failed',
            commitError: result.error
          })
      5b. AuditService.record({
            action: 'commit_proposal',
            result: 'failure',
            errorCode: result.error?.code
          })
      5c. 返回 { success: false, error: explainCoreFailure(result.error) }

    - 回写失败（Core 已成功但写作层保存失败）:
      严重问题。Core 已经写入，但写作层不知道。
      → 记录 audit: result='partial', 标记为需要恢复
      → 返回 { success: true, coreEventId, 但附带回写警告 }
      → 后续对账任务修复 writing_core_refs 和 draft 状态

  返回: { success, coreEventId?, error? }
```

#### registerReviewedEntity ★核心方法

```
Agent 可调用：禁止（COMMIT_FORBIDDEN）
调用者：CLI 确认通道

registerReviewedEntity(ctx, sketchId):

  前置条件:
    - sketch 存在且 status === 'approved'
    - sketch.typeLabel 非空

  主流程:
    1. WritingStore.getEntitySketch(sketchId) → 检查存在
    2. 状态机校验: status === 'approved'
    3. 构建 Core entity 参数:
       entityName = sketch.displayName

       // 解析 entityKind——按优先级：sketch 已有 coreKind > Blueprint 映射 > 硬编码映射
       entityKind = sketch.coreKind
       if (!entityKind) {
         const blueprint = WritingStore.getActiveBlueprint(projectId)
         const typeDef = blueprint?.entityTypes.find(t => t.label === sketch.typeLabel)
         if (typeDef?.coreMapping && typeDef.coreMapping.confidence >= 0.5) {
           entityKind = typeDef.coreMapping.entityKind
         }
       }
       if (!entityKind) {
         entityKind = mapTypeLabelToEntityKind(sketch.typeLabel)
         // 硬编码兜底映射: '角色'→'character', '地点'→'place', '组织'→'faction',
         //                   '物品'→'item', '异常现象'→'spatial_domain', 其他→'entity'
       }
       // 如果 Blueprint 有映射但置信度 < 0.5：
       //   → 仍然使用兜底映射，但记录 BLUEPRINT_MAPPING_LOW_CONFIDENCE 警告到 audit
    4. 调用 Core:
       result = toolRouter.handle('register_entity', {
         name: entityName,
         kind: entityKind,
         description: sketch.summary,
         chapter: 1  // Phase 7 默认
       })
    5. Core 成功:
       a. EntityService._markRegistered(sketchId, result.entity_id, entityKind)
       b. WritingStore.createCoreRef(projectId, {
            writingObjectType: 'entity_sketch',
            writingObjectId: sketchId,
            coreObjectType: 'entity',
            coreObjectId: result.entity_id
          })
       c. AuditService.record({ action: 'register_entity', ... })

  错误路径:
    - Core 注册失败（重名等）→ 返回 { success: false, error: explainCoreFailure(...) }
    - status !== 'approved' → INVALID_STATUS_TRANSITION

  返回: { success, coreEntityId?, coreKind?, error? }
```

#### readCurrentWorldSnapshot

```
Agent 可调用：是（只读）

readCurrentWorldSnapshot(ctx):

  主流程:
    1. 调用 Core get_context_slice (无具体 entity_id，获取全局快照)
       或通过 Core 提供的最小快照接口获取
    2. 组装 WorldSnapshotViewModel（人话版）
    3. 应用 visibilityMode 过滤

  返回: WorldSnapshotViewModel
```

#### explainCoreFailure

```
Agent 可调用：是（只读）

explainCoreFailure(error: ToolError):

  主流程:
    1. 将 Core ToolErrorCode 映射到人话消息
       (复用 Core 的错误码 → 人话映射，或写作层补充映射)
    2. 构建 CoreErrorExplanation:
       - errorCode: 原始 Core 错误码
       - humanMessage: 自然语言解释
       - suggestedActions: 可执行的修复方向
       - isRecoverable: 是否可以重试

  返回: CoreErrorExplanation
```

---

### 7.8 WorkflowService — 待确认事项与决策管理

**依赖**：WritingStore, AuditService
**职责**：创建/解决待确认事项、决策历史查询
**复杂度**：低——纯写作层状态

#### createPendingDecision

```
Agent 可调用：是（LOW_RISK_WRITE）

createPendingDecision(ctx, { kind, title, description?, linkedObjectId?, linkedObjectType? }):

  主流程:
    1. WritingStore.createDecision(projectId, {
         kind, title, description,
         linkedObjectId, linkedObjectType,
         sourceRefs: ctx.sourceRefs
       })
       → status='open'

  副作用:
    2. AuditService.record({
         action: 'create_pending_decision',
         targetType: 'pending_decision', targetId: decision.id,
         detail: { kind, linkedObjectId }
       })

  注意: 不检查 duplicate——同一草案可以有多个决策
        （如：确认实体 + 确认提案同时存在）

  返回: PendingDecisionItem
```

#### resolvePendingDecision

```
Agent 可调用：否（CLI 确认通道专用）
调用者：CLI 确认通道（handlePendingDecisions 短路逻辑）

resolvePendingDecision(ctx, decisionId, { status, note? }):

  前置条件:
    - decision 存在且 status === 'open'
    - resolution status 为 'resolved'、'dismissed' 或 'expired'

  主流程:
    1. WritingStore.getDecision(decisionId) → 检查存在
    2. 状态机校验: decision.status === 'open'
    3. WritingStore.resolveDecision(decisionId, status, note)

  副作用:
    4. AuditService.record({
         action: status === 'resolved' ? 'resolve_decision' : 'dismiss_decision',
         targetType: 'pending_decision', targetId: decisionId,
         result: 'success',
         detail: { resolution: status, note }
       })

  错误路径:
    - decision 不存在 → WRITING_OBJECT_NOT_FOUND
    - status !== 'open' → INVALID_STATUS_TRANSITION
      "此决策已被处理，无需重复操作"

  返回: PendingDecisionItem（已更新）
```

#### 查询方法

```
listPendingDecisions(ctx):
  1. WritingStore.listPendingDecisions(projectId)
     → 只返回 status='open' 的
  2. 按 created_at 升序（最早的优先处理）

getDecisionHistory(ctx):
  1. WritingStore 查询所有 decision（不限 status）
  2. 按 resolved_at 降序
```

---

### 7.9 AuditService — 操作审计

**依赖**：WritingStore
**职责**：记录所有写作层关键操作
**复杂度**：低——纯写入，无复杂逻辑

#### record

```
record(ctx, { action, targetType?, targetId?, result, detail?, errorCode? }):

  主流程:
    1. WritingStore.recordAudit({
         projectId: ctx.projectId,
         action,
         targetType: targetType ?? undefined,
         targetId: targetId ?? undefined,
         triggerSource: ctx.trigger,
         result: result ?? 'success',
         detail: detail ?? {},
         errorCode: errorCode ?? undefined,
         requestId: ctx.requestId,
         sessionId: ctx.sessionId
       })

  注意: 此方法不应抛异常。即使审计写入失败，也不应阻断主流程。
        (catch → 写 stderr 警告，不抛)

  返回: WritingAuditLog
```

#### query

```
query(ctx, { action?, targetType?, targetId?, limit? }):

  主流程:
    1. WritingStore.queryAuditLogs(projectId, { action, targetType, targetId, limit })

  返回: WritingAuditLog[]
```

---

### 7.10 服务间协作时序图

```
Agent.processUserInput("确认提交")
  │
  ▼
CLI 确认通道: handlePendingDecisions("确认提交")
  │
  ├─ WorkflowService.listPendingDecisions(projectId)
  │   → [{ kind: 'confirm_proposal', linkedObjectId: 'wpvw_xxx' }]
  │
  ├─ isConfirmIntent("确认提交") → true
  │
  ├─ WorkflowService.resolvePendingDecision(decisionId, 'resolved')
  │   → AuditService.record('resolve_decision')
  │
  ├─ CoreBridgeService.commitReviewedProposal(ctx, 'wpvw_xxx')
  │   │
  │   ├─ WritingStore.getProposalView('wpvw_xxx')
  │   ├─ validateCommitReadiness(pv, draft)
  │   ├─ toolRouter.handle('commit_event', { proposal_id: 'xxx' })
  │   │   └─ Core 写入 Fact/Event/Knowledge/Thread
  │   ├─ WritingStore.updateProposalView('wpvw_xxx', { status: 'committed', coreEventId: 'evt_xxx' })
  │   ├─ WritingStore.createCoreRef(..., 'event', 'evt_xxx')
  │   ├─ DraftService._markCommitted(draftId, 'evt_xxx')
  │   │   └─ WritingStore.updateDraft(draftId, { status: 'committed' })
  │   ├─ AuditService.record('commit_proposal', 'success')
  │   └─ 返回 { success: true, coreEventId: 'evt_xxx' }
  │
  └─ 返回 AgentTurnResult: "✅ 已写入世界状态。事件 ID: evt_xxx"
```

---

### 7.11 已知设计边界与恢复路径

#### 7.11.1 软删除级联

`archiveProject` 必须级联软删除所有子表记录（audit_logs 除外）：
- 所有 `writing_*` 子表执行 `UPDATE SET deleted_at = datetime('now') WHERE project_id = ? AND deleted_at IS NULL`
- `writing_audit_logs` 不级联——审计记录永久保留
- 外键 `FOREIGN KEY (project_id) REFERENCES writing_projects(id)` 仅为逻辑约束，SQLite 不自动级联

#### 7.11.2 commit_failed 恢复路径

`ProposalView.status === 'commit_failed'` 时有两种恢复方式：

**路径 A（推荐——重新推演）**：
1. 作者修改草案内容
2. `updateDraftContent` 自动 expire 旧的 ProposalView（含关联 PendingDecision）
3. 重新 `markReadyForSimulation` → `simulateDraft` → 新 ProposalView
4. 旧 ProposalView 通过 `superseded` 与新 ProposalView 关联

**路径 B（直接重试——仅适用临时错误）**：
1. 确认 Core 错误已修复（如网络恢复、临时锁释放）
2. 手动将 `commit_failed` 重置为 `open`
3. 重新走 CLI 确认通道 → `author_approved` → `commitReviewedProposal`
4. Phase 7 不实现自动重试（防止死循环）

#### 7.11.3 knowledge/schema_extension/retcon 提交通道

Phase 7 只实现 `event` 和 `entity_registration` 两种提案类型的完整闭环。
`knowledge`、`schema_extension`、`retcon` 的提交通过独立通道：

| 提案类型 | 提交方法 | 写回目标 | Phase 7 实现 |
|---------|---------|---------|:--:|
| event | commitReviewedProposal | DraftService._markCommitted | ✅ |
| entity_registration | registerReviewedEntity | EntityService._markRegistered | ✅ |
| thread | commitReviewedThreadChange | (Phase 8) | ❌ |
| knowledge | commitReviewedKnowledgeChange | (Phase 8) | ❌ |
| schema_extension | commitReviewedWorldPackageChange | (Phase 8) | ❌ |
| retcon | Retcon 独立通道 | (Phase 8) | ❌ |

#### 7.11.4 simulateDraft 部分失败的恢复

如果 `simulateDraft` 在步骤 4（更新 draft.status）之后、步骤 5/6（创建 ProposalView/PendingDecision）之前失败：

- draft 状态为 `simulated` 但无对应的 ProposalView
- 再次调 `simulateDraft` 会因为 `status !== 'ready_to_simulate'` 被拒绝
- **恢复**：手动将 draft.status 重置为 `drafting`，然后重新走 `markReadyForSimulation` → `simulateDraft`

Phase 7 不实现自动回滚（SQLite SAVEPOINT 可选，但不强制）。服务实现时可将步骤 4-6 包裹在 try-catch 中，失败时回滚 draft 状态。

#### 7.11.5 两阶段提交恢复机制

`commitReviewedProposal` 先写 Core 再回写写作层，两个写入不在同一事务中：

```
Core 成功 + WritingStore 成功  → 正常
Core 成功 + WritingStore 失败  → 不一致（Core 有但写作层不知道）
Core 失败 + WritingStore 未执行 → 正常（commit_failed 路径）
```

恢复策略（Phase 7）：
1. 构造时运行 `reconcileCommittedProposals()`：
   - 遍历 `writing_proposal_views` 中 `status='author_approved'` 的记录
   - 对每条记录，检查 Core 侧 proposal 是否已被提交：
     调用 Core 查询接口（get_context_slice / 查询相关 event）
     如果 Core 已有对应 event → 回写 `status='committed'`
     如果 Core 无记录且 proposal 已过期 → 回写 `status='commit_failed'`
2. 此方法在 Agent/NarrativeAgent 初始化时调用，不阻塞正常流程
3. Phase 7 不实现完整的对账后台任务（后续 Phase 8）

#### 7.11.6 提案跨会话生命周期

Core 的 ProposalStore 是纯内存 Map（架构文档 §4.3.2）。进程重启后所有 proposal 丢失。

**问题**：用户前一天推演生成 proposal，第二天确认提交。WritingStore 中的 ProposalView 仍然存在（status='author_approved'），但 Core 端的 proposal 已不存在。

**缓解措施**：
- `commitReviewedProposal` 调用 Core commit_event 时，
  如果 Core 返回 PROPOSAL_NOT_FOUND 错误 → 自动将 ProposalView 标记为 `expired`
  并向用户说明需要重新推演
- `validateCommitReadiness` 不预先验证 Core 侧有效性（避免额外的 Core 查询开销）
- Phase 8 可选：定期延迟任务检查 proposal 有效性

#### 7.11.7 PendingDecision 选择机制

当存在多个 open PendingDecision 时，用户可能需要选择处理哪一个：

- `handlePendingDecisions` 默认处理 `decisions[0]`（最早创建的）
- 如果 `decisions[0]` 关联的 ProposalView 已过期/失效：
  → 自动将该决策标记为 `expired`，然后处理下一个
- 用户可通过指定决策标题来精确选择：
  "确认 登记实体" → 匹配 kind='confirm_entity' 的决策
  "确认 事件提案" → 匹配 kind='confirm_proposal' 的决策

#### 7.11.8 实体名称唯一性

`writing_entity_sketches` 不强制 `UNIQUE(project_id, display_name)`——因为用户可能用同一名称创建多个不同阶段的候选（hint 和 candidate 可共存）。

但 `registered` 状态的实体必须唯一。由 `EntityService.approveCandidate` 在注册前检查：
```ts
const existing = WritingStore.findEntitySketchesByName(projectId, displayName)
  .filter(s => s.status === 'registered');
if (existing.length > 0) → 创建 duplicate_warning，不阻止但告知用户
```

Core 端的 `register_entity` 由 Core 自己保证名称唯一性（如果 Core 拒绝重名，写作层收到错误并展示）。

#### 7.11.9 实体列表分页（Agent 上下文控制）

当已注册实体超过 30 个时，`findRegisteredEntities` 返回完整列表会导致 Agent 上下文膨胀。

Phase 7 策略：
- `findRegisteredEntities` 默认不限制，但调用方（Agent 上下文组装）自行截断
- Agent 上下文组装时：最近使用的 10 个实体 + 当前草案涉及的实体 + 模糊匹配 top 5
- 设计意图：不在存储层硬编码分页，由上下文策略层控制

#### 7.11.5（原）实体注册的审核视图

实体注册有两种路径进入 Core：

**路径 A：通过提案（ProposalView + PendingDecision）**：
- `EntityService.approveCandidate` → 创建 `PendingDecision(kind='confirm_entity')`
- CLI 确认通道处理 → `CoreBridge.registerReviewedEntity` → 写回 `registered`

**路径 B：直接注册（测试/脚本场景）**：
- 跳过 PendingDecision，直接调 `CoreBridge.registerReviewedEntity`
- 仅允许 CLI 通道调用，Agent 禁止

---

## 8. NarrativeAgent 改造方案

### 8.0 核心原则：commit 不消失，换调用者

```
Phase 6（当前）：
  Agent → propose_event → Agent → commit_event → Core

Phase 7（目标）：
  Agent → CoreBridge.simulateDraftAsEvent (propose_event)
       → 创建 PendingDecision + ProposalReview
       → CLI 确认通道："是否确认提交？"
       → 用户确认
       → CoreBridge.commitReviewedProposal → commit_event → Core
```

commit_event 本身还在，Core 不变。变化的是**谁在什么条件下调用它**。

Agent 只管"推演 + 展示 + 引导确认"，提交动作永远从 Proposal Review 通道发。

### 8.1 改造三步走

```
Step A（同时做）：
  1. Agent 移除 commit_event 直接调用路径
  2. Agent 推演成功 → 自动创建 PendingDecisionItem + ProposalReview
  3. 实现 CLI 确认通道 → 用户说"确认" → CoreBridge.commitReviewedProposal

Step B（随后做）：
  4. Agent 的 propose_event 调用改为走 CoreBridge.simulateDraftAsEvent
  5. Agent 的 workingDraft 与 WritingDraft 对齐
  6. 系统提示词注入写作层状态摘要

Step C（收尾）：
  7. Agent 工具权限分级（AgentCapability）
  8. 写作层状态注入 Push 检索
  9. 长期记忆延伸到写作层决策
```

Step A 是最小闭环——做完就能跑通"推演→确认→提交"的完整流程。

### 8.2 Step A 详细设计

#### 8.2.1 Agent 中 commit_event 的移除路径

当前 `narrative-agent.ts` 中 `commit_event` 出现在以下位置：

| 位置 | 当前行为 | Step A 改造 |
|------|---------|-----------|
| `handleToolCall` 路由 | 允许 LLM 发起 `commit_event` tool call | LLM 仍可发起（保持 tool call 协议兼容），但返回 `AGENT_COMMIT_FORBIDDEN` 错误 |
| `handleToolSuccess` 中 commit_event 分支 | 清理 pendingProposalIds | 删除此分支 |
| `DEFAULT_SYSTEM_PROMPT` | 提及 commit_event 可用 | 改为："提交到世界状态需要使用 Proposal Review 通道，你不能直接调用 commit_event" |
| `processUserInput` 中 confirmKeywords 检测 | 识别"确认提交" → 自动 commit | 改为：识别"确认提交" → 查找当前 PendingDecision → 调 resolvePendingDecision → CoreBridge.commitReviewedProposal |

#### 8.2.2 Agent 推演后自动创建审核

Agent 调用 `propose_event` 成功后（proposal_id 返回），自动执行：

```
1. DraftService.createProposalFromDraft(draftId)
   → 创建 WritingProposalView (status='open', coreProposalId=proposal_id)

2. WorkflowService.createPendingDecision({
     kind: 'confirm_proposal',
     title: '确认提交事件提案',
     description: humanSummary,
     linkedObjectId: proposalView.id,
     linkedObjectType: 'proposal_view'
   })

3. Agent 回复用户时展示：
   "推演完成。以下是将写入世界状态的变化：
    ＋沈笙 位置 = 废弃站台
    ＋黑晶碎片 状态 = 激活
    是否确认提交？"
```

#### 8.2.3 CLI 确认通道

CLI 确认通道是一个独立于 Agent ReAct 循环的决策处理层。它监听用户输入，当存在 `open` 状态的 `PendingDecisionItem` 时，优先检查用户输入是否为确认/拒绝。

```
用户输入 → CLI 确认通道（优先拦截）
            │
            ├─ 存在 open PendingDecision + 用户说"确认"/"提交"
            │    → ProposalView.status = 'author_approved'  ← 关键步骤
            │    → resolvePendingDecision('resolved')
            │    → CoreBridge.commitReviewedProposal
            │    → 展示结果："✅ 已写入世界状态"
            │    → 不进入 Agent ReAct 循环
            │
            ├─ 存在 open PendingDecision + 用户说"拒绝"/"取消"/"修改"
            │    → ProposalView.status = 'author_rejected'
            │    → resolvePendingDecision('dismissed')
            │    → 通知 Agent 重新进入草案修改
            │
            └─ 不存在 open PendingDecision 或是普通对话
                 → 正常进入 Agent ReAct 循环
```

**CLI 确认通道不是一个前端页面，而是一个中间件**——它在 Agent 的 `processUserInput` 入口处做短路判断。当有等待中的决策时，优先处理决策而非启动新的 Agent 推理。

实现位置：在 `NarrativeAgent.processUserInput()` 内部最前面插入 `await this.handlePendingDecisions(userInput)`。

```ts
// narrative-agent.ts 中新增
private async handlePendingDecisions(userInput: string): Promise<AgentTurnResult | null> {
  // 查询当前项目的 open 决策
  const decisions = await this.workflowService.listPendingDecisions(ctx);
  if (decisions.length === 0) return null; // 无待处理决策，走正常流程

  const decision = decisions[0]!; // 先处理最早的

  // 确认识别
  if (this.isConfirmIntent(userInput)) {
    if (decision.kind === 'confirm_proposal' && decision.linkedObjectId) {
      // 1. 先从 open 转为 author_approved（状态机要求）
      const pv = await this.writingStore.getProposalView(decision.linkedObjectId);
      if (!pv || pv.status !== 'open') {
        return { status: 'failed', responseText: '该提案已过期或已被处理。' };
      }
      await this.writingStore.updateProposalView(decision.linkedObjectId, {
        status: 'author_approved',
        authorDecision: '确认提交',
        authorDecisionAt: new Date().toISOString(),
      });

      // 2. 提交到 Core
      const result = await this.coreBridge.commitReviewedProposal(ctx, decision.linkedObjectId);

      // 3. 解决决策
      await this.workflowService.resolvePendingDecision(ctx, decision.id, {
        status: 'resolved',
        note: `作者确认提交，coreEventId=${result.coreEventId}`
      });

      // 4. 审计
      await this.auditService.record(ctx, {
        action: 'commit_proposal',
        targetType: 'proposal_view',
        targetId: decision.linkedObjectId,
        result: result.success ? 'success' : 'failure',
      });

      return {
        status: result.success ? 'completed' : 'failed',
        responseText: result.success
          ? `✅ 已写入世界状态。事件 ID：${result.coreEventId}`
          : `❌ 提交失败：${result.error?.humanMessage}`,
      };
    }
    if (decision.kind === 'confirm_entity' && decision.linkedObjectId) {
      // 实体注册：先确认 → 再注册
      await this.writingStore.updateEntitySketch(decision.linkedObjectId, {
        status: 'approved',
      });
      const result = await this.coreBridge.registerReviewedEntity(ctx, decision.linkedObjectId);
      await this.workflowService.resolvePendingDecision(ctx, decision.id, {
        status: 'resolved',
        note: result.success
          ? `作者确认注册，coreEntityId=${result.coreEntityId}`
          : `注册失败：${result.error?.humanMessage}`
      });
      return {
        status: result.success ? 'completed' : 'failed',
        responseText: result.success
          ? `✅ ${result.coreEntityId} 已登记为正式实体。`
          : `❌ 注册失败：${result.error?.humanMessage}`,
      };
    }
    // ... 其他决策类型（蓝图确认等）
  }

  // 拒绝/修改意图
  if (this.isReviseIntent(userInput)) {
    // 更新 ProposalView 为 author_rejected
    if (decision.linkedObjectId && decision.linkedObjectType === 'proposal_view') {
      await this.writingStore.updateProposalView(decision.linkedObjectId, {
        status: 'author_rejected',
        authorDecision: '拒绝提交，要求修改',
        authorDecisionAt: new Date().toISOString(),
      });
    }
    await this.workflowService.resolvePendingDecision(ctx, decision.id, {
      status: 'dismissed',
      note: '作者拒绝，要求修改'
    });
    // 不返回 null，继续进入 Agent 循环让 Agent 处理修改
    return null;
  }

  // 不是确认也不是拒绝，正常进入 Agent 循环
  return null;
}

/**
 * Agent 在展示推演结果给用户时，必须包含 Proposal Review 的 6 个信息区域
 * （对应 Feature Spec §34.1）：
 *
 * Zone 1（来源）: 草案标题 + 草案 ID
 * Zone 2（摘要）: proposalView.humanSummary
 * Zone 3（变化）: factDiff 列表，"＋实体 属性 = 值" 格式
 * Zone 4（影响）: involvedEntityIds + ruleWarnings（含风险等级）
 * Zone 5（决策）: "是否确认提交？"
 * Zone 6（结果）: 由 CLI 确认通道在提交后展示
 *
 * 渲染规则位于 agent-adapter.ts 中的 renderProposalForUser() 方法。
 */
private renderProposalForUser(pv: WritingProposalView): string { ... }
```

### 8.3 Agent 能力矩阵（Phase 7 最终态）

#### 8.3.1 当前能力 vs Phase 7 要求

| 能力 | 当前 Agent | Step A | Step B | Step C（最终态） |
|------|----------|--------|--------|-----------------|
| `commit_event` 调用 | 授权模式可调 | 🔴 返回 FORBIDDEN | 🔴 | 🔴 |
| `propose_event` 调用 | 可调 | 🟢 保留 | 🟡 改走 CoreBridge | 🟡 |
| 推演后创建审核 | 无 | 🟢 新增 | 🟢 | 🟢 |
| CLI 确认通道 | 无 | 🟢 新增 | 🟢 | 🟢 |
| 草案管理 | Agent 内部 workingDraft | 🟢 保留 | 🟡 对齐 WritingDraft | 🟡 |
| 系统提示词 | WP 生成 | 🟢 | 🟡 注入写作层摘要 | 🟡 |
| Push 检索 | Core Facts | 🟢 | 🟢 | 🟡 注入写作层状态 |
| 上下文压缩 | 消息级 | 🟢 | 🟢 | 🟢 |
| 长期记忆 | Agent 协作偏好 | 🟢 | 🟢 | 🟡 含写作层决策 |
| 意图识别 | 9 种 | 🟢 | 🟢 | 🟡 扩展到 10 种 |

#### 8.3.2 Agent 工具权限分级

```ts
// src/writing/agent/permission-check.ts

export enum AgentCapability {
  /** 只读查询：读取项目、正文、Core 投影 */
  READ_QUERY = 'read_query',
  /** 低风险写入：保存灵感、创建草案 */
  LOW_RISK_WRITE = 'low_risk_write',
  /** 候选写入：创建候选实体/关系 */
  CANDIDATE_WRITE = 'candidate_write',
  /** 审核创建：创建 Proposal Review */
  REVIEW_CREATE = 'review_create',
  /** 禁止：正式提交 Core */
  COMMIT_FORBIDDEN = 'commit_forbidden',
}

/** Agent 对各写作层接口的权限映射 */
export const AGENT_PERMISSIONS: Record<string, AgentCapability> = {
  // =========================================================================
  // 只读查询（Agent 可自由调用）
  // =========================================================================
  'ProjectService.getProjectHomeView': AgentCapability.READ_QUERY,
  'ProjectService.getProjectSettings': AgentCapability.READ_QUERY,
  'ProjectService.listAuthorGoals': AgentCapability.READ_QUERY,
  'IdeaService.listIdeaCards': AgentCapability.READ_QUERY,
  'IdeaService.getIdeaDetail': AgentCapability.READ_QUERY,
  'DraftService.getDraftEditorView': AgentCapability.READ_QUERY,
  'DraftService.listDrafts': AgentCapability.READ_QUERY,
  'EntityService.getEntityProfileView': AgentCapability.READ_QUERY,
  'EntityService.listCandidateQueue': AgentCapability.READ_QUERY,
  'BlueprintService.getActiveBlueprint': AgentCapability.READ_QUERY,
  'BlueprintService.getBlueprintEvolution': AgentCapability.READ_QUERY,
  'WorkflowService.listPendingDecisions': AgentCapability.READ_QUERY,
  'WorkflowService.getDecisionHistory': AgentCapability.READ_QUERY,
  'AuditService.query': AgentCapability.READ_QUERY,
  'CoreBridgeService.readCurrentWorldSnapshot': AgentCapability.READ_QUERY,
  'CoreBridgeService.explainCoreFailure': AgentCapability.READ_QUERY,

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
  // 审核创建（Agent 生成审核视图，不能直接提交）
  // =========================================================================
  'BlueprintService.generateBlueprintDraft': AgentCapability.REVIEW_CREATE,
  'DraftService.markReadyForSimulation': AgentCapability.REVIEW_CREATE,
  'DraftService.simulateDraft': AgentCapability.REVIEW_CREATE,
  'CoreBridgeService.simulateDraftAsEvent': AgentCapability.REVIEW_CREATE,
  'CoreBridgeService.simulateProposal': AgentCapability.REVIEW_CREATE,
  'EntityService.detectEntityHints': AgentCapability.REVIEW_CREATE,

  // =========================================================================
  // 禁止 — Agent 绝对不能调用的方法
  // =========================================================================
  'ProjectService.setWorkspaceMode': AgentCapability.COMMIT_FORBIDDEN,
  'ProjectService.archiveProject': AgentCapability.COMMIT_FORBIDDEN,
  'BlueprintService.acceptBlueprintDraft': AgentCapability.COMMIT_FORBIDDEN,
  'BlueprintService.acceptBlueprintChange': AgentCapability.COMMIT_FORBIDDEN,
  'DraftService._markCommitted': AgentCapability.COMMIT_FORBIDDEN,
  'EntityService._markRegistered': AgentCapability.COMMIT_FORBIDDEN,
  'WorkflowService.resolvePendingDecision': AgentCapability.COMMIT_FORBIDDEN,
  'CoreBridgeService.commitReviewedProposal': AgentCapability.COMMIT_FORBIDDEN,
  'CoreBridgeService.registerReviewedEntity': AgentCapability.COMMIT_FORBIDDEN,
  'CoreBridgeService.commitReviewedThreadChange': AgentCapability.COMMIT_FORBIDDEN,
  'CoreBridgeService.commitReviewedKnowledgeChange': AgentCapability.COMMIT_FORBIDDEN,
  'CoreBridgeService.commitReviewedWorldPackageChange': AgentCapability.COMMIT_FORBIDDEN,
};
```

#### 8.3.3 Agent 调用写作层服务的流程

```
Agent.processUserInput
  │
  ├─ handlePendingDecisions   ← CLI 确认通道（优先短路）
  │
  ├─ detectIntent             ← 意图识别
  │
  ├─ ReAct 循环
  │    │
  │    ├─ Reason（LLM）
  │    │    ├─ 注入 WP + Blueprint 摘要 + 写作层状态
  │    │    └─ 写入规则："你不能直接提交。推演后需用户确认。"
  │    │
  │    ├─ Act（工具调用）
  │    │    ├─ propose_event → agent 直接调用（Step A）
  │    │    ├─ commit_event  → 返回 AGENT_COMMIT_FORBIDDEN
  │    │    └─ 其他只读工具 → 放行
  │    │
  │    ├─ Observe
  │    │    └─ propose_event 成功 → 自动创建 ProposalReview + PendingDecision
  │    │
  │    ├─ Reflect（失败时）
  │    │
  │    └─ Respond
  │         └─ 有 open PendingDecision → "是否确认提交？"
  │
  └─ 返回 AgentTurnResult（status=needs_user_confirmation）
```

### 8.4 具体文件改造清单

| 文件 | Step A | Step B | Step C |
|------|--------|--------|--------|
| `src/agent/narrative-agent.ts` | +handlePendingDecisions / -handleToolSuccess commit 分支 / system prompt 更新 | propose_event → CoreBridge.simulateDraftAsEvent | Push 检索注入写作层状态 |
| `src/agent/types.ts` | ConfirmKeywords 扩展（含"确认提交"/"拒绝"） | 无变更 | +AgentCapability |
| 新增 `src/writing/agent/agent-adapter.ts` | 无 | Agent 意图 → Command 映射 | 权限检查 + 上下文组装 |
| 新增 `src/writing/agent/permission-check.ts` | 无 | 无 | AGENT_PERMISSIONS 表 |
| 新增 `src/writing/agent/context-assembly.ts` | 无 | 注入 Blueprint 摘要 | 注入完整写作层状态 |
| `src/agent/context-compressor.ts` | 无 | 无 | 写作层对象摘要纳入压缩 |

---

### 8.5 Agent 迁移桥接层（Step A 关键设计）

现有 Agent 代码有 4 个与 Phase 7 直接冲突的地方。本节定义迁移桥接——每一步的具体改动和过渡行为。

#### 8.5.1 handleConfirmCommit → handlePendingDecisions（修复审查 #1）

**冲突**：`narrative-agent.ts:724` 的 `handleConfirmCommit` 直接调 `this.toolRouter.execute('commit_event', ...)`。Phase 7 要求所有提交走 CLI 确认通道 → CoreBridge.commitReviewedProposal。

**Step A 改造**：
1. `handleConfirmCommit` 方法**删除**
2. `processUserInput` 中 `if (intent === 'confirm_commit')` 分支**删除**
3. 替代：`handlePendingDecisions`（新增）在 `processUserInput` 最开头运行
4. `detectIntent` 中的 `confirm_commit` 返回值保留作为意图标签（不改变行为，仅用于日志）

**过渡期行为**：用户说"确认提交"时：
- `handlePendingDecisions` → 找到 open PendingDecision → 走 CoreBridge 提交流程
- 如果没有 open PendingDecision → 返回 null → 进入 Agent 正常循环 → Agent 说"当前没有待确认的提案"

#### 8.5.2 workingDraft → WritingDraft 桥接（修复审查 #2）

**冲突**：Agent 的 `workingDraft`（agent_working_drafts 表）和写作层的 `WritingDraft`（writing_drafts 表）是两套独立系统。

**Step A 策略**：Agent 调用 `DraftService.createDraft` 时，**不创建 Agent 内部 workingDraft**。Agent 的 `ensureWorkingDraft` 方法改为委托给 DraftService。

**具体改造**（narrative-agent.ts）：
```ts
// 旧：Agent 自己管理 workingDraft
// private ensureWorkingDraft(summary: string): AgentWorkingDraft {
//   this.agentStore.createDraft(...)
// }

// 新：委托给 DraftService（当 writingLayer 存在时）
private async ensureWorkingDraft(summary: string): Promise<WritingDraft> {
  if (this.writingLayer) {
    return this.writingLayer.draftService.createDraft(ctx, {
      kind: 'event', title: summary
    });
  }
  // fallback: 旧路径（当写作层未注入时保留兼容）
  const id = this.agentStore.createDraft(this.state.sessionId, this.projectId, summary);
  return { id, ... } as unknown as WritingDraft;
}
```

**过渡期**：Agent 构造时注入 `writingLayer?: WritingLayerServices`。有则走 DraftService，无则走旧 AgentStore。保证测试不中断。

#### 8.5.3 pendingProposalIds → PendingDecisionItem 桥接（修复审查 #3）

**冲突**：Agent 的 `pendingProposalIds: string[]` 是 Core proposal ID 列表。Phase 7 用 `PendingDecisionItem`（含 linkedObjectId → ProposalView → coreProposalId）。

**Step A 改造**：
1. `pendingProposalIds` 数组**保留**但降级为审计用途（记录本轮创建了哪些 proposal）
2. Agent 不应该再用 `pendingProposalIds` 来驱动提交流程
3. 提交决策全部走 `WorkflowService.listPendingDecisions` → `handlePendingDecisions`

**transition**：`handleToolSuccess` 中 `propose_event` 成功时：
```ts
// 旧：只记录到 pendingProposalIds
// this.state.pendingProposalIds.push(proposalId);

// 新：同时创建 PendingDecision
if (this.writingLayer) {
  await this.writingLayer.workflowService.createPendingDecision(ctx, {
    kind: 'confirm_proposal',
    title: `确认提交提案 ${proposalId}`,
    linkedObjectId: proposalView.id,
    linkedObjectType: 'proposal_view'
  });
}
// 仍然记录到 pendingProposalIds（向后兼容）
this.state.pendingProposalIds.push(proposalId);
```

#### 8.5.4 detectIntent 与 CLI 通道的优先级（修复审查 #4）

**冲突**：两个地方都在检测"确认提交"——`detectIntent`（Agent 内部）和 `handlePendingDecisions`（CLI 确认通道）。

**解决**：`handlePendingDecisions` 在 `processUserInput` **最开头**执行，在 `detectIntent` 之前。如果短路返回了 `AgentTurnResult`，`detectIntent` 根本不会被调用。

```
processUserInput(userInput):
  1. handlePendingDecisions(userInput)  ← 先检查 CLI 确认
     → 返回 AgentTurnResult? → return（短路，不进入 Agent）
     → 返回 null? → 继续
  2. detectIntent(userInput)             ← CLI 确认通道没拦截，正常判断意图
  3. ReAct 循环
```

**detectIntent 的 confirm_commit 返回值处理**：当 `handlePendingDecisions` 返回 null（无 open 决策）但用户说"确认提交"时，`detectIntent` 返回 `confirm_commit`。此时 Agent 应回复"当前没有待确认的提案，你想提交什么？"——而不是进入 commit 路径。

#### 8.5.5 写作层服务注入点

`NarrativeAgent` 构造函数新增可选参数：

```ts
interface WritingLayerServices {
  projectService: ProjectService;
  ideaService: IdeaService;
  blueprintService: BlueprintService;
  draftService: DraftService;
  entityService: EntityService;
  workflowService: WorkflowService;
  auditService: AuditService;
  coreBridge: CoreBridgeService;  // 注意：Agent 只能调只读+推演方法
  writingStore: SQLiteWritingStore;  // 用于 CLI 确认通道直接读写 ProposalView
}
```

Agent 构造时：
- `writingLayer` 存在 → Agent 启用 Phase 7 行为（CLI 确认通道、DraftService 委托）
- `writingLayer` 为 undefined → Agent 保持 Phase 6 行为（完全向后兼容）

#### 8.5.6 实体 ID 查找（修复审查 #6）

Agent 构建 `factChanges` 需要 Core entity ID。Phase 7 新增查找方法：

```
EntityService.getCoreEntityId(sketchId): string | undefined
  从 WritingEntitySketch.coreEntityId 读取（已注册的实体才有此字段）

EntityService.findRegisteredEntities(projectId, namePattern?): WritingEntitySketch[]
  列出所有 status='registered' 的实体（Agent 可从中获取 coreEntityId）
```

Agent 在构建 factChanges 前调用 `entityService.findRegisteredEntities()` 获取可用实体 ID 列表，注入到 LLM 上下文。

#### 8.5.7 chapter 字段（修复审查 #7）

`WritingDraft` 新增 `chapter` 字段：
- DDL `writing_drafts` 新增 `chapter INTEGER NOT NULL DEFAULT 1`
- `WritingDraft` 接口新增 `chapter: number`
- `createDraft` 参数新增 `chapter?: number`（默认 1）
- `simulateDraft` 从 `draft.chapter` 提取而非猜测

Phase 7 默认 chapter=1（单章演示），后续扩展时按项目状态自动递增。

#### 8.5.8 DraftStatus 'review' 状态澄清（修复审查 #8）

原始设计在 `simulated → review → committed` 中间有一个 `review` 状态。但 Phase 7 实际实现中，`simulateDraft` 直接创建 ProposalView（status='open'），ProposalView 承担"审核中"的语义。Draft 的 `review` 状态**保留但不使用**——改为 `simulated → committed`（中间状态由 ProposalView.status 表达）。

Draft 状态机更新：
```
drafting → ready_to_simulate → simulated → committed
                                  │            │
                                  └→ drafting  └→ (终态)
                                  (修改后重回)
```
移除了 `review` 状态，Draft 本身不表达"审核中"，审核生命周期由 ProposalView.status 管理。

---

## 9. ViewModel 投影规则

### 9.1 普通作者视图过滤规则

以下字段在 `visibilityMode: 'normal'` 时**绝对不能出现**：

| 禁止字段 | 示例 |
|---------|------|
| `EntityKind` | place / character / faction |
| `RelationKind` | spatial / social / causal |
| Core predicate | location / target / connected_to |
| Core entity ID | ent_hanli |
| Core fact ID | fct_encounter_50_02 |
| Core event ID | evt_encounter_250 |
| JSON DSL | wp_rules 的 condition 表达式 |
| 内部 request ID | req_xxx |
| 表名 | writing_drafts |

### 9.2 ViewModel 示例

```ts
// ProjectHomeViewModel — 普通作者看到的首页
interface ProjectHomeViewModel {
  projectTitle: string;           // 作品名
  projectStatusLabel: string;     // "构思中" / "写作中" / "审核中"
  workspaceModeLabel: string;     // "规划" / "写作" / "审核"
  recentDrafts: Array<{
    title: string;                // 草案标题
    statusLabel: string;          // "起草中" / "可推演" / "已提交"
    updatedAt: string;
  }>;
  pendingDecisions: Array<{
    title: string;                // 待确认事项标题
    kindLabel: string;            // "实体注册" / "提案审核" / ...
  }>;
  candidateEntityCount: number;   // 候选实体数量
  // ❌ 这里不出现 coreEntityId, EntityKind, predicate
}

// ProposalReviewViewModel — 审核页
interface ProposalReviewViewModel {
  // 来源区
  sourceLabel: string;            // "来自草案：第一幕事件"
  // 摘要区
  humanSummary: string;           // "系统准备写入：沈笙发现黑晶碎片发热..."
  // 变化区
  factDiffs: Array<{
    description: string;          // "新增：沈笙 位置 = 废弃站台"（人话）
    entityName: string;           // "沈笙"
    changeLabel: string;          // "位置变化"
  }>;
  // 影响区
  involvedEntities: string[];     // ["沈笙", "长庚站", "黑晶碎片"]
  warnings: Array<{
    level: '提醒' | '警告' | '阻断';
    message: string;              // "沈笙当前在长庚站，新事件会改变她的位置"
  }>;
  // ❌ 这里不出现 fact_changes JSON, predicate, EntityKind
}
```

---

## 10. 错误模型

### 10.1 写作层错误码枚举

```ts
// src/writing/errors/error-codes.ts

export const WritingErrorCode = {
  // 状态机违规
  INVALID_STATUS_TRANSITION: 'INVALID_STATUS_TRANSITION',
  DRAFT_NOT_READY_FOR_SIMULATION: 'DRAFT_NOT_READY_FOR_SIMULATION',
  PROPOSAL_NOT_IN_REVIEW: 'PROPOSAL_NOT_IN_REVIEW',

  // 权限违规
  AGENT_COMMIT_FORBIDDEN: 'AGENT_COMMIT_FORBIDDEN',
  AGENT_REGISTER_FORBIDDEN: 'AGENT_REGISTER_FORBIDDEN',
  COMMIT_WITHOUT_REVIEW: 'COMMIT_WITHOUT_REVIEW',

  // 来源问题
  SOURCE_DRAFT_MODIFIED_AFTER_REVIEW: 'SOURCE_DRAFT_MODIFIED_AFTER_REVIEW',
  SOURCE_REF_BROKEN: 'SOURCE_REF_BROKEN',
  CORE_REF_STALE: 'CORE_REF_STALE',

  // CoreBridge 失败
  COREBRIDGE_SIMULATE_FAILED: 'COREBRIDGE_SIMULATE_FAILED',
  COREBRIDGE_COMMIT_FAILED: 'COREBRIDGE_COMMIT_FAILED',
  COREBRIDGE_WRITEBACK_FAILED: 'COREBRIDGE_WRITEBACK_FAILED',

  // 映射问题
  BLUEPRINT_MAPPING_LOW_CONFIDENCE: 'BLUEPRINT_MAPPING_LOW_CONFIDENCE',
  ENTITY_TYPE_NOT_MAPPED: 'ENTITY_TYPE_NOT_MAPPED',
  PREDICATE_NOT_FOUND: 'PREDICATE_NOT_FOUND',

  // 重复/冲突
  DUPLICATE_ENTITY_CANDIDATE: 'DUPLICATE_ENTITY_CANDIDATE',
  DUPLICATE_PROPOSAL: 'DUPLICATE_PROPOSAL',

  // 存储
  WRITING_STORE_ERROR: 'WRITING_STORE_ERROR',
  WRITING_OBJECT_NOT_FOUND: 'WRITING_OBJECT_NOT_FOUND',
} as const;

export type WritingErrorCodeType = (typeof WritingErrorCode)[keyof typeof WritingErrorCode];
```

### 10.2 错误恢复动作映射

| 错误码 | 作者可见消息 | 恢复动作 |
|--------|------------|---------|
| `INVALID_STATUS_TRANSITION` | "当前状态不允许此操作" | 刷新并重试 |
| `AGENT_COMMIT_FORBIDDEN` | "提交需要你在审核页确认" | 引导到 Proposal Review |
| `SOURCE_DRAFT_MODIFIED_AFTER_REVIEW` | "草案在审核期间被修改，需要重新推演" | 重新 simulate |
| `COREBRIDGE_COMMIT_FAILED` | "提交失败：[Core错误说明]" | 展示 CoreBridge 错误，修复后重试 |
| `COREBRIDGE_WRITEBACK_FAILED` | "提交成功但写作层状态更新失败" | 触发对账恢复 |
| `BLUEPRINT_MAPPING_LOW_CONFIDENCE` | "系统不确定如何将「{类型}」映射到世界状态" | 引导作者确认映射 |

---

## 11. 代码结构

### 11.1 建议目录结构

```
src/writing/
  models/
    types.ts              # 领域对象类型定义（§6）
    source-ref.ts          # SourceRef 类型
    state-machine.ts       # 状态机校验函数（状态跳转合法性）
  services/
    context.ts             # WritingRequestContext
    project-service.ts     # ProjectService 接口 + 实现
    idea-service.ts        # IdeaService
    blueprint-service.ts   # BlueprintService
    draft-service.ts       # DraftService
    entity-service.ts      # EntityService
    workflow-service.ts    # WorkflowService
    audit-service.ts       # AuditService
  core-bridge/
    core-bridge-service.ts # CoreBridgeService 接口 + 实现
    error-explainer.ts     # Core 错误 → 人话说明
    writeback.ts           # 提交成功/失败后的回写逻辑
  repositories/
    writing-store.ts       # writing_* 表 DDL + CRUD（与 agent-store.ts 同模式）
  view-models/
    project-home.ts        # ProjectHomeViewModel
    proposal-review.ts     # ProposalReviewViewModel
    entity-profile.ts      # EntityProfileViewModel
    draft-editor.ts        # DraftEditorViewModel
    filter.ts              # 技术字段过滤（visibilityMode: normal → 移除禁止字段）
  agent/
    agent-adapter.ts       # Agent 意图 → 写作层 Command 映射
    permission-check.ts    # Agent 工具权限检查
    context-assembly.ts    # Agent 上下文组装（注入写作层状态）
  errors/
    error-codes.ts         # 错误码枚举
    writing-error.ts       # WritingError 类
  jobs/
    job-runner.ts          # 异步任务执行器骨架
```

### 11.2 Phase 7 实现顺序

```
Step 1:  models/types.ts + source-ref.ts + error-codes.ts       ← 纯类型，无依赖
Step 2:  repositories/writing-store.ts (DDL + CRUD)              ← 依赖 Step1
Step 3:  services/context.ts + audit-service.ts                  ← 依赖 Step2
Step 4:  services/project-service.ts                             ← 依赖 Step3
Step 5:  services/idea-service.ts                                ← 依赖 Step3
Step 6:  services/blueprint-service.ts                           ← 依赖 Step4
Step 7:  services/draft-service.ts + entity-service.ts           ← 依赖 Step4
Step 8:  core-bridge/ (mock 先行)                                ← 依赖 Step7
Step 9:  services/workflow-service.ts                            ← 依赖 Step7
Step 10: view-models/ (投影 + 过滤)                              ← 依赖 Step7-9
Step 11: agent/agent-adapter.ts (Agent 改造)                     ← 依赖 Step7-9
Step 12: core-bridge/ (真实 CoreBridge 接通)                     ← 依赖 Step8
Step 13: 测试                                                    ← 全程并行
```

---

## 12. 已关闭的待澄清问题

| DQ# | Feature Spec §51 问题 | 决策 | 理由 |
|-----|----------------------|------|------|
| 1 | 同库 vs sidecar | 同库 `writing_*` 表 | 与 agent_* 表模式一致，单文件备份 |
| 2 | Blueprint 表策略 | 独立表 `writing_blueprints` | 需要版本管理 + 多代并存 |
| 3 | 语义索引时机 | Phase 7 先用文本索引 | Core 已有 LanceDB，语义索引复用 |
| 4 | AuditLog 记录范围 | 仅记录写入 + 高风险操作 | 只读查询量太大，不记审计 |
| 5 | 测试矩阵位置 | 后续拆独立文档 | 当前先留在本文档 §13 |
| 6 | 审核视图形态 | CLI 确认通道（中间件短路），不做 Web | 见 §8.2.3，不依赖前端 |
| 7 | 测试文件命名 | 用 `src/writing/tests/` 下的独立命名 | 服务测试命名：`*-service.test.ts` |
| 8 | SourceRef 格式 | JSON 字段 | 结构简单，不需要独立表 |
| 9 | CoreReferenceIndex | 独立表 `writing_core_refs` | 需要双向索引 |
| 10 | DomainEvent 持久化 | Phase 7 不持久化 | 内存事件 + 审计日志够用 |

DQ-3、DQ-4、DQ-5、DQ-6、DQ-7 通过决策方式关闭。

---

## 13. 决策已关闭（Q1/Q2）

### Q1: 审核视图形态 → C + CLI 确认通道

**决策**：不做 Web。Phase 7 审核通过 CLI 确认通道实现——用户在终端看到 diff 后输入"确认提交"，系统短路到 CoreBridge.commitReviewedProposal。

**理由**：
- Feature Spec 定义的 6 个信息区域（来源/摘要/变化/影响/决策/结果）在 CLI 下都能展示
- ProposalReviewViewModel 数据结构完整，后续 WebApp 接入时只需换渲染层
- 不引入前端技术栈依赖，保持 Phase 7 聚焦写作层领域逻辑
- CLI 确认通道不依赖 Agent ReAct 循环——它是独立中间件

### Q2: commit_event 移除时机 → A（第一步就移除）

**决策**：Phase 7 Step A 第一步就移除 Agent 的 `commit_event` 直接调用，同时实现 CLI 确认通道作为替代提交路径。

**前提**（必须同时做）：
1. Agent 推演成功后自动创建 ProposalReview + PendingDecision
2. CLI 确认通道在 `processUserInput` 入口短路处理确认/拒绝
3. CoreBridge.commitReviewedProposal 实现完成

**对现有测试的影响**：
- 依赖 `agent_authorized_for_session` 自动提交的测试需要更新：改为推演 + CLI 确认通道提交
- Tool Router 测试不受影响（commit_event 工具本身不变，只是 Agent 不调了）
- Agent 测试新增：AGENT_COMMIT_FORBIDDEN 场景

---

## 14. 端到端流程（Phase 7 最小闭环）

### 14.1 创建作品到首次提交

```
用户: "我想写一个灰域科幻，一对兄妹在废弃星球首府求生。"
  │
  ├─ Agent 识别意图：new_content
  ├─ IdeaService.captureIdea("灰域科幻...", { kind: 'premise' })
  │   → wic_premise_001
  │
  ├─ Agent: "已保存灵感。要整理一下这个世界的结构吗？"
  │
用户: "好，整理一下。"
  │
  ├─ BlueprintService.generateBlueprintDraft("灰域科幻...")
  │   → wb_blueprint_001 (maturity='drafted')
  │   提取：实体类型[角色/地点/组织/物品/异常现象]
  │         关系类型[庇护/追捕/侵蚀]
  │
  ├─ Agent: "我暂时这样理解：这个世界有角色、地点、组织、物品和异常现象。
  │         角色之间存在庇护/追捕关系。确认吗？"
  │
用户: "确认。"
  │
  ├─ BlueprintService.acceptBlueprintDraft(wb_blueprint_001)
  │   → maturity='active'
  │
用户: "帮我把主角设定写出来。"
  │
  ├─ Agent: DraftService.createDraft({ kind: 'setting', content: '...' })
  │   → wd_draft_001 (status='drafting')
  │
用户: "沈墨有嵌合体义肢，沈笙能让灰域短暂退缩。"
  │
  ├─ Agent: DraftService.updateDraftContent(wd_draft_001, '...')
  │
  ├─ Agent: EntityService.detectEntityHints("沈墨...沈笙...灰域...")
  │   → [wes_hint_001 (沈墨/角色), wes_hint_002 (沈笙/角色),
  │       wes_hint_003 (灰域/异常现象), wes_hint_004 (长庚站/地点)]
  │
  ├─ Agent: "我发现这些可能成为重要设定：
  │         · 沈墨 — 角色
  │         · 沈笙 — 角色
  │         · 灰域 — 异常现象
  │         · 长庚站 — 地点
  │         要登记这些吗？"
  │
用户: "沈墨和沈笙登记，灰域和长庚站先保持候选。"
  │
  ├─ EntityService.promoteHintToSketch(wes_hint_001, '沈墨', '角色')
  ├─ EntityService.promoteHintToSketch(wes_hint_002, '沈笙', '角色')
  ├─ EntityService.approveCandidate(wes_sketch_001)
  ├─ EntityService.approveCandidate(wes_sketch_002)
  │
  ├─ WorkflowService.createPendingDecision({
  │     kind: 'confirm_entity',
  │     title: '登记实体：沈墨、沈笙',
  │     linkedObjectId: ..., linkedObjectType: 'entity_sketch'
  │   })
  │
  ├─ Agent: "实体登记审核已创建。确认登记沈墨和沈笙为正式角色？"
  │
用户: "确认。"
  │
  ├─ CLI 确认通道短路：
  │   resolvePendingDecision('resolved')
  │   → CoreBridge.registerReviewedEntity(wes_sketch_001)
  │   → CoreBridge.registerReviewedEntity(wes_sketch_002)
  │
  ├─ Agent: "✅ 沈墨、沈笙已登记为正式角色。"
  │
用户: "把他们发现黑晶碎片发热的场景写成第一幕事件。"
  │
  ├─ Agent: DraftService.createDraft({ kind: 'event', content: '...' })
  │   → wd_draft_002 (status='drafting')
  │
  ├─ Agent: DraftService.markReadyForSimulation(wd_draft_002)
  ├─ Agent: CoreBridge.simulateDraftAsEvent(wd_draft_002, {
  │     eventDescription: '沈墨和沈笙在长庚站发现黑晶碎片发热...',
  │     chapter: 1, factChanges: [...]
  │   })
  │
  ├─ CoreBridge → propose_event → 返回 proposal_id + simulation_report
  │
  ├─ Agent 自动创建：
  │   DraftService.createProposalFromDraft(wd_draft_002)
  │     → wpv_review_001 (status='open')
  │   WorkflowService.createPendingDecision({
  │     kind: 'confirm_proposal',
  │     title: '确认提交事件：发现黑晶碎片',
  │     linkedObjectId: wpv_review_001
  │   })
  │
  ├─ Agent: "推演完成。以下是将写入世界状态的变化：
  │
  │         ＋沈墨 位置 = 长庚站
  │         ＋沈笙 位置 = 长庚站
  │         ＋黑晶碎片 状态 = 发热激活
  │
  │         涉及实体：沈墨、沈笙、黑晶碎片、长庚站
  │         [警告] 沈笙当前在长庚站，新事件改变位置但未说明到达方式
  │
  │         是否确认提交？[确认提交 / 修改 / 取消]"
  │
用户: "确认提交。"
  │
  ├─ CLI 确认通道短路：
  │   resolvePendingDecision('resolved')
  │   → CoreBridge.commitReviewedProposal(wpv_review_001)
  │   → commit_event → Core
  │   → DraftService._markCommitted(wd_draft_002, evt_xxx)
  │   → AuditService.record('commit_proposal', ...)
  │
  ├─ Agent: "✅ 已写入世界状态。事件 ID evt_first_encounter_001。"
```

### 14.2 端到端状态变化追踪

| 步骤 | 写作层对象 | 状态变化 | Core 影响 |
|------|---------|---------|----------|
| 创建作品 | WritingProject | planning | 无 |
| 保存灵感 | IdeaCard | raw | 无 |
| 生成蓝图 | ProjectBlueprint | drafted | 无 |
| 确认蓝图 | ProjectBlueprint | active | 无 |
| 创建草案 | WritingDraft | drafting | 无 |
| 实体发现 | EntitySketch ×4 | hint | 无 |
| 确认候选 | EntitySketch ×2 | candidate → approved | 无 |
| 注册实体 | EntitySketch ×2 | registered | register_entity |
| 推演草案 | WritingDraft | simulated | propose_event |
| 创建审核 | ProposalView | open | 无 |
| 确认提交 | ProposalView → Draft | committed | commit_event |

---

## 15. Phase 7 Step A 开发最小清单

### 15.0 与 Feature Spec 的明确边界

Phase 7 只实现以下闭环（对应 Feature Spec §28.1 主闭环 + §29.1-29.7 任务列表）：

**Phase 7 包含**：
- 项目创建、灵感保存、蓝图管理、草案推演、候选实体、Proposal Review、CoreBridge 提交通道、审计日志、Core 引用追踪

**Phase 7 明确不包含**（对应 Roadmap §26 + Feature Spec §29 "第一阶段不做"）：
- 导入已有正文分析（→ Phase 8）
- 章节/场景结构规划（→ Phase 10）
- 时间线视图（→ Phase 10）
- 读者模型/视角管理（→ Phase 11）
- 伏笔/悬念系统（→ Phase 11）
- 地理/空间/地图编辑器（→ Phase 9）
- 图谱可视化（→ Phase 8）
- 完整风格/正文生成系统（→ Phase 12）
- 多 Agent 协作（→ Phase 8+）
- Agent 自动提交 Core（永不做）
- 自动固化 World Package（→ Phase 8）
- Web 前端工作台（Phase 7 只做 CLI/TUI）
- 蓝图前端面板与人话展示（→ Phase 8，当前仅 CLI 文本输出）
- 蓝图建议噪音控制/频率管理（→ Phase 8）
- 参考资料卡片管理 ReferenceCard（→ Phase 8）
- 互斥方案管理 IdeaAlternativeGroup（→ Phase 8）
- 草案版本/分支/合并/对比（→ Phase 9）
- 草案结构化拆分 DraftSplitPlan（→ Phase 9）
- 草案与正文/章节/场景关联 DraftUsageLink（→ Phase 10）
- 实体档案页 EntityProfileView（→ Phase 8）
- 实体属性/状态摘要 EntityAttributeDraft（→ Phase 8）
- 实体出场追踪 EntityMention/EntityAppearanceReport（→ Phase 10）

**Phase 7 部分实现**（核心路径完成，辅助能力后续补充）：
- 蓝图生成：只创建容器，NL→结构化提取由 Agent 完成（→ Phase 8 实现自动提取）
- 蓝图演化：变更建议接受/拒绝已实现，自动检测新概念由 Agent 驱动（→ Phase 8）
- 想法转出：灵感→草案、灵感→蓝图候选已实现；灵感→实体候选需经 detectEntityHints 中间步骤
- 实体别名：存储和合并已实现；别名记录/拆分/歧义警告由 Agent 辅助（→ Phase 8）
- 项目首页：基础 ViewModel 已定义；"上次编辑位置"/"Core 读取失败回退"等完整产品体验（→ Phase 8）
- 项目设置：归档已完整实现；项目设置页/删除预览/恢复功能（→ Phase 8）

这些是**有意推迟**，不是遗忘。数据模型的 `writing_jobs` 表和 SourceRef 的 `import` 类型已为后续扩展预留。

### 15.1 Step A 开发任务

这是完成后立即可以演示"一句话→Core 正式提交"的最小任务集：

```
[ ] Step A1: writing-store.ts DDL — 11 张表建表（30min）
[ ] Step A2: models/types.ts — 全部领域对象类型（45min）
[ ] Step A3: models/source-ref.ts — SourceRef 工具类型（10min）
[ ] Step A4: errors/error-codes.ts — WritingErrorCode 枚举（15min）
[ ] Step A5: services/context.ts — WritingRequestContext（15min）
[ ] Step A6: services/audit-service.ts — 审计写入（30min）
[ ] Step A7: services/project-service.ts — 创建项目 + 目标管理（45min）
[ ] Step A8: services/idea-service.ts — 灵感捕捉（30min）
[ ] Step A9: services/draft-service.ts — 草案 CRUD（45min）
[ ] Step A10: services/entity-service.ts — 实体发现+候选（45min）
[ ] Step A11: core-bridge/core-bridge-service.ts — Mock 版本（45min）
[ ] Step A12: services/workflow-service.ts — 待确认事项（30min）
[ ] Step A13: services/blueprint-service.ts — 蓝图草案（45min）
[ ] Step A14: core-bridge/ 真实 CoreBridge 接通（60min）
[ ] Step A15: agent/agent-adapter.ts — CLI 确认通道 + Agent 改造（90min）
[ ] Step A16: 端到端测试 — 完整闭环（60min）
```

预计总工时：约 10 小时（不含 LLM 调优）。

---

## 16. WritingStore CRUD 接口

遵循 `agent-store.ts` 模式：同库共享连接、prepared statement、JSON 序列化、snake_case 行类型。

### 16.1 ID 生成

```ts
// 写作层 ID 前缀规则
const WRITING_ID_PREFIX: Record<string, string> = {
  project:           'wprj',
  author_goal:       'wagl',
  idea_card:         'wicd',
  blueprint:         'wblp',
  draft:             'wdft',
  entity_sketch:     'wesk',
  pending_decision:  'wpdc',
  proposal_view:     'wpvw',
  audit_log:         'waul',
  core_ref:          'wcref',
  job:               'wjob',
};

function makeId(prefix: string): string {
  const ts = Date.now();
  const rnd = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${ts}_${rnd}`;
}
```

### 16.2 行类型（DB → 领域对象映射）

```ts
// src/writing/repositories/writing-store.ts

// --- 数据库行类型（snake_case，与 DDL 对齐）---

export interface ProjectRow {
  id: string; title: string; premise: string | null;
  status: string; active_blueprint_id: string | null;
  current_draft_id: string | null; workspace_mode: string;
  created_at: string; updated_at: string; deleted_at: string | null;
}

export interface AuthorGoalRow {
  id: string; project_id: string; text: string; kind: string;
  priority: string; scope: string; status: string;
  source_refs_json: string;
  created_at: string; updated_at: string; deleted_at: string | null;
}

export interface IdeaCardRow {
  id: string; project_id: string; content: string; summary: string | null;
  kind: string; maturity: string; tags_json: string; source: string;
  analysis_policy: string; source_refs_json: string;
  linked_draft_ids_json: string;
  created_at: string; updated_at: string; deleted_at: string | null;
}

export interface BlueprintRow {
  id: string; project_id: string; version: number; maturity: string;
  entity_types_json: string; relation_types_json: string;
  spatial_node_types_json: string; spatial_edge_types_json: string;
  workflow_presets_json: string; graph_view_presets_json: string;
  source_refs_json: string; change_suggestions_json: string;
  superseded_by: string | null;
  created_at: string; updated_at: string; deleted_at: string | null;
}

export interface DraftRow {
  id: string; project_id: string; kind: string;
  title: string | null; content: string; summary: string | null;
  status: string; source_refs_json: string;
  linked_proposal_view_id: string | null; version_group_id: string | null;
  created_at: string; updated_at: string; deleted_at: string | null;
}

export interface EntitySketchRow {
  id: string; project_id: string; display_name: string;
  type_label: string; summary: string | null;
  aliases_json: string; tags_json: string; status: string;
  source_refs_json: string; core_entity_id: string | null;
  core_kind: string | null;
  created_at: string; updated_at: string; deleted_at: string | null;
}

export interface PendingDecisionRow {
  id: string; project_id: string; kind: string;
  title: string; description: string | null;
  source_refs_json: string; linked_object_id: string | null;
  linked_object_type: string | null; status: string;
  resolved_at: string | null; resolution_note: string | null;
  created_at: string; updated_at: string; deleted_at: string | null;
}

export interface ProposalViewRow {
  id: string; project_id: string; source_draft_id: string | null;
  source_entity_sketch_id: string | null; proposal_type: string;
  core_proposal_id: string | null; core_bridge_result_json: string;
  status: string; human_summary: string | null;
  fact_diff_json: string; involved_entity_ids_json: string;
  rule_warnings_json: string; author_decision: string | null;
  author_decision_at: string | null; core_event_id: string | null;
  commit_error_json: string | null;
  created_at: string; updated_at: string; deleted_at: string | null;
}

export interface AuditLogRow {
  id: string; project_id: string; action: string;
  target_type: string | null; target_id: string | null;
  trigger_source: string; result: string; detail_json: string;
  error_code: string | null; request_id: string | null;
  session_id: string | null; created_at: string;
}

export interface CoreRefRow {
  id: string; project_id: string;
  writing_object_type: string; writing_object_id: string;
  core_object_type: string; core_object_id: string;
  ref_status: string; last_verified_at: string | null; created_at: string;
}

export interface JobRow {
  id: string; project_id: string; job_type: string; status: string;
  progress: number; summary: string | null;
  input_refs_json: string; output_refs_json: string;
  error_json: string | null; created_by: string;
  created_at: string; updated_at: string;
}
```

### 16.3 反序列化辅助

```ts
function safeParseJson(text: string, id: string, field: string): unknown {
  try { return JSON.parse(text); }
  catch { throw new Error(`writing-store: JSON 解析失败 — ${field} in record ${id}`); }
}

function rowToProject(row: ProjectRow): WritingProject {
  return {
    id: row.id, title: row.title, premise: row.premise ?? undefined,
    status: row.status as ProjectStatus,
    activeBlueprintId: row.active_blueprint_id ?? undefined,
    currentDraftId: row.current_draft_id ?? undefined,
    workspaceMode: row.workspace_mode as WorkspaceMode,
    sourceRefs: [], // Project 的 sourceRefs 从创建上下文获取，不存表
    createdAt: row.created_at, updatedAt: row.updated_at,
    deletedAt: row.deleted_at ?? undefined,
  };
}

function rowToDraft(row: DraftRow): WritingDraft {
  return {
    id: row.id, projectId: row.project_id, kind: row.kind as DraftKind,
    title: row.title ?? undefined, content: row.content,
    summary: row.summary ?? undefined, status: row.status as DraftStatus,
    sourceRefs: safeParseJson(row.source_refs_json, row.id, 'source_refs_json') as SourceRef[],
    linkedProposalViewId: row.linked_proposal_view_id ?? undefined,
    versionGroupId: row.version_group_id ?? undefined,
    createdAt: row.created_at, updatedAt: row.updated_at,
    deletedAt: row.deleted_at ?? undefined,
  };
}

// ... (其余 rowTo* 函数同理)
```

### 16.4 WritingStore 类接口

```ts
export class SQLiteWritingStore {
  private db: Database.Database;

  constructor(db: Database.Database) { this.db = db; }

  /** 执行 DDL 创建所有 writing_* 表（幂等） */
  createTables(): void { this.db.exec(WRITING_DDL); }

  // =========================================================================
  // writing_projects
  // =========================================================================

  createProject(title: string, premise?: string): WritingProject {
    const id = makeId('wprj');
    this.db.prepare(`INSERT INTO writing_projects (id, title, premise) VALUES (?, ?, ?)`)
      .run(id, title, premise ?? null);
    return this.getProject(id)!;
  }

  getProject(projectId: string): WritingProject | undefined {
    const row = this.db.prepare('SELECT * FROM writing_projects WHERE id = ? AND deleted_at IS NULL')
      .get(projectId) as ProjectRow | undefined;
    return row ? rowToProject(row) : undefined;
  }

  updateProject(projectId: string, updates: Partial<Pick<ProjectRow, 'title' | 'premise' | 'status' | 'active_blueprint_id' | 'current_draft_id' | 'workspace_mode'>>): void {
    const parts: string[] = [];
    const values: unknown[] = [];
    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined) {
        parts.push(`${key} = ?`);
        values.push(value);
      }
    }
    if (parts.length === 0) return;
    parts.push("updated_at = datetime('now')");
    values.push(projectId);
    this.db.prepare(`UPDATE writing_projects SET ${parts.join(', ')} WHERE id = ?`).run(...values);
  }

  softDeleteProject(projectId: string): void {
    this.db.prepare("UPDATE writing_projects SET deleted_at = datetime('now') WHERE id = ?").run(projectId);
  }

  // =========================================================================
  // writing_author_goals
  // =========================================================================

  createGoal(projectId: string, text: string, kind: GoalKind,
    priority?: GoalPriority, scope?: GoalScope): AuthorGoal {
    const id = makeId('wagl');
    this.db.prepare(`INSERT INTO writing_author_goals (id, project_id, text, kind, priority, scope) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(id, projectId, text, kind, priority ?? 'normal', scope ?? 'project');
    return this.getGoal(id)!;
  }

  getGoal(goalId: string): AuthorGoal | undefined { /* ... */ }
  listGoals(projectId: string, status?: GoalStatus): AuthorGoal[] { /* ... */ }

  updateGoalStatus(goalId: string, status: GoalStatus): void {
    this.db.prepare("UPDATE writing_author_goals SET status = ?, updated_at = datetime('now') WHERE id = ?")
      .run(status, goalId);
  }

  // =========================================================================
  // writing_idea_cards
  // =========================================================================

  createIdeaCard(projectId: string, content: string, kind: IdeaKind,
    tags?: string[], source?: IdeaSource, analysisPolicy?: AnalysisPolicy): IdeaCard {
    const id = makeId('wicd');
    this.db.prepare(`INSERT INTO writing_idea_cards (id, project_id, content, kind, tags_json, source, analysis_policy) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(id, projectId, content, kind, JSON.stringify(tags ?? []), source ?? 'manual', analysisPolicy ?? 'normal');
    return this.getIdeaCard(id)!;
  }

  getIdeaCard(ideaId: string): IdeaCard | undefined { /* ... */ }
  listIdeaCards(projectId: string, filter?: { maturity?: IdeaMaturity; kind?: IdeaKind }): IdeaCard[] { /* ... */ }

  updateIdeaCard(ideaId: string, updates: Partial<Pick<IdeaCardRow, 'content' | 'summary' | 'kind' | 'maturity' | 'tags_json' | 'analysis_policy'>>): void { /* ... */ }

  softDeleteIdeaCard(ideaId: string): void { /* ... */ }

  // =========================================================================
  // writing_blueprints
  // =========================================================================

  createBlueprint(projectId: string, entityTypes?: BlueprintTypeDef[],
    relationTypes?: BlueprintTypeDef[], maturity?: BlueprintMaturity): ProjectBlueprint {
    const id = makeId('wblp');
    this.db.prepare(`INSERT INTO writing_blueprints (id, project_id, entity_types_json, relation_types_json, maturity) VALUES (?, ?, ?, ?, ?)`)
      .run(id, projectId, JSON.stringify(entityTypes ?? []), JSON.stringify(relationTypes ?? []), maturity ?? 'drafted');
    return this.getBlueprint(id)!;
  }

  getBlueprint(blueprintId: string): ProjectBlueprint | undefined { /* ... */ }
  getActiveBlueprint(projectId: string): ProjectBlueprint | undefined {
    const row = this.db.prepare(
      "SELECT * FROM writing_blueprints WHERE project_id = ? AND maturity IN ('active','evolving') AND deleted_at IS NULL ORDER BY version DESC LIMIT 1"
    ).get(projectId) as BlueprintRow | undefined;
    return row ? rowToBlueprint(row) : undefined;
  }

  updateBlueprint(blueprintId: string, updates: {
    maturity?: BlueprintMaturity;
    entityTypes?: BlueprintTypeDef[];
    relationTypes?: BlueprintTypeDef[];
    changeSuggestions?: BlueprintChangeSuggestion[];
  }): void { /* ... */ }

  supersedeBlueprint(blueprintId: string, newBlueprintId: string): void {
    this.db.prepare("UPDATE writing_blueprints SET maturity = 'superseded', superseded_by = ?, updated_at = datetime('now') WHERE id = ?")
      .run(newBlueprintId, blueprintId);
  }

  // =========================================================================
  // writing_drafts
  // =========================================================================

  createDraft(projectId: string, kind: DraftKind, title?: string,
    content?: string, sourceRefs?: SourceRef[]): WritingDraft {
    const id = makeId('wdft');
    this.db.prepare(`INSERT INTO writing_drafts (id, project_id, kind, title, content, source_refs_json) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(id, projectId, kind, title ?? null, content ?? '', JSON.stringify(sourceRefs ?? []));
    return this.getDraft(id)!;
  }

  getDraft(draftId: string): WritingDraft | undefined { /* ... */ }
  listDrafts(projectId: string, filter?: { status?: DraftStatus; kind?: DraftKind }): WritingDraft[] { /* ... */ }

  updateDraft(draftId: string, updates: {
    content?: string; summary?: string; title?: string;
    status?: DraftStatus; linkedProposalViewId?: string | null;
  }): void { /* ... */ }

  softDeleteDraft(draftId: string): void {
    this.db.prepare("UPDATE writing_drafts SET deleted_at = datetime('now') WHERE id = ?").run(draftId);
  }

  // =========================================================================
  // writing_entity_sketches
  // =========================================================================

  createEntitySketch(projectId: string, displayName: string, typeLabel: string,
    status?: EntitySketchStatus, sourceRefs?: SourceRef[]): WritingEntitySketch {
    const id = makeId('wesk');
    this.db.prepare(`INSERT INTO writing_entity_sketches (id, project_id, display_name, type_label, status, source_refs_json) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(id, projectId, displayName, typeLabel, status ?? 'hint', JSON.stringify(sourceRefs ?? []));
    return this.getEntitySketch(id)!;
  }

  getEntitySketch(sketchId: string): WritingEntitySketch | undefined { /* ... */ }
  listEntitySketches(projectId: string, filter?: { status?: EntitySketchStatus; typeLabel?: string }): WritingEntitySketch[] { /* ... */ }

  /** 按名称查找候选实体（合并检测用） */
  findByName(projectId: string, displayName: string): WritingEntitySketch[] { /* ... */ }

  updateEntitySketch(sketchId: string, updates: {
    displayName?: string; typeLabel?: string; summary?: string | null;
    status?: EntitySketchStatus; coreEntityId?: string | null; coreKind?: string | null;
  }): void { /* ... */ }

  /** 合并实体：source 合并到 target */
  mergeSketches(sourceId: string, targetId: string): void {
    const stmt = this.db.prepare(`UPDATE writing_entity_sketches SET status = 'merged', updated_at = datetime('now') WHERE id = ?`);
    stmt.run(sourceId);
  }

  // =========================================================================
  // writing_pending_decisions
  // =========================================================================

  createDecision(projectId: string, kind: DecisionKind, title: string,
    description?: string, linkedObjectId?: string, linkedObjectType?: string): PendingDecisionItem {
    const id = makeId('wpdc');
    this.db.prepare(`INSERT INTO writing_pending_decisions (id, project_id, kind, title, description, linked_object_id, linked_object_type) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(id, projectId, kind, title, description ?? null, linkedObjectId ?? null, linkedObjectType ?? null);
    return this.getDecision(id)!;
  }

  getDecision(decisionId: string): PendingDecisionItem | undefined { /* ... */ }
  listPendingDecisions(projectId: string): PendingDecisionItem[] {
    return (this.db.prepare(
      "SELECT * FROM writing_pending_decisions WHERE project_id = ? AND status = 'open' AND deleted_at IS NULL ORDER BY created_at ASC"
    ).all(projectId) as PendingDecisionRow[]).map(rowToDecision);
  }

  resolveDecision(decisionId: string, status: 'resolved' | 'dismissed' | 'expired',
    resolutionNote?: string): void {
    // 乐观锁：仅在 status='open' 时更新，防止并发重复处理
    const result = this.db.prepare(
      `UPDATE writing_pending_decisions
       SET status = ?, resolved_at = datetime('now'), resolution_note = ?, updated_at = datetime('now')
       WHERE id = ? AND status = 'open'`
    ).run(status, resolutionNote ?? null, decisionId);
    if (result.changes === 0) {
      throw new Error(`Decision ${decisionId} is not open (already resolved or expired)`);
    }
  }

  // =========================================================================
  // writing_proposal_views
  // =========================================================================

  createProposalView(projectId: string, proposalType: ProposalType,
    sourceDraftId?: string, sourceEntitySketchId?: string): WritingProposalView {
    const id = makeId('wpvw');
    this.db.prepare(`INSERT INTO writing_proposal_views (id, project_id, proposal_type, source_draft_id, source_entity_sketch_id) VALUES (?, ?, ?, ?, ?)`)
      .run(id, projectId, proposalType, sourceDraftId ?? null, sourceEntitySketchId ?? null);
    return this.getProposalView(id)!;
  }

  getProposalView(viewId: string): WritingProposalView | undefined { /* ... */ }
  listProposalViews(projectId: string, filter?: { status?: ProposalViewStatus }): WritingProposalView[] { /* ... */ }

  updateProposalView(viewId: string, updates: {
    coreProposalId?: string | null; coreBridgeResult?: unknown;
    status?: ProposalViewStatus; humanSummary?: string | null;
    factDiff?: FactDiffEntry[]; involvedEntityIds?: string[];
    ruleWarnings?: RuleWarning[]; authorDecision?: string | null;
    coreEventId?: string | null; commitError?: unknown | null;
  }): void { /* ... */ }

  /** 来源草案修改导致审核过期 */
  expireProposalView(viewId: string): void {
    this.db.prepare("UPDATE writing_proposal_views SET status = 'expired', updated_at = datetime('now') WHERE id = ?").run(viewId);
  }

  // =========================================================================
  // writing_audit_logs
  // =========================================================================

  recordAudit(projectId: string, action: string, triggerSource: AuditTrigger,
    result: AuditResult, params?: {
      targetType?: string; targetId?: string; detail?: unknown;
      errorCode?: string; requestId?: string; sessionId?: string;
    }): WritingAuditLog {
    const id = makeId('waul');
    this.db.prepare(`INSERT INTO writing_audit_logs (id, project_id, action, target_type, target_id, trigger_source, result, detail_json, error_code, request_id, session_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, projectId, action, params?.targetType ?? null, params?.targetId ?? null,
        triggerSource, result, JSON.stringify(params?.detail ?? {}),
        params?.errorCode ?? null, params?.requestId ?? null, params?.sessionId ?? null);
    return this.getAuditLog(id)!;
  }

  getAuditLog(logId: string): WritingAuditLog | undefined { /* ... */ }
  queryAuditLogs(projectId: string, filter?: {
    action?: string; targetType?: string; targetId?: string; limit?: number;
  }): WritingAuditLog[] { /* ... */ }

  // =========================================================================
  // writing_core_refs
  // =========================================================================

  createCoreRef(projectId: string, writingObjectType: WritingObjectType,
    writingObjectId: string, coreObjectType: CoreObjectType,
    coreObjectId: string): WritingCoreRef {
    const id = makeId('wcref');
    // UPSERT: 同一写作对象对同一 Core 对象只保留一条引用
    this.db.prepare(`INSERT OR REPLACE INTO writing_core_refs (id, project_id, writing_object_type, writing_object_id, core_object_type, core_object_id, ref_status) VALUES (?, ?, ?, ?, ?, ?, 'active')`)
      .run(id, projectId, writingObjectType, writingObjectId, coreObjectType, coreObjectId);
    return this.getCoreRef(id)!;
  }

  getCoreRefsByWritingObject(writingObjectType: string, writingObjectId: string): WritingCoreRef[] { /* ... */ }
  getCoreRefsByCoreObject(coreObjectType: string, coreObjectId: string): WritingCoreRef[] { /* ... */ }

  markCoreRefStale(coreRefId: string): void {
    this.db.prepare("UPDATE writing_core_refs SET ref_status = 'stale', last_verified_at = datetime('now') WHERE id = ?").run(coreRefId);
  }

  markCoreRefBroken(coreRefId: string): void {
    this.db.prepare("UPDATE writing_core_refs SET ref_status = 'broken', last_verified_at = datetime('now') WHERE id = ?").run(coreRefId);
  }
}
```

**实现注意事项**：
- 每个 `get*` 方法自动过滤 `deleted_at IS NOT NULL`（软删除）
- `list*` 方法默认按 `created_at DESC` 排列
- `update*` 方法使用动态 SQL 拼接（与 agent-store.ts 的 `updateDraft` 模式一致）
- JSON 字段写入时 `JSON.stringify`，读取时 `safeParseJson`
- 参照现有 `agent-store.ts:349-359` 的 update 模式

---

## 17. 状态机校验函数

每个服务在执行状态变更前调用校验函数。校验不通过抛出 `WritingError`。

```ts
// src/writing/models/state-machine.ts

import { WritingErrorCode } from '../errors/error-codes.js';

export class StateMachineError extends Error {
  constructor(
    public code: string,
    public currentStatus: string,
    public targetStatus: string,
    public objectType: string,
    public objectId: string,
  ) {
    super(`状态跳转禁止: ${objectType}#${objectId} ${currentStatus} → ${targetStatus}`);
  }
}

// =========================================================================
// Draft 状态跳转校验
// =========================================================================

const DRAFT_TRANSITIONS: Record<string, string[]> = {
  'drafting':             ['ready_to_simulate', 'archived'],
  'ready_to_simulate':    ['simulated', 'drafting', 'archived'],
  'simulated':            ['committed', 'drafting', 'archived'],
  'committed':            [],                          // 不可逆
  'archived':             ['drafting'],                // 可恢复
  'error':                ['drafting', 'archived'],    // 可恢复
};

export function validateDraftTransition(
  currentStatus: string, targetStatus: string, draftId: string
): void {
  const allowed = DRAFT_TRANSITIONS[currentStatus];
  if (!allowed || !allowed.includes(targetStatus)) {
    throw new StateMachineError(
      WritingErrorCode.INVALID_STATUS_TRANSITION,
      currentStatus, targetStatus, 'WritingDraft', draftId,
    );
  }
}

// =========================================================================
// EntitySketch 状态跳转校验
// =========================================================================

const ENTITY_SKETCH_TRANSITIONS: Record<string, string[]> = {
  'hint':       ['candidate', 'deprecated'],
  'candidate':  ['approved', 'deprecated', 'merged'],
  'approved':   ['registered', 'deprecated', 'candidate'],  // candidate=退回
  'registered': ['deprecated'],          // 已注册不可逆（修改走 Retcon）
  'deprecated': ['candidate'],           // 可恢复
  'merged':     [],                      // 终态
  'error':      ['candidate', 'approved', 'deprecated'],
};

// =========================================================================
// WritingProject 状态跳转校验
// =========================================================================

const PROJECT_TRANSITIONS: Record<string, string[]> = {
  'planning':  ['drafting', 'reviewing', 'paused', 'archived'],
  'drafting':  ['reviewing', 'paused', 'archived'],
  'reviewing': ['drafting', 'paused', 'archived'],
  'paused':    ['planning', 'drafting', 'reviewing', 'archived'],
  'archived':  [],  // 终态
};

export function validateProjectTransition(
  currentStatus: string, targetStatus: string, projectId: string
): void {
  const allowed = PROJECT_TRANSITIONS[currentStatus];
  if (!allowed || !allowed.includes(targetStatus)) {
    throw new StateMachineError(
      WritingErrorCode.INVALID_STATUS_TRANSITION,
      currentStatus, targetStatus, 'WritingProject', projectId,
    );
  }
}

// =========================================================================
// IdeaCard 成熟度跳转校验
// =========================================================================

const IDEA_TRANSITIONS: Record<string, string[]> = {
  'raw':             ['candidate', 'archived'],
  'candidate':       ['structured', 'ready_for_draft', 'archived'],
  'structured':      ['ready_for_draft', 'archived'],
  'ready_for_draft': ['archived'],  // 转草案由 promoteIdeaToDraft 处理，不改变自身 maturity
  'archived':        ['raw'],       // 可恢复
};

export function validateIdeaTransition(
  currentMaturity: string, targetMaturity: string, ideaId: string
): void {
  const allowed = IDEA_TRANSITIONS[currentMaturity];
  if (!allowed || !allowed.includes(targetMaturity)) {
    throw new StateMachineError(
      WritingErrorCode.INVALID_STATUS_TRANSITION,
      currentMaturity, targetMaturity, 'IdeaCard', ideaId,
    );
  }
}

// =========================================================================
// ProjectBlueprint 成熟度跳转校验
// =========================================================================

const BLUEPRINT_TRANSITIONS: Record<string, string[]> = {
  'implicit':   ['drafted', 'archived'],
  'drafted':    ['reviewed', 'active', 'archived'],
  'reviewed':   ['active', 'evolving', 'drafted', 'archived'],
  'active':     ['evolving', 'archived'],
  'evolving':   ['active', 'drafted', 'archived'],
  'archived':   [],         // 终态
  'superseded': [],         // 被新版本替代，终态
};

export function validateBlueprintTransition(
  currentMaturity: string, targetMaturity: string, blueprintId: string
): void {
  const allowed = BLUEPRINT_TRANSITIONS[currentMaturity];
  if (!allowed || !allowed.includes(targetMaturity)) {
    throw new StateMachineError(
      WritingErrorCode.INVALID_STATUS_TRANSITION,
      currentMaturity, targetMaturity, 'ProjectBlueprint', blueprintId,
    );
  }
}

// =========================================================================
// EntitySketch 状态跳转校验
// =========================================================================

export function validateEntitySketchTransition(
  currentStatus: string, targetStatus: string, sketchId: string
): void {
  const allowed = ENTITY_SKETCH_TRANSITIONS[currentStatus];
  if (!allowed || !allowed.includes(targetStatus)) {
    throw new StateMachineError(
      WritingErrorCode.INVALID_STATUS_TRANSITION,
      currentStatus, targetStatus, 'WritingEntitySketch', sketchId,
    );
  }
}

// =========================================================================
// ProposalView 状态跳转校验
// =========================================================================

const PROPOSAL_VIEW_TRANSITIONS: Record<string, string[]> = {
  'open':              ['author_approved', 'author_rejected', 'expired'],
  'author_approved':   ['committed', 'commit_failed'],
  'author_rejected':   ['superseded'],
  'committed':         [],
  'commit_failed':     ['open'],              // 修复后重试
  'expired':           ['superseded'],
  'superseded':        [],
};

export function validateProposalViewTransition(
  currentStatus: string, targetStatus: string, viewId: string
): void {
  const allowed = PROPOSAL_VIEW_TRANSITIONS[currentStatus];
  if (!allowed || !allowed.includes(targetStatus)) {
    throw new StateMachineError(
      WritingErrorCode.INVALID_STATUS_TRANSITION,
      currentStatus, targetStatus, 'WritingProposalView', viewId,
    );
  }
}

// =========================================================================
// 复合校验（跨对象）
// =========================================================================

/**
 * 提交前校验：确保 ProposalView 状态为 author_approved，
 * 且来源草案未被修改、来源实体仍存在
 */
export function validateCommitReadiness(
  proposalView: WritingProposalView,
  sourceDraft?: WritingDraft,
): { valid: boolean; reason?: string } {
  if (proposalView.status !== 'author_approved') {
    return { valid: false, reason: '提案尚未获得作者批准' };
  }
  if (sourceDraft && proposalView.sourceDraftId) {
    if (sourceDraft.status === 'drafting' || sourceDraft.status === 'ready_to_simulate') {
      return { valid: false, reason: '来源草案在审核期间被修改，需要重新推演' };
    }
    if (sourceDraft.deletedAt) {
      return { valid: false, reason: '来源草案已被删除' };
    }
  }
  return { valid: true };
}

/**
 * 推演前校验：Draft 必须有内容、不能是 committed/archived
 */
export function validateDraftSimulationReadiness(draft: WritingDraft): { valid: boolean; reason?: string } {
  if (draft.status === 'committed') return { valid: false, reason: '草案已提交' };
  if (draft.status === 'archived') return { valid: false, reason: '草案已归档' };
  if (!draft.content || draft.content.trim().length === 0) return { valid: false, reason: '草案内容为空' };
  return { valid: true };
}
```

---

## 18. CoreBridge 真实实现规格

**策略变更（2026-06-13）**：不实现 MockCoreBridge。Core 是我们的代码，不是外部 API。所有测试使用真实 Core（:memory: SQLite + ToolRouter），跟现有的 `narrative-agent.test.ts` 一样。

### 18.1 测试策略

```
外部 API（需要 Mock）:
  - DeepSeek LLM         → MockLLMClient（已有）
  - Embedding 服务       → MockEmbedder

自己的代码（不用 Mock）:
  - Core Engine          → :memory: SQLite + 真实 ToolRouter
  - CoreBridgeService    → 真实包装 ToolRouter
  - WritingStore         → :memory: SQLite
  - 所有 Writing Layer 服务 → 真实实例
```

### 18.2 RealCoreBridge 实现

```ts
// src/writing/core-bridge/real-bridge.ts

import type { ToolRouter } from '../../core/tool-router.js';
import type {
  CoreBridgeService, SimulationResult, CommitResult,
  RegisterEntityResult, CoreErrorExplanation,
} from './core-bridge-service.js';

/**
 * RealCoreBridge — 包装 ToolRouter，所有调用走真实 Core。
 *
 * Agent 持有此实例但类型只暴露 CoreBridgeService 接口。
 * Agent 在类型层面就无法调用 commit/register 方法（接口不包含）。
 */
export class RealCoreBridge implements CoreBridgeService {
  private toolRouter: ToolRouter;

  constructor(toolRouter: ToolRouter) {
    this.toolRouter = toolRouter;
  }

  // =========================================================================
  // 沙盒/只读（Agent 可调用）
  // =========================================================================

  async simulateDraftAsEvent(projectId: string, params: {
    draftId: string; eventDescription: string; eventType: string;
    chapter: number; factChanges: unknown[];
  }): Promise<SimulationResult> {
    const result = await this.toolRouter.execute('propose_event', {
      event_type: params.eventType,
      event_description: params.eventDescription,
      chapter: params.chapter,
      fact_changes: params.factChanges,
      context: 'global',
    });

    return {
      proposalId: result.proposal_id,
      isSafeToCommit: result.is_safe_to_commit,
      report: result.simulation_report_markdown,
    };
  }

  async simulateProposal(projectId: string, proposalViewId: string): Promise<SimulationResult> {
    // 重新推演：需要从 ProposalView 获取原始参数，然后重调 propose_event
    // Phase 7 简化：直接调用 simulateDraftAsEvent 的逻辑
    throw new Error('simulateProposal: Phase 7 暂未实现重新推演逻辑');
  }

  async readCurrentWorldSnapshot(projectId: string): Promise<unknown> {
    // 调用 Core 查询接口获取全局快照
    const result = await this.toolRouter.execute('get_context_slice', {
      entity_id: null, // 全局查询
      current_chapter: 1,
      include_relations: true,
    });
    return result;
  }

  explainCoreFailure(error: unknown): CoreErrorExplanation {
    // 将 Core 错误码转为人话
    const err = error as { code?: string; message?: string };
    return {
      errorCode: err.code ?? 'UNKNOWN',
      humanMessage: err.message ?? '未知 Core 错误',
      suggestedActions: ['重试操作', '检查参数'],
      isRecoverable: true,
    };
  }

  // =========================================================================
  // 写入（仅 CLI 确认通道调用，Agent 类型层面不可见）
  // =========================================================================

  async commitReviewedProposal(projectId: string, proposalViewId: string): Promise<CommitResult> {
    try {
      const result = await this.toolRouter.execute('commit_event', {
        proposal_id: proposalViewId,
      });
      return {
        success: result.status === 'success',
        coreEventId: result.committed_event_id,
      };
    } catch (error) {
      return {
        success: false,
        error: this.explainCoreFailure(error),
      };
    }
  }

  async registerReviewedEntity(projectId: string, sketchId: string): Promise<RegisterEntityResult> {
    try {
      const result = await this.toolRouter.execute('register_entity', {
        name: sketchId, // 调用方会替换为实际名称
        kind: 'entity',
        chapter: 1,
      });
      return {
        success: true,
        coreEntityId: result.entity_id,
        coreKind: result.kind ?? 'entity',
      };
    } catch (error) {
      return {
        success: false,
        error: this.explainCoreFailure(error),
      };
    }
  }
}
```

### 18.3 测试中的 CLI 确认通道实现

测试不 Mock Core，直接使用 `RealCoreBridge` + `:memory:` SQLite。

```ts
// tests/writing/writing-main-loop.test.ts 示例结构

import Database from 'better-sqlite3';
import { SQLiteFactStoreAdapter } from '../../src/adapters/sqlite/fact-store.js';
import { SQLiteWritingStore } from '../../src/writing/repositories/writing-store.js';
import { ToolRouter } from '../../src/core/tool-router.js';
import { RealCoreBridge } from '../../src/writing/core-bridge/real-bridge.js';
import { ProjectService } from '../../src/writing/services/project-service.js';
// ... 其他服务

function setupWritingTestEnv() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Core 层
  const factStore = new SQLiteFactStoreAdapter(':memory:', 'test-project');
  const toolRouter = new ToolRouter(factStore, /* 其他 Core 依赖 */);

  // 写作层
  const writingStore = new SQLiteWritingStore(factStore.getDatabase());
  writingStore.createTables();

  // CoreBridge（真实包装 ToolRouter）
  const coreBridge = new RealCoreBridge(toolRouter);

  // 服务层
  const auditService = new AuditService(writingStore);
  const workflowService = new WorkflowService(writingStore, auditService);
  const projectService = new ProjectService(writingStore, auditService);
  const draftService = new DraftService(writingStore, auditService, coreBridge, workflowService);
  const entityService = new EntityService(writingStore, auditService, workflowService);
  // ...

  return { writingStore, coreBridge, projectService, draftService, entityService, workflowService };
}
```

## 19. 测试夹具与最低验收用例

### 19.1 灰域科幻样例项目数据

```ts
// tests/writing/fixtures/grey-domain-fixture.ts

export const GREY_DOMAIN_PROJECT_ID = 'wprj_grey_domain_test';

export const GREY_DOMAIN_PREMISE = `
一对兄妹在废弃星球首府的灰域边缘求生。
哥哥沈墨有嵌合体义肢。
妹妹沈笙能让灰域短暂退缩。
灰域调查局正在寻找这种能力。
黑晶碎片会在靠近灰域异常时发热。
`;

export const GREY_DOMAIN_BLUEPRINT_TYPES = {
  entityTypes: [
    { id: 'type_char', label: '角色', status: 'accepted', sourceRefs: [] },
    { id: 'type_loc', label: '地点', status: 'accepted', sourceRefs: [] },
    { id: 'type_faction', label: '组织', status: 'accepted', sourceRefs: [] },
    { id: 'type_item', label: '物品', status: 'accepted', sourceRefs: [] },
    { id: 'type_anomaly', label: '异常现象', status: 'accepted', sourceRefs: [] },
  ],
  relationTypes: [
    { id: 'rel_shelter', label: '庇护', status: 'accepted', sourceRefs: [] },
    { id: 'rel_pursue', label: '追捕', status: 'accepted', sourceRefs: [] },
    { id: 'rel_erode', label: '侵蚀', status: 'accepted', sourceRefs: [] },
  ],
};

export const SAMPLE_PROSE = `
长庚站的扶梯早就停了。沈墨把沈笙拉到广告牌后面，左臂义肢的关节在冷风里轻轻咬合。
红区方向传来低频震动，黑晶碎片贴着他的掌心发热。
沈笙抬头看了一眼灰雾，灰雾像被什么看不见的手推开，露出一截旧轨道。
远处的调查局无人机转向了他们。
`;
```

### 19.2 Phase 7 最低测试清单

```ts
// tests/writing/writing-loop-e2e.test.ts — 主闭环测试

describe('Phase 7 主闭环', () => {

  // WL-E2E-001: 创建作品不写 Core
  it('创建作品后 Core Fact 数量不变', async () => {
    const { store, coreBridge } = setupTestEnv();
    const projectService = new ProjectService(store, auditService);

    const project = await projectService.createProject(ctx, {
      title: '灰域科幻', premise: GREY_DOMAIN_PREMISE,
    });

    expect(project.status).toBe('planning');
    // Core 无任何写入
    expect(coreBridge.commitCalled).toBe(false);
    expect(coreBridge.registerCalled).toBe(false);
  });

  // WL-E2E-002: 灵感→草案→候选实体（全写作层，不写 Core）
  it('灵感保存和候选实体不写 Core', async () => {
    const idea = await ideaService.captureIdea(ctx, {
      content: GREY_DOMAIN_PREMISE, kind: 'premise',
    });
    expect(idea.maturity).toBe('raw');

    const hints = await entityService.detectEntityHints(ctx, SAMPLE_PROSE);
    // 发现提示，不是候选
    expect(hints.every(h => h.status === 'hint')).toBe(true);
  });

  // WL-E2E-003: 候选实体注册→必须经过 approved
  it('候选实体不能直接注册到 Core', async () => {
    const sketch = await entityService.promoteHintToSketch(ctx, hintId, {
      displayName: '沈墨', typeLabel: '角色',
    });
    expect(sketch.status).toBe('candidate');

    // 直接调 registerReviewedEntity 应该被状态机拒绝
    // （因为 approved 状态的实体不存在 coreEntityId）
    expect(sketch.coreEntityId).toBeUndefined();
  });

  // WL-E2E-004: 草案推演→只调 propose，不调 commit
  it('草案推演只调 propose_event，不调 commit_event', async () => {
    const draft = await draftService.createDraft(ctx, {
      kind: 'event', content: SAMPLE_PROSE,
    });
    await draftService.markReadyForSimulation(ctx, draft.id);

    const { proposalView } = await draftService.simulateDraft(ctx, draft.id);

    expect(proposalView.status).toBe('open');
    expect(proposalView.coreProposalId).toBeDefined();
    // commit 未调用
    expect(coreBridge.commitCalled).toBe(false);
  });

  // WL-E2E-005: Proposal Review 确认→提交→回写
  it('作者确认后提交成功，草案状态回写为 committed', async () => {
    // 前序：draft → simulated → review
    const decision = await workflowService.createPendingDecision(ctx, {
      kind: 'confirm_proposal',
      title: '确认提交事件',
      linkedObjectId: proposalView.id,
      linkedObjectType: 'proposal_view',
    });

    // 用户确认
    await workflowService.resolvePendingDecision(ctx, decision.id, {
      status: 'resolved', note: '确认提交',
    });
    const result = await coreBridge.commitReviewedProposal(ctx, proposalView.id);
    expect(result.success).toBe(true);

    await draftService._markCommitted(draft.id, result.coreEventId!);
    const updated = await draftService.getDraftEditorView(ctx, draft.id);
    expect(updated.status).toBe('committed');
  });

  // WL-E2E-012: 禁止路径测试
  it('Agent 调用 commitReviewedProposal 被拒绝', async () => {
    const perm = AGENT_PERMISSIONS['CoreBridgeService.commitReviewedProposal'];
    expect(perm).toBe(AgentCapability.COMMIT_FORBIDDEN);
  });

  it('drafting 状态草案不能直接标记为 committed', () => {
    expect(() => validateDraftTransition('drafting', 'committed', 'test'))
      .toThrow(StateMachineError);
  });

  it('hint 状态实体不能直接注册', () => {
    expect(() => validateEntitySketchTransition('hint', 'registered', 'test'))
      .toThrow(StateMachineError);
  });

  // WL-E2E-015: 普通作者视图过滤
  it('普通作者不看到技术字段', async () => {
    const vm = await getProjectHomeView(ctx, 'normal');
    const json = JSON.stringify(vm);
    // 禁止字段检查
    expect(json).not.toContain('EntityKind');
    expect(json).not.toContain('RelationKind');
    expect(json).not.toContain('coreEntityId');
    expect(json).not.toContain('predicate');
    expect(json).not.toContain('fct_');
  });

  // CoreBridge 失败恢复
  it('CoreBridge 提交失败时写作层不回写 committed', async () => {
    coreBridge.commitShouldFail = true;
    const result = await coreBridge.commitReviewedProposal(ctx, proposalView.id);
    expect(result.success).toBe(false);
    // 草案状态不变
    const draft = await draftService.getDraftEditorView(ctx, draft.id);
    expect(draft.status).not.toBe('committed');
  });

  // 审核过期
  it('草案修改后 ProposalReview 标记为过期', async () => {
    // draft 已 simulated，review 已 open
    await draftService.updateDraftContent(ctx, draft.id, '修改后的内容');
    // 应在 updateDraftContent 内部自动 expire 相关 ProposalView
    const pv = await coreBridge.getProposalView(reviewId);
    expect(pv.status).toBe('expired');
  });
});
```

---

## 20. 实现状态追踪

| Step | 内容 | 状态 | 备注 |
|------|------|:--:|------|
| A1 | writing-store.ts DDL | ✅ | 含 chapter 字段 + 乐观锁 |
| A2 | models/types.ts | ✅ | 11 个领域类型 |
| A3 | models/source-ref.ts | ✅ | |
| A4 | errors/error-codes.ts | ✅ | 17 个错误码 |
| A5 | services/context.ts | ✅ | WritingRequestContext |
| A6 | audit-service.ts | ✅ | |
| A7 | project-service.ts | ✅ | |
| A8 | idea-service.ts | ✅ | |
| A9 | draft-service.ts | ✅ | simulateDraft + 自动副作用 |
| A10 | entity-service.ts | ✅ | detectHints + approve + deprecate |
| A11 | core-bridge/interface.ts | ✅ | CoreBridgeService 接口 |
| A12 | workflow-service.ts | ✅ | 含乐观锁 resolve |
| A13 | blueprint-service.ts | ✅ | 含去重 + accept/reject |
| A14 | core-bridge/real-bridge.ts | ✅ | 真实包装 ToolRouter |
| ⬜ | agent 改造 + CLI 确认通道 | ⬜ | §8 |
| ⬜ | 端到端测试（:memory: SQLite + 真实 Core） | ⬜ | §18-19 |

---

*本文档将持续更新，每解决一个问题就追记决策和理由。*

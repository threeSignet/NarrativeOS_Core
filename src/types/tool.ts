// =============================================================================
// Tool Interface 输入/输出类型 + 错误编码体系
// =============================================================================
// §11: 10 个 Tool 的输入/输出类型
// §17: ToolErrorCode / ToolError / ToolResult / ChapterLevelWarning

import type { FactIndexEntry, FactChangeInput } from './fact.js';
import type { NarrativeThread } from './thread.js';
import type { KnowledgeSource, KnowledgeChangeInput } from './knowledge.js';
import type { NarrativeEvent } from './event.js';
import type { EntityKind, EntityRecord } from './entity.js';
import type { EventConsequence, DeclarativeRule } from './rule.js';
import type { PredicateDefinition } from './world.js';

// =============================================================================
// Tool 1: get_context_slice
// =============================================================================

/** Tool 1: get_context_slice 的返回值 */
export interface ContextSliceResult {
  profile_markdown: string;              // FactRenderer 渲染的实体档案
  fact_index: FactIndexEntry[];          // 底层 Fact 索引
  retrieval_telemetry?: RetrievalTelemetry; // 可观测性信号
}

/** 检索管线可观测性信号 */
export interface RetrievalTelemetry {
  active_mode: 'semantic' | 'hybrid' | 'exact_only';
  lance_db_sync_lag_ms: number;
  step0_hit_rate_window: number;
}

// =============================================================================
// Tool 2: propose_event
// =============================================================================

/** 知识可见性细粒度推断 */
export interface KnowledgeHint {
  entityId: string;         // 谁获得了新知识
  factIndex?: number;       // 对应 fact_changes 中的哪条（省略=所有）
  source: KnowledgeSource;
  confidence: number;
}

/** 知识可见性粗粒度广播 */
export interface KnowledgeBroadcast {
  visibility: 'explicit_entities' | 'faction_members' | 'scene_participants';
  target_entity_ids?: string[];
  target_faction_id?: string;
  confidence: number;
  source: KnowledgeSource;
}

/** Tool 2: propose_event 的参数 */
export interface ProposeEventInput {
  event_type: string;
  event_description: string;
  chapter: number;
  fact_changes: FactChangeInput[];
  context?: string;
  exit_from?: string;
  thread_resolutions?: string[];
  knowledge_hints?: KnowledgeHint[];
  knowledge_broadcast?: KnowledgeBroadcast;
  knowledge_changes?: KnowledgeChangeInput[];
  dependent_fact_ids?: string[];
}

/** Tool 2: propose_event 的返回值 */
export interface ProposalResult {
  proposalId: string;
  expectedStateVersion: number;          // propose_event 读取到的 project_state.state_version
  isSafeToCommit: boolean;
  consequences: EventConsequence;
  simulationReportMarkdown: string;      // FactRenderer 渲染的审计报告
  newFactIds?: Record<string, string>;   // change_id → new_fact_id 映射
  proposedEvent: Omit<NarrativeEvent, 'id'>; // commit_event 必须复用 Phase A 的事件上下文
  dependentFactIds: string[];            // Phase 1 轻量依赖声明，提交时写入 event_dependencies
  dependentFactSources: Record<string, 'llm' | 'system_exit_scope' | 'rule_inference'>; // factId → 依赖来源
  knowledgeChanges: KnowledgeChangeInput[]; // 显式认知操作，Phase B 在自动传播之后写入
  knowledgeHints?: KnowledgeHint[];        // Phase 2D：LLM 细粒度知识提示（tier 3）
  knowledgeBroadcast?: KnowledgeBroadcast; // Phase 2D：LLM 粗粒度知识广播（tier 2）
}

// =============================================================================
// Tool 3: commit_event
// =============================================================================

/** Tool 3: commit_event 的参数 */
export interface CommitEventInput {
  proposal_id: string;
}

/** Tool 3: commit_event 的返回值 */
export interface CommitEventResult {
  event_id: string;
  committed_fact_count: number;
  committed_knowledge_count: number;
  affected_threads: string[];
}

// =============================================================================
// Tool 4/5: propose_retcon / commit_retcon
// =============================================================================

/** Tool 4: propose_retcon 的参数 */
export interface ProposeRetconInput {
  target_event_id: string;
  reason: string;
  chapter: number;
}

/** Tool 4: propose_retcon 的返回值 */
export interface ProposeRetconResult {
  proposal_id: string;
  affected_facts: string[];
  affected_knowledge_ids: string[];
  affected_thread_ids: string[];
  cascade_report_markdown: string;
  is_safe_to_commit: boolean;
}

/** Tool 5: commit_retcon 的参数 */
export interface CommitRetconInput {
  retcon_proposal_id: string;
}

// =============================================================================
// Tool 6: register_entity
// =============================================================================

/** Tool 6: register_entity 的参数 */
export interface RegisterEntityInput {
  name: string;
  kind: EntityKind;
  description?: string;
  chapter: number;
  tags?: string[];
}

/** Tool 6: register_entity 的返回值 */
export interface RegisterEntityResult {
  entity_id: string;
  entity: EntityRecord;
}

// =============================================================================
// Tool 7: get_open_threads
// =============================================================================

/** Tool 7: get_open_threads 的返回值 */
export interface OpenThreadsResult {
  threads: NarrativeThread[];
  summary_markdown: string;
}

// =============================================================================
// Tool 8: resolve_thread
// =============================================================================

/** Tool 8: resolve_thread 的参数 */
export interface ResolveThreadInput {
  thread_id: string;
  resolution: 'fill' | 'abandon' | 'hint' | 'partially_reveal' | 'resolve';
  description: string;
  event_id?: string;
  chapter: number;
}

// =============================================================================
// Tool 9/10: propose_schema_extension / commit_schema_extension
// =============================================================================

/** Tool 9: propose_schema_extension 的参数 */
export interface ProposeSchemaExtensionInput {
  chapter: number;
  new_predicates?: Omit<PredicateDefinition, 'deprecated'>[];
  new_rules?: DeclarativeRule[];
}

/** Tool 10: commit_schema_extension 的参数 */
export interface CommitSchemaExtensionInput {
  proposal_id: string;
}

// =============================================================================
// 错误编码体系
// =============================================================================

/**
 * Tool 错误码（20 个），覆盖所有已知的失败模式
 *
 * 分类：
 *   - 1000-1999: 验证错误
 *   - 2000-2999: 资源/状态冲突
 *   - 3000-3999: 系统错误
 */
export enum ToolErrorCode {
  // ---- 验证错误 (10xx) ----
  SCHEMA_VALIDATION_FAILED = 'SCHEMA_VALIDATION_FAILED',
  UNKNOWN_TOOL = 'UNKNOWN_TOOL',
  UNKNOWN_PREDICATE = 'UNKNOWN_PREDICATE',
  INVALID_ENUM_VALUE = 'INVALID_ENUM_VALUE',
  TYPE_MISMATCH = 'TYPE_MISMATCH',
  ENTITY_NOT_FOUND = 'ENTITY_NOT_FOUND',
  FACT_NOT_FOUND = 'FACT_NOT_FOUND',
  FACT_NOT_CURRENT = 'FACT_NOT_CURRENT',
  FACT_ID_FABRICATED = 'FACT_ID_FABRICATED',
  PROPOSAL_NOT_FOUND = 'PROPOSAL_NOT_FOUND',
  SCOPE_FACT_MISMATCH = 'SCOPE_FACT_MISMATCH',

  // ---- 冲突/逻辑错误 (20xx) ----
  PREDICATE_CONFLICT = 'PREDICATE_CONFLICT',
  STATE_VERSION_CONFLICT = 'STATE_VERSION_CONFLICT',
  STALE_PROPOSAL = 'STALE_PROPOSAL',
  LOGIC_CONFLICT = 'LOGIC_CONFLICT',
  RULE_VIOLATION = 'RULE_VIOLATION',
  SCOPE_RULE_VIOLATION = 'SCOPE_RULE_VIOLATION',

  // ---- 系统错误 (30xx) ----
  TRANSACTION_FAILED = 'TRANSACTION_FAILED',
  EMBEDDING_API_ERROR = 'EMBEDDING_API_ERROR',
  LANCEDB_ERROR = 'LANCEDB_ERROR',
  LLM_API_ERROR = 'LLM_API_ERROR',
}

/** 章节级别告警（非阻塞，但注入 LLM 提示） */
export type ChapterLevelWarning =
  | 'STALE_RETRIEVAL'       // 检索延迟 > 1s
  | 'LANCE_DB_DEGRADED'    // LanceDB 不可用
  | 'SPIKE_1_RECALL_LOW';  // 语义检索 Recall < 40%

/**
 * Tool 错误结果
 */
export interface ToolError {
  code: ToolErrorCode;
  message: string;
  detail?: string;          // 详细错误信息（如哪个字段校验失败）
  retryable: boolean;       // 是否可重试（L1 自修复判定依据）
  correctionHint?: string;  // 纠错指导（注入 LLM 的下一步建议）
}

/**
 * Tool 调用结果泛型：成功返回 T，失败返回 ToolError
 */
export type ToolResult<T> = { success: true; data: T } | { success: false; error: ToolError };

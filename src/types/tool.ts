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
  // ---- 验证/参数错误 (10xx)：LLM 可自行修复后重试 ----
  SCHEMA_VALIDATION_FAILED = 'SCHEMA_VALIDATION_FAILED',
  UNKNOWN_TOOL = 'UNKNOWN_TOOL',
  UNKNOWN_PREDICATE = 'UNKNOWN_PREDICATE',
  INVALID_ENUM_VALUE = 'INVALID_ENUM_VALUE',
  TYPE_MISMATCH = 'TYPE_MISMATCH',
  INVALID_CHAPTER = 'INVALID_CHAPTER',             // §9.3: chapter 参数不合法（非正整数、非单调递增）
  ENTITY_NOT_FOUND = 'ENTITY_NOT_FOUND',
  FACT_NOT_FOUND = 'FACT_NOT_FOUND',
  FACT_NOT_CURRENT = 'FACT_NOT_CURRENT',
  FACT_ID_FABRICATED = 'FACT_ID_FABRICATED',
  PROPOSAL_NOT_FOUND = 'PROPOSAL_NOT_FOUND',
  SCOPE_FACT_MISMATCH = 'SCOPE_FACT_MISMATCH',
  THREAD_NOT_FOUND = 'THREAD_NOT_FOUND',           // §9.3: resolve_thread 时 thread_id 不存在
  THREAD_ALREADY_CLOSED = 'THREAD_ALREADY_CLOSED', // §9.3: resolve_thread 时线索已关闭
  EXTENSION_NOT_FOUND = 'EXTENSION_NOT_FOUND',     // §9.3: commit_schema_extension 时 extension 不存在
  KNOWLEDGE_TARGET_MISSING = 'KNOWLEDGE_TARGET_MISSING', // §9.3: 记忆操作目标范围内无 Knowledge 记录
  RULE_JSON_INVALID = 'RULE_JSON_INVALID',         // §9.3: 声明式规则 JSON 格式错误
  TEMPLATE_PARENT_NOT_FOUND = 'TEMPLATE_PARENT_NOT_FOUND', // §9.3: extends 的父模板不存在

  // ---- 冲突/逻辑错误 (20xx)：LLM 需调整策略后重试 ----
  PREDICATE_CONFLICT = 'PREDICATE_CONFLICT',
  STATE_VERSION_CONFLICT = 'STATE_VERSION_CONFLICT',
  STALE_PROPOSAL = 'STALE_PROPOSAL',
  LOGIC_CONFLICT = 'LOGIC_CONFLICT',
  RULE_VIOLATION = 'RULE_VIOLATION',
  SCOPE_RULE_VIOLATION = 'SCOPE_RULE_VIOLATION',
  DUPLICATE_ENTITY = 'DUPLICATE_ENTITY',           // §9.3: register_entity 时实体已存在（非致命）
  RETCON_CASCADE_TOO_DEEP = 'RETCON_CASCADE_TOO_DEEP', // §9.3: Retcon 级联超安全阈值
  SCHEMA_EXTENSION_CONFLICT = 'SCHEMA_EXTENSION_CONFLICT', // §9.3: 扩展与现有 WP 冲突

  // ---- 系统错误 (30xx)：一般不可重试，需人工介入 ----
  TRANSACTION_FAILED = 'TRANSACTION_FAILED',
  INTERNAL_ERROR = 'INTERNAL_ERROR',               // §9.3: 未预期的内部错误（SQLite 异常等）
  EMBEDDING_API_ERROR = 'EMBEDDING_API_ERROR',
  EMBEDDING_SERVICE_UNAVAILABLE = 'EMBEDDING_SERVICE_UNAVAILABLE', // §9.3: Embedding API 不可用
  LANCEDB_ERROR = 'LANCEDB_ERROR',
  LLM_API_ERROR = 'LLM_API_ERROR',

  // ---- 权限错误（Agent 适配层 §8.3）：仅由 Agent 工具权限门控抛出，Core 内部永不抛出 ----
  /**
   * Agent 的 ReAct 循环禁止直接调用 commit_event。
   * 提交须经用户在 Proposal Review 通道确认后由系统执行（§8.0/§8.2.1）。
   *
   * 注意：这与 WritingErrorCode.AGENT_COMMIT_FORBIDDEN 是两道不同的门——
   *   - 本码（ToolErrorCode）：LLM 工具调用层拦截，流经 ToolResult
   *   - WritingErrorCode 同名码：CoreBridge 方法调用层拦截（W2 接入），流经写作层错误包装
   */
  AGENT_COMMIT_FORBIDDEN = 'AGENT_COMMIT_FORBIDDEN',

  /**
   * Agent 的 ReAct 循环禁止直接调用 register_entity。
   * 实体注册须经审核通道（detectEntityHints → EntitySketch 审批）后由系统执行（§25 #7）。
   * 与 AGENT_COMMIT_FORBIDDEN 并列：提交类 vs 注册类，消息与引导文案不同。
   */
  AGENT_REGISTER_FORBIDDEN = 'AGENT_REGISTER_FORBIDDEN',
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

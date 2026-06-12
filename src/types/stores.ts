// =============================================================================
// 适配器接口 — 所有 Store 接口 + 查询引擎 + 过滤条件
// =============================================================================
// §12: FactStore / ThreadStore / KnowledgeStore / EventStore / ProposalStore
//      Query types / Filter types / NarrativeQueryEngine

import type { Fact, FactChange, FactGroup, FactIndexEntry } from './fact.js';
import type { FactValue } from './base.js';
import type { NarrativeThread, ThreadMilestone, ThreadDirection, ThreadType, ThreadStatus } from './thread.js';
import type { Knowledge, KnowledgeChangeInput, KnowledgeSource } from './knowledge.js';
import type { NarrativeEvent, EventKindFilter } from './event.js';
import type { EntityRecord, EntityKind, RelationKind } from './entity.js';
import type { Certainty } from './base.js';
import type { ProposalResult } from './tool.js';
import type { VectorEntry, VectorQuery, ScoredFact } from './vector.js';

// =============================================================================
// FactStore
// =============================================================================

/**
 * FactStore：时序三元组存储层核心接口
 *
 * 以时间为第一维度的三元组存储，不是图数据库。
 * 四级索引：subject→predicate→Fact[] / causeEvent→Fact[] / factId→Fact / targetEntityId→Fact[]
 * 实现为 SQLiteFactStoreAdapter（better-sqlite3），接口层保持不变以便替换存储后端。
 */
export interface FactStore {
  // ---- 写入 ----
  assert(fact: Omit<Fact, 'id' | 'embeddingText'>): Fact;
  retract(factId: string, validTo: number): void;
  update(
    factId: string,
    newValue: FactValue,
    newCauseEvent: string,
    validFrom: number,
    context?: string
  ): Fact;
  applyFactGroup(group: FactGroup): Map<string, string>; // changeId → factId 映射
  forceRemove(factId: string): void; // 仅供事务回滚使用

  // ---- Retcon ----
  markContested(factIds: string[], causeEvent: string): number; // 批量标记 contested，返回实际更新行数
  updateCertainty(factId: string, certainty: Certainty): void;  // 单条确定性变更（用于重置等）

  // ---- 查询 ----
  query(query: FactQuery): Fact[];
  getSnapshot(subject: string, atChapter: number): Record<string, FactValue>;
  getFactsByEvent(eventId: string): Fact[];
  getById(factId: string): Fact | undefined;
  getRelationsTargeting(entityId: string, atChapter?: number): Fact[];

  // ---- 乐观锁 ----
  getStateVersion(projectId: string): number;                         // 获取项目当前乐观锁版本号
  tryUpdateStateVersion(projectId: string, expectedVersion: number): boolean; // 条件递增，返回是否成功
}

/** Fact 查询条件 */
export interface FactQuery {
  subject?: string;
  predicate?: string;
  atChapter?: number;
  certainties?: Certainty[];
  relationKind?: RelationKind;
  valueEntityRef?: string;
  context?: string;
  includeInherited?: boolean;
  mode?: 'current' | 'history';
  includeInactive?: boolean;
}

/** Fact 查询条件；Phase 1.5A 复用底层 FactQuery 语义 */
export type FactFilter = FactQuery;

// =============================================================================
// ThreadStore
// =============================================================================

/**
 * ThreadStore：叙事线索存储接口
 *
 * 与 FactStore 共享同一个 SQLite 连接（同库不同表），但接口层面职责完全分离。
 * NarrativeThread 与 Fact 本质不同：Fact 不可变，Thread 有状态流转和生命周期里程碑。
 */
export interface ThreadStore {
  create(thread: Omit<NarrativeThread, 'id'>): NarrativeThread;
  updateStatus(threadId: string, status: ThreadStatus, closedBy?: string): void;
  addMilestone(threadId: string, milestone: Omit<ThreadMilestone, 'id'>): void;
  getOpen(): NarrativeThread[];
  getById(threadId: string): NarrativeThread | undefined;
  getByFilters(filters: ThreadFilter): NarrativeThread[];
}

/** Thread 过滤条件 */
export interface ThreadFilter {
  direction?: ThreadDirection;
  type?: ThreadType[];
  severity?: ('minor' | 'major' | 'critical')[];
  status?: ThreadStatus[];
  nearChapter?: number;
  window?: number;
  closedByEvent?: string;
  relatedEntity?: string;
  arcTag?: string;
  excludeArcTags?: string[];
}

// =============================================================================
// KnowledgeStore
// =============================================================================

/**
 * KnowledgeStore：知识可见性存储接口
 *
 * 与 FactStore 共享同一个 SQLite 连接（同库不同表）。
 * Knowledge 遵循与 Fact 相同的 Event Sourcing 原则——不能删除，只能通过新事件覆盖或封印。
 */
export interface KnowledgeStore {
  create(knowledge: Omit<Knowledge, 'id'>): Knowledge;
  batchCreate(entries: Omit<Knowledge, 'id'>[]): Knowledge[];
  getKnownFacts(entityId: string, atChapter?: number): Knowledge[];
  getActiveKnowledge(entityId: string, atChapter?: number): Knowledge[];
  getKnowersOfFact(factId: string): Knowledge[];
  getByFactId(factId: string): Knowledge[];
  updateConfidence(knowledgeId: string, confidence: number, updatedByEvent?: string): void;
  query(filter: KnowledgeFilter): Knowledge[];
}

/** Knowledge 过滤条件 */
export interface KnowledgeFilter {
  entityId?: string;
  factId?: string;
  source?: KnowledgeSource[];
  minConfidence?: number;
  atChapter?: number;
}

/**
 * Knowledge 查询条件。
 *
 * 默认返回当前有效认知：对同一 (entityId, factId) 取最新记录，并过滤 confidence <= 0。
 * includeHistory=true 时返回 Store 层匹配的全部历史记录，不做 (entityId, factId) 最新态去重；
 *   封印记录是否出现仍由 includeSealed 控制。
 * includeSealed=true 时保留 confidence=0 的封印记录。
 */
export interface NarrativeKnowledgeFilter extends KnowledgeFilter {
  factSubject?: string;
  factPredicate?: string;
  includeHistory?: boolean;
  includeSealed?: boolean;
}

// =============================================================================
// EventStore
// =============================================================================

/**
 * EventStore：事件存储接口
 *
 * Retcon BFS 级联遍历和事件溯源的前置依赖。
 * 与 FactStore 共享同一个 SQLite 连接，使用独立的 events 表。
 */
export interface EventStore {
  create(event: Omit<NarrativeEvent, 'id'>): NarrativeEvent;
  getById(eventId: string): NarrativeEvent | undefined;
  getByChapterRange(fromChapter: number, toChapter?: number, kind?: EventKindFilter): NarrativeEvent[];
  getBySubject(entityId: string, fromChapter?: number, kind?: EventKindFilter): NarrativeEvent[];
  getByType(eventType: string, fromChapter?: number, kind?: EventKindFilter): NarrativeEvent[];
  getByDependentFactIds(factIds: string[], kind?: EventKindFilter): NarrativeEvent[];
}

// =============================================================================
// Entity / Event 过滤器 (Phase 1.5A 查询层)
// =============================================================================

/** Entity 查询条件（Phase 1.5A 简版，直接读取 entities 表） */
export interface EntityFilter {
  id?: string;
  name?: string;
  nameContains?: string;
  kind?: EntityKind | EntityKind[];
  appearedBefore?: number;
  appearedAfter?: number;
}

/** Event 查询条件（Phase 1.5A 简版，封装 EventStore） */
export interface EventFilter {
  id?: string;
  type?: string;
  subject?: string;
  fromChapter?: number;
  toChapter?: number;
  kind?: EventKindFilter;
  dependentFactIds?: string[];
}

// =============================================================================
// NarrativeQueryEngine (Phase 1.5A 只读查询层)
// =============================================================================

/** Phase 1.5A 只读查询层；findThreads 等 Phase 2 ThreadStore + ThreadResolver 就绪后接入 */
export interface NarrativeQueryEngine {
  findFacts(filter: FactFilter): Promise<Fact[]>;
  findKnowledge(filter: NarrativeKnowledgeFilter): Promise<Knowledge[]>;
  findEvents(filter: EventFilter): Promise<NarrativeEvent[]>;
  findEntities(filter: EntityFilter): Promise<EntityRecord[]>;
  findThreads(filter: ThreadFilter): Promise<NarrativeThread[]>;
}

// =============================================================================
// ProposalStore
// =============================================================================

/**
 * ProposalStore：提案存储接口
 *
 * Proposal 是 propose_event 和 commit_event 之间的临时数据。
 * 使用内存 Map 实现，进程重启后清空（LLM 需重新 propose）。
 */
// 前向声明以避免循环导入
export interface ProposalStore {
  save(proposal: ProposalResult, originalFactChanges?: FactChange[]): void;
  get(proposalId: string): ProposalResult | undefined;
  getOriginalChanges(proposalId: string): FactChange[];
  remove(proposalId: string): void;
  expireStale(currentChapter: number, maxAge?: number): void;
}

// =============================================================================
// VectorStore
// =============================================================================

/**
 * VectorStore：向量存储接口
 *
 * LanceDB 的抽象接口，用于语义检索。
 * 实现为 LanceDBTableAdapter。
 */
export interface VectorStore {
  init(): Promise<void>;
  add(vectors: VectorEntry[]): Promise<void>;
  search(query: VectorQuery): Promise<ScoredFact[]>;
  markInvalid(factId: string): Promise<void>;
  updateCertainty(factId: string, certainty: Certainty): Promise<void>;
  remove(factId: string): Promise<void>;
  count(): Promise<number>;
  getAllIds(): Promise<string[]>;
}

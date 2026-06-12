// =============================================================================
// 向量存储与同步队列类型
// =============================================================================
// §12 (Vector domain): VectorEntry / VectorQuery / ScoredFact / RelevantFactSet
// §15: SyncQueueOperation / SyncQueueEntry

import type { Fact } from './fact.js';
import type { FactValue, Certainty } from './base.js';
import type { NarrativeThread } from './thread.js';

/** 向量条目：写入 LanceDB 的数据结构 */
export interface VectorEntry {
  id: string;
  vector: number[];
  subject: string;
  predicate: string;
  valid_from: number;
  valid_to: number | null;
  is_current: boolean;
  certainty: Certainty;
  context: string;
}

/** 向量查询条件 */
export interface VectorQuery {
  embedding: number[];
  topK: number;
  filter?: {
    subject?: string;
    predicate?: string;
    context?: string;
    certainty?: Certainty;
    is_current?: boolean;
  };
}

/** 语义检索命中的 Fact（带相似度分数） */
export interface ScoredFact {
  factId: string;
  score: number;
}

/**
 * 相关 Fact 集合 —— 语义检索管线输出
 *
 * 由 RelevantFactRetriever 组装，传入 FactRenderer.renderRelevantFacts 渲染为 LLM 上下文。
 * 对应架构文档 §7.2.2 RelevantFactRetriever 六段检索管线输出。
 */
export interface RelevantFactSet {
  /** 精确查询：场景实体的完整状态快照 */
  entitySnapshots: Record<string, Record<string, FactValue>>;
  /** 精确查询：场景实体的关系 Fact */
  entityRelations: Fact[];
  /** 语义检索：与写作上下文语义相关的其他 Fact */
  semanticFacts: Fact[];
  /** 当前未关闭的叙事线索 */
  openThreads: NarrativeThread[];
}

// =============================================================================
// 同步队列
// =============================================================================

/** 同步队列操作类型 */
export type SyncQueueOperation = 'insert_vector' | 'mark_invalid' | 'update_certainty' | 'rebuild_event_vectors';

/** 同步队列条目 */
export interface SyncQueueEntry {
  eventId: string;
  factIds: string[];
  operation: SyncQueueOperation;
  payload: Record<string, unknown>;
  retryCount: number;
  maxRetries: number;
  nextRetryAt: number;
  error?: string;
}

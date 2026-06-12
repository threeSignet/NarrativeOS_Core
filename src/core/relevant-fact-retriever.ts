// =============================================================================
// RelevantFactRetriever —— 六段检索管线
// =============================================================================
// Phase 4 核心组件。综合精确查询、语义检索、线索注入、知识过滤，
// 将相关 Fact 组装为 RelevantFactSet 供 FactRenderer 渲染注入 LLM 上下文。
//
// 六段管线（§7.2.2 + §10.2）：
//   Step 0: 短期工作记忆强制注入（最近 N 章事件的 Fact）
//   Step 1: 精确查询（场景实体快照 + 关系）
//   Step 2: 语义检索（LanceDB ANN + metadata filter）
//   Step 3: 叙事线索注入（活跃 Thread 关联的 Fact）
//   Step 4: 排序与去重
//   Step 5: 知识感知过滤（仅返回 requestingEntity 知晓的 Fact）
//
// 设计要点：
//   - 各步骤独立，失败不阻塞后续步骤（逐步降级）
//   - 去重以 Fact ID 为 key
//   - 知识过滤需 KnowledgeStore 支持
//
// =============================================================================

import type {
  FactStore,
  KnowledgeStore,
  ThreadStore,
  Fact,
  NarrativeThread,
  RelevantFactSet,
  ScoredFact,
} from '../types.js';
import { ContextAnalyzer, type ContextSignals } from './context-analyzer.js';
import { LanceDBTableAdapter } from '../adapters/lancedb/table-adapter.js';
import { SiliconFlowEmbeddingService } from '../adapters/embedding/siliconflow-embedder.js';

// ---------------------------------------------------------------------------
// 检索选项
// ---------------------------------------------------------------------------

export interface RetrievalOptions {
  topK?: number;
  includeRelations?: boolean;
  atChapter?: number;
  recentChapterWindow?: number;
  /** POV 实体 ID：Step 5 知识感知过滤，只返回该实体知晓的 Fact */
  povEntityId?: string;
}

// ---------------------------------------------------------------------------
// RelevantFactRetriever
// ---------------------------------------------------------------------------

export class RelevantFactRetriever {
  private factStore: FactStore;
  private knowledgeStore: KnowledgeStore;
  private threadStore: ThreadStore | undefined;
  private vectorStore: LanceDBTableAdapter;
  private embedder: SiliconFlowEmbeddingService;
  private analyzer: ContextAnalyzer;

  constructor(
    factStore: FactStore,
    knowledgeStore: KnowledgeStore,
    threadStore: ThreadStore | undefined,
    vectorStore: LanceDBTableAdapter,
    embedder: SiliconFlowEmbeddingService,
  ) {
    this.factStore = factStore;
    this.knowledgeStore = knowledgeStore;
    this.threadStore = threadStore;
    this.vectorStore = vectorStore;
    this.embedder = embedder;
    this.analyzer = new ContextAnalyzer(factStore);
  }

  // =========================================================================
  // 主入口：执行完整六段检索管线
  // =========================================================================

  async retrieve(
    signals: ContextSignals,
    options: RetrievalOptions = {},
  ): Promise<RelevantFactSet> {
    const topK = options.topK ?? 20;
    const atChapter = options.atChapter ?? signals.temporalFocus;
    const recentWindow = options.recentChapterWindow ?? 5;

    // Step 0+1: 精确查询（同步，无需向量）
    let entitySnapshots: Record<string, Record<string, any>> = {};
    let entityRelations: Fact[] = [];
    const seen = new Set<string>();  // 去重用

    for (const entityId of signals.primaryEntities) {
      const snapshot = this.factStore.getSnapshot(entityId, atChapter);
      if (Object.keys(snapshot).length > 0) {
        entitySnapshots[entityId] = snapshot;
      }
      if (options.includeRelations !== false) {
        const relations = this.factStore.getRelationsTargeting(entityId, atChapter);
        for (const r of relations) {
          if (!seen.has(r.id)) {
            seen.add(r.id);
            entityRelations.push(r);
          }
        }
      }
    }

    // Step 0: 短期工作记忆（最近 N 章事件的 Fact）
    const recentFacts: Fact[] = [];
    const fromChapter = Math.max(1, atChapter - recentWindow);
    const recentFactIds = this.factStore.query({
      atChapter,
      mode: 'current',
      certainties: ['canonical'],
    }).filter(f => f.validFrom >= fromChapter);
    for (const f of recentFactIds) {
      if (!seen.has(f.id)) {
        seen.add(f.id);
        recentFacts.push(f);
      }
    }

    // Step 2: 语义检索（LanceDB ANN）
    let semanticFacts: Fact[] = [];
    try {
      const allEntities = [
        ...signals.primaryEntities,
        ...signals.secondaryEntities,
        ...signals.nearbyEntities,
      ];
      const queryText = allEntities.join('，') + ' ' + (signals.genreHints.join(' '));
      if (queryText.trim()) {
        const queryEmbedding = await this.embedder.embed(queryText);
        const scoredResults = await this.vectorStore.search({
          embedding: queryEmbedding,
          topK,
          filter: {
            is_current: true,
            certainty: 'canonical',
            context: signals.activeScopes[0] ?? 'global',
          },
        });

        for (const sr of scoredResults) {
          if (!seen.has(sr.factId)) {
            seen.add(sr.factId);
            const fact = this.factStore.getById(sr.factId);
            if (fact) semanticFacts.push(fact);
          }
        }
      }
    } catch {
      // 语义检索失败降级：不阻塞管线
      semanticFacts = [];
    }

    // Step 3: 叙事线索注入
    let openThreads: NarrativeThread[] = [];
    if (this.threadStore) {
      openThreads = this.threadStore.getOpen();
    }

    // Step 4: 排序与去重（已通过 seen Set 完成去重）
    // Step 5: 知识感知过滤——POV 实体只能看到自己知晓的 Fact
    if (options.povEntityId) {
      const pov = options.povEntityId;
      const knownFactIds = new Set<string>();
      const knowledge = this.knowledgeStore.getKnownFacts(pov, atChapter);
      for (const k of knowledge) knownFactIds.add(k.factId);

      // 过滤语义检索结果
      semanticFacts = semanticFacts.filter(f => knownFactIds.has(f.id));

      // 过滤实体快照：只保留 POV 知晓的 predicate
      const filteredSnapshots: Record<string, Record<string, any>> = {};
      for (const [entityId, snapshot] of Object.entries(entitySnapshots)) {
        const filteredPredicates: Record<string, any> = {};
        for (const [pred, value] of Object.entries(snapshot)) {
          // 检查 POV 是否知道这条 Fact
          const facts = this.factStore.query({ subject: entityId, predicate: pred, atChapter });
          if (facts.length > 0 && knownFactIds.has(facts[0]!.id)) {
            filteredPredicates[pred] = value;
          }
        }
        if (Object.keys(filteredPredicates).length > 0) {
          filteredSnapshots[entityId] = filteredPredicates;
        }
      }
      entitySnapshots = filteredSnapshots;

      // 过滤关系：只保留 POV 知晓的 Fact
      entityRelations = entityRelations.filter(r => knownFactIds.has(r.id));
    }

    return {
      entitySnapshots,
      entityRelations,
      semanticFacts,
      openThreads,
    };
  }
}

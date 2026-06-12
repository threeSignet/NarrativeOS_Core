// =============================================================================
// ToolService —— LLM Tool Interface 服务层
// =============================================================================
// Phase 3C：将 FactRenderer 接入现有 Tool，为 LLM 提供 Markdown 渲染输出。
//
// 职责：
//   Tool 1 (get_context_slice)  → FactRenderer.renderEntityProfile
//   Tool 2 (propose_event)       → FactRenderer.renderSimulationReport
//   Tool 7 (get_open_threads)   → FactRenderer.renderThreadSummary
//
// 与架构文档的对应关系：
//   §9.2 Tool 1 get_context_slice  → 实体档案 + fact_index（ID 传递契约）
//   §9.2 Tool 7 get_open_threads   → 线索清单 + expiring_soon + hintable
//   §8.2 FactRenderer 接口         → 5 个渲染方法
// =============================================================================

import { FactRenderer } from './fact-renderer.js';
import type {
  FactStore,
  KnowledgeStore,
  EventStore,
  ThreadStore,
  Fact,
  NarrativeThread,
  Knowledge,
  FactIndexEntry,
  ThreadFilter,
} from '../types.js';
import { CoreNarrativeQueryEngine } from './query-engine.js';
import { ThreadResolver } from './thread-resolver.js';

// =============================================================================
// ToolService
// =============================================================================

export class ToolService {
  private renderer: FactRenderer;
  private queryEngine: CoreNarrativeQueryEngine;
  private factStore: FactStore;
  private threadStore?: ThreadStore;
  private threadResolver?: ThreadResolver;

  constructor(
    factStore: FactStore,
    knowledgeStore: KnowledgeStore,
    eventStore: EventStore,
    threadStore?: ThreadStore,
    threadResolver?: ThreadResolver,
  ) {
    this.factStore = factStore;
    this.threadStore = threadStore;
    this.threadResolver = threadResolver;
    this.renderer = new FactRenderer();
    this.queryEngine = new CoreNarrativeQueryEngine(
      factStore, knowledgeStore, eventStore, threadStore, threadResolver,
    );
  }

  // =========================================================================
  // Tool 1: get_context_slice
  // =========================================================================

  /**
   * 获取特定实体在当前章节的完整状态档案
   *
   * 返回 profile_markdown（FactRenderer 渲染）和 fact_index（后续 update/retract 操作的外科手术刀）。
   * 实现 ID 传递契约：LLM 必须从 fact_index 获取 target_fact_id，严禁凭空捏造。
   */
  async getContextSlice(params: {
    entityId: string;
    currentChapter: number;
    includeRelations?: boolean;
    entityNames?: Record<string, string>;
  }): Promise<{
    profileMarkdown: string;
    factIndex: FactIndexEntry[];
  }> {
    const entityId = params.entityId;
    const atChapter = params.currentChapter;
    const includeRelations = params.includeRelations ?? true;
    const entityNames = params.entityNames ?? {};

    // 获取实体快照
    const snapshot = this.factStore.getSnapshot(entityId, atChapter);

    // 获取关系
    let relations: Fact[] = [];
    if (includeRelations) {
      relations = this.factStore.getRelationsTargeting(entityId, atChapter);
    }

    // 获取未关闭线索
    let openThreads: NarrativeThread[] = [];
    if (this.threadStore) {
      openThreads = this.threadStore.getByFilters({
        relatedEntity: entityId,
        status: ['UNFILLED', 'PLANTED', 'HINTED', 'PARTIALLY_REVEALED'],
      });
    }

    // 渲染档案
    const profileMarkdown = this.renderer.renderEntityProfile(
      entityId,
      snapshot,
      relations,
      openThreads,
      atChapter,
      entityNames,
    );

    // 构建 fact_index（供 LLM 后续操作使用）
    const snapshotFacts = this.factStore.query({
      subject: entityId,
      atChapter,
      mode: 'current',
    });
    const factIndex: FactIndexEntry[] = snapshotFacts.map(f => ({
      factId: f.id,
      predicate: f.predicate,
      value: String(f.value),
      validFrom: f.validFrom,
      validTo: f.validTo,
      isCurrent: f.validTo === null,
      context: f.context !== 'global' ? f.context : undefined,
      action_hint: f.predicate === 'status' || f.predicate === 'note'
        ? `若要修改: op='update', target_fact_id='${f.id}'。若要撤销: op='retract', target_fact_id='${f.id}'`
        : `若要修改此设定，请在 propose_event 中使用 op='update', target_fact_id='${f.id}'`,
    }));

    return { profileMarkdown, factIndex };
  }

  // =========================================================================
  // Tool 7: get_open_threads
  // =========================================================================

  /**
   * 获取所有未关闭的叙事线索清单
   *
   * 返回 threads_markdown（FactRenderer 渲染）和结构化辅助数据。
   */
  async getOpenThreads(params: {
    currentChapter: number;
    severityFilter?: ('minor' | 'major' | 'critical')[];
    direction?: 'retroactive' | 'progressive';
    type?: string[];
  }): Promise<{
    threadsMarkdown: string;
    expiringSoon: string[];
    hintable: string[];
    totalOpen: number;
  }> {
    if (!this.threadStore || !this.threadResolver) {
      throw new Error('THREAD_QUERY_UNSUPPORTED: 需要注入 ThreadStore 和 ThreadResolver');
    }

    // 构建过滤条件
    const filter: ThreadFilter = {
      status: ['UNFILLED', 'PLANTED', 'HINTED', 'PARTIALLY_REVEALED'],
    };
    if (params.severityFilter) filter.severity = params.severityFilter;
    if (params.direction) filter.direction = params.direction;
    if (params.type) filter.type = params.type as any;

    const openThreads = this.threadStore.getByFilters(filter);

    // 渲染线索清单
    const threadsMarkdown = this.renderer.renderThreadSummary(openThreads, params.currentChapter);

    // 计算辅助数据
    const expiringSoon = this.threadResolver.getExpiringThreads(openThreads, params.currentChapter, 5)
      .map(t => t.id);
    const hintable = this.threadResolver.getHintableThreads(
      openThreads,
      {
        id: '_tool_hintable_',
        kind: 'system',
        type: 'get_open_threads',
        chapter: params.currentChapter,
        description: '查询可暗示线索',
        params: {},
        context: 'global',
        timestamp: new Date().toISOString(),
        factGroupId: '_tool_hintable_',
        resolvedThreads: [],
        dependentFactIds: [],
      }
    ).map(t => t.id);

    return {
      threadsMarkdown,
      expiringSoon,
      hintable,
      totalOpen: openThreads.length,
    };
  }

  // =========================================================================
  // 辅助：提供 FactRenderer 实例供外部使用
  // =========================================================================

  /** 获取 FactRenderer 实例（供 ProposalManager 等直接使用） */
  getFactRenderer(): FactRenderer {
    return this.renderer;
  }

  /** 获取查询引擎实例 */
  getQueryEngine(): CoreNarrativeQueryEngine {
    return this.queryEngine;
  }
}

// =============================================================================
// NarrativeQueryEngine —— Phase 1.5A 只读查询层
// =============================================================================
// 薄封装已有 Store 查询能力，让作者/开发者能验证 Phase 1 写入结果。
// 本层只读，不做推理、不调用 LLM、不触发语义检索，也不实现 Thread 生命周期。
// =============================================================================

import type {
  EntityFilter,
  EntityKind,
  EntityRecord,
  EventFilter,
  Fact,
  FactFilter,
  FactStore,
  Knowledge,
  KnowledgeStore,
  NarrativeEvent,
  NarrativeKnowledgeFilter,
  NarrativeQueryEngine,
  NarrativeThread,
  ThreadFilter,
  ThreadStore,
  EventStore,
} from '../types.js';
import { ThreadResolver } from './thread-resolver.js';

interface QueryDatabase {
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
  };
}

interface EntityRow {
  id: string;
  name: string;
  kind: EntityKind;
  description: string | null;
  first_appearance: number;
  registered_at_event: string | null;
}

export class CoreNarrativeQueryEngine implements NarrativeQueryEngine {
  private db?: QueryDatabase;

  constructor(
    private readonly factStore: FactStore,
    private readonly knowledgeStore: KnowledgeStore,
    private readonly eventStore: EventStore,
    // Phase 2E：ThreadStore + ThreadResolver 用于 findThreads 和 getExpiringThreads
    private readonly threadStore?: ThreadStore,
    private readonly threadResolver?: ThreadResolver,
    db?: QueryDatabase,
  ) {
    this.db = db ?? (factStore as FactStore & { getDatabase?: () => QueryDatabase }).getDatabase?.();
  }

  /** 查询 Fact。默认语义沿用 FactStore.query：当前有效、canonical/contested。 */
  async findFacts(filter: FactFilter): Promise<Fact[]> {
    return this.factStore.query(filter);
  }

  /**
   * 查询 Knowledge。
   *
   * 执行顺序：
   *   1. 按时间/身份条件（entityId, factId, source, atChapter）从 Store 取候选记录
   *   2. 非 history 模式下，对每个 (entityId, factId) 取 knownSince DESC + rowid DESC 最新记录
   *   3. 最后统一应用可见性过滤（includeSealed / minConfidence / factPredicate）
   *
   * 关键：minConfidence 绝不能在步骤 1 预过滤，否则较新的封印记录（confidence=0）
   * 会被误排除，导致旧的正确记录被当成当前认知返回。
   */
  async findKnowledge(filter: NarrativeKnowledgeFilter): Promise<Knowledge[]> {
    // 候选记录不传 minConfidence，保证封印/低确信度记录也参与"取最新"竞争
    const rows = filter.includeHistory
      ? this.knowledgeStore.query({
          entityId: filter.entityId,
          factId: filter.factId,
          source: filter.source,
          atChapter: filter.atChapter,
        })
      : this.getLatestKnowledge(filter);

    return rows.filter(knowledge => {
      // includeSealed 过滤：默认隐藏 confidence <= 0 的封印记录
      if (!filter.includeSealed && knowledge.confidence <= 0) return false;
      // minConfidence 只作用于非封印记录；封印记录的可见性由 includeSealed 独立控制
      if (filter.minConfidence !== undefined && knowledge.confidence > 0 && knowledge.confidence < filter.minConfidence) return false;
      if (filter.factSubject || filter.factPredicate) {
        const fact = this.factStore.getById(knowledge.factId);
        if (!fact) return false;
        if (filter.factSubject && fact.subject !== filter.factSubject) return false;
        if (filter.factPredicate && fact.predicate !== filter.factPredicate) return false;
      }
      return true;
    });
  }

  /** 查询事件。默认只查 business 事件，除非 filter.kind 显式指定。 */
  async findEvents(filter: EventFilter): Promise<NarrativeEvent[]> {
    const kind = filter.kind ?? 'business';
    let events: NarrativeEvent[];

    if (filter.id) {
      const event = this.eventStore.getById(filter.id);
      events = event ? [event] : [];
    } else if (filter.dependentFactIds && filter.dependentFactIds.length > 0) {
      events = this.eventStore.getByDependentFactIds(filter.dependentFactIds, kind);
    } else if (filter.subject) {
      events = this.eventStore.getBySubject(filter.subject, filter.fromChapter, kind);
    } else if (filter.type) {
      events = this.eventStore.getByType(filter.type, filter.fromChapter, kind);
    } else {
      events = this.eventStore.getByChapterRange(filter.fromChapter ?? 0, filter.toChapter, kind);
    }

    return events.filter(event => {
      if (filter.type && event.type !== filter.type) return false;
      if (filter.subject && event.params['subject'] !== filter.subject) return false;
      if (filter.fromChapter !== undefined && event.chapter < filter.fromChapter) return false;
      if (filter.toChapter !== undefined && event.chapter > filter.toChapter) return false;
      if (kind !== 'all' && event.kind !== kind) return false;
      return true;
    });
  }

  /**
   * 查询叙事线索（Phase 2E）
   *
   * 薄封装 ThreadStore.getByFilters。ThreadStore 未注入时抛出错误。
   */
  async findThreads(filter: ThreadFilter): Promise<NarrativeThread[]> {
    if (!this.threadStore) {
      throw new Error('THREAD_QUERY_UNSUPPORTED: 当前 QueryEngine 未注入 ThreadStore');
    }
    return this.threadStore.getByFilters(filter);
  }

  /**
   * 查询即将超期的回溯型线索（Phase 2E）
   *
   * 需同时注入 ThreadStore + ThreadResolver。
   * 默认预警窗口 5 章，可通过 warningWindow 参数调整。
   */
  async getExpiringThreads(currentChapter: number, warningWindow?: number): Promise<NarrativeThread[]> {
    if (!this.threadStore || !this.threadResolver) {
      throw new Error('THREAD_QUERY_UNSUPPORTED: 需要注入 ThreadStore 和 ThreadResolver');
    }
    const allThreads = this.threadStore.getOpen();
    return this.threadResolver.getExpiringThreads(allThreads, currentChapter, warningWindow);
  }

  /** 查询实体注册表。实体状态仍应通过 Fact 查询获得。 */
  async findEntities(filter: EntityFilter): Promise<EntityRecord[]> {
    if (!this.db) {
      throw new Error('ENTITY_QUERY_UNSUPPORTED: 当前 QueryEngine 未提供 SQLite 数据库连接');
    }

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filter.id) {
      conditions.push('id = ?');
      params.push(filter.id);
    }
    if (filter.name) {
      conditions.push('name = ?');
      params.push(filter.name);
    }
    if (filter.nameContains) {
      conditions.push('name LIKE ?');
      params.push(`%${filter.nameContains}%`);
    }
    if (filter.kind) {
      const kinds = Array.isArray(filter.kind) ? filter.kind : [filter.kind];
      conditions.push(`kind IN (${kinds.map(() => '?').join(',')})`);
      params.push(...kinds);
    }
    if (filter.appearedBefore !== undefined) {
      conditions.push('first_appearance <= ?');
      params.push(filter.appearedBefore);
    }
    if (filter.appearedAfter !== undefined) {
      conditions.push('first_appearance >= ?');
      params.push(filter.appearedAfter);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = this.db.prepare(
      `SELECT id, name, kind, description, first_appearance, registered_at_event
       FROM entities ${whereClause}
       ORDER BY first_appearance ASC, id ASC`
    ).all(...params) as EntityRow[];

    return rows.map(row => ({
      id: row.id,
      name: row.name,
      kind: row.kind,
      description: row.description ?? undefined,
      registeredAtChapter: row.first_appearance,
      registeredAtEvent: row.registered_at_event ?? '',
    }));
  }

  /**
   * 获取每个 (entityId, factId) 组合的最新 Knowledge 记录。
   *
   * 不在 Store 层传递 minConfidence——先取全部候选，让"取最新"逻辑正确运行，
   * 然后由 findKnowledge 的外层过滤器统一处理可见性。
   */
  private getLatestKnowledge(filter: NarrativeKnowledgeFilter): Knowledge[] {
    if (filter.entityId) {
      const rows = this.knowledgeStore.query({
        entityId: filter.entityId,
        source: filter.source,
        atChapter: filter.atChapter,
      });
      return this.pickLatestByEntityAndFact(rows, filter);
    }

    const rows = this.knowledgeStore.query({
      factId: filter.factId,
      source: filter.source,
      atChapter: filter.atChapter,
    });
    return this.pickLatestByEntityAndFact(rows, filter);
  }

  /**
   * 从已排序的候选记录中，对每个 (entityId, factId) 取第一条（即最新）。
   *
   * 前提：rows 已按 knownSince DESC, rowid DESC 排序（Store query 保证）。
   * 可见性过滤（minConfidence / includeSealed）不在这一步执行，留给 findKnowledge 外层统一处理。
   */
  private pickLatestByEntityAndFact(rows: Knowledge[], filter: NarrativeKnowledgeFilter): Knowledge[] {
    const latest = new Map<string, Knowledge>();
    for (const row of rows) {
      const key = `${row.entityId}:${row.factId}`;
      if (!latest.has(key)) {
        latest.set(key, row);
      }
    }

    return [...latest.values()].filter(row => {
      if (filter.factId && row.factId !== filter.factId) return false;
      if (filter.entityId && row.entityId !== filter.entityId) return false;
      return true;
    });
  }
}

// =============================================================================
// NarrativeQueryEngine Phase 1.5A 集成测试
// =============================================================================
// 验证 Query Layer 是只读薄封装：不推理、不写入，只按冻结语义读出现有状态。

import { describe, expect, it, beforeEach } from 'vitest';
import { CoreNarrativeQueryEngine } from '../../src/core/query-engine.js';
import { ThreadResolver } from '../../src/core/thread-resolver.js';
import { SQLiteFactStoreAdapter } from '../../src/adapters/sqlite/fact-store.js';
import { SQLiteKnowledgeStoreAdapter } from '../../src/adapters/sqlite/knowledge-store.js';
import { SQLiteEventStoreAdapter } from '../../src/adapters/sqlite/event-store.js';
import { SQLiteThreadStoreAdapter } from '../../src/adapters/sqlite/thread-store.js';

describe('CoreNarrativeQueryEngine — Phase 1.5A', () => {
  let factStore: SQLiteFactStoreAdapter;
  let knowledgeStore: SQLiteKnowledgeStoreAdapter;
  let eventStore: SQLiteEventStoreAdapter;
  let queryEngine: CoreNarrativeQueryEngine;

  beforeEach(() => {
    factStore = new SQLiteFactStoreAdapter(':memory:', 'query_test');
    const db = factStore.getDatabase();

    db.exec(`
      INSERT OR IGNORE INTO entities (id, name, kind, first_appearance, registered_at_event)
      VALUES
        ('ent_zhangsan', '张三', 'entity', 1, 'evt_origin_01'),
        ('ent_lisi', '李四', 'entity', 1, 'evt_origin_01'),
        ('ent_gumu', '古墓', 'place', 1, 'evt_origin_01');

      INSERT OR IGNORE INTO events (id, kind, type, chapter, description, params_json, context, fact_group_id)
      VALUES
        ('evt_origin_01', 'business', 'origin', 1, '初始设定', '{"subject":"ent_zhangsan"}', 'global', 'evt_origin_01'),
        ('evt_system_01', 'system', 'schema', 2, '系统事件', '{}', 'global', 'evt_system_01'),
        ('evt_discover_20', 'business', 'discover', 20, '发现秘密', '{"subject":"ent_zhangsan"}', 'global', 'evt_discover_20');
    `);

    knowledgeStore = new SQLiteKnowledgeStoreAdapter(db);
    eventStore = new SQLiteEventStoreAdapter(db);
    queryEngine = new CoreNarrativeQueryEngine(factStore, knowledgeStore, eventStore);
  });

  it('findFacts 默认遵守当前态查询语义', async () => {
    const oldFact = factStore.assert({
      subject: 'ent_zhangsan',
      predicate: 'realm',
      value: '筑基期',
      certainty: 'canonical',
      causeEvent: 'evt_origin_01',
      validFrom: 1,
      validTo: null,
      embeddingText: '',
    });
    factStore.update(oldFact.id, '金丹期', 'evt_discover_20', 20);

    const current = await queryEngine.findFacts({
      subject: 'ent_zhangsan',
      predicate: 'realm',
      atChapter: 30,
    });
    expect(current.map(f => f.value)).toEqual(['金丹期']);

    const history = await queryEngine.findFacts({
      subject: 'ent_zhangsan',
      predicate: 'realm',
      atChapter: 30,
      mode: 'history',
    });
    expect(history.map(f => f.value)).toContain('筑基期');
    expect(history.map(f => f.value)).toContain('金丹期');
  });

  it('findKnowledge 默认返回最新有效认知并隐藏 sealed 记录', async () => {
    const fact = factStore.assert({
      subject: 'ent_gumu',
      predicate: 'secret',
      value: '藏有传送阵',
      certainty: 'canonical',
      causeEvent: 'evt_discover_20',
      validFrom: 20,
      validTo: null,
      embeddingText: '',
    });

    knowledgeStore.create({
      factId: fact.id,
      entityId: 'ent_zhangsan',
      knownSince: 20,
      source: 'self_action',
      confidence: 1,
    });
    knowledgeStore.create({
      factId: fact.id,
      entityId: 'ent_zhangsan',
      knownSince: 30,
      source: 'memory_seal',
      confidence: 0,
      previousConfidence: 1,
      updatedAtEvent: 'evt_discover_20',
    });

    const visible = await queryEngine.findKnowledge({
      entityId: 'ent_zhangsan',
      factPredicate: 'secret',
      atChapter: 40,
    });
    expect(visible).toEqual([]);

    const sealed = await queryEngine.findKnowledge({
      entityId: 'ent_zhangsan',
      factPredicate: 'secret',
      atChapter: 40,
      includeSealed: true,
    });
    expect(sealed).toHaveLength(1);
    expect(sealed[0]!.source).toBe('memory_seal');
  });

  it('findEvents 默认只返回 business 事件', async () => {
    const business = await queryEngine.findEvents({ fromChapter: 1, toChapter: 10 });
    expect(business.map(event => event.id)).toContain('evt_origin_01');
    expect(business.map(event => event.id)).not.toContain('evt_system_01');

    const all = await queryEngine.findEvents({ fromChapter: 1, toChapter: 10, kind: 'all' });
    expect(all.map(event => event.id)).toContain('evt_system_01');
  });

  it('findEntities 支持 id/name/kind 的轻量查询', async () => {
    const byKind = await queryEngine.findEntities({ kind: 'place' });
    expect(byKind.map(entity => entity.id)).toEqual(['ent_gumu']);

    const byName = await queryEngine.findEntities({ nameContains: '张' });
    expect(byName.map(entity => entity.id)).toEqual(['ent_zhangsan']);
  });

  it('较新封印记录存在时，minConfidence 不能让旧的正确记录返回', async () => {
    const fact = factStore.assert({
      subject: 'ent_gumu',
      predicate: 'secret',
      value: '藏有传送阵',
      certainty: 'canonical',
      causeEvent: 'evt_discover_20',
      validFrom: 20,
      validTo: null,
      embeddingText: '',
    });

    // 第 20 章：自动认知，confidence=1
    knowledgeStore.create({
      factId: fact.id,
      entityId: 'ent_zhangsan',
      knownSince: 20,
      source: 'self_action',
      confidence: 1,
    });
    // 第 30 章：记忆封印，confidence=0（较新记录）
    knowledgeStore.create({
      factId: fact.id,
      entityId: 'ent_zhangsan',
      knownSince: 30,
      source: 'memory_seal',
      confidence: 0,
      previousConfidence: 1,
      updatedAtEvent: 'evt_discover_20',
    });

    // 即使传入 minConfidence: 0.5，默认查询也不能返回旧的 self_action 记录
    const result = await queryEngine.findKnowledge({
      entityId: 'ent_zhangsan',
      factPredicate: 'secret',
      atChapter: 40,
      minConfidence: 0.5,
    });
    expect(result).toEqual([]);
  });

  it('同章节封印后再恢复时，rowid 仲裁应返回恢复记录', async () => {
    const fact = factStore.assert({
      subject: 'ent_gumu',
      predicate: 'secret',
      value: '藏有传送阵',
      certainty: 'canonical',
      causeEvent: 'evt_discover_20',
      validFrom: 20,
      validTo: null,
      embeddingText: '',
    });

    // 第 20 章：自动认知
    knowledgeStore.create({
      factId: fact.id,
      entityId: 'ent_zhangsan',
      knownSince: 20,
      source: 'self_action',
      confidence: 1,
    });
    // 第 30 章：封印（同章节内先写入）
    knowledgeStore.create({
      factId: fact.id,
      entityId: 'ent_zhangsan',
      knownSince: 30,
      source: 'memory_seal',
      confidence: 0,
      previousConfidence: 1,
      updatedAtEvent: 'evt_discover_20',
    });
    // 第 30 章：恢复（同章节内后写入，rowid 更大，应被选为最新）
    knowledgeStore.create({
      factId: fact.id,
      entityId: 'ent_zhangsan',
      knownSince: 30,
      source: 'memory_restore',
      confidence: 1,
      previousConfidence: 0,
      updatedAtEvent: 'evt_discover_20',
    });

    const result = await queryEngine.findKnowledge({
      entityId: 'ent_zhangsan',
      factPredicate: 'secret',
      atChapter: 40,
    });
    expect(result).toHaveLength(1);
    expect(result[0]!.source).toBe('memory_restore');
    expect(result[0]!.confidence).toBe(1);
  });

  it('同时传入 entityId + factId + minConfidence 时，封印记录不能让旧记录返回', async () => {
    const factA = factStore.assert({
      subject: 'ent_gumu',
      predicate: 'secret',
      value: '藏有传送阵',
      certainty: 'canonical',
      causeEvent: 'evt_discover_20',
      validFrom: 20,
      validTo: null,
      embeddingText: '',
    });
    const factB = factStore.assert({
      subject: 'ent_gumu',
      predicate: 'location',
      value: '昆仑山脉',
      certainty: 'canonical',
      causeEvent: 'evt_origin_01',
      validFrom: 1,
      validTo: null,
      embeddingText: '',
    });

    // ent_zhangsan 对 factA：第 20 章自动认知，第 30 章封印
    knowledgeStore.create({
      factId: factA.id,
      entityId: 'ent_zhangsan',
      knownSince: 20,
      source: 'self_action',
      confidence: 1,
    });
    knowledgeStore.create({
      factId: factA.id,
      entityId: 'ent_zhangsan',
      knownSince: 30,
      source: 'memory_seal',
      confidence: 0,
      previousConfidence: 1,
      updatedAtEvent: 'evt_discover_20',
    });

    // ent_zhangsan 对 factB：正常认知（对照组，应正常返回）
    knowledgeStore.create({
      factId: factB.id,
      entityId: 'ent_zhangsan',
      knownSince: 5,
      source: 'self_action',
      confidence: 0.8,
    });

    // 同时传入 entityId + factId + minConfidence，只应返回 factB 的认知
    const result = await queryEngine.findKnowledge({
      entityId: 'ent_zhangsan',
      factId: factA.id,
      atChapter: 40,
      minConfidence: 0.5,
    });
    expect(result).toEqual([]);
  });

  it('includeHistory + includeSealed 应返回历史认知记录且包含封印记录', async () => {
    const fact = factStore.assert({
      subject: 'ent_gumu',
      predicate: 'secret',
      value: '藏有传送阵',
      certainty: 'canonical',
      causeEvent: 'evt_discover_20',
      validFrom: 20,
      validTo: null,
      embeddingText: '',
    });

    // 第 20 章：自动认知
    knowledgeStore.create({
      factId: fact.id,
      entityId: 'ent_zhangsan',
      knownSince: 20,
      source: 'self_action',
      confidence: 1,
    });
    // 第 30 章：封印
    knowledgeStore.create({
      factId: fact.id,
      entityId: 'ent_zhangsan',
      knownSince: 30,
      source: 'memory_seal',
      confidence: 0,
      previousConfidence: 1,
      updatedAtEvent: 'evt_discover_20',
    });

    const result = await queryEngine.findKnowledge({
      entityId: 'ent_zhangsan',
      factPredicate: 'secret',
      atChapter: 40,
      includeHistory: true,
      includeSealed: true,
    });
    // 应包含两条记录：原始认知 + 封印记录
    expect(result).toHaveLength(2);
    const sources = result.map(k => k.source);
    expect(sources).toContain('self_action');
    expect(sources).toContain('memory_seal');
  });
});

// =============================================================================
// Phase 2E 测试：findThreads + getExpiringThreads
// =============================================================================

describe('CoreNarrativeQueryEngine — Phase 2E findThreads', () => {
  it('findThreads 应查询 ThreadStore.getByFilters 的结果', async () => {
    const factStore = new SQLiteFactStoreAdapter(':memory:', 'findThreads_test');
    const db = factStore.getDatabase();
    db.exec("INSERT OR IGNORE INTO entities (id, name, kind, first_appearance) VALUES ('ent_hero', '主角', 'entity', 1)");
    db.exec("INSERT OR IGNORE INTO events (id, kind, type, chapter, description, params_json, fact_group_id) VALUES ('evt_origin_01', 'business', 'origin', 1, '初始', '{}', 'evt_origin_01')");

    const threadStore = new SQLiteThreadStoreAdapter(db);
    const engine = new CoreNarrativeQueryEngine(
      factStore,
      new SQLiteKnowledgeStoreAdapter(db),
      new SQLiteEventStoreAdapter(db),
      threadStore,
    );

    // 创建线索
    threadStore.create({
      type: 'foreshadowing',
      direction: 'progressive',
      severity: 'minor',
      description: '测试伏笔',
      closeCondition: {},
      status: 'PLANTED',
      closedBy: null,
      createdAtEvent: 'evt_origin_01',
      createdAtChapter: 1,
      milestones: [],
      relatedEntities: ['ent_hero'],
      upstreamFactIds: [],
    });

    const results = await engine.findThreads({ direction: 'progressive' });
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe('PLANTED');
  });

  it('findThreads 未注入 ThreadStore 时应抛出错误', async () => {
    const factStore = new SQLiteFactStoreAdapter(':memory:', 'no_threads_test');
    const db = factStore.getDatabase();
    const engine = new CoreNarrativeQueryEngine(
      factStore,
      new SQLiteKnowledgeStoreAdapter(db),
      new SQLiteEventStoreAdapter(db),
    );

    await expect(engine.findThreads({})).rejects.toThrow('THREAD_QUERY_UNSUPPORTED');
  });

  it('getExpiringThreads 应返回预警窗口内的回溯型线索', async () => {
    const factStore = new SQLiteFactStoreAdapter(':memory:', 'expiring_test');
    const db = factStore.getDatabase();
    db.exec("INSERT OR IGNORE INTO entities (id, name, kind, first_appearance) VALUES ('ent_hero', '主角', 'entity', 1)");
    db.exec("INSERT OR IGNORE INTO events (id, kind, type, chapter, description, params_json, fact_group_id) VALUES ('evt_origin_01', 'business', 'origin', 1, '初始', '{}', 'evt_origin_01')");

    const threadStore = new SQLiteThreadStoreAdapter(db);
    const resolver = new ThreadResolver();
    const engine = new CoreNarrativeQueryEngine(
      factStore,
      new SQLiteKnowledgeStoreAdapter(db),
      new SQLiteEventStoreAdapter(db),
      threadStore,
      resolver,
    );

    // 创建一条在第 10 章产生、deadline 为 10+10=20 的回溯型线索
    threadStore.create({
      type: 'causal_gap',
      direction: 'retroactive',
      severity: 'major',
      description: '需要补充原因',
      closeCondition: { withinChapters: 10 },
      status: 'UNFILLED',
      closedBy: null,
      createdAtEvent: 'evt_origin_01',
      createdAtChapter: 10,
      milestones: [],
      relatedEntities: ['ent_hero'],
      upstreamFactIds: [],
    });

    // 第 17 章查询（预警窗口 5 章：17 >= 20-5=15，且 17 < 20）
    const expiring = await engine.getExpiringThreads(17);
    expect(expiring).toHaveLength(1);

    // 第 5 章查询（远在预警窗口外）
    const farAway = await engine.getExpiringThreads(5);
    expect(farAway).toHaveLength(0);
  });
});

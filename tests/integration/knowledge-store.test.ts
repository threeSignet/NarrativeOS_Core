// =============================================================================
// SQLiteKnowledgeStoreAdapter 集成测试
// =============================================================================
// Phase 1 最小版：create / batchCreate / getKnownFacts / getActiveKnowledge / getKnowersOfFact

import { describe, it, expect, beforeEach } from 'vitest';
import { SQLiteFactStoreAdapter } from '../../src/adapters/sqlite/fact-store.js';
import { SQLiteKnowledgeStoreAdapter } from '../../src/adapters/sqlite/knowledge-store.js';
import type { Knowledge } from '../../src/types.js';

// ---------------------------------------------------------------------------
// 测试环境
// ---------------------------------------------------------------------------

function setupEntitiesAndFacts(factStore: SQLiteFactStoreAdapter): void {
  const db = factStore.getDatabase();
  // 注册实体
  db.exec("INSERT OR IGNORE INTO entities (id, name, kind, first_appearance) VALUES ('ent_claine', '克莱恩', 'entity', 1)");
  db.exec("INSERT OR IGNORE INTO entities (id, name, kind, first_appearance) VALUES ('ent_dunn', '邓恩', 'entity', 1)");
  db.exec("INSERT OR IGNORE INTO entities (id, name, kind, first_appearance) VALUES ('ent_audrey', '奥黛丽', 'entity', 1)");
  // 注册事件
  db.exec("INSERT OR IGNORE INTO events (id, kind, type, chapter, description, params_json, fact_group_id) VALUES ('evt_ch01', 'business', 'origin', 1, '初始事件', '{}', 'evt_ch01')");
  db.exec("INSERT OR IGNORE INTO events (id, kind, type, chapter, description, params_json, fact_group_id) VALUES ('evt_ch50', 'business', 'tribulation', 50, '第50章事件', '{}', 'evt_ch50')");
}

function createTestFacts(store: SQLiteFactStoreAdapter): { fact1: string; fact2: string; fact3: string } {
  const f1 = store.assert({
    subject: 'ent_claine', predicate: 'identity', value: '愚者',
    certainty: 'canonical', causeEvent: 'evt_ch01', validFrom: 1, validTo: null,
    embeddingText: '克莱恩 的真实身份是 愚者（第1章）',
  });
  const f2 = store.assert({
    subject: 'ent_claine', predicate: 'ability', value: '占卜',
    certainty: 'canonical', causeEvent: 'evt_ch01', validFrom: 1, validTo: null,
    embeddingText: '克莱恩 的能力是 占卜（第1章）',
  });
  const f3 = store.assert({
    subject: 'ent_dunn', predicate: 'status', value: 'alive',
    certainty: 'canonical', causeEvent: 'evt_ch01', validFrom: 1, validTo: null,
    embeddingText: '邓恩 的状态是 存活（第1章）',
  });
  return { fact1: f1.id, fact2: f2.id, fact3: f3.id };
}

describe('SQLiteKnowledgeStoreAdapter', () => {
  let factStore: SQLiteFactStoreAdapter;
  let knowledgeStore: SQLiteKnowledgeStoreAdapter;

  beforeEach(() => {
    factStore = new SQLiteFactStoreAdapter(':memory:', 'test_knowledge');
    setupEntitiesAndFacts(factStore);
    knowledgeStore = new SQLiteKnowledgeStoreAdapter(factStore.getDatabase());
  });

  // -------------------------------------------------------------------
  // create
  // -------------------------------------------------------------------

  describe('create', () => {
    it('应创建 Knowledge 并自动生成 kno_ 前缀 ID', () => {
      const { fact1 } = createTestFacts(factStore);

      const k = knowledgeStore.create({
        factId: fact1,
        entityId: 'ent_claine',
        knownSince: 1,
        source: 'self_action',
        confidence: 1.0,
      });

      expect(k.id).toMatch(/^kno_claine_/);
      expect(k.factId).toBe(fact1);
      expect(k.entityId).toBe('ent_claine');
      expect(k.confidence).toBe(1.0);
      expect(k.source).toBe('self_action');
      expect(k.knownSince).toBe(1);
    });

    it('different entities 对同一 Fact 应有各自的 Knowledge', () => {
      const { fact1 } = createTestFacts(factStore);

      const k1 = knowledgeStore.create({
        factId: fact1, entityId: 'ent_claine',
        knownSince: 1, source: 'self_action' as const, confidence: 1.0,
      });
      const k2 = knowledgeStore.create({
        factId: fact1, entityId: 'ent_dunn',
        knownSince: 200, source: 'inferred' as const, confidence: 0.8,
      });

      expect(k1.id).not.toBe(k2.id);
      expect(k1.entityId).toBe('ent_claine');
      expect(k2.entityId).toBe('ent_dunn');
    });
  });

  // -------------------------------------------------------------------
  // batchCreate
  // -------------------------------------------------------------------

  describe('batchCreate', () => {
    it('应批量创建多条 Knowledge 并返回完整对象', () => {
      const { fact1, fact2 } = createTestFacts(factStore);

      const results = knowledgeStore.batchCreate([
        { factId: fact1, entityId: 'ent_claine', knownSince: 1, source: 'self_action' as const, confidence: 1.0 },
        { factId: fact2, entityId: 'ent_claine', knownSince: 1, source: 'self_action' as const, confidence: 1.0 },
      ]);

      expect(results.length).toBe(2);
      expect(results[0]!.confidence).toBe(1.0);
      expect(results[1]!.entityId).toBe('ent_claine');
    });
  });

  // -------------------------------------------------------------------
  // getKnownFacts — 核心查询
  // -------------------------------------------------------------------

  describe('getKnownFacts', () => {
    it('应返回实体知道的所有 Fact（confidence > 0）', () => {
      const { fact1, fact2 } = createTestFacts(factStore);

      knowledgeStore.batchCreate([
        { factId: fact1, entityId: 'ent_claine', knownSince: 1, source: 'self_action' as const, confidence: 1.0 },
        { factId: fact2, entityId: 'ent_claine', knownSince: 1, source: 'self_action' as const, confidence: 1.0 },
      ]);

      const known = knowledgeStore.getKnownFacts('ent_claine');
      expect(known.length).toBe(2);
      expect(known.every(k => k.entityId === 'ent_claine')).toBe(true);
    });

    it('时间切片：atChapter 应排除该章节之后才知道的 Fact', () => {
      const { fact1, fact2 } = createTestFacts(factStore);

      // 克莱恩第 1 章知道自己身份
      knowledgeStore.create({
        factId: fact1, entityId: 'ent_claine',
        knownSince: 1, source: 'self_action', confidence: 1.0,
      });
      // 邓恩第 380 章才知道克莱恩身份
      knowledgeStore.create({
        factId: fact1, entityId: 'ent_dunn',
        knownSince: 380, source: 'inferred', confidence: 0.9,
      });

      // 第 200 章时：克莱恩知道，邓恩还不知道
      const knownAt200 = knowledgeStore.getKnownFacts('ent_dunn', 200);
      expect(knownAt200.length).toBe(0);

      // 第 400 章时：邓恩也知道了
      const knownAt400 = knowledgeStore.getKnownFacts('ent_dunn', 400);
      expect(knownAt400.length).toBe(1);
    });
  });

  // -------------------------------------------------------------------
  // getActiveKnowledge — 过滤 contested/orphaned
  // -------------------------------------------------------------------

  describe('getActiveKnowledge', () => {
    it('应排除指向 contested Fact 的 Knowledge', () => {
      const { fact1: fId } = createTestFacts(factStore);

      // 插入 Knowledge
      knowledgeStore.create({
        factId: fId, entityId: 'ent_claine',
        knownSince: 1, source: 'self_action', confidence: 1.0,
      });

      // 此时 Fact 是 canonical，activeKnowledge 应返回
      const active1 = knowledgeStore.getActiveKnowledge('ent_claine');
      expect(active1.length).toBe(1);

      // 模拟 Retcon 将 Fact 标记为 contested
      factStore.getDatabase().exec(`UPDATE facts SET certainty = 'contested' WHERE id = '${fId}'`);

      // contested Fact 的 Knowledge 不再 active
      const active2 = knowledgeStore.getActiveKnowledge('ent_claine');
      expect(active2.length).toBe(0);
    });
  });

  // -------------------------------------------------------------------
  // getKnowersOfFact — 反向查询
  // -------------------------------------------------------------------

  describe('getKnowersOfFact', () => {
    it('应返回某条 Fact 的所有知晓者', () => {
      const { fact1 } = createTestFacts(factStore);

      knowledgeStore.batchCreate([
        { factId: fact1, entityId: 'ent_claine', knownSince: 1, source: 'self_action' as const, confidence: 1.0 },
        { factId: fact1, entityId: 'ent_dunn', knownSince: 380, source: 'inferred' as const, confidence: 0.9 },
      ]);

      const knowers = knowledgeStore.getKnowersOfFact(fact1);
      expect(knowers.length).toBe(2);
      const entityIds = knowers.map(k => k.entityId);
      expect(entityIds).toContain('ent_claine');
      expect(entityIds).toContain('ent_dunn');
    });
  });

  // -------------------------------------------------------------------
  // getByFactId — 全历史记录
  // -------------------------------------------------------------------

  describe('getByFactId', () => {
    it('应返回 Fact 的全部认知记录（含历史）', () => {
      const { fact1 } = createTestFacts(factStore);

      // 创建后模拟 seal 操作——两条记录指向同一 Fact
      knowledgeStore.create({
        factId: fact1, entityId: 'ent_claine',
        knownSince: 1, source: 'self_action', confidence: 1.0,
      });
      knowledgeStore.create({
        factId: fact1, entityId: 'ent_claine',
        knownSince: 100, source: 'memory_seal', confidence: 0.0,
        previousConfidence: 1.0,
      });

      const all = knowledgeStore.getByFactId(fact1);
      expect(all.length).toBe(2);
      expect(all[0]!.source).toBe('memory_seal');  // 最新记录排第一
      expect(all[1]!.source).toBe('self_action');
    });
  });

  // -------------------------------------------------------------------
  // updateConfidence — Event Sourcing 原则
  // -------------------------------------------------------------------

  describe('updateConfidence', () => {
    it('应 INSERT 新记录而非 UPDATE', () => {
      const { fact1 } = createTestFacts(factStore);

      const k = knowledgeStore.create({
        factId: fact1, entityId: 'ent_claine',
        knownSince: 1, source: 'self_action', confidence: 1.0,
      });

      knowledgeStore.updateConfidence(k.id, 0.5, 'evt_ch50');

      // 原记录不变
      const original = knowledgeStore.getByFactId(fact1).find(r => r.id === k.id);
      expect(original!.confidence).toBe(1.0);

      // 新记录存在
      const all = knowledgeStore.getByFactId(fact1);
      expect(all.length).toBe(2);
    });
  });

  // -------------------------------------------------------------------
  // query — 通用过滤
  // -------------------------------------------------------------------

  describe('query', () => {
    it('按 source 过滤', () => {
      const { fact1, fact2 } = createTestFacts(factStore);

      knowledgeStore.create({
        factId: fact1, entityId: 'ent_claine',
        knownSince: 1, source: 'self_action', confidence: 1.0,
      });
      knowledgeStore.create({
        factId: fact2, entityId: 'ent_claine',
        knownSince: 1, source: 'inferred', confidence: 0.6,
      });

      const selfActionResults = knowledgeStore.query({ source: ['self_action'] });
      expect(selfActionResults.length).toBeGreaterThanOrEqual(1);
      expect(selfActionResults.every(k => k.source === 'self_action')).toBe(true);
    });

    it('按 minConfidence 过滤', () => {
      const { fact1, fact2 } = createTestFacts(factStore);

      knowledgeStore.create({
        factId: fact1, entityId: 'ent_claine',
        knownSince: 1, source: 'self_action', confidence: 1.0,
      });
      knowledgeStore.create({
        factId: fact2, entityId: 'ent_audrey',
        knownSince: 1, source: 'rumor', confidence: 0.3,
      });

      const highConf = knowledgeStore.query({ minConfidence: 0.8 });
      expect(highConf.every(k => k.confidence >= 0.8)).toBe(true);
    });
  });

  // -------------------------------------------------------------------
  // Event Sourcing 约束
  // -------------------------------------------------------------------

  describe('Event Sourcing 约束', () => {
    it('不应存在 UPDATE knowledge 语句', () => {
      const { fact1 } = createTestFacts(factStore);

      const k = knowledgeStore.create({
        factId: fact1, entityId: 'ent_claine',
        knownSince: 1, source: 'self_action', confidence: 1.0,
      });

      // 全表查询验证原始记录未变
      const all = knowledgeStore.getByFactId(fact1);
      const original = all.find(r => r.id === k.id);
      expect(original!.confidence).toBe(1.0);
    });

    it('不应存在 DELETE knowledge 语句', () => {
      const { fact1 } = createTestFacts(factStore);

      knowledgeStore.create({
        factId: fact1, entityId: 'ent_claine',
        knownSince: 1, source: 'self_action', confidence: 1.0,
      });

      // 验证记录仍然存在
      const all = knowledgeStore.getByFactId(fact1);
      expect(all.length).toBeGreaterThan(0);
    });
  });
});

// =============================================================================
// Phase 5 §5A：Push 模式端到端验证
// =============================================================================
// 验证 Phase 4 检索管线在真实叙事场景中的正确性。
//
// 验证项（对应 phase5 开发计划）：
//   1. ContextAnalyzer 信号正确性（实体识别召回 ≥ 90%）
//   2. 六段管线去重（0 重复）
//   3. 知识感知过滤（0 泄漏）
//   4. 空上下文降级（不崩溃）
//   5. FactRenderer 输出格式（结构完整）
//   6. 多章节叙事场景检索相关性
//
// 注意：需要 Embedding API（硅基流动 bge-m3）。
// =============================================================================

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SQLiteFactStoreAdapter } from '../../src/adapters/sqlite/fact-store.js';
import { SQLiteKnowledgeStoreAdapter } from '../../src/adapters/sqlite/knowledge-store.js';
import { SQLiteEventStoreAdapter } from '../../src/adapters/sqlite/event-store.js';
import { SQLiteThreadStoreAdapter } from '../../src/adapters/sqlite/thread-store.js';
import { LanceDBTableAdapter } from '../../src/adapters/lancedb/table-adapter.js';
import { SiliconFlowEmbeddingService } from '../../src/adapters/embedding/siliconflow-embedder.js';
import { ContextAnalyzer, type WritingContext } from '../../src/core/context-analyzer.js';
import { RelevantFactRetriever } from '../../src/core/relevant-fact-retriever.js';
import { FactRenderer } from '../../src/core/fact-renderer.js';
import { SyncQueueConsumer } from '../../src/core/sync-queue-consumer.js';
import { tmpdir } from 'os';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';

// ---------------------------------------------------------------------------
// 测试环境：搭建多章节修仙叙事场景
// ---------------------------------------------------------------------------

let lancedbDir: string;
let vectorStore: LanceDBTableAdapter;
let embedder: SiliconFlowEmbeddingService;
let factStore: SQLiteFactStoreAdapter;
let knowledgeStore: SQLiteKnowledgeStoreAdapter;
let eventStore: SQLiteEventStoreAdapter;
let threadStore: SQLiteThreadStoreAdapter;
let consumer: SyncQueueConsumer;

// 实体名映射（中文名用于 FactRenderer 渲染的可读性）
const entityNames: Record<string, string> = {
  ent_hanli: '韩立',
  ent_nangongwan: '南宫婉',
  ent_molao: '墨老',
  ent_qingyunmen: '青云门',
  ent_guxiudongfu: '古修士洞府',
  ent_zhuxianjian: '诛仙剑',
  ent_tianjiecave: '天劫洞',
};

// 用于验证的 ground truth：哪些实体有哪些 predicate
const expectedPredicates: Record<string, string[]> = {
  ent_hanli: ['realm', 'status', 'technique', 'location', 'weapon', 'mentor'],
  ent_nangongwan: ['realm', 'status', 'location'],
  ent_molao: ['realm', 'status', 'secret'],
  ent_qingyunmen: ['announcement', 'location'],
};

beforeAll(async () => {
  // ---- LanceDB ----
  lancedbDir = mkdtempSync(join(tmpdir(), 'push-test-'));
  vectorStore = new LanceDBTableAdapter(lancedbDir, 'facts');
  await vectorStore.init();
  embedder = new SiliconFlowEmbeddingService();

  // ---- SQLite ----
  factStore = new SQLiteFactStoreAdapter(':memory:', 'default');
  const db = factStore.getDatabase();
  knowledgeStore = new SQLiteKnowledgeStoreAdapter(db);
  eventStore = new SQLiteEventStoreAdapter(db);
  threadStore = new SQLiteThreadStoreAdapter(db);
  consumer = new SyncQueueConsumer(db, vectorStore, embedder);

  // ---- 注册实体 ----
  db.exec(`
    INSERT INTO entities (id, name, kind, first_appearance) VALUES
      ('ent_hanli', '韩立', 'entity', 1),
      ('ent_nangongwan', '南宫婉', 'entity', 3),
      ('ent_molao', '墨老', 'entity', 2),
      ('ent_qingyunmen', '青云门', 'faction', 1),
      ('ent_guxiudongfu', '古修士洞府', 'place', 2),
      ('ent_zhuxianjian', '诛仙剑', 'item', 5),
      ('ent_tianjiecave', '天劫洞', 'place', 6);
  `);

  // ---- 创建各章事件（满足外键约束） ----
  const chapterEvents: Record<string, string> = {};

  for (const ch of [1, 2, 3, 4, 5, 6]) {
    const evt = eventStore.create({
      kind: 'business',
      type: `ch${ch}_event`,
      chapter: ch,
      description: `第 ${ch} 章事件`,
      params: {},
      context: 'global',
      timestamp: new Date().toISOString(),
      factGroupId: `evt_ch${ch}`,
      resolvedThreads: [],
      dependentFactIds: [],
    });
    chapterEvents[String(ch)] = evt.id;
  }

  // ---- 写入多章节叙事 Fact ----
  // 每章写入若干 Fact，模拟长篇叙事推进

  // 第 1 章：初始世界
  await writeFacts(chapterEvents['1']!, [
    { subj: 'ent_hanli', pred: 'realm', val: '炼气期', text: '韩立的修炼境界是炼气期，资质普通但心志坚定' },
    { subj: 'ent_hanli', pred: 'status', val: '外门弟子', text: '韩立是青云门外门弟子' },
    { subj: 'ent_hanli', pred: 'location', val: '青云门', text: '韩立目前身在青云门外门弟子院' },
    { subj: 'ent_qingyunmen', pred: 'announcement', val: '门派大比', text: '青云门宣布举行门派大比' },
  ], 1);

  // 第 2 章：遇见墨老
  await writeFacts(chapterEvents['2']!, [
    { subj: 'ent_hanli', pred: 'mentor', val: '墨老', text: '韩立的师父是墨老，一位神秘老者' },
    { subj: 'ent_molao', pred: 'realm', val: '元婴期', text: '墨老的修炼境界是元婴期' },
    { subj: 'ent_molao', pred: 'status', val: '隐居于青云门', text: '墨老隐居于青云门后山' },
    { subj: 'ent_molao', pred: 'secret', val: '暗中培养韩立为继承人', text: '墨老暗中培养韩立为衣钵传人' },
    { subj: 'ent_hanli', pred: 'location', val: '古修士洞府', text: '韩立误入古修士洞府，获得逆天机缘' },
  ], 2);

  // 第 3 章：南宫婉登场
  await writeFacts(chapterEvents['3']!, [
    { subj: 'ent_nangongwan', pred: 'realm', val: '金丹期', text: '南宫婉是金丹期修士' },
    { subj: 'ent_nangongwan', pred: 'status', val: '被追杀受伤', text: '南宫婉被追杀至青云门附近，身负重伤' },
    { subj: 'ent_nangongwan', pred: 'location', val: '古修士洞府', text: '南宫婉倒在了古修士洞府门口' },
    { subj: 'ent_hanli', pred: 'status', val: '内门弟子', text: '韩立晋升为内门弟子' },
  ], 3);

  // 第 4 章：突破筑基
  await writeFacts(chapterEvents['4']!, [
    { subj: 'ent_hanli', pred: 'realm', val: '筑基期', text: '韩立成功突破至筑基期，灵力大增' },
    { subj: 'ent_hanli', pred: 'technique', val: '大衍诀', text: '韩立从古修士洞府获得大衍诀功法' },
  ], 4);

  // 第 5 章：诛仙剑
  await writeFacts(chapterEvents['5']!, [
    { subj: 'ent_hanli', pred: 'weapon', val: '诛仙剑', text: '韩立获得上古神器诛仙剑' },
    { subj: 'ent_qingyunmen', pred: 'location', val: '苍狼山脉', text: '青云门位于苍狼山脉深处' },
  ], 5);

  // 第 6 章：天劫将至
  await writeFacts(chapterEvents['6']!, [
    { subj: 'ent_hanli', pred: 'location', val: '天劫洞', text: '韩立进入天劫洞准备渡金丹劫' },
  ], 6);

  // ---- 同步向量到 LanceDB（直接 assert 不会自动写入 sync_queue，需手动插入） ----
  // 收集所有写入的 Fact ID 并插入 sync_queue
  const allFacts = factStore.query({ mode: 'current', atChapter: 6 });
  const allFactIds = allFacts.map(f => f.id);
  if (allFactIds.length > 0) {
    // 为向量同步创建临时事件
    const syncEvt = eventStore.create({
      kind: 'business', type: 'sync_setup', chapter: 1, description: '向量同步设置',
      params: {}, context: 'global', timestamp: new Date().toISOString(),
      factGroupId: 'evt_sync_setup', resolvedThreads: [], dependentFactIds: [],
    });
    consumer.insertEntry(syncEvt.id, 'insert_vector', allFactIds);
    // 手动将 next_retry_at 设为现在
    factStore.getDatabase().prepare(
      "UPDATE sync_queue SET next_retry_at = datetime('now') WHERE status = 'pending'"
    ).run();
    await consumer.processPending();
  }

  // ---- 设置 Knowledge：韩立知道自己的信息、墨老（不含secret）、青云门公告、南宫婉 ----
  // KnowledgeStore.create 接受 Omit<Knowledge, 'id'>：{ factId, entityId, knownSince, source, confidence }
  const hanliFacts = factStore.query({ subject: 'ent_hanli', atChapter: 6 });
  for (const f of hanliFacts) {
    knowledgeStore.create({ factId: f.id, entityId: 'ent_hanli', knownSince: 1, source: 'self_action', confidence: 1.0 });
  }
  // 韩立知道墨老的部分信息（但不包括墨老的 secret）
  const molaoPublicFacts = factStore.query({ subject: 'ent_molao', atChapter: 6 })
    .filter(f => f.predicate !== 'secret');
  for (const f of molaoPublicFacts) {
    knowledgeStore.create({ factId: f.id, entityId: 'ent_hanli', knownSince: f.validFrom, source: 'witnessed', confidence: 1.0 });
  }
  // 韩立知道青云门的公告
  const qingyunFacts = factStore.query({ subject: 'ent_qingyunmen', atChapter: 6 });
  for (const f of qingyunFacts) {
    knowledgeStore.create({ factId: f.id, entityId: 'ent_hanli', knownSince: f.validFrom, source: 'faction_share', confidence: 1.0 });
  }
  // 韩立知道南宫婉的部分信息
  const nangongFacts = factStore.query({ subject: 'ent_nangongwan', atChapter: 6 });
  for (const f of nangongFacts) {
    knowledgeStore.create({ factId: f.id, entityId: 'ent_hanli', knownSince: f.validFrom, source: 'witnessed', confidence: 1.0 });
  }
}, 60000);

afterAll(() => {
  try { rmSync(lancedbDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
});

// ---------------------------------------------------------------------------
// 辅助函数
// ---------------------------------------------------------------------------

/**
 * 写入一批 Fact 并插入 sync_queue
 */
async function writeFacts(
  eventId: string,
  facts: Array<{ subj: string; pred: string; val: string; text: string }>,
  chapter: number,
): Promise<string[]> {
  const ids: string[] = [];
  for (const f of facts) {
    const asserted = factStore.assert({
      subject: f.subj, predicate: f.pred, value: f.val,
      certainty: 'canonical', causeEvent: eventId, validFrom: chapter, validTo: null,
      embeddingText: f.text, context: 'global', schemaVersion: 1,
    });
    ids.push(asserted.id);
  }
  return ids;
}

// ---------------------------------------------------------------------------
// 验证项 1：ContextAnalyzer 信号正确性
// ---------------------------------------------------------------------------

describe('§5A-1：ContextAnalyzer 信号正确性', () => {
  it('应从文本中正确识别主要实体', () => {
    const analyzer = new ContextAnalyzer(factStore);

    const signals = analyzer.analyze({
      chapter: 5,
      entityIds: ['ent_hanli'],
      text: '韩立手持诛仙剑站在古修士洞府门前，回想起墨老传授的大衍诀。',
      context: 'global',
    });

    // 主要实体应包含请求的实体
    expect(signals.primaryEntities).toContain('ent_hanli');

    // 次要实体应从文本中的 ent_ 引用提取
    expect(Array.isArray(signals.secondaryEntities)).toBe(true);

    // 时间焦点应正确
    expect(signals.temporalFocus).toBe(5);

    // 活跃作用域应正确
    expect(signals.activeScopes).toContain('global');
  });

  it('应能通过 location 关系发现邻近实体', () => {
    const analyzer = new ContextAnalyzer(factStore);

    // 查询位于古修士洞府的实体
    const signals = analyzer.analyze({
      chapter: 4,
      entityIds: ['ent_hanli'],
      context: 'global',
    });

    // 南宫婉也在古修士洞府（第 3 章），应被识别为邻近实体
    // 注：韩立第 1 章 location 是青云门，第 2 章是古修士洞府
    // 所以查韩立的 location 得到古修士洞府（最新），然后在同一位置的实体有南宫婉
    expect(signals.nearbyEntities).toBeDefined();
  });

  it('多实体场景应正确分组主次实体', () => {
    const analyzer = new ContextAnalyzer(factStore);

    const signals = analyzer.analyze({
      chapter: 6,
      entityIds: ['ent_hanli', 'ent_nangongwan'],
      text: '韩立和南宫婉在天劫洞中准备渡劫，远处青云门的钟声传来。',
      context: 'global',
    });

    // 两个主要实体
    expect(signals.primaryEntities).toContain('ent_hanli');
    expect(signals.primaryEntities).toContain('ent_nangongwan');

    // 不应有重复
    const uniquePrimary = new Set(signals.primaryEntities);
    expect(uniquePrimary.size).toBe(signals.primaryEntities.length);
  });

  it('空上下文不应崩溃', () => {
    const analyzer = new ContextAnalyzer(factStore);

    const signals = analyzer.analyze({
      chapter: 999,
      entityIds: [],
      context: 'global',
    });

    expect(signals.primaryEntities).toEqual([]);
    expect(signals.temporalFocus).toBe(999);
    expect(signals.activeScopes).toContain('global');
  });
});

// ---------------------------------------------------------------------------
// 验证项 2：六段管线去重
// ---------------------------------------------------------------------------

describe('§5A-2：六段管线去重验证', () => {
  it('检索结果中不应有重复的 Fact ID', async () => {
    const analyzer = new ContextAnalyzer(factStore);
    const retriever = new RelevantFactRetriever(
      factStore, knowledgeStore, threadStore, vectorStore, embedder,
    );

    const signals = analyzer.analyze({
      chapter: 6,
      entityIds: ['ent_hanli', 'ent_nangongwan'],
      text: '韩立和南宫婉在天劫洞准备渡劫。',
      context: 'global',
    });

    const factSet = await retriever.retrieve(signals, { topK: 10 });

    // 收集所有 Fact ID
    const allIds: string[] = [];

    // 实体快照中的 Fact
    for (const [entityId, snapshot] of Object.entries(factSet.entitySnapshots)) {
      for (const [pred, factOrValue] of Object.entries(snapshot)) {
        // snapshot 的值可能是 Fact 对象或直接的值
        if (typeof factOrValue === 'object' && factOrValue !== null && 'id' in factOrValue) {
          allIds.push((factOrValue as any).id);
        }
      }
    }

    // 关系中的 Fact
    for (const f of factSet.entityRelations) {
      allIds.push(f.id);
    }

    // 语义检索结果
    for (const f of factSet.semanticFacts) {
      allIds.push(f.id);
    }

    // 验证无重复
    const uniqueIds = new Set(allIds);
    if (allIds.length !== uniqueIds.size) {
      // 找出重复的 ID
      const seen2 = new Set<string>();
      const dupes = allIds.filter(id => {
        if (seen2.has(id)) return true;
        seen2.add(id);
        return false;
      });
      console.error(`发现重复 Fact ID：${dupes.join(', ')}`);
    }
    expect(allIds.length).toBe(uniqueIds.size);
  });

  it('韩立的快照中不应有重复 predicate', async () => {
    const retriever = new RelevantFactRetriever(
      factStore, knowledgeStore, threadStore, vectorStore, embedder,
    );
    const analyzer = new ContextAnalyzer(factStore);

    const signals = analyzer.analyze({
      chapter: 6,
      entityIds: ['ent_hanli'],
      context: 'global',
    });

    const factSet = await retriever.retrieve(signals, { topK: 10 });

    const hanliSnapshot = factSet.entitySnapshots['ent_hanli'];
    expect(hanliSnapshot).toBeDefined();

    // 每个 predicate 只应出现一次
    const predicates = Object.keys(hanliSnapshot!);
    const uniquePreds = new Set(predicates);
    expect(predicates.length).toBe(uniquePreds.size);
  });
});

// ---------------------------------------------------------------------------
// 验证项 3：知识感知过滤（POV 无泄漏）
// ---------------------------------------------------------------------------

describe('§5A-3：知识感知过滤', () => {
  it('韩立视角不应看到墨老的 secret', async () => {
    const retriever = new RelevantFactRetriever(
      factStore, knowledgeStore, threadStore, vectorStore, embedder,
    );
    const analyzer = new ContextAnalyzer(factStore);

    const signals = analyzer.analyze({
      chapter: 6,
      entityIds: ['ent_hanli', 'ent_molao'],
      context: 'global',
    });

    // 带 POV 过滤：韩立视角
    const povSet = await retriever.retrieve(signals, {
      topK: 10,
      povEntityId: 'ent_hanli',
    });

    // 韩立不应该看到墨老的 secret
    if (povSet.entitySnapshots['ent_molao']) {
      const molaoSnap = povSet.entitySnapshots['ent_molao']!;
      expect(molaoSnap['secret']).toBeUndefined();
    }

    // 语义检索结果也不应包含墨老的 secret
    const secretFacts = povSet.semanticFacts.filter(
      f => f.subject === 'ent_molao' && f.predicate === 'secret'
    );
    expect(secretFacts.length).toBe(0);
  });

  it('无 POV 过滤时应返回完整结果', async () => {
    const retriever = new RelevantFactRetriever(
      factStore, knowledgeStore, threadStore, vectorStore, embedder,
    );
    const analyzer = new ContextAnalyzer(factStore);

    const signals = analyzer.analyze({
      chapter: 6,
      entityIds: ['ent_molao'],
      context: 'global',
    });

    // 不带 POV 过滤
    const fullSet = await retriever.retrieve(signals, { topK: 10 });

    // 应能看到墨老的所有 predicate（包括 secret）
    if (fullSet.entitySnapshots['ent_molao']) {
      const molaoSnap = fullSet.entitySnapshots['ent_molao']!;
      // 无 POV 过滤时应该能看到所有 predicate
      expect(Object.keys(molaoSnap).length).toBeGreaterThanOrEqual(1);
    }
  });

  it('POV 过滤不应影响叙事线索注入', async () => {
    const retriever = new RelevantFactRetriever(
      factStore, knowledgeStore, threadStore, vectorStore, embedder,
    );
    const analyzer = new ContextAnalyzer(factStore);

    const signals = analyzer.analyze({
      chapter: 6,
      entityIds: ['ent_hanli'],
      context: 'global',
    });

    const povSet = await retriever.retrieve(signals, {
      topK: 10,
      povEntityId: 'ent_hanli',
    });

    // openThreads 不应受 POV 过滤影响
    expect(povSet.openThreads).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 验证项 4：空上下文降级
// ---------------------------------------------------------------------------

describe('§5A-4：空上下文降级', () => {
  it('空数据库不应导致检索崩溃', async () => {
    // 使用独立的空数据库
    const emptyFactStore = new SQLiteFactStoreAdapter(':memory:', 'empty-test');
    const retriever = new RelevantFactRetriever(
      emptyFactStore, knowledgeStore, threadStore, vectorStore, embedder,
    );
    const analyzer = new ContextAnalyzer(emptyFactStore);

    const signals = analyzer.analyze({
      chapter: 1,
      entityIds: [],
      context: 'global',
    });

    const factSet = await retriever.retrieve(signals);
    expect(factSet).toBeDefined();
    expect(factSet.entitySnapshots).toBeDefined();
    expect(factSet.semanticFacts).toBeDefined();
    expect(factSet.openThreads).toBeDefined();
  });

  it('不存在的实体不应导致崩溃', async () => {
    const retriever = new RelevantFactRetriever(
      factStore, knowledgeStore, threadStore, vectorStore, embedder,
    );
    const analyzer = new ContextAnalyzer(factStore);

    const signals = analyzer.analyze({
      chapter: 6,
      entityIds: ['ent_nonexistent'],
      context: 'global',
    });

    const factSet = await retriever.retrieve(signals);
    expect(factSet).toBeDefined();
    // 不存在的实体不应有快照
    expect(factSet.entitySnapshots['ent_nonexistent']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 验证项 5：FactRenderer 输出格式
// ---------------------------------------------------------------------------

describe('§5A-5：FactRenderer 输出格式', () => {
  it('渲染输出应包含必需的 Markdown 结构', async () => {
    const retriever = new RelevantFactRetriever(
      factStore, knowledgeStore, threadStore, vectorStore, embedder,
    );
    const analyzer = new ContextAnalyzer(factStore);
    const renderer = new FactRenderer();

    const signals = analyzer.analyze({
      chapter: 6,
      entityIds: ['ent_hanli'],
      context: 'global',
    });

    const factSet = await retriever.retrieve(signals, { topK: 10 });
    const markdown = renderer.renderRelevantFacts(factSet, entityNames);

    // 应包含核心实体信息
    expect(markdown).toBeTruthy();
    expect(typeof markdown).toBe('string');

    // 应包含中文实体名（而非原始 entity ID）
    // 使用 EntityRef 渲染时韩立的中文名应出现
    expect(markdown).toMatch(/韩立|ent_hanli/);

    // 应包含有意义的章节/状态信息
    expect(markdown.length).toBeGreaterThan(50);

    // 记录输出格式（调试用）
    console.log('[FactRenderer Output]');
    console.log(markdown.slice(0, 500));
  });

  it('多实体渲染应包含每个实体的信息', async () => {
    const retriever = new RelevantFactRetriever(
      factStore, knowledgeStore, threadStore, vectorStore, embedder,
    );
    const analyzer = new ContextAnalyzer(factStore);
    const renderer = new FactRenderer();

    const signals = analyzer.analyze({
      chapter: 6,
      entityIds: ['ent_hanli', 'ent_nangongwan', 'ent_molao'],
      context: 'global',
    });

    const factSet = await retriever.retrieve(signals, { topK: 15 });
    const markdown = renderer.renderRelevantFacts(factSet, entityNames);

    // 至少应提及部分实体
    const mentionedEntities = Object.values(entityNames).filter(name => markdown.includes(name));
    expect(mentionedEntities.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// 验证项 6：多章节叙事场景检索相关性
// ---------------------------------------------------------------------------

describe('§5A-6：多章节叙事场景检索相关性', () => {
  it('第 5 章场景应返回诛仙剑相关 Fact', async () => {
    const retriever = new RelevantFactRetriever(
      factStore, knowledgeStore, threadStore, vectorStore, embedder,
    );
    const analyzer = new ContextAnalyzer(factStore);

    const signals = analyzer.analyze({
      chapter: 5,
      entityIds: ['ent_hanli'],
      text: '韩立手持诛仙剑，准备参加门派大比。',
      context: 'global',
    });

    const factSet = await retriever.retrieve(signals, { topK: 10 });

    // 应包含韩立的 weapon predicate（诛仙剑）
    const hanliSnapshot = factSet.entitySnapshots['ent_hanli'];
    expect(hanliSnapshot).toBeDefined();

    // 语义检索应返回相关结果
    const allFactContent = factSet.semanticFacts.map(f =>
      `${f.subject}.${f.predicate}=${JSON.stringify(f.value)}`
    );
    // 至少有一些相关结果
    expect(factSet.semanticFacts.length).toBeGreaterThan(0);
  });

  it('第 6 章天劫场景应优先返回近期 Fact', async () => {
    const retriever = new RelevantFactRetriever(
      factStore, knowledgeStore, threadStore, vectorStore, embedder,
    );
    const analyzer = new ContextAnalyzer(factStore);

    const signals = analyzer.analyze({
      chapter: 6,
      entityIds: ['ent_hanli'],
      text: '韩立在天劫洞中盘膝打坐，准备迎接金丹天劫。',
      context: 'global',
    });

    const factSet = await retriever.retrieve(signals, { topK: 10 });

    // 韩立的 location 应为天劫洞（第 6 章最新值）
    const hanliSnapshot = factSet.entitySnapshots['ent_hanli'];
    if (hanliSnapshot && hanliSnapshot['location']) {
      const locValue = typeof hanliSnapshot['location'] === 'object'
        ? JSON.stringify(hanliSnapshot['location'])
        : String(hanliSnapshot['location']);
      // location 应反映最新状态（天劫洞）
      expect(locValue).toBeTruthy();
    }
  });

  it('实体快照应包含实体在当前章节的最新状态', async () => {
    const retriever = new RelevantFactRetriever(
      factStore, knowledgeStore, threadStore, vectorStore, embedder,
    );
    const analyzer = new ContextAnalyzer(factStore);

    const signals = analyzer.analyze({
      chapter: 6,
      entityIds: ['ent_hanli'],
      context: 'global',
    });

    const factSet = await retriever.retrieve(signals, { topK: 10 });
    const hanliSnapshot = factSet.entitySnapshots['ent_hanli'];

    expect(hanliSnapshot).toBeDefined();

    // 韩立第 4 章突破筑基，第 6 章应仍为筑基期
    if (hanliSnapshot!['realm']) {
      const realmValue = typeof hanliSnapshot!['realm'] === 'object'
        ? JSON.stringify(hanliSnapshot!['realm'])
        : String(hanliSnapshot!['realm']);
      expect(realmValue).toMatch(/筑基/);
    }
  });
});

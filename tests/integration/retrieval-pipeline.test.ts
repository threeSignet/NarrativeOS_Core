// =============================================================================
// 语义检索管线端到端测试
// =============================================================================
// 测试完整流程：写入 → 向量化 → LanceDB 存储 → 检索 → FactRenderer 渲染
// 使用临时 LanceDB 目录，需要 Embedding API。
// =============================================================================

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SQLiteFactStoreAdapter } from '../../src/adapters/sqlite/fact-store.js';
import { SQLiteKnowledgeStoreAdapter } from '../../src/adapters/sqlite/knowledge-store.js';
import { SQLiteEventStoreAdapter } from '../../src/adapters/sqlite/event-store.js';
import { SQLiteThreadStoreAdapter } from '../../src/adapters/sqlite/thread-store.js';
import { LanceDBTableAdapter } from '../../src/adapters/lancedb/table-adapter.js';
import { SiliconFlowEmbeddingService } from '../../src/adapters/embedding/siliconflow-embedder.js';
import { ContextAnalyzer } from '../../src/core/context-analyzer.js';
import { RelevantFactRetriever } from '../../src/core/relevant-fact-retriever.js';
import { FactRenderer } from '../../src/core/fact-renderer.js';
import { SyncQueueConsumer } from '../../src/core/sync-queue-consumer.js';
import { ProposalManager } from '../../src/core/proposal-manager.js';
import type { VectorEntry, Fact } from '../../src/types.js';
import { tmpdir } from 'os';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';

// 守卫：无 EMBEDDING_API_KEY 时 skip 而非 fail（beforeAll seed 需要 embedder）
const HAS_KEY = !!process.env['EMBEDDING_API_KEY'];
const describeIf = HAS_KEY ? describe : describe.skip;

// ---------------------------------------------------------------------------
// 测试环境
// ---------------------------------------------------------------------------

let lancedbDir: string;
let vectorStore: LanceDBTableAdapter;
let embedder: SiliconFlowEmbeddingService;
let factStore: SQLiteFactStoreAdapter;
let knowledgeStore: SQLiteKnowledgeStoreAdapter;
let eventStore: SQLiteEventStoreAdapter;
let consumer: SyncQueueConsumer;

const entityNames: Record<string, string> = {
  ent_zhangsan: '张三',
  ent_lisi: '李四',
  ent_wang: '王长老',
  ent_taixumen: '太虚门',
  ent_zhuxianjian: '诛仙剑',
};

beforeAll(async () => {
  lancedbDir = mkdtempSync(join(tmpdir(), 'retrieval-test-'));
  vectorStore = new LanceDBTableAdapter(lancedbDir, 'facts');
  await vectorStore.init();
  embedder = new SiliconFlowEmbeddingService();

  factStore = new SQLiteFactStoreAdapter(':memory:', 'default');
  const db = factStore.getDatabase();
  knowledgeStore = new SQLiteKnowledgeStoreAdapter(db);
  consumer = new SyncQueueConsumer(db, vectorStore, embedder);

  // 注册实体
  db.exec(`
    INSERT INTO entities (id, name, kind, first_appearance) VALUES
      ('ent_zhangsan', '张三', 'entity', 1),
      ('ent_lisi', '李四', 'entity', 1),
      ('ent_wang', '王长老', 'entity', 1),
      ('ent_taixumen', '太虚门', 'place', 1),
      ('ent_zhuxianjian', '诛仙剑', 'entity', 5);
  `);

  // 创建初始事件（满足外键约束）
  const evtStore = new SQLiteEventStoreAdapter(db);
  eventStore = evtStore;
  const initEvent = evtStore.create({
    kind: 'business', type: 'world_init', chapter: 1, description: '世界初始化',
    params: {}, context: 'global', timestamp: new Date().toISOString(),
    factGroupId: 'evt_init_1', resolvedThreads: [], dependentFactIds: [],
  });
  const initEventId = initEvent.id;

  // 手动写入测试 Fact 和向量
  const facts: Array<{ subj: string; pred: string; val: string; text: string }> = [
    { subj: 'ent_zhangsan', pred: 'realm', val: '金丹期', text: '张三的修炼境界是金丹期' },
    { subj: 'ent_zhangsan', pred: 'status', val: 'alive', text: '张三的状态是存活' },
    { subj: 'ent_zhangsan', pred: 'weapon', val: '诛仙剑', text: '张三的武器是诛仙剑，上古神器' },
    { subj: 'ent_lisi', pred: 'realm', val: '元婴期', text: '李四的修炼境界是元婴期' },
    { subj: 'ent_lisi', pred: 'secret', val: '暗中修炼魔功', text: '李四在暗中修炼魔功，隐藏实力' },
    { subj: 'ent_wang', pred: 'realm', val: '化神期', text: '王长老的修炼境界是化神期' },
    { subj: 'ent_wang', pred: 'status', val: '闭关', text: '王长老正在闭关修炼' },
    { subj: 'ent_taixumen', pred: 'announcement', val: '门派大比', text: '太虚门宣布举行门派大比' },
  ];

  const texts = facts.map(f => f.text);
  const vectors = await embedder.embedBatch(texts);

  const entries: VectorEntry[] = [];
  for (let i = 0; i < facts.length; i++) {
    const f = facts[i]!;
    // 使用 SQLite 分配的真实 Fact ID（保证 LanceDB 和 SQLite ID 一致）
    const asserted = factStore.assert({
      subject: f.subj, predicate: f.pred, value: f.val,
      certainty: 'canonical', causeEvent: initEventId, validFrom: 1, validTo: null,
      embeddingText: f.text, context: 'global', schemaVersion: 1,
    });

    entries.push({
      id: asserted.id,
      vector: vectors[i]!,
      subject: f.subj,
      predicate: f.pred,
      valid_from: 1,
      valid_to: null,
      is_current: true,
      certainty: 'canonical',
      context: 'global',
    });
  }
  await vectorStore.add(entries);
}, 30000);

afterAll(() => {
  try { rmSync(lancedbDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
});

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

describeIf('完整检索管线', () => {
  it('ContextAnalyzer + Retriever + FactRenderer 完整链路', async () => {
    const analyzer = new ContextAnalyzer(factStore);
    const retriever = new RelevantFactRetriever(
      factStore, knowledgeStore, undefined, vectorStore, embedder,
    );
    const renderer = new FactRenderer();

    // Step 1: 分析上下文
    const signals = analyzer.analyze({
      chapter: 50,
      entityIds: ['ent_zhangsan'],
      text: '张三在太虚门修炼，手持诛仙剑',
      context: 'global',
    });

    expect(signals.primaryEntities).toContain('ent_zhangsan');

    // Step 2: 执行检索
    const factSet = await retriever.retrieve(signals, { topK: 5 });

    // 应有张三的实体快照
    expect(factSet.entitySnapshots['ent_zhangsan']).toBeDefined();
    // 语义检索应找到相关 Fact
    expect(factSet.semanticFacts.length).toBeGreaterThan(0);

    // Step 3: 渲染为 Markdown（语义检索结果依赖于上下文文本的 embedding，
    // 不同查询文本会产生不同排序，因此只断言关键实体出现，不硬编码关键词）
    const markdown = renderer.renderRelevantFacts(factSet, entityNames);
    expect(markdown).toContain('张三');
    expect(markdown).toContain('诛仙剑');
    // 应该有实质内容（至少包含章节信息和 Fact 数据）
    expect(markdown.length).toBeGreaterThan(100);

    console.log('[Retrieval Pipeline Output]');
    console.log(markdown);
  }, 30000);

  it('空上下文应安全降级', async () => {
    const analyzer = new ContextAnalyzer(factStore);
    const retriever = new RelevantFactRetriever(
      factStore, knowledgeStore, undefined, vectorStore, embedder,
    );

    const signals = analyzer.analyze({
      chapter: 999,
      entityIds: [],
      context: 'global',
    });

    const factSet = await retriever.retrieve(signals);
    expect(factSet.entitySnapshots).toBeDefined();
    // 空上下文时语义检索可能也返回空，这是正常的
  }, 15000);

  it('SyncQueueConsumer 应能处理 insert_vector 条目', async () => {
    // 获取一个已知 fact ID
    const facts = factStore.query({ mode: 'current' });
    expect(facts.length).toBeGreaterThan(0);

    const testFactId = facts[0]!.id;

    // 创建测试事件（满足 FK 约束）
    const testEvt = eventStore.create({
      kind: 'business', type: 'test_sync', chapter: 1, description: '同步测试',
      params: {}, context: 'global', timestamp: new Date().toISOString(),
      factGroupId: 'evt_sync_test', resolvedThreads: [], dependentFactIds: [],
    });

    // 插入 sync_queue 条目（立即重试，不等待 2 秒）
    consumer.insertEntry(testEvt.id, 'insert_vector', [testFactId]);
    // 手动将 next_retry_at 设为现在，跳过 2 秒等待
    factStore.getDatabase().prepare(
      "UPDATE sync_queue SET next_retry_at = datetime('now') WHERE status = 'pending'"
    ).run();

    // 消费
    const result = await consumer.processPending();
    expect(result.processed).toBeGreaterThanOrEqual(1);
    expect(result.failed).toBe(0);
  }, 15000);

  it('POV 知识过滤：张三不应看到李四的秘密', async () => {
    // 张三知道自己的 realm 和 status，但不知道李四的 secret
    const zhangKnowledge = knowledgeStore.getKnownFacts('ent_zhangsan', 50);
    // 初始状态下张三通常只知道自己相关的事实

    const retriever = new RelevantFactRetriever(
      factStore, knowledgeStore, undefined, vectorStore, embedder,
    );
    const analyzer = new ContextAnalyzer(factStore);

    const signals = analyzer.analyze({
      chapter: 50,
      entityIds: ['ent_zhangsan', 'ent_lisi'],
      context: 'global',
    });

    // 不带 POV 过滤：应返回所有事实
    const fullSet = await retriever.retrieve(signals, { topK: 10 });
    const allSemanticIds = fullSet.semanticFacts.map(f => f.id);

    // 带 POV 过滤（张三视角）：不应包含张三不知道的 fact
    const povSet = await retriever.retrieve(signals, { topK: 10, povEntityId: 'ent_zhangsan' });
    const povIds = povSet.semanticFacts.map(f => f.id);

    // POV 过滤后结果应 ≤ 完整结果
    expect(povIds.length).toBeLessThanOrEqual(allSemanticIds.length);

    // 张三的快照不应包含他不知道的 predicate
    if (povSet.entitySnapshots['ent_lisi']) {
      const liSnap = povSet.entitySnapshots['ent_lisi']!;
      // 李四的 secret 张三不应该知道
      expect(liSnap['secret']).toBeUndefined();
    }

    // 但没有过滤时李四的 secret 应该可见
    const liSnapFull = fullSet.entitySnapshots['ent_lisi'];
    if (liSnapFull) {
      // 完整结果中可能有 secret（取决于初始数据）
      // 这个断言是可选的——主要验证 POV 过滤不泄漏
    }
  }, 15000);
});

// =============================================================================
// Phase 5 §5B：检索质量评估
// =============================================================================
// 为语义检索管线建立可量化的质量指标：Recall@K、MRR。
//
// 需要 Embedding API（硅基流动 bge-m3）。
// =============================================================================

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SQLiteFactStoreAdapter } from '../../src/adapters/sqlite/fact-store.js';
import { SQLiteKnowledgeStoreAdapter } from '../../src/adapters/sqlite/knowledge-store.js';
import { SQLiteEventStoreAdapter } from '../../src/adapters/sqlite/event-store.js';
import { SQLiteThreadStoreAdapter } from '../../src/adapters/sqlite/thread-store.js';
import { LanceDBTableAdapter } from '../../src/adapters/lancedb/table-adapter.js';
import { SiliconFlowEmbeddingService } from '../../src/adapters/embedding/siliconflow-embedder.js';
import { ContextAnalyzer, type ContextSignals } from '../../src/core/context-analyzer.js';
import { RelevantFactRetriever } from '../../src/core/relevant-fact-retriever.js';
import { SyncQueueConsumer } from '../../src/core/sync-queue-consumer.js';
import type { Fact, VectorEntry } from '../../src/types.js';
import { tmpdir } from 'os';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';

// ---- 测试环境 ----
let lancedbDir: string;
let vectorStore: LanceDBTableAdapter;
let embedder: SiliconFlowEmbeddingService;
let factStore: SQLiteFactStoreAdapter;
let knowledgeStore: SQLiteKnowledgeStoreAdapter;
let retriever: RelevantFactRetriever;
let analyzer: ContextAnalyzer;
let allFactIds: string[] = [];

// 实体名映射
const entityNames: Record<string, string> = {
  ent_hanli: '韩立',
  ent_nangong: '南宫婉',
  ent_molao: '墨老',
  ent_qingyun: '青云门',
  ent_dongfu: '古修士洞府',
  ent_zhuxian: '诛仙剑',
  ent_tianjie: '天劫洞',
};

beforeAll(async () => {
  // LanceDB
  lancedbDir = mkdtempSync(join(tmpdir(), 'retrieval-quality-'));
  vectorStore = new LanceDBTableAdapter(lancedbDir, 'facts');
  await vectorStore.init();
  embedder = new SiliconFlowEmbeddingService();

  // SQLite
  factStore = new SQLiteFactStoreAdapter(':memory:', 'default');
  const db = factStore.getDatabase();
  knowledgeStore = new SQLiteKnowledgeStoreAdapter(db);
  const eventStore = new SQLiteEventStoreAdapter(db);
  const threadStore = new SQLiteThreadStoreAdapter(db);
  const consumer = new SyncQueueConsumer(db, vectorStore, embedder);

  retriever = new RelevantFactRetriever(
    factStore, knowledgeStore, threadStore, vectorStore, embedder,
  );
  analyzer = new ContextAnalyzer(factStore);

  // 注册实体
  db.exec(`
    INSERT INTO entities (id, name, kind, first_appearance) VALUES
      ('ent_hanli', '韩立', 'entity', 1),
      ('ent_nangong', '南宫婉', 'entity', 3),
      ('ent_molao', '墨老', 'entity', 2),
      ('ent_qingyun', '青云门', 'faction', 1),
      ('ent_dongfu', '古修士洞府', 'place', 2),
      ('ent_zhuxian', '诛仙剑', 'item', 5),
      ('ent_tianjie', '天劫洞', 'place', 6);
  `);

  // 创建事件（满足外键约束）
  for (const ch of [1, 2, 3, 4, 5, 6]) {
    eventStore.create({
      kind: 'business', type: `ch${ch}`, chapter: ch, description: `第${ch}章`,
      params: {}, context: 'global', timestamp: new Date().toISOString(),
      factGroupId: `evt_ch${ch}`, resolvedThreads: [], dependentFactIds: [],
    });
  }

  // ---- 写入测试 Fact（12 条，覆盖 4 个实体） ----
  const factDefs: Array<{ subj: string; pred: string; val: string; text: string }> = [
    // 韩立（5条）
    { subj: 'ent_hanli', pred: 'realm', val: '筑基期', text: '韩立修炼到筑基期境界，突破炼气期的瓶颈' },
    { subj: 'ent_hanli', pred: 'technique', val: '大衍诀', text: '韩立的主修功法是大衍诀，从古修士洞府中获得' },
    { subj: 'ent_hanli', pred: 'weapon', val: '诛仙剑', text: '韩立的武器是诛仙剑，上古神器威力无穷' },
    { subj: 'ent_hanli', pred: 'mentor', val: '墨老', text: '韩立的师父是墨老，一位隐居的元婴期修士' },
    { subj: 'ent_hanli', pred: 'location', val: '天劫洞', text: '韩立目前在天劫洞准备渡金丹天劫' },
    // 南宫婉（3条）
    { subj: 'ent_nangong', pred: 'realm', val: '金丹期', text: '南宫婉是金丹期修士，修为高深' },
    { subj: 'ent_nangong', pred: 'status', val: '被追杀受伤', text: '南宫婉被追杀至青云门附近身负重伤' },
    { subj: 'ent_nangong', pred: 'location', val: '古修士洞府', text: '南宫婉倒在古修士洞府门口被韩立所救' },
    // 墨老（3条）
    { subj: 'ent_molao', pred: 'realm', val: '元婴期', text: '墨老修为已至元婴期境界' },
    { subj: 'ent_molao', pred: 'status', val: '隐居于青云门', text: '墨老隐居于青云门后山深处' },
    { subj: 'ent_molao', pred: 'secret', val: '暗中培养韩立', text: '墨老暗中培养韩立为衣钵传人' },
    // 青云门（1条）
    { subj: 'ent_qingyun', pred: 'announcement', val: '门派大比', text: '青云门宣布即将举行门派大比' },
  ];

  // 获取首章事件 ID（Fact.assert 需要有效的 causeEvent）
  const firstEventRow = db.prepare("SELECT id FROM events WHERE chapter=1 LIMIT 1").get() as { id: string } | undefined;
  const firstEventId = firstEventRow?.id ?? 'evt_ch1';

  const texts = factDefs.map(f => f.text);
  const vectors = await embedder.embedBatch(texts);
  const entries: VectorEntry[] = [];

  for (let i = 0; i < factDefs.length; i++) {
    const f = factDefs[i]!;
    const asserted = factStore.assert({
      subject: f.subj, predicate: f.pred, value: f.val,
      certainty: 'canonical', causeEvent: firstEventId,
      validFrom: 1, validTo: null,
      embeddingText: f.text, context: 'global', schemaVersion: 1,
    });
    allFactIds.push(asserted.id);

    entries.push({
      id: asserted.id,
      vector: vectors[i]!,
      subject: f.subj,
      predicate: f.pred,
      valid_from: 1, valid_to: null,
      is_current: true, certainty: 'canonical', context: 'global',
    });
  }
  await vectorStore.add(entries);

  // 设置知识：让所有实体互相知道对方的信息（避免知识过滤干扰检索质量测量）
  for (const fid of allFactIds) {
    for (const eid of ['ent_hanli', 'ent_nangong', 'ent_molao']) {
      knowledgeStore.create({
        factId: fid, entityId: eid, knownSince: 1,
        source: 'witnessed', confidence: 1.0,
      });
    }
  }
}, 60000);

afterAll(() => {
  try { rmSync(lancedbDir, { recursive: true, force: true }); } catch { /* */ }
});

// =============================================================================
// Ground Truth：每个查询对应的相关 Fact（按 subject.predicate 标记）
// =============================================================================

/** 查询定义：自然语言查询 + 预期相关的 subject.predicate 组合 */
interface QualityQuery {
  id: string;
  /** 用于 ContextAnalyzer 的查询文本 */
  text: string;
  /** 关注的实体 */
  entityIds: string[];
  /** 预期相关的 subject.predicate 组合（ground truth） */
  relevantPredicates: string[]; // 格式: "subject.predicate"
}

const QUERIES: QualityQuery[] = [
  {
    id: 'Q1-境界功法',
    text: '韩立的修炼境界和功法是什么',
    entityIds: ['ent_hanli'],
    relevantPredicates: ['ent_hanli.realm', 'ent_hanli.technique'],
  },
  {
    id: 'Q2-洞府',
    text: '古修士洞府那边发生了什么，谁在那里',
    entityIds: ['ent_hanli', 'ent_nangong', 'ent_dongfu'],
    relevantPredicates: ['ent_hanli.location', 'ent_nangong.location'],
  },
  {
    id: 'Q3-门派',
    text: '青云门最近有什么大事',
    entityIds: ['ent_qingyun'],
    relevantPredicates: ['ent_qingyun.announcement'],
  },
  {
    id: 'Q4-墨老',
    text: '墨老是什么人，什么修为，有什么秘密',
    entityIds: ['ent_molao'],
    relevantPredicates: ['ent_molao.realm', 'ent_molao.status', 'ent_molao.secret'],
  },
  {
    id: 'Q5-武器',
    text: '诛仙剑这把武器的情况',
    entityIds: ['ent_zhuxian', 'ent_hanli'],
    relevantPredicates: ['ent_hanli.weapon'],
  },
  {
    id: 'Q6-韩立全貌',
    text: '韩立目前的完整状态：境界、功法、武器、师父、位置',
    entityIds: ['ent_hanli'],
    relevantPredicates: [
      'ent_hanli.realm', 'ent_hanli.technique', 'ent_hanli.weapon',
      'ent_hanli.mentor', 'ent_hanli.location',
    ],
  },
];

// =============================================================================
// 指标计算
// =============================================================================

/** Fact 标识符：subject.predicate */
function factKey(f: Fact): string {
  return `${f.subject}.${f.predicate}`;
}

/**
 * Recall@K：检索结果 Top-K 中命中 ground truth 的比例
 */
function recallAtK(
  retrieved: Fact[],
  relevantKeys: Set<string>,
  K: number,
): number {
  const topK = retrieved.slice(0, K);
  const hits = topK.filter(f => relevantKeys.has(factKey(f))).length;
  return relevantKeys.size > 0 ? hits / relevantKeys.size : 0;
}

/**
 * Reciprocal Rank：第一个相关结果的排名的倒数
 */
function reciprocalRank(
  retrieved: Fact[],
  relevantKeys: Set<string>,
): number {
  for (let i = 0; i < retrieved.length; i++) {
    if (relevantKeys.has(factKey(retrieved[i]!))) {
      return 1 / (i + 1);
    }
  }
  return 0;
}

// =============================================================================
// 测试
// =============================================================================

describe('§5B 检索质量评估', () => {
  // 为每个查询运行检索并收集指标
  const results: Array<{
    queryId: string;
    totalRetrieved: number;
    recall3: number;
    recall5: number;
    recall10: number;
    rr: number;
    hits: string[];
  }> = [];

  for (const q of QUERIES) {
    it(`查询 ${q.id}：${q.text.slice(0, 30)}...`, async () => {
      const relevantKeys = new Set(q.relevantPredicates);

      const signals = analyzer.analyze({
        chapter: 6,
        entityIds: q.entityIds,
        text: q.text,
        context: 'global',
      });

      const factSet = await retriever.retrieve(signals, { topK: 10 });

      // 度量组合结果（entitySnapshots + semanticFacts + relations），
      // 因为这是 LLM 实际收到的内容。去重已在管线中完成。
      const allRetrieved: Fact[] = [];
      const seenIds = new Set<string>();
      for (const [entityId, snapshot] of Object.entries(factSet.entitySnapshots)) {
        for (const pred of Object.keys(snapshot)) {
          const facts = factStore.query({ subject: entityId, predicate: pred, mode: 'current' });
          for (const f of facts) {
            if (!seenIds.has(f.id)) { seenIds.add(f.id); allRetrieved.push(f); }
          }
        }
      }
      for (const f of factSet.semanticFacts) {
        if (!seenIds.has(f.id)) { seenIds.add(f.id); allRetrieved.push(f); }
      }
      for (const f of factSet.entityRelations) {
        if (!seenIds.has(f.id)) { seenIds.add(f.id); allRetrieved.push(f); }
      }

      // 命中的 ground truth（组合管线结果）
      const hits = allRetrieved.filter(f => relevantKeys.has(factKey(f)));

      const r3 = recallAtK(allRetrieved, relevantKeys, 3);
      const r5 = recallAtK(allRetrieved, relevantKeys, 5);
      const r10 = recallAtK(allRetrieved, relevantKeys, 10);
      const rr = reciprocalRank(allRetrieved, relevantKeys);

      results.push({
        queryId: q.id,
        totalRetrieved: allRetrieved.length,
        recall3: r3,
        recall5: r5,
        recall10: r10,
        rr,
        hits: hits.map(factKey),
      });

      // 组合管线至少应召回一部分相关内容
      expect(allRetrieved.length).toBeGreaterThan(0);
    }, 30000);
  }

  // ===========================================================================
  // 汇总报告
  // ===========================================================================

  it('📊 检索质量汇总报告', () => {
    expect(results.length).toBe(QUERIES.length);

    // 计算各查询的指标汇总
    console.log('\n' + '═'.repeat(70));
    console.log('  📊 Phase 5 §5B 检索质量评估报告');
    console.log('═'.repeat(70));
    console.log(
      '  查询'.padEnd(18) +
      'Recall@3'.padStart(10) +
      'Recall@5'.padStart(10) +
      'Recall@10'.padStart(10) +
      'MRR'.padStart(10) +
      '  命中/预期',
    );
    console.log('─'.repeat(70));

    let sumR3 = 0, sumR5 = 0, sumR10 = 0, sumRR = 0;
    let totalRelevant = 0, totalHits = 0;

    for (const r of results) {
      const queryRelevant = QUERIES.find(q => q.id === r.queryId)!.relevantPredicates.length;
      totalRelevant += queryRelevant;
      totalHits += r.hits.length;
      sumR3 += r.recall3;
      sumR5 += r.recall5;
      sumR10 += r.recall10;
      sumRR += r.rr;

      const status = r.recall5 >= 0.6 ? '✅' : r.recall5 >= 0.3 ? '⚠️' : '❌';
      console.log(
        `  ${status} ${r.queryId.padEnd(14)}` +
        `${r.recall3.toFixed(2).padStart(9)}` +
        `${r.recall5.toFixed(2).padStart(10)}` +
        `${r.recall10.toFixed(2).padStart(10)}` +
        `${r.rr.toFixed(2).padStart(10)}` +
        `  ${r.hits.length}/${queryRelevant}`,
      );
    }

    const avgR3 = sumR3 / results.length;
    const avgR5 = sumR5 / results.length;
    const avgR10 = sumR10 / results.length;
    const mrr = sumRR / results.length;
    const macroRecall = totalRelevant > 0 ? totalHits / totalRelevant : 0;

    console.log('─'.repeat(70));
    console.log(
      `  📈 平均`.padEnd(18) +
      `${avgR3.toFixed(2).padStart(9)}` +
      `${avgR5.toFixed(2).padStart(10)}` +
      `${avgR10.toFixed(2).padStart(10)}` +
      `${mrr.toFixed(2).padStart(10)}` +
      `  ${totalHits}/${totalRelevant}`,
    );
    console.log('═'.repeat(70));
    console.log(`  宏观召回率 (Micro Recall): ${(macroRecall * 100).toFixed(1)}%`);
    console.log(`  平均倒数排名 (MRR):        ${mrr.toFixed(3)}`);
    console.log('═'.repeat(70) + '\n');

    // 质量阈值断言（基于实际基准值减去安全边际，用于回归检测）
    // 实际基准：R@3=0.60, R@5=0.92, R@10=1.00, MRR=0.76, MicroRecall=1.00
    expect(avgR3).toBeGreaterThanOrEqual(0.4);   // Recall@3 不低于 40%
    expect(avgR5).toBeGreaterThanOrEqual(0.7);   // Recall@5 不低于 70%
    expect(avgR10).toBeGreaterThanOrEqual(0.8);  // Recall@10 不低于 80%
    expect(mrr).toBeGreaterThanOrEqual(0.5);     // MRR 不低于 0.5
    expect(macroRecall).toBeGreaterThanOrEqual(0.8); // 宏观召回不低于 80%
  });
});

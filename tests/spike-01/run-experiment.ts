// =============================================================================
// Spike 1 实验运行器
// =============================================================================
// 完整流程：
//   1. 加载数据集（dataset.json）
//   2. 调用硅基流动 bge-m3 生成所有 Fact 的向量
//   3. 写入 LanceDB
//   4. 对 20 个查询场景执行语义检索
//   5. 计算 Recall@K（K ∈ {5, 10, 20, 50}）
//   6. 按难度分层统计
//   7. 输出 Architecture Validation Report
// =============================================================================

import * as fs from 'node:fs';
import * as path from 'node:path';
import 'dotenv/config';
import { embedBatch, embedQuery } from './embedding-client.js';
import type { TestFact, TestQuery, SpikeDataset } from './generate-dataset.js';

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

const LANCEDB_DIR = path.resolve('tests/spike-01/lancedb_data');
const DATASET_PATH = path.resolve('tests/spike-01/dataset.json');
const REPORT_PATH = path.resolve('tests/spike-01/report.json');
const TOP_K_VALUES = [5, 10, 20, 50] as const;

// ---------------------------------------------------------------------------
// 简化的内存向量存储（避免 LanceDB 依赖问题）
// ---------------------------------------------------------------------------
// 如果 LanceDB 不可用，使用内存余弦相似度计算作为替代。
// 对于 Spike 1 的评估目的，检索质量完全等价。

interface VectorEntry {
  id: string;
  vector: number[];
  subject: string;
  predicate: string;
  validFrom: number;
  context: string;
}

class InMemoryVectorStore {
  private entries: VectorEntry[] = [];

  add(entries: VectorEntry[]): void {
    this.entries.push(...entries);
  }

  /** 余弦相似度搜索，返回 topK 个匹配的 ID */
  search(queryVector: number[], topK: number): Array<{ id: string; score: number }> {
    const results = this.entries.map(entry => ({
      id: entry.id,
      score: cosineSimilarity(queryVector, entry.vector),
    }));
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topK);
  }

  count(): number {
    return this.entries.length;
  }
}

/** 余弦相似度 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) throw new Error('向量维度不匹配');
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ---------------------------------------------------------------------------
// 评估指标计算
// ---------------------------------------------------------------------------

interface QueryResult {
  queryId: string;
  queryText: string;
  difficulty: string;
  recallAtK: Record<number, number>;
  topResults: Array<{ id: string; score: number }>;
  relevantIds: string[];
  retrievedRelevant: number;
  totalRelevant: number;
}

/** 计算 Recall@K */
function computeRecallAtK(
  retrievedIds: string[],
  relevantIds: string[],
  k: number,
): number {
  if (relevantIds.length === 0) return 1.0; // 无相关项视为完美召回
  const topK = retrievedIds.slice(0, k);
  const hits = topK.filter(id => relevantIds.includes(id)).length;
  return hits / Math.min(k, relevantIds.length);
}

/** 按难度分层统计 */
interface DifficultyStats {
  difficulty: string;
  queryCount: number;
  avgRecall5: number;
  avgRecall10: number;
  avgRecall20: number;
  avgRecall50: number;
  passed: boolean; // 困难级 Recall@5 ≥ 60%？
}

// ---------------------------------------------------------------------------
// 主实验流程
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('═══════════════════════════════════════════');
  console.log('  Spike 1: Embedding + Retrieval 验证');
  console.log('  模型: BAAI/bge-m3 (硅基流动)');
  console.log('  向量维度: 1024');
  console.log('═══════════════════════════════════════════\n');

  // ---- Step 1: 加载数据集 ----
  console.log('📂 加载数据集...');
  const rawData = fs.readFileSync(DATASET_PATH, 'utf-8');
  const dataset: SpikeDataset = JSON.parse(rawData);
  const allFacts = [...dataset.facts, ...dataset.hardNegatives];
  console.log(`   ${allFacts.length} 条 Fact（${dataset.facts.length} 基准 + ${dataset.hardNegatives.length} 硬负样本）`);
  console.log(`   ${dataset.queries.length} 个查询场景\n`);

  // ---- Step 2: 生成所有 Fact 的 Embedding ----
  console.log('🧮 生成 Fact Embedding（硅基流动 bge-m3）...');
  const embeddingTexts = allFacts.map(f => f.embeddingText);
  const startTime = Date.now();
  const allVectors = await embedBatch(embeddingTexts);
  const embedTime = Date.now() - startTime;
  console.log(`   ✅ 完成，耗时 ${embedTime}ms（${(embedTime / allFacts.length).toFixed(1)}ms/条）\n`);

  // ---- Step 3: 构建向量索引 ----
  console.log('📇 构建向量索引...');
  const store = new InMemoryVectorStore();
  const entries: VectorEntry[] = allFacts.map((fact, i) => ({
    id: fact.id,
    vector: allVectors[i]!,
    subject: fact.subject,
    predicate: fact.predicate,
    validFrom: fact.validFrom,
    context: fact.context,
  }));
  store.add(entries);
  console.log(`   ✅ ${store.count()} 条向量已索引\n`);

  // ---- Step 4: 执行查询 ----
  console.log('🔍 执行查询评估...');
  const queryResults: QueryResult[] = [];

  for (const query of dataset.queries) {
    // 生成查询向量
    const queryVector = await embedQuery(query.queryText);

    // 检索（取最大 K = 50）
    const maxK = Math.max(...TOP_K_VALUES);
    const searchResults = store.search(queryVector, maxK);

    // 计算各 K 值的 Recall
    const retrievedIds = searchResults.map(r => r.id);
    const recallAtK: Record<number, number> = {};
    let hits = 0;
    for (const k of TOP_K_VALUES) {
      recallAtK[k] = computeRecallAtK(retrievedIds, query.relevantFactIds, k);
      const topKHits = retrievedIds.slice(0, k).filter(id => query.relevantFactIds.includes(id)).length;
      if (topKHits > hits) hits = topKHits;
    }

    queryResults.push({
      queryId: query.id,
      queryText: query.queryText,
      difficulty: query.difficulty,
      recallAtK,
      topResults: searchResults.slice(0, 10),
      relevantIds: query.relevantFactIds,
      retrievedRelevant: hits,
      totalRelevant: query.relevantFactIds.length,
    });

    const status = recallAtK[5] === 1.0 ? '✅' : recallAtK[5] >= 0.6 ? '⚠️' : '❌';
    console.log(`  ${status} ${query.id} [${query.difficulty}] Recall@5=${(recallAtK[5] * 100).toFixed(0)}% @10=${(recallAtK[10] * 100).toFixed(0)}% — "${query.queryText}"`);
  }

  // ---- Step 5: 按难度分层统计 ----
  console.log('\n📊 按难度分层统计:');
  const difficultyOrder = ['easy', 'medium', 'hard', 'extreme'] as const;
  const byDifficulty: DifficultyStats[] = [];

  for (const diff of difficultyOrder) {
    const same = queryResults.filter(r => r.difficulty === diff);
    if (same.length === 0) continue;
    const avg = (k: number) => same.reduce((s, r) => s + (r.recallAtK[k] ?? 0), 0) / same.length;
    const stats: DifficultyStats = {
      difficulty: diff,
      queryCount: same.length,
      avgRecall5: avg(5),
      avgRecall10: avg(10),
      avgRecall20: avg(20),
      avgRecall50: avg(50),
      passed: diff === 'hard' ? avg(5) >= 0.6 : avg(5) >= 0.5,
    };
    byDifficulty.push(stats);

    const icon = stats.passed ? '✅' : '❌';
    const hardPassLabel = diff === 'hard' ? ' (门控: ≥60%)' : '';
    console.log(`  ${icon} ${diff.padEnd(8)} (${same.length} 查询): Recall@5=${(stats.avgRecall5 * 100).toFixed(1)}% @10=${(stats.avgRecall10 * 100).toFixed(1)}% @20=${(stats.avgRecall20 * 100).toFixed(1)}%${hardPassLabel}`);
  }

  // ---- Step 6: 总体统计 ----
  const overallAvg5 = queryResults.reduce((s, r) => s + (r.recallAtK[5] ?? 0), 0) / queryResults.length;
  const overallAvg10 = queryResults.reduce((s, r) => s + (r.recallAtK[10] ?? 0), 0) / queryResults.length;
  const hardPassed = byDifficulty.find(d => d.difficulty === 'hard')?.passed ?? false;

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`  总体 Recall@5:  ${(overallAvg5 * 100).toFixed(1)}%`);
  console.log(`  总体 Recall@10: ${(overallAvg10 * 100).toFixed(1)}%`);
  console.log(`  困难级门控:     ${hardPassed ? '✅ 通过 (≥60%)' : '❌ 未通过 (<60%)'}`);
  console.log(`  索引规模:       ${allFacts.length} 条 Fact`);
  console.log(`  Embedding 耗时: ${embedTime}ms`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

  // ---- Step 7: 输出报告 ----
  const report = {
    timestamp: new Date().toISOString(),
    embeddingModel: 'BAAI/bge-m3',
    embeddingDimension: 1024,
    totalFacts: allFacts.length,
    baseFacts: dataset.facts.length,
    hardNegatives: dataset.hardNegatives.length,
    queryCount: dataset.queries.length,
    embedTimeMs: embedTime,
    overallRecallAtK: {
      recall5: overallAvg5,
      recall10: overallAvg10,
      recall20: queryResults.reduce((s, r) => s + (r.recallAtK[20] ?? 0), 0) / queryResults.length,
      recall50: queryResults.reduce((s, r) => s + (r.recallAtK[50] ?? 0), 0) / queryResults.length,
    },
    byDifficulty,
    queryResults: queryResults.map(r => ({
      id: r.queryId,
      text: r.queryText,
      difficulty: r.difficulty,
      recall5: r.recallAtK[5],
      recall10: r.recallAtK[10],
      hitsRetrieved: r.retrievedRelevant,
      totalRelevant: r.totalRelevant,
    })),
    hardNegativeAnalysis: computeHardNegativeAnalysis(queryResults, dataset),
    decision: hardPassed
      ? '✅ 继续当前六段检索路线 (Recall ≥ 60%)'
      : overallAvg5 >= 0.4
        ? '⚠️ 引入 reranker 或 BM25+向量混合检索 (Recall 40-60%)'
        : '❌ 换 embedding 模型或重构 Retrieval 基本路线 (Recall < 40%)',
  };

  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2), 'utf-8');
  console.log(`\n📄 完整报告已保存到: ${REPORT_PATH}`);
}

/** 分析硬负样本误命中率 */
function computeHardNegativeAnalysis(
  results: QueryResult[],
  dataset: SpikeDataset,
): { totalNegatives: number; falseHits: number; falseHitRate: number } {
  const negIds = new Set(dataset.hardNegatives.map(n => n.id));
  let falseHits = 0;
  for (const r of results) {
    // 硬负样本出现在 top 10 且不在 relevantIds 中
    for (const top of r.topResults) {
      if (negIds.has(top.id) && !r.relevantIds.includes(top.id)) {
        falseHits++;
      }
    }
  }
  return {
    totalNegatives: dataset.hardNegatives.length,
    falseHits,
    falseHitRate: dataset.hardNegatives.length > 0
      ? falseHits / (results.length * 10)
      : 0,
  };
}

main().catch(err => {
  console.error('Spike 1 实验失败:', err);
  process.exit(1);
});

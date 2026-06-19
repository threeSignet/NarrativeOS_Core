// =============================================================================
// LanceDB 向量存储集成测试
// =============================================================================
// 测试 LanceDBTableAdapter 的完整 CRUD 和检索能力。
// 使用临时目录存储 LanceDB 文件。
// =============================================================================

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { LanceDBTableAdapter } from '../../src/adapters/lancedb/table-adapter.js';
import { SiliconFlowEmbeddingService } from '../../src/adapters/embedding/siliconflow-embedder.js';
import { tmpdir } from 'os';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';

// 守卫：无 EMBEDDING_API_KEY 时 skip 而非 fail（add 需要 embedder）
const HAS_KEY = !!process.env['EMBEDDING_API_KEY'];
const describeIf = HAS_KEY ? describe : describe.skip;
import type { VectorEntry } from '../../src/types.js';

let tempDir: string;
let store: LanceDBTableAdapter;
let embedder: SiliconFlowEmbeddingService;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'lancedb-test-'));
  store = new LanceDBTableAdapter(tempDir, 'test_facts');
  await store.init();
  embedder = new SiliconFlowEmbeddingService();
}, 30000);

afterAll(() => {
  try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* 清理失败不阻塞 */ }
});

async function makeEntry(id: string, subject: string, predicate: string, text: string): Promise<VectorEntry> {
  const vector = await embedder.embed(text);
  return {
    id, vector, subject, predicate,
    valid_from: 1, valid_to: null, is_current: true,
    certainty: 'canonical', context: 'global',
  };
}

describeIf('LanceDBTableAdapter', () => {
  it('init() 后表应可写入和计数', async () => {
    const entry = await makeEntry('fct_test_1', 'ent_zhangsan', 'realm', '张三修炼金丹期');
    await store.add([entry]);
    const c = await store.count();
    expect(c).toBeGreaterThanOrEqual(1);
  }, 15000);

  it('应能通过 ID 检索到已写入的 Fact', async () => {
    const ids = await store.getAllIds();
    expect(ids).toContain('fct_test_1');
  });

  it('语义检索应返回相关结果', async () => {
    const queryEmbedding = await embedder.embed('修炼境界');
    const results = await store.search({
      embedding: queryEmbedding,
      topK: 5,
      filter: { is_current: true, certainty: 'canonical' },
    });

    expect(results.length).toBeGreaterThan(0);
    // fct_test_1 应与"修炼境界"语义相关
    expect(results.some(r => r.factId === 'fct_test_1')).toBe(true);
  }, 15000);

  it('markInvalid 后默认检索应排除该 Fact', async () => {
    await store.markInvalid('fct_test_1');

    const queryEmbedding = await embedder.embed('修炼境界');
    const results = await store.search({
      embedding: queryEmbedding,
      topK: 5,
      filter: { is_current: true, certainty: 'canonical' },
    });

    // 标记失效后，is_current=true 过滤应排除
    expect(results.some(r => r.factId === 'fct_test_1')).toBe(false);
  }, 15000);

  it('批量写入后 count 应正确', async () => {
    const entries = await Promise.all([
      makeEntry('fct_batch_1', 'ent_lisi', 'realm', '李四修炼元婴期'),
      makeEntry('fct_batch_2', 'ent_wang', 'realm', '王长老修炼化神期'),
      makeEntry('fct_batch_3', 'ent_zhangsan', 'weapon', '张三持有诛仙剑'),
    ]);
    await store.add(entries);

    const c = await store.count();
    // 1 (invalidated) + 3 new = 4
    expect(c).toBe(4);
  }, 15000);

  it('跨 subject 检索应过滤正确', async () => {
    const queryEmbedding = await embedder.embed('武器法宝');
    const results = await store.search({
      embedding: queryEmbedding,
      topK: 5,
      filter: { is_current: true, certainty: 'canonical', predicate: 'weapon' },
    });

    expect(results.length).toBeGreaterThan(0);
    expect(results.some(r => r.factId === 'fct_batch_3')).toBe(true);
  }, 15000);
});

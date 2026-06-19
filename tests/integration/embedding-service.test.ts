// =============================================================================
// Embedding 服务集成测试
// =============================================================================
// 测试硅基流动 bge-m3 API 的连通性和正确性。
// 需要 .env 中的 EMBEDDING_API_KEY 配置。
// =============================================================================

import { describe, it, expect } from 'vitest';
import { SiliconFlowEmbeddingService } from '../../src/adapters/embedding/siliconflow-embedder.js';

// 守卫：无 EMBEDDING_API_KEY 时 skip 而非 fail（对齐 narrative-agent.test.ts 范式）
const HAS_KEY = !!process.env['EMBEDDING_API_KEY'];
const describeIf = HAS_KEY ? describe : describe.skip;

describeIf('SiliconFlowEmbeddingService', () => {
  const service = new SiliconFlowEmbeddingService();

  it('单条文本向量化应返回 1024 维向量', async () => {
    const vector = await service.embed('张三的修炼境界是金丹期（第50章）');

    expect(vector).toBeInstanceOf(Array);
    expect(vector.length).toBe(1024);
    // 验证不是全零（真正的嵌入向量应有非零值）
    const nonZero = vector.filter(v => v !== 0);
    expect(nonZero.length).toBeGreaterThan(0);
  }, 15000); // API 调用可能需要几秒

  it('批量文本向量化应返回等长数组', async () => {
    const texts = [
      '张三的修炼境界是金丹期（第50章）',
      '李四在太虚门（第1章）',
      '诛仙剑是上古神器（第5章）',
    ];

    const vectors = await service.embedBatch(texts);

    expect(vectors).toHaveLength(3);
    for (const v of vectors) {
      expect(v.length).toBe(1024);
    }
  }, 15000);

  it('空数组应返回空数组', async () => {
    const vectors = await service.embedBatch([]);
    expect(vectors).toHaveLength(0);
  });

  it('不同内容的向量应不相同', async () => {
    const v1 = await service.embed('张三修炼金丹期');
    const v2 = await service.embed('李四炼制法宝');

    // 两个不同文本的向量不应完全相同
    const allSame = v1.every((val, i) => val === v2[i]);
    expect(allSame).toBe(false);
  }, 15000);
});

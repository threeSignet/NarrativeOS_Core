// =============================================================================
// SiliconFlowEmbeddingService —— 硅基流动 bge-m3 Embedding API 适配器
// =============================================================================
// Phase 4 核心组件。将 Fact 的 embeddingText 通过硅基流动 API 转为 1024 维向量，
// 存入 LanceDB 用于语义检索。
//
// API 文档：https://docs.siliconflow.cn/cn/api-reference/embeddings/create-embeddings
//
// 设计要点：
//   - 单条 embed() 复用 embedBatch()，减少 API 调用次数
//   - API 故障时降级为零向量 + 日志告警，不阻塞主流程
//   - 使用 fetch API（Node 18+ 原生支持）
//
// 与架构文档的对应关系：
//   §7.2.1 EmbeddingService 接口 → embed / embedBatch
//   §7.4 LanceDB 向量存储      → 此服务产出向量供 LanceDB 存储
// =============================================================================

import type { EmbeddingService } from '../../types.js';

/** 从 .env 读取配置（测试环境由 dotenv 加载） */
function getConfig() {
  return {
    apiKey: process.env['EMBEDDING_API_KEY'] ?? '',
    baseUrl: process.env['EMBEDDING_BASE_URL'] ?? 'https://api.siliconflow.cn/v1',
    model: process.env['EMBEDDING_MODEL'] ?? 'BAAI/bge-m3',
    dimensions: parseInt(process.env['EMBEDDING_DIMENSIONS'] ?? '1024', 10),
  };
}

export class SiliconFlowEmbeddingService implements EmbeddingService {
  private config = getConfig();

  /**
   * 单条文本向量化
   *
   * @param text 待向量化的文本（通常为 Fact.embeddingText）
   * @returns 1024 维浮点数数组
   */
  async embed(text: string): Promise<number[]> {
    const results = await this.embedBatch([text]);
    return results[0] ?? [];
  }

  /**
   * 批量文本向量化
   *
   * 每次 API 调用最多支持 batch_size=32（硅基流动限制）。
   * 超过 32 条自动分批。
   *
   * @param texts 待向量化的文本数组
   * @returns 等长的 1024 维向量数组
   */
  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const BATCH_SIZE = 32;
    const allVectors: number[][] = [];

    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const batch = texts.slice(i, i + BATCH_SIZE);
      try {
        const vectors = await this.callApi(batch);
        allVectors.push(...vectors);
      } catch (err) {
        // 降级策略：API 故障时返回零向量，写入日志告警
        // 不阻塞主流程——丢失的向量可在后续 sync_queue 重试时补上
        console.error(`[SiliconFlowEmbedding] API 调用失败（批次 ${i}-${i + batch.length}）: ${String(err)}`);
        for (const _ of batch) {
          allVectors.push(new Array(this.config.dimensions).fill(0));
        }
      }
    }

    return allVectors;
  }

  /**
   * 调用硅基流动 Embedding API
   *
   * POST /v1/embeddings
   * Body: { model, input: string[], encoding_format: "float" }
   */
  private async callApi(texts: string[]): Promise<number[][]> {
    const url = `${this.config.baseUrl}/embeddings`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        model: this.config.model,
        input: texts,
        encoding_format: 'float',
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Embedding API 返回 ${response.status}: ${body.slice(0, 200)}`);
    }

    const data = await response.json() as {
      data: Array<{ index: number; embedding: number[] }>;
    };

    // 按 index 排序保证输出顺序与输入一致
    const sorted = [...data.data].sort((a, b) => a.index - b.index);
    return sorted.map(item => item.embedding);
  }
}

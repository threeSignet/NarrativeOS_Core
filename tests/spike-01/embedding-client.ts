// =============================================================================
// Embedding 客户端 —— 硅基流动 BAAI/bge-m3
// =============================================================================
// 调用 SiliconFlow 的 OpenAI 兼容 Embedding API，1024 维向量输出。
// 使用真实的 API Key（从 .env 加载），无 mock。
// =============================================================================

import 'dotenv/config';

const EMBEDDING_BASE_URL = process.env['EMBEDDING_BASE_URL'] ?? 'https://api.siliconflow.cn/v1';
const EMBEDDING_API_KEY = process.env['EMBEDDING_API_KEY'] ?? '';
const EMBEDDING_MODEL = process.env['EMBEDDING_MODEL'] ?? 'BAAI/bge-m3';
const BATCH_SIZE = 32; // 每批最多 32 条（SiliconFlow 免费 API 限制）

/** 单条文本向量化 */
export async function embed(text: string): Promise<number[]> {
  const response = await fetch(`${EMBEDDING_BASE_URL}/embeddings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${EMBEDDING_API_KEY}`,
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input: text,
      encoding_format: 'float',
    }),
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    throw new Error(`Embedding API 错误 (${response.status}): ${errBody}`);
  }

  const data = await response.json() as {
    data: Array<{ embedding: number[]; index: number }>;
  };
  return data.data[0]!.embedding;
}

/** 批量文本向量化（节省 API 调用） */
export async function embedBatch(texts: string[]): Promise<number[][]> {
  const allEmbeddings: number[][] = [];

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const response = await fetch(`${EMBEDDING_BASE_URL}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${EMBEDDING_API_KEY}`,
      },
      body: JSON.stringify({
        model: EMBEDDING_MODEL,
        input: batch,
        encoding_format: 'float',
      }),
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      throw new Error(`Embedding API 批处理错误 (${response.status}): ${errBody}`);
    }

    const data = await response.json() as {
      data: Array<{ embedding: number[]; index: number }>;
    };
    // 按 index 排序以保证输出顺序与输入一致
    const sorted = data.data.sort((a, b) => a.index - b.index);
    allEmbeddings.push(...sorted.map(d => d.embedding));

    // 进度提示
    const done = Math.min(i + BATCH_SIZE, texts.length);
    console.log(`  Embedding 进度: ${done}/${texts.length}`);
  }

  return allEmbeddings;
}

/**
 * 生成查询向量（与 Fact embedding 使用同一模型，确保语义空间一致）
 */
export async function embedQuery(queryText: string): Promise<number[]> {
  return embed(queryText);
}

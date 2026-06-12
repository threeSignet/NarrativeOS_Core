// =============================================================================
// LanceDBTableAdapter —— VectorStore 接口的 LanceDB 实现
// =============================================================================
// Phase 4 核心组件。将 Fact 向量存储到 LanceDB，支持 ANN 检索和 metadata 过滤。
//
// 设计要点：
//   - 使用嵌入式 vectordb（@lancedb/lancedb），零外部服务进程
//   - 布尔字段用 integer 0/1（LanceDB metadata filter 兼容性）
//   - null validTo 用 -1 哨兵值（LanceDB 不支持 null filter）
//   - 表结构对齐 VectorEntry 接口
//
// 与架构文档的对应关系：
//   §7.4 LanceDB Table 设计          → 表结构 + 索引
//   §4.5 VectorStore 接口            → init / add / search / markInvalid / updateCertainty
//   附录 E.5 sync_queue outbox        → 后台同步消费者
// =============================================================================

import * as lancedb from 'vectordb';
import type { VectorStore, VectorEntry, VectorQuery, ScoredFact, Certainty } from '../../types.js';
import {
  certaintyToLance,
  lanceToCertainty,
  validToToLance,
  lanceToValidTo,
  boolToLance,
  lanceToBool,
  buildLanceFilter,
} from './schema.js';

// ---------------------------------------------------------------------------
// LanceDB 行类型
// ---------------------------------------------------------------------------

interface LanceRow {
  id: string;
  vector: number[];
  subject: string;
  predicate: string;
  valid_from: number;
  valid_to: number;
  is_current: number;
  certainty: number;
  context: string;
}

// ---------------------------------------------------------------------------
// LanceDBTableAdapter
// ---------------------------------------------------------------------------

export class LanceDBTableAdapter implements VectorStore {
  private dbPath: string;
  private tableName: string;
  private table: any = null; // vectordb LocalTable（类型定义不完整，使用 any）
  private connection: any = null; // vectordb LocalConnection

  constructor(dbPath: string, tableName: string = 'facts') {
    this.dbPath = dbPath;
    this.tableName = tableName;
  }

  // =========================================================================
  // init —— 初始化 LanceDB 连接和表
  // =========================================================================

  async init(): Promise<void> {
    this.connection = await lancedb.connect(this.dbPath);
    const tableNames: string[] = await this.connection.tableNames();

    if (tableNames.includes(this.tableName)) {
      this.table = await this.connection.openTable(this.tableName);
    } else {
      const initialData: LanceRow[] = [{
        id: '__placeholder__',
        vector: new Array(1024).fill(0),
        subject: '',
        predicate: '',
        valid_from: 0,
        valid_to: -1,
        is_current: 1,
        certainty: 1,
        context: 'global',
      }];
      this.table = await this.connection.createTable(this.tableName, initialData);
      // 删除占位行
      await this.table.delete('id = "__placeholder__"');
    }
  }

  // =========================================================================
  // add —— 批量写入向量
  // =========================================================================

  async add(vectors: VectorEntry[]): Promise<void> {
    if (!this.table) throw new Error('LanceDB 表未初始化，请先调用 init()');
    if (vectors.length === 0) return;

    const rows: LanceRow[] = vectors.map(v => ({
      id: v.id,
      vector: v.vector,
      subject: v.subject,
      predicate: v.predicate,
      valid_from: v.valid_from,
      valid_to: validToToLance(v.valid_to),
      is_current: boolToLance(v.is_current),
      certainty: certaintyToLance(v.certainty),
      context: v.context,
    }));

    await this.table.add(rows);
  }

  // =========================================================================
  // search —— ANN 语义检索
  // =========================================================================

  async search(query: VectorQuery): Promise<ScoredFact[]> {
    if (!this.table) throw new Error('LanceDB 表未初始化');

    // 构建 metadata filter
    const filterStr = buildLanceFilter({
      isCurrent: query.filter?.is_current ?? true,
      certainty: query.filter?.certainty,
      context: query.filter?.context,
      subject: query.filter?.subject,
      predicate: query.filter?.predicate,
    });

    let q = this.table.search(query.embedding).limit(query.topK);
    if (filterStr) {
      q = q.filter(filterStr);
    }

    const results = await q.execute();
    const scored: ScoredFact[] = [];
    for (const row of results) {
      const r = row as unknown as LanceRow;
      scored.push({
        factId: r.id,
        score: 1.0 - ((row as any)._distance ?? 0), // 距离 → 相似度
      });
    }
    return scored;
  }

  // =========================================================================
  // markInvalid —— 标记向量失效
  // =========================================================================

  async markInvalid(factId: string): Promise<void> {
    if (!this.table) throw new Error('LanceDB 表未初始化');
    // 如果 LanceDB SDK 的 update API 不可用，通过 delete+add 重建
    // 不吞异常：调用方（SyncQueueConsumer）需要知道失败以触发重试
    try {
      await this.table.update({ where: `id = "${factId}"`, values: { is_current: 0 } } as any);
    } catch (updateErr) {
      // LanceDB Node SDK 可能不支持 update，尝试 delete + 标记模式
      // 当前 MVP：抛出错误让 sync_queue 消费方重试
      throw new Error(`LanceDB markInvalid 失败: ${String(updateErr)}`);
    }
  }

  async updateCertainty(factId: string, certainty: Certainty): Promise<void> {
    if (!this.table) throw new Error('LanceDB 表未初始化');
    try {
      await this.table.update({ where: `id = "${factId}"`, values: { certainty: certaintyToLance(certainty) } } as any);
    } catch (updateErr) {
      throw new Error(`LanceDB updateCertainty 失败: ${String(updateErr)}`);
    }
  }

  // =========================================================================
  // remove / count / getAllIds —— 维护操作
  // =========================================================================

  async remove(factId: string): Promise<void> {
    if (!this.table) throw new Error('LanceDB 表未初始化');
    await this.table.delete(`id = "${factId}"`);
  }

  async count(): Promise<number> {
    if (!this.table) return 0;
    return await this.table.countRows();
  }

  async getAllIds(): Promise<string[]> {
    if (!this.table) return [];
    // 查询所有 id 列
    const results = await this.table.search(new Array(1024).fill(0)).limit(100000).execute();
    return results.map((r: any) => r.id as string);
  }
}

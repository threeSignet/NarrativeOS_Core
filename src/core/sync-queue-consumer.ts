// =============================================================================
// SyncQueueConsumer —— LanceDB 同步队列消费者
// =============================================================================
// Phase 4 组件。读取 sync_queue 表中的 outbox 条目，消费后将 Fact 同步到 LanceDB。
//
// 设计要点：
//   - 三种操作类型：insert_vector / mark_invalid / update_certainty
//   - 失败重试：retry_count < max_retries 时重新调度
//   - 非阻塞：后台异步消费，不影响主写入流
//   - commit_event/commit_retcon 的 Phase C 调用此消费者
//
// 与架构文档的对应关系：
//   §4.5 LanceDB 异步同步          → Phase C outbox 模式
//   附录 E.5 sync_queue 表          → DDL 定义
//   §10.1 写入流 Phase C            → 后台向量同步
// =============================================================================

import Database from 'better-sqlite3';
import { LanceDBTableAdapter } from '../adapters/lancedb/table-adapter.js';
import { SiliconFlowEmbeddingService } from '../adapters/embedding/siliconflow-embedder.js';
import type { VectorEntry, Certainty } from '../types.js';

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

interface SyncQueueRow {
  id: number;
  event_id: string;
  operation: 'insert_vector' | 'mark_invalid' | 'update_certainty';
  fact_ids: string;       // JSON 数组
  payload_json: string;   // JSON 对象
  status: 'pending' | 'processing' | 'completed' | 'failed';
  retry_count: number;
  max_retries: number;
  next_retry_at: string;
  last_error: string | null;
}

/** facts 表查询行类型（buildVectorEntries 用） */
interface FactRow {
  id: string;
  subject: string;
  predicate: string;
  value_scalar: string | null;
  value_entity_ref: string | null;
  embedding_text: string;
  certainty: Certainty;
  valid_from: number;
  valid_to: number | null;
  is_current: number;
  context: string;
}

/**
 * processing 孤儿行回收阈值（秒）。
 * consumer 抢占行后若在此时间内未完成（进程崩溃），下次 processPending 会重置为 pending。
 * 5 分钟覆盖单批最长处理时间（embed API 调用 + LanceDB 写）并留余量。
 */
const STALE_PROCESSING_SECONDS = 300;

// ---------------------------------------------------------------------------
// SyncQueueConsumer
// ---------------------------------------------------------------------------

export class SyncQueueConsumer {
  private db: Database.Database;
  private vectorStore: LanceDBTableAdapter;
  private embedder: SiliconFlowEmbeddingService;

  constructor(
    db: Database.Database,
    vectorStore: LanceDBTableAdapter,
    embedder: SiliconFlowEmbeddingService,
  ) {
    this.db = db;
    this.vectorStore = vectorStore;
    this.embedder = embedder;
  }

  // =========================================================================
  // 消费 pending 条目
  // =========================================================================

  /**
   * 消费所有 pending 状态且已到重试时间的 sync_queue 条目
   *
   * @returns 处理结果统计
   */
  async processPending(): Promise<{ processed: number; failed: number }> {
    // 孤儿行回收（reaper）：consumer 崩溃后行会永久停留 'processing'（后续 SELECT 只抓 pending），
    // 导致对应 Fact 向量永久缺失。此处把超过 STALE_PROCESSING_SECONDS 仍 processing 的行重置为 pending。
    // 幂等：重置后会被下方抢占逻辑重新处理（LanceDB add 是 upsert 语义，重复处理不破坏一致性）。
    const reaped = this.db.prepare(`
      UPDATE sync_queue
      SET status = 'pending', next_retry_at = datetime('now')
      WHERE status = 'processing'
        AND next_retry_at < datetime('now', '-${STALE_PROCESSING_SECONDS} seconds')
    `).run().changes;
    if (reaped > 0) {
      console.warn(`[SyncQueue] 回收 ${reaped} 个停滞的 processing 孤儿行（疑似 consumer 崩溃）`);
    }

    // P1 修复：原子抢占 pending → processing，防止并发 consumer 重复处理同一批条目
    // （多 worker 场景下，两个 processPending 可能 SELECT 到相同 pending 行，各自处理一遍，
    // 导致 LanceDB 重复写入向量）。RETURNING 子句需 SQLite 3.35+（better-sqlite3 内置版本满足）。
    const rows = this.db.prepare(`
      UPDATE sync_queue
      SET status = 'processing'
      WHERE id IN (
        SELECT id FROM sync_queue
        WHERE status = 'pending' AND next_retry_at <= datetime('now')
        ORDER BY id ASC LIMIT 100
      )
      RETURNING *
    `).all() as SyncQueueRow[];

    let processed = 0;
    let failed = 0;

    for (const row of rows) {
      try {
        await this.processRow(row);
        this.db.prepare(
          "UPDATE sync_queue SET status = 'completed' WHERE id = ?"
        ).run(row.id);
        processed++;
      } catch (err) {
        const newRetryCount = row.retry_count + 1;
        if (newRetryCount >= row.max_retries) {
          this.db.prepare(`
            UPDATE sync_queue SET status = 'failed', retry_count = ?, last_error = ?
            WHERE id = ?
          `).run(newRetryCount, String(err).slice(0, 500), row.id);
          console.error(`[SyncQueue] 条目 ${row.id} 重试耗尽 (${newRetryCount}/${row.max_retries}): ${String(err).slice(0, 200)}`);
        } else {
          // 指数退避：2^retry × 2秒。失败后 processing → pending（等待退避后重试）
          const delay = Math.pow(2, newRetryCount) * 2;
          this.db.prepare(`
            UPDATE sync_queue SET status = 'pending', retry_count = ?, next_retry_at = datetime('now', '+' || ? || ' seconds'), last_error = ?
            WHERE id = ?
          `).run(newRetryCount, Math.floor(delay), String(err).slice(0, 500), row.id);
        }
        failed++;
      }
    }

    return { processed, failed };
  }

  // =========================================================================
  // 单条处理
  // =========================================================================

  private async processRow(row: SyncQueueRow): Promise<void> {
    const factIds: string[] = JSON.parse(row.fact_ids);

    switch (row.operation) {
      case 'insert_vector': {
        // 从 facts 表读取 Fact，向量化后写入 LanceDB
        const entries = await this.buildVectorEntries(factIds);
        if (entries.length > 0) {
          await this.vectorStore.add(entries);
        }
        break;
      }
      case 'mark_invalid': {
        // 标记向量失效
        for (const fid of factIds) {
          await this.vectorStore.markInvalid(fid);
        }
        break;
      }
      case 'update_certainty': {
        // 更新确定性标记
        const certainty = JSON.parse(row.payload_json)['certainty'] as string;
        for (const fid of factIds) {
          await this.vectorStore.updateCertainty(fid, certainty as any);
        }
        break;
      }
    }
  }

  /**
   * 从 SQLite facts 表读取 Fact，调用 Embedding API 构建 VectorEntry
   */
  private async buildVectorEntries(factIds: string[]): Promise<VectorEntry[]> {
    // P1 修复：原实现分两轮循环各查一次 facts（2N 次 SELECT），且第二轮用 factIds[i] 索引——
    // 当某 factId 不存在时 texts.length < factIds.length，导致索引错位查到错误的 Fact。
    // 改为单轮查询并缓存 row，同时消除索引错位 bug。
    const rows: FactRow[] = [];
    const texts: string[] = [];

    // 读取 Fact 并构建 embedding 文本（单轮查询，缓存 row 供后续组装）
    for (const fid of factIds) {
      const row = this.db.prepare(
        'SELECT id, subject, predicate, value_scalar, value_entity_ref, embedding_text, certainty, valid_from, valid_to, is_current, context FROM facts WHERE id = ?'
      ).get(fid) as FactRow | undefined;
      if (!row) continue;

      const text = row.embedding_text || `${row.subject} ${row.predicate} ${row.value_scalar ?? row.value_entity_ref ?? ''}`;
      rows.push(row);
      texts.push(text);
    }

    if (texts.length === 0) return [];

    // 批量向量化
    const vectors = await this.embedder.embedBatch(texts);

    // 组装 VectorEntry（复用已缓存的 row，无需二次查询）
    const entries: VectorEntry[] = [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      entries.push({
        id: row.id,
        vector: vectors[i] ?? new Array(1024).fill(0),
        subject: row.subject,
        predicate: row.predicate,
        valid_from: row.valid_from,
        valid_to: row.valid_to,
        is_current: row.is_current === 1,
        certainty: row.certainty,
        context: row.context ?? 'global',
      });
    }

    return entries;
  }

  // =========================================================================
  // 便捷方法：插入并立即消费（测试用）
  // =========================================================================

  /**
   * 插入一条 sync_queue 条目（由 commit_event/commit_retcon 的 Phase B 调用）
   */
  insertEntry(eventId: string, operation: SyncQueueRow['operation'], factIds: string[], payload: Record<string, unknown> = {}): void {
    this.db.prepare(`
      INSERT INTO sync_queue (event_id, operation, fact_ids, payload_json, next_retry_at)
      VALUES (?, ?, ?, ?, datetime('now', '+2 seconds'))
    `).run(eventId, operation, JSON.stringify(factIds), JSON.stringify(payload));
  }

  /** 查询 pending 条目数量 */
  getPendingCount(): number {
    const row = this.db.prepare(
      "SELECT COUNT(*) as cnt FROM sync_queue WHERE status = 'pending'"
    ).get() as { cnt: number };
    return row.cnt;
  }
}

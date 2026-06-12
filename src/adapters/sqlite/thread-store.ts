// =============================================================================
// SQLiteThreadStoreAdapter —— ThreadStore 接口的 SQLite 实现
// =============================================================================
// Phase 2A 最小版本：create / getById / updateStatus / addMilestone / getOpen / getByFilters。
// 与 FactStore 共享同一个 SQLite 连接（同库不同表），threads 表 DDL 已在 FactStore 初始化时创建。
//
// 设计要点：
//   - ID 生成：thr_{tag}_{chapter}[_{seq}]，优先使用 tags[0]，否则使用 type
//   - cst_ 兼容：getById / updateStatus / addMilestone 支持旧 cst_ 前缀自动映射为 thr_
//   - JSON 序列化：closeCondition / relatedEntities / upstreamFactIds / milestones / tags 为 JSON 字段
//   - JSON 数组过滤：relatedEntity 反序列化后精确匹配，避免 SQL LIKE 通配符误判
//   - I-9 不变式：ThreadStore 只读写 threads 表，不触碰 facts / knowledge / events 等表
//   - 反序列化安全：JSON 解析失败时抛出可读错误，不静默返回错误对象
//
// 与架构文档的对应关系：
//   §6 NarrativeThread 统一追踪 → 回溯型 + 渐进型叙事承诺
//   §6.1 生命周期状态机       → ThreadStatus 枚举
//   §6.2 ThreadMilestone      → 里程碑追加 + 状态联动
//   附录 E.4 threads 表       → DDL 已在 FactStore 适配器中创建
// =============================================================================

import type Database from 'better-sqlite3';
import type {
  NarrativeThread,
  ThreadStatus,
  ThreadMilestone,
  ThreadFilter,
} from '../../types.js';

// ---------------------------------------------------------------------------
// SQLite 行类型（数据库返回的原始格式）
// ---------------------------------------------------------------------------

interface ThreadRow {
  id: string;
  type: string;
  direction: string;
  severity: string;
  description: string;
  close_condition: string;
  status: string;
  closed_by: string | null;
  created_at_event: string;
  created_at_chapter: number;
  related_entities: string;
  upstream_fact_ids: string;
  milestones: string;
  hint_count: number;
  tags: string | null;
  arc_tag: string | null;
}

// 开放状态集合——getOpen() 只返回这些状态
const OPEN_STATUSES: ThreadStatus[] = ['UNFILLED', 'PLANTED', 'HINTED', 'PARTIALLY_REVEALED'];

// ---------------------------------------------------------------------------
// SQLiteThreadStoreAdapter
// ---------------------------------------------------------------------------

export class SQLiteThreadStoreAdapter {
  private db: Database.Database;

  /**
   * @param db 共享的 better-sqlite3 Database 实例（与 FactStore 同库）
   *           DDL 已由 SQLiteFactStoreAdapter 在初始化时创建
   */
  constructor(db: Database.Database) {
    this.db = db;
  }

  // -----------------------------------------------------------------------
  // 写入操作
  // -----------------------------------------------------------------------

  /**
   * 创建 NarrativeThread
   *
   * 自动生成 thr_ 前缀 ID，格式：thr_{tag}_{chapter}[_{seq}]
   * 优先使用 thread.tags[0]，否则使用 thread.type 作为 ID 片段。
   * 同一 base ID 已存在时追加递增序号，保证不碰撞。
   */
  create(thread: Omit<NarrativeThread, 'id'>): NarrativeThread {
    const id = this.generateId(thread);

    this.db.prepare(`
      INSERT INTO threads (id, type, direction, severity, description, close_condition, status, closed_by,
                           created_at_event, created_at_chapter, related_entities, upstream_fact_ids,
                           milestones, hint_count, tags, arc_tag)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      thread.type,
      thread.direction,
      thread.severity,
      thread.description,
      JSON.stringify(thread.closeCondition),
      thread.status,
      thread.closedBy ?? null,
      thread.createdAtEvent,
      thread.createdAtChapter,
      JSON.stringify(thread.relatedEntities),
      JSON.stringify(thread.upstreamFactIds),
      JSON.stringify(thread.milestones),
      0,
      thread.tags ? JSON.stringify(thread.tags) : null,
      thread.arcTag ?? null,
    );

    return this.rowToThread(
      this.db.prepare('SELECT * FROM threads WHERE id = ?').get(id) as ThreadRow,
    );
  }

  /**
   * 更新 Thread 状态
   *
   * 支持 cst_ → thr_ 查询兼容。仅当传入 closedBy 时更新 closed_by，
   * 未传入时保留已有 closed_by 值。
   */
  updateStatus(threadId: string, status: ThreadStatus, closedBy?: string): void {
    const resolvedId = this.resolveThreadId(threadId);
    if (!resolvedId) {
      throw new Error(`THREAD_NOT_FOUND: ${threadId}`);
    }

    if (closedBy !== undefined) {
      this.db.prepare(`
        UPDATE threads SET status = ?, closed_by = ? WHERE id = ?
      `).run(status, closedBy, resolvedId);
    } else {
      this.db.prepare(`
        UPDATE threads SET status = ? WHERE id = ?
      `).run(status, resolvedId);
    }
  }

  /**
   * 追加里程碑
   *
   * 生成里程碑 ID，追加到 milestones JSON 数组，同步更新 Thread 的 status。
   * 当 milestone status 为 HINTED 时递增 hint_count。
   * 当 milestone status 为 FILLED/RESOLVED 且带 eventId 时设置 closed_by。
   */
  addMilestone(threadId: string, milestone: Omit<ThreadMilestone, 'id'>): void {
    const resolvedId = this.resolveThreadId(threadId);
    if (!resolvedId) {
      throw new Error(`THREAD_NOT_FOUND: ${threadId}`);
    }

    const row = this.db.prepare('SELECT * FROM threads WHERE id = ?').get(resolvedId) as ThreadRow;
    if (!row) {
      throw new Error(`THREAD_NOT_FOUND: ${resolvedId}`);
    }

    // 安全反序列化已有 milestones
    const existingMilestones = this.parseJsonField<ThreadMilestone[]>(row.milestones, 'milestones', resolvedId);

    // 生成里程碑 ID
    const milestoneId = `ms_${resolvedId.replace('thr_', '')}_${String(existingMilestones.length + 1).padStart(2, '0')}`;

    const newMilestone: ThreadMilestone = {
      id: milestoneId,
      ...milestone,
    };

    const updatedMilestones = [...existingMilestones, newMilestone];

    // 计算 hint_count 递增
    let hintCount = row.hint_count;
    if (milestone.status === 'HINTED') {
      hintCount += 1;
    }

    // 计算 closed_by：当终态里程碑带 eventId 时记录关闭事件
    let closedBy: string | null = row.closed_by;
    if ((milestone.status === 'FILLED' || milestone.status === 'RESOLVED') && milestone.eventId) {
      closedBy = milestone.eventId;
    }

    this.db.prepare(`
      UPDATE threads SET status = ?, milestones = ?, hint_count = ?, closed_by = ? WHERE id = ?
    `).run(
      milestone.status,
      JSON.stringify(updatedMilestones),
      hintCount,
      closedBy,
      resolvedId,
    );
  }

  // -----------------------------------------------------------------------
  // 查询操作
  // -----------------------------------------------------------------------

  /**
   * 按 ID 获取 Thread，支持 cst_ → thr_ 前缀兼容
   */
  getById(threadId: string): NarrativeThread | undefined {
    const resolvedId = this.resolveThreadId(threadId);
    if (!resolvedId) return undefined;

    const row = this.db.prepare('SELECT * FROM threads WHERE id = ?').get(resolvedId) as ThreadRow | undefined;
    return row ? this.rowToThread(row) : undefined;
  }

  /**
   * 获取所有开放状态的 Thread
   *
   * 只返回 UNFILLED / PLANTED / HINTED / PARTIALLY_REVEALED，
   * 排除所有终态（FILLED / RESOLVED / ABANDONED / OBSOLETE）。
   */
  getOpen(): NarrativeThread[] {
    const placeholders = OPEN_STATUSES.map(() => '?').join(',');
    const rows = this.db.prepare(
      `SELECT * FROM threads WHERE status IN (${placeholders}) ORDER BY created_at_chapter ASC, id ASC`,
    ).all(...OPEN_STATUSES) as ThreadRow[];
    return rows.map(r => this.rowToThread(r));
  }

  /**
   * 多条件过滤查询
   *
   * 支持 direction / type / severity / status / nearChapter+window /
   * closedByEvent / relatedEntity / arcTag / excludeArcTags。
   */
  getByFilters(filters: ThreadFilter): NarrativeThread[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    // SQL 字段过滤
    if (filters.direction) {
      conditions.push('direction = ?');
      params.push(filters.direction);
    }

    if (filters.type && filters.type.length > 0) {
      conditions.push(`type IN (${filters.type.map(() => '?').join(',')})`);
      params.push(...filters.type);
    }

    if (filters.severity && filters.severity.length > 0) {
      conditions.push(`severity IN (${filters.severity.map(() => '?').join(',')})`);
      params.push(...filters.severity);
    }

    if (filters.status && filters.status.length > 0) {
      conditions.push(`status IN (${filters.status.map(() => '?').join(',')})`);
      params.push(...filters.status);
    }

    // 章节窗口过滤
    if (filters.nearChapter !== undefined && filters.window !== undefined) {
      conditions.push('created_at_chapter >= ? AND created_at_chapter <= ?');
      params.push(filters.nearChapter - filters.window, filters.nearChapter + filters.window);
    }

    // 关闭事件过滤
    if (filters.closedByEvent) {
      conditions.push('closed_by = ?');
      params.push(filters.closedByEvent);
    }

    // arcTag 精确匹配
    if (filters.arcTag) {
      conditions.push('arc_tag = ?');
      params.push(filters.arcTag);
    }

    // excludeArcTags 排除
    if (filters.excludeArcTags && filters.excludeArcTags.length > 0) {
      conditions.push(`(arc_tag IS NULL OR arc_tag NOT IN (${filters.excludeArcTags.map(() => '?').join(',')}))`);
      params.push(...filters.excludeArcTags);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = this.db.prepare(
      `SELECT * FROM threads ${whereClause} ORDER BY created_at_chapter ASC, id ASC`,
    ).all(...params) as ThreadRow[];

    let threads = rows.map(r => this.rowToThread(r));

    if (filters.relatedEntity) {
      threads = threads.filter(thread => thread.relatedEntities.includes(filters.relatedEntity!));
    }

    return threads;
  }

  // -----------------------------------------------------------------------
  // 辅助方法
  // -----------------------------------------------------------------------

  /**
   * 生成 Thread ID：thr_{tag}_{chapter}[_{seq}]
   *
   * 优先使用 tags[0]，否则使用 type。
   * 对片段做稳定清洗：去除特殊字符，转小写。
   * 同一 base ID 已存在时追加递增序号。
   */
  private generateId(thread: Omit<NarrativeThread, 'id'>): string {
    // 选择 ID 片段：优先 tags[0]，否则 type
    const rawSlug = (thread.tags && thread.tags.length > 0) ? thread.tags[0]! : thread.type;
    const slug = rawSlug.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase();
    const baseId = `thr_${slug}_${thread.createdAtChapter}`;

    // 检查基础 ID 是否已占用
    const existing = this.db.prepare('SELECT COUNT(*) as cnt FROM threads WHERE id = ?').get(baseId) as { cnt: number };
    if (existing.cnt === 0) {
      return baseId;
    }

    // 基础 ID 已占用，追加序号
    let seq = 2;
    while (true) {
      const seqId = `${baseId}_${String(seq).padStart(2, '0')}`;
      const check = this.db.prepare('SELECT COUNT(*) as cnt FROM threads WHERE id = ?').get(seqId) as { cnt: number };
      if (check.cnt === 0) return seqId;
      seq++;
    }
  }

  /**
   * 解析 threadId，支持 cst_ → thr_ 前缀兼容
   *
   * 先尝试原始 ID，若不存在且为 cst_ 前缀则自动映射为 thr_ 再查。
   * 返回实际存在的 ID，或 null 表示都找不到。
   */
  private resolveThreadId(threadId: string): string | null {
    // 先试原始 ID
    const direct = this.db.prepare('SELECT id FROM threads WHERE id = ?').get(threadId) as { id: string } | undefined;
    if (direct) return direct.id;

    // cst_ 前缀兼容：映射为 thr_ 再查
    if (threadId.startsWith('cst_')) {
      const mappedId = 'thr_' + threadId.slice(4);
      const mapped = this.db.prepare('SELECT id FROM threads WHERE id = ?').get(mappedId) as { id: string } | undefined;
      if (mapped) return mapped.id;
    }

    return null;
  }

  /**
   * 安全解析 JSON 字段，解析失败时抛出包含字段名和 thread id 的可读错误
   */
  private parseJsonField<T>(jsonStr: string, fieldName: string, threadId: string): T {
    try {
      return JSON.parse(jsonStr) as T;
    } catch (err) {
      throw new Error(`JSON_PARSE_ERROR: 字段 "${fieldName}" 反序列化失败 (thread=${threadId}): ${(err as Error).message}`);
    }
  }

  /**
   * 将 SQLite 行转换为 NarrativeThread 对象
   */
  private rowToThread(row: ThreadRow): NarrativeThread {
    return {
      id: row.id,
      type: row.type as NarrativeThread['type'],
      direction: row.direction as NarrativeThread['direction'],
      severity: row.severity as NarrativeThread['severity'],
      description: row.description,
      closeCondition: this.parseJsonField(row.close_condition, 'close_condition', row.id),
      status: row.status as ThreadStatus,
      closedBy: row.closed_by,
      createdAtEvent: row.created_at_event,
      createdAtChapter: row.created_at_chapter,
      milestones: this.parseJsonField<ThreadMilestone[]>(row.milestones, 'milestones', row.id),
      relatedEntities: this.parseJsonField<string[]>(row.related_entities, 'related_entities', row.id),
      upstreamFactIds: this.parseJsonField<string[]>(row.upstream_fact_ids, 'upstream_fact_ids', row.id),
      tags: row.tags ? this.parseJsonField<string[]>(row.tags, 'tags', row.id) : undefined,
      arcTag: row.arc_tag ?? undefined,
    };
  }
}

// =============================================================================
// SQLiteKnowledgeStoreAdapter —— KnowledgeStore 接口的 SQLite 实现
// =============================================================================
// Phase 1 最小版本：表结构 + create / batchCreate / getLatest / getByFactId。
// seal/restore/decay/soul_read/implant 的写入编排由 ProposalManager 在 Phase B 完成。
//
// 设计原则：
//   - Event Sourcing 不可变：永远不 DELETE / UPDATE knowledge 表记录，只 INSERT 新记录
//   - "取最新"查询：ORDER BY known_since DESC, rowid DESC LIMIT 1
//   - rowid tiebreaker：同章节内显式操作（seal/implant）晚于自动推导（propagation）
//   - 与 FactStore 共享同一个 SQLite 连接（同库不同表）
//
// 与架构文档的对应关系：
//   §3.6  Knowledge 双流写入     → 与 Fact 流并行的认知事件流
//   §4.3.4 KnowledgeStore 接口    → 完整接口定义
//   §10.1 写入流                  → Phase B 事务内原子写入
//   附录 E.7 knowledge 表         → DDL 已在 FactStore 适配器中创建
// =============================================================================

import type Database from 'better-sqlite3';
import type { Knowledge, KnowledgeFilter, KnowledgeSource } from '../../types.js';

// ---------------------------------------------------------------------------
// SQLite 行类型
// ---------------------------------------------------------------------------

interface KnowledgeRow {
  id: string;
  fact_id: string;
  entity_id: string;
  known_since: number;
  source: string;
  confidence: number;
  previous_confidence: number | null;
  updated_at_event: string | null;
}

// ---------------------------------------------------------------------------
// SQLiteKnowledgeStoreAdapter
// ---------------------------------------------------------------------------

export class SQLiteKnowledgeStoreAdapter {
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
   * 创建单条 Knowledge 记录
   *
   * 自动生成 ID：kno_{knower}_{factSeq}
   * knower 为 entityId 去掉 ent_ 前缀的部分
   * factSeq 为 factId 去掉 fct_ 前缀的部分
   */
  create(knowledge: Omit<Knowledge, 'id'>): Knowledge {
    const id = this.generateId(knowledge.entityId, knowledge.factId);

    this.db.prepare(`
      INSERT INTO knowledge (id, fact_id, entity_id, known_since, source, confidence, previous_confidence, updated_at_event)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      knowledge.factId,
      knowledge.entityId,
      knowledge.knownSince,
      knowledge.source,
      knowledge.confidence,
      knowledge.previousConfidence ?? null,
      knowledge.updatedAtEvent ?? null,
    );

    return this.rowToKnowledge(
      this.db.prepare('SELECT * FROM knowledge WHERE id = ?').get(id) as KnowledgeRow
    );
  }

  /**
   * 批量创建 Knowledge 记录（commit_event 时一次性写入多条）
   *
   * 所有记录在同一事务中写入，保证原子性。
   */
  batchCreate(entries: Omit<Knowledge, 'id'>[]): Knowledge[] {
    const stmt = this.db.prepare(`
      INSERT INTO knowledge (id, fact_id, entity_id, known_since, source, confidence, previous_confidence, updated_at_event)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const results: Knowledge[] = [];
    for (const entry of entries) {
      const id = this.generateId(entry.entityId, entry.factId);
      stmt.run(
        id,
        entry.factId,
        entry.entityId,
        entry.knownSince,
        entry.source,
        entry.confidence,
        entry.previousConfidence ?? null,
        entry.updatedAtEvent ?? null,
      );
      // 回读已写入的记录（同一事务内可见）
      const row = this.db.prepare('SELECT * FROM knowledge WHERE id = ?').get(id) as KnowledgeRow;
      results.push(this.rowToKnowledge(row));
    }

    return results;
  }

  // -----------------------------------------------------------------------
  // 查询操作
  // -----------------------------------------------------------------------

  /**
   * 查询某实体在指定章节知道的所有 Fact（取最新一条 Knowledge 记录的 confidence > 0）
   *
   * "取最新"使用关联子查询：对每个 (entity_id, fact_id) 组合，
   * 先按 known_since DESC, rowid DESC 排序取第一条，确保 latest 确实是同一条记录。
   * 之前的 MAX(known_since)+MAX(rowid) 方案存在隐患——两个 MAX 独立计算，
   * 可能选出不存在于同一行的组合（known_since 最大行 ≠ rowid 最大行）。
   */
  getKnownFacts(entityId: string, atChapter?: number): Knowledge[] {
    const chapterFilter = atChapter !== undefined ? 'AND k2.known_since <= ?' : '';
    const sql = `
      SELECT k.* FROM knowledge k
      WHERE k.rowid = (
        SELECT k2.rowid FROM knowledge k2
        WHERE k2.entity_id = k.entity_id AND k2.fact_id = k.fact_id ${chapterFilter}
        ORDER BY k2.known_since DESC, k2.rowid DESC
        LIMIT 1
      )
      AND k.entity_id = ? AND k.confidence > 0
    `;

    const params: unknown[] = [];
    if (atChapter !== undefined) params.push(atChapter);
    params.push(entityId);

    const rows = this.db.prepare(sql).all(...params) as KnowledgeRow[];
    return rows.map(r => this.rowToKnowledge(r));
  }

  /**
   * 查询某实体知道的所有活跃 Fact（过滤掉指向 contested/orphaned Fact 的 Knowledge）
   *
   * 用于检索管线 Step 5 的知识感知过滤。
   * JOIN facts 表确保只返回指向 canonical/potential Fact 的 Knowledge。
   * 使用关联子查询取最新记录，避免 MAX+MAX 自连接隐患（同 getKnownFacts）。
   */
  getActiveKnowledge(entityId: string, atChapter?: number): Knowledge[] {
    const chapterFilter = atChapter !== undefined ? 'AND k2.known_since <= ?' : '';
    const sql = `
      SELECT k.* FROM knowledge k
      INNER JOIN facts f ON k.fact_id = f.id
      WHERE k.rowid = (
        SELECT k2.rowid FROM knowledge k2
        WHERE k2.entity_id = k.entity_id AND k2.fact_id = k.fact_id ${chapterFilter}
        ORDER BY k2.known_since DESC, k2.rowid DESC
        LIMIT 1
      )
      AND k.entity_id = ? AND k.confidence > 0 AND f.certainty IN ('canonical', 'potential')
    `;

    const params: unknown[] = [];
    if (atChapter !== undefined) params.push(atChapter);
    params.push(entityId);

    const rows = this.db.prepare(sql).all(...params) as KnowledgeRow[];
    return rows.map(r => this.rowToKnowledge(r));
  }

  /**
   * 查询某条 Fact 被哪些实体知晓（取最新一条认知记录，confidence > 0）
   * 使用关联子查询取最新记录，避免 MAX+MAX 自连接隐患（同 getKnownFacts）。
   */
  getKnowersOfFact(factId: string): Knowledge[] {
    const sql = `
      SELECT k.* FROM knowledge k
      WHERE k.rowid = (
        SELECT k2.rowid FROM knowledge k2
        WHERE k2.entity_id = k.entity_id AND k2.fact_id = k.fact_id
        ORDER BY k2.known_since DESC, k2.rowid DESC
        LIMIT 1
      )
      AND k.fact_id = ? AND k.confidence > 0
    `;
    const rows = this.db.prepare(sql).all(factId) as KnowledgeRow[];
    return rows.map(r => this.rowToKnowledge(r));
  }

  /**
   * 查询某 Fact 的全部认知记录（Retcon 级联扫描使用，含历史记录）
   *
   * 与 getKnowersOfFact 的区别：不过滤 confidence > 0，返回全部历史记录。
   */
  getByFactId(factId: string): Knowledge[] {
    const rows = this.db.prepare(
      'SELECT * FROM knowledge WHERE fact_id = ? ORDER BY known_since DESC, rowid DESC'
    ).all(factId) as KnowledgeRow[];
    return rows.map(r => this.rowToKnowledge(r));
  }

  /**
   * 更新确信度（作者订正时使用）
   *
   * ⚠ 不直接 UPDATE！遵循 Event Sourcing 原则：INSERT 新记录。
   * 通过 generateId 自动获取下一个可用序号。
   */
  updateConfidence(knowledgeId: string, confidence: number, updatedByEvent?: string): void {
    const existing = this.db.prepare('SELECT * FROM knowledge WHERE id = ?').get(knowledgeId) as KnowledgeRow | undefined;
    if (!existing) throw new Error(`KNOWLEDGE_NOT_FOUND: ${knowledgeId}`);

    // INSERT 新记录（confidence 变更，其他字段继承）
    // 委托 create 以复用 generateId 的消歧逻辑
    this.create({
      factId: existing.fact_id,
      entityId: existing.entity_id,
      knownSince: existing.known_since,
      source: existing.source as KnowledgeSource,
      confidence,
      previousConfidence: existing.confidence,
      updatedAtEvent: updatedByEvent ?? undefined,
    });
  }

  /**
   * 通用多条件查询
   */
  query(filter: KnowledgeFilter): Knowledge[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filter.entityId) {
      conditions.push('entity_id = ?');
      params.push(filter.entityId);
    }
    if (filter.factId) {
      conditions.push('fact_id = ?');
      params.push(filter.factId);
    }
    if (filter.source && filter.source.length > 0) {
      conditions.push(`source IN (${filter.source.map(() => '?').join(',')})`);
      params.push(...filter.source);
    }
    if (filter.minConfidence !== undefined) {
      conditions.push('confidence >= ?');
      params.push(filter.minConfidence);
    }
    if (filter.atChapter !== undefined) {
      conditions.push('known_since <= ?');
      params.push(filter.atChapter);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = this.db.prepare(
      `SELECT * FROM knowledge ${whereClause} ORDER BY known_since DESC, rowid DESC`
    ).all(...params) as KnowledgeRow[];

    return rows.map(r => this.rowToKnowledge(r));
  }

  // -----------------------------------------------------------------------
  // 辅助方法
  // -----------------------------------------------------------------------

  /**
   * 生成 Knowledge ID：kno_{knower}_{factRef}[_{seq}]
   *
   * knower 为 entityId 去掉 ent_ 前缀的部分
   * factRef 为 factId 去掉 fct_ 前缀的部分
   *
   * 示例：
   *   首次：kno_claine_tribulation_50_01
   *   再次（seal/restore 等）：kno_claine_tribulation_50_01_02
   *
   * 消歧策略：同一 (entityId, factId) 组合首次写入直接用基础 ID；
   * 如果基础 ID 已存在（同章节内 seal/restore/decay 重复操作），
   * 追加两位数字序号（_02, _03...）。
   */
  private generateId(entityId: string, factId: string): string {
    const knower = entityId.replace('ent_', '');
    const factRef = factId.replace('fct_', '');
    const baseId = `kno_${knower}_${factRef}`;

    // 检查基础 ID 是否已占用
    const existing = this.db.prepare('SELECT COUNT(*) as cnt FROM knowledge WHERE id = ?').get(baseId) as { cnt: number };
    if (existing.cnt === 0) {
      return baseId;
    }

    // 基础 ID 已占用，追加序号
    let seq = 2;
    while (true) {
      const seqId = `${baseId}_${String(seq).padStart(2, '0')}`;
      const check = this.db.prepare('SELECT COUNT(*) as cnt FROM knowledge WHERE id = ?').get(seqId) as { cnt: number };
      if (check.cnt === 0) return seqId;
      seq++;
    }
  }

  /**
   * 将 SQLite 行转换为 Knowledge 对象
   */
  private rowToKnowledge(row: KnowledgeRow): Knowledge {
    return {
      id: row.id,
      factId: row.fact_id,
      entityId: row.entity_id,
      knownSince: row.known_since,
      source: row.source as KnowledgeSource,
      confidence: row.confidence,
      previousConfidence: row.previous_confidence ?? undefined,
      updatedAtEvent: row.updated_at_event ?? undefined,
    };
  }
}

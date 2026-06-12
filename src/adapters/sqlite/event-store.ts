// =============================================================================
// SQLiteEventStoreAdapter —— EventStore 接口的 SQLite 实现
// =============================================================================
// 事件持久化存储，支持 Retcon BFS 级联遍历和事件溯源。
// 与 FactStore 共享同一个 SQLite 连接（同库不同表）。
// =============================================================================

import type Database from 'better-sqlite3';
import type { NarrativeEvent, EventKindFilter } from '../../types.js';

interface EventRow {
  id: string;
  kind: string;
  type: string;
  chapter: number;
  description: string;
  params_json: string;
  context: string;
  timestamp: string;
  status: string;
  fact_group_id: string;
  resolved_threads: string;
  dependencies_json: string;
}

export class SQLiteEventStoreAdapter {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  create(event: Omit<NarrativeEvent, 'id'>): NarrativeEvent {
    // 生成事件 ID
    const seq = (this.db.prepare('SELECT COUNT(*) as cnt FROM events').get() as { cnt: number }).cnt + 1;
    const id = `evt_${event.type}_${event.chapter}_${String(seq).padStart(2, '0')}`;

    this.db.prepare(`
      INSERT INTO events (id, kind, type, chapter, description, params_json, context, fact_group_id, resolved_threads, dependencies_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      event.kind ?? 'business',
      event.type,
      event.chapter,
      event.description,
      JSON.stringify(event.params ?? {}),
      event.context ?? 'global',
      id, // fact_group_id = event id (1:1)
      JSON.stringify(event.resolvedThreads ?? []),
      JSON.stringify(event.dependentFactIds ?? []),
    );

    return this.rowToEvent(
      this.db.prepare('SELECT * FROM events WHERE id = ?').get(id) as EventRow
    );
  }

  getById(eventId: string): NarrativeEvent | undefined {
    const row = this.db.prepare('SELECT * FROM events WHERE id = ?').get(eventId) as EventRow | undefined;
    return row ? this.rowToEvent(row) : undefined;
  }

  getByChapterRange(fromChapter: number, toChapter?: number, kind: EventKindFilter = 'business'): NarrativeEvent[] {
    let sql = 'SELECT * FROM events WHERE chapter >= ?';
    const params: unknown[] = [fromChapter];
    if (toChapter !== undefined) { sql += ' AND chapter <= ?'; params.push(toChapter); }
    if (kind !== 'all') { sql += ' AND kind = ?'; params.push(kind); }
    sql += ' ORDER BY chapter ASC';
    const rows = this.db.prepare(sql).all(...params) as EventRow[];
    return rows.map(r => this.rowToEvent(r));
  }

  getBySubject(entityId: string, fromChapter?: number, kind: EventKindFilter = 'business'): NarrativeEvent[] {
    let sql = "SELECT * FROM events WHERE json_extract(params_json, '$.subject') = ?";
    const params: unknown[] = [entityId];
    if (fromChapter !== undefined) { sql += ' AND chapter >= ?'; params.push(fromChapter); }
    if (kind !== 'all') { sql += ' AND kind = ?'; params.push(kind); }
    sql += ' ORDER BY chapter ASC';
    const rows = this.db.prepare(sql).all(...params) as EventRow[];
    return rows.map(r => this.rowToEvent(r));
  }

  getByType(eventType: string, fromChapter?: number, kind: EventKindFilter = 'business'): NarrativeEvent[] {
    let sql = 'SELECT * FROM events WHERE type = ?';
    const params: unknown[] = [eventType];
    if (fromChapter !== undefined) { sql += ' AND chapter >= ?'; params.push(fromChapter); }
    if (kind !== 'all') { sql += ' AND kind = ?'; params.push(kind); }
    sql += ' ORDER BY chapter ASC';
    const rows = this.db.prepare(sql).all(...params) as EventRow[];
    return rows.map(r => this.rowToEvent(r));
  }

  getByDependentFactIds(factIds: string[], kind: EventKindFilter = 'business'): NarrativeEvent[] {
    const placeholders = factIds.map(() => '?').join(',');
    let sql = `SELECT DISTINCT e.* FROM events e
      INNER JOIN event_dependencies ed ON e.id = ed.event_id
      WHERE ed.fact_id IN (${placeholders})`;
    const params: unknown[] = [...factIds];
    if (kind !== 'all') { sql += ' AND e.kind = ?'; params.push(kind); }
    sql += ' ORDER BY e.chapter ASC';
    const rows = this.db.prepare(sql).all(...params) as EventRow[];
    return rows.map(r => this.rowToEvent(r));
  }

  private rowToEvent(row: EventRow): NarrativeEvent {
    return {
      id: row.id,
      kind: row.kind as NarrativeEvent['kind'],
      type: row.type,
      chapter: row.chapter,
      description: row.description,
      context: row.context,
      params: JSON.parse(row.params_json),
      timestamp: row.timestamp,
      factGroupId: row.fact_group_id,
      resolvedThreads: JSON.parse(row.resolved_threads),
      dependentFactIds: JSON.parse(row.dependencies_json),
    };
  }
}

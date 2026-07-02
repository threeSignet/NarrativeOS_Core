// =============================================================================
// SQLiteFactStoreAdapter —— FactStore 接口的 SQLite 实现
// =============================================================================
// Phase 1 核心产出。使用 better-sqlite3 的同步 API 实现所有 FactStore 接口方法。
//
// 设计要点：
//   - WAL 模式：初始化时显式启用，保证读写并发性能
//   - 外键约束：启用 FOREIGN KEY，保证引用完整性
//   - 原子事务：applyFactGroup 使用 SAVEPOINT 实现组内局部回滚
//   - 序列化隔离：read → deserialize → write → serialize，保证类型安全
//   - ID 生成：assert 方法自动生成 Fact ID（fct_{完整事件标识}_{seq}，事件标识取自 causeEvent 去前缀）
//   - embeddingText 生成：由上游 FactEmbedder 负责，本层只存储
//
// 与架构文档的对应关系：
//   §4.1 设计定位     → 时序三元组存储，非图数据库
//   §4.2 四级索引     → subject→predicate / causeEvent→Fact / factId→Fact / targetEntity→Fact
//   §4.4 原子回滚     → SAVEPOINT 实现 FactGroup 原子性
//   §10.1 双流写入    → Phase B 事务内写入 Fact + 同库不同表的 Knowledge/Event
//   附录 E.1-E.8      → 完整建表 SQL
// =============================================================================

import Database from 'better-sqlite3';
import type {
  Fact,
  FactValue,
  FactChange,
  FactGroup,
  FactQuery,
  FactIndexEntry,
  EntityRef,
  FactStore,
} from '../../types.js';
import { serializeFactValue, deserializeFactValue } from '../../types.js';
import type { FactScalarType, Certainty } from '../../types.js';

// ---------------------------------------------------------------------------
// SQLite 行类型（数据库返回的原始格式）
// ---------------------------------------------------------------------------

interface FactRow {
  id: string;
  subject: string;
  predicate: string;
  value_type: 'scalar' | 'entity_ref';
  value_scalar_type: FactScalarType | null;
  value_scalar: string | null;
  value_entity_ref: string | null;
  certainty: string;
  cause_event: string;
  valid_from: number;
  valid_to: number | null;
  is_current: number;       // VIRTUAL 生成列: 0/1
  context: string;
  relation_kind: string | null;
  embedding_text: string;
  schema_version: number;
}

// ---------------------------------------------------------------------------
// 建表 SQL（全部 8 张核心表，对应附录 E.1-E.8）
// ---------------------------------------------------------------------------

const DDL = `
-- E.1 实体注册表（附录 E.1）
CREATE TABLE IF NOT EXISTS entities (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  kind             TEXT NOT NULL,
  description      TEXT,
  first_appearance REAL NOT NULL,                -- 首次出场章节（支持小数编号）
  registered_at_event TEXT,                       -- 注册事件 ID（Phase 2 外键约束）
  tags_json        TEXT,                          -- P1-7: 实体标签数组（JSON），支持分类与检索过滤
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_entities_kind ON entities(kind);
CREATE INDEX IF NOT EXISTS idx_entities_first_appearance ON entities(first_appearance);

-- E.2 Fact 主表
CREATE TABLE IF NOT EXISTS facts (
  id               TEXT PRIMARY KEY,
  subject          TEXT NOT NULL,
  predicate        TEXT NOT NULL,
  value_type       TEXT NOT NULL DEFAULT 'scalar',
  value_scalar_type TEXT,
  value_scalar     TEXT,
  value_entity_ref TEXT,
  certainty        TEXT NOT NULL DEFAULT 'canonical',
  cause_event      TEXT NOT NULL,
  valid_from       REAL NOT NULL,
  valid_to         REAL,
  is_current       INTEGER GENERATED ALWAYS AS (CASE WHEN valid_to IS NULL THEN 1 ELSE 0 END) VIRTUAL,
  context          TEXT NOT NULL DEFAULT 'global',
  relation_kind    TEXT,
  embedding_text   TEXT NOT NULL DEFAULT '',
  schema_version   INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY (subject) REFERENCES entities(id),
  FOREIGN KEY (cause_event) REFERENCES events(id)
);
CREATE INDEX IF NOT EXISTS idx_facts_subject_predicate ON facts(subject, predicate);
CREATE INDEX IF NOT EXISTS idx_facts_cause_event ON facts(cause_event);
CREATE INDEX IF NOT EXISTS idx_facts_value_entity_ref ON facts(value_entity_ref) WHERE value_type = 'entity_ref';
CREATE INDEX IF NOT EXISTS idx_facts_valid_range ON facts(valid_from, valid_to);
CREATE INDEX IF NOT EXISTS idx_facts_certainty ON facts(certainty);
CREATE INDEX IF NOT EXISTS idx_facts_context ON facts(context, certainty, is_current);

-- E.3 事件表
CREATE TABLE IF NOT EXISTS events (
  id               TEXT PRIMARY KEY,
  kind             TEXT NOT NULL DEFAULT 'business',
  type             TEXT NOT NULL,
  chapter          REAL NOT NULL,
  description      TEXT NOT NULL,
  params_json      TEXT NOT NULL,
  context          TEXT NOT NULL DEFAULT 'global',
  timestamp        TEXT NOT NULL DEFAULT (datetime('now')),
  status           TEXT NOT NULL DEFAULT 'committed',
  fact_group_id    TEXT NOT NULL,
  resolved_threads TEXT NOT NULL DEFAULT '[]',
  dependencies_json TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_events_chapter ON events(chapter);
CREATE INDEX IF NOT EXISTS idx_events_context ON events(context);
CREATE INDEX IF NOT EXISTS idx_events_kind ON events(kind);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
CREATE INDEX IF NOT EXISTS idx_events_status ON events(status);
CREATE INDEX IF NOT EXISTS idx_events_params_subject ON events(json_extract(params_json, '$.subject'));

-- E.3.1 轻量级依赖边表
CREATE TABLE IF NOT EXISTS event_dependencies (
  event_id         TEXT NOT NULL,
  fact_id          TEXT NOT NULL,
  source           TEXT NOT NULL DEFAULT 'llm',
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (event_id, fact_id),
  FOREIGN KEY (event_id) REFERENCES events(id),
  FOREIGN KEY (fact_id) REFERENCES facts(id)
);
CREATE INDEX IF NOT EXISTS idx_event_dependencies_fact ON event_dependencies(fact_id);
CREATE INDEX IF NOT EXISTS idx_event_dependencies_event ON event_dependencies(event_id);

-- E.4 叙事线索表（Phase 2 启用，但表结构 Phase 1 即创建）
CREATE TABLE IF NOT EXISTS threads (
  id               TEXT PRIMARY KEY,
  type             TEXT NOT NULL,
  direction        TEXT NOT NULL,
  severity         TEXT NOT NULL,
  description      TEXT NOT NULL,
  close_condition  TEXT NOT NULL,
  status           TEXT NOT NULL,
  closed_by        TEXT,
  created_at_event TEXT NOT NULL,
  created_at_chapter REAL NOT NULL,
  related_entities TEXT NOT NULL DEFAULT '[]',
  upstream_fact_ids TEXT NOT NULL DEFAULT '[]',
  milestones       TEXT NOT NULL DEFAULT '[]',
  hint_count       INTEGER NOT NULL DEFAULT 0,
  tags             TEXT DEFAULT NULL,
  arc_tag          TEXT DEFAULT NULL,
  FOREIGN KEY (created_at_event) REFERENCES events(id),
  FOREIGN KEY (closed_by) REFERENCES events(id)
);
CREATE INDEX IF NOT EXISTS idx_threads_status ON threads(status);
CREATE INDEX IF NOT EXISTS idx_threads_direction ON threads(direction);
CREATE INDEX IF NOT EXISTS idx_threads_severity ON threads(severity);
CREATE INDEX IF NOT EXISTS idx_threads_closed_by ON threads(closed_by);
CREATE INDEX IF NOT EXISTS idx_threads_created_chapter ON threads(created_at_chapter);
CREATE INDEX IF NOT EXISTS idx_threads_related_entities ON threads(json_extract(related_entities, '$[0]'));
CREATE INDEX IF NOT EXISTS idx_threads_upstream_fact ON threads(json_extract(upstream_fact_ids, '$[0]'));

-- E.5 同步队列（LanceDB sync outbox）
CREATE TABLE IF NOT EXISTS sync_queue (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id         TEXT NOT NULL,
  operation        TEXT NOT NULL,
  fact_ids         TEXT NOT NULL,
  payload_json     TEXT NOT NULL DEFAULT '{}',
  status           TEXT NOT NULL DEFAULT 'pending',
  retry_count      INTEGER NOT NULL DEFAULT 0,
  max_retries      INTEGER NOT NULL DEFAULT 3,
  next_retry_at    TEXT NOT NULL,
  last_error       TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (event_id) REFERENCES events(id)
);
CREATE INDEX IF NOT EXISTS idx_sync_queue_next_retry ON sync_queue(next_retry_at);
CREATE INDEX IF NOT EXISTS idx_sync_queue_status_retry ON sync_queue(status, next_retry_at);
CREATE INDEX IF NOT EXISTS idx_sync_queue_operation ON sync_queue(operation);

-- E.6 审计日志
CREATE TABLE IF NOT EXISTS audit_log (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id         TEXT NOT NULL,
  tool_name        TEXT NOT NULL,
  raw_input_json   TEXT NOT NULL,
  timestamp        TEXT NOT NULL DEFAULT (datetime('now')),
  status           TEXT NOT NULL DEFAULT 'committed',
  FOREIGN KEY (event_id) REFERENCES events(id)
);
CREATE INDEX IF NOT EXISTS idx_audit_log_event ON audit_log(event_id);

-- E.7 知识可见性存储
CREATE TABLE IF NOT EXISTS knowledge (
  id               TEXT PRIMARY KEY,
  fact_id          TEXT NOT NULL,
  entity_id        TEXT NOT NULL,
  known_since      REAL NOT NULL,
  source           TEXT NOT NULL,
  confidence       REAL NOT NULL DEFAULT 1.0,
  previous_confidence REAL,
  updated_at_event TEXT,
  FOREIGN KEY (fact_id) REFERENCES facts(id),
  FOREIGN KEY (entity_id) REFERENCES entities(id),
  FOREIGN KEY (updated_at_event) REFERENCES events(id)
);
CREATE INDEX IF NOT EXISTS idx_knowledge_entity ON knowledge(entity_id, known_since);
CREATE INDEX IF NOT EXISTS idx_knowledge_fact ON knowledge(fact_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_confidence ON knowledge(confidence);
CREATE INDEX IF NOT EXISTS idx_knowledge_entity_fact_time ON knowledge(entity_id, fact_id, known_since);

-- E.8 项目级运行状态（乐观锁 + 当前章节）
CREATE TABLE IF NOT EXISTS project_state (
  project_id        TEXT PRIMARY KEY,
  state_version     INTEGER NOT NULL DEFAULT 0,
  current_chapter   REAL NOT NULL DEFAULT 1,
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

-- E.9 World Package 存储（Tool 9/10 Schema Extension 写入目标）
-- 谓词注册表：存储已注册的 predicate 定义
CREATE TABLE IF NOT EXISTS wp_predicates (
  name             TEXT PRIMARY KEY,
  display_name     TEXT NOT NULL,
  value_type       TEXT NOT NULL DEFAULT 'scalar',
  enum_values      TEXT,                         -- JSON 数组
  sequence_order   TEXT,                         -- JSON 数组（有序枚举的递进序列）
  description      TEXT NOT NULL DEFAULT '',
  relation_kind    TEXT NOT NULL DEFAULT 'structural',
  deprecated       INTEGER NOT NULL DEFAULT 0,
  replacement_name TEXT
);

-- 谓词别名：旧名称 → 当前推荐名称
CREATE TABLE IF NOT EXISTS wp_predicate_aliases (
  alias            TEXT PRIMARY KEY,
  canonical_name   TEXT NOT NULL,
  FOREIGN KEY (canonical_name) REFERENCES wp_predicates(name)
);

-- 规则表：存储声明式 JSON 规则
CREATE TABLE IF NOT EXISTS wp_rules (
  id               TEXT PRIMARY KEY,
  type             TEXT NOT NULL,                 -- transition | inference | constraint | propagation
  name             TEXT NOT NULL,
  description      TEXT NOT NULL DEFAULT '',
  priority         INTEGER NOT NULL DEFAULT 0,
  definition_json  TEXT NOT NULL,                 -- 完整规则 JSON
  enabled          INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_wp_rules_type ON wp_rules(type);

-- 实体模板表
CREATE TABLE IF NOT EXISTS wp_entity_templates (
  name                  TEXT PRIMARY KEY,
  kind                  TEXT NOT NULL,
  extends_template      TEXT,
  default_predicates    TEXT NOT NULL DEFAULT '[]', -- JSON 数组
  override_predicates   TEXT,                       -- JSON 对象（可选）
  description           TEXT NOT NULL DEFAULT ''
);

-- 作用域预设表
CREATE TABLE IF NOT EXISTS wp_scope_presets (
  name                    TEXT PRIMARY KEY,
  display_name            TEXT NOT NULL,
  default_exit_behavior   TEXT NOT NULL DEFAULT 'suggest_discard',
  inherits_global_rules   INTEGER NOT NULL DEFAULT 1,
  override_rules          TEXT,                    -- JSON（可选）
  description             TEXT NOT NULL DEFAULT ''
);
`;

// ---------------------------------------------------------------------------
// SQLiteFactStoreAdapter
// ---------------------------------------------------------------------------

export class SQLiteFactStoreAdapter implements FactStore {
  private db: Database.Database;
  /**
   * 该 factStore 绑定的项目 ID（状态版本乐观锁的 key）。
   *
   * 2026-06-18 修复：此前构造接收 projectId 但只用于初始化 project_state 行就丢弃，
   * 导致 Core 层（proposal-manager/retcon-engine）写死 'default' 调 getStateVersion/tryUpdateStateVersion。
   * 现在存为字段，Core 层经 getProjectId() 取真实项目 ID，消除硬编码（每项目独立 db 文件后双保险）。
   */
  private readonly projectId: string;
  // P1-1 修复：Fact 序列改为 DB COUNT 查询（见 assert 方法），不再持有内存计数器。
  // 原内存 Map 在进程重启后清空；若为已存在事件重新 assert 会生成重复 factId 触发主键冲突。

  /** 私有标记：用于区分"已打开句柄"的内部构造路径，避免与公开路径构造函数签名冲突 */
  private static readonly EXISTING_DB = Symbol('existing-db');

  /**
   * 公开构造：自己打开 db 文件（或 ':memory:'），启用 WAL/foreign_keys，建表。
   * 54+ 测试沿用此路径：`new SQLiteFactStoreAdapter(':memory:', projectId)`。
   */
  constructor(dbPath: string, projectId?: string);

  /**
   * 内部构造：用「已打开」的 Database 句柄构造（配合 EXISTING_DB 标记）。
   * 仅供 forExistingDb 使用，不 new Database、不重复 pragma。
   */
  constructor(db: Database.Database, projectId: string, marker: symbol);

  /** 构造实现：按是否带 EXISTING_DB 标记分流 */
  constructor(dbPathOrDb: string | Database.Database, projectId: string = 'default', marker?: symbol) {
    this.projectId = projectId;
    if (marker === SQLiteFactStoreAdapter.EXISTING_DB) {
      // 已打开句柄路径：直接持有（调用方负责 pragma）
      this.db = dbPathOrDb as Database.Database;
    } else {
      // 常规路径：打开文件并启用 WAL/foreign_keys
      this.db = new Database(dbPathOrDb as string);
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('foreign_keys = ON');
    }
    // 建表 + 初始化项目状态（两条路径共用）
    this.initSchema(projectId);
  }

  /**
   * 工厂方法：用「已打开」的 Database 句柄构造（不再自己 new Database）。
   *
   * 用于存储融合后的 ProjectSession：由 ProjectSession 统一打开 project.db
   * 并设置 pragma，再把句柄传给 FactStore 与其他 adapter 共享（消除"FactStore
   * 既是 adapter 又是 db 工厂"的双重身份）。调用方需自行保证：
   *   - 句柄已设置 WAL / foreign_keys（FactStore 不再重复设置）
   *   - 同一句柄不会被多个 FactStore 实例重复建表（DDL 幂等，可重复执行）
   *
   * 不影响旧构造函数：54+ 测试继续用 `new SQLiteFactStoreAdapter(':memory:')`。
   */
  static forExistingDb(db: Database.Database, projectId: string = 'default'): SQLiteFactStoreAdapter {
    return new SQLiteFactStoreAdapter(db, projectId, SQLiteFactStoreAdapter.EXISTING_DB);
  }

  /**
   * 建表 + 初始化 project_state（幂等）。两条构造路径共用。
   * 抽成私有方法以避免重复逻辑。
   */
  private initSchema(projectId: string): void {
    // 建表（DDL 幂等）
    this.db.exec(DDL);
    // 初始化项目状态（幂等）
    this.db.prepare(`
      INSERT OR IGNORE INTO project_state (project_id, state_version, current_chapter)
      VALUES (?, 0, 1)
    `).run(projectId);
  }

  /** 获取底层 Database 实例（供同库的其他 Adapter 使用） */
  getDatabase(): Database.Database {
    return this.db;
  }

  /** 关闭数据库连接 */
  close(): void {
    this.db.close();
  }

  // -----------------------------------------------------------------------
  // 写入操作
  // -----------------------------------------------------------------------

  /**
   * 断言新 Fact
   *
   * 自动生成 id 和 embeddingText（如果调用方未提供）。
   * causeEvent 和 validFrom 由调用方传入（通常来自 FactGroup）。
   */
  assert(fact: Omit<Fact, 'id' | 'embeddingText'>): Fact {
    const { valueType, scalarType, textValue } = this.serializeFactValue(fact.value);

    // 生成 Fact ID：fct_{完整事件标识}_{seq}
    // 用 causeEvent 去掉 evt_ 前缀后的【完整】字符串作为 Fact ID 前缀，保证不同事件
    // 产生的 Fact ID 永不冲突。
    //
    // P1-1b 修复（2026-06-14，writing-loop 场景 B/E 根因）：
    // 此前按 split('_') 取 [0..2] 拼接（type/chapter/seq），对多词事件类型会误解析——
    // evt_character_intro_1_03 被切成 ['character','intro','1','03']，eventSeq 只取到 '1'，
    // 末尾真正区分事件的全局序号 '03' 被丢弃。于是同一族事件 evt_character_intro_1_03 与
    // evt_character_intro_1_05 会生成完全相同的 fct_character_intro_1_01，命中 facts.id 的
    // UNIQUE 约束，第二次 commit_event 直接失败（抛 UNIQUE constraint failed: facts.id）。
    // 这不是 LLM / 超时问题，而是确定性的 ID 生成缺陷。
    //
    // 改用完整 eventTag 后：fct_character_intro_1_03_01 与 fct_character_intro_1_05_01 天然不同；
    // 单词类型同样兼容——evt_tribulation_50 → fct_tribulation_50_01（与旧格式逐字一致）。
    // knowledge-store.generateId 把 factRef 当不透明串处理（自带 seq 去重），不解析其内部结构，故无影响。
    const eventTag = fact.causeEvent.replace(/^evt_/, '');

    // P1-1 修复：Fact 序号从 DB 持久化查询，消除内存计数器依赖
    // 事务内多次 assert 可见同事务的 INSERT，COUNT 自然递增；
    // facts 表为 append-only（retcon 用 markInvalid 软失效，不物理删除），保证 seq 单调。
    const existingCount = (this.db.prepare(
      'SELECT COUNT(*) AS cnt FROM facts WHERE cause_event = ?'
    ).get(fact.causeEvent) as { cnt: number }).cnt;
    const nextSeq = existingCount + 1;

    // 构造 Fact ID：eventTag 含完整事件标识（含全局序号），nextSeq 保证同事件内 Fact 唯一
    const factId = `fct_${eventTag}_${String(nextSeq).padStart(2, '0')}`;

    // embeddingText 由 assert 内部生成（架构 §2214：FactEmbedder 在 assert 内部生成；
    // 接口签名 Omit<Fact,'id'|'embeddingText'> 不接收外部传入）。
    // 此前曾留空 ''，导致 sync_queue consumer 只能用兜底拼接 "ent_xxx pred val"——
    // 语义信号过弱，语义检索召回质量下降（见 §5A-6 第 5 章场景召回失败的回归）。
    // 现按 §3.1.2 标准格式生成，保证 embedding_text 列非空且语义充分。
    const embeddingText = this.buildEmbeddingText(fact);

    this.db.prepare(`
      INSERT INTO facts (id, subject, predicate, value_type, value_scalar_type, value_scalar, value_entity_ref,
                         certainty, cause_event, valid_from, valid_to, context, relation_kind, embedding_text)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      factId,
      fact.subject,
      fact.predicate,
      valueType,
      scalarType ?? null,
      valueType === 'scalar' ? textValue : null,
      valueType === 'entity_ref' ? textValue : null,
      fact.certainty ?? 'canonical',
      fact.causeEvent,
      fact.validFrom,
      fact.validTo ?? null,
      fact.context ?? 'global',
      fact.relationKind ?? null,
      embeddingText,
    );

    return this.rowToFact(this.db.prepare('SELECT * FROM facts WHERE id = ?').get(factId) as FactRow);
  }

  /**
   * 生成 Fact 的 embeddingText（写入 LanceDB 前的向量化输入文本）
   *
   * 架构 §3.1.2 规范格式：`{主体显示名} 的{谓词}是 {值显示名}（第{章}章）`。
   * 完整实现应由 FactEmbedder + WorldPackage 提供（谓词中文名、描述增强），
   * 但 FactStore 层无 WorldPackage 访问权限，故此处为字段组合的降级实现：
   * 主体/值均解析为实体显示名（ent_hanli → 韩立），谓词用原始名。
   * 关键保证：embedding_text 列永不为空，避免 consumer 兜底拼接出裸 ID 文本。
   */
  private buildEmbeddingText(fact: Omit<Fact, 'id' | 'embeddingText'>): string {
    const subjectName = this.resolveEntityName(fact.subject);
    const { valueType, textValue } = serializeFactValue(fact.value);
    // entity_ref 值解析为目标实体显示名，避免向量输入出现裸实体 ID（如 ent_lisi）
    const valueDisplay = valueType === 'entity_ref'
      ? this.resolveEntityName(textValue)
      : textValue;
    return `${subjectName} 的${fact.predicate}是 ${valueDisplay}（第${fact.validFrom}章）`;
  }

  /**
   * 解析实体 ID 为人类可读显示名
   *
   * 查 entities 表 name 列；查不到（实体未注册，或 subject 本就不是实体）时
   * 剥离 ent_ 前缀兜底，保证返回非空字符串。单行主键查询，开销可忽略。
   */
  private resolveEntityName(entityId: string): string {
    if (!entityId || !entityId.startsWith('ent_')) return entityId || '';
    const row = this.db.prepare('SELECT name FROM entities WHERE id = ?')
      .get(entityId) as { name?: string } | undefined;
    return row?.name ?? entityId.replace('ent_', '');
  }

  /**
   * 撤回 Fact（设置 valid_to，不物理删除）
   */
  retract(factId: string, validTo: number): void {
    const result = this.db.prepare(`
      UPDATE facts SET valid_to = ? WHERE id = ? AND valid_to IS NULL
    `).run(validTo, factId);
    if (result.changes === 0) {
      throw new Error(`FACT_NOT_FOUND 或已失效: ${factId}`);
    }
  }

  /**
   * 更新 Fact：retract 旧 + assert 新（保证不可变性）
   *
   * context 参数用于 exit_scope 场景（可选，省略则继承原 Fact 的 context）。
   */
  update(
    factId: string,
    newValue: FactValue,
    newCauseEvent: string,
    validFrom: number,
    context?: string,
  ): Fact {
    const oldFact = this.getById(factId);
    if (!oldFact) throw new Error(`FACT_NOT_FOUND: ${factId}`);

    // 撤回旧 Fact
    this.retract(factId, validFrom);

    // 断言新 Fact（继承旧 Fact 的大部分字段）
    const newFact = this.assert({
      subject: oldFact.subject,
      predicate: oldFact.predicate,
      value: newValue,
      certainty: oldFact.certainty,
      causeEvent: newCauseEvent,
      validFrom,
      validTo: null,
      context: context ?? oldFact.context,
      relationKind: oldFact.relationKind,
      schemaVersion: oldFact.schemaVersion,
    });

    return newFact;
  }

  /**
   * 原子应用一组变更（SAVEPOINT 实现组内局部回滚）
   *
   * 调用约定：此方法在 commit_event Phase B 的 SQLite 事务内调用。
   * 返回 changeId → factId 映射表，供上层 KnowledgeStore / ThreadStore / audit_log 消费。
   */
  applyFactGroup(group: FactGroup): Map<string, string> {
    const idMap = new Map<string, string>();

    this.db.prepare('SAVEPOINT factgroup_sp').run();
    try {
      for (const change of group.changes) {
        if (change.op === 'assert') {
          if (!change.payload) throw new Error('SCHEMA_VALIDATION_FAILED: assert 缺少 payload');
          if (change.payload.subject === undefined) throw new Error('SCHEMA_VALIDATION_FAILED: assert 缺少 subject');
          if (change.payload.predicate === undefined) throw new Error('SCHEMA_VALIDATION_FAILED: assert 缺少 predicate');
          if (change.payload.value === undefined) throw new Error('SCHEMA_VALIDATION_FAILED: assert 缺少 value');
          if (change.payload.validFrom === undefined) throw new Error('SCHEMA_VALIDATION_FAILED: assert 缺少 validFrom');

          const newFact = this.assert({
            subject: change.payload.subject,
            predicate: change.payload.predicate,
            value: change.payload.value,
            certainty: change.payload.certainty ?? 'canonical',
            causeEvent: group.causeEvent,
            validFrom: change.payload.validFrom,
            validTo: change.payload.validTo ?? null,
            context: change.payload.context ?? 'global',
            relationKind: change.payload.relationKind,
            schemaVersion: change.payload.schemaVersion ?? 1,
          });
          if (change.changeId) {
            idMap.set(change.changeId, newFact.id);
          }
        } else if (change.op === 'retract') {
          if (!change.targetFactId) throw new Error('SCHEMA_VALIDATION_FAILED: retract 缺少 targetFactId');
          if (!change.payload || typeof change.payload.validTo !== 'number') {
            throw new Error('SCHEMA_VALIDATION_FAILED: retract 缺少 validTo');
          }

          const targetId = change.targetFactId;
          const targetFact = this.getById(targetId);
          if (!targetFact) throw new Error(`FACT_NOT_FOUND: ${targetId}`);
          if (targetFact.validTo !== null) throw new Error(`FACT_NOT_CURRENT: ${targetId}`);
          if (change.payload.context && targetFact.context !== change.payload.context) {
            throw new Error(`SCOPE_FACT_MISMATCH: ${targetId}`);
          }
          this.retract(targetId, change.payload.validTo);
          if (change.changeId) {
            idMap.set(change.changeId, targetId);
          }
        } else if (change.op === 'update') {
          if (!change.targetFactId) throw new Error('SCHEMA_VALIDATION_FAILED: update 缺少 targetFactId');
          if (!change.payload || change.payload.validFrom === undefined) {
            throw new Error('SCHEMA_VALIDATION_FAILED: update 缺少 validFrom');
          }

          const targetId = change.targetFactId;
          const targetFact = this.getById(targetId);
          if (!targetFact) throw new Error(`FACT_NOT_FOUND: ${targetId}`);
          if (targetFact.validTo !== null) throw new Error(`FACT_NOT_CURRENT: ${targetId}`);
          if (change.payload.context && targetFact.context !== change.payload.context) {
            throw new Error(`SCOPE_FACT_MISMATCH: ${targetId}`);
          }

          this.retract(targetId, change.payload.validFrom);
          const newFact = this.assert({
            subject: change.payload.subject ?? targetFact.subject,
            predicate: change.payload.predicate ?? targetFact.predicate,
            value: change.payload.value !== undefined ? change.payload.value : targetFact.value,
            certainty: change.payload.certainty ?? targetFact.certainty,
            causeEvent: group.causeEvent,
            validFrom: change.payload.validFrom,
            validTo: null,
            context: change.payload.context ?? targetFact.context,
            relationKind: change.payload.relationKind ?? targetFact.relationKind,
            schemaVersion: change.payload.schemaVersion ?? targetFact.schemaVersion,
          });
          if (change.changeId) {
            idMap.set(change.changeId, newFact.id);
          }
        }
      }
      this.db.prepare('RELEASE factgroup_sp').run();
    } catch (err) {
      this.db.prepare('ROLLBACK TO factgroup_sp').run();
      throw err;
    }

    return idMap;
  }

  /**
   * 物理删除 Fact（仅供事务回滚使用，不对外暴露）
   */
  forceRemove(factId: string): void {
    this.db.prepare('DELETE FROM facts WHERE id = ?').run(factId);
  }

  // -----------------------------------------------------------------------
  // 查询操作
  // -----------------------------------------------------------------------

  /**
   * 通用多维查询
   *
   * 时间切片过滤规则（§4.3）：
   *   fact.validFrom <= query.atChapter
   *   AND (query.mode='history' OR fact.validTo IS NULL OR fact.validTo > query.atChapter)
   */
  query(query: FactQuery): Fact[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (query.subject) {
      conditions.push('subject = ?');
      params.push(query.subject);
    }
    if (query.predicate) {
      conditions.push('predicate = ?');
      params.push(query.predicate);
    }

    // 时间切片
    if (query.atChapter !== undefined) {
      conditions.push('valid_from <= ?');
      params.push(query.atChapter);
      if (query.mode !== 'history') {
        // current 模式：只查当前有效的 Fact
        conditions.push('(valid_to IS NULL OR valid_to > ?)');
        params.push(query.atChapter);
      }
    }

    // 确定性过滤
    if (query.certainties && query.certainties.length > 0) {
      conditions.push(`certainty IN (${query.certainties.map(() => '?').join(',')})`);
      params.push(...query.certainties);
    } else {
      // 默认只查 canonical 和 contested
      conditions.push("certainty IN ('canonical', 'contested')");
    }

    // 关系语义过滤
    if (query.relationKind) {
      conditions.push('relation_kind = ?');
      params.push(query.relationKind);
    }

    // 反向关系查询
    if (query.valueEntityRef) {
      conditions.push('value_type = ? AND value_entity_ref = ?');
      params.push('entity_ref', query.valueEntityRef);
    }

    // 作用域过滤
    if (query.context && query.context !== 'global' && query.includeInherited !== false) {
      // 包含继承：自身 context + global 的兜底
      conditions.push('(context = ? OR context = ?)');
      params.push(query.context, 'global');
    } else if (query.context) {
      conditions.push('context = ?');
      params.push(query.context);
    }

    // 非活跃 Fact 显式过滤
    // 未传 atChapter 时，SQL 层没有 valid_to 过滤条件，需要在这里补上：
    // 默认只返回当前有效的 Fact（valid_to IS NULL），除非调用方显式要求历史/全部。
    if (query.includeInactive !== true && query.mode !== 'history' && query.atChapter === undefined) {
      conditions.push('valid_to IS NULL');
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = this.db.prepare(`SELECT * FROM facts ${whereClause} ORDER BY valid_from DESC`).all(...params) as FactRow[];
    return rows.map(r => this.rowToFact(r));
  }

  /**
   * 实体在某章节时刻的状态快照
   *
   * 返回 { predicate: value } 的去重字典（同 predicate 取最新 validFrom 的值）。
   */
  getSnapshot(subject: string, atChapter: number): Record<string, FactValue> {
    const facts = this.query({
      subject,
      atChapter,
      certainties: ['canonical', 'contested'],
      mode: 'current',
    });

    // 同 predicate 取 validFrom 最新的值（最近一次变更）
    const snapshot: Record<string, FactValue> = {};
    for (const f of facts) {
      if (!(f.predicate in snapshot)) {
        snapshot[f.predicate] = f.value;
      }
    }
    return snapshot;
  }

  /**
   * 按事件追溯其产生的所有 Fact
   */
  getFactsByEvent(eventId: string): Fact[] {
    const rows = this.db.prepare(
      'SELECT * FROM facts WHERE cause_event = ? ORDER BY id'
    ).all(eventId) as FactRow[];
    return rows.map(r => this.rowToFact(r));
  }

  /**
   * 按 ID 获取单条 Fact
   */
  getById(factId: string): Fact | undefined {
    const row = this.db.prepare('SELECT * FROM facts WHERE id = ?').get(factId) as FactRow | undefined;
    return row ? this.rowToFact(row) : undefined;
  }

  /**
   * 检查实体是否已在 entities 表注册。
   *
   * witness_propagation 遍历 location fact 的 subject 作 witness 时，必须过滤掉未注册的 subject，
   * 否则产生的 knowledge 行 entity_id 违反外键约束导致 commit_event 回滚（FOREIGN KEY failed）。
   * 此前纯 service 路径 register+simulate+commit 总失败、Agent 路径成功的根因即此。
   */
  entityExists(entityId: string): boolean {
    const row = this.db.prepare('SELECT 1 FROM entities WHERE id = ?').get(entityId);
    return row !== undefined;
  }

  /**
   * 查询所有指向某实体的关系 Fact（反向查询）
   */
  getRelationsTargeting(entityId: string, atChapter?: number): Fact[] {
    const conditions: string[] = ['value_type = ?', 'value_entity_ref = ?'];
    const params: unknown[] = ['entity_ref', entityId];

    if (atChapter !== undefined) {
      conditions.push('valid_from <= ?');
      params.push(atChapter);
      conditions.push('(valid_to IS NULL OR valid_to > ?)');
      params.push(atChapter);
    }

    const rows = this.db.prepare(
      `SELECT * FROM facts WHERE ${conditions.join(' AND ')} ORDER BY valid_from DESC`
    ).all(...params) as FactRow[];
    return rows.map(r => this.rowToFact(r));
  }

  // -----------------------------------------------------------------------
  // Retcon 操作
  // -----------------------------------------------------------------------

  /**
   * 批量将 canonical Fact 标记为 contested
   *
   * 只标记 certainty='canonical' 的 Fact，已 contested/orphaned 的不重复标记。
   * 返回实际更新的行数（用于验证预期标记数量）。
   *
   * Event Sourcing 原则：不 DELETE，只 UPDATE certainty 字段。
   * contested Fact 保持 is_current=true —— 它仍是"当前"状态，只是确定性被质疑。
   *
   * 注：causeEvent 参数当前未写入 facts 表（无 contest_cause 列）。
   * Retcon 的因果溯源（哪个 retcon 事件标记了哪些 fact）经 event_dependencies 表建立——
   * retcon-engine.ts 在 markContested 后单独 INSERT event_dependencies。此参数保留供
   * 未来若需在 facts 行直接记录 contest 因果（避免 JOIN event_dependencies 查询）。
   */
  markContested(factIds: string[], causeEvent: string): number {
    void causeEvent; // 当前未使用（因果经 event_dependencies），保留参数避免接口变更
    if (factIds.length === 0) return 0;

    const placeholders = factIds.map(() => '?').join(',');
    const result = this.db.prepare(
      `UPDATE facts SET certainty = 'contested' WHERE id IN (${placeholders}) AND certainty = 'canonical'`
    ).run(...factIds);
    return result.changes;
  }

  /**
   * 单条 Fact 的确定性字段变更
   *
   * 主要用于测试重置（contested → canonical）或特殊恢复路径。
   * 不通过 markContested 批量操作单独调用——批量操作应使用 markContested。
   */
  updateCertainty(factId: string, certainty: Certainty): void {
    this.db.prepare(
      'UPDATE facts SET certainty = ? WHERE id = ?'
    ).run(certainty, factId);
  }

  // -----------------------------------------------------------------------
  // 辅助方法
  // -----------------------------------------------------------------------

  /**
   * 将 SQLite 行转换为 Fact 对象
   */
  private rowToFact(row: FactRow): Fact {
    return {
      id: row.id,
      subject: row.subject,
      predicate: row.predicate,
      value: this.deserializeFactValue(row),
      certainty: row.certainty as Certainty,
      causeEvent: row.cause_event,
      validFrom: row.valid_from,
      validTo: row.valid_to,
      context: row.context,
      relationKind: (row.relation_kind as Fact['relationKind']) ?? undefined,
      embeddingText: row.embedding_text,
      schemaVersion: row.schema_version,
    };
  }

  /**
   * 序列化 FactValue → SQLite 存储格式
   */
  private serializeFactValue(value: FactValue): {
    valueType: 'scalar' | 'entity_ref';
    scalarType: FactScalarType | null;
    textValue: string;
  } {
    const serialized = serializeFactValue(value);
    return {
      valueType: serialized.valueType,
      scalarType: serialized.scalarType ?? null,
      textValue: serialized.textValue,
    };
  }

  /**
   * 从 SQLite 行反序列化 FactValue
   */
  private deserializeFactValue(row: FactRow): FactValue {
    return deserializeFactValue({
      valueType: row.value_type,
      scalarType: row.value_scalar_type ?? undefined,
      textValue: row.value_type === 'entity_ref' ? (row.value_entity_ref ?? '') : (row.value_scalar ?? ''),
    });
  }

  /**
   * 返回该 factStore 绑定的项目 ID（Core 层状态版本乐观锁的 key）。
   *
   * Core 层（proposal-manager/retcon-engine）经此方法取真实项目 ID，
   * 消除硬编码 'default'（每项目独立 db 文件后双保险）。
   */
  getProjectId(): string {
    return this.projectId;
  }

  /**
   * 获取项目当前乐观锁版本号（供 commit_event Phase B 使用）。
   *
   * @param projectId 可选；省略时用 factStore 绑定的项目 ID（消除 Core 层硬编码）
   */
  getStateVersion(projectId?: string): number {
    const row = this.db.prepare(
      'SELECT state_version FROM project_state WHERE project_id = ?'
    ).get(projectId ?? this.projectId) as { state_version: number } | undefined;
    return row?.state_version ?? 0;
  }

  /**
   * 条件更新乐观锁版本号（Phase B 第一步）。
   *
   * @param projectId 可选；省略时用 factStore 绑定的项目 ID
   * @returns 更新行数（0 = 版本冲突，1 = 成功）
   */
  tryUpdateStateVersion(projectId: string | undefined, expectedVersion: number): boolean {
    const result = this.db.prepare(
      `UPDATE project_state SET state_version = state_version + 1, updated_at = datetime('now')
       WHERE project_id = ? AND state_version = ?`
    ).run(projectId ?? this.projectId, expectedVersion);
    return result.changes === 1;
  }
}

// =============================================================================
// SQLiteAgentStoreAdapter — Agent 持久化层
// =============================================================================
// NarrativeAgent v0.1 持久化：7 张表（agent_sessions / agent_turns /
// agent_working_drafts / agent_traces / agent_messages /
// agent_context_summaries / agent_memories）。
//
// 设计要点：
//   - 与 FactStore 共享同一 SQLite 连接（同库不同表）
//   - 所有写入使用 prepared statement，批量操作走事务
//   - JSON 字段使用 JSON.stringify / JSON.parse 序列化
//   - ID 格式：表前缀 + 时间戳 + 随机后缀
//   - 外键约束：turns → sessions, traces → sessions+turns, messages → sessions+turns
//
// 对应设计文档：
//   §13 Trace 持久化
//   §14.1-14.7 数据库表设计
// =============================================================================

import type Database from 'better-sqlite3';
import type {
  AgentWorkingDraft,
  AgentWorkingDraftStatus,
  AgentTraceRecord,
  AgentTraceStepType,
  AgentTraceStatus,
  AgentMessage,
  AgentLongTermMemory,
  AgentMemoryKind,
  AgentMemoryStatus,
  AgentContextSummary,
  CommitAuthority,
  AgentTurnStatus,
} from '../../agent/types.js';

// =============================================================================
// DDL — 7 张 Agent 相关表
// =============================================================================

export const AGENT_DDL = `
-- 14.1 agent_sessions：记录一次智能体会话
CREATE TABLE IF NOT EXISTS agent_sessions (
  id                 TEXT PRIMARY KEY,
  project_id         TEXT NOT NULL,
  title              TEXT,
  status             TEXT NOT NULL DEFAULT 'active',
  commit_authority   TEXT NOT NULL DEFAULT 'explicit_user_confirmation',
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at          TEXT
);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_project
  ON agent_sessions(project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_status
  ON agent_sessions(status);

-- 14.2 agent_turns：记录用户与 Agent 的一次回合
CREATE TABLE IF NOT EXISTS agent_turns (
  id                  TEXT PRIMARY KEY,
  session_id          TEXT NOT NULL,
  project_id          TEXT NOT NULL,
  user_message_summary TEXT NOT NULL,
  plan_summary        TEXT,
  assistant_summary   TEXT,
  status              TEXT NOT NULL DEFAULT 'running',
  pending_proposal_ids TEXT NOT NULL DEFAULT '[]',
  working_draft_id    TEXT,
  started_at          TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at        TEXT,
  FOREIGN KEY (session_id) REFERENCES agent_sessions(id)
);
CREATE INDEX IF NOT EXISTS idx_agent_turns_session
  ON agent_turns(session_id, started_at);
CREATE INDEX IF NOT EXISTS idx_agent_turns_status
  ON agent_turns(status);

-- 14.3 agent_working_drafts：记录多轮协商中的草案状态
CREATE TABLE IF NOT EXISTS agent_working_drafts (
  id                    TEXT PRIMARY KEY,
  session_id            TEXT NOT NULL,
  project_id            TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'collecting',
  summary               TEXT NOT NULL,
  structured_intent_json TEXT NOT NULL DEFAULT '{}',
  proposed_changes_json TEXT NOT NULL DEFAULT '[]',
  proposal_id           TEXT,
  revision_count        INTEGER NOT NULL DEFAULT 0,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (session_id) REFERENCES agent_sessions(id)
);
CREATE INDEX IF NOT EXISTS idx_agent_working_drafts_session
  ON agent_working_drafts(session_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_agent_working_drafts_status
  ON agent_working_drafts(status);
CREATE INDEX IF NOT EXISTS idx_agent_working_drafts_proposal
  ON agent_working_drafts(proposal_id);

-- 14.4 agent_traces：记录 ReAct 摘要（可审计性核心）
CREATE TABLE IF NOT EXISTS agent_traces (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL,
  session_id     TEXT NOT NULL,
  turn_id        TEXT NOT NULL,
  step_index     INTEGER NOT NULL,
  step_type      TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'ok',
  summary        TEXT NOT NULL,
  detail_json    TEXT NOT NULL DEFAULT '{}',
  tool_name      TEXT,
  tool_call_id   TEXT,
  proposal_id    TEXT,
  event_id       TEXT,
  error_code     TEXT,
  next_action    TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (session_id) REFERENCES agent_sessions(id),
  FOREIGN KEY (turn_id) REFERENCES agent_turns(id)
);
CREATE INDEX IF NOT EXISTS idx_agent_traces_turn
  ON agent_traces(turn_id, step_index);
CREATE INDEX IF NOT EXISTS idx_agent_traces_session
  ON agent_traces(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_agent_traces_project
  ON agent_traces(project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_agent_traces_tool
  ON agent_traces(tool_name);
CREATE INDEX IF NOT EXISTS idx_agent_traces_error
  ON agent_traces(error_code);

-- 14.5 agent_messages：消息历史完整原文持久化
CREATE TABLE IF NOT EXISTS agent_messages (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL,
  session_id     TEXT NOT NULL,
  turn_id        TEXT,
  role           TEXT NOT NULL,
  content        TEXT NOT NULL,
  content_summary TEXT NOT NULL,
  tool_call_id   TEXT,
  compressed      INTEGER NOT NULL DEFAULT 0,
  visible_to_llm  INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (session_id) REFERENCES agent_sessions(id),
  FOREIGN KEY (turn_id) REFERENCES agent_turns(id)
);
CREATE INDEX IF NOT EXISTS idx_agent_messages_session
  ON agent_messages(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_agent_messages_turn
  ON agent_messages(turn_id, created_at);
CREATE INDEX IF NOT EXISTS idx_agent_messages_compressed
  ON agent_messages(session_id, compressed, created_at);

-- 14.6 agent_context_summaries：自动上下文压缩结果
CREATE TABLE IF NOT EXISTS agent_context_summaries (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL,
  session_id          TEXT NOT NULL,
  from_message_id     TEXT NOT NULL,
  to_message_id       TEXT NOT NULL,
  summary             TEXT NOT NULL,
  key_decisions_json  TEXT NOT NULL DEFAULT '[]',
  open_questions_json TEXT NOT NULL DEFAULT '[]',
  draft_refs_json     TEXT NOT NULL DEFAULT '[]',
  token_estimate      INTEGER,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (session_id) REFERENCES agent_sessions(id)
);
CREATE INDEX IF NOT EXISTS idx_agent_context_summaries_session
  ON agent_context_summaries(session_id, created_at);

-- 14.7 agent_memories：跨会话长期记忆
CREATE TABLE IF NOT EXISTS agent_memories (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL,
  kind           TEXT NOT NULL,
  summary        TEXT NOT NULL,
  detail_json    TEXT NOT NULL DEFAULT '{}',
  source_session_id TEXT,
  source_turn_id TEXT,
  confidence     REAL NOT NULL DEFAULT 1.0,
  status         TEXT NOT NULL DEFAULT 'active',
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_agent_memories_project
  ON agent_memories(project_id, kind, status);
CREATE INDEX IF NOT EXISTS idx_agent_memories_source
  ON agent_memories(source_session_id, source_turn_id);
`;

// =============================================================================
// ID 生成辅助
// =============================================================================

/** 生成形如：agent_session_20260612_xxxxx 的 ID */
function makeId(prefix: string): string {
  const ts = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
  const suffix = Math.random().toString(36).slice(2, 7);
  return `${prefix}_${ts}_${suffix}`;
}

// =============================================================================
// SQLiteAgentStoreAdapter
// =============================================================================

export class SQLiteAgentStoreAdapter {
  private db: Database.Database;

  /**
   * @param db 共享的 better-sqlite3 Database 实例（与 FactStore 同库）
   *           调用 createTables() 或在初始化时执行 AGENT_DDL 建表
   */
  constructor(db: Database.Database) {
    this.db = db;
  }

  /**
   * 执行 DDL 创建 Agent 相关表
   * 幂等：使用 IF NOT EXISTS
   */
  createTables(): void {
    this.db.exec(AGENT_DDL);
  }

  // =========================================================================
  // agent_sessions
  // =========================================================================

  createSession(projectId: string, title?: string, commitAuthority?: CommitAuthority): string {
    const id = makeId('agent_session');
    const stmt = this.db.prepare(`
      INSERT INTO agent_sessions (id, project_id, title, commit_authority)
      VALUES (?, ?, ?, ?)
    `);
    stmt.run(id, projectId, title ?? null, commitAuthority ?? 'explicit_user_confirmation');
    return id;
  }

  getSession(sessionId: string): SessionRow | undefined {
    return this.db.prepare('SELECT * FROM agent_sessions WHERE id = ?').get(sessionId) as SessionRow | undefined;
  }

  getActiveSessions(projectId: string): SessionRow[] {
    return this.db.prepare(
      'SELECT * FROM agent_sessions WHERE project_id = ? AND status = ? ORDER BY created_at DESC'
    ).all(projectId, 'active') as SessionRow[];
  }

  closeSession(sessionId: string): void {
    this.db.prepare(
      "UPDATE agent_sessions SET status = 'closed', closed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?"
    ).run(sessionId);
  }

  updateSessionTitle(sessionId: string, title: string): void {
    this.db.prepare(
      "UPDATE agent_sessions SET title = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(title, sessionId);
  }

  // =========================================================================
  // agent_turns
  // =========================================================================

  createTurn(sessionId: string, projectId: string, userMessageSummary: string): string {
    const id = makeId('agent_turn');
    const stmt = this.db.prepare(`
      INSERT INTO agent_turns (id, session_id, project_id, user_message_summary, plan_summary, assistant_summary)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    stmt.run(id, sessionId, projectId, userMessageSummary, null, null);
    return id;
  }

  getTurn(turnId: string): TurnRow | undefined {
    return this.db.prepare('SELECT * FROM agent_turns WHERE id = ?').get(turnId) as TurnRow | undefined;
  }

  getTurnsBySession(sessionId: string): TurnRow[] {
    return this.db.prepare(
      'SELECT * FROM agent_turns WHERE session_id = ? ORDER BY started_at ASC'
    ).all(sessionId) as TurnRow[];
  }

  updateTurnStatus(turnId: string, status: AgentTurnStatus): void {
    this.db.prepare(
      "UPDATE agent_turns SET status = ?, completed_at = CASE WHEN ? IN ('completed','failed','suspended') THEN datetime('now') ELSE NULL END WHERE id = ?"
    ).run(status, status, turnId);
  }

  updateTurnSummary(turnId: string, field: 'plan_summary' | 'assistant_summary', value: string): void {
    this.db.prepare(`UPDATE agent_turns SET ${field} = ? WHERE id = ?`).run(value, turnId);
  }

  updateTurnPendingProposals(turnId: string, proposalIds: string[]): void {
    this.db.prepare('UPDATE agent_turns SET pending_proposal_ids = ? WHERE id = ?')
      .run(JSON.stringify(proposalIds), turnId);
  }

  // =========================================================================
  // agent_working_drafts
  // =========================================================================

  createDraft(sessionId: string, projectId: string, summary: string): string {
    const id = makeId('agent_draft');
    const stmt = this.db.prepare(`
      INSERT INTO agent_working_drafts (id, session_id, project_id, summary)
      VALUES (?, ?, ?, ?)
    `);
    stmt.run(id, sessionId, projectId, summary);
    return id;
  }

  getDraft(draftId: string): DraftRow | undefined {
    return this.db.prepare('SELECT * FROM agent_working_drafts WHERE id = ?').get(draftId) as DraftRow | undefined;
  }

  getDraftsBySession(sessionId: string): DraftRow[] {
    return this.db.prepare(
      'SELECT * FROM agent_working_drafts WHERE session_id = ? ORDER BY updated_at DESC'
    ).all(sessionId) as DraftRow[];
  }

  getActiveDraft(sessionId: string): DraftRow | undefined {
    return this.db.prepare(
      "SELECT * FROM agent_working_drafts WHERE session_id = ? AND status NOT IN ('committed','abandoned') ORDER BY updated_at DESC LIMIT 1"
    ).get(sessionId) as DraftRow | undefined;
  }

  /** 按 ID 获取草案（P3-14: switchDraft 使用） */
  getDraftById(draftId: string): DraftRow | undefined {
    return this.db.prepare(
      'SELECT * FROM agent_working_drafts WHERE id = ?'
    ).get(draftId) as DraftRow | undefined;
  }

  updateDraft(draftId: string, updates: {
    status?: AgentWorkingDraftStatus;
    summary?: string;
    structuredIntent?: unknown;
    proposedChanges?: unknown[];
    proposalId?: string | null;
    revisionCount?: number;
  }): void {
    const parts: string[] = [];
    const values: unknown[] = [];

    if (updates.status !== undefined) { parts.push('status = ?'); values.push(updates.status); }
    if (updates.summary !== undefined) { parts.push('summary = ?'); values.push(updates.summary); }
    if (updates.structuredIntent !== undefined) { parts.push('structured_intent_json = ?'); values.push(JSON.stringify(updates.structuredIntent)); }
    if (updates.proposedChanges !== undefined) { parts.push('proposed_changes_json = ?'); values.push(JSON.stringify(updates.proposedChanges)); }
    if (updates.proposalId !== undefined) { parts.push('proposal_id = ?'); values.push(updates.proposalId); }
    if (updates.revisionCount !== undefined) { parts.push('revision_count = ?'); values.push(updates.revisionCount); }

    parts.push("updated_at = datetime('now')");
    values.push(draftId);

    this.db.prepare(`UPDATE agent_working_drafts SET ${parts.join(', ')} WHERE id = ?`).run(...values);
  }

  // =========================================================================
  // agent_traces
  // =========================================================================

  addTrace(trace: Omit<AgentTraceRecord, 'id' | 'createdAt'>): string {
    const id = makeId('agent_trace');
    const stmt = this.db.prepare(`
      INSERT INTO agent_traces (id, project_id, session_id, turn_id, step_index, step_type, status, summary, detail_json, tool_name, tool_call_id, proposal_id, event_id, error_code, next_action)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      id, trace.projectId, trace.sessionId, trace.turnId, trace.stepIndex,
      trace.stepType, trace.status, trace.summary,
      JSON.stringify(trace.detail ?? {}),
      trace.toolName ?? null, trace.toolCallId ?? null,
      trace.proposalId ?? null, trace.eventId ?? null,
      trace.errorCode ?? null, trace.nextAction ?? null,
    );
    return id;
  }

  getTracesByTurn(turnId: string): AgentTraceRecord[] {
    const rows = this.db.prepare(
      'SELECT * FROM agent_traces WHERE turn_id = ? ORDER BY step_index ASC'
    ).all(turnId) as TraceRow[];
    return rows.map(rowToTrace);
  }

  getTracesBySession(sessionId: string): AgentTraceRecord[] {
    const rows = this.db.prepare(
      'SELECT * FROM agent_traces WHERE session_id = ? ORDER BY created_at ASC'
    ).all(sessionId) as TraceRow[];
    return rows.map(rowToTrace);
  }

  // =========================================================================
  // agent_messages
  // =========================================================================

  addMessage(msg: Omit<AgentMessage, 'id' | 'createdAt'>): string {
    const id = makeId('agent_msg');
    const stmt = this.db.prepare(`
      INSERT INTO agent_messages (id, project_id, session_id, turn_id, role, content, content_summary, tool_call_id, compressed, visible_to_llm)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      id, msg.projectId, msg.sessionId, msg.turnId ?? null,
      msg.role, msg.content, msg.summary, msg.toolCallId ?? null,
      msg.compressed ? 1 : 0, msg.visibleToLlm ? 1 : 0,
    );
    return id;
  }

  getMessagesBySession(sessionId: string): MessageRow[] {
    return this.db.prepare(
      'SELECT * FROM agent_messages WHERE session_id = ? ORDER BY created_at ASC'
    ).all(sessionId) as MessageRow[];
  }

  getMessagesByTurn(turnId: string): MessageRow[] {
    return this.db.prepare(
      'SELECT * FROM agent_messages WHERE turn_id = ? ORDER BY created_at ASC'
    ).all(turnId) as MessageRow[];
  }

  getVisibleMessages(sessionId: string, maxCount?: number): MessageRow[] {
    // P1-2 修复：maxCount 时用子查询 LIMIT 下推到 SQL，避免长会话全表读入内存再 slice
    if (maxCount !== undefined) {
      return this.db.prepare(
        `SELECT * FROM (
          SELECT * FROM agent_messages WHERE session_id = ? AND visible_to_llm = 1
          ORDER BY created_at DESC LIMIT ?
        ) ORDER BY created_at ASC`
      ).all(sessionId, maxCount) as MessageRow[];
    }
    return this.db.prepare(
      'SELECT * FROM agent_messages WHERE session_id = ? AND visible_to_llm = 1 ORDER BY created_at ASC'
    ).all(sessionId) as MessageRow[];
  }

  markMessagesCompressed(messageIds: string[]): void {
    if (messageIds.length === 0) return;
    const placeholders = messageIds.map(() => '?').join(',');
    this.db.prepare(`UPDATE agent_messages SET compressed = 1, visible_to_llm = 0 WHERE id IN (${placeholders})`)
      .run(...messageIds);
  }

  // =========================================================================
  // agent_context_summaries
  // =========================================================================

  addContextSummary(summary: Omit<AgentContextSummary, 'id' | 'createdAt'>): string {
    const id = makeId('agent_summary');
    const stmt = this.db.prepare(`
      INSERT INTO agent_context_summaries (id, project_id, session_id, from_message_id, to_message_id, summary, key_decisions_json, open_questions_json, draft_refs_json, token_estimate)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      id, summary.projectId, summary.sessionId,
      summary.fromMessageId, summary.toMessageId, summary.summary,
      JSON.stringify(summary.keyDecisions),
      JSON.stringify(summary.openQuestions),
      JSON.stringify(summary.draftRefs),
      summary.tokenEstimate ?? null,
    );
    return id;
  }

  getContextSummariesBySession(sessionId: string): ContextSummaryRow[] {
    return this.db.prepare(
      'SELECT * FROM agent_context_summaries WHERE session_id = ? ORDER BY created_at ASC'
    ).all(sessionId) as ContextSummaryRow[];
  }

  // =========================================================================
  // agent_memories
  // =========================================================================

  addMemory(memory: Omit<AgentLongTermMemory, 'id' | 'createdAt' | 'updatedAt'>): string {
    const id = makeId('agent_memory');
    const stmt = this.db.prepare(`
      INSERT INTO agent_memories (id, project_id, kind, summary, detail_json, source_session_id, source_turn_id, confidence, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      id, memory.projectId, memory.kind, memory.summary,
      JSON.stringify(memory.detail),
      memory.sourceSessionId ?? null, memory.sourceTurnId ?? null,
      memory.confidence, memory.status,
    );
    return id;
  }

  getActiveMemories(projectId: string, kind?: AgentMemoryKind): MemoryRow[] {
    if (kind) {
      return this.db.prepare(
        'SELECT * FROM agent_memories WHERE project_id = ? AND kind = ? AND status = ? ORDER BY created_at DESC'
      ).all(projectId, kind, 'active') as MemoryRow[];
    }
    return this.db.prepare(
      'SELECT * FROM agent_memories WHERE project_id = ? AND status = ? ORDER BY created_at DESC'
    ).all(projectId, 'active') as MemoryRow[];
  }

  archiveMemory(memoryId: string): void {
    this.db.prepare(
      "UPDATE agent_memories SET status = 'archived', updated_at = datetime('now') WHERE id = ?"
    ).run(memoryId);
  }
}

// =============================================================================
// 行类型（数据库返回的原始格式）
// =============================================================================

export interface SessionRow {
  id: string;
  project_id: string;
  title: string | null;
  status: string;
  commit_authority: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

export interface TurnRow {
  id: string;
  session_id: string;
  project_id: string;
  user_message_summary: string;
  plan_summary: string | null;
  assistant_summary: string | null;
  status: string;
  pending_proposal_ids: string;
  working_draft_id: string | null;
  started_at: string;
  completed_at: string | null;
}

export interface DraftRow {
  id: string;
  session_id: string;
  project_id: string;
  status: string;
  summary: string;
  structured_intent_json: string;
  proposed_changes_json: string;
  proposal_id: string | null;
  revision_count: number;
  created_at: string;
  updated_at: string;
}

interface TraceRow {
  id: string;
  project_id: string;
  session_id: string;
  turn_id: string;
  step_index: number;
  step_type: string;
  status: string;
  summary: string;
  detail_json: string;
  tool_name: string | null;
  tool_call_id: string | null;
  proposal_id: string | null;
  event_id: string | null;
  error_code: string | null;
  next_action: string | null;
  created_at: string;
}

export interface MessageRow {
  id: string;
  project_id: string;
  session_id: string;
  turn_id: string | null;
  role: string;
  content: string;
  content_summary: string;
  tool_call_id: string | null;
  compressed: number;
  visible_to_llm: number;
  created_at: string;
}

interface ContextSummaryRow {
  id: string;
  project_id: string;
  session_id: string;
  from_message_id: string;
  to_message_id: string;
  summary: string;
  key_decisions_json: string;
  open_questions_json: string;
  draft_refs_json: string;
  token_estimate: number | null;
  created_at: string;
}

interface MemoryRow {
  id: string;
  project_id: string;
  kind: string;
  summary: string;
  detail_json: string;
  source_session_id: string | null;
  source_turn_id: string | null;
  confidence: number;
  status: string;
  created_at: string;
  updated_at: string;
}

// =============================================================================
// 反序列化辅助
// =============================================================================

function rowToTrace(row: TraceRow): AgentTraceRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    sessionId: row.session_id,
    turnId: row.turn_id,
    stepIndex: row.step_index,
    stepType: row.step_type as AgentTraceStepType,
    status: row.status as AgentTraceStatus,
    summary: row.summary,
    detail: safeParseJson(row.detail_json, row.id, 'detail_json'),
    toolName: row.tool_name ?? undefined,
    toolCallId: row.tool_call_id ?? undefined,
    proposalId: row.proposal_id ?? undefined,
    eventId: row.event_id ?? undefined,
    errorCode: row.error_code ?? undefined,
    nextAction: row.next_action ?? undefined,
    createdAt: row.created_at,
  };
}

function safeParseJson(text: string, id: string, field: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`agent-store: JSON 解析失败 — ${field} in record ${id}`);
  }
}

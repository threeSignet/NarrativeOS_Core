// =============================================================================
// AppRegistry —— 全局应用注册表（存储融合阶段2）
// =============================================================================
// 职责：
//   - 管理 data/app.db：项目注册表(app_projects) + 用户表(app_users 预留)
//   - 只存「路径索引 + 双 id 映射 + 归属」，不存业务数据
//     （标题/前提/状态等仍在项目库的 writing_projects，单一真相源）
//   - 提供项目列表/查询/注册/最近打开等操作，供 ProjectManager 与 CLI/BFF 复用
//
// 设计原则（一问一答确认）：
//   - app.db 是全局单例，一个进程一个文件
//   - 用户表本轮只建结构 + 插默认用户 local，不做登录 UI
//   - coreProjectId 与目录名解耦：注册表存 core_project_id，不再从目录名派生
// =============================================================================

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/** app_projects 注册表行 */
export interface AppProjectRecord {
  /** 项目 id（= writingProjectId，wprj_xxx，作主键） */
  id: string;
  /** 项目名（= 目录名，UNIQUE，文件系统键） */
  name: string;
  /** project.db 绝对/相对路径 */
  dbPath: string;
  /** Core 层项目 id（与目录名解耦，Core 表用） */
  coreProjectId: string;
  /** 向量库目录路径 */
  vectorsPath: string;
  /** 归属用户 id（预留，默认 local） */
  ownerUserId: string;
  /** 创建时间（ISO） */
  createdAt: string;
  /** 最近打开时间（ISO，touchLastOpened 更新） */
  lastOpenedAt: string;
}

/** app_users 行（预留） */
export interface AppUserRecord {
  id: string;
  username: string;
  createdAt: string;
}

/** 默认用户（本地单用户场景） */
const DEFAULT_USER_ID = 'local';
const DEFAULT_USER_NAME = 'local';

const APP_DDL = `
CREATE TABLE IF NOT EXISTS app_projects (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL UNIQUE,
  db_path         TEXT NOT NULL,
  core_project_id TEXT NOT NULL,
  vectors_path    TEXT NOT NULL,
  owner_user_id   TEXT NOT NULL DEFAULT 'local',
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  last_opened_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_app_projects_owner ON app_projects(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_app_projects_name ON app_projects(name);

CREATE TABLE IF NOT EXISTS app_users (
  id         TEXT PRIMARY KEY,
  username   TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

export class AppRegistry {
  private db: Database.Database;

  constructor(dbPath?: string) {
    const path = resolve(dbPath ?? process.env.APP_DB ?? './data/app.db');
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(APP_DDL);
    // 幂等插入默认用户（本轮本地单用户）
    this.db.prepare(
      `INSERT OR IGNORE INTO app_users (id, username) VALUES (?, ?)`,
    ).run(DEFAULT_USER_ID, DEFAULT_USER_NAME);
  }

  /** 注册一个项目（id 即 writingProjectId） */
  registerProject(input: {
    id: string;
    name: string;
    dbPath: string;
    coreProjectId: string;
    vectorsPath: string;
    ownerUserId?: string;
  }): AppProjectRecord {
    this.db.prepare(`
      INSERT INTO app_projects (id, name, db_path, core_project_id, vectors_path, owner_user_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      input.id, input.name, input.dbPath, input.coreProjectId,
      input.vectorsPath, input.ownerUserId ?? DEFAULT_USER_ID,
    );
    return this.getProject(input.id)!;
  }

  /** 按 id（writingProjectId）查项目 */
  getProject(id: string): AppProjectRecord | undefined {
    return this.rowToRecord(
      this.db.prepare('SELECT * FROM app_projects WHERE id = ?').get(id) as AppProjectRow | undefined,
    );
  }

  /** 按项目名（目录名）查项目 */
  getProjectByName(name: string): AppProjectRecord | undefined {
    return this.rowToRecord(
      this.db.prepare('SELECT * FROM app_projects WHERE name = ?').get(name) as AppProjectRow | undefined,
    );
  }

  /** 列出全部项目（按最近打开降序） */
  listProjects(): AppProjectRecord[] {
    const rows = this.db.prepare(
      'SELECT * FROM app_projects ORDER BY last_opened_at DESC',
    ).all() as AppProjectRow[];
    return rows.map(r => this.rowToRecord(r)!).filter(Boolean);
  }

  /** 更新最近打开时间 */
  touchLastOpened(id: string): void {
    this.db.prepare(
      `UPDATE app_projects SET last_opened_at = datetime('now') WHERE id = ?`,
    ).run(id);
  }

  /** 删除项目注册（不删文件，仅清注册表） */
  unregisterProject(id: string): void {
    this.db.prepare('DELETE FROM app_projects WHERE id = ?').run(id);
  }

  /** 取默认用户（本轮本地单用户） */
  getDefaultUser(): AppUserRecord {
    return this.db.prepare('SELECT * FROM app_users WHERE id = ?').get(DEFAULT_USER_ID) as AppUserRecord;
  }

  /** 关闭连接 */
  close(): void {
    this.db.close();
  }

  /** 裸行 → record（snake_case → camelCase） */
  private rowToRecord(row: AppProjectRow | undefined): AppProjectRecord | undefined {
    if (!row) return undefined;
    return {
      id: row.id,
      name: row.name,
      dbPath: row.db_path,
      coreProjectId: row.core_project_id,
      vectorsPath: row.vectors_path,
      ownerUserId: row.owner_user_id,
      createdAt: row.created_at,
      lastOpenedAt: row.last_opened_at,
    };
  }
}

/** app_projects 原始行（snake_case） */
interface AppProjectRow {
  id: string;
  name: string;
  db_path: string;
  core_project_id: string;
  vectors_path: string;
  owner_user_id: string;
  created_at: string;
  last_opened_at: string;
}

/** 按 dbPath 缓存的单例（同一 app.db 路径复用，不同路径各自独立） */
const _registries = new Map<string, AppRegistry>();
export function getAppRegistry(dbPath?: string): AppRegistry {
  const key = dbPath ?? '__default__';
  let r = _registries.get(key);
  if (!r) {
    r = new AppRegistry(dbPath);
    _registries.set(key, r);
  }
  return r;
}

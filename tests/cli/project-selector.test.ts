// =============================================================================
// 项目选择器测试（project-selector.ts 的纯函数）
// =============================================================================
// 覆盖：项目扫描、名称校验、记住上次、旧库迁移、目录创建。
// 不测 readline 交互（selectProject/promptNewProject 涉及 stdin，纯函数层足够）。
// =============================================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  listProjects, readLastProject, writeLastProject, isValidProjectName,
  migrateLegacyDb, ensureProjectDir, readLegacyProjects,
} from '../../src/cli/project-selector.js';

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'proj-sel-'));
});

afterEach(() => {
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
});

/** 在 dataDir/projects/<name>/ 下造一个 cli.db（模拟已有项目） */
function makeFakeProject(name: string): void {
  const dir = join(dataDir, 'projects', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'cli.db'), 'fake'); // 占位文件（listProjects 只检查存在性）
}

describe('listProjects（扫描项目目录）', () => {
  it('无 projects 目录返回空数组', () => {
    expect(listProjects(dataDir)).toEqual([]);
  });

  it('列出含 cli.db 的项目目录（按名称 Unicode 排序）', () => {
    makeFakeProject('灰域科幻');
    makeFakeProject('修仙录');
    // sort() 按 Unicode：修(U+4FEE) < 灰(U+7070)，故修仙录在前
    expect(listProjects(dataDir)).toEqual(['修仙录', '灰域科幻']);
  });

  it('忽略无 cli.db 的空目录', () => {
    makeFakeProject('真项目');
    mkdirSync(join(dataDir, 'projects', '空目录'), { recursive: true }); // 无 cli.db
    expect(listProjects(dataDir)).toEqual(['真项目']);
  });

  it('忽略 lancedb 子目录（不是项目）', () => {
    makeFakeProject('项目A');
    mkdirSync(join(dataDir, 'projects', '项目A', 'lancedb'), { recursive: true });
    expect(listProjects(dataDir)).toEqual(['项目A']); // lancedb 在项目A内部，不重复
  });
});

describe('isValidProjectName（名称校验）', () => {
  it('合法名称通过', () => {
    expect(isValidProjectName('灰域科幻')).toBe(true);
    expect(isValidProjectName('My Novel 2024')).toBe(true);
    expect(isValidProjectName('a')).toBe(true);
  });

  it('拒绝空名', () => {
    expect(isValidProjectName('')).toBe(false);
    expect(isValidProjectName('   ')).toBe(false);
  });

  it('拒绝路径分隔符（防注入）', () => {
    expect(isValidProjectName('a/b')).toBe(false);
    expect(isValidProjectName('a\\b')).toBe(false);
  });

  it('拒绝 .. 穿越', () => {
    expect(isValidProjectName('..')).toBe(false);
    expect(isValidProjectName('../etc')).toBe(false);
    expect(isValidProjectName('a/../b')).toBe(false);
  });

  it('拒绝以点开头（防隐藏文件）', () => {
    expect(isValidProjectName('.hidden')).toBe(false);
  });

  it('拒绝 Windows 非法字符', () => {
    expect(isValidProjectName('a:b')).toBe(false);
    expect(isValidProjectName('a*b')).toBe(false);
    expect(isValidProjectName('a?b')).toBe(false);
    expect(isValidProjectName('a"b')).toBe(false);
  });

  it('拒绝超长名称', () => {
    expect(isValidProjectName('x'.repeat(101))).toBe(false);
  });
});

describe('readLastProject / writeLastProject（记住上次）', () => {
  it('无记录返回 undefined', () => {
    expect(readLastProject(dataDir)).toBeUndefined();
  });

  it('写入后能读回', () => {
    writeLastProject(dataDir, '灰域科幻');
    expect(readLastProject(dataDir)).toBe('灰域科幻');
  });

  it('空内容记录返回 undefined', () => {
    writeFileSync(join(dataDir, '.current-project'), '   \n');
    expect(readLastProject(dataDir)).toBeUndefined();
  });
});

describe('ensureProjectDir（创建项目目录）', () => {
  it('创建 projects/<name>/ 和 lancedb/ 子目录', () => {
    const dir = ensureProjectDir(dataDir, '新项目');
    expect(existsSync(dir)).toBe(true);
    expect(existsSync(join(dir, 'lancedb'))).toBe(true);
  });

  it('非法名称抛错', () => {
    expect(() => ensureProjectDir(dataDir, '../bad')).toThrow();
    expect(() => ensureProjectDir(dataDir, '')).toThrow();
  });

  it('已存在目录幂等（不报错）', () => {
    ensureProjectDir(dataDir, '项目');
    expect(() => ensureProjectDir(dataDir, '项目')).not.toThrow();
  });
});

describe('migrateLegacyDb（旧库迁移）', () => {
  it('复制旧库为新项目的 cli.db + 建 lancedb', () => {
    // 造旧库
    const legacyDb = join(dataDir, 'cli-project.db');
    writeFileSync(legacyDb, 'legacy content');
    writeFileSync(legacyDb + '-wal', 'wal content');

    migrateLegacyDb(dataDir, '迁移项目');

    const targetDb = join(dataDir, 'projects', '迁移项目', 'cli.db');
    expect(existsSync(targetDb)).toBe(true);
    expect(existsSync(join(dataDir, 'projects', '迁移项目', 'lancedb'))).toBe(true);
    // 内容正确复制
    expect(copyFileContent(targetDb)).toBe('legacy content');
    // wal 也复制
    expect(existsSync(targetDb + '-wal')).toBe(true);
  });

  it('旧库不存在抛错', () => {
    expect(() => migrateLegacyDb(dataDir, '项目')).toThrow(/旧库不存在/);
  });

  it('迁移后旧库保留（不删除）', () => {
    const legacyDb = join(dataDir, 'cli-project.db');
    writeFileSync(legacyDb, 'legacy');
    migrateLegacyDb(dataDir, '迁移');
    expect(existsSync(legacyDb)).toBe(true); // 旧库仍在
  });
});

/** 读取文件内容（测试辅助） */
function copyFileContent(path: string): string {
  return readFileSync(path, 'utf-8');
}

describe('readLegacyProjects（读旧库项目名）', () => {
  it('非 sqlite 文件返回空数组', () => {
    const fakeDb = join(dataDir, 'cli-project.db');
    writeFileSync(fakeDb, 'not a database');
    expect(readLegacyProjects(fakeDb)).toEqual([]);
  });

  it('不存在的文件返回空数组（不抛错）', () => {
    expect(readLegacyProjects(join(dataDir, 'nope.db'))).toEqual([]);
  });

  it('能读出旧库里的项目列表', () => {
    // 用真实 SQLite 造一个含项目的旧库
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require('better-sqlite3');
    const dbPath = join(dataDir, 'cli-project.db');
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE writing_projects (
        id TEXT PRIMARY KEY, title TEXT, premise TEXT, status TEXT,
        workspace_mode TEXT, active_blueprint_id TEXT, current_draft_id TEXT,
        source_refs_json TEXT, version INTEGER, created_at TEXT, updated_at TEXT, deleted_at TEXT
      );
    `);
    db.prepare("INSERT INTO writing_projects (id, title, status, workspace_mode, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run('wprj_1', '灰域科幻', 'planning', 'planning', 1, '2026-01-01', '2026-01-02');
    db.prepare("INSERT INTO writing_projects (id, title, status, workspace_mode, version, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run('wprj_2', '已删除项目', 'archived', 'planning', 1, '2026-01-01', '2026-01-02', '2026-01-03');
    db.close();

    const projects = readLegacyProjects(dbPath);
    expect(projects).toHaveLength(1); // deleted_at 不为空的被过滤
    expect(projects[0]!.title).toBe('灰域科幻');
    expect(projects[0]!.status).toBe('planning');
  });
});

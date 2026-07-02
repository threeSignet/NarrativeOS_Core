// =============================================================================
// ProjectManager 测试（存储融合层 src/session/project-manager.ts）
// =============================================================================
// 覆盖：项目名校验、创建项目（建目录+装配+写 app.db）、列出项目、打开项目、
// 注册表读写、目录与 db 文件落地。用临时目录隔离，每个测试独立 app.db + projects/。
// =============================================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { isValidProjectName, ProjectManager } from '../../src/session/project-manager.js';

let dataDir: string;
let mgr: ProjectManager;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'pm-test-'));
  // 每个测试用独立的 ProjectManager（独立 app.db）；不复用全局单例
  mgr = new ProjectManager(dataDir);
});

afterEach(() => {
  try { mgr.closeAll(); } catch { /* 忽略 */ }
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
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

describe('createProject（创建项目）', () => {
  it('建项目：目录 + project.db + app.db 注册', () => {
    const { session, record } = mgr.createProject({ name: '测试作品', title: '测试作品' });
    expect(record.name).toBe('测试作品');
    expect(record.id).toMatch(/^wprj_/);
    expect(record.coreProjectId).toBe(`core_${record.id}`);
    // 目录与 db 文件落地
    expect(existsSync(join(dataDir, 'projects', '测试作品', 'project.db'))).toBe(true);
    // session 装配完成，writingProjectId 就绪
    expect(session.writingProjectId).toBe(record.id);
  });

  it('重复名抛错', () => {
    mgr.createProject({ name: '作品A' });
    expect(() => mgr.createProject({ name: '作品A' })).toThrow(/已存在/);
  });

  it('非法名抛错', () => {
    expect(() => mgr.createProject({ name: '../bad' })).toThrow(/非法/);
    expect(() => mgr.createProject({ name: '' })).toThrow(/非法/);
    expect(() => mgr.createProject({ name: 'a:b' })).toThrow(/非法/);
  });

  it('createProject 后能查到（listProjects / getProject / getProjectByName）', () => {
    mgr.createProject({ name: '查得到' });
    expect(mgr.listProjects()).toHaveLength(1);
    expect(mgr.getProjectByName('查得到')).toBeDefined();
    // getProject 用 writingProjectId
    const r = mgr.getProjectByName('查得到')!;
    expect(mgr.getProject(r.id)).toBeDefined();
  });
});

describe('listProjects（列出项目）', () => {
  it('初始空', () => {
    expect(mgr.listProjects()).toHaveLength(0);
  });

  it('列出全部已注册项目', () => {
    mgr.createProject({ name: '作品一' });
    mgr.createProject({ name: '作品二' });
    mgr.createProject({ name: '作品三' });
    const names = mgr.listProjects().map(r => r.name).sort();
    expect(names).toEqual(['作品一', '作品三', '作品二']);
  });
});

describe('openProject（打开项目）', () => {
  it('打开已创建项目，session 装配完整', async () => {
    const { record } = mgr.createProject({ name: '可打开' });
    const session = await mgr.openProject('可打开', { withVector: false, withAgent: false });
    expect(session.writingProjectId).toBe(record.id);
    // session 关键字段就绪
    expect(session.writingStore).toBeDefined();
    expect(session.documentService).toBeDefined();
    expect(session.coreBridge).toBeDefined();
    expect(session.toolRouter).toBeDefined();
  });

  it('按 id 打开（不只用 name）', async () => {
    const { record } = mgr.createProject({ name: '按ID' });
    const session = await mgr.openProject(record.id, { withVector: false, withAgent: false });
    expect(session.writingProjectId).toBe(record.id);
  });

  it('不存在的项目抛错', async () => {
    await expect(mgr.openProject('不存在', { withVector: false, withAgent: false }))
      .rejects.toThrow(/不存在/);
  });

  it('重复打开复用缓存 session（同一引用）', async () => {
    mgr.createProject({ name: '复用' });
    const s1 = await mgr.openProject('复用', { withVector: false, withAgent: false });
    const s2 = await mgr.openProject('复用', { withVector: false, withAgent: false });
    expect(s1).toBe(s2);
  });
});

describe('端到端：建项目 → 建文档 → 重开读到', () => {
  it('文档持久化到 project.db，重开 session 可读', async () => {
    const { record } = mgr.createProject({ name: '持久化测试' });
    const s1 = await mgr.openProject('持久化测试', { withVector: false, withAgent: false });
    const doc = s1.documentService.createDocument(s1.makeCtx(), { parentId: null, title: '测试文档' });
    expect(doc.id).toMatch(/^wdoc_/);

    // 关掉再重开（清缓存模拟新进程）
    mgr.closeAll();
    // 重建 manager 用同一 dataDir（同一 app.db + project.db）
    const mgr2 = new ProjectManager(dataDir);
    const s2 = await mgr2.openProject('持久化测试', { withVector: false, withAgent: false });
    const docs = s2.writingStore.listDocuments(record.id);
    expect(docs).toHaveLength(1);
    expect(docs[0]!.title).toBe('测试文档');
    mgr2.closeAll();
  });
});

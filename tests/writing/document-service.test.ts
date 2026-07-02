// =============================================================================
// 起草工作台测试：DocumentService（设定集文档树）
// =============================================================================

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { SQLiteWritingStore } from '../../src/writing/repositories/writing-store.js';
import { AuditService } from '../../src/writing/services/audit-service.js';
import { DocumentService } from '../../src/writing/services/document-service.js';
import { makeRequestContext } from '../../src/writing/services/context.js';
import type { WritingRequestContext } from '../../src/writing/services/context.js';
import { WritingError } from '../../src/writing/errors/error-codes.js';

describe('起草工作台 · DocumentService', () => {
  let store: SQLiteWritingStore;
  let documentService: DocumentService;
  let ctx: WritingRequestContext;
  let projectId: string;

  beforeEach(() => {
    const db = new Database(':memory:');
    store = new SQLiteWritingStore(db);
    store.createTables();
    const auditService = new AuditService(store);
    documentService = new DocumentService(store, auditService);
    projectId = store.createProject('设定集测试').id;
    ctx = makeRequestContext({ projectId, trigger: 'author_action' });
  });

  // ---------- 创建 ----------
  it('创建文件夹节点', () => {
    const folder = documentService.createFolder(ctx, { parentId: null, title: '世界观' });
    expect(folder.id).toMatch(/^wdoc_/);
    expect(folder.kind).toBe('folder');
    expect(folder.title).toBe('世界观');
    expect(folder.parentId).toBeNull();
    expect(folder.sortOrder).toBe(0);
    expect(folder.template).toBe('freeform');
  });

  it('创建文档节点', () => {
    const folder = documentService.createFolder(ctx, { parentId: null, title: '角色' });
    const doc = documentService.createDocument(ctx, {
      parentId: folder.id, title: '沈墨', tags: ['主角'],
    });
    expect(doc.kind).toBe('document');
    expect(doc.title).toBe('沈墨');
    expect(doc.parentId).toBe(folder.id);
    expect(doc.template).toBe('freeform');
    expect(doc.contentFormat).toBe('tiptap');
    expect(doc.tags).toEqual(['主角']);
    expect(doc.sortOrder).toBe(0);
    // 新建空文档字数为 0
    expect(doc.wordCount).toBe(0);
  });

  it('同级自动递增 sortOrder', () => {
    documentService.createFolder(ctx, { parentId: null, title: 'A' });
    documentService.createFolder(ctx, { parentId: null, title: 'B' });
    documentService.createFolder(ctx, { parentId: null, title: 'C' });
    const tree = documentService.listTree(ctx);
    const sortOrders = tree.map(d => d.sortOrder);
    expect(sortOrders).toEqual([0, 1, 2]);
  });

  // ---------- 列表 ----------
  it('listTree 返回项目下全部文档', () => {
    documentService.createFolder(ctx, { parentId: null, title: 'F1' });
    documentService.createFolder(ctx, { parentId: null, title: 'F2' });
    const tree = documentService.listTree(ctx);
    expect(tree).toHaveLength(2);
  });

  // ---------- 内容更新 ----------
  it('更新富文本内容并自动算字数', () => {
    const doc = documentService.createDocument(ctx, { parentId: null, title: 'D' });
    const updated = documentService.updateContent(ctx, doc.id, doc.version, '<p>沈墨独自站在青云峰顶</p>');
    expect(updated.version).toBe(2);
    expect(updated.content).toBe('<p>沈墨独自站在青云峰顶</p>');
    // 去标签去空白后的字符数
    expect(updated.wordCount).toBeGreaterThan(0);
  });

  it('内容更新带乐观锁，过期版本抛错', () => {
    const doc = documentService.createDocument(ctx, { parentId: null, title: 'D' });
    documentService.updateContent(ctx, doc.id, doc.version, 'v1');
    // 用旧 version 再更新应失败
    expect(() => documentService.updateContent(ctx, doc.id, doc.version, 'v2')).toThrow(WritingError);
  });

  // ---------- 改名 ----------
  it('改名', () => {
    const doc = documentService.createDocument(ctx, { parentId: null, title: '旧名' });
    const updated = documentService.rename(ctx, doc.id, doc.version, '新名');
    expect(updated.title).toBe('新名');
    expect(updated.version).toBe(2);
  });

  // ---------- 移动 ----------
  it('移动文档到另一文件夹', () => {
    const f1 = documentService.createFolder(ctx, { parentId: null, title: 'F1' });
    const f2 = documentService.createFolder(ctx, { parentId: null, title: 'F2' });
    const doc = documentService.createDocument(ctx, { parentId: f1.id, title: 'D' });
    const moved = documentService.move(ctx, doc.id, doc.version, f2.id);
    expect(moved.parentId).toBe(f2.id);
  });

  it('移入自身抛错（防循环）', () => {
    const folder = documentService.createFolder(ctx, { parentId: null, title: 'F' });
    expect(() => documentService.move(ctx, folder.id, folder.version, folder.id)).toThrow(WritingError);
  });

  it('移入自身后代抛错（防循环）', () => {
    const root = documentService.createFolder(ctx, { parentId: null, title: '根' });
    const child = documentService.createFolder(ctx, { parentId: root.id, title: '子' });
    // 把 root 移入 child（child 是 root 的后代）应失败
    expect(() => documentService.move(ctx, root.id, root.version, child.id)).toThrow(WritingError);
  });

  it('移入非文件夹（普通文档）抛错', () => {
    const target = documentService.createDocument(ctx, { parentId: null, title: '我是个文档' });
    const doc = documentService.createDocument(ctx, { parentId: null, title: 'D' });
    expect(() => documentService.move(ctx, doc.id, doc.version, target.id)).toThrow(WritingError);
  });

  // ---------- 重排 ----------
  it('同级重排生效', () => {
    const a = documentService.createFolder(ctx, { parentId: null, title: 'A' });
    const b = documentService.createFolder(ctx, { parentId: null, title: 'B' });
    const c = documentService.createFolder(ctx, { parentId: null, title: 'C' });
    // 原序 A B C，重排为 C A B
    documentService.reorder(ctx, null, [c.id, a.id, b.id]);
    const tree = documentService.listTree(ctx);
    expect(tree.map(d => d.title)).toEqual(['C', 'A', 'B']);
    expect(tree.map(d => d.sortOrder)).toEqual([0, 1, 2]);
  });

  // ---------- 归档 ----------
  it('归档单个文档', () => {
    const doc = documentService.createDocument(ctx, { parentId: null, title: 'D' });
    documentService.archive(ctx, doc.id);
    const tree = documentService.listTree(ctx);
    expect(tree).toHaveLength(0);
  });

  it('归档文件夹级联归档全部后代', () => {
    const root = documentService.createFolder(ctx, { parentId: null, title: '根' });
    const child = documentService.createFolder(ctx, { parentId: root.id, title: '子' });
    documentService.createDocument(ctx, { parentId: child.id, title: '孙1' });
    documentService.createDocument(ctx, { parentId: child.id, title: '孙2' });
    documentService.createDocument(ctx, { parentId: root.id, title: '子文档' });

    documentService.archive(ctx, root.id);
    const tree = documentService.listTree(ctx);
    expect(tree).toHaveLength(0);
  });

  // ---------- 项目隔离 ----------
  it('不能访问其他项目的文档', () => {
    const doc = documentService.createDocument(ctx, { parentId: null, title: 'D' });
    // 另一个项目的 ctx
    const otherProjectId = store.createProject('其他项目').id;
    const otherCtx = makeRequestContext({ projectId: otherProjectId, trigger: 'author_action' });
    expect(() => documentService.getDocument(otherCtx, doc.id)).toThrow(WritingError);
  });
});

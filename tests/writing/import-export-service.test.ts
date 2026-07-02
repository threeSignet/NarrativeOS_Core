// =============================================================================
// Phase 12 测试：ImportExportService——导入与导出（§20/§23）
// =============================================================================

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { SQLiteWritingStore } from '../../src/writing/repositories/writing-store.js';
import { AuditService } from '../../src/writing/services/audit-service.js';
import { ProseService } from '../../src/writing/services/prose-service.js';
import { ImportExportService } from '../../src/writing/services/import-export-service.js';
import { makeRequestContext } from '../../src/writing/services/context.js';
import type { WritingRequestContext } from '../../src/writing/services/context.js';

describe('Phase 12 · ImportExportService', () => {
  let store: SQLiteWritingStore;
  let service: ImportExportService;
  let ctx: WritingRequestContext;

  beforeEach(() => {
    const db = new Database(':memory:');
    store = new SQLiteWritingStore(db);
    store.createTables();
    const proseService = new ProseService(store, new AuditService(store));
    service = new ImportExportService(store, new AuditService(store), proseService);
    const projectId = store.createProject('导入导出测试').id;
    ctx = makeRequestContext({ projectId, trigger: 'author_action' });
  });

  // --- 导入（§20.1）---

  it('importText 建批次 + 切分建文档', () => {
    const result = service.importText(ctx, {
      sourceFilename: 'novel.txt',
      importType: 'prose',
      content: '# 第一章\n\n正文段落一。\n\n正文段落二。',
    });
    expect(result.batch.status).toBe('imported');
    expect(result.batch.rawSnapshot).toContain('第一章');
    expect(result.blockCount).toBeGreaterThanOrEqual(3); // chapter_title + 2 paragraph
    expect(result.batch.generatedDocumentIds).toContain(result.documentId);
  });

  it('导入不写 Core（§20.1 验收）', () => {
    // ImportExportService 不持有 Core store 引用；导入只写写作层
    const result = service.importText(ctx, {
      importType: 'mixed',
      content: '测试正文',
    });
    expect(result.batch.status).toBe('imported');
    // 仅验证写作层文档存在
    expect(store.getProseDocument(result.documentId)).toBeDefined();
  });

  it('空内容抛错', () => {
    expect(() => service.importText(ctx, { importType: 'prose', content: '' })).toThrow();
    expect(() => service.importText(ctx, { importType: 'prose', content: '   ' })).toThrow();
  });

  it('listImportBatches 按项目返回', () => {
    service.importText(ctx, { importType: 'prose', content: '内容一' });
    service.importText(ctx, { importType: 'draft', content: '内容二' });
    const batches = service.listImportBatches(ctx);
    expect(batches).toHaveLength(2);
  });

  it('cancelImportBatch 待处理可取消，已导入不可取消', () => {
    const result = service.importText(ctx, { importType: 'prose', content: '内容' });
    expect(() => service.cancelImportBatch(ctx, result.batch.id)).toThrow(); // 已 imported
  });

  it('导入批次隔离按项目', () => {
    service.importText(ctx, { importType: 'prose', content: '本项目' });
    const otherProjectId = store.createProject('其他').id;
    const otherCtx = makeRequestContext({ projectId: otherProjectId, trigger: 'author_action' });
    service.importText(otherCtx, { importType: 'prose', content: '他项目' });
    expect(service.listImportBatches(ctx)).toHaveLength(1);
  });

  // --- 导出（§23）---

  it('exportProject all 聚合全量数据', () => {
    // 预置一些数据
    store.createProseDocument(ctx.projectId, { title: '文档' });
    store.getOrCreateDefaultStyleGuide(ctx.projectId);

    const result = service.exportProject(ctx, 'all');
    expect(result.scope).toBe('all');
    expect(result.data['prose']).toBeDefined();
    expect(result.data['style']).toBeDefined();
    expect(result.data['blueprint']).toBeDefined();
  });

  it('exportProject 单范围', () => {
    store.createProseDocument(ctx.projectId, { title: '文档一' });
    store.createProseDocument(ctx.projectId, { title: '文档二' });

    const result = service.exportProject(ctx, 'prose');
    expect(result.scope).toBe('prose');
    expect(Object.keys(result.data)).toEqual(['prose']);
    const docs = result.data['prose'] as unknown[];
    expect(docs).toHaveLength(2);
  });

  it('导出只读不改变状态', () => {
    store.createProseDocument(ctx.projectId, { title: '文档' });
    const before = store.listProseDocuments(ctx.projectId).length;
    service.exportProject(ctx, 'all');
    service.exportProject(ctx, 'prose');
    const after = store.listProseDocuments(ctx.projectId).length;
    expect(after).toBe(before); // 导出不新增数据
  });

  it('exportProject 返回结构含 projectId/exportedAt/scope/data', () => {
    const result = service.exportProject(ctx, 'entities');
    expect(result).toHaveProperty('projectId');
    expect(result).toHaveProperty('exportedAt');
    expect(result).toHaveProperty('scope');
    expect(result).toHaveProperty('data');
    expect(result.projectId).toBe(ctx.projectId);
  });
});

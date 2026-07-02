// =============================================================================
// Phase 12 测试：ProseService——块级正文模型（§13.8）
// =============================================================================

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { SQLiteWritingStore } from '../../src/writing/repositories/writing-store.js';
import { AuditService } from '../../src/writing/services/audit-service.js';
import { ProseService, splitMarkdownToBlocks } from '../../src/writing/services/prose-service.js';
import { makeRequestContext } from '../../src/writing/services/context.js';
import type { WritingRequestContext } from '../../src/writing/services/context.js';

describe('Phase 12 · ProseService', () => {
  let store: SQLiteWritingStore;
  let service: ProseService;
  let ctx: WritingRequestContext;

  beforeEach(() => {
    const db = new Database(':memory:');
    store = new SQLiteWritingStore(db);
    store.createTables();
    service = new ProseService(store, new AuditService(store));
    const projectId = store.createProject('正文测试').id;
    ctx = makeRequestContext({ projectId, trigger: 'author_action' });
  });

  it('创建文档并追加块，order_index 连续递增', () => {
    const doc = service.createDocument(ctx, { title: '第一章' });
    const b1 = service.addBlock(ctx, { documentId: doc.id, kind: 'chapter_title', text: '第一章 序幕' });
    const b2 = service.addBlock(ctx, { documentId: doc.id, kind: 'paragraph', text: '夜色如墨。' });
    const b3 = service.addBlock(ctx, { documentId: doc.id, kind: 'paragraph', text: '他推开门。' });

    expect(b1.orderIndex).toBe(0);
    expect(b2.orderIndex).toBe(1);
    expect(b3.orderIndex).toBe(2);

    const { blocks } = service.getDocumentWithBlocks(ctx, doc.id);
    expect(blocks).toHaveLength(3);
    expect(blocks.map(b => b.orderIndex)).toEqual([0, 1, 2]);
  });

  it('结构变更 bump versionId（锚点失效依据）', () => {
    const doc = service.createDocument(ctx, { title: '文档' });
    const originalVersionId = doc.versionId;
    service.addBlock(ctx, { documentId: doc.id, kind: 'paragraph', text: '段落一' });

    const refreshed = store.getProseDocument(doc.id)!;
    expect(refreshed.versionId).not.toBe(originalVersionId);
    expect(refreshed.version).toBe(2);
  });

  it('移动块后 order_index 重排保持连续', () => {
    const doc = service.createDocument(ctx, { title: '文档' });
    const b1 = service.addBlock(ctx, { documentId: doc.id, kind: 'paragraph', text: 'A' });
    const b2 = service.addBlock(ctx, { documentId: doc.id, kind: 'paragraph', text: 'B' });
    const b3 = service.addBlock(ctx, { documentId: doc.id, kind: 'paragraph', text: 'C' });

    // 把 B（orderIndex=1）移到末尾（targetOrderIndex=2）
    service.moveBlock(ctx, b2.id, 2);
    const { blocks } = service.getDocumentWithBlocks(ctx, doc.id);
    expect(blocks.map(b => b.text)).toEqual(['A', 'C', 'B']);
    expect(blocks.map(b => b.orderIndex)).toEqual([0, 1, 2]);
  });

  it('删除块后重排剩余块 order_index', () => {
    const doc = service.createDocument(ctx, { title: '文档' });
    service.addBlock(ctx, { documentId: doc.id, kind: 'paragraph', text: 'A' });
    const b2 = service.addBlock(ctx, { documentId: doc.id, kind: 'paragraph', text: 'B' });
    service.addBlock(ctx, { documentId: doc.id, kind: 'paragraph', text: 'C' });

    service.deleteBlock(ctx, b2.id);
    const { blocks } = service.getDocumentWithBlocks(ctx, doc.id);
    expect(blocks.map(b => b.text)).toEqual(['A', 'C']);
    expect(blocks.map(b => b.orderIndex)).toEqual([0, 1]);
  });

  it('跨项目访问被拒绝', () => {
    const doc = service.createDocument(ctx, { title: '本项目文档' });
    const otherProjectId = store.createProject('其他项目').id;
    const otherCtx = makeRequestContext({ projectId: otherProjectId, trigger: 'author_action' });
    expect(() => service.getDocumentWithBlocks(otherCtx, doc.id)).toThrow();
  });

  it('ingestText 按 Markdown 切分为块', () => {
    const doc = service.createDocument(ctx, { title: '导入' });
    const text = '# 章节标题\n\n第一段文字。\n\n第二段文字。\n\n## 场景\n\n第三段。';
    const { addedCount } = service.ingestText(ctx, doc.id, text);
    // chapter_title + 2 paragraph + scene_heading + 1 paragraph = 5
    expect(addedCount).toBe(5);
    const { blocks } = service.getDocumentWithBlocks(ctx, doc.id);
    const kinds = blocks.map(b => b.kind);
    expect(kinds).toContain('chapter_title');
    expect(kinds).toContain('scene_heading');
    expect(kinds.filter(k => k === 'paragraph').length).toBe(3);
  });
});

describe('Phase 12 · splitMarkdownToBlocks（纯函数）', () => {
  it('识别 # 标题为 chapter_title', () => {
    const blocks = splitMarkdownToBlocks('# 序章\n\n正文');
    expect(blocks[0]).toMatchObject({ kind: 'chapter_title', text: '序章' });
    expect(blocks[1]).toMatchObject({ kind: 'paragraph' });
  });

  it('识别 ## 标题为 scene_heading', () => {
    const blocks = splitMarkdownToBlocks('## 黎明\n\n内容');
    expect(blocks[0]).toMatchObject({ kind: 'scene_heading', text: '黎明' });
  });

  it('识别 *** / --- 为 separator', () => {
    expect(splitMarkdownToBlocks('A\n\n***\n\nB')[1]!.kind).toBe('separator');
    expect(splitMarkdownToBlocks('A\n\n---\n\nB')[1]!.kind).toBe('separator');
  });

  it('识别 > 注释为 note', () => {
    const blocks = splitMarkdownToBlocks('> 这是作者注释');
    expect(blocks[0]).toMatchObject({ kind: 'note', text: '这是作者注释' });
  });

  it('连续非空行合并为同一段落', () => {
    const blocks = splitMarkdownToBlocks('第一行\n第二行\n第三行');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.text).toBe('第一行\n第二行\n第三行');
  });

  it('空行分段', () => {
    const blocks = splitMarkdownToBlocks('段一\n\n段二');
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.text).toBe('段一');
    expect(blocks[1]!.text).toBe('段二');
  });
});

// =============================================================================
// Phase 12 · ProseService——块级正文的业务逻辑（§13.8）
// =============================================================================
// 职责：
//   - 正文文档（ProseDocument）的创建/查询/删除
//   - 正文块（ProseBlock）的增/改/移动/删除，维护 order_index 连续性
//   - 结构变更时 bump versionId（正文锚点失效判断依据）
//
// 核心不变式（Feature-Spec §13.8）：
//   - 正文文档模型不写 Core（Core 不保存正文块结构）
//   - 每个段落都有稳定 blockId（用于锚点、版本对比、候选来源引用）
//   - 删除或移动段落不会悄悄提交 Core
//   - 纯文本操作，不做 AI 扩写/改写（生成能力留给前端会话或后续 phase）
//
// 与 ChapterService 范式一致：构造注入 store + audit，方法首参 ctx，更新记审计。
// =============================================================================

import type { SQLiteWritingStore } from '../repositories/writing-store.js';
import type { AuditService } from './audit-service.js';
import type { WritingRequestContext } from './context.js';
import { WritingError, WritingErrorCode } from '../errors/error-codes.js';
import type {
  ProseDocument, ProseBlock, ProseBlockKind, ProseDocumentMode,
} from '../models/types.js';

/** 文档 + 块的聚合视图（一次查询拿全） */
export interface ProseDocumentWithBlocks {
  document: ProseDocument;
  blocks: ProseBlock[];
}

export class ProseService {
  constructor(
    private store: SQLiteWritingStore,
    private audit: AuditService,
  ) {}

  /** 创建正文文档 */
  createDocument(
    ctx: WritingRequestContext,
    input: { title: string; draftId?: string },
  ): ProseDocument {
    const doc = this.store.createProseDocument(ctx.projectId, { title: input.title, draftId: input.draftId });
    this.audit.record(ctx, {
      action: 'create_prose_document', targetType: 'prose_document',
      targetId: doc.id, result: 'success',
      detail: { title: doc.title, draftId: input.draftId },
    });
    return doc;
  }

  /** 获取文档 + 全部块（按 order_index 排序） */
  getDocumentWithBlocks(ctx: WritingRequestContext, documentId: string): ProseDocumentWithBlocks {
    const document = this.store.getProseDocument(documentId);
    if (!document) throw new WritingError(WritingErrorCode.WRITING_OBJECT_NOT_FOUND, `正文文档不存在: ${documentId}`);
    if (document.projectId !== ctx.projectId) throw new WritingError(WritingErrorCode.WRITING_OBJECT_NOT_FOUND, `正文文档不属于当前项目: ${documentId}`);
    const blocks = this.store.getProseBlocks(documentId);
    return { document, blocks };
  }

  /** 列出项目所有文档（不含块，仅概览） */
  listDocuments(ctx: WritingRequestContext): ProseDocument[] {
    return this.store.listProseDocuments(ctx.projectId);
  }

  /** 更新文档元信息（标题/模式/关联草案） */
  updateDocument(
    ctx: WritingRequestContext,
    id: string,
    updates: Partial<{ title: string; mode: ProseDocumentMode; draftId: string }>,
  ): void {
    const doc = this.store.getProseDocument(id);
    if (!doc) throw new WritingError(WritingErrorCode.WRITING_OBJECT_NOT_FOUND, `正文文档不存在: ${id}`);
    this.store.updateProseDocument(id, updates);
    this.audit.record(ctx, {
      action: 'update_prose_document', targetType: 'prose_document',
      targetId: id, result: 'success', detail: { fields: Object.keys(updates) },
    });
  }

  /** 追加一个块到文档末尾 */
  addBlock(
    ctx: WritingRequestContext,
    input: { documentId: string; kind: ProseBlockKind; text: string; sceneId?: string; sourceRefs?: string[] },
  ): ProseBlock {
    this.assertDocumentInProject(ctx, input.documentId);
    const block = this.store.addProseBlock(input);
    this.audit.record(ctx, {
      action: 'add_prose_block', targetType: 'prose_document',
      targetId: input.documentId, result: 'success',
      detail: { blockId: block.id, kind: block.kind, orderIndex: block.orderIndex },
    });
    return block;
  }

  /** 更新块文本/类型/关联场景（文本变更会 bump versionId，锚点可能偏移） */
  updateBlock(
    ctx: WritingRequestContext,
    id: string,
    updates: Partial<{ kind: ProseBlockKind; text: string; sceneId: string }>,
  ): void {
    this.store.updateProseBlock(id, updates);
    this.audit.record(ctx, {
      action: 'update_prose_block', targetType: 'prose_document',
      targetId: id, result: 'success', detail: { fields: Object.keys(updates) },
    });
  }

  /** 移动块到新位置（重排，影响 order_index 连续性） */
  moveBlock(ctx: WritingRequestContext, id: string, targetOrderIndex: number): void {
    this.store.moveProseBlock(id, targetOrderIndex);
    this.audit.record(ctx, {
      action: 'move_prose_block', targetType: 'prose_document',
      targetId: id, result: 'success', detail: { targetOrderIndex },
    });
  }

  /** 删除块（重排剩余块保持 order_index 连续） */
  deleteBlock(ctx: WritingRequestContext, id: string): void {
    this.store.deleteProseBlock(id);
    this.audit.record(ctx, {
      action: 'delete_prose_block', targetType: 'prose_document',
      targetId: id, result: 'success',
    });
  }

  /**
   * 把纯文本按空行分段，批量写入文档。
   * §14.6 场景到正文 + §20 导入切分的共享辅助：纯规则切分，不调 LLM。
   * 以「# 」/「## 」开头的行识别为 chapter_title / scene_heading；连续非空行合并为段落。
   */
  ingestText(
    ctx: WritingRequestContext,
    documentId: string,
    text: string,
  ): { addedCount: number } {
    this.assertDocumentInProject(ctx, documentId);
    const rawBlocks = splitMarkdownToBlocks(text);
    let addedCount = 0;
    for (const b of rawBlocks) {
      this.store.addProseBlock({ documentId, kind: b.kind, text: b.text });
      addedCount++;
    }
    if (addedCount > 0) {
      this.audit.record(ctx, {
        action: 'ingest_prose_text', targetType: 'prose_document',
        targetId: documentId, result: 'success', detail: { addedCount },
      });
    }
    return { addedCount };
  }

  private assertDocumentInProject(ctx: WritingRequestContext, documentId: string): void {
    const doc = this.store.getProseDocument(documentId);
    if (!doc) throw new WritingError(WritingErrorCode.WRITING_OBJECT_NOT_FOUND, `正文文档不存在: ${documentId}`);
    if (doc.projectId !== ctx.projectId) throw new WritingError(WritingErrorCode.WRITING_OBJECT_NOT_FOUND, `正文文档不属于当前项目: ${documentId}`);
  }
}

/**
 * Markdown 纯文本 → 块序列（§13.8 块级模型 + §20 切分规则）。
 * 规则：
 *   - `# 标题` → chapter_title
 *   - `## 标题` 或 `***` / `---` → scene_heading / separator
 *   - `> 注释` → note
 *   - 其余连续非空行合并为 paragraph
 */
export function splitMarkdownToBlocks(text: string): Array<{ kind: ProseBlockKind; text: string }> {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const blocks: Array<{ kind: ProseBlockKind; text: string }> = [];
  let para: string[] = [];

  const flushParagraph = () => {
    if (para.length > 0) {
      blocks.push({ kind: 'paragraph', text: para.join('\n').trim() });
      para = [];
    }
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (line === '') {
      flushParagraph();
      continue;
    }
    if (line.startsWith('# ')) {
      flushParagraph();
      blocks.push({ kind: 'chapter_title', text: line.slice(2).trim() });
    } else if (line.startsWith('## ')) {
      flushParagraph();
      blocks.push({ kind: 'scene_heading', text: line.slice(3).trim() });
    } else if (line === '***' || line === '---' || line === '* * *') {
      flushParagraph();
      blocks.push({ kind: 'separator', text: '' });
    } else if (line.startsWith('> ')) {
      flushParagraph();
      blocks.push({ kind: 'note', text: line.slice(2).trim() });
    } else {
      // 连续非空行合并为同一段落；行内以对话引导符「"」「『」开头不强拆，保持段落完整性
      para.push(raw);
    }
  }
  flushParagraph();
  return blocks;
}

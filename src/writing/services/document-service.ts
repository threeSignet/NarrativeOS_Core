// =============================================================================
// DocumentService — 设定集文档树的业务逻辑（起草工作台核心）
// =============================================================================
// 职责：
//   - 文档节点的创建/改名/移动/重排/归档
//   - 富文本内容更新（自动重算字数）
//   - 文档树结构维护（防循环、级联归档）
//
// 核心不变式：
//   - 不写 Core（设定集是写作层自有的参考资料载体，不走审核流程）
//   - move 时禁止把节点移入自身或自身后代（防循环）
//   - 归档文件夹时级联归档所有后代
//   - 所有写操作记审计
//
// 与 ChapterService 范式一致：构造注入 store + audit，方法首参 ctx，更新带 expectedVersion。
// =============================================================================

import type { SQLiteWritingStore } from '../repositories/writing-store.js';
import type { AuditService } from './audit-service.js';
import type { WritingRequestContext } from './context.js';
import { WritingError, WritingErrorCode } from '../errors/error-codes.js';
import type {
  WritingDocument, WritingDocumentKind, WritingDocumentTemplate,
  DocumentContentFormat, WritingDocumentStatus,
} from '../models/types.js';

export class DocumentService {
  constructor(
    private store: SQLiteWritingStore,
    private audit: AuditService,
  ) {}

  /** 新建文件夹节点 */
  createFolder(
    ctx: WritingRequestContext,
    input: { parentId: string | null; title: string; icon?: string },
  ): WritingDocument {
    const sortOrder = this.nextSortOrder(ctx.projectId, input.parentId);
    const doc = this.store.createDocument(ctx.projectId, {
      parentId: input.parentId, kind: 'folder', title: input.title,
      icon: input.icon, sortOrder,
    });

    this.audit.record(ctx, {
      action: 'create_document_folder', targetType: 'document',
      targetId: doc.id, result: 'success',
      detail: { title: doc.title, parentId: doc.parentId },
    });
    return doc;
  }

  /** 新建文档节点（设定文档） */
  createDocument(
    ctx: WritingRequestContext,
    input: {
      parentId: string | null; title: string;
      template?: WritingDocumentTemplate; icon?: string;
      content?: string; contentFormat?: DocumentContentFormat;
      tags?: string[];
    },
  ): WritingDocument {
    const sortOrder = this.nextSortOrder(ctx.projectId, input.parentId);
    const doc = this.store.createDocument(ctx.projectId, {
      parentId: input.parentId, kind: 'document',
      template: input.template ?? 'freeform', title: input.title,
      icon: input.icon, content: input.content,
      contentFormat: input.contentFormat ?? 'tiptap', sortOrder, tags: input.tags,
      wordCount: input.content ? this.countWords(input.content) : 0,
    });

    this.audit.record(ctx, {
      action: 'create_document', targetType: 'document',
      targetId: doc.id, result: 'success',
      detail: { title: doc.title, parentId: doc.parentId, template: doc.template },
    });
    return doc;
  }

  /** 获取单个文档 */
  getDocument(ctx: WritingRequestContext, id: string): WritingDocument {
    const doc = this.store.getDocument(id);
    if (!doc) throw new WritingError(WritingErrorCode.WRITING_OBJECT_NOT_FOUND, `文档不存在: ${id}`, { objectType: 'document', objectId: id });
    if (doc.projectId !== ctx.projectId) throw new WritingError(WritingErrorCode.WRITING_OBJECT_NOT_FOUND, `文档不属于当前项目: ${id}`, { objectType: 'document', objectId: id });
    return doc;
  }

  /** 列出项目下全部文档（树由前端按 parentId 组装） */
  listTree(ctx: WritingRequestContext): WritingDocument[] {
    return this.store.listDocuments(ctx.projectId);
  }

  /** 更新富文本内容（自动重算字数） */
  updateContent(
    ctx: WritingRequestContext,
    id: string,
    expectedVersion: number,
    content: string,
    contentFormat?: DocumentContentFormat,
  ): WritingDocument {
    this.getDocument(ctx, id); // 存在性 + 项目归属校验
    const wordCount = this.countWords(content);
    this.store.updateDocument(id, expectedVersion, {
      content, wordCount, ...(contentFormat ? { contentFormat } : {}),
    });

    this.audit.record(ctx, {
      action: 'update_document_content', targetType: 'document',
      targetId: id, result: 'success',
      detail: { version: expectedVersion + 1, wordCount },
    });
    return this.store.getDocument(id)!;
  }

  /** 改名 */
  rename(
    ctx: WritingRequestContext,
    id: string,
    expectedVersion: number,
    newTitle: string,
  ): WritingDocument {
    this.getDocument(ctx, id);
    this.store.updateDocument(id, expectedVersion, { title: newTitle });

    this.audit.record(ctx, {
      action: 'rename_document', targetType: 'document',
      targetId: id, result: 'success', detail: { newTitle },
    });
    return this.store.getDocument(id)!;
  }

  /**
   * 移动文档到新父节点（跨文件夹拖拽）。
   * 防循环：新父节点不能是自身或自身的后代。
   * 新位置落到目标父节点子列表末尾。
   */
  move(
    ctx: WritingRequestContext,
    id: string,
    expectedVersion: number,
    newParentId: string | null,
  ): WritingDocument {
    const doc = this.getDocument(ctx, id);
    if (newParentId !== null) {
      // 校验目标父存在 + 项目归属
      const newParent = this.store.getDocument(newParentId);
      if (!newParent) throw new WritingError(WritingErrorCode.WRITING_OBJECT_NOT_FOUND, `目标文件夹不存在: ${newParentId}`, { objectType: 'document', objectId: newParentId });
      if (newParent.projectId !== ctx.projectId) throw new WritingError(WritingErrorCode.WRITING_OBJECT_NOT_FOUND, `目标文件夹不属于当前项目: ${newParentId}`, { objectType: 'document', objectId: newParentId });
      // 防循环：不能移入自身
      if (newParentId === id) throw new WritingError(WritingErrorCode.WRITING_STORE_ERROR, `不能把文档移入自身: ${id}`, { objectType: 'document', objectId: id });
      // 防循环：不能移入自身后代
      const descendantIds = this.store.listDescendantIds(id);
      if (descendantIds.includes(newParentId)) throw new WritingError(WritingErrorCode.WRITING_STORE_ERROR, `不能把文档移入自身后代（会形成环）: ${id} -> ${newParentId}`, { objectType: 'document', objectId: id });
      // 目标必须是文件夹
      if (newParent.kind !== 'folder') throw new WritingError(WritingErrorCode.WRITING_STORE_ERROR, `目标节点不是文件夹，无法移入: ${newParentId}`, { objectType: 'document', objectId: newParentId });
    }
    const newSortOrder = this.nextSortOrder(ctx.projectId, newParentId);
    this.store.updateDocument(id, expectedVersion, { parentId: newParentId, sortOrder: newSortOrder });

    this.audit.record(ctx, {
      action: 'move_document', targetType: 'document',
      targetId: id, result: 'success',
      detail: { fromParentId: doc.parentId, toParentId: newParentId },
    });
    return this.store.getDocument(id)!;
  }

  /**
   * 同级重排（拖拽排序）。
   * orderedIds 为某父节点下全部直接子节点的新顺序。
   * 用乐观锁逐个更新；冲突时抛出，调用方应刷新后重试。
   */
  reorder(
    ctx: WritingRequestContext,
    parentId: string | null,
    orderedIds: string[],
  ): void {
    this.store.runInTransaction(() => {
      for (let i = 0; i < orderedIds.length; i++) {
        const doc = this.store.getDocument(orderedIds[i]!);
        if (!doc) continue;
        this.store.updateDocument(orderedIds[i]!, doc.version, { sortOrder: i });
      }
    });

    this.audit.record(ctx, {
      action: 'reorder_documents', targetType: 'document',
      targetId: ctx.projectId, result: 'success',
      detail: { parentId, count: orderedIds.length },
    });
  }

  /**
   * 归档文档（软删除）。
   * 文件夹节点级联归档全部后代。
   */
  archive(ctx: WritingRequestContext, id: string): void {
    const doc = this.getDocument(ctx, id);
    const descendantIds = this.store.listDescendantIds(id);
    this.store.runInTransaction(() => {
      this.store.archiveDocument(id);
      for (const did of descendantIds) this.store.archiveDocument(did);
    });

    this.audit.record(ctx, {
      action: 'archive_document', targetType: 'document',
      targetId: id, result: 'success',
      detail: { title: doc.title, cascadedCount: descendantIds.length },
    });
  }

  // ---------- 私有辅助 ----------

  /** 计算某父节点下下一个 sortOrder（取现有 max+1，空则 0）。 */
  private nextSortOrder(projectId: string, parentId: string | null): number {
    const children = this.store.listDocumentsByParent(projectId, parentId);
    if (children.length === 0) return 0;
    return children[children.length - 1]!.sortOrder + 1;
  }

  /**
   * 粗略字数统计。
   * 富文本内容为 TipTap JSON / HTML 字符串，这里按"去标签 + 去空白"后字符数计。
   * 中英文混排场景下够用；精确统计由前端编辑器层做。
   */
  private countWords(content: string): number {
    if (!content) return 0;
    // 剥离 HTML/JSON 结构字符，只留可见文本
    const text = content
      .replace(/<[^>]+>/g, '')        // HTML 标签
      .replace(/\\u[0-9a-fA-F]{4}/g, '') // JSON unicode 转义标记
      .replace(/["\\\[\]{}:]/g, '')    // JSON 结构符
      .replace(/\s+/g, '');
    return text.length;
  }
}

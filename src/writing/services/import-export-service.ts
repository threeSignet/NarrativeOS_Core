// =============================================================================
// Phase 12 · ImportExportService——导入已有正文 + 统一导出（§20/§23）
// =============================================================================
// 职责：
//   - 导入：把已有小说正文/草稿/设定片段导入为写作层文档（ImportBatch + ProseDocument）
//   - 导出：聚合写作层全量数据为 JSON（§23.1-23.3），复用各 service 的查询能力
//
// 核心不变式：
//   - 导入正文不写 Core（§20.1 验收）
//   - 原文可回看（失败也不丢失原始文件，存 rawSnapshot）
//   - 导入失败不丢失原始文件或粘贴内容
//   - 导出只读，不改变任何状态
//   - 纯规则切分，不调 LLM 反推 Blueprint（§20.7 反推属 AI 部分，推迟）
//
// 与 ChapterService 范式一致：构造注入 store + audit，方法首参 ctx，操作记审计。
// =============================================================================

import type { SQLiteWritingStore } from '../repositories/writing-store.js';
import type { AuditService } from './audit-service.js';
import type { WritingRequestContext } from './context.js';
import { WritingError, WritingErrorCode } from '../errors/error-codes.js';
import { ProseService } from './prose-service.js';
import type { ImportBatch, ImportType } from '../models/types.js';

/** 导出范围（§23.1-23.3） */
export type ExportScope =
  | 'all' | 'blueprint' | 'entities' | 'relations' | 'spatial'
  | 'chapters' | 'scenes' | 'timeline' | 'reader' | 'foreshadowing'
  | 'prose' | 'style';

export interface ProjectExport {
  projectId: string;
  exportedAt: string;
  scope: ExportScope;
  data: Record<string, unknown>;
}

export class ImportExportService {
  constructor(
    private store: SQLiteWritingStore,
    private audit: AuditService,
    private proseService: ProseService,
  ) {}

  // ===========================================================================
  // 导入（§20.1）
  // ===========================================================================

  /**
   * 导入文本：建 ImportBatch（存原文快照）+ 切分建 ProseDocument + ProseBlock。
   * §20.1 验收：导入失败不丢失原文（rawSnapshot 持久）。
   * 切分规则走 ProseService.splitMarkdownToBlocks（# 标题/段落/分隔符）。
   */
  importText(
    ctx: WritingRequestContext,
    input: { sourceFilename?: string; importType: ImportType; content: string },
  ): { batch: ImportBatch; documentId: string; blockCount: number } {
    if (!input.content || input.content.trim() === '') {
      throw new WritingError(WritingErrorCode.WRITING_STORE_ERROR, '导入内容不能为空');
    }

    // 1. 建 ImportBatch（pending），先存原文快照——即使后续失败原文也在
    const batch = this.store.createImportBatch(ctx.projectId, {
      sourceFilename: input.sourceFilename,
      importType: input.importType,
      rawSnapshot: input.content,
      metadata: { lineCount: input.content.split('\n').length, charCount: input.content.length },
    });

    try {
      // 2. 建 ProseDocument（标题取文件名或首行）
      const title = input.sourceFilename ?? this.extractTitle(input.content) ?? `导入文档 ${new Date().toLocaleString()}`;
      const doc = this.proseService.createDocument(ctx, { title });

      // 3. 切分并写入块
      const { addedCount } = this.proseService.ingestText(ctx, doc.id, input.content);

      // 4. 标记 batch 完成
      this.store.completeImportBatch(batch.id, 'imported', [doc.id]);

      this.audit.record(ctx, {
        action: 'import_text', targetType: 'import_batch',
        targetId: batch.id, result: 'success',
        detail: { documentId: doc.id, blockCount: addedCount, sourceFilename: input.sourceFilename },
      });

      return { batch: this.store.getImportBatch(batch.id)!, documentId: doc.id, blockCount: addedCount };
    } catch (err) {
      // §20.1 验收：导入失败标 failed，但原文快照保留（不删除 batch）
      this.store.completeImportBatch(batch.id, 'failed', []);
      this.audit.record(ctx, {
        action: 'import_text', targetType: 'import_batch',
        targetId: batch.id, result: 'failure',
        detail: { error: err instanceof Error ? err.message : String(err) },
      });
      throw err;
    }
  }

  /** 列出导入批次 */
  listImportBatches(ctx: WritingRequestContext): ImportBatch[] {
    return this.store.listImportBatches(ctx.projectId);
  }

  /** 取消待处理批次（已 imported/failed 的不可取消） */
  cancelImportBatch(ctx: WritingRequestContext, id: string): void {
    const batch = this.store.getImportBatch(id);
    if (!batch) throw new WritingError(WritingErrorCode.WRITING_OBJECT_NOT_FOUND, `导入批次不存在: ${id}`);
    if (batch.projectId !== ctx.projectId) throw new WritingError(WritingErrorCode.WRITING_OBJECT_NOT_FOUND, `批次不属于当前项目: ${id}`);
    if (batch.status === 'imported') throw new WritingError(WritingErrorCode.INVALID_STATUS_TRANSITION, `已导入的批次不可取消: ${id}`);
    this.store.completeImportBatch(id, 'cancelled', batch.generatedDocumentIds);
    this.audit.record(ctx, {
      action: 'cancel_import_batch', targetType: 'import_batch',
      targetId: id, result: 'success',
    });
  }

  private extractTitle(content: string): string | undefined {
    const firstLine = content.split('\n').map(l => l.trim()).find(l => l.length > 0);
    if (!firstLine) return undefined;
    // 若首行是标题标记，去掉标记
    return firstLine.replace(/^#+\s*/, '').slice(0, 60);
  }

  // ===========================================================================
  // 导出（§23）
  // ===========================================================================

  /**
   * 导出项目数据为 JSON。
   * §23.1-23.3：聚合蓝图/实体/关系/空间/章节/场景/时间线/读者/伏笔/正文/风格。
   * 复用 store 的 list 方法（只读，不调 service 的写路径）。
   */
  exportProject(ctx: WritingRequestContext, scope: ExportScope = 'all'): ProjectExport {
    const data: Record<string, unknown> = {};
    const scopes: ExportScope[] = scope === 'all'
      ? ['blueprint', 'entities', 'relations', 'spatial', 'chapters', 'scenes', 'reader', 'foreshadowing', 'prose', 'style']
      : [scope];

    for (const s of scopes) {
      data[s] = this.exportScope(ctx, s);
    }

    this.audit.record(ctx, {
      action: 'export_project', targetType: 'project',
      targetId: ctx.projectId, result: 'success',
      detail: { scope, scopes },
    });

    return {
      projectId: ctx.projectId,
      exportedAt: new Date().toISOString(),
      scope,
      data,
    };
  }

  /** 导出单个范围的数据 */
  private exportScope(ctx: WritingRequestContext, scope: ExportScope): unknown {
    switch (scope) {
      case 'blueprint':
        return this.store.listBlueprints(ctx.projectId);
      case 'entities':
        return this.store.listEntitySketches(ctx.projectId);
      case 'relations':
        return this.store.listRelationCandidates(ctx.projectId);
      case 'spatial':
        return {
          nodes: this.store.listSpatialNodes(ctx.projectId),
          edges: this.store.listSpatialEdges(ctx.projectId),
          views: this.store.listSpatialViews(ctx.projectId),
        };
      case 'chapters':
        return this.store.listChapterPlans(ctx.projectId);
      case 'scenes':
        return this.store.listScenePlans(ctx.projectId);
      case 'reader':
        return {
          audiences: this.store.listReaderAudiences(ctx.projectId),
        };
      case 'foreshadowing':
        return {
          plans: this.store.listForeshadowingPlans(ctx.projectId),
          revealPlans: this.store.listRevealPlans(ctx.projectId),
        };
      case 'prose':
        return this.store.listProseDocuments(ctx.projectId).map(d => ({
          document: d,
          blocks: this.store.getProseBlocks(d.id),
        }));
      case 'style':
        return {
          guides: this.store.listStyleGuides(ctx.projectId),
          examples: this.store.listStyleExamples(ctx.projectId),
          bannedExpressions: this.store.listBannedExpressions(ctx.projectId),
        };
      default:
        return null;
    }
  }
}

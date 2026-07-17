// =============================================================================
// Phase 10 · ChapterService——章节规划的业务逻辑
// =============================================================================
// 职责：
//   - 章节规划的创建/修改/状态推进/重排
//   - 关联场景、草案、线索
//
// 核心不变式（Feature-Spec §14.2）：
//   - 章节规划不写 Core
//   - 调整章节顺序只改变写作层结构顺序
//   - 不把章节目标写入 Core
// =============================================================================

import type { SQLiteWritingStore } from '../repositories/writing-store.js';
import type { AuditService } from './audit-service.js';
import type { WritingRequestContext } from './context.js';
import { WritingError, WritingErrorCode } from '../errors/error-codes.js';
import type { ChapterPlan, ChapterPlanStatus } from '../models/types.js';

export class ChapterService {
  constructor(
    private store: SQLiteWritingStore,
    private audit: AuditService,
  ) {}

  /** 列出项目的全部章节规划（按 order 升序） */
  listChapters(ctx: WritingRequestContext): ChapterPlan[] {
    return this.store.listChapterPlans(ctx.projectId).sort((a, b) => a.order - b.order);
  }

  /** 获取单个章节规划 */
  getChapter(ctx: WritingRequestContext, id: string): ChapterPlan | undefined {
    return this.store.getChapterPlan(id);
  }

  /** 创建章节规划 */
  createChapter(
    ctx: WritingRequestContext,
    input: {
      order: number;
      title: string;
      goals?: string[];
      povEntityId?: string;
    },
  ): ChapterPlan {
    const chapter = this.store.createChapterPlan(ctx.projectId, {
      order: input.order,
      title: input.title,
      goals: input.goals,
      povEntityId: input.povEntityId,
    });

    this.audit.record(ctx, {
      action: 'create_chapter_plan',
      targetType: 'chapter_plan',
      targetId: chapter.id,
      result: 'success',
      detail: { title: chapter.title, order: chapter.order },
    });

    return chapter;
  }

  /** 更新章节规划（乐观锁） */
  updateChapter(
    ctx: WritingRequestContext,
    id: string,
    expectedVersion: number,
    updates: Partial<{
      order: number; title: string; goals: string[];
      povEntityId: string; linkedSceneIds: string[];
      linkedThreadIds: string[]; linkedDraftIds: string[];
      proseDocumentId: string;
    }>,
  ): ChapterPlan {
    const chapter = this.store.getChapterPlan(id);
    if (!chapter) throw new WritingError(WritingErrorCode.WRITING_OBJECT_NOT_FOUND, `章节规划不存在: ${id}`, { objectType: 'chapter_plan', objectId: id });

    this.store.updateChapterPlan(id, expectedVersion, updates);

    this.audit.record(ctx, {
      action: 'update_chapter_plan',
      targetType: 'chapter_plan',
      targetId: id,
      result: 'success',
      detail: { updatedFields: Object.keys(updates) },
    });

    return this.store.getChapterPlan(id)!;
  }

  /** 推进章节状态 */
  transitionChapterStatus(
    ctx: WritingRequestContext,
    id: string,
    targetStatus: ChapterPlanStatus,
  ): ChapterPlan {
    const chapter = this.store.getChapterPlan(id);
    if (!chapter) throw new WritingError(WritingErrorCode.WRITING_OBJECT_NOT_FOUND, `章节规划不存在: ${id}`, { objectType: 'chapter_plan', objectId: id });

    this.store.updateChapterPlan(id, chapter.version, { status: targetStatus });

    this.audit.record(ctx, {
      action: 'transition_chapter_status',
      targetType: 'chapter_plan',
      targetId: id,
      result: 'success',
      detail: { from: chapter.status, to: targetStatus },
    });

    return this.store.getChapterPlan(id)!;
  }

  /** 重排章节顺序 */
  reorderChapters(
    ctx: WritingRequestContext,
    orderedIds: string[],
  ): void {
    for (let i = 0; i < orderedIds.length; i++) {
      const chapter = this.store.getChapterPlan(orderedIds[i]!);
      if (chapter) {
        this.store.updateChapterPlan(orderedIds[i]!, chapter.version, { order: i + 1 });
      }
    }

    this.audit.record(ctx, {
      action: 'reorder_chapter_plans',
      targetType: 'chapter_plan',
      targetId: ctx.projectId,
      result: 'success',
      detail: { count: orderedIds.length },
    });
  }
}

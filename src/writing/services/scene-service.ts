// =============================================================================
// Phase 10 · SceneService——场景规划的业务逻辑
// =============================================================================
// 职责：
//   - 场景规划的创建/修改/状态推进/重排
//   - 关联章节、空间节点、参与者
//
// 核心不变式（Feature-Spec §14.3）：
//   - 场景计划不写 Core
//   - 场景转正式事件时进入 Proposal Review
//   - 场景结果不是 Core Fact
// =============================================================================

import type { SQLiteWritingStore } from '../repositories/writing-store.js';
import type { AuditService } from './audit-service.js';
import type { WritingRequestContext } from './context.js';
import { WritingError, WritingErrorCode } from '../errors/error-codes.js';
import type { ScenePlan, ScenePlanStatus, ScenePurpose } from '../models/types.js';

export class SceneService {
  constructor(
    private store: SQLiteWritingStore,
    private audit: AuditService,
  ) {}

  /** 创建场景规划 */
  createScene(
    ctx: WritingRequestContext,
    input: {
      chapterId: string;
      order: number;
      title: string;
      purpose?: ScenePurpose[];
      povEntityId?: string;
      spatialNodeId?: string;
      temporalRef?: string;
      participants?: string[];
      expectedOutcome?: string;
    },
  ): ScenePlan {
    // 校验章节存在
    const chapter = this.store.getChapterPlan(input.chapterId);
    if (!chapter) throw new WritingError(WritingErrorCode.WRITING_OBJECT_NOT_FOUND, `章节规划不存在: ${input.chapterId}`, { objectType: 'chapter_plan', objectId: input.chapterId });

    const scene = this.store.createScenePlan(ctx.projectId, {
      chapterId: input.chapterId,
      order: input.order,
      title: input.title,
      purpose: input.purpose,
      povEntityId: input.povEntityId,
      spatialNodeId: input.spatialNodeId,
      temporalRef: input.temporalRef,
      participants: input.participants,
      expectedOutcome: input.expectedOutcome,
    });

    // 自动关联到章节
    const linkedSceneIds = [...chapter.linkedSceneIds, scene.id];
    this.store.updateChapterPlan(chapter.id, chapter.version, { linkedSceneIds });

    this.audit.record(ctx, {
      action: 'create_scene_plan',
      targetType: 'scene_plan',
      targetId: scene.id,
      result: 'success',
      detail: { title: scene.title, chapterId: input.chapterId, order: scene.order },
    });

    return scene;
  }

  /** 更新场景规划（乐观锁） */
  updateScene(
    ctx: WritingRequestContext,
    id: string,
    expectedVersion: number,
    updates: Partial<{
      order: number; title: string; purpose: ScenePurpose[];
      povEntityId: string; spatialNodeId: string; temporalRef: string;
      participants: string[]; expectedOutcome: string;
      linkedProseBlockIds: string[];
    }>,
  ): ScenePlan {
    const scene = this.store.getScenePlan(id);
    if (!scene) throw new WritingError(WritingErrorCode.WRITING_OBJECT_NOT_FOUND, `场景规划不存在: ${id}`, { objectType: 'scene_plan', objectId: id });

    this.store.updateScenePlan(id, expectedVersion, updates);

    this.audit.record(ctx, {
      action: 'update_scene_plan',
      targetType: 'scene_plan',
      targetId: id,
      result: 'success',
      detail: { updatedFields: Object.keys(updates) },
    });

    return this.store.getScenePlan(id)!;
  }

  /** 推进场景状态 */
  transitionSceneStatus(
    ctx: WritingRequestContext,
    id: string,
    targetStatus: ScenePlanStatus,
  ): ScenePlan {
    const scene = this.store.getScenePlan(id);
    if (!scene) throw new WritingError(WritingErrorCode.WRITING_OBJECT_NOT_FOUND, `场景规划不存在: ${id}`, { objectType: 'scene_plan', objectId: id });

    this.store.updateScenePlan(id, scene.version, { status: targetStatus });

    this.audit.record(ctx, {
      action: 'transition_scene_status',
      targetType: 'scene_plan',
      targetId: id,
      result: 'success',
      detail: { from: scene.status, to: targetStatus },
    });

    return this.store.getScenePlan(id)!;
  }

  /** 重排章节内场景顺序 */
  reorderScenes(
    ctx: WritingRequestContext,
    chapterId: string,
    orderedIds: string[],
  ): void {
    for (let i = 0; i < orderedIds.length; i++) {
      const scene = this.store.getScenePlan(orderedIds[i]!);
      if (scene && scene.chapterId === chapterId) {
        this.store.updateScenePlan(orderedIds[i]!, scene.version, { order: i + 1 });
      }
    }

    this.audit.record(ctx, {
      action: 'reorder_scene_plans',
      targetType: 'scene_plan',
      targetId: chapterId,
      result: 'success',
      detail: { count: orderedIds.length },
    });
  }

  /** 列出场景（可按章节过滤） */
  listScenes(ctx: WritingRequestContext, chapterId?: string): ScenePlan[] {
    return this.store.listScenePlans(ctx.projectId, chapterId ? { chapterId } : undefined);
  }

  /** 获取单个场景 */
  getScene(ctx: WritingRequestContext, id: string): ScenePlan | undefined {
    return this.store.getScenePlan(id);
  }
}

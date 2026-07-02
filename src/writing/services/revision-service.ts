// =============================================================================
// Phase 12 · RevisionService——写作层通用修订记录（§19.1）
// =============================================================================
// 职责：
//   - 记录写作层对象（草案/正文/候选/计划等）的修订轨迹
//   - 按目标对象或版本组查询修订历史
//   - 恢复到某个历史版本（仅写作层，不触发 Core）
//
// 核心不变式（Feature-Spec §19.1）：
//   - 未提交内容修订不触发 Retcon（恢复正文旧版本不回滚 Core）
//   - 已关联 proposal 需要提示失效风险（由调用方判断，本 service 只记录）
//   - 提示「可能需要 Retcon」时必须说明原因（afterSnapshot.reason 承载）
//   - 修订记录覆盖所有写作层对象类型，单一真相源
//
// 与 ChapterService 范式一致：构造注入 store + audit，方法首参 ctx，更新记审计。
// =============================================================================

import type { SQLiteWritingStore } from '../repositories/writing-store.js';
import type { AuditService } from './audit-service.js';
import type { WritingRequestContext } from './context.js';
import { WritingError, WritingErrorCode } from '../errors/error-codes.js';
import type {
  RevisionRecord, RevisionTargetType, RevisionAction,
} from '../models/types.js';

export class RevisionService {
  constructor(
    private store: SQLiteWritingStore,
    private audit: AuditService,
  ) {}

  /**
   * 记录一次修订。调用方在 update/delete/restore 后调用此方法落审计快照。
   * versionGroupId 不传时按 `${targetType}_${targetId}` 自动生成（同一对象的多次修订归为一组）。
   */
  recordRevision(
    ctx: WritingRequestContext,
    input: {
      targetType: RevisionTargetType; targetId: string; action: RevisionAction; summary: string;
      beforeSnapshot?: Record<string, unknown>; afterSnapshot?: Record<string, unknown>;
      versionGroupId?: string; operator?: 'author' | 'agent';
    },
  ): RevisionRecord {
    const record = this.store.createRevisionRecord(ctx.projectId, input);
    this.audit.record(ctx, {
      action: 'create_revision_record', targetType: input.targetType,
      targetId: input.targetId, result: 'success',
      detail: { revisionId: record.id, action: input.action, versionGroupId: record.versionGroupId },
    });
    return record;
  }

  /** 查询某对象的修订历史（按时间倒序） */
  listRevisionsByTarget(
    ctx: WritingRequestContext,
    targetType: RevisionTargetType,
    targetId: string,
  ): RevisionRecord[] {
    return this.store.listRevisionsByTarget(ctx.projectId, targetType, targetId);
  }

  /** 查询某版本组的全部修订（按时间倒序） */
  listRevisionsByGroup(versionGroupId: string): RevisionRecord[] {
    return this.store.listRevisionsByGroup(versionGroupId);
  }

  /** 获取单条修订记录 */
  getRevision(ctx: WritingRequestContext, id: string): RevisionRecord {
    const record = this.store.getRevisionRecord(id);
    if (!record) throw new WritingError(WritingErrorCode.WRITING_OBJECT_NOT_FOUND, `修订记录不存在: ${id}`);
    if (record.projectId !== ctx.projectId) throw new WritingError(WritingErrorCode.WRITING_OBJECT_NOT_FOUND, `修订记录不属于当前项目: ${id}`);
    return record;
  }

  /**
   * 恢复到某个历史版本。
   * 注意：本方法只返回目标快照，由调用方据 targetType 应用到具体对象。
   * 这是因为恢复逻辑因对象类型而异（draft 改 content/status，prose 重建块），
   * 集中在本 service 会引入对所有对象 store 方法的耦合。
   * §19.1 不变量：恢复不触发 Core。若恢复影响已提交状态，afterSnapshot.reason 标注「可能需要 Retcon」。
   */
  restoreRevision(
    ctx: WritingRequestContext,
    id: string,
  ): { snapshot: Record<string, unknown> | undefined; targetType: RevisionTargetType; targetId: string } {
    const record = this.getRevision(ctx, id);
    // 恢复行为本身也记一条修订记录（形成可追溯链条）
    this.recordRevision(ctx, {
      targetType: record.targetType, targetId: record.targetId,
      action: 'restore', summary: `恢复到修订 ${id}`,
      afterSnapshot: record.afterSnapshot, versionGroupId: record.versionGroupId,
    });
    return {
      snapshot: record.afterSnapshot,
      targetType: record.targetType,
      targetId: record.targetId,
    };
  }
}

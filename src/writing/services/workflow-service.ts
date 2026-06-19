// =============================================================================
// WorkflowService — 待确认事项与决策管理
// =============================================================================
// 管理写作过程中的待确认事项（PendingDecisionItem）。
// 所有需要用户确认的操作都通过此服务创建决策、等待解决。
//
// 设计要点：
//   - createPendingDecision 在推演/审批后自动创建
//   - resolvePendingDecision 由 CLI 确认通道调用
//   - resolveDecision 使用乐观锁（WHERE status='open'）防止并发重复处理
//
// 对应设计文档：Phase7-Refinement.md §7.8
// =============================================================================

import { SQLiteWritingStore } from '../repositories/writing-store.js';
import { AuditService } from './audit-service.js';
import type { WritingRequestContext } from './context.js';
import type { PendingDecisionItem, DecisionKind } from '../models/types.js';
import type { SourceRef } from '../models/source-ref.js';
import { WritingError, WritingErrorCode } from '../errors/error-codes.js';

export class WorkflowService {
  private store: SQLiteWritingStore;
  private audit: AuditService;

  constructor(store: SQLiteWritingStore, audit: AuditService) {
    this.store = store;
    this.audit = audit;
  }

  // =========================================================================
  // Command
  // =========================================================================

  /**
   * 创建待确认事项
   *
   * Agent 可调用：是（LOW_RISK_WRITE）
   *
   * 不检查重复——同一草案可以有多个决策并存。
   */
  createPendingDecision(
    ctx: WritingRequestContext,
    params: {
      kind: DecisionKind;
      title: string;
      description?: string;
      linkedObjectId?: string;
      linkedObjectType?: string;
      sourceRefs?: SourceRef[];
    },
  ): PendingDecisionItem {
    const decision = this.store.createDecision(ctx.projectId, {
      kind: params.kind,
      title: params.title,
      description: params.description,
      linkedObjectId: params.linkedObjectId,
      linkedObjectType: params.linkedObjectType,
      sourceRefs: params.sourceRefs ?? ctx.sourceRefs,
    });

    this.audit.record(ctx, {
      action: 'create_pending_decision',
      targetType: 'pending_decision',
      targetId: decision.id,
      detail: { kind: params.kind, linkedObjectId: params.linkedObjectId },
    });

    return decision;
  }

  /**
   * 解决待确认事项
   *
   * Agent 可调用：否（CLI 确认通道专用）
   *
   * 前置条件:
   *   - decision 存在且 status === 'open'
   *   - resolution status 为 'resolved'、'dismissed' 或 'expired'
   *
   * 乐观锁: writing-store 层面 WHERE status = 'open'，防止并发重复处理
   */
  resolvePendingDecision(
    ctx: WritingRequestContext,
    decisionId: string,
    resolution: {
      status: 'resolved' | 'dismissed' | 'expired';
      note?: string;
    },
  ): PendingDecisionItem {
    const decision = this.store.getDecision(decisionId);
    if (!decision) {
      throw new WritingError(WritingErrorCode.WRITING_OBJECT_NOT_FOUND, `找不到待确认事项: ${decisionId}`, { objectType: 'decision', objectId: decisionId });
    }
    if (decision.status !== 'open') {
      throw new WritingError(WritingErrorCode.INVALID_STATUS_TRANSITION, `待确认事项 ${decisionId} 已被处理（当前状态: ${decision.status}）`, { currentStatus: decision.status, attemptedAction: 'resolve' });
    }

    // 乐观锁更新：仅 WHERE status = 'open' 时成功
    this.store.resolveDecision(decisionId, resolution.status, resolution.note);

    this.audit.record(ctx, {
      action: resolution.status === 'resolved' ? 'resolve_decision' : 'dismiss_decision',
      targetType: 'pending_decision',
      targetId: decisionId,
      detail: { resolution: resolution.status, note: resolution.note },
    });

    return this.store.getDecision(decisionId)!;
  }

  // =========================================================================
  // Query
  // =========================================================================

  /**
   * 列出当前待确认事项
   */
  listPendingDecisions(ctx: WritingRequestContext): PendingDecisionItem[] {
    return this.store.listPendingDecisions(ctx.projectId);
  }

  /**
   * 获取决策历史
   *
   * P2 修复：同时纳入 'resolve_decision' 与 'dismiss_decision'。
   * 原实现仅查 resolve_decision，导致被驳回（dismissed）的决策从历史中消失。
   * queryAuditLogs.action 为单值，故分别查询后合并。
   */
  getDecisionHistory(ctx: WritingRequestContext): PendingDecisionItem[] {
    const resolveLogs = this.store.queryAuditLogs(ctx.projectId, { action: 'resolve_decision' });
    const dismissLogs = this.store.queryAuditLogs(ctx.projectId, { action: 'dismiss_decision' });
    return [...resolveLogs, ...dismissLogs]
      .map(log => this.store.getDecision(log.targetId!))
      .filter((d): d is PendingDecisionItem => d !== undefined);
  }
}

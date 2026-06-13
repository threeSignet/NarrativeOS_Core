// =============================================================================
// AuditService — 写作层操作审计
// =============================================================================
// 记录写作层所有关键操作：创建、修改、提交、失败恢复。
// 不记录纯只读查询。
//
// 设计要点：
//   - record() 方法永不抛异常——即使审计写入失败也不阻断主流程
//   - 所有状态变更通过 AuditService 写审计记录
//   - trigger 字段保留操作来源（author/agent/system）
//   - 查询方法仅读写 writing_audit_logs 表
//
// 对应设计文档：Phase7-Refinement.md §7.9
// =============================================================================

import { SQLiteWritingStore } from '../repositories/writing-store.js';
import type { WritingRequestContext } from './context.js';
import type { WritingAuditLog, AuditResult } from '../models/types.js';

export class AuditService {
  private store: SQLiteWritingStore;

  constructor(store: SQLiteWritingStore) {
    this.store = store;
  }

  /**
   * 记录一条操作审计日志
   *
   * 此方法不抛异常。即使审计写入失败（磁盘满、锁冲突等），
   * 也只写 stderr 警告，不阻断主流程。
   */
  record(
    ctx: WritingRequestContext,
    params: {
      action: string;
      targetType?: string;
      targetId?: string;
      result?: AuditResult;
      detail?: unknown;
      errorCode?: string;
    },
  ): WritingAuditLog | undefined {
    try {
      return this.store.recordAudit({
        projectId: ctx.projectId,
        action: params.action,
        targetType: params.targetType,
        targetId: params.targetId,
        triggerSource: ctx.trigger,
        result: params.result ?? 'success',
        detail: params.detail,
        errorCode: params.errorCode,
        requestId: ctx.requestId,
        sessionId: ctx.sessionId,
      });
    } catch (err) {
      // 审计写入失败不能阻断主流程
      console.error(`[AuditService] 审计写入失败: ${params.action}`, err);
      return undefined;
    }
  }

  /**
   * 查询审计日志
   *
   * 按项目ID和可选过滤条件返回最近的审计记录。
   */
  query(
    ctx: WritingRequestContext,
    filter?: {
      action?: string;
      targetType?: string;
      targetId?: string;
      limit?: number;
    },
  ): WritingAuditLog[] {
    return this.store.queryAuditLogs(ctx.projectId, filter);
  }
}

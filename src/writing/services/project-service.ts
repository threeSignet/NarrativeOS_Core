// =============================================================================
// ProjectService — 项目与目标管理
// =============================================================================
// 管理作品项目、作者目标、工作模式切换、归档。
// Phase 7 最基础的服务——只依赖 WritingStore 和 AuditService，不接触 Core。
//
// 设计要点：
//   - 创建项目时自动记录审计
//   - 作者目标支持创建/更新/暂停/归档
//   - archiveProject 必须级联软删除所有子表记录
//   - 所有状态变更都经过 validateProjectTransition 校验
//
// 对应设计文档：Phase7-Refinement.md §7.2
// =============================================================================

import { SQLiteWritingStore } from '../repositories/writing-store.js';
import { AuditService } from './audit-service.js';
import type { WritingRequestContext } from './context.js';
import type {
  WritingProject,
  ProjectStatus,
  WorkspaceMode,
  AuthorGoal,
  GoalKind,
  GoalPriority,
  GoalScope,
  GoalStatus,
} from '../models/types.js';

export class ProjectService {
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
   * 创建作品项目
   *
   * Agent 可调用：是（LOW_RISK_WRITE）
   *
   * 前置条件:
   *   - title 非空
   *
   * 主流程:
   *   1. WritingStore.createProject → status='planning', workspaceMode='planning'
   *   2. AuditService.record
   *
   * 错误路径:
   *   - title 为空 → 抛 Error
   *   - WritingStore 写入失败 → 抛 WRITING_STORE_ERROR
   *
   * 返回: WritingProject (status='planning')
   */
  createProject(
    ctx: WritingRequestContext,
    params: { title: string; premise?: string },
  ): WritingProject {
    if (!params.title || params.title.trim().length === 0) {
      throw new Error('作品标题不能为空');
    }

    const project = this.store.createProject(params.title, params.premise);

    this.audit.record(ctx, {
      action: 'create_project',
      targetType: 'project',
      targetId: project.id,
      result: 'success',
    });

    return project;
  }

  /**
   * 创建或更新作者目标
   *
   * Agent 可调用：是（LOW_RISK_WRITE）
   *
   * 如果 goalId 存在→更新；否则→创建新目标。
   */
  updateAuthorGoal(
    ctx: WritingRequestContext,
    params: {
      goalId?: string;
      text: string;
      kind: GoalKind;
      priority?: GoalPriority;
      scope?: GoalScope;
    },
  ): AuthorGoal {
    if (!params.text || params.text.trim().length === 0) {
      throw new Error('目标文本不能为空');
    }

    if (params.goalId) {
      // 更新已有目标
      const existing = this.store.getGoal(params.goalId);
      if (!existing) {
        throw new Error(`找不到作者目标: ${params.goalId}`);
      }
      this.store.updateGoal(params.goalId, {
        text: params.text,
        kind: params.kind,
        priority: params.priority,
        scope: params.scope,
      });
      const updated = this.store.getGoal(params.goalId)!;

      this.audit.record(ctx, {
        action: 'update_goal',
        targetType: 'author_goal',
        targetId: updated.id,
      });

      return updated;
    }

    // 创建新目标
    const goal = this.store.createGoal(
      ctx.projectId,
      params.text,
      params.kind,
      params.priority,
      params.scope,
      ctx.sourceRefs,
    );

    this.audit.record(ctx, {
      action: 'create_goal',
      targetType: 'author_goal',
      targetId: goal.id,
    });

    return goal;
  }

  /**
   * 暂停作者目标
   */
  pauseAuthorGoal(ctx: WritingRequestContext, goalId: string): void {
    const goal = this.store.getGoal(goalId);
    if (!goal) throw new Error(`找不到作者目标: ${goalId}`);

    this.store.updateGoal(goalId, { status: 'paused' });

    this.audit.record(ctx, {
      action: 'pause_goal',
      targetType: 'author_goal',
      targetId: goalId,
    });
  }

  /**
   * 归档作者目标
   */
  archiveAuthorGoal(ctx: WritingRequestContext, goalId: string): void {
    const goal = this.store.getGoal(goalId);
    if (!goal) throw new Error(`找不到作者目标: ${goalId}`);
    if (goal.status === 'archived') {
      throw new Error('目标已归档');
    }

    this.store.updateGoal(goalId, { status: 'archived' });

    this.audit.record(ctx, {
      action: 'archive_goal',
      targetType: 'author_goal',
      targetId: goalId,
    });
  }

  /**
   * 切换工作模式
   *
   * Agent 可调用：否（COMMIT_FORBIDDEN — 仅 CLI/用户直接操作）
   */
  setWorkspaceMode(ctx: WritingRequestContext, mode: WorkspaceMode): void {
    const project = this.store.getProject(ctx.projectId);
    if (!project) throw new Error(`找不到项目: ${ctx.projectId}`);

    this.store.updateProject(ctx.projectId, { workspaceMode: mode });

    this.audit.record(ctx, {
      action: 'set_workspace_mode',
      targetType: 'project',
      targetId: ctx.projectId,
      detail: { mode },
    });
  }

  /**
   * 归档项目
   *
   * Agent 可调用：否（COMMIT_FORBIDDEN — 高风险操作）
   *
   * 前置条件:
   *   - 项目存在且 status != 'archived'
   *   - 所有 open PendingDecision 已解决或过期
   *
   * 主流程:
   *   1. 验证无未解决决策
   *   2. 级联软删除所有子表记录（audit_logs 除外）
   *   3. 软删除项目
   *   4. 审计
   */
  archiveProject(ctx: WritingRequestContext): void {
    const project = this.store.getProject(ctx.projectId);
    if (!project) throw new Error(`找不到项目: ${ctx.projectId}`);
    if (project.status === 'archived') {
      throw new Error('项目已归档');
    }

    // 检查是否有未解决的待确认事项
    const pendingDecisions = this.store.listPendingDecisions(ctx.projectId);
    if (pendingDecisions.length > 0) {
      throw new Error(
        `项目有 ${pendingDecisions.length} 个待确认事项，请先处理后再归档。` +
        pendingDecisions.map(d => `\n  - ${d.title}`).join(''),
      );
    }

    // 级联软删除子表（audit_logs 除外）
    this.store.softDeleteProject(ctx.projectId);

    this.audit.record(ctx, {
      action: 'archive_project',
      targetType: 'project',
      targetId: ctx.projectId,
    });
  }

  // =========================================================================
  // Query
  // =========================================================================

  /**
   * 获取项目首页视图
   *
   * 组装项目摘要、最近草案、待确认事项、候选实体数。
   */
  getProjectHomeView(ctx: WritingRequestContext): {
    project: WritingProject;
    recentDrafts: Array<{ id: string; title: string; status: string; updatedAt: string }>;
    pendingDecisionCount: number;
    candidateEntityCount: number;
  } {
    const project = this.store.getProject(ctx.projectId);
    if (!project) throw new Error(`找不到项目: ${ctx.projectId}`);

    const recentDrafts = this.store.listDrafts(ctx.projectId)
      .slice(0, 5)
      .map(d => ({
        id: d.id,
        title: d.title ?? d.summary ?? '(无标题)',
        status: d.status,
        updatedAt: d.updatedAt,
      }));

    const pendingDecisions = this.store.listPendingDecisions(ctx.projectId);
    const candidateEntities = this.store.listEntitySketches(ctx.projectId, { status: 'candidate' });

    return {
      project,
      recentDrafts,
      pendingDecisionCount: pendingDecisions.length,
      candidateEntityCount: candidateEntities.length,
    };
  }

  /**
   * 获取项目基本信息（设置页用）
   */
  getProject(ctx: WritingRequestContext): WritingProject {
    const project = this.store.getProject(ctx.projectId);
    if (!project) throw new Error(`找不到项目: ${ctx.projectId}`);
    return project;
  }

  /**
   * 列出作者目标
   */
  listAuthorGoals(ctx: WritingRequestContext, status?: GoalStatus): AuthorGoal[] {
    return this.store.listGoals(ctx.projectId, status);
  }
}

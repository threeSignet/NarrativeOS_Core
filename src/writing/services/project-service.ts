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
import { buildProjectHomeView } from '../view-models/project-home.js';
import type { ProjectHomeViewModel } from '../view-models/project-home.js';
import { stripForbiddenFields } from '../view-models/filter.js';
import { validateProjectTransition } from '../models/state-machine.js';
import { WritingError, WritingErrorCode } from '../errors/error-codes.js';
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
   * 创建作品项目（§3.1 组合初始化）
   *
   * Agent 可调用：是（LOW_RISK_WRITE）
   *
   * 前置条件:
   *   - title 非空（trim 后长度 > 0）
   *
   * 主流程（单一事务，原子性——任一子对象创建失败则整体回滚，避免「项目已建、子对象残缺」悬挂态）:
   *   1. WritingStore.createProject → status='planning', workspaceMode='planning'
   *   2. 创建初始 ProjectBlueprint（maturity='implicit'）——项目的版本-1 潜在结构种子
   *   3. （提供 premise 时）创建第一条 IdeaCard（kind='premise', maturity='raw'）保存原始创意
   *   4. 创建默认 WorkspaceLayout（§22.1 工作台布局容器，1:1）
   *   5. 创建 ProjectPreferenceProfile（项目级作者偏好容器，1:1，初始空 {}）
   *   6. AuditService.record
   *
   * §3.1 不变量：全部仅写 writing_* 表，绝不注册 Core Entity / 写入 Core Fact
   * （验收：创建作品后 Core 中 Fact 数量不变）。ProjectService 不注入 Core，结构性保证。
   *
   * 关于 activeBlueprintId：组合初始化**不**回填该列——按 §6 activeBlueprintId 不变式
   * （见 Phase7-Refinement.md），该字段是作者可选的「手动标注引用」，**非系统真相源**；
   * 系统对"当前蓝图"的判断只走 getActiveBlueprint()（maturity 派生，§3.1 仅建 implicit 蓝图
   * 且 implicit 非 'active'/'evolving'，回填指针会制造「指针指向但派生查不到」的不一致）。
   * 隐式种子经 listBlueprints 可取，待作者整理蓝图（BlueprintService 推进 maturity）后自然
   * 经 getActiveBlueprint() 成为活跃蓝图。该字段留待未来 `/project set activeBlueprintId` CLI
   * 命令做作者显式 pin，但即便被 pin 也不得绕过 getActiveBlueprint() 形成第二条真相。
   *
   * 关于 premise IdeaCard：仅在提供 premise（非空白）时创建——空白开始无创意可存，避免空内容
   * 灵感卡。premise 经 trim 后同时作为 WritingProject.premise 与 IdeaCard.content 持久化。
   *
   * 错误路径:
   *   - title 为空 → 抛 Error（不创建任何对象）
   *   - WritingStore 写入失败 → 事务回滚，抛 WRITING_STORE_ERROR，不创建任何对象
   *
   * 返回: WritingProject (status='planning')
   */
  createProject(
    ctx: WritingRequestContext,
    params: { title: string; premise?: string },
  ): WritingProject {
    if (!params.title || params.title.trim().length === 0) {
      throw new WritingError(WritingErrorCode.WRITING_STORE_ERROR, '作品标题不能为空', { field: 'title' });
    }

    // premise 归一：trim 后非空才视为有效创意（空白 premise 不创建前提灵感卡）
    const premiseText = params.premise?.trim();
    const premise = premiseText && premiseText.length > 0 ? premiseText : undefined;

    // §3.1 组合初始化：单一事务内创建项目 + 隐式蓝图 + （前提灵感）+ 默认布局 + 偏好容器。
    // 仅写 writing_* 表，绝不触碰 Core（§3.1 验收：Core Fact 数量不变）。
    const { project } = this.store.runInTransaction(() => {
      const proj = this.store.createProject(params.title, premise);

      // 初始 ProjectBlueprint（maturity='implicit'）：项目的潜在结构种子（§3.1 系统行为第 2 项）
      this.store.createBlueprint(proj.id, { maturity: 'implicit' });

      // 第一条 IdeaCard（kind='premise', maturity='raw'）：保存用户原始创意（§3.1 系统行为第 3 项）
      if (premise) {
        this.store.createIdeaCard(proj.id, { content: premise, kind: 'premise' });
      }

      // 默认 WorkspaceLayout（§3.1 系统行为第 4 项）+ 项目级偏好容器（第 5 项）：1:1 容器
      this.store.createWorkspaceLayout(proj.id);
      this.store.createProjectPreferenceProfile(proj.id);

      return { project: proj };
    });

    // 记审计：用刚创建的 project.id 作 ctx.projectId（调用方传入的 ctx.projectId 在项目
    // 创建前可能不存在——如 CLI bootstrap 传 'pending' 占位）。audit_logs.project_id 有
    // FK 约束指向 writing_projects.id，用占位 id 会导致 FOREIGN KEY failed。
    const auditCtx: WritingRequestContext = {
      ...ctx,
      projectId: project.id,
    };
    this.audit.record(auditCtx, {
      action: 'create_project',
      targetType: 'project',
      targetId: project.id,
      result: 'success',
      // 记录组合初始化范围（是否含前提灵感），便于审计追溯
      detail: { compositeInit: true, withPremiseIdea: !!premise },
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
      throw new WritingError(WritingErrorCode.WRITING_STORE_ERROR, '目标文本不能为空', { field: 'text' });
    }

    if (params.goalId) {
      // 更新已有目标
      const existing = this.store.getGoal(params.goalId);
      if (!existing) {
        throw new WritingError(WritingErrorCode.WRITING_OBJECT_NOT_FOUND, `找不到作者目标: ${params.goalId}`, { objectType: 'author_goal', objectId: params.goalId });
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
    if (!goal) throw new WritingError(WritingErrorCode.WRITING_OBJECT_NOT_FOUND, `找不到作者目标: ${goalId}`, { objectType: 'author_goal', objectId: goalId });

    // 已归档目标是终态——禁止 pause（否则 archived→paused 静默复活已归档目标，违背全仓库
    // "archived 终态"不变式：Project/Blueprint/Draft/Idea/Sketch 的 archived 皆不可逆回流）。
    // paused→paused 幂等、active→paused 合法，故仅守 archived。AuthorGoal 无独立状态机表
    // （GoalStatus 仅 active/paused/archived 三态），此处为领域不变式守卫，非状态机校验。
    if (goal.status === 'archived') {
      throw new WritingError(
        WritingErrorCode.INVALID_STATUS_TRANSITION,
        `作者目标 ${goalId} 已归档（终态），不能暂停`,
        { goalId, currentStatus: goal.status, targetStatus: 'paused' },
      );
    }

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
    if (!goal) throw new WritingError(WritingErrorCode.WRITING_OBJECT_NOT_FOUND, `找不到作者目标: ${goalId}`, { objectType: 'author_goal', objectId: goalId });
    if (goal.status === 'archived') {
      // W11：状态违规统一 WritingError（INVALID_STATUS_TRANSITION）——上层经 ERROR_RECOVERY_MAP
      // 映射"当前状态不允许此操作"人话与恢复动作，而非泛化兜底。与 pauseAuthorGoal 守卫同范式。
      throw new WritingError(
        WritingErrorCode.INVALID_STATUS_TRANSITION,
        `作者目标 ${goalId} 已归档（终态），不能重复归档`,
        { goalId, currentStatus: goal.status, targetStatus: 'archived' },
      );
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
    if (!project) throw new WritingError(WritingErrorCode.WRITING_OBJECT_NOT_FOUND, `找不到项目: ${ctx.projectId}`, { objectType: 'project', objectId: ctx.projectId });

    this.store.updateProject(ctx.projectId, { workspaceMode: mode });

    this.audit.record(ctx, {
      action: 'set_workspace_mode',
      targetType: 'project',
      targetId: ctx.projectId,
      detail: { mode },
    });
  }

  /**
   * 推进项目生命周期状态（planning → drafting → reviewing → paused，皆可 → archived）
   *
   * Agent 可调用：否（COMMIT_FORBIDDEN — 项目生命周期是作者层面的元操作，与 setWorkspaceMode
   *   / archiveProject 同级，仅 CLI/用户直接操作，避免 Agent 自行驱动项目阶段跳转）
   *
   * W10-b：此前 validateProjectTransition 是死代码——项目 status 创建为 'planning' 后，
   * 仅有 workspaceMode（工作模式，与生命周期 status 是两个维度）会被 setWorkspaceMode 改动，
   * project.status 本身没有任何写入路径，状态机校验自然无处调用。本方法是 §5.1 项目状态机的
   * 唯一驱动入口，使 validateProjectTransition 落地（非法跳转如 archived→drafting 抛
   * StateMachineError）。注：归档走 archiveProject（软删 deleted_at），不由此方法处理。
   *
   * 对应设计文档：Phase7-Refinement.md §5.1（WritingProject 状态机）、§7.2
   */
  transitionProjectStatus(
    ctx: WritingRequestContext,
    targetStatus: ProjectStatus,
  ): WritingProject {
    const project = this.store.getProject(ctx.projectId);
    if (!project) throw new WritingError(WritingErrorCode.WRITING_OBJECT_NOT_FOUND, `找不到项目: ${ctx.projectId}`, { objectType: 'project', objectId: ctx.projectId });

    // 同态短路（幂等）：当前已是目标状态则不写库。必须在 validateProjectTransition 之前——
    // 状态机表无自环（planning→planning 不在允许列表），若先校验会把幂等 noop 误判为非法跳转。
    if (project.status === targetStatus) {
      this.audit.record(ctx, {
        action: 'transition_project_status',
        targetType: 'project',
        targetId: ctx.projectId,
        detail: { from: project.status, to: targetStatus, noop: true },
      });
      return project;
    }

    // 状态机校验（单一真相源）——非法跳转抛 StateMachineError（INVALID_STATUS_TRANSITION）
    validateProjectTransition(project.status, targetStatus, ctx.projectId);

    this.store.updateProject(ctx.projectId, { status: targetStatus });
    const updated = this.store.getProject(ctx.projectId)!;

    this.audit.record(ctx, {
      action: 'transition_project_status',
      targetType: 'project',
      targetId: ctx.projectId,
      detail: { from: project.status, to: targetStatus },
    });

    return updated;
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
    if (!project) throw new WritingError(WritingErrorCode.WRITING_OBJECT_NOT_FOUND, `找不到项目: ${ctx.projectId}`, { objectType: 'project', objectId: ctx.projectId });
    if (project.status === 'archived') {
      throw new WritingError(WritingErrorCode.INVALID_STATUS_TRANSITION, '项目已归档', { currentStatus: 'archived', attemptedAction: 'archive' });
    }

    // 检查是否有未解决的待确认事项
    const pendingDecisions = this.store.listPendingDecisions(ctx.projectId);
    if (pendingDecisions.length > 0) {
      throw new WritingError(
        WritingErrorCode.INVALID_STATUS_TRANSITION,
        `项目有 ${pendingDecisions.length} 个待确认事项，请先处理后再归档。` +
        pendingDecisions.map(d => `\n  - ${d.title}`).join(''),
        { currentStatus: project.status, attemptedAction: 'archive', pendingCount: pendingDecisions.length },
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

  /**
   * 更新项目元信息（title / premise）—— CLI `/project set` 的数据源
   *
   * 与 setWorkspaceMode / transitionProjectStatus 同级，均为作者层面的元操作（COMMIT_FORBIDDEN，
   * 仅 CLI/用户直接操作）。title/premise 是自由文本字段，无状态机约束，故独立成方法。
   * status 走 transitionProjectStatus（带状态机校验），workspace-mode 走 setWorkspaceMode。
   *
   * 对应设计文档：CLI-Layer-Design.md §4.8（行 274-280）。
   */
  updateProjectMeta(
    ctx: WritingRequestContext,
    patch: { title?: string; premise?: string },
  ): WritingProject {
    const project = this.store.getProject(ctx.projectId);
    if (!project) throw new WritingError(WritingErrorCode.WRITING_OBJECT_NOT_FOUND, `找不到项目: ${ctx.projectId}`, { objectType: 'project', objectId: ctx.projectId });

    // 至少要有一个字段
    if (patch.title === undefined && patch.premise === undefined) {
      throw new WritingError(WritingErrorCode.WRITING_STORE_ERROR, 'updateProjectMeta 需至少指定 title 或 premise 之一', { field: 'patch' });
    }

    const updatePatch: { title?: string; premise?: string } = {};
    if (patch.title !== undefined) {
      const trimmed = patch.title.trim();
      if (trimmed.length === 0) throw new WritingError(WritingErrorCode.WRITING_STORE_ERROR, '项目标题不能为空', { field: 'title' });
      updatePatch.title = trimmed;
    }
    if (patch.premise !== undefined) {
      updatePatch.premise = patch.premise.trim();
    }

    this.store.updateProject(ctx.projectId, updatePatch);
    const updated = this.store.getProject(ctx.projectId)!;

    this.audit.record(ctx, {
      action: 'update_project_meta',
      targetType: 'project',
      targetId: ctx.projectId,
      detail: { fields: Object.keys(updatePatch) },
    });

    return updated;
  }

  // =========================================================================
  // Query
  // =========================================================================

  /**
   * 获取项目首页视图（§9.2 ProjectHomeViewModel）
   *
   * 组装项目摘要、最近 5 条草案、未解决待确认事项、候选实体数，
   * 经 buildProjectHomeView 投影为人话 ViewModel。
   *
   * 关键：原始领域对象（含 id / 枚举 / Core 引用）只在 service 内部存活，
   * 出口的 ProjectHomeViewModel 按 ctx.visibilityMode 过滤——normal 模式
   * 绝不泄漏技术字段（§9.1），debug 模式附带 _debug 诊断块。这消费了
   * WritingRequestContext.visibilityMode（此前为死代码，W6 闭合）。
   */
  getProjectHomeView(ctx: WritingRequestContext): ProjectHomeViewModel {
    const project = this.store.getProject(ctx.projectId);
    if (!project) throw new WritingError(WritingErrorCode.WRITING_OBJECT_NOT_FOUND, `找不到项目: ${ctx.projectId}`, { objectType: 'project', objectId: ctx.projectId });

    // §7.2 步骤 3/4：最近草案（limit 5）+ 未解决待确认事项（listPendingDecisions 已过滤 status='open'）
    const recentDrafts = this.store.listDrafts(ctx.projectId).slice(0, 5);
    const pendingDecisions = this.store.listPendingDecisions(ctx.projectId);
    const candidateEntities = this.store.listEntitySketches(ctx.projectId, { status: 'candidate' });

    // 步骤 5：组装 ViewModel 并应用 visibilityMode 过滤（标签化 + debug 分流 + 防御性断言）
    return buildProjectHomeView(ctx, {
      project,
      recentDrafts,
      pendingDecisions,
      candidateEntityCount: candidateEntities.length,
    });
  }

  /**
   * 获取项目基本信息（设置页用）
   */
  getProject(ctx: WritingRequestContext): WritingProject {
    const project = this.store.getProject(ctx.projectId);
    if (!project) throw new WritingError(WritingErrorCode.WRITING_OBJECT_NOT_FOUND, `找不到项目: ${ctx.projectId}`, { objectType: 'project', objectId: ctx.projectId });
    return project;
  }

  /**
   * 列出作者目标（§7.2）
   *
   * 步骤 2：normal 模式应用 §9.1 技术字段过滤（stripForbiddenFields）；
   * debug 模式原样返回。AuthorGoal 本身不含 Core ID/谓词，过滤对其为
   * 安全兜底（防御未来字段引入 Core 引用时泄漏）；这也消费了 visibilityMode。
   *
   * 注：与 getProjectHomeView 不同，这里只做「过滤」不做「ViewModel 组装」——
   * §9.2 未定义 GoalViewModel，目标列表的枚举字段（kind/priority/scope/status）
   * 不属 §9.1 禁止范畴，由 UI 自行标签化展示。
   */
  listAuthorGoals(ctx: WritingRequestContext, status?: GoalStatus): AuthorGoal[] {
    const goals = this.store.listGoals(ctx.projectId, status);
    return stripForbiddenFields(goals, ctx.visibilityMode);
  }
}

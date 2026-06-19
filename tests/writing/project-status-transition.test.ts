// =============================================================================
// W10-b 测试：ProjectService.transitionProjectStatus（§5.1 项目状态机驱动）
// =============================================================================
// 验证 W10-b——validateProjectTransition 此前是死代码（无任何写入 project.status 的路径，
// 仅 workspaceMode 会被 setWorkspaceMode 改动）。transitionProjectStatus 是 §5.1 项目状态机
// 的唯一驱动入口，使状态机校验落地：合法跳转放行 + 记审计；非法跳转抛 StateMachineError。
//
// 使用真实 :memory: WritingStore + ProjectService，不依赖 Core / LLM。
// =============================================================================

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { SQLiteWritingStore } from '../../src/writing/repositories/writing-store.js';
import { AuditService } from '../../src/writing/services/audit-service.js';
import { ProjectService } from '../../src/writing/services/project-service.js';
import { makeRequestContext } from '../../src/writing/services/context.js';
import { StateMachineError } from '../../src/writing/models/state-machine.js';
import { WritingError, WritingErrorCode } from '../../src/writing/errors/error-codes.js';

describe('W10-b ProjectService.transitionProjectStatus 项目状态机驱动', () => {
  let store: SQLiteWritingStore;
  let projectService: ProjectService;
  let projectId: string;
  let ctx: ReturnType<typeof makeRequestContext>;

  beforeEach(() => {
    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    store = new SQLiteWritingStore(db);
    store.createTables();
    const audit = new AuditService(store);
    projectService = new ProjectService(store, audit);

    // 项目默认 status='planning'
    projectId = store.createProject('状态机测试作品').id;
    ctx = makeRequestContext({ projectId });
  });

  it('合法跳转 planning → drafting：更新 status + 记审计（from/to）', () => {
    const updated = projectService.transitionProjectStatus(ctx, 'drafting');

    expect(updated.status).toBe('drafting');
    expect(store.getProject(projectId)!.status).toBe('drafting');

    const logs = store.queryAuditLogs(projectId, { action: 'transition_project_status' });
    expect(logs).toHaveLength(1);
    expect(logs[0]!.detail).toEqual({ from: 'planning', to: 'drafting' });
  });

  it('多步链路 planning → drafting → reviewing → paused → drafting 均合法', () => {
    projectService.transitionProjectStatus(ctx, 'drafting');
    projectService.transitionProjectStatus(ctx, 'reviewing');
    projectService.transitionProjectStatus(ctx, 'paused');
    // paused → drafting（paused 可回到 drafting/审查/规划）
    projectService.transitionProjectStatus(ctx, 'drafting');

    expect(store.getProject(projectId)!.status).toBe('drafting');
    const logs = store.queryAuditLogs(projectId, { action: 'transition_project_status' });
    expect(logs).toHaveLength(4);
  });

  it('非法跳转（archived → drafting）抛 StateMachineError，不写库', () => {
    // 先到 drafting 再归档（用 transitionProjectStatus 走 →archived，合法）
    projectService.transitionProjectStatus(ctx, 'drafting');
    projectService.transitionProjectStatus(ctx, 'archived');
    expect(store.getProject(projectId)!.status).toBe('archived');

    // archived 无任何出边 → 非法
    expect(() => projectService.transitionProjectStatus(ctx, 'drafting')).toThrow(StateMachineError);
    // 状态未被改动
    expect(store.getProject(projectId)!.status).toBe('archived');
  });

  it('非法跳转（drafting → planning 回退）抛 StateMachineError', () => {
    projectService.transitionProjectStatus(ctx, 'drafting');
    // drafting 的出边不含 planning（PROJECT_TRANSITIONS['drafting']=['reviewing','paused','archived']）
    expect(() => projectService.transitionProjectStatus(ctx, 'planning')).toThrow(StateMachineError);
    expect(store.getProject(projectId)!.status).toBe('drafting');
  });

  it('同态短路（已是目标状态）：不写库但仍记审计（noop 标记）', () => {
    const before = store.getProject(projectId)!;
    const result = projectService.transitionProjectStatus(ctx, 'planning');

    expect(result.status).toBe('planning');
    const after = store.getProject(projectId)!;
    // updated_at 未变（未触发 updateProject）
    expect(after.updatedAt).toBe(before.updatedAt);

    const logs = store.queryAuditLogs(projectId, { action: 'transition_project_status' });
    expect(logs).toHaveLength(1);
    expect(logs[0]!.detail).toEqual({ from: 'planning', to: 'planning', noop: true });
  });

  it('项目不存在抛错', () => {
    const missingCtx = makeRequestContext({ projectId: 'proj_does_not_exist' });
    expect(() => projectService.transitionProjectStatus(missingCtx, 'drafting')).toThrow(
      /找不到项目/,
    );
  });
});

// =============================================================================
// AuthorGoal 终态守卫（P1 修复：archived 不可逆回流）
// =============================================================================
// 此前 pauseAuthorGoal 无任何守卫——pause 一个已 archived 的目标会让 archived→paused，
// 静默复活终态目标，违背全仓库"archived 终态"不变式（Project/Blueprint/Draft/Idea/Sketch 的
// archived 皆不可逆）。archiveAuthorGoal 的"重复归档"守卫原本是裸 Error，现统一 WritingError
// （对齐 W11：状态违规经 ERROR_RECOVERY_MAP 映射人话）。这两个 goal 生命周期方法此前零测试覆盖。
// =============================================================================
describe('AuthorGoal 终态守卫：pause/archive 状态前置校验', () => {
  let store: SQLiteWritingStore;
  let projectService: ProjectService;
  let projectId: string;
  let ctx: ReturnType<typeof makeRequestContext>;

  beforeEach(() => {
    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    store = new SQLiteWritingStore(db);
    store.createTables();
    const audit = new AuditService(store);
    projectService = new ProjectService(store, audit);
    projectId = store.createProject('目标守卫测试作品').id;
    ctx = makeRequestContext({ projectId });
  });

  /** 创建一个 active 目标（updateAuthorGoal 无 goalId → 创建分支） */
  function makeGoal() {
    return projectService.updateAuthorGoal(ctx, { text: '保持主角动机一致', kind: 'goal' });
  }

  it('happy path：pause active 目标 → paused；pause paused 幂等不抛错', () => {
    const goal = makeGoal();
    projectService.pauseAuthorGoal(ctx, goal.id);
    expect(store.getGoal(goal.id)!.status).toBe('paused');

    // paused → paused 幂等：守卫只拦 archived，paused 不受影响
    expect(() => projectService.pauseAuthorGoal(ctx, goal.id)).not.toThrow();
    expect(store.getGoal(goal.id)!.status).toBe('paused');
  });

  it('pause 已 archived 目标 → 抛 WritingError(INVALID_STATUS_TRANSITION)，状态不变', () => {
    const goal = makeGoal();
    projectService.archiveAuthorGoal(ctx, goal.id);
    expect(store.getGoal(goal.id)!.status).toBe('archived');

    // archived 是终态，pause 不得让其回流到 paused
    try {
      projectService.pauseAuthorGoal(ctx, goal.id);
      throw new Error('应抛 WritingError 但未抛');
    } catch (e) {
      expect(e).toBeInstanceOf(WritingError);
      expect((e as WritingError).code).toBe(WritingErrorCode.INVALID_STATUS_TRANSITION);
    }
    // 状态未被改动（仍是 archived，未回流）
    expect(store.getGoal(goal.id)!.status).toBe('archived');
  });

  it('archive 已 archived 目标 → 抛 WritingError（非裸 Error），状态不变', () => {
    const goal = makeGoal();
    projectService.archiveAuthorGoal(ctx, goal.id);

    try {
      projectService.archiveAuthorGoal(ctx, goal.id);
      throw new Error('应抛 WritingError 但未抛');
    } catch (e) {
      expect(e).toBeInstanceOf(WritingError);
      expect((e as WritingError).code).toBe(WritingErrorCode.INVALID_STATUS_TRANSITION);
    }
    expect(store.getGoal(goal.id)!.status).toBe('archived');
  });
});

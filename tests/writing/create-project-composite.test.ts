// =============================================================================
// W12 测试：createProject §3.1 组合初始化
// =============================================================================
// 验证 ProjectService.createProject 按 Feature-Spec §3.1 完成「组合初始化」：
//   - 创建 WritingProject（status=planning, workspaceMode=planning）
//   - 创建初始 ProjectBlueprint（maturity=implicit）——潜在结构种子
//   - （提供 premise 时）创建第一条 IdeaCard（kind=premise, maturity=raw）保存原始创意
//   - 创建默认 WorkspaceLayout（§22.1 工作台布局容器，与项目 1:1）
//   - 创建 ProjectPreferenceProfile（项目级作者偏好容器，1:1，初始空 {}）
//   - 不写 Core（WL-E2E-001 验收：创建作品后 Core 中 Fact 数量不变）
//
// 关键不变量：组合初始化全部仅写 writing_* 表，绝不注册 Core Entity / 写入 Core Fact。
// ProjectService 只依赖 WritingStore + AuditService（不注入 Core/ToolRouter），结构性保证。
//
// 使用真实 Core（:memory: SQLite），无 LLM / Embedding。
// =============================================================================

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SQLiteFactStoreAdapter } from '../../src/adapters/sqlite/fact-store.js';
import { SQLiteWritingStore } from '../../src/writing/repositories/writing-store.js';
import { AuditService } from '../../src/writing/services/audit-service.js';
import { ProjectService } from '../../src/writing/services/project-service.js';
import { makeRequestContext } from '../../src/writing/services/context.js';
import { WritingError, WritingErrorCode } from '../../src/writing/errors/error-codes.js';

describe('W12 createProject §3.1 组合初始化', () => {
  let factStore: SQLiteFactStoreAdapter;
  let store: SQLiteWritingStore;
  let audit: AuditService;
  let projectService: ProjectService;

  beforeEach(() => {
    factStore = new SQLiteFactStoreAdapter(':memory:', 'default');
    const db = factStore.getDatabase();
    store = new SQLiteWritingStore(db);
    store.createTables();
    audit = new AuditService(store);
    projectService = new ProjectService(store, audit);
  });

  /** Core Fact 计数——验证「创建作品不写 Core」不变量（§3.1 验收） */
  const countCoreFacts = (): number =>
    (factStore.getDatabase().prepare('SELECT COUNT(*) as c FROM facts').get() as { c: number }).c;

  const ctx = () => makeRequestContext({ projectId: 'ctx-scope', trigger: 'author_action' });

  // ---------------------------------------------------------------------------
  // §3.1 验收 1：创建作品不写 Core（Fact 数量不变）
  // ---------------------------------------------------------------------------
  it('WL-E2E-001：创建作品后 Core 中 Fact 数量不变（绝不写 Core）', () => {
    const before = countCoreFacts();
    projectService.createProject(ctx(), { title: '灰域纪事', premise: '一对兄妹在灰域边缘求生' });
    expect(countCoreFacts()).toBe(before);
  });

  // ---------------------------------------------------------------------------
  // §3.1 系统行为 1-5：组合初始化创建全部对象
  // ---------------------------------------------------------------------------
  it('组合初始化（有 premise）：项目(planning) + 隐式蓝图 + 前提灵感 + 布局 + 偏好容器', () => {
    const project = projectService.createProject(ctx(), { title: '灰域纪事', premise: '原始创意' });

    // 项目基础状态（§3.1）
    expect(project.status).toBe('planning');
    expect(project.workspaceMode).toBe('planning');

    // 隐式蓝图（maturity=implicit，§3.1 系统行为第 2 项）
    const blueprints = store.listBlueprints(project.id);
    expect(blueprints.length).toBe(1);
    expect(blueprints[0]!.maturity).toBe('implicit');

    // activeBlueprintId 不回填——休眠列，且 getActiveBlueprint 按 maturity('active'/'evolving')
    // 查询不返回 implicit 蓝图；强行链接会制造指针/maturity 不一致（见 createProject 注释）
    expect(project.activeBlueprintId).toBeUndefined();
    expect(store.getActiveBlueprint(project.id)).toBeUndefined();

    // 前提灵感（kind=premise, maturity=raw, content=premise，§3.1 系统行为第 3 项）
    const ideas = store.listIdeaCards(project.id);
    expect(ideas.length).toBe(1);
    expect(ideas[0]!.kind).toBe('premise');
    expect(ideas[0]!.maturity).toBe('raw');
    expect(ideas[0]!.content).toBe('原始创意');

    // 默认工作台布局（1:1，version=1，§3.1 系统行为第 4 项）
    const layout = store.getWorkspaceLayout(project.id);
    expect(layout).toBeDefined();
    expect(layout!.version).toBe(1);

    // 项目级偏好容器（1:1，空 {}，version=1，§3.1 系统行为第 5 项）
    const pref = store.getProjectPreferenceProfile(project.id);
    expect(pref).toBeDefined();
    expect(pref!.version).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // §3.1 空白开始：无 premise 时不创建前提灵感，但其余容器照常创建
  // ---------------------------------------------------------------------------
  it('空白开始（无 premise）：不创建前提灵感，但仍创建蓝图+布局+偏好', () => {
    const project = projectService.createProject(ctx(), { title: '空白作品' });

    expect(store.listIdeaCards(project.id).length).toBe(0);   // 无 premise → 无灵感卡
    expect(store.listBlueprints(project.id).length).toBe(1);  // 仍创建隐式蓝图
    expect(store.getWorkspaceLayout(project.id)).toBeDefined();
    expect(store.getProjectPreferenceProfile(project.id)).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // 1:1 容器独立性：多项目互不干扰
  // ---------------------------------------------------------------------------
  it('多次 createProject 各自独立（1:1 容器按 projectId 隔离）', () => {
    const p1 = projectService.createProject(ctx(), { title: 'A', premise: 'a' });
    const p2 = projectService.createProject(ctx(), { title: 'B' });
    expect(p1.id).not.toBe(p2.id);

    // 每个项目各有独立的隐式蓝图 + 布局 + 偏好
    expect(store.getWorkspaceLayout(p1.id)!.id).not.toBe(store.getWorkspaceLayout(p2.id)!.id);
    expect(store.getProjectPreferenceProfile(p1.id)!.id).not.toBe(store.getProjectPreferenceProfile(p2.id)!.id);
    // A 有前提灵感，B 无
    expect(store.listIdeaCards(p1.id).length).toBe(1);
    expect(store.listIdeaCards(p2.id).length).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // W3 乐观锁一致性：1:1 容器同样支持版本推进 + 冲突检测
  // ---------------------------------------------------------------------------
  it('布局/偏好容器乐观锁：版本推进 + 旧版本号冲突抛 VERSION_CONFLICT', () => {
    const project = projectService.createProject(ctx(), { title: 'X', premise: 'p' });

    // 布局乐观锁
    const layout = store.getWorkspaceLayout(project.id)!;
    const r1 = store.updateWorkspaceLayout(project.id, layout.version, { panelLayout: { panels: ['outline'] } });
    expect(r1.newVersion).toBe(2);
    expect(store.getWorkspaceLayout(project.id)!.version).toBe(2);
    expect(() => store.updateWorkspaceLayout(project.id, layout.version, { panelLayout: {} }))
      .toThrow(WritingError);
    try {
      store.updateWorkspaceLayout(project.id, layout.version, { panelLayout: {} });
      throw new Error('应抛 VERSION_CONFLICT 但未抛');
    } catch (err) {
      expect((err as WritingError).code).toBe(WritingErrorCode.VERSION_CONFLICT);
    }

    // 偏好容器乐观锁（同样语义）
    const pref = store.getProjectPreferenceProfile(project.id)!;
    const r2 = store.updateProjectPreferenceProfile(project.id, pref.version, { preferences: { pov: 'first' } });
    expect(r2.newVersion).toBe(2);
    expect(store.getProjectPreferenceProfile(project.id)!.version).toBe(2);
  });

  // ---------------------------------------------------------------------------
  // 原子性：title 非法 → 抛错且不创建任何对象（事务回滚）
  // ---------------------------------------------------------------------------
  it('标题为空 → 抛错，不创建任何对象（事务回滚保证无悬挂态）', () => {
    expect(() => projectService.createProject(ctx(), { title: '   ' })).toThrow();
    expect(store.listProjects().length).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // 生命周期：1:1 容器随项目级联软删
  // ---------------------------------------------------------------------------
  it('softDeleteProject 级联软删除 1:1 容器（布局/偏好随项目软删）', () => {
    const project = projectService.createProject(ctx(), { title: 'X' });
    expect(store.getWorkspaceLayout(project.id)).toBeDefined();

    // 直接走 store 级联软删（验证 W12 新表已纳入 softDeleteProject 的 childTables）
    store.softDeleteProject(project.id);
    expect(store.getWorkspaceLayout(project.id)).toBeUndefined();
    expect(store.getProjectPreferenceProfile(project.id)).toBeUndefined();
    expect(store.listBlueprints(project.id).length).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // 审计：组合初始化记录 create_project，detail 标注组合范围
  // ---------------------------------------------------------------------------
  // 注：AuditService.record 以 ctx.projectId 落审计，而 writing_audit_logs.project_id 有
  // FK→writing_projects(id)。createProject 生成新项目 id（≠ ctx.projectId），故以占位 ctx
  // 调用时 FK 会失败、record 静默吞掉（这是既有行为，E2E-007 依赖：其 env.projectId 为真实项目
  // 故 FK 成立）。本测试用 spy 直接断言 createProject 以正确参数调用 record，不耦合 FK 持久化路径。
  it('组合初始化记录 create_project 审计（detail 标注 compositeInit + withPremiseIdea）', () => {
    const recordSpy = vi.spyOn(audit, 'record').mockReturnValue(undefined);
    projectService.createProject(ctx(), { title: 'X', premise: 'p' });

    expect(recordSpy).toHaveBeenCalledTimes(1);
    const auditParams = recordSpy.mock.calls[0]![1]!;
    expect(auditParams.action).toBe('create_project');
    expect(auditParams.targetType).toBe('project');
    expect(auditParams.result).toBe('success');
    expect(auditParams.detail).toMatchObject({ compositeInit: true, withPremiseIdea: true });

    recordSpy.mockRestore();
  });
});

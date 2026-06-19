// =============================================================================
// W6-b 服务级测试：ProjectService.getProjectHomeView 投影接线（§9.1/§9.2）
// =============================================================================
// 验证 W6 缺口的真正落点——project-service.ts:248 此前直接返回原始领域对象
// （泄漏 id / 枚举 / Core 引用），现已改为经 buildProjectHomeView 投影：
//   1. 出口是 ProjectHomeViewModel（人话字段），非原始 WritingProject。
//   2. recentDrafts/pendingDecisions 项**不含 id 键**，状态/类型已标签化。
//   3. candidateEntityCount 只计 candidate（不计 registered）。
//   4. normal 模式：_debug 不存在，findForbiddenField 全表扫描无违规（§9.1）。
//   5. debug 模式：_debug 诊断块含 id / 原始枚举（合法），断言放行。
//
// 这消费了 WritingRequestContext.visibilityMode——此前为死代码（W6 闭合）。
// 使用真实 :memory: WritingStore，不依赖 Core / LLM。
// =============================================================================

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { SQLiteWritingStore } from '../../src/writing/repositories/writing-store.js';
import { AuditService } from '../../src/writing/services/audit-service.js';
import { ProjectService } from '../../src/writing/services/project-service.js';
import { makeRequestContext } from '../../src/writing/services/context.js';
import { findForbiddenField } from '../../src/writing/view-models/filter.js';
import type { ProjectHomeViewModel } from '../../src/writing/view-models/project-home.js';

describe('W6-b ProjectService.getProjectHomeView 投影接线', () => {
  let store: SQLiteWritingStore;
  let projectService: ProjectService;
  let projectId: string;

  beforeEach(() => {
    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    store = new SQLiteWritingStore(db);
    store.createTables();
    const audit = new AuditService(store);
    projectService = new ProjectService(store, audit);

    // 项目（默认 planning/planning，这里推进到 drafting/writing 以覆盖非平凡标签）
    const project = store.createProject('长庚站纪事', '一个灰域科幻故事');
    store.updateProject(project.id, { status: 'drafting', workspaceMode: 'writing' });
    projectId = project.id;

    // 两条草案：一条有标题，一条无标题（测 '(无标题)' 兜底）
    store.createDraft(projectId, { kind: 'event', title: '第一幕：黑晶碎片发热', content: '沈笙触碰碎片…' });
    store.createDraft(projectId, { kind: 'scene', content: '站台远景描写…' });

    // 一个未解决待确认事项（listPendingDecisions 只返回 status='open'）
    store.createDecision(projectId, { kind: 'confirm_proposal', title: '是否提交「黑晶碎片发热」事件？' });

    // 候选实体 ×1（计入）+ 已注册实体 ×1（不计入 candidate 队列）
    store.createEntitySketch(projectId, { displayName: '黑晶碎片', typeLabel: '物品', status: 'candidate' });
    store.createEntitySketch(projectId, { displayName: '沈笙', typeLabel: '角色', status: 'registered' });
  });

  it('normal 模式：返回人话 ViewModel，无 id/枚举/Core 引用泄漏（§9.1）', () => {
    const ctx = makeRequestContext({ projectId, visibilityMode: 'normal' });
    const vm: ProjectHomeViewModel = projectService.getProjectHomeView(ctx);

    // 人话字段
    expect(vm.projectTitle).toBe('长庚站纪事');
    expect(vm.projectStatusLabel).toBe('写作中');
    expect(vm.workspaceModeLabel).toBe('写作');
    expect(vm.candidateEntityCount).toBe(1); // 仅 candidate，registered 不计

    // 草案项：有标题 / 无标题兜底
    expect(vm.recentDrafts).toHaveLength(2);
    const titled = vm.recentDrafts.find((d) => d.title === '第一幕：黑晶碎片发热')!;
    expect(titled).toBeTruthy();
    expect(titled.statusLabel).toBe('起草中'); // createDraft 默认 status='drafting'
    const untitled = vm.recentDrafts.find((d) => d.title === '(无标题)')!;
    expect(untitled).toBeTruthy();

    // 待确认事项项：标签化
    expect(vm.pendingDecisions).toHaveLength(1);
    expect(vm.pendingDecisions[0]!.title).toBe('是否提交「黑晶碎片发热」事件？');
    expect(vm.pendingDecisions[0]!.kindLabel).toBe('提案审核');

    // 结构纯净：草案/决策项只含人话键，绝无 id
    expect(Object.keys(titled).sort()).toEqual(['statusLabel', 'title', 'updatedAt']);
    expect(Object.keys(vm.pendingDecisions[0]!).sort()).toEqual(['kindLabel', 'title']);

    // 顶级不泄漏原始 project 对象或 id
    expect((vm as Record<string, unknown>).project).toBeUndefined();
    expect((vm as Record<string, unknown>).id).toBeUndefined();
    expect(vm._debug).toBeUndefined();

    // §9.1 全表扫描：整个 ViewModel 无 Core ID / 谓词 / 表名等技术字段
    expect(findForbiddenField(vm, 'normal')).toBeNull();
    // 序列化后也不含任何 Core 内部前缀（兜底校验）
    const json = JSON.stringify(vm);
    expect(json).not.toMatch(/ent_|fct_|evt_|thd_|kno_|req_|writing_[a-z_]+/);
  });

  it('debug 模式：附带 _debug 诊断块（含 id / 原始枚举），断言放行', () => {
    const ctx = makeRequestContext({ projectId, visibilityMode: 'debug' });
    const vm = projectService.getProjectHomeView(ctx);

    expect(vm._debug).toBeDefined();
    expect(vm._debug!.projectId).toBe(projectId);
    expect(vm._debug!.projectStatus).toBe('drafting');
    expect(vm._debug!.workspaceMode).toBe('writing');
    expect(vm._debug!.draftIds).toHaveLength(2);
    expect(vm._debug!.pendingDecisionIds).toHaveLength(1);

    // debug 模式合法携带 id/枚举——过滤器放行（不误报）
    expect(findForbiddenField(vm, 'debug')).toBeNull();
  });

  it('listAuthorGoals：normal 模式应用 §9.1 过滤（§7.2 步骤 2），合法字段保留', () => {
    store.createGoal(projectId, '主角弧光：从怀疑到承担', 'goal', 'high', 'character');

    const ctxNormal = makeRequestContext({ projectId, visibilityMode: 'normal' });
    const goals = projectService.listAuthorGoals(ctxNormal);

    expect(goals).toHaveLength(1);
    // 合法字段保留（text / kind 不属 §9.1 禁止范畴）
    expect(goals[0]!.text).toBe('主角弧光：从怀疑到承担');
    expect(goals[0]!.kind).toBe('goal');
    // normal 模式出口经 §9.1 过滤——无技术字段泄漏
    expect(findForbiddenField(goals, 'normal')).toBeNull();
  });
});

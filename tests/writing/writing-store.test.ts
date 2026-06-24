// =============================================================================
// WritingStore 快速验证测试
// =============================================================================
// 验证 11 张 writing_* 表建表 + 完整 CRUD 闭环。
// 使用 :memory: SQLite 数据库，不依赖 Core。
// =============================================================================

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { SQLiteWritingStore } from '../../src/writing/repositories/writing-store.js';
import { WritingError, WritingErrorCode } from '../../src/writing/errors/error-codes.js';

describe('WritingStore 建表验证', () => {
  let db: Database.Database;
  let store: SQLiteWritingStore;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    store = new SQLiteWritingStore(db);
    store.createTables();
  });

  // =============================================================================
  // 建表验证 — 确认 11 张表全部创建
  // =============================================================================

  it('16 张表全部创建成功（13 原 + 3 Phase 8）', () => {
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'writing_%' ORDER BY name"
    ).all() as Array<{ name: string }>;

    const names = tables.map(t => t.name);
    expect(names).toContain('writing_projects');
    expect(names).toContain('writing_author_goals');
    expect(names).toContain('writing_idea_cards');
    expect(names).toContain('writing_blueprints');
    expect(names).toContain('writing_drafts');
    expect(names).toContain('writing_entity_sketches');
    expect(names).toContain('writing_pending_decisions');
    expect(names).toContain('writing_proposal_views');
    expect(names).toContain('writing_audit_logs');
    expect(names).toContain('writing_core_refs');
    expect(names).toContain('writing_jobs');
    // W12 §3.1：工作台布局 + 项目级偏好容器（与项目 1:1）
    expect(names).toContain('writing_workspace_layouts');
    expect(names).toContain('writing_project_preferences');
    // Phase 8：关系候选 + 创作关联 + 检测提示
    expect(names).toContain('writing_relations');
    expect(names).toContain('writing_associations');
    expect(names).toContain('writing_relation_hints');
    expect(tables.length).toBe(16);
  });

  // =============================================================================
  // WritingProject CRUD
  // =============================================================================

  it('创建和查询作品项目', () => {
    const project = store.createProject('灰域科幻', '一对兄妹在废弃星球首府的灰域边缘求生');

    expect(project.id).toMatch(/^wprj_/);
    expect(project.title).toBe('灰域科幻');
    expect(project.premise).toBe('一对兄妹在废弃星球首府的灰域边缘求生');
    expect(project.status).toBe('planning');
    expect(project.workspaceMode).toBe('planning');
    expect(project.deletedAt).toBeUndefined();

    // 查询
    const found = store.getProject(project.id);
    expect(found).toBeDefined();
    expect(found!.title).toBe('灰域科幻');
  });

  it('更新作品项目状态', () => {
    const project = store.createProject('测试作品');
    store.updateProject(project.id, { status: 'drafting', workspaceMode: 'writing' });

    const updated = store.getProject(project.id);
    expect(updated!.status).toBe('drafting');
    expect(updated!.workspaceMode).toBe('writing');
  });

  it('软删除作品项目', () => {
    const project = store.createProject('待删除作品');
    store.softDeleteProject(project.id);

    const found = store.getProject(project.id);
    expect(found).toBeUndefined(); // 查询自动过滤 deleted_at
  });

  // =============================================================================
  // AuthorGoal CRUD
  // =============================================================================

  it('创建和查询作者目标', () => {
    const project = store.createProject('测试');
    const goal = store.createGoal(project.id, '不要太套路', 'avoid', 'high', 'project');

    expect(goal.id).toMatch(/^wagl_/);
    expect(goal.kind).toBe('avoid');
    expect(goal.priority).toBe('high');
    expect(goal.status).toBe('active');
  });

  // =============================================================================
  // IdeaCard CRUD
  // =============================================================================

  it('创建和查询灵感卡片', () => {
    const project = store.createProject('测试');
    const idea = store.createIdeaCard(project.id, {
      content: '沈墨有嵌合体义肢，沈笙能让灰域退缩',
      kind: 'premise',
      tags: ['主角', '能力'],
      source: 'chat',
    });

    expect(idea.id).toMatch(/^wicd_/);
    expect(idea.maturity).toBe('raw');
    expect(idea.tags).toContain('主角');

    // 按成熟度查询
    const rawIdeas = store.listIdeaCards(project.id, { maturity: 'raw' });
    expect(rawIdeas.length).toBe(1);
  });

  // =============================================================================
  // ProjectBlueprint CRUD
  // =============================================================================

  it('创建和查询蓝图', () => {
    const project = store.createProject('测试');
    const bp = store.createBlueprint(project.id, {
      entityTypes: [
        { id: 'type_char', label: '角色', status: 'accepted', aliases: [], examples: [], sourceRefs: [] },
      ],
      maturity: 'drafted',
      sourceRefs: [{ kind: 'idea', id: 'test_idea' }],
    });

    expect(bp.id).toMatch(/^wblp_/);
    expect(bp.maturity).toBe('drafted');
    expect(bp.entityTypes.length).toBe(1);

    // 查询活跃蓝图
    store.updateBlueprint(bp.id, bp.version, { maturity: 'active' });
    const active = store.getActiveBlueprint(project.id);
    expect(active).toBeDefined();
  });

  // =============================================================================
  // WritingDraft CRUD
  // =============================================================================

  it('创建和查询草案', () => {
    const project = store.createProject('测试');
    const draft = store.createDraft(project.id, {
      kind: 'event',
      title: '第一幕：灰域边缘',
      content: '长庚站的扶梯早就停了。沈墨把沈笙拉到广告牌后面...',
      sourceRefs: [{ kind: 'idea', id: 'test_idea' }],
    });

    expect(draft.id).toMatch(/^wdft_/);
    expect(draft.status).toBe('drafting');
    expect(draft.kind).toBe('event');
  });

  it('草案状态流转', () => {
    const project = store.createProject('测试');
    const draft = store.createDraft(project.id, { kind: 'event', content: '测试内容' });
    expect(draft.version).toBe(1); // W3：乐观锁版本号初始为 1

    // drafting → ready_to_simulate（用返回的新版本号串联，避免下一次写入版本过期）
    let v = store.updateDraft(draft.id, draft.version, { status: 'ready_to_simulate' }).newVersion;
    expect(store.getDraft(draft.id)!.status).toBe('ready_to_simulate');

    // ready_to_simulate → simulated
    v = store.updateDraft(draft.id, v, { status: 'simulated' }).newVersion;
    expect(store.getDraft(draft.id)!.status).toBe('simulated');

    // simulated → committed（审核生命周期由 ProposalView.status 管理）
    store.updateDraft(draft.id, v, { status: 'committed' });
    expect(store.getDraft(draft.id)!.status).toBe('committed');
    expect(store.getDraft(draft.id)!.version).toBe(4); // 三次更新：1→2→3→4
  });

  // =============================================================================
  // WritingEntitySketch CRUD
  // =============================================================================

  it('创建和查询候选实体', () => {
    const project = store.createProject('测试');
    const hint = store.createEntitySketch(project.id, {
      displayName: '沈墨',
      typeLabel: '角色',
      status: 'hint',
      sourceRefs: [{ kind: 'chat', id: 'test_msg' }],
    });

    expect(hint.status).toBe('hint');

    // hint → candidate
    store.updateEntitySketch(hint.id, { status: 'candidate' });
    expect(store.getEntitySketch(hint.id)!.status).toBe('candidate');

    // candidate → approved
    store.updateEntitySketch(hint.id, { status: 'approved' });
    expect(store.getEntitySketch(hint.id)!.status).toBe('approved');
  });

  it('按名称查找候选实体（合并检测）', () => {
    const project = store.createProject('测试');
    store.createEntitySketch(project.id, { displayName: '沈墨', status: 'candidate' });
    store.createEntitySketch(project.id, { displayName: '沈墨', status: 'candidate' });
    store.createEntitySketch(project.id, { displayName: '沈笙', status: 'hint' });

    const duplicates = store.findEntitySketchesByName(project.id, '沈墨');
    expect(duplicates.length).toBe(2);
  });

  // =============================================================================
  // PendingDecision CRUD
  // =============================================================================

  it('创建和解决待确认事项', () => {
    const project = store.createProject('测试');
    const draft = store.createDraft(project.id, { kind: 'event', content: '测试' });

    const decision = store.createDecision(project.id, {
      kind: 'confirm_draft',
      title: '确认提交事件草案',
      linkedObjectId: draft.id,
      linkedObjectType: 'draft',
    });

    expect(decision.status).toBe('open');
    expect(decision.kind).toBe('confirm_draft');

    // 待确认列表
    const pending = store.listPendingDecisions(project.id);
    expect(pending.length).toBe(1);

    // 解决
    store.resolveDecision(decision.id, 'resolved', '作者确认提交');
    expect(store.getDecision(decision.id)!.status).toBe('resolved');

    // 解决后 pending 列表为空
    const afterResolve = store.listPendingDecisions(project.id);
    expect(afterResolve.length).toBe(0);
  });

  // =============================================================================
  // WritingProposalView CRUD
  // =============================================================================

  it('创建和流转审核视图', () => {
    const project = store.createProject('测试');
    const draft = store.createDraft(project.id, { kind: 'event', content: '测试内容' });

    const pv = store.createProposalView(project.id, {
      proposalType: 'event',
      sourceDraftId: draft.id,
    });

    expect(pv.status).toBe('open');
    expect(pv.proposalType).toBe('event');

    // open → author_approved（用户确认）
    store.updateProposalView(pv.id, {
      status: 'author_approved',
      authorDecision: '确认提交',
    });
    expect(store.getProposalView(pv.id)!.status).toBe('author_approved');

    // 查找草案关联的活跃审核视图
    const activeView = store.getActiveProposalViewForDraft(draft.id);
    expect(activeView).toBeDefined();

    // author_approved → committed（CoreBridge 成功）
    store.updateProposalView(pv.id, {
      status: 'committed',
      coreEventId: 'mock_evt_test',
      humanSummary: '沈墨和沈笙在长庚站发现黑晶碎片发热',
      factDiff: [{ op: 'new', humanDescription: '沈笙位置 = 废弃站台', entityName: '沈笙', predicateLabel: '位置', newValue: '废弃站台' }],
    });
    expect(store.getProposalView(pv.id)!.status).toBe('committed');
  });

  // =============================================================================
  // AuditLog CRUD
  // =============================================================================

  it('记录和查询审计日志', () => {
    const project = store.createProject('测试');

    store.recordAudit({
      projectId: project.id,
      action: 'create_draft',
      targetType: 'draft',
      targetId: 'wdft_test',
      triggerSource: 'author_action',
      result: 'success',
    });

    store.recordAudit({
      projectId: project.id,
      action: 'commit_proposal',
      targetType: 'proposal_view',
      targetId: 'wpvw_test',
      triggerSource: 'review_decision',
      result: 'failure',
      errorCode: 'COREBRIDGE_COMMIT_FAILED',
    });

    const allLogs = store.queryAuditLogs(project.id);
    expect(allLogs.length).toBe(2);

    const failures = store.queryAuditLogs(project.id, { action: 'commit_proposal' });
    expect(failures.length).toBe(1);
    expect(failures[0]!.errorCode).toBe('COREBRIDGE_COMMIT_FAILED');
  });

  // =============================================================================
  // CoreRef CRUD
  // =============================================================================

  it('创建和查询 Core 引用', () => {
    const project = store.createProject('测试');

    store.createCoreRef(project.id, {
      writingObjectType: 'entity_sketch',
      writingObjectId: 'wesk_test',
      coreObjectType: 'entity',
      coreObjectId: 'ent_test',
    });

    const refs = store.getCoreRefsByWritingObject('entity_sketch', 'wesk_test');
    expect(refs.length).toBe(1);
    expect(refs[0]!.coreObjectId).toBe('ent_test');

    // 反向查询
    const byCore = store.getCoreRefsByCoreObject('entity', 'ent_test');
    expect(byCore.length).toBe(1);
  });

  // =============================================================================
  // 软删除验证
  // =============================================================================

  it('软删除后查询过滤', () => {
    const project = store.createProject('测试');
    const draft1 = store.createDraft(project.id, { kind: 'event', content: '保留' });
    const draft2 = store.createDraft(project.id, { kind: 'setting', content: '删除' });

    // 软删除第二个
    const stmt = db.prepare("UPDATE writing_drafts SET deleted_at = datetime('now') WHERE id = ?");
    stmt.run(draft2.id);

    const all = store.listDrafts(project.id);
    expect(all.length).toBe(1);
    expect(all[0]!.id).toBe(draft1.id);
  });

  // =============================================================================
  // 完整闭合流程
  // =============================================================================

  it('端到端：创建项目→灵感→蓝图→草案→候选实体→审核→审计', () => {
    // 1. 创建作品
    const project = store.createProject('灰域科幻', '一对兄妹在灰域边缘求生');
    expect(project.status).toBe('planning');

    // 2. 保存灵感
    const idea = store.createIdeaCard(project.id, {
      content: '沈墨有嵌合体义肢，沈笙能让灰域退缩',
      kind: 'premise',
      tags: ['主角'],
    });
    expect(idea.maturity).toBe('raw');

    // 3. 创建蓝图
    const bp = store.createBlueprint(project.id, {
      entityTypes: [
        { id: 'type_char', label: '角色', status: 'accepted', aliases: [], examples: [], sourceRefs: [] },
      ],
    });
    store.updateBlueprint(bp.id, bp.version, { maturity: 'active' });

    // 4. 创建草案
    const draft = store.createDraft(project.id, {
      kind: 'event',
      title: '第一幕：发现黑晶碎片',
      content: '长庚站的扶梯早就停了...',
    });
    store.updateDraft(draft.id, draft.version, { status: 'simulated' });

    // 5. 候选实体
    const shenmo = store.createEntitySketch(project.id, {
      displayName: '沈墨', typeLabel: '角色', status: 'candidate',
    });
    store.updateEntitySketch(shenmo.id, { status: 'approved' });

    // 6. 创建审核视图
    const pv = store.createProposalView(project.id, {
      proposalType: 'event', sourceDraftId: draft.id,
    });
    store.updateProposalView(pv.id, { status: 'author_approved' });

    // 7. 创建待确认事项
    const decision = store.createDecision(project.id, {
      kind: 'confirm_proposal',
      title: '确认提交事件',
      linkedObjectId: pv.id,
      linkedObjectType: 'proposal_view',
    });

    // 8. 作者确认 → 提交
    store.resolveDecision(decision.id, 'resolved', '确认');
    store.updateProposalView(pv.id, {
      status: 'committed',
      coreEventId: 'evt_test',
    });
    // 草案在步骤4已更新过一次（version 1→2），此处须用最新版本号
    store.updateDraft(draft.id, store.getDraft(draft.id)!.version, { status: 'committed' });

    // 9. Core 引用
    store.createCoreRef(project.id, {
      writingObjectType: 'draft', writingObjectId: draft.id,
      coreObjectType: 'event', coreObjectId: 'evt_test',
    });

    // 10. 审计记录
    store.recordAudit({
      projectId: project.id,
      action: 'commit_proposal',
      targetType: 'proposal_view',
      targetId: pv.id,
      result: 'success',
    });

    // 验证终态
    expect(store.getDraft(draft.id)!.status).toBe('committed');
    expect(store.getProposalView(pv.id)!.status).toBe('committed');
    expect(store.listPendingDecisions(project.id).length).toBe(0);

    const auditLogs = store.queryAuditLogs(project.id);
    const commitLog = auditLogs.find(l => l.action === 'commit_proposal');
    expect(commitLog).toBeDefined();
    expect(commitLog!.result).toBe('success');
  });
});

// =============================================================================
// W14：sourceRefs 持久化（ProposalView + AuditLog）+ resolveDecision 结构化错误码
// =============================================================================
// 验证三件事：
//   1. createProposalView 的 sourceRefs 经 source_refs_json 列往返保持（§4 SourceRef / §30.1 数据模型对齐）
//   2. recordAudit 的 sourceRefs 同上（审计来源追溯——"本次动作由哪个草案/灵感触发"）
//   3. resolveDecision 对非 open 状态抛 WritingError(INVALID_STATUS_TRANSITION)，而非裸 Error
//      （W14：激活"无 throw 点的裸 Error → 结构化错误码"路径，调用方可按码分流恢复动作）
// =============================================================================

describe('W14 · sourceRefs 持久化 + resolveDecision 错误码', () => {
  let db: Database.Database;
  let store: SQLiteWritingStore;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    store = new SQLiteWritingStore(db);
    store.createTables();
  });

  it('createProposalView 持久化 sourceRefs（传入/不传入往返）', () => {
    const project = store.createProject('测试');
    const draft = store.createDraft(project.id, { kind: 'event', content: 'c' });

    // 传入多源 sourceRefs → 经 source_refs_json 列原样读回
    const pv = store.createProposalView(project.id, {
      proposalType: 'event',
      sourceDraftId: draft.id,
      sourceRefs: [
        { kind: 'draft', id: draft.id },
        { kind: 'idea', id: 'wid_upstream' },
      ],
    });
    expect(pv.sourceRefs).toEqual([
      { kind: 'draft', id: draft.id },
      { kind: 'idea', id: 'wid_upstream' },
    ]);
    // 重新查询（走 rowToProposalView 映射）仍保持
    const reloaded = store.getProposalView(pv.id)!;
    expect(reloaded.sourceRefs).toEqual([
      { kind: 'draft', id: draft.id },
      { kind: 'idea', id: 'wid_upstream' },
    ]);

    // 不传 sourceRefs → 默认空数组（既有调用方零改不破）
    const pvEmpty = store.createProposalView(project.id, { proposalType: 'event' });
    expect(pvEmpty.sourceRefs).toEqual([]);
  });

  it('recordAudit 持久化 sourceRefs（传入/不传入往返）', () => {
    const project = store.createProject('测试');

    // 传入 sourceRefs（本次提交由某草案触发）→ 经 source_refs_json 列原样读回
    const log = store.recordAudit({
      projectId: project.id,
      action: 'commit_proposal',
      targetType: 'proposal_view',
      targetId: 'wpvw_src',
      triggerSource: 'review_decision',
      result: 'success',
      sourceRefs: [{ kind: 'draft', id: 'wdft_src' }],
    });
    expect(log.sourceRefs).toEqual([{ kind: 'draft', id: 'wdft_src' }]);
    const reloaded = store.getAuditLog(log.id)!;
    expect(reloaded.sourceRefs).toEqual([{ kind: 'draft', id: 'wdft_src' }]);

    // 不传 → 默认空数组（既有 recordAudit 调用方零改不破）
    const logEmpty = store.recordAudit({
      projectId: project.id,
      action: 'create_draft',
      targetType: 'draft',
    });
    expect(logEmpty.sourceRefs).toEqual([]);
  });

  it('resolveDecision 对非 open 状态抛 WritingError(INVALID_STATUS_TRANSITION)', () => {
    const project = store.createProject('测试');
    const decision = store.createDecision(project.id, {
      kind: 'confirm_draft',
      title: '确认提交',
    });
    expect(decision.status).toBe('open');

    // 先正常 resolve（open → resolved）
    store.resolveDecision(decision.id, 'resolved', '一次');
    expect(store.getDecision(decision.id)!.status).toBe('resolved');

    // 再对已 resolved 的决策 resolve → UPDATE WHERE status='open' 命中 0 行 → 抛结构化错误码
    // （W14：此前为裸 Error，调用方无法按码分流；现经 ERROR_RECOVERY_MAP 出"当前状态不允许此操作"人话）
    try {
      store.resolveDecision(decision.id, 'resolved', '二次');
      throw new Error('应抛错但未抛');
    } catch (e) {
      expect(e).toBeInstanceOf(WritingError);
      expect((e as WritingError).code).toBe(WritingErrorCode.INVALID_STATUS_TRANSITION);
    }
  });
});

// =============================================================================
// WritingStore 快速验证测试
// =============================================================================
// 验证 11 张 writing_* 表建表 + 完整 CRUD 闭环。
// 使用 :memory: SQLite 数据库，不依赖 Core。
// =============================================================================

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { SQLiteWritingStore } from '../../src/writing/repositories/writing-store.js';

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

  it('11 张表全部创建成功', () => {
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
    expect(tables.length).toBe(11);
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
    store.updateBlueprint(bp.id, { maturity: 'active' });
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

    // drafting → ready_to_simulate
    store.updateDraft(draft.id, { status: 'ready_to_simulate' });
    expect(store.getDraft(draft.id)!.status).toBe('ready_to_simulate');

    // ready_to_simulate → simulated
    store.updateDraft(draft.id, { status: 'simulated' });
    expect(store.getDraft(draft.id)!.status).toBe('simulated');

    // simulated → committed（审核生命周期由 ProposalView.status 管理）
    store.updateDraft(draft.id, { status: 'committed' });
    expect(store.getDraft(draft.id)!.status).toBe('committed');
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
    store.updateBlueprint(bp.id, { maturity: 'active' });

    // 4. 创建草案
    const draft = store.createDraft(project.id, {
      kind: 'event',
      title: '第一幕：发现黑晶碎片',
      content: '长庚站的扶梯早就停了...',
    });
    store.updateDraft(draft.id, { status: 'simulated' });

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
    store.updateDraft(draft.id, { status: 'committed' });

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

// =============================================================================
// Phase 11 测试：ForeshadowingService + ReaderService
// =============================================================================

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { SQLiteWritingStore } from '../../src/writing/repositories/writing-store.js';
import { AuditService } from '../../src/writing/services/audit-service.js';
import { ForeshadowingService } from '../../src/writing/services/foreshadowing-service.js';
import { ReaderService } from '../../src/writing/services/reader-service.js';
import { makeRequestContext } from '../../src/writing/services/context.js';
import type { WritingRequestContext } from '../../src/writing/services/context.js';

describe('Phase 11 · ForeshadowingService', () => {
  let store: SQLiteWritingStore;
  let service: ForeshadowingService;
  let ctx: WritingRequestContext;
  let projectId: string;

  beforeEach(() => {
    const db = new Database(':memory:');
    store = new SQLiteWritingStore(db);
    store.createTables();
    service = new ForeshadowingService(store, new AuditService(store));
    projectId = store.createProject('伏笔测试').id;
    ctx = makeRequestContext({ projectId, trigger: 'author_action' });
  });

  it('创建伏笔计划', () => {
    const plan = service.createForeshadowingPlan(ctx, { label: '诛仙剑秘密', kind: 'clue', targetReaderEffect: '好奇来源' });
    expect(plan.id).toMatch(/^wfp_/);
    expect(plan.label).toBe('诛仙剑秘密');
    expect(plan.kind).toBe('clue');
    expect(plan.status).toBe('planned');
  });

  it('更新伏笔状态', () => {
    const plan = service.createForeshadowingPlan(ctx, { label: 'A', kind: 'suspense', targetReaderEffect: '紧张' });
    service.updateForeshadowingPlanStatus(ctx, plan.id, 'active');
    expect(store.getForeshadowingPlan(plan.id)!.status).toBe('active');
  });

  it('创建暗示节点', () => {
    const plan = service.createForeshadowingPlan(ctx, { label: 'A', kind: 'clue', targetReaderEffect: '好奇' });
    const hint = service.createHintOccurrence(ctx, { foreshadowingPlanId: plan.id, intensity: 'subtle', visibility: 'reader_visible', chapterId: 'ch_1' });
    expect(hint.id).toMatch(/^who_/);
    expect(hint.intensity).toBe('subtle');
  });

  it('创建回收计划', () => {
    const plan = service.createForeshadowingPlan(ctx, { label: 'A', kind: 'clue', targetReaderEffect: '好奇' });
    const payoff = service.createPayoffPlan(ctx, { foreshadowingPlanId: plan.id, kind: 'truth_reveal', targetChapterId: 'ch_5' });
    expect(payoff.id).toMatch(/^wpp_/);
    expect(payoff.kind).toBe('truth_reveal');
  });

  it('创建揭示计划', () => {
    const reveal = service.createRevealPlan(ctx, { label: '诛仙剑真相', subjectDescription: '剑的来历和力量来源' });
    expect(reveal.id).toMatch(/^wrp_/);
    expect(reveal.label).toBe('诛仙剑真相');
    expect(reveal.status).toBe('planned');
  });

  it('更新揭示计划状态', () => {
    const reveal = service.createRevealPlan(ctx, { label: 'A', subjectDescription: '测试' });
    service.updateRevealPlanStatus(ctx, reveal.id, 'executing');
    expect(store.getRevealPlan(reveal.id)!.status).toBe('executing');
  });

  it('创建揭示里程碑', () => {
    const reveal = service.createRevealPlan(ctx, { label: 'A', subjectDescription: '测试' });
    const milestone = service.createRevealMilestone(ctx, { revealPlanId: reveal.id, kind: 'first_hint', description: '第一次暗示', chapterId: 'ch_1' });
    expect(milestone.id).toMatch(/^wrm_/);
    expect(milestone.kind).toBe('first_hint');
  });

  // A1 修复回归：list 入口存在且按项目隔离（此前 Tool 20 恒返回空数组）
  it('listForeshadowingPlans 按项目返回伏笔计划', () => {
    service.createForeshadowingPlan(ctx, { label: '伏笔一', kind: 'clue', targetReaderEffect: '好奇' });
    service.createForeshadowingPlan(ctx, { label: '伏笔二', kind: 'suspense', targetReaderEffect: '紧张' });
    const plans = service.listForeshadowingPlans(ctx);
    expect(plans).toHaveLength(2);
    expect(plans.map(p => p.label).sort()).toEqual(['伏笔一', '伏笔二']);
  });

  it('listRevealPlans 按项目返回揭示计划', () => {
    service.createRevealPlan(ctx, { label: '揭示一', subjectDescription: '甲' });
    service.createRevealPlan(ctx, { label: '揭示二', subjectDescription: '乙' });
    const reveals = service.listRevealPlans(ctx);
    expect(reveals).toHaveLength(2);
  });

  it('list 按项目隔离，不跨项目泄漏', () => {
    service.createForeshadowingPlan(ctx, { label: '本项目伏笔', kind: 'clue', targetReaderEffect: '好奇' });
    // 另一个项目
    const otherProjectId = store.createProject('其他项目').id;
    const otherCtx = makeRequestContext({ projectId: otherProjectId, trigger: 'author_action' });
    service.createForeshadowingPlan(otherCtx, { label: '他项目伏笔', kind: 'clue', targetReaderEffect: '好奇' });
    const plans = service.listForeshadowingPlans(ctx);
    expect(plans).toHaveLength(1);
    expect(plans[0]!.label).toBe('本项目伏笔');
  });
});

describe('Phase 11 · ReaderService', () => {
  let store: SQLiteWritingStore;
  let service: ReaderService;
  let ctx: WritingRequestContext;
  let projectId: string;

  beforeEach(() => {
    const db = new Database(':memory:');
    store = new SQLiteWritingStore(db);
    store.createTables();
    service = new ReaderService(store, new AuditService(store));
    projectId = store.createProject('读者测试').id;
    ctx = makeRequestContext({ projectId, trigger: 'author_action' });
  });

  it('创建读者群体', () => {
    const audience = service.createAudience(ctx, { label: '目标读者', kind: 'target_reader' });
    expect(audience.id).toMatch(/^wra_/);
    expect(audience.kind).toBe('target_reader');
  });

  it('获取或创建默认读者', () => {
    const first = service.getOrCreateDefaultAudience(ctx);
    const second = service.getOrCreateDefaultAudience(ctx);
    expect(first.id).toBe(second.id);
  });

  it('创建读者认知状态', () => {
    const audience = service.createAudience(ctx, { label: '测试', kind: 'target_reader' });
    const ks = service.createKnowledgeState(ctx, { audienceId: audience.id, subjectRef: 'ent_zhangsan', state: 'known', narrativePositionType: 'chapter', narrativePositionId: 'ch_1' });
    expect(ks.id).toMatch(/^wrks_/);
    expect(ks.state).toBe('known');
  });

  it('更新读者认知状态', () => {
    const audience = service.createAudience(ctx, { label: '测试', kind: 'target_reader' });
    const ks = service.createKnowledgeState(ctx, { audienceId: audience.id, subjectRef: 'ent_zhangsan', state: 'hinted', narrativePositionType: 'chapter', narrativePositionId: 'ch_1' });
    service.updateKnowledgeState(ctx, ks.id, 'revealed', 0.9);
    const states = store.listReaderKnowledgeStates(audience.id);
    expect(states[0]!.state).toBe('revealed');
  });
});

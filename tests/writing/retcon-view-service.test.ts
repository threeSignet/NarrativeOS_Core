// =============================================================================
// Phase 12 测试：RetconViewService——Retcon 影响报告（§10.5）
// =============================================================================

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { SQLiteWritingStore } from '../../src/writing/repositories/writing-store.js';
import { AuditService } from '../../src/writing/services/audit-service.js';
import { ForeshadowingService } from '../../src/writing/services/foreshadowing-service.js';
import { RetconViewService } from '../../src/writing/services/retcon-view-service.js';
import { makeRequestContext } from '../../src/writing/services/context.js';
import type { WritingRequestContext } from '../../src/writing/services/context.js';

describe('Phase 12 · RetconViewService', () => {
  let store: SQLiteWritingStore;
  let service: RetconViewService;
  let ctx: WritingRequestContext;

  beforeEach(() => {
    const db = new Database(':memory:');
    store = new SQLiteWritingStore(db);
    store.createTables();
    service = new RetconViewService(store, new AuditService(store));
    const projectId = store.createProject('Retcon视图测试').id;
    ctx = makeRequestContext({ projectId, trigger: 'author_action' });
  });

  it('buildRetconImpactReport 从 proposal 投影出受影响节点', () => {
    const report = service.buildRetconImpactReport(ctx, {
      proposalId: 'rtc_event1_1_01',
      affectedFactIds: ['fct_1', 'fct_2'],
      affectedEventIds: ['evt_2'],
      affectedThreadIds: ['thr_1'],
    });

    expect(report.id).toMatch(/^wrr_/);
    expect(report.status).toBe('pending');
    expect(report.retconProposalId).toBe('rtc_event1_1_01');
    // 2 fact + 1 event + 1 thread = 4 节点
    expect(report.affectedNodes).toHaveLength(4);
    expect(report.affectedNodes.filter(n => n.kind === 'fact')).toHaveLength(2);
    expect(report.affectedNodes.find(n => n.kind === 'thread')).toBeDefined();
  });

  it('受影响 fact 标记为 contested（需重新裁决）', () => {
    const report = service.buildRetconImpactReport(ctx, {
      proposalId: 'p1',
      affectedFactIds: ['fct_1'],
      affectedEventIds: [],
    });
    const factNode = report.affectedNodes.find(n => n.kind === 'fact')!;
    expect(factNode.effect).toBe('contested');
    expect(factNode.reason).toBeTruthy();
  });

  it('重检项包含关联受影响实体的伏笔计划', () => {
    // 预置一个伏笔计划，关联实体 ent_a
    const foreshadowService = new ForeshadowingService(store, new AuditService(store));
    foreshadowService.createForeshadowingPlan(ctx, {
      label: '主角秘密', kind: 'clue', targetReaderEffect: '好奇',
      linkedEntityRefs: ['ent_a'],
    });

    const report = service.buildRetconImpactReport(ctx, {
      proposalId: 'p1',
      affectedFactIds: [],
      affectedEventIds: [],
      affectedKnowledgeEntityIds: ['ent_a'], // ent_a 受影响
    });

    const foreshadowRecheck = report.recheckList.find(r => r.targetType === 'foreshadowing_plan');
    expect(foreshadowRecheck).toBeDefined();
    expect(foreshadowRecheck!.label).toBe('主角秘密');
  });

  it('确认前不改变正式状态（pending + 只读）', () => {
    const report = service.buildRetconImpactReport(ctx, {
      proposalId: 'p1',
      affectedFactIds: ['fct_1'],
      affectedEventIds: [],
    });
    expect(report.status).toBe('pending');
    // 验证 Core factStore 不受影响（本 service 不持有 factStore 引用）
    expect(report.affectedNodes).toBeDefined();
  });

  it('updateReportStatus 推进状态', () => {
    const report = service.buildRetconImpactReport(ctx, {
      proposalId: 'p1', affectedFactIds: [], affectedEventIds: [],
    });
    service.updateReportStatus(ctx, report.id, 'confirmed');
    const refreshed = service.getReport(ctx, report.id);
    expect(refreshed.status).toBe('confirmed');
    expect(refreshed.confirmedAt).toBeTruthy();
  });

  it('getReportByProposal 按 proposal 查最新', () => {
    service.buildRetconImpactReport(ctx, {
      proposalId: 'p1', affectedFactIds: ['fct_1'], affectedEventIds: [],
    });
    const latest = service.buildRetconImpactReport(ctx, {
      proposalId: 'p1', affectedFactIds: ['fct_1', 'fct_2'], affectedEventIds: [],
    });
    const found = service.getReportByProposal('p1');
    expect(found!.id).toBe(latest.id); // 最新那个
  });

  it('summary 包含受影响项计数', () => {
    const report = service.buildRetconImpactReport(ctx, {
      proposalId: 'p1',
      affectedFactIds: ['fct_1', 'fct_2'],
      affectedEventIds: ['evt_1'],
      affectedThreadIds: ['thr_1'],
    });
    expect(report.summary).toContain('2 个事实');
    expect(report.summary).toContain('1 个下游事件');
    expect(report.summary).toContain('1 个线索');
  });
});

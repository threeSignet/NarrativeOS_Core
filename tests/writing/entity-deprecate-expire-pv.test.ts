// =============================================================================
// W17 测试：deprecateEntitySketch 废弃时 expire 关联 ProposalView + PendingDecision
// =============================================================================
// 验证 Phase7-Refinement §7.6 deprecateEntitySketch 主流程4：
//   「如果此实体有活跃的审核视图：找到并 expire 关联的 ProposalView + PendingDecision」
//
// 覆盖：
//   1. 废弃 hint/approved 实体 + 存在活跃实体类 PV → PV expired + 关联 PendingDecision expired
//   2. 无关联 PV → 正常废弃，无副作用（防御性）
//   3. 只 expire 活跃 PV（open/author_approved）；已 committed 的 PV 不受影响
//   4. registered/merged 实体 → 抛错（§7.6 错误路径，回归保护）
//
// 使用真实 EntityService + store/audit/workflow（:memory:），无 Core/LLM。
// 实体类 PV（sourceEntitySketchId）当前无 service 创建路径（registerReviewedEntity 未物化 PV），
// 故测试直接用 store.createProposalView 预置，验证 expire 逻辑正确性——这与 abandonDraft
// 经 getActiveProposalViewForDraft expire 草案类 PV 完全对称。
// =============================================================================

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { SQLiteWritingStore } from '../../src/writing/repositories/writing-store.js';
import { AuditService } from '../../src/writing/services/audit-service.js';
import { WorkflowService } from '../../src/writing/services/workflow-service.js';
import { EntityService } from '../../src/writing/services/entity-service.js';
import { makeRequestContext } from '../../src/writing/services/context.js';

describe('W17 deprecateEntitySketch expire 关联 ProposalView', () => {
  let db: Database.Database;
  let store: SQLiteWritingStore;
  let workflow: WorkflowService;
  let entityService: EntityService;
  let projectId: string;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    store = new SQLiteWritingStore(db);
    store.createTables();
    const audit = new AuditService(store);
    workflow = new WorkflowService(store, audit);
    entityService = new EntityService(store, audit, workflow);
    projectId = store.createProject('W17 测试作品').id;
  });

  /** 预置一个实体草图 + 其关联的活跃 ProposalView(open) + PendingDecision */
  function setupEntityWithActivePV(status: 'hint' | 'candidate' | 'approved') {
    const sketch = store.createEntitySketch(projectId, {
      displayName: '沈墨', typeLabel: '角色', status,
    });
    // §7.6：实体类 PV 通过 sourceEntitySketchId 关联（与草案类 PV 的 sourceDraftId 对称）
    const pv = store.createProposalView(projectId, {
      proposalType: 'entity_registration',
      sourceEntitySketchId: sketch.id,
      sourceRefs: [{ kind: 'agent_observation', id: sketch.id }],
    });
    // 模拟 simulateDraft/register 流程会为 PV 创建的待确认事项
    const decision = workflow.createPendingDecision(
      makeRequestContext({ projectId }),
      {
        kind: 'confirm_entity',
        title: '确认登记实体: 沈墨',
        linkedObjectId: pv.id,
        linkedObjectType: 'proposal_view',
      },
    );
    return { sketch, pv, decision };
  }

  it('废弃 hint 实体 + 活跃 PV → PV expired + 关联 PendingDecision expired', () => {
    const { sketch, pv, decision } = setupEntityWithActivePV('hint');
    const ctx = makeRequestContext({ projectId });

    entityService.deprecateEntitySketch(ctx, sketch.id, '角色废弃');

    // 草图置 deprecated
    expect(store.getEntitySketch(sketch.id)!.status).toBe('deprecated');
    // §7.6 主流程4：关联活跃 PV 被 expire
    expect(store.getProposalView(pv.id)!.status).toBe('expired');
    // 关联 PendingDecision 同步 expire
    expect(store.getDecision(decision.id)!.status).toBe('expired');

    // 审计可观测性：expire_proposal_view + deprecate_entity 两条审计均落地
    const expireLogs = store.queryAuditLogs(projectId, { action: 'expire_proposal_view' });
    const expireLog = expireLogs.find(l => l.targetId === pv.id);
    expect(expireLog).toBeDefined();
    expect((expireLog!.detail as Record<string, unknown>).reason).toBe('entity_sketch_deprecated');
    const deprecateLogs = store.queryAuditLogs(projectId, { action: 'deprecate_entity' });
    expect(deprecateLogs.find(l => l.targetId === sketch.id)).toBeDefined();
  });

  it('无关联 PV → 正常废弃，无副作用（防御性）', () => {
    const sketch = store.createEntitySketch(projectId, {
      displayName: '李四', typeLabel: '角色', status: 'candidate',
    });
    const ctx = makeRequestContext({ projectId });

    expect(() => entityService.deprecateEntitySketch(ctx, sketch.id)).not.toThrow();
    expect(store.getEntitySketch(sketch.id)!.status).toBe('deprecated');
  });

  it('approved 实体废弃 → 关联 PV expired（状态范围 {hint,candidate,approved} 均可废弃）', () => {
    const { sketch, pv } = setupEntityWithActivePV('approved');
    const ctx = makeRequestContext({ projectId });

    entityService.deprecateEntitySketch(ctx, sketch.id);

    expect(store.getEntitySketch(sketch.id)!.status).toBe('deprecated');
    expect(store.getProposalView(pv.id)!.status).toBe('expired');
  });

  it('只 expire 活跃 PV（open/author_approved）；已 committed 的 PV 不受影响', () => {
    const sketch = store.createEntitySketch(projectId, {
      displayName: '孙七', typeLabel: '角色', status: 'approved',
    });
    // 预置一个已 committed 的实体类 PV（非活跃态）
    // 状态机校验接入 store 后，必须走合法路径 open→author_approved→committed（不能直接 open→committed）
    const committedPv = store.createProposalView(projectId, {
      proposalType: 'entity_registration',
      sourceEntitySketchId: sketch.id,
    });
    store.updateProposalView(committedPv.id, { status: 'author_approved' });
    store.updateProposalView(committedPv.id, { status: 'committed' });
    const ctx = makeRequestContext({ projectId });

    entityService.deprecateEntitySketch(ctx, sketch.id);

    // committed PV 不被误 expire——getActiveProposalViewForEntitySketch 只查 open/author_approved
    expect(store.getProposalView(committedPv.id)!.status).toBe('committed');
  });

  it('registered 实体 → 抛错（已注册实体需走 Retcon，§7.6 错误路径）', () => {
    const sketch = store.createEntitySketch(projectId, {
      displayName: '王五', typeLabel: '角色', status: 'registered',
    });
    const ctx = makeRequestContext({ projectId });

    expect(() => entityService.deprecateEntitySketch(ctx, sketch.id)).toThrow(/已注册实体不能直接废弃/);
  });

  it('merged 实体 → 抛错（终态，§7.6 错误路径）', () => {
    const sketch = store.createEntitySketch(projectId, {
      displayName: '赵六', typeLabel: '角色', status: 'merged',
    });
    const ctx = makeRequestContext({ projectId });

    expect(() => entityService.deprecateEntitySketch(ctx, sketch.id)).toThrow(/已合并的实体是终态/);
  });
});

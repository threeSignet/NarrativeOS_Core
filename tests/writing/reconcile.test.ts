// =============================================================================
// W5 测试：reconcileCommittedProposals / reconcileRegisteredEntities 启动对账
// =============================================================================
// 验证 §7.11.5 两阶段提交恢复机制：commitReviewedProposal / registerReviewedEntity
// 在 Core 写入成功但写作层回写失败（partial）时，对象停留在提交前状态（author_approved /
// approved），但 Core 已持久化对应 event/entity。reconcile 在启动时通过审计日志定位这些孤儿
// 并回写恢复（status → committed/registered + coreRef + 草案）。
//
// 关键设计：用审计日志作"Core 已写入"的持久证据（Core ProposalStore 是内存 Map，重启即丢，
// 无法用 proposal_id 反查；审计在回写前落地，detail.coreEventId/coreEntityId 是可靠线索）。
//
// 使用真实 Core（:memory: SQLite + 真实 ToolRouter），无 LLM / Embedding 依赖。
// =============================================================================

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SQLiteFactStoreAdapter } from '../../src/adapters/sqlite/fact-store.js';
import { SQLiteThreadStoreAdapter } from '../../src/adapters/sqlite/thread-store.js';
import { SQLiteKnowledgeStoreAdapter } from '../../src/adapters/sqlite/knowledge-store.js';
import { SQLiteEventStoreAdapter } from '../../src/adapters/sqlite/event-store.js';
import { ProposalManager } from '../../src/core/proposal-manager.js';
import { RuleEngine } from '../../src/core/rule-engine.js';
import { ThreadResolver } from '../../src/core/thread-resolver.js';
import { RetconEngine } from '../../src/core/retcon-engine.js';
import { ToolService } from '../../src/core/tool-service.js';
import { SchemaExtensionManager } from '../../src/core/schema-extension-manager.js';
import { ToolRouter } from '../../src/core/tool-router.js';
import { SQLiteWritingStore } from '../../src/writing/repositories/writing-store.js';
import { AuditService } from '../../src/writing/services/audit-service.js';
import { RealCoreBridge } from '../../src/writing/core-bridge/real-bridge.js';
import { makeRequestContext } from '../../src/writing/services/context.js';
import type { WritingRequestContext } from '../../src/writing/services/context.js';

describe('W5 reconcileCommittedProposals / reconcileRegisteredEntities 启动对账', () => {
  let router: ToolRouter;
  let writingStore: SQLiteWritingStore;
  let auditService: AuditService;
  let coreBridge: RealCoreBridge;
  let projectId: string;
  let ctx: WritingRequestContext;

  beforeEach(() => {
    const factStore = new SQLiteFactStoreAdapter(':memory:', 'default');
    const db = factStore.getDatabase();
    const threadStore = new SQLiteThreadStoreAdapter(db);
    const knowledgeStore = new SQLiteKnowledgeStoreAdapter(db);
    const eventStore = new SQLiteEventStoreAdapter(db);
    const threadResolver = new ThreadResolver();
    const proposalManager = new ProposalManager(new RuleEngine(), undefined, threadStore, threadResolver);
    const retconEngine = new RetconEngine();
    const toolService = new ToolService(factStore, knowledgeStore, eventStore, threadStore, threadResolver);
    const schemaExtensionManager = new SchemaExtensionManager(db);
    router = new ToolRouter({ proposalManager, retconEngine, toolService, schemaExtensionManager, factStore, knowledgeStore, eventStore, threadStore });

    db.exec(`INSERT INTO entities (id, name, kind, first_appearance) VALUES ('ent_hero', '主角', 'entity', 1)`);

    writingStore = new SQLiteWritingStore(db);
    writingStore.createTables();
    auditService = new AuditService(writingStore);
    coreBridge = new RealCoreBridge(router, writingStore, auditService);

    projectId = writingStore.createProject('W5 对账测试').id;
    ctx = makeRequestContext({ projectId, trigger: 'review_decision' });
  });

  /** 提案并创建 author_approved 的 ProposalView（可选关联来源草案） */
  async function makeApprovedView(opts: { coreProposalId: string; withDraft?: boolean }) {
    let sourceDraftId: string | undefined;
    if (opts.withDraft) {
      const draft = writingStore.createDraft(projectId, { kind: 'event', content: '草案内容足够长用于推演' });
      // W10-a：真实流程下来源草案此时已推演完毕（simulated）；store 直写模拟该终态，
      // 否则 commitReviewedProposal 的 validateCommitReadiness 会因 drafting 状态误判为「来源草案被改」
      writingStore.updateDraft(draft.id, draft.version, { status: 'simulated' });
      sourceDraftId = draft.id;
    }
    const pv = writingStore.createProposalView(projectId, { proposalType: 'event', sourceDraftId });
    writingStore.updateProposalView(pv.id, {
      coreProposalId: opts.coreProposalId,
      status: 'author_approved',
      authorDecision: '确认提交',
    });
    return pv;
  }

  async function proposeRealEvent(): Promise<string> {
    const propose = await router.execute('propose_event', {
      event_type: 'w5_test',
      event_description: 'W5 测试事件',
      chapter: 1,
      subject: 'ent_hero',
      context: 'global',
      fact_changes: [
        { change_id: 'c1', op: 'assert', subject: 'ent_hero', predicate: 'status', value: '出战' },
      ],
    });
    if (!propose.success) throw new Error('propose_event 失败');
    return (propose as { data: { proposalId: string } }).data.proposalId;
  }

  // ===========================================================================
  // reconcileCommittedProposals
  // ===========================================================================

  it('提案 partial 失败后启动对账：孤儿 PV 恢复为 committed + coreRef + 草案', async () => {
    const proposalId = await proposeRealEvent();
    const pv = await makeApprovedView({ coreProposalId: proposalId, withDraft: true });
    const draftId = pv.sourceDraftId!;

    // 模拟 Core 提交成功后回写抛错（partial）：第一次 updateProposalView 调用（commit 回写）抛错，
    // 之后自动还原真实实现（reconcile 的回写能成功）。Core 已提交是不可逆事实。
    const spy = vi.spyOn(writingStore, 'updateProposalView').mockImplementationOnce(() => {
      throw new Error('模拟回写失败');
    });

    const commitResult = await coreBridge.commitReviewedProposal(ctx, pv.id);
    expect(commitResult.success).toBe(true); // Core 确实提交了
    expect(commitResult.coreEventId).toBeTruthy();
    // 孤儿态：PV 仍停在 author_approved，草案未提交，无 coreRef
    expect(writingStore.getProposalView(pv.id)!.status).toBe('author_approved');
    expect(writingStore.getDraft(draftId)!.status).not.toBe('committed');
    spy.mockRestore();

    // 启动对账
    const result = coreBridge.reconcileCommittedProposals();

    expect(result.recovered).toEqual([pv.id]);
    expect(result.inspected).toBe(1);
    // PV 恢复为 committed + coreEventId
    const recoveredPv = writingStore.getProposalView(pv.id)!;
    expect(recoveredPv.status).toBe('committed');
    expect(recoveredPv.coreEventId).toBe(commitResult.coreEventId);
    // 草案恢复为 committed
    expect(writingStore.getDraft(draftId)!.status).toBe('committed');

    // 恢复审计落地（system_recovery 触发）
    const reconAudits = writingStore.queryAuditLogs(projectId, { action: 'reconcile_proposal_view' });
    expect(reconAudits.length).toBe(1);
    expect(reconAudits[0]!.triggerSource).toBe('system_recovery');
    expect(reconAudits[0]!.result).toBe('success');
  });

  it('合法待提交的 PV（无"Core 已提交"审计）不被误恢复', async () => {
    // 一个 author_approved 但从未提交的 PV（合法 pending）
    const proposalId = await proposeRealEvent();
    const pv = await makeApprovedView({ coreProposalId: proposalId });

    const result = coreBridge.reconcileCommittedProposals();

    expect(result.recovered).toEqual([]);
    expect(result.inspected).toBe(1);
    // 保持 author_approved（未被误标失败）
    expect(writingStore.getProposalView(pv.id)!.status).toBe('author_approved');
  });

  it('对账幂等：连续两次 reconcile，第二次无新增恢复', async () => {
    const proposalId = await proposeRealEvent();
    const pv = await makeApprovedView({ coreProposalId: proposalId });

    vi.spyOn(writingStore, 'updateProposalView').mockImplementationOnce(() => {
      throw new Error('模拟回写失败');
    });
    await coreBridge.commitReviewedProposal(ctx, pv.id);
    vi.mocked(writingStore.updateProposalView).mockRestore();

    const r1 = coreBridge.reconcileCommittedProposals();
    expect(r1.recovered).toEqual([pv.id]);

    // 第二次：PV 已是 committed，不在 author_approved 孤儿集合中
    const r2 = coreBridge.reconcileCommittedProposals();
    expect(r2.recovered).toEqual([]);
    expect(r2.inspected).toBe(0);
  });

  // ===========================================================================
  // reconcileRegisteredEntities
  // ===========================================================================

  it('实体 partial 失败后启动对账：孤儿草图恢复为 registered', async () => {
    const sketch = writingStore.createEntitySketch(projectId, {
      displayName: '新角色', typeLabel: '角色', status: 'approved',
    });

    // 模拟注册成功后回写抛错（partial）
    vi.spyOn(writingStore, 'updateEntitySketch').mockImplementationOnce(() => {
      throw new Error('模拟回写失败');
    });
    const regResult = await coreBridge.registerReviewedEntity(ctx, sketch.id);
    expect(regResult.success).toBe(true);
    expect(regResult.coreEntityId).toBeTruthy();
    // 孤儿态：草图仍 approved
    expect(writingStore.getEntitySketch(sketch.id)!.status).toBe('approved');
    vi.mocked(writingStore.updateEntitySketch).mockRestore();

    const result = coreBridge.reconcileRegisteredEntities();

    expect(result.recovered).toEqual([sketch.id]);
    const recoveredSketch = writingStore.getEntitySketch(sketch.id)!;
    expect(recoveredSketch.status).toBe('registered');
    expect(recoveredSketch.coreEntityId).toBe(regResult.coreEntityId);
  });

  it('合法待注册的草图（无"Core 已注册"审计）不被误恢复', async () => {
    writingStore.createEntitySketch(projectId, {
      displayName: '待定角色', typeLabel: '角色', status: 'approved',
    });

    const result = coreBridge.reconcileRegisteredEntities();
    expect(result.recovered).toEqual([]);
  });

  // ===========================================================================
  // reconcile（组合）+ 边界
  // ===========================================================================

  it('reconcile() 组合入口同时恢复提案与实体', async () => {
    // 孤儿提案
    const proposalId = await proposeRealEvent();
    const pv = await makeApprovedView({ coreProposalId: proposalId });
    vi.spyOn(writingStore, 'updateProposalView').mockImplementationOnce(() => { throw new Error('x'); });
    await coreBridge.commitReviewedProposal(ctx, pv.id);
    vi.mocked(writingStore.updateProposalView).mockRestore();

    // 孤儿实体
    const sketch = writingStore.createEntitySketch(projectId, {
      displayName: '组合角色', typeLabel: '角色', status: 'approved',
    });
    vi.spyOn(writingStore, 'updateEntitySketch').mockImplementationOnce(() => { throw new Error('x'); });
    await coreBridge.registerReviewedEntity(ctx, sketch.id);
    vi.mocked(writingStore.updateEntitySketch).mockRestore();

    const combined = coreBridge.reconcile();
    expect(combined.proposals.recovered).toEqual([pv.id]);
    expect(combined.entities.recovered).toEqual([sketch.id]);
  });

  it('未注入 WritingStore 时对账安全返回空结果（不崩溃）', () => {
    const bareBridge = new RealCoreBridge(router); // 无 writingStore
    expect(bareBridge.reconcileCommittedProposals()).toEqual({ recovered: [], inspected: 0 });
    expect(bareBridge.reconcileRegisteredEntities()).toEqual({ recovered: [], inspected: 0 });
  });
});

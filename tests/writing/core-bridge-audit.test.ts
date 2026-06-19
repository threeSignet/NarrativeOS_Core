// =============================================================================
// W4 测试：CoreBridge 提交/注册的审计与回写健壮性
// =============================================================================
// 验证 RealCoreBridge.commitReviewedProposal / registerReviewedEntity：
//   1. 审计在桥接层内部落地（§7.7 4d/5b）——成功记 'success'，Core 失败记 'failure'，
//      回写部分失败记 'partial'（§7.7 行1862），不再依赖调用方各自记录。
//   2. 写回整体被 try/catch 包裹——Core 已提交是不可逆事实，回写失败不抛错吞掉审计，
//      而是记 'partial'，交由 reconcileCommittedProposals (W5) 对账恢复。
//   3. auditService 未注入时不阻断提交流程（审计为可追溯依据，非前置条件）。
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

describe('W4 CoreBridge 提交/注册审计与回写健壮性', () => {
  let router: ToolRouter;
  let writingStore: SQLiteWritingStore;
  let auditService: AuditService;
  let coreBridge: RealCoreBridge;
  let projectId: string;
  let ctx: WritingRequestContext;

  beforeEach(() => {
    // ---- 真实 Core 栈（:memory:，无 Embedding）----
    const factStore = new SQLiteFactStoreAdapter(':memory:', 'default');
    const db = factStore.getDatabase();
    const threadStore = new SQLiteThreadStoreAdapter(db);
    const knowledgeStore = new SQLiteKnowledgeStoreAdapter(db);
    const eventStore = new SQLiteEventStoreAdapter(db);
    const threadResolver = new ThreadResolver();

    const proposalManager = new ProposalManager(
      new RuleEngine(), undefined, threadStore, threadResolver,
    );
    const retconEngine = new RetconEngine();
    const toolService = new ToolService(
      factStore, knowledgeStore, eventStore, threadStore, threadResolver,
    );
    const schemaExtensionManager = new SchemaExtensionManager(db);

    router = new ToolRouter({
      proposalManager, retconEngine, toolService,
      schemaExtensionManager, factStore, knowledgeStore, eventStore, threadStore,
    });

    // 注册测试实体（供 propose_event 引用）
    db.exec(`INSERT INTO entities (id, name, kind, first_appearance) VALUES ('ent_hero', '主角', 'entity', 1)`);

    // ---- 写作层 ----
    writingStore = new SQLiteWritingStore(db);
    writingStore.createTables();
    auditService = new AuditService(writingStore);
    coreBridge = new RealCoreBridge(router, writingStore, auditService);

    projectId = writingStore.createProject('W4 测试作品').id;
    ctx = makeRequestContext({ projectId, trigger: 'review_decision' });
  });

  /** 提案并创建一个 author_approved 的 ProposalView（可选关联来源草案） */
  async function makeApprovedView(opts: {
    coreProposalId: string;
    withDraft?: boolean;
    /** 来源草案状态（默认 simulated——真实流程下 PV 的来源草案此时已推演完毕） */
    draftStatus?: 'simulated' | 'drafting' | 'ready_to_simulate';
  }) {
    let sourceDraftId: string | undefined;
    if (opts.withDraft) {
      const draft = writingStore.createDraft(projectId, { kind: 'event', content: '草案内容' });
      // W10-a：真实流程下 simulateDraft 会把草案置为 simulated；此处用 store 直写模拟该终态
      // （draftStatus 可覆盖以测试「来源草案被改」等异常态）
      writingStore.updateDraft(draft.id, draft.version, { status: opts.draftStatus ?? 'simulated' });
      sourceDraftId = draft.id;
    }
    const pv = writingStore.createProposalView(projectId, {
      proposalType: 'event',
      sourceDraftId,
    });
    writingStore.updateProposalView(pv.id, {
      coreProposalId: opts.coreProposalId,
      status: 'author_approved',
      authorDecision: '确认提交',
    });
    return pv;
  }

  /** 通过 propose_event 取得一个真实可提交的 Core proposalId */
  async function proposeRealEvent(): Promise<string> {
    const propose = await router.execute('propose_event', {
      event_type: 'w4_test',
      event_description: 'W4 测试事件',
      chapter: 1,
      subject: 'ent_hero',
      context: 'global',
      fact_changes: [
        { change_id: 'c1', op: 'assert', subject: 'ent_hero', predicate: 'status', value: '出战' },
      ],
    });
    if (!propose.success) throw new Error('propose_event 失败：测试前置不通过');
    return (propose as { data: { proposalId: string } }).data.proposalId;
  }

  // ===========================================================================
  // commitReviewedProposal 审计
  // ===========================================================================

  it('提交成功：记 audit commit_proposal result=success，并回写 PV + 草案', async () => {
    const proposalId = await proposeRealEvent();
    const pv = await makeApprovedView({ coreProposalId: proposalId, withDraft: true });
    const draftId = pv.sourceDraftId!;

    const result = await coreBridge.commitReviewedProposal(ctx, pv.id);

    expect(result.success).toBe(true);
    expect(result.coreEventId).toBeTruthy();

    // PV 推进到 committed
    expect(writingStore.getProposalView(pv.id)!.status).toBe('committed');
    // 来源草案推进到 committed
    expect(writingStore.getDraft(draftId)!.status).toBe('committed');

    // 审计落地：action=commit_proposal, result=success
    const logs = writingStore.queryAuditLogs(projectId, { action: 'commit_proposal' });
    expect(logs.length).toBe(1);
    expect(logs[0]!.result).toBe('success');
    expect(logs[0]!.triggerSource).toBe('review_decision');
    // W14：审计来源追溯——本次提交由源草案触发（commitSourceRefs 由 pv.sourceDraftId 派生，经
    // real-bridge.recordAudit → AuditService.record → store.recordAudit 三层透传写 source_refs_json）
    expect(logs[0]!.sourceRefs).toEqual([{ kind: 'draft', id: draftId }]);
  });

  it('Core 提交失败·PROPOSAL_NOT_FOUND（proposal 跨会话丢失）：PV 标 expired，提示重新推演（§7.11.6）', async () => {
    // 用一个不存在的 proposal_id 触发 commit_event 的 PROPOSAL_NOT_FOUND
    const pv = await makeApprovedView({ coreProposalId: 'prop_does_not_exist' });

    const result = await coreBridge.commitReviewedProposal(ctx, pv.id);

    expect(result.success).toBe(false);
    expect(result.error?.errorCode).toBe('PROPOSAL_NOT_FOUND');
    // §7.11.6：proposal 已丢失不可恢复 → expired（区别于可重试的 commit_failed）
    expect(writingStore.getProposalView(pv.id)!.status).toBe('expired');
    // 给用户"重新推演"的明确指引（而非误导性的"重试"）
    expect(result.error?.humanMessage).toContain('重新推演');
    expect(result.error?.isRecoverable).toBe(false);

    const logs = writingStore.queryAuditLogs(projectId, { action: 'commit_proposal' });
    expect(logs.length).toBe(1);
    expect(logs[0]!.result).toBe('failure');
    expect(logs[0]!.errorCode).toBe('PROPOSAL_NOT_FOUND');
  });

  it('Core 提交失败·非 PROPOSAL_NOT_FOUND（如 STALE_PROPOSAL）：PV 标 commit_failed（可恢复，§7.11.2）', async () => {
    // 提案 A（记录当前世界状态版本 V0）——谓词与 B 不同，避免推演期冲突
    const propA = await router.execute('propose_event', {
      event_type: 'w4_stale_a', event_description: '提案A', chapter: 1,
      subject: 'ent_hero', context: 'global',
      fact_changes: [{ change_id: 'ca', op: 'assert', subject: 'ent_hero', predicate: 'realm', value: '炼气期' }],
    });
    const proposalIdA = (propA as { data: { proposalId: string } }).data.proposalId;
    // 提案 B 并先提交 → 世界状态版本 CAS 推进到 V1
    const propB = await router.execute('propose_event', {
      event_type: 'w4_stale_b', event_description: '提案B', chapter: 1,
      subject: 'ent_hero', context: 'global',
      fact_changes: [{ change_id: 'cb', op: 'assert', subject: 'ent_hero', predicate: 'weapon', value: '木剑' }],
    });
    const proposalIdB = (propB as { data: { proposalId: string } }).data.proposalId;
    const commitB = await router.execute('commit_event', { proposal_id: proposalIdB });
    expect(commitB.success).toBe(true);

    // 现在提交 A → expectedStateVersion V0 已过期 → STALE_PROPOSAL（proposal 仍在内存，非丢失）
    const pv = await makeApprovedView({ coreProposalId: proposalIdA });
    const result = await coreBridge.commitReviewedProposal(ctx, pv.id);

    expect(result.success).toBe(false);
    expect(result.error?.errorCode).toBe('STALE_PROPOSAL');
    // 非 PROPOSAL_NOT_FOUND → commit_failed（可恢复态，可重新审核/重试，区别于 expired）
    expect(writingStore.getProposalView(pv.id)!.status).toBe('commit_failed');
  });

  it('Core 提交成功但回写失败：记 audit commit_proposal result=partial，方法仍返回 success', async () => {
    const proposalId = await proposeRealEvent();
    const pv = await makeApprovedView({ coreProposalId: proposalId, withDraft: true });

    // 模拟回写阶段 updateDraft 抛错（如乐观锁冲突）——Core 已提交是不可逆事实
    const spy = vi.spyOn(writingStore, 'updateDraft').mockImplementation(() => {
      throw new Error('模拟回写失败');
    });

    const result = await coreBridge.commitReviewedProposal(ctx, pv.id);

    // Core 确实提交了——success=true，coreEventId 有值
    expect(result.success).toBe(true);
    expect(result.coreEventId).toBeTruthy();

    // 审计记为 partial（§7.7 行1862），交由 W5 reconcile 对账恢复
    const logs = writingStore.queryAuditLogs(projectId, { action: 'commit_proposal' });
    expect(logs.length).toBe(1);
    expect(logs[0]!.result).toBe('partial');

    spy.mockRestore();
  });

  it('auditService 未注入时不阻断提交，审计静默跳过', async () => {
    // 重建一个不注入 auditService 的桥接
    const bridgeNoAudit = new RealCoreBridge(router, writingStore);
    const proposalId = await proposeRealEvent();
    const pv = await makeApprovedView({ coreProposalId: proposalId });

    const result = await bridgeNoAudit.commitReviewedProposal(ctx, pv.id);

    // 提交依然成功
    expect(result.success).toBe(true);
    expect(writingStore.getProposalView(pv.id)!.status).toBe('committed');
    // 无审计记录（auditService 缺省）
    const logs = writingStore.queryAuditLogs(projectId, { action: 'commit_proposal' });
    expect(logs.length).toBe(0);
  });

  it('W10-a：来源草案在审核期被改（drafting）→ 拒提交 SOURCE_DRAFT_MODIFIED_AFTER_REVIEW（可恢复）', async () => {
    const proposalId = await proposeRealEvent();
    // 来源草案被回退到 drafting（模拟审核期间作者改了草案内容，updateDraftContent 会把 simulated→drafting）
    const pv = await makeApprovedView({
      coreProposalId: proposalId, withDraft: true, draftStatus: 'drafting',
    });

    const result = await coreBridge.commitReviewedProposal(ctx, pv.id);

    // 不提交——陈旧提案（基于过期内容）禁止落 Core
    expect(result.success).toBe(false);
    expect(result.error?.errorCode).toBe('SOURCE_DRAFT_MODIFIED_AFTER_REVIEW');
    expect(result.error?.isRecoverable).toBe(true);
    expect(result.error?.humanMessage).toContain('重新推演');
    // PV 状态不变（未到 Core，不标 commit_failed/expired——仍可重新推演刷新）
    expect(writingStore.getProposalView(pv.id)!.status).toBe('author_approved');

    // 记 failure 审计
    const logs = writingStore.queryAuditLogs(projectId, { action: 'commit_proposal' });
    expect(logs[0]!.result).toBe('failure');
    expect(logs[0]!.errorCode).toBe('SOURCE_DRAFT_MODIFIED_AFTER_REVIEW');
  });

  it('W10-a：来源草案被软删 → 拒提交 SOURCE_DRAFT_MODIFIED_AFTER_REVIEW（删除）', async () => {
    const proposalId = await proposeRealEvent();
    const pv = await makeApprovedView({ coreProposalId: proposalId, withDraft: true });
    // 软删来源草案：store 无单条软删 API（仅 softDeleteProject 级联），用底层 SQL 直置 deleted_at，
    // 模拟「来源草案被删」——getDraft 过滤 deleted_at 后查不到 → sourceDraftDeleted=true。
    writingStore.getDatabase()
      .prepare("UPDATE writing_drafts SET deleted_at = datetime('now') WHERE id = ?")
      .run(pv.sourceDraftId!);

    const result = await coreBridge.commitReviewedProposal(ctx, pv.id);

    expect(result.success).toBe(false);
    expect(result.error?.errorCode).toBe('SOURCE_DRAFT_MODIFIED_AFTER_REVIEW');
    expect(result.error?.humanMessage).toContain('删除');
  });

  // ===========================================================================
  // registerReviewedEntity 审计
  // ===========================================================================

  it('注册成功：记 audit register_entity result=success，草图标 registered', async () => {
    const sketch = writingStore.createEntitySketch(projectId, {
      displayName: '新角色',
      typeLabel: '角色',
      status: 'approved',
    });

    const result = await coreBridge.registerReviewedEntity(ctx, sketch.id);

    expect(result.success).toBe(true);
    expect(result.coreEntityId).toBeTruthy();
    expect(writingStore.getEntitySketch(sketch.id)!.status).toBe('registered');

    const logs = writingStore.queryAuditLogs(projectId, { action: 'register_entity' });
    expect(logs.length).toBe(1);
    expect(logs[0]!.result).toBe('success');
  });

  it('Core 注册成功但回写失败：记 audit register_entity result=partial', async () => {
    const sketch = writingStore.createEntitySketch(projectId, {
      displayName: '部分失败角色',
      typeLabel: '角色',
      status: 'approved',
    });

    const spy = vi.spyOn(writingStore, 'updateEntitySketch').mockImplementation(() => {
      throw new Error('模拟回写失败');
    });

    const result = await coreBridge.registerReviewedEntity(ctx, sketch.id);

    expect(result.success).toBe(true);
    expect(result.coreEntityId).toBeTruthy();

    const logs = writingStore.queryAuditLogs(projectId, { action: 'register_entity' });
    expect(logs.length).toBe(1);
    expect(logs[0]!.result).toBe('partial');

    spy.mockRestore();
  });

  it('未批准的草图直接注册：记 failure 审计并返回结构化错误', async () => {
    // status='candidate'（未 approved）——前置校验应拦截
    const sketch = writingStore.createEntitySketch(projectId, {
      displayName: '未批准角色',
      typeLabel: '角色',
      status: 'candidate',
    });

    const result = await coreBridge.registerReviewedEntity(ctx, sketch.id);

    expect(result.success).toBe(false);
    expect(result.error?.errorCode).toBe('INVALID_STATUS_TRANSITION');

    const logs = writingStore.queryAuditLogs(projectId, { action: 'register_entity' });
    expect(logs.length).toBe(1);
    expect(logs[0]!.result).toBe('failure');
  });
});

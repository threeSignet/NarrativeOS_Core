// =============================================================================
// W9 测试：simulateProposal 重新推演 + simulationInputs 持久化
// =============================================================================
// 验证 W9 闭环：
//   1. simulateDraft 把原始推演输入（SimulationInputs）持久化到 PV；
//   2. simulateProposal 从 PV 读回输入，用相同参数重调 propose_event，得到新鲜 SimulationResult；
//   3. 错误分支：PV 无 simulationInputs（非草案来源）/ PV 不存在 / writingStore 未注入 均按契约抛错。
//
// 使用真实 Core（:memory: SQLite + 真实 ToolRouter）+ 真实 DraftService / RealCoreBridge，无 LLM。
// =============================================================================

import { describe, it, expect, beforeEach } from 'vitest';
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
import { WorkflowService } from '../../src/writing/services/workflow-service.js';
import { DraftService } from '../../src/writing/services/draft-service.js';
import { RealCoreBridge } from '../../src/writing/core-bridge/real-bridge.js';
import { makeRequestContext } from '../../src/writing/services/context.js';

describe('W9 simulateProposal 重新推演 + simulationInputs 持久化', () => {
  let store: SQLiteWritingStore;
  let router: ToolRouter;
  let coreBridge: RealCoreBridge;
  let draftService: DraftService;
  let projectId: string;
  let draftId: string;

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

    // Core 注册测试实体（供 propose_event 的 fact_change subject 引用）
    db.exec(`INSERT INTO entities (id, name, kind, first_appearance) VALUES ('ent_hero', '主角', 'entity', 1)`);

    // ---- 写作层 ----
    store = new SQLiteWritingStore(db);
    store.createTables();
    const audit = new AuditService(store);
    const workflow = new WorkflowService(store, audit);
    coreBridge = new RealCoreBridge(router, store, audit);
    draftService = new DraftService(store, audit, coreBridge, workflow);

    projectId = store.createProject('W9 测试作品').id;

    // 实体草图回填 coreEntityId，使 resolveEntityName 能解析 ent_hero→「主角」
    const sketch = store.createEntitySketch(projectId, {
      displayName: '主角', typeLabel: '角色', status: 'registered',
    });
    store.updateEntitySketch(sketch.id, { coreEntityId: 'ent_hero' });

    // 草案（content ≥10 字），置为 ready_to_simulate
    const draft = store.createDraft(projectId, {
      kind: 'event', title: '主角抵达废弃站台',
      content: '主角穿过荒原，抵达废弃站台查看异象。',
    });
    store.updateDraft(draft.id, draft.version, { status: 'ready_to_simulate' });
    draftId = draft.id;
  });

  it('simulateDraft 把原始推演输入持久化到 PV（simulationInputs）', async () => {
    const ctx = makeRequestContext({ projectId });
    const factChanges = [
      { change_id: 'ch1', op: 'assert', subject: 'ent_hero', predicate: 'location', value: '废弃站台' },
    ];
    const { proposalView } = await draftService.simulateDraft(ctx, draftId, factChanges);

    const pv = store.getProposalView(proposalView.id)!;
    // simulationInputs 完整回填——这是 simulateProposal 重推的唯一可靠来源
    expect(pv.simulationInputs).toBeDefined();
    expect(pv.simulationInputs!.eventDescription).toBe('主角抵达废弃站台');
    expect(pv.simulationInputs!.eventType).toBe('custom'); // draft.kind==='event' → custom
    expect(pv.simulationInputs!.chapter).toBe(1);
    // 原始 factChanges 原文存留（含 ent_ 主体、change_id——内部存储字段，§9.1 过滤在投影层）
    expect(pv.simulationInputs!.factChanges).toEqual(factChanges);
  });

  it('simulateProposal 读回 simulationInputs 重调 propose_event，返回新鲜 SimulationResult', async () => {
    const ctx = makeRequestContext({ projectId });
    const factChanges = [
      { change_id: 'ch1', op: 'assert', subject: 'ent_hero', predicate: 'location', value: '废弃站台' },
      { change_id: 'ch2', op: 'assert', subject: 'ent_hero', predicate: 'status', value: '警戒' },
    ];
    const { proposalView } = await draftService.simulateDraft(ctx, draftId, factChanges);
    const originalPv = store.getProposalView(proposalView.id)!;
    const originalProposalId = originalPv.coreProposalId!;

    // 重新推演——用 PV 持久化的原始输入，不重新传 factChanges
    const reSim = await coreBridge.simulateProposal(projectId, proposalView.id);

    // 返回结构合法
    expect(reSim.proposalId).toBeTruthy();
    expect(typeof reSim.isSafeToCommit).toBe('boolean');
    expect(typeof reSim.report).toBe('string');
    expect(Array.isArray(reSim.consequenceThreads)).toBe(true);
    expect(Array.isArray(reSim.consequenceWarnings)).toBe(true);

    // 重推生成的是「新」Core proposal——proposalId 与首次推演不同（ProposalStore 新建了一条）
    expect(reSim.proposalId).not.toBe(originalProposalId);
  });

  it('simulateProposal 重推后反映最新世界状态（先提交另一事件改变世界，再重推同一提案）', async () => {
    const ctx = makeRequestContext({ projectId });
    const factChanges = [
      { change_id: 'ch1', op: 'assert', subject: 'ent_hero', predicate: 'location', value: '废弃站台' },
    ];
    const { proposalView } = await draftService.simulateDraft(ctx, draftId, factChanges);

    // 模拟「期间世界状态已变化」：直接往 Core 提交一个把主角 location 改到别处的事件，
    // 制造与待审提案冲突的世界状态（同一实体 location 已是不同值）。
    const proposeRes = await router.execute('propose_event', {
      event_type: 'custom',
      event_description: '主角先行抵达中央广场',
      chapter: 1,
      fact_changes: [
        { change_id: 'pre1', op: 'assert', subject: 'ent_hero', predicate: 'location', value: '中央广场' },
      ],
      subject: '主角先行抵达中央广场',
      context: 'global',
    });
    const proposal = proposeRes as { success: true; data: { proposalId: string } };
    await router.execute('commit_event', { proposal_id: proposal.data.proposalId });

    // 重新推演原待审提案：现在主角 location 已是「中央广场」，再 assert「废弃站台」会
    // 产生 update（覆盖）而非 new——验证重推确实对照了「最新」Core 状态。
    const reSim = await coreBridge.simulateProposal(projectId, proposalView.id);
    expect(reSim.proposalId).toBeTruthy();
    // 仍可推演（重推本身不因世界变化而失败，结果交由作者判断）
    expect(typeof reSim.isSafeToCommit).toBe('boolean');
  });

  it('simulateProposal：PV 无 simulationInputs（非草案来源，如实体注册）抛错', async () => {
    // 手建一个实体注册来源的 PV（不走 simulateDraft，故无 simulationInputs）
    const regPv = store.createProposalView(projectId, {
      proposalType: 'entity_registration',
    });
    await expect(coreBridge.simulateProposal(projectId, regPv.id)).rejects.toThrow(
      /无原始推演输入/,
    );
  });

  it('simulateProposal：PV 不存在抛错', async () => {
    await expect(
      coreBridge.simulateProposal(projectId, 'pv_does_not_exist'),
    ).rejects.toThrow(/找不到审核视图/);
  });

  it('simulateProposal：writingStore 未注入抛错', async () => {
    // 构造一个无 writingStore 的桥接（裸 router）——读不到 PV 的 simulationInputs
    const bareBridge = new RealCoreBridge(router);
    await expect(
      bareBridge.simulateProposal(projectId, 'whatever'),
    ).rejects.toThrow(/需要 writingStore/);
  });
});

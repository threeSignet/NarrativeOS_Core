// =============================================================================
// W7 服务级测试：DraftService.simulateDraft 填充 Proposal Review 四件套
// =============================================================================
// 验证 W7 接线——simulateDraft 此前只把 eventDescription 塞进 humanSummary、
// factDiff/involvedEntityIds/ruleWarnings 全空；现经 buildProposalReviewData 投影后，
// ProposalView 四件套被正确写入并持久化。
//
// 使用真实 Core（:memory: SQLite + 真实 ToolRouter）+ 真实 DraftService，无 LLM。
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

describe('W7 DraftService.simulateDraft 填充 Proposal Review 四件套', () => {
  let store: SQLiteWritingStore;
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

    const router = new ToolRouter({
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
    const coreBridge = new RealCoreBridge(router, store, audit);
    draftService = new DraftService(store, audit, coreBridge, workflow);

    projectId = store.createProject('W7 测试作品').id;

    // 实体草图：displayName='主角'，回填 coreEntityId='ent_hero'（模拟已注册态）
    // → draft-service 的 resolveEntityName 据此把 ent_hero 解析为「主角」
    const sketch = store.createEntitySketch(projectId, {
      displayName: '主角', typeLabel: '角色', status: 'registered',
    });
    store.updateEntitySketch(sketch.id, { coreEntityId: 'ent_hero' });

    // 草案（content ≥10 字），置为 ready_to_simulate（存储层直写，绕过 service 入口校验）
    const draft = store.createDraft(projectId, {
      kind: 'event', title: '主角抵达废弃站台', content: '主角穿过荒原，抵达废弃站台查看异象。',
    });
    store.updateDraft(draft.id, draft.version, { status: 'ready_to_simulate' });
    draftId = draft.id;
  });

  it('simulateDraft 后 ProposalView 四件套被填充并持久化', async () => {
    const ctx = makeRequestContext({ projectId });
    const { proposalView } = await draftService.simulateDraft(ctx, draftId, [
      { change_id: 'ch1', op: 'assert', subject: 'ent_hero', predicate: 'location', value: '废弃站台' },
      { change_id: 'ch2', op: 'assert', subject: 'ent_hero', predicate: 'status', value: '警戒' },
    ]);

    // 返回的 proposalView 是 re-fetch 的持久化版本（非 stale 快照）
    const pv = store.getProposalView(proposalView.id)!;

    // ---- factDiff ----
    expect(pv.factDiff).toHaveLength(2);
    expect(pv.factDiff[0]!.op).toBe('new');
    expect(pv.factDiff[0]!.entityName).toBe('主角'); // ent_hero 经草图解析为显示名
    expect(pv.factDiff[0]!.predicateLabel).toBe('位置');
    expect(pv.factDiff[0]!.newValue).toBe('废弃站台');
    // §9.1：持久化的 factDiff 序列化不泄漏 ent_/fct_
    expect(JSON.stringify(pv.factDiff)).not.toMatch(/ent_|fct_/);

    // ---- involvedEntityIds（去重，保留原始 ent_ id——内部存储字段）----
    expect(pv.involvedEntityIds).toEqual(['ent_hero']);

    // ---- ruleWarnings（数组；安全提交可能为空）----
    expect(Array.isArray(pv.ruleWarnings)).toBe(true);

    // ---- humanSummary（含事件/变更数/涉及实体/安全状态，无 ent_ 泄漏）----
    expect(pv.humanSummary).toContain('主角抵达废弃站台');
    expect(pv.humanSummary).toContain('2 项设定');
    expect(pv.humanSummary).toContain('主角');
    expect(pv.humanSummary).not.toMatch(/ent_/);

    // coreProposalId 也回填了（既有逻辑，W7 未改）
    expect(pv.coreProposalId).toBeTruthy();
  });

  it('coreBridgeResult 仍保留原始推演报告（markdown），四件套为新增结构化字段', async () => {
    const ctx = makeRequestContext({ projectId });
    const { proposalView } = await draftService.simulateDraft(ctx, draftId, [
      { change_id: 'ch1', op: 'assert', subject: 'ent_hero', predicate: 'status', value: '出战' },
    ]);
    const pv = store.getProposalView(proposalView.id)!;

    // coreBridgeResult 保留 { proposalId, isSafeToCommit, report }（既有契约不变）
    expect((pv.coreBridgeResult as { report?: string }).report).toBeTruthy();
    // 四件套非空（factDiff 至少 1 条）
    expect(pv.factDiff.length).toBeGreaterThanOrEqual(1);
    expect(pv.involvedEntityIds).toContain('ent_hero');
  });
});

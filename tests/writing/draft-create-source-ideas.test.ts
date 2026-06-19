// =============================================================================
// W15 测试：DraftService.createDraft 的 sourceIdeaIds→sourceRefs 转换
// =============================================================================
// 验证 Phase7-Refinement §7.5 createDraft 契约：
//   1. sourceIdeaIds?: string[] 便捷入口 → service 内自动 wrap 为 {kind:'idea', id}（§7.5 主流程1）
//   2. 三来源合并顺序：ctx.sourceRefs（上下文追溯）→ ideaRefs（灵感）→ params.sourceRefs（显式通用）（§7.5 主流程2）
//   3. content 兜底空串（§7.5 content: content ?? ''）
//   4. 审计 detail 记 hasSourceIdeas: !!sourceIdeaIds?.length（§7.5 副作用3）
//   5. 向后兼容：不传 sourceIdeaIds/sourceRefs → draft.sourceRefs 仅 ctx.sourceRefs
//
// 使用真实 DraftService + 真实 store/audit（:memory:），无 LLM。
// createDraft 路径不碰 coreBridge/workflow，但 DraftService 构造要求 4 依赖齐备，
// 故与 draft-simulate-review.test.ts 同构地构造真实 Core 栈（保证类型完整、无 stub hack）。
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

describe('W15 DraftService.createDraft sourceIdeaIds→sourceRefs 转换', () => {
  let store: SQLiteWritingStore;
  let draftService: DraftService;
  let projectId: string;

  beforeEach(() => {
    // 真实 Core 栈——仅为构造完整 DraftService（createDraft 不碰 Core，但构造要求 4 依赖齐备）
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

    store = new SQLiteWritingStore(db);
    store.createTables();
    const audit = new AuditService(store);
    const workflow = new WorkflowService(store, audit);
    const coreBridge = new RealCoreBridge(router, store, audit);
    draftService = new DraftService(store, audit, coreBridge, workflow);

    projectId = store.createProject('W15 测试作品').id;
  });

  it('sourceIdeaIds → 自动 wrap 为 {kind:"idea", id} 写入 draft.sourceRefs', () => {
    const ctx = makeRequestContext({ projectId });
    const draft = draftService.createDraft(ctx, {
      kind: 'event',
      content: '韩立获得逆天功法',
      sourceIdeaIds: ['wicd_a', 'wicd_b'],
    });

    // §7.5 主流程1：灵感 id 数组经 service 转换为 {kind:'idea', id} 形态写库
    expect(draft.sourceRefs).toEqual([
      { kind: 'idea', id: 'wicd_a' },
      { kind: 'idea', id: 'wicd_b' },
    ]);
  });

  it('三来源合并顺序：ctx.sourceRefs → ideaRefs → params.sourceRefs', () => {
    const ctx = makeRequestContext({
      projectId,
      sourceRefs: [{ kind: 'chat', id: 'msg_origin' }],
    });
    const draft = draftService.createDraft(ctx, {
      kind: 'event',
      content: '剧情推进',
      sourceIdeaIds: ['wicd_1'],
      sourceRefs: [{ kind: 'draft', id: 'wdft_prev' }],
    });

    // §7.5 主流程2：合并顺序——ctx 追溯链最先、sourceIdeaIds 转换居中、显式 sourceRefs 最后
    expect(draft.sourceRefs).toEqual([
      { kind: 'chat', id: 'msg_origin' },   // ctx.sourceRefs（上下文追溯）
      { kind: 'idea', id: 'wicd_1' },        // sourceIdeaIds 转换
      { kind: 'draft', id: 'wdft_prev' },    // params.sourceRefs（显式通用）
    ]);
  });

  it('content 不传 → 兜底空串（§7.5 content: content ?? ""）', () => {
    const ctx = makeRequestContext({ projectId });
    const draft = draftService.createDraft(ctx, { kind: 'event', sourceIdeaIds: ['wicd_y'] });

    // §7.5：content 缺省兜底空串（service 层对齐契约，非依赖 store 兜底）
    expect(draft.content).toBe('');
  });

  it('审计 detail 记 hasSourceIdeas：传 sourceIdeaIds=true，不传=false（§7.5 副作用3）', () => {
    const ctx = makeRequestContext({ projectId });

    const withIdeas = draftService.createDraft(ctx, {
      kind: 'event', content: 'c1', sourceIdeaIds: ['wicd_x'],
    });
    const withoutIdeas = draftService.createDraft(ctx, {
      kind: 'event', content: 'c2',
    });

    const logs = store.queryAuditLogs(projectId, { action: 'create_draft' });
    expect(logs.length).toBe(2);

    // detail?: unknown，断言时按记录形状取键
    const logWith = logs.find(l => l.targetId === withIdeas.id)!;
    const logWithout = logs.find(l => l.targetId === withoutIdeas.id)!;

    expect((logWith.detail as Record<string, unknown>).hasSourceIdeas).toBe(true);
    expect((logWithout.detail as Record<string, unknown>).hasSourceIdeas).toBe(false);
  });

  it('向后兼容：不传 sourceIdeaIds/sourceRefs → draft.sourceRefs 仅 ctx.sourceRefs', () => {
    const ctx = makeRequestContext({
      projectId,
      sourceRefs: [{ kind: 'user_decision', id: 'dec_1' }],
    });
    const draft = draftService.createDraft(ctx, { kind: 'event', content: 'c' });

    // 既有调用方零改不破：未显式声明来源时，仅保留上下文追溯链
    expect(draft.sourceRefs).toEqual([{ kind: 'user_decision', id: 'dec_1' }]);
  });
});

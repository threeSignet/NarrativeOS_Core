// =============================================================================
// W13：Agent 草案轨道统一 — 双轨草案系统收敛测试
// =============================================================================
// 验证 §8.5 桥接：NarrativeAgent 的 ReAct 产物（propose_event）在 writingLayer 路径下
// 物化为可审核的 WritingDraft + ProposalView + PendingDecision（而非裸 pendingProposalId），
// 同时保证裸路径（无 writingLayer）行为 100% 不变。
//
// 范式：脚本化 Mock LLM 驱动真实 Agent + 真实 Core（:memory: SQLite + 真实 ToolRouter +
// 真实 DraftService / RealCoreBridge），无 DeepSeek key（CI 稳定运行）。参考 commit-gate.test.ts。
// =============================================================================

import { describe, it, expect, beforeEach } from 'vitest';
import { SQLiteFactStoreAdapter } from '../../src/adapters/sqlite/fact-store.js';
import { SQLiteThreadStoreAdapter } from '../../src/adapters/sqlite/thread-store.js';
import { SQLiteKnowledgeStoreAdapter } from '../../src/adapters/sqlite/knowledge-store.js';
import { SQLiteEventStoreAdapter } from '../../src/adapters/sqlite/event-store.js';
import { SQLiteAgentStoreAdapter } from '../../src/adapters/sqlite/agent-store.js';
import { ProposalManager } from '../../src/core/proposal-manager.js';
import { RuleEngine } from '../../src/core/rule-engine.js';
import { ThreadResolver } from '../../src/core/thread-resolver.js';
import { RetconEngine } from '../../src/core/retcon-engine.js';
import { ToolService } from '../../src/core/tool-service.js';
import { SchemaExtensionManager } from '../../src/core/schema-extension-manager.js';
import { ToolRouter } from '../../src/core/tool-router.js';
import { NarrativeAgent } from '../../src/agent/narrative-agent.js';
import { SQLiteWritingStore } from '../../src/writing/repositories/writing-store.js';
import { AuditService } from '../../src/writing/services/audit-service.js';
import { WorkflowService } from '../../src/writing/services/workflow-service.js';
import { DraftService } from '../../src/writing/services/draft-service.js';
import { EntityService } from '../../src/writing/services/entity-service.js';
import { RealCoreBridge } from '../../src/writing/core-bridge/real-bridge.js';
import { makeRequestContext } from '../../src/writing/services/context.js';
import type { LLMClient, ToolCallResult } from '../../src/types/llm.js';

/** 一次 propose_event 工具调用（LLM 在 ReAct 循环里发起） */
const PROPOSE_TOOL_CALL = {
  name: 'propose_event' as const,
  arguments: {
    event_type: 'custom',
    event_description: '主角抵达废弃站台',
    chapter: 1,
    fact_changes: [
      { change_id: 'ch1', op: 'assert', subject: 'ent_hero', predicate: 'location', value: '废弃站台' },
      { change_id: 'ch2', op: 'assert', subject: 'ent_hero', predicate: 'status', value: '警戒' },
    ],
    // subject 必须是【实体 ID】（ent_hero），而非显示名「主角」。
    // 契约：tool-router.ts 的 propose_event schema 明示 subject='事件主体实体ID'，
    // 传播规则 rule-engine.ts:84 把 event.params.subject 直接当 knowledge.entity_id（→entities.id FK）。
    // 若误传显示名，commit_event 在 knowledge.entity_id FK 上失败（TRANSACTION_FAILED: FOREIGN KEY constraint failed）。
    subject: 'ent_hero',
    context: 'global',
  },
};

/**
 * 脚本化 Mock LLM：按预设序列依次返回，不调外部 API。
 * - chat() 返回空串（detectIntent 走关键词，memory 提取容忍空）
 * - chatWithTools() 依次吐出 script；用尽后停留在末条（避免循环里无限索取）
 */
class ScriptedMockLLM implements LLMClient {
  private idx = 0;
  constructor(private readonly script: ToolCallResult[]) {}
  async chat(): Promise<string> { return ''; }
  async chatWithTools(): Promise<ToolCallResult> {
    const last = this.script[this.script.length - 1]!;
    const step = this.script[this.idx] ?? last;
    if (this.idx < this.script.length - 1) this.idx++;
    return step;
  }
}

/** 单回合脚本：propose_event → 文本收尾 */
function singleTurnProposeScript(): ToolCallResult[] {
  return [
    { content: '', toolCalls: [PROPOSE_TOOL_CALL] },
    { content: '已记录事件草案，等待你确认。', toolCalls: undefined },
  ];
}

interface Env {
  db: ReturnType<SQLiteFactStoreAdapter['getDatabase']>;
  toolRouter: ToolRouter;
  agentStore: SQLiteAgentStoreAdapter;
  writingStore?: SQLiteWritingStore;
  workflowService?: WorkflowService;
  draftService?: DraftService;
  coreBridge?: RealCoreBridge;
  writingProjectId?: string;
}

/** 搭建真实 Core 栈；withWritingLayer=true 时额外接入写作层（含 ent_hero 实体 + sketch 回填） */
function createEnv(withWritingLayer: boolean): Env {
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
  const toolRouter = new ToolRouter({
    proposalManager, retconEngine, toolService,
    schemaExtensionManager, factStore, knowledgeStore, eventStore, threadStore,
  });
  const agentStore = new SQLiteAgentStoreAdapter(db);
  agentStore.createTables();

  const env: Env = { db, toolRouter, agentStore };

  if (withWritingLayer) {
    const writingStore = new SQLiteWritingStore(db);
    writingStore.createTables();
    const audit = new AuditService(writingStore);
    const workflowService = new WorkflowService(writingStore, audit);
    const coreBridge = new RealCoreBridge(toolRouter, writingStore, audit);
    const draftService = new DraftService(writingStore, audit, coreBridge, workflowService);
    // EntityService 仅为构造完整性注入（W13 物化路径不依赖它）
    void new EntityService(writingStore, audit, workflowService);
    const writingProjectId = writingStore.createProject('W13 测试作品').id;

    // Core 注册测试实体（propose_event 的 fact_change.subject 必须引用已存在实体）
    db.exec(`INSERT INTO entities (id, name, kind, first_appearance) VALUES ('ent_hero', '主角', 'entity', 1)`);
    // sketch 回填 coreEntityId——使 resolveEntityName 能把 ent_hero 解析为「主角」（§9.1 不泄漏 id）
    const sketch = writingStore.createEntitySketch(writingProjectId, {
      displayName: '主角', typeLabel: '角色', status: 'registered',
    });
    writingStore.updateEntitySketch(sketch.id, { coreEntityId: 'ent_hero' });

    env.writingStore = writingStore;
    env.workflowService = workflowService;
    env.draftService = draftService;
    env.coreBridge = coreBridge;
    env.writingProjectId = writingProjectId;
  }

  return env;
}

/** 构造注入了 writingLayer 的 Agent */
function makeAgent(env: Env, script: ToolCallResult[]): NarrativeAgent {
  return new NarrativeAgent({
    llm: new ScriptedMockLLM(script),
    toolRouter: env.toolRouter,
    agentStore: env.agentStore,
    projectId: 'default',
    limits: { maxToolSteps: 8, maxRepeatedToolFailure: 3, maxWallClockMs: 60000 },
    writingProjectId: env.writingProjectId,
    writingStore: env.writingStore,
    auditService: env.writingStore ? new AuditService(env.writingStore) : undefined,
    workflowService: env.workflowService,
    draftService: env.draftService,
    coreBridge: env.coreBridge,
  });
}

describe('W13：Agent 草案轨道统一（writingLayer 物化 + 裸路径不变）', () => {
  let env: Env;

  beforeEach(() => {
    env = createEnv(true);
  });

  it('W13-a：writingLayer 下 propose_event 委托 DraftService 建 WritingDraft，workingDraft.id 对齐', async () => {
    const agent = makeAgent(env, singleTurnProposeScript());
    agent.startSession('w13a');
    await agent.processUserInput('让主角抵达废弃站台');

    const drafts = env.writingStore!.listDrafts(env.writingProjectId!);
    expect(drafts.length).toBe(1);
    // 状态机已推进到 simulated（materializeProposalView 经 drafting→ready_to_simulate→simulated）
    expect(drafts[0]!.status).toBe('simulated');

    // state.workingDraft 是 WritingDraft 的内存投影——id 与持久化草案一致（保护消费者）
    const wd = agent.getState().workingDraft;
    expect(wd).toBeDefined();
    expect(wd!.id).toBe(drafts[0]!.id);
  }, 30000);

  it('W13-b：propose_event 物化为 open PV（factDiff>0）+ confirm_proposal PendingDecision', async () => {
    const agent = makeAgent(env, singleTurnProposeScript());
    agent.startSession('w13b');
    await agent.processUserInput('让主角抵达废弃站台');

    const pvs = env.writingStore!.listProposalViews(env.writingProjectId!);
    expect(pvs.length).toBe(1);
    const pv = pvs[0]!;
    expect(pv.status).toBe('open');
    // coreProposalId 匹配 Agent pendingProposalIds 里那条（复用 Core 已推演的 proposal，非重推）
    expect(pv.coreProposalId).toBeTruthy();
    expect(agent.getState().pendingProposalIds).toContain(pv.coreProposalId);
    // factDiff 用真实 fact_changes（2 条 assert），非兜底空数组
    expect((pv.factDiff ?? []).length).toBe(2);
    // simulationInputs 回填（供 /review resim 重推）
    expect(pv.simulationInputs).toBeDefined();
    expect(pv.simulationInputs!.eventType).toBe('custom');

    // PendingDecision：confirm_proposal，linkedObjectId 指向该 PV
    const ctx = makeRequestContext({ projectId: env.writingProjectId! });
    const decisions = env.workflowService!.listPendingDecisions(ctx);
    expect(decisions.length).toBe(1);
    expect(decisions[0]!.kind).toBe('confirm_proposal');
    expect(decisions[0]!.linkedObjectId).toBe(pv.id);
    expect(decisions[0]!.linkedObjectType).toBe('proposal_view');
  }, 30000);

  it('/auto writingLayer：agent_authorized_for_session 自动确认 → PV committed + pending 清空', async () => {
    const agent = makeAgent(env, singleTurnProposeScript());
    agent.startSession('w13-auto');
    await agent.processUserInput('让主角抵达废弃站台', {
      commitAuthority: 'agent_authorized_for_session',
    });

    // 自动提交后 pending proposal 清空（autoApprovePendingDecisions 末尾清理）
    expect(agent.getState().pendingProposalIds.length).toBe(0);

    const pvs = env.writingStore!.listProposalViews(env.writingProjectId!);
    expect(pvs[0]!.status).toBe('committed');

    // PendingDecision 已 resolved（listPendingDecisions 只返回 open → 应为空）
    const ctx = makeRequestContext({ projectId: env.writingProjectId! });
    expect(env.workflowService!.listPendingDecisions(ctx).length).toBe(0);

    // Core 确实落库：ent_hero 的 location 事实存在（提交成功，非仅 PV 标记）
    // facts 表标量值存于 value_scalar 列（value_type='scalar'），无 value 列。
    const facts = env.db.prepare(
      `SELECT value_scalar FROM facts WHERE subject = 'ent_hero' AND predicate = 'location' AND is_current = 1`,
    ).all() as { value_scalar: string }[];
    expect(facts.some((f) => f.value_scalar === '废弃站台')).toBe(true);
  }, 30000);

  it('裸路径回归：无 writingLayer 时 propose_event 仍走 agent_working_drafts，不建写作层对象', async () => {
    const bareEnv = createEnv(false);
    const agent = new NarrativeAgent({
      llm: new ScriptedMockLLM(singleTurnProposeScript()),
      toolRouter: bareEnv.toolRouter,
      agentStore: bareEnv.agentStore,
      projectId: 'default',
      limits: { maxToolSteps: 8, maxRepeatedToolFailure: 3, maxWallClockMs: 60000 },
    });
    // 裸路径也需 Core 实体（propose_event 引用 ent_hero）
    bareEnv.db.exec(`INSERT INTO entities (id, name, kind, first_appearance) VALUES ('ent_hero', '主角', 'entity', 1)`);
    agent.startSession('bare');
    const result = await agent.processUserInput('让主角抵达废弃站台');

    expect(result.status).not.toBe('failed');
    // pending proposal 堆积在 pendingProposalIds（裸路径无自动提交，commitAuthority=explicit）
    expect(agent.getState().pendingProposalIds.length).toBe(1);
    // workingDraft 走 agent_working_drafts（agentStore.getActiveDraft 命中）
    const sessionId = agent.getState().sessionId;
    expect(bareEnv.agentStore.getActiveDraft(sessionId)).toBeDefined();
  }, 30000);

  it('handleRejectDraft writingLayer：reject 后 WritingDraft 归 archived，workingDraft 清空', async () => {
    const agent = makeAgent(env, singleTurnProposeScript());
    agent.startSession('w13-reject');
    await agent.processUserInput('让主角抵达废弃站台');

    // 第二回合 reject——「废弃」先被 handlePendingDecisions 的 revise 分支处理（PV→author_rejected、
    // decision dismissed），落空后 detectIntent→reject_draft→handleRejectDraft 归档草案。
    await agent.processUserInput('废弃当前草案');

    const drafts = env.writingStore!.listDrafts(env.writingProjectId!);
    expect(drafts.length).toBe(1);
    expect(drafts[0]!.status).toBe('archived');
    // workingDraft 已清空（writingDraftId/Version 同步重置）
    expect(agent.getState().workingDraft).toBeUndefined();
    expect(agent.getState().pendingProposalIds.length).toBe(0);
  }, 30000);

  it('PV 查重：同草案二次 propose_event 复用现有 PV，不新建、不重复 PendingDecision', async () => {
    // 4 条脚本：两回合各 [propose, text]
    const script: ToolCallResult[] = [
      { content: '', toolCalls: [PROPOSE_TOOL_CALL] },
      { content: '已记录，待确认。', toolCalls: undefined },
      { content: '', toolCalls: [PROPOSE_TOOL_CALL] },
      { content: '再次记录，待确认。', toolCalls: undefined },
    ];
    const agent = makeAgent(env, script);
    agent.startSession('w13-dedup');

    await agent.processUserInput('让主角抵达废弃站台');
    const afterFirst = env.writingStore!.listProposalViews(env.writingProjectId!);
    expect(afterFirst.length).toBe(1);
    const firstProposalId = afterFirst[0]!.coreProposalId;

    await agent.processUserInput('再让主角抵达废弃站台');
    const afterSecond = env.writingStore!.listProposalViews(env.writingProjectId!);

    // 仍只有 1 个 PV（复用同草案的活跃视图），但 coreProposalId 已更新为第二次推演的新 proposal
    expect(afterSecond.length).toBe(1);
    expect(afterSecond[0]!.id).toBe(afterFirst[0]!.id);
    expect(afterSecond[0]!.coreProposalId).not.toBe(firstProposalId);

    // PendingDecision 不重复——仍只有 1 个 open（hasOpenDecision 守卫）
    const ctx = makeRequestContext({ projectId: env.writingProjectId! });
    const decisions = env.workflowService!.listPendingDecisions(ctx);
    expect(decisions.length).toBe(1);
  }, 30000);
});

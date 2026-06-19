// =============================================================================
// W2：权限强制运行时测试（assertAgentMayCall 接入后）
// =============================================================================
// 验证两个运行时不变式（对齐 w13-draft-unification.test.ts / commit-gate.test.ts 范式：
// 脚本化 Mock LLM + 真实 Core/writing 栈，无 DeepSeek key）：
//   场景1：作者"确认"经确认通道（applyDecisionConfirm，带 AUTHOR_CONFIRM_CHANNEL caller）
//          调用 commitReviewedProposal → assert 放行 → 提交真正抵达 Core（fact 落库）。
//          证明 6 处 assert 接入不阻断既有作者确认通道（裸路径 + W13 行为 100% 不变）。
//   场景2：裸 Agent 路径（无 caller 标记）直接调 commitReviewedProposal → 抛 AGENT_COMMIT_FORBIDDEN；
//          registerReviewedEntity → 抛 AGENT_REGISTER_FORBIDDEN。
//          证明权限矩阵在自动路径生效（前向防回归 + 激活原本无 throw 点的死错误码）。
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
import { assertAgentMayCall } from '../../src/writing/agent/permission-check.js';
import { WritingError, WritingErrorCode } from '../../src/writing/errors/error-codes.js';
import type { LLMClient, ToolCallResult } from '../../src/types/llm.js';

/** 一次 propose_event 工具调用（subject 用实体 ID ent_hero——传播规则的 FK 契约，见 CLAUDE.md 陷阱 5） */
const PROPOSE_TOOL_CALL = {
  name: 'propose_event' as const,
  arguments: {
    event_type: 'custom',
    event_description: '主角抵达废弃站台',
    chapter: 1,
    fact_changes: [
      { change_id: 'ch1', op: 'assert', subject: 'ent_hero', predicate: 'location', value: '废弃站台' },
    ],
    subject: 'ent_hero',
    context: 'global',
  },
};

/**
 * 脚本化 Mock LLM：按预设序列依次返回，不调外部 API（对齐 w13-draft-unification.test.ts）。
 * 用尽后停留在末条，避免 ReAct 循环里无限索取。
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

interface Env {
  db: ReturnType<SQLiteFactStoreAdapter['getDatabase']>;
  toolRouter: ToolRouter;
  agentStore: SQLiteAgentStoreAdapter;
  writingStore: SQLiteWritingStore;
  workflowService: WorkflowService;
  draftService: DraftService;
  coreBridge: RealCoreBridge;
  writingProjectId: string;
}

/** 搭建真实 Core 栈 + writingLayer（含 ent_hero 实体 + sketch 回填） */
function createEnv(): Env {
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

  const writingStore = new SQLiteWritingStore(db);
  writingStore.createTables();
  const audit = new AuditService(writingStore);
  const workflowService = new WorkflowService(writingStore, audit);
  const coreBridge = new RealCoreBridge(toolRouter, writingStore, audit);
  const draftService = new DraftService(writingStore, audit, coreBridge, workflowService);
  // EntityService 仅为构造完整性注入（本测试场景不依赖它，但保持与真实 CLI 注入集一致）
  void new EntityService(writingStore, audit, workflowService);
  const writingProjectId = writingStore.createProject('权限测试作品').id;

  // Core 注册测试实体（propose_event 的 subject 必须引用已存在实体，见 CLAUDE.md 陷阱 5）
  db.exec(`INSERT INTO entities (id, name, kind, first_appearance) VALUES ('ent_hero', '主角', 'entity', 1)`);
  // sketch 回填 coreEntityId——使 resolveEntityName 能把 ent_hero 解析为「主角」（§9.1 不泄漏 id）
  const sketch = writingStore.createEntitySketch(writingProjectId, {
    displayName: '主角', typeLabel: '角色', status: 'registered',
  });
  writingStore.updateEntitySketch(sketch.id, { coreEntityId: 'ent_hero' });

  return { db, toolRouter, agentStore, writingStore, workflowService, draftService, coreBridge, writingProjectId };
}

/** 构造注入了 writingLayer 的 Agent（env 内的 draftService/coreBridge 已由 createEnv 建好） */
function makeAgent(env: Env, script: ToolCallResult[]): NarrativeAgent {
  return new NarrativeAgent({
    llm: new ScriptedMockLLM(script),
    toolRouter: env.toolRouter,
    agentStore: env.agentStore,
    projectId: 'default',
    limits: { maxToolSteps: 8, maxRepeatedToolFailure: 3, maxWallClockMs: 60000 },
    writingProjectId: env.writingProjectId,
    writingStore: env.writingStore,
    auditService: new AuditService(env.writingStore),
    workflowService: env.workflowService,
    draftService: env.draftService,
    coreBridge: env.coreBridge,
  });
}

describe('W2 · 权限强制运行时（assertAgentMayCall 接入）', () => {
  let env: Env;

  beforeEach(() => {
    env = createEnv();
  });

  it('场景1：作者"确认"经确认通道提交 → assert 放行 → fact 真正落库 Core', async () => {
    const agent = makeAgent(env, [
      // 回合1：propose_event → 物化 open PV + confirm_proposal 决策；收尾文本
      { content: '', toolCalls: [PROPOSE_TOOL_CALL] },
      { content: '已记录事件草案，等待你确认。', toolCalls: undefined },
      // 回合2（'确认'）由 handlePendingDecisions 在 ReAct 前拦截，不消费 LLM；
      // 末条作安全兜底（若意外进入 ReAct，无 toolCalls 立即返回）
      { content: '', toolCalls: undefined },
    ]);
    agent.startSession('perm-enforce');

    // 回合1：提案
    await agent.processUserInput('让主角抵达废弃站台');
    const pvsAfterPropose = env.writingStore.listProposalViews(env.writingProjectId);
    expect(pvsAfterPropose.length).toBe(1);
    expect(pvsAfterPropose[0]!.status).toBe('open');

    // 回合2：作者确认（走 applyDecisionConfirm，内部 6 处 assert 带 caller 标记豁免，不抛错）
    const result = await agent.processUserInput('确认');
    expect(result.status).toBe('completed');

    // 提交真正抵达 Core：ent_hero 的 location 事实存在（非仅 PV 状态标记）
    const facts = env.db.prepare(
      `SELECT value_scalar FROM facts WHERE subject = 'ent_hero' AND predicate = 'location' AND is_current = 1`,
    ).all() as { value_scalar: string }[];
    expect(facts.some((f) => f.value_scalar === '废弃站台')).toBe(true);

    // PV → committed；PendingDecision → resolved（listPendingDecisions 只返回 open，应为空）
    const pvsAfterCommit = env.writingStore.listProposalViews(env.writingProjectId);
    expect(pvsAfterCommit[0]!.status).toBe('committed');
    const ctx = makeRequestContext({ projectId: env.writingProjectId });
    expect(env.workflowService.listPendingDecisions(ctx).length).toBe(0);
  }, 30000);

  it('场景2：裸路径（无 caller 标记）直接调 commitReviewedProposal → 抛 AGENT_COMMIT_FORBIDDEN', () => {
    // 模拟未来某处误增的"Agent 自动路径直接提交"调用——权限矩阵应拦下
    try {
      assertAgentMayCall('CoreBridgeService.commitReviewedProposal');
      throw new Error('应抛错但未抛');
    } catch (e) {
      expect(e).toBeInstanceOf(WritingError);
      expect((e as WritingError).code).toBe(WritingErrorCode.AGENT_COMMIT_FORBIDDEN);
    }

    // registerReviewedEntity 同理抛 AGENT_REGISTER_FORBIDDEN（实体注册类，区别于提交类）
    try {
      assertAgentMayCall('CoreBridgeService.registerReviewedEntity');
      throw new Error('应抛错但未抛');
    } catch (e) {
      expect(e).toBeInstanceOf(WritingError);
      expect((e as WritingError).code).toBe(WritingErrorCode.AGENT_REGISTER_FORBIDDEN);
    }
  });

  it('场景3：writingLayer Agent 调裸提交入口（handleConfirmCommit）→ 抛 COMMIT_WITHOUT_REVIEW', async () => {
    // handleConfirmCommit 是裸路径的直提 commit_event 入口（不经 PV 审核）。writingLayer 模式
    // （writingStore 已注入）下调用它即"绕过 Proposal Review 审核"。现有两个公开调用点均用
    // !this.writingStore 守卫，故永不触发——这里**绕过守卫直接调私有方法**，模拟未来某处误删
    // 调用点守卫的回归。验证：handleConfirmCommit 顶部守卫立即抛 COMMIT_WITHOUT_REVIEW，
    // 而非静默裸提交（激活此前无 throw 点的死错误码，转隐性假设为显式可测不变式）。
    const agent = makeAgent(env, [
      { content: '', toolCalls: undefined },
    ]);
    agent.startSession('commit-without-review');

    await expect(
      (agent as unknown as { handleConfirmCommit: (t: string) => Promise<unknown> }).handleConfirmCommit('t1'),
    ).rejects.toThrow();

    // 进一步精确断言：抛的是 WritingError，code 为 COMMIT_WITHOUT_REVIEW（而非通用 Error）
    try {
      await (agent as unknown as { handleConfirmCommit: (t: string) => Promise<unknown> })
        .handleConfirmCommit('t2');
      throw new Error('应抛错但未抛');
    } catch (e) {
      expect(e).toBeInstanceOf(WritingError);
      expect((e as WritingError).code).toBe(WritingErrorCode.COMMIT_WITHOUT_REVIEW);
    }
  }, 30000);
});

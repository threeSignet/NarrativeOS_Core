// =============================================================================
// W2：权限强制运行时测试（assertAgentMayCall 接入后）
// =============================================================================
// 验证两个运行时不变式：
//   场景1：作者"确认"经确认通道（applyDecisionConfirm，带 AUTHOR_CONFIRM_CHANNEL caller）
//          调用 commitReviewedProposal → assert 放行 → 提交真正抵达 Core（fact 落库）。
//          需要 DEEPSEEK_API_KEY（真实 LLM 驱动 propose_event）。
//   场景2：裸 Agent 路径（无 caller 标记）直接调 commitReviewedProposal → 抛 AGENT_COMMIT_FORBIDDEN；
//          registerReviewedEntity → 抛 AGENT_REGISTER_FORBIDDEN。
//          纯函数调用，不需要 API key。
//   场景3：writingLayer Agent 调裸提交入口（handleConfirmCommit）→ 抛 COMMIT_WITHOUT_REVIEW。
//          纯函数调用，不需要 API key。
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
import { DeepSeekLLMClientAdapter } from '../../src/adapters/llm/deepseek-client.js';
import { SQLiteWritingStore } from '../../src/writing/repositories/writing-store.js';
import { AuditService } from '../../src/writing/services/audit-service.js';
import { WorkflowService } from '../../src/writing/services/workflow-service.js';
import { DraftService } from '../../src/writing/services/draft-service.js';
import { EntityService } from '../../src/writing/services/entity-service.js';
import { RealCoreBridge } from '../../src/writing/core-bridge/real-bridge.js';
import { makeRequestContext } from '../../src/writing/services/context.js';
import { assertAgentMayCall } from '../../src/writing/agent/permission-check.js';
import { WritingError, WritingErrorCode } from '../../src/writing/errors/error-codes.js';

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
  void new EntityService(writingStore, audit, workflowService);
  const writingProjectId = writingStore.createProject('权限测试作品').id;

  db.exec(`INSERT INTO entities (id, name, kind, first_appearance) VALUES ('ent_hero', '主角', 'entity', 1)`);
  const sketch = writingStore.createEntitySketch(writingProjectId, {
    displayName: '主角', typeLabel: '角色', status: 'registered',
  });
  writingStore.updateEntitySketch(sketch.id, { coreEntityId: 'ent_hero' });

  return { db, toolRouter, agentStore, writingStore, workflowService, draftService, coreBridge, writingProjectId };
}

/** 构造注入了 writingLayer 的 Agent */
function makeAgent(env: Env): NarrativeAgent {
  return new NarrativeAgent({
    llm: new DeepSeekLLMClientAdapter(),
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

const HAS_API_KEY = !!process.env['DEEPSEEK_API_KEY'];
const describeIfReal = HAS_API_KEY ? describe : describe.skip;

describeIfReal('W2 · 权限强制运行时（assertAgentMayCall 接入）', () => {
  let env: Env;

  beforeEach(() => {
    env = createEnv();
  });

  it('场景1：作者"确认"经确认通道提交 → assert 放行 → fact 真正落库 Core', async () => {
    const agent = makeAgent(env);
    agent.startSession('perm-enforce');

    // 回合1：LLM 推演事件（propose_event）
    await agent.processUserInput('让主角抵达废弃站台');
    const pvsAfterPropose = env.writingStore.listProposalViews(env.writingProjectId);
    expect(pvsAfterPropose.length).toBe(1);
    expect(pvsAfterPropose[0]!.status).toBe('open');

    // 回合2：作者确认（走 applyDecisionConfirm，内部 6 处 assert 带 caller 标记豁免）
    const result = await agent.processUserInput('确认');
    expect(result.status).toBe('completed');

    // 提交真正抵达 Core
    const facts = env.db.prepare(
      `SELECT value_scalar FROM facts WHERE subject = 'ent_hero' AND predicate = 'location' AND is_current = 1`,
    ).all() as { value_scalar: string }[];
    expect(facts.some((f) => f.value_scalar === '废弃站台')).toBe(true);

    const pvsAfterCommit = env.writingStore.listProposalViews(env.writingProjectId);
    expect(pvsAfterCommit[0]!.status).toBe('committed');
    const ctx = makeRequestContext({ projectId: env.writingProjectId });
    expect(env.workflowService.listPendingDecisions(ctx).length).toBe(0);
  }, 60000);
});

describe('W2 · 权限强制运行时（纯函数，不需要 API key）', () => {
  it('场景2：裸路径（无 caller 标记）直接调 commitReviewedProposal → 抛 AGENT_COMMIT_FORBIDDEN', () => {
    try {
      assertAgentMayCall('CoreBridgeService.commitReviewedProposal');
      throw new Error('应抛错但未抛');
    } catch (e) {
      expect(e).toBeInstanceOf(WritingError);
      expect((e as WritingError).code).toBe(WritingErrorCode.AGENT_COMMIT_FORBIDDEN);
    }

    try {
      assertAgentMayCall('CoreBridgeService.registerReviewedEntity');
      throw new Error('应抛错但未抛');
    } catch (e) {
      expect(e).toBeInstanceOf(WritingError);
      expect((e as WritingError).code).toBe(WritingErrorCode.AGENT_REGISTER_FORBIDDEN);
    }
  });

  it('场景3：writingLayer Agent 调裸提交入口（handleConfirmCommit）→ 抛 COMMIT_WITHOUT_REVIEW', async () => {
    const env = createEnv();
    const agent = makeAgent(env);
    agent.startSession('commit-without-review');

    await expect(
      (agent as unknown as { handleConfirmCommit: (t: string) => Promise<unknown> }).handleConfirmCommit('t1'),
    ).rejects.toThrow();

    try {
      await (agent as unknown as { handleConfirmCommit: (t: string) => Promise<unknown> })
        .handleConfirmCommit('t2');
      throw new Error('应抛错但未抛');
    } catch (e) {
      expect(e).toBeInstanceOf(WritingError);
      expect((e as WritingError).code).toBe(WritingErrorCode.COMMIT_WITHOUT_REVIEW);
    }
  });
});

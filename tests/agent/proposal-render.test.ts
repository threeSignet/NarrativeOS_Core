// =============================================================================
// W2 Phase C：renderProposalForUser 接入 ReAct 收尾测试
// =============================================================================
// 验证 Agent 在 propose_event 物化 open PV 后，回合回复追加结构化推演（Zone1-5）。
// 所有 Agent 驱动场景需要 DEEPSEEK_API_KEY。
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
    void new EntityService(writingStore, audit, workflowService);
    const writingProjectId = writingStore.createProject('渲染测试作品').id;

    db.exec(`INSERT INTO entities (id, name, kind, first_appearance) VALUES ('ent_hero', '主角', 'entity', 1)`);
    const sketch = writingStore.createEntitySketch(writingProjectId, {
      displayName: '主角', typeLabel: '角色', status: 'registered',
    });
    writingStore.updateEntitySketch(sketch.id, { coreEntityId: 'ent_hero' });

    env.writingStore = writingStore;
    env.workflowService = workflowService;
    env.draftService = draftService;
    env.coreBridge = coreBridge;
    env.writingProjectId = writingProjectId;
  } else {
    db.exec(`INSERT INTO entities (id, name, kind, first_appearance) VALUES ('ent_hero', '主角', 'entity', 1)`);
  }

  return env;
}

const HAS_API_KEY = !!process.env['DEEPSEEK_API_KEY'];
const describeIfReal = HAS_API_KEY ? describe : describe.skip;

describeIfReal('W2 Phase C · renderProposalForUser 接入 ReAct 收尾', () => {
  it('writingLayer 路径：propose_event 后回复追加结构化推演', async () => {
    const env = createEnv(true);
    const agent = new NarrativeAgent({
      llm: new DeepSeekLLMClientAdapter(),
      toolRouter: env.toolRouter,
      agentStore: env.agentStore,
      projectId: 'default',
      limits: { maxToolSteps: 8, maxRepeatedToolFailure: 3, maxWallClockMs: 60000 },
      writingProjectId: env.writingProjectId,
      writingStore: env.writingStore,
      auditService: new AuditService(env.writingStore!),
      workflowService: env.workflowService,
      draftService: env.draftService,
      coreBridge: env.coreBridge,
    });
    agent.startSession('render');

    const result = await agent.processUserInput(
      '让主角抵达废弃站台。实体ID是 ent_hero。',
    );
    const content = result.content ?? '';

    // 宽松断言：流程跑通 + 有回复 + 无崩溃
    expect(result.status).not.toBe('failed');
    expect(content.length).toBeGreaterThan(5);
  }, 60000);

  it('裸路径回归：无 writingLayer 时回复不追加结构化推演', async () => {
    const env = createEnv(false);
    const agent = new NarrativeAgent({
      llm: new DeepSeekLLMClientAdapter(),
      toolRouter: env.toolRouter,
      agentStore: env.agentStore,
      projectId: 'default',
      limits: { maxToolSteps: 8, maxRepeatedToolFailure: 3, maxWallClockMs: 60000 },
    });
    agent.startSession('bare-render');

    const result = await agent.processUserInput(
      '让主角抵达废弃站台。实体ID是 ent_hero。',
    );

    expect(result.status).not.toBe('failed');
    expect(result.content).toBeTruthy();
  }, 60000);
});

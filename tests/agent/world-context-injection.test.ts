// =============================================================================
// W2 Fix-3：世界段注入端到端运行时测试
// =============================================================================
// 验证 Agent 在有 committed fact 的环境下能正常工作（世界上下文注入路径畅通）。
// 需要 DEEPSEEK_API_KEY。
// =============================================================================

import { describe, it, expect } from 'vitest';
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

function createEnv() {
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
  const writingProjectId = writingStore.createProject('世界注入测试作品').id;

  db.exec(`INSERT INTO entities (id, name, kind, first_appearance) VALUES ('ent_hero', '主角', 'entity', 1)`);
  const sketch = writingStore.createEntitySketch(writingProjectId, {
    displayName: '主角', typeLabel: '角色', status: 'registered',
  });
  writingStore.updateEntitySketch(sketch.id, { coreEntityId: 'ent_hero' });

  return { db, toolRouter, agentStore, writingStore, workflowService, draftService, coreBridge, writingProjectId };
}

const HAS_API_KEY = !!process.env['DEEPSEEK_API_KEY'];
const describeIfReal = HAS_API_KEY ? describe : describe.skip;

describeIfReal('W2 Fix-3 · 世界段注入运行时', () => {
  it('已 commit 的事实环境下 Agent 能正常工作', async () => {
    const env = createEnv();

    // commit 一条事实
    const proposeResult = await env.toolRouter.execute('propose_event', {
      event_type: 'custom',
      event_description: '主角抵达废弃站台',
      chapter: 1,
      subject: 'ent_hero',
      fact_changes: [
        { change_id: 'c1', op: 'assert', subject: 'ent_hero', predicate: 'location', value: '废弃站台' },
      ],
    });
    expect(proposeResult.success).toBe(true);
    const pid = (proposeResult.data as { proposalId: string }).proposalId;
    const commitResult = await env.toolRouter.execute('commit_event', { proposal_id: pid });
    expect(commitResult.success).toBe(true);

    // 用真实 LLM 启动 Agent 回合
    const agent = new NarrativeAgent({
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
    agent.startSession('world-inj');

    const result = await agent.processUserInput('继续描写主角接下来的行动');

    // 宽松断言：流程跑通、有回复、无崩溃
    expect(result.status).not.toBe('failed');
    expect(result.content).toBeTruthy();
    expect(result.content.length).toBeGreaterThan(5);
  }, 60000);

  it('无 coreBridge 时降级不抛错', async () => {
    const env = createEnv();

    const agent = new NarrativeAgent({
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
      // 故意不传 coreBridge
    });
    agent.startSession('world-inj-fallback');

    const result = await agent.processUserInput('继续描写主角接下来的行动');

    expect(result.status).not.toBe('failed');
    expect(result.content).toBeTruthy();
  }, 60000);
});

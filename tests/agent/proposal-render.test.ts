// =============================================================================
// W2 Phase C：renderProposalForUser 接入 ReAct 收尾测试
// =============================================================================
// 验证 Agent 在 propose_event 物化 open PV 后，回合回复追加结构化推演（Zone1-5），
// 使作者无需主动 /review 即可在对话里看到"系统准备写入什么、有哪些一致性风险"。
//
// 范式：脚本化 Mock LLM + 真实 Core/writing 栈（对齐 w13-draft-unification.test.ts）。
// 不依赖 DeepSeek key（CI 稳定）。
//
// 覆盖：
//   - writingLayer 路径：回复含 Zone1-5 标记 + 下一步指引；**绝不裸露 ent_ id**（§9.1）
//   - 裸路径回归（无 writingLayer）：回复不追加结构化推演，保持原 LLM 文本
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
import type { LLMClient, ToolCallResult } from '../../src/types/llm.js';

/** 一次 propose_event 工具调用（subject=ent_hero，sketch 回填显示名「主角」） */
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

/** 单回合脚本：propose_event → 文本收尾 */
function singleTurnProposeScript(): ToolCallResult[] {
  return [
    { content: '', toolCalls: [PROPOSE_TOOL_CALL] },
    { content: '已记录事件草案，等待你确认。', toolCalls: undefined },
  ];
}

/** 脚本化 Mock LLM（对齐 w13-draft-unification.test.ts） */
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
  writingStore?: SQLiteWritingStore;
  workflowService?: WorkflowService;
  draftService?: DraftService;
  coreBridge?: RealCoreBridge;
  writingProjectId?: string;
}

/** 搭建真实 Core 栈；withWritingLayer=true 时额外接入写作层（含 ent_hero + sketch 回填） */
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
    // 裸路径也需 Core 实体（propose_event 引用 ent_hero）
    db.exec(`INSERT INTO entities (id, name, kind, first_appearance) VALUES ('ent_hero', '主角', 'entity', 1)`);
  }

  return env;
}

describe('W2 Phase C · renderProposalForUser 接入 ReAct 收尾', () => {
  it('writingLayer 路径：propose_event 后回复追加 Zone1-5 结构化推演，且不泄漏 ent_ id', async () => {
    const env = createEnv(true);
    const agent = new NarrativeAgent({
      llm: new ScriptedMockLLM(singleTurnProposeScript()),
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

    const result = await agent.processUserInput('让主角抵达废弃站台');
    const content = result.content ?? '';

    // Zone1：事件推演摘要（前缀稳定，不依赖具体人话措辞）
    expect(content).toContain('📋 事件推演：');
    // Zone2：设定变更区（factDiff 非空时渲染）
    expect(content).toContain('【设定变更】');
    // Zone3：一致性检查区（无冲突时显式 ✅）
    expect(content).toContain('【一致性检查】');
    // Zone4：涉及实体区——显示名「主角」，非裸 ent_hero id
    expect(content).toContain('【涉及实体】');
    expect(content).toContain('主角');
    // Zone5：推演输入区（事件描述 + 类型 + 章节）
    expect(content).toContain('【推演输入】');
    expect(content).toContain('主角抵达废弃站台');
    // 下一步动作指引（Zone6 由 applyDecisionConfirm 承担，此处只给指引）
    expect(content).toContain('回复');

    // §9.1 合规：normal 模式绝不泄漏裸实体 ID
    expect(content).not.toContain('ent_hero');
  }, 30000);

  it('裸路径回归：无 writingLayer 时回复不追加结构化推演，保持原 LLM 文本', async () => {
    const env = createEnv(false);
    const agent = new NarrativeAgent({
      llm: new ScriptedMockLLM(singleTurnProposeScript()),
      toolRouter: env.toolRouter,
      agentStore: env.agentStore,
      projectId: 'default',
      limits: { maxToolSteps: 8, maxRepeatedToolFailure: 3, maxWallClockMs: 60000 },
    });
    agent.startSession('bare-render');

    const result = await agent.processUserInput('让主角抵达废弃站台');
    const content = result.content ?? '';

    // 裸路径无 writingLayer → 不追加结构化推演（保护既有行为）
    expect(content).not.toContain('📋 事件推演：');
    expect(content).not.toContain('【设定变更】');
    // 但裸路径仍正常工作（pending 堆积，commitAuthority 默认 explicit 不自动提交）
    expect(result.status).not.toBe('failed');
    expect(agent.getState().pendingProposalIds.length).toBe(1);
  }, 30000);
});

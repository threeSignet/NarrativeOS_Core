// =============================================================================
// W2 Fix-3：世界段注入端到端运行时测试（worldSnapshot → LLM 消息）
// =============================================================================
// 验证 runReActLoop 每回合预取的 Core 世界快照，真的把"实体 + 当前设定事实"渲染进了
// 发给 LLM 的 system message（不只是编译期穿透，而是运行时消息内容）。
//
// 这是 Fix-3 的最强证据：在真实 Core 栈里 commit 一条事实 → 下一回合 Agent 的 LLM 上下文
// 必须含该事实的紧凑渲染（location=废弃站台）。若预取 / 穿透 / 渲染任一环节断裂，此断言失败。
//
// 范式：真实 Core/writing 栈 + 捕获型 Mock LLM（记录 chatWithTools 收到的 messages）。
// 不依赖 DeepSeek key（CI 稳定）。对齐 proposal-render.test.ts 的 createEnv 真实栈搭建。
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
import { SQLiteWritingStore } from '../../src/writing/repositories/writing-store.js';
import { AuditService } from '../../src/writing/services/audit-service.js';
import { WorkflowService } from '../../src/writing/services/workflow-service.js';
import { DraftService } from '../../src/writing/services/draft-service.js';
import { EntityService } from '../../src/writing/services/entity-service.js';
import { RealCoreBridge } from '../../src/writing/core-bridge/real-bridge.js';
import type { LLMClient, ToolCallResult, ChatMessage } from '../../src/types/llm.js';

/**
 * 捕获型 Mock LLM：记录每次 chatWithTools 收到的 messages，脚本化返回结果。
 *
 * 用于断言 Agent 实际发给 LLM 的上下文里是否含世界段（system message 通道）。
 */
class CapturingMockLLM implements LLMClient {
  /** 累计所有调用收到的 messages（每轮 ReAct 迭代一条） */
  readonly capturedMessages: ChatMessage[] = [];
  private idx = 0;
  constructor(private readonly script: ToolCallResult[]) {}
  async chat(): Promise<string> { return ''; }
  async chatWithTools(messages: ChatMessage[]): Promise<ToolCallResult> {
    // 记录本轮 LLM 收到的完整上下文
    this.capturedMessages.push(...messages);
    const last = this.script[this.script.length - 1]!;
    const step = this.script[this.idx] ?? last;
    if (this.idx < this.script.length - 1) this.idx++;
    return step;
  }
}

/** 搭建真实 Core 栈 + writingLayer（ent_hero + sketch 回填显示名「主角」） */
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

  // Core 实体 + 写作层草图回填（readCurrentWorldSnapshot 枚举 registered + coreEntityId 已回填的草图）
  db.exec(`INSERT INTO entities (id, name, kind, first_appearance) VALUES ('ent_hero', '主角', 'entity', 1)`);
  const sketch = writingStore.createEntitySketch(writingProjectId, {
    displayName: '主角', typeLabel: '角色', status: 'registered',
  });
  writingStore.updateEntitySketch(sketch.id, { coreEntityId: 'ent_hero' });

  return { db, toolRouter, agentStore, writingStore, workflowService, draftService, coreBridge, writingProjectId };
}

describe('W2 Fix-3 · 世界段注入运行时（committed fact → LLM 消息）', () => {
  it('已 commit 的事实经预取渲染进 LLM 的 system message（富实体段含 predicate=value）', async () => {
    const env = createEnv();

    // ---- 步骤 1：在真实 Core 里 commit 一条事实（location=废弃站台）----
    // 用 propose_event → commit_event 真实路径写入（与 live-agent-session.ts 一致）。
    // 这条事实将在下一回合被 readCurrentWorldSnapshot 经 get_context_slice 读出。
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

    // ---- 步骤 2：用捕获型 Mock 启动一个新 Agent 回合 ----
    // 脚本：单轮纯文本回复（不发起工具调用）——本测试只关心 LLM 收到的上下文，不关心回合产出。
    const llm = new CapturingMockLLM([
      { content: '好的，我了解主角目前在废弃站台。', toolCalls: undefined },
    ]);
    const agent = new NarrativeAgent({
      llm,
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

    await agent.processUserInput('继续描写主角接下来的行动');

    // ---- 步骤 3：断言 LLM 收到的上下文含世界段 + 已 commit 的事实 ----
    // 把所有捕获的 system message 内容拼起来检索（世界段是其中一条 system message）
    const systemText = llm.capturedMessages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n');

    // 富实体段标题（区分于轻量 sketch 段——证明 worldSnapshot 真的被消费）
    expect(systemText).toContain('当前已注册实体与世界状态');
    // 实体行：name (coreEntityId, typeLabel)——coreEntityId 注入给 LLM（system 通道）
    expect(systemText).toContain('主角 (ent_hero, 角色)');
    // 已 commit 事实的紧凑渲染——这是 Fix-3 的核心断言：committed fact 真的进了 LLM 上下文
    expect(systemText).toContain('location=废弃站台');
  }, 30000);

  it('无 coreBridge（部分接线）时降级为轻量 sketch 实体段，不抛错', async () => {
    const env = createEnv();

    // 不传 coreBridge → writingLayer.coreBridge 为 undefined → 预取跳过 → assembleWritingContext
    // 回落轻量 sketch 段（仅 name+id+type，不含事实）。验证降级路径运行时可用。
    const llm = new CapturingMockLLM([
      { content: '好的。', toolCalls: undefined },
    ]);
    const agent = new NarrativeAgent({
      llm,
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

    // 降级路径不阻断回合（读取用于增强上下文，非正确性必需）
    expect(result.status).not.toBe('failed');

    const systemText = llm.capturedMessages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n');
    // 轻量 sketch 段标题（无"与世界状态"后缀——区分富段）
    expect(systemText).toContain('当前已注册实体');
    expect(systemText).not.toContain('当前已注册实体与世界状态');
    // 实体行仍含 coreEntityId（LLM 仍需它构造 subject）
    expect(systemText).toContain('主角 (ent_hero, 角色)');
  }, 30000);
});

// =============================================================================
// commit_event 门控运行时测试（W1）
// =============================================================================
// 验证 Agent 的 ReAct 循环在 LLM 真正发起 commit_event 工具调用时：
//   1. 被 tool-permissions 门控拦截为 AGENT_COMMIT_FORBIDDEN（trace 可见）
//   2. 该调用从未抵达 ToolRouter（用 execute 间谍计数验证）→ 写不进 Core
//   3. 回合不崩溃（LLM 收到权限错误后转为文本回复，正常收尾）
//
// 关键：本测试不依赖 DEEPSEEK_API_KEY——用脚本化 Mock LLM 替身驱动真实 Agent + 真实 Core，
// 因此可在 CI 无 key 环境稳定运行（也是 W18 Mock 化测试范式的早期样例）。

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
import type { LLMClient, ToolCallResult } from '../../src/types/llm.js';

/**
 * 脚本化 Mock LLM：按预设序列依次返回响应，不调用任何外部 API。
 * 第 1 轮返回 commit_event 工具调用（模拟 LLM 试图自行提交）；
 * 第 2 轮起返回纯文本（模拟 LLM 收到权限错误后改为引导用户确认）。
 */
class ScriptedMockLLM implements LLMClient {
  private idx = 0;
  constructor(private readonly script: ToolCallResult[]) {}

  async chat(): Promise<string> {
    // detectIntent 是关键词规则不走 chat；memory 提取即便调用也容忍空串。
    return '';
  }

  async chatWithTools(): Promise<ToolCallResult> {
    const last = this.script[this.script.length - 1]!;
    const step = this.script[this.idx] ?? last;
    if (this.idx < this.script.length - 1) this.idx++;
    return step;
  }
}

function createEnv() {
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
  const toolRouter = new ToolRouter({
    proposalManager, retconEngine, toolService,
    schemaExtensionManager, factStore, knowledgeStore, eventStore, threadStore,
  });
  const agentStore = new SQLiteAgentStoreAdapter(db);
  agentStore.createTables();

  const llm = new ScriptedMockLLM([
    // 第 1 轮：LLM 试图绕过确认直接提交
    { content: '', toolCalls: [{ name: 'commit_event', arguments: { proposal_id: 'fake_proposal_001' } }] },
    // 第 2 轮：收到 AGENT_COMMIT_FORBIDDEN 后改为文本引导
    { content: '推演已完成，请确认是否提交。', toolCalls: undefined },
  ]);

  const agent = new NarrativeAgent({
    llm,
    toolRouter,
    agentStore,
    projectId: 'default',
    limits: { maxToolSteps: 8, maxRepeatedToolFailure: 3, maxWallClockMs: 60000 },
  });

  return { db, eventStore, toolRouter, agent };
}

describe('W1: commit_event Agent 门控（运行时）', () => {
  let env: ReturnType<typeof createEnv>;
  beforeEach(() => {
    env = createEnv();
  });

  it('LLM 发起 commit_event 应被拦截为 AGENT_COMMIT_FORBIDDEN，且不抵达 ToolRouter', async () => {
    // 间谍：统计 commit_event 是否真的被转发到 ToolRouter.execute。
    // 门控正确时该计数必须为 0（在 ToolRouter 之前短路）。
    let commitReachedCore = 0;
    const origExecute = env.toolRouter.execute.bind(env.toolRouter);
    env.toolRouter.execute = async (toolName: string, params: Record<string, unknown>) => {
      if (toolName === 'commit_event') commitReachedCore++;
      return origExecute(toolName, params);
    };

    env.agent.startSession('gate-test');
    const result = await env.agent.processUserInput('帮我记录一个测试事件');

    // 1. 回合不应崩溃（mock 第 2 轮转文本后正常收尾）
    expect(result.status).not.toBe('failed');

    // 2. trace 中应记录 commit_event 被权限门控拦截
    const traces = env.agent.getState().traceBuffer;
    const blocked = traces.find(
      t => t.toolName === 'commit_event' && t.errorCode === 'AGENT_COMMIT_FORBIDDEN',
    );
    expect(blocked).toBeDefined();

    // 3. 门控在 ToolRouter 之前短路——commit_event 从未抵达 Core
    expect(commitReachedCore).toBe(0);
  }, 30000);
});

// =============================================================================
// W18-a 测试：MockLLMClient —— 确定性 LLM Mock（测试基础设施）
// =============================================================================
// §18.1 测试策略：外部 API（DeepSeek LLM）必须 Mock。本测试锁定 MockLLMClient
// 作为确定性 e2e 地基的全部不变式，让真实 ReAct 循环可被预置脚本精确驱动。
//
// 覆盖：
//   1. 实现 LLMClient 接口（chat / chatWithTools / chatWithToolsStream）
//   2. 队列按调用顺序消费（确定性）
//   3. toolCalls 透传 + arguments 保持对象（防 double-stringify）
//   4. 空 toolCalls 数组 → 归一化 undefined（防 Agent 误判"有工具调用"）
//   5. 队列耗尽 + 无兜底 → 显式抛错（防静默空响应 → ReAct 误判/隐藏 bug）
//   6. defaultResponse 兜底 / responder 动态响应 / responder 优先于队列
//   7. 调用历史记录（method/callIndex/tools/response，跨方法递增）
//   8. chat 纯文本路径 / chatWithToolsStream onToken 契约
//   9. reasoningContent 回传
//  10. queueResponse 运行时追加 / resetCalls 清记录保队列 / 入参数组不被污染 / calls 返回副本
//  11. 防御：toolCalls.arguments 非对象 → 抛错
// =============================================================================

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { MockLLMClient } from '../../src/adapters/llm/mock-llm-client.js';
import type { MockLLMResponse } from '../../src/adapters/llm/mock-llm-client.js';
import type { LLMClient, ChatMessage, ToolDefinition } from '../../src/types.js';
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

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

const msgs: ChatMessage[] = [{ role: 'user', content: '测试输入' }];
const tools: ToolDefinition[] = [
  { name: 'register_entity', description: '注册实体', parameters: { type: 'object' } },
];

const textResponse = (content: string): MockLLMResponse => ({ content });
const toolResponse = (
  name: string,
  args: Record<string, unknown> = {},
): MockLLMResponse => ({ toolCalls: [{ name, arguments: args }] });

// ===========================================================================
// 接口契约
// ===========================================================================

describe('MockLLMClient — 接口实现', () => {
  it('实现 LLMClient 接口（具备 chat / chatWithTools / chatWithToolsStream 方法）', () => {
    const mock = new MockLLMClient({ responses: [textResponse('hi')] });
    // 类型层面满足 LLMClient（编译期保证）；运行期校验方法存在
    const asClient: LLMClient = mock;
    expect(typeof asClient.chat).toBe('function');
    expect(typeof asClient.chatWithTools).toBe('function');
    expect(typeof asClient.chatWithToolsStream).toBe('function');
  });
});

// ===========================================================================
// 队列消费（确定性）
// ===========================================================================

describe('MockLLMClient — 队列消费', () => {
  it('按调用顺序消费 responses（先 r0 后 r1 后 r2）', async () => {
    const mock = new MockLLMClient({
      responses: [toolResponse('a'), toolResponse('b'), textResponse('done')],
    });

    const r0 = await mock.chatWithTools(msgs, tools);
    const r1 = await mock.chatWithTools(msgs, tools);
    const r2 = await mock.chatWithTools(msgs, tools);

    expect(r0.toolCalls?.[0]?.name).toBe('a');
    expect(r1.toolCalls?.[0]?.name).toBe('b');
    expect(r2.toolCalls).toBeUndefined(); // 纯文本 → 归一化 undefined
    expect(r2.content).toBe('done');
  });

  it('toolCalls 透传且 arguments 保持为对象（Agent 会 JSON.stringify，须防 double-stringify）', async () => {
    const mock = new MockLLMClient({
      responses: [{ toolCalls: [{ name: 'register_entity', arguments: { name: '韩立', kind: 'entity' } }] }],
    });

    const result = await mock.chatWithTools(msgs, tools);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0]!.name).toBe('register_entity');
    // arguments 必须是对象——若 Mock 返回字符串 '{"name":"韩立"}'，Agent JSON.stringify 后会变成
    // '"{\"name\":\"韩立\"}"'（double-stringify），污染 ToolRouter 参数解析。
    expect(result.toolCalls![0]!.arguments).toEqual({ name: '韩立', kind: 'entity' });
  });

  it('空数组 toolCalls → 归一化为 undefined（与真实 adapter 一致，防 Agent 误判有工具调用）', async () => {
    // 若返回 { toolCalls: [] }，Agent 的 `toolCalls.length > 0` 判断虽为 false，
    // 但归一化为 undefined 让"无工具调用"语义与真实 DeepSeek adapter 完全一致，消除歧义。
    const mock = new MockLLMClient({ responses: [{ content: '纯文本', toolCalls: [] }] });
    const result = await mock.chatWithTools(msgs, tools);
    expect(result.toolCalls).toBeUndefined();
    expect(result.content).toBe('纯文本');
  });

  it('队列耗尽 + 无 responder + 无 defaultResponse → 抛显式错误（防静默空响应）', async () => {
    const mock = new MockLLMClient({ responses: [textResponse('only one')] });
    await mock.chatWithTools(msgs, tools);

    // 第二次无预置响应——必须抛错，不能返回空 ToolCallResult 让 ReAct 假绿
    await expect(mock.chatWithTools(msgs, tools)).rejects.toThrow(/MOCK_LLM_ERROR.*第 1 次.*无预置响应/);
  });
});

// ===========================================================================
// 兜底与动态响应
// ===========================================================================

describe('MockLLMClient — 兜底与动态响应', () => {
  it('defaultResponse 在队列耗尽后兜底', async () => {
    const mock = new MockLLMClient({
      responses: [toolResponse('first')],
      defaultResponse: textResponse('fallback'),
    });

    await mock.chatWithTools(msgs, tools); // first
    const r1 = await mock.chatWithTools(msgs, tools); // 兜底
    const r2 = await mock.chatWithTools(msgs, tools); // 仍兜底

    expect(r1.content).toBe('fallback');
    expect(r2.content).toBe('fallback');
    expect(mock.pendingCount).toBe(0);
  });

  it('responder 按 callIndex 动态决定响应', async () => {
    const mock = new MockLLMClient({
      responder: (ctx) =>
        ctx.callIndex === 0
          ? toolResponse('register_entity')
          : textResponse('finished'),
    });

    const r0 = await mock.chatWithTools(msgs, tools);
    const r1 = await mock.chatWithTools(msgs, tools);
    expect(r0.toolCalls?.[0]?.name).toBe('register_entity');
    expect(r1.toolCalls).toBeUndefined();
    expect(r1.content).toBe('finished');
  });

  it('responder 优先于 responses 队列', async () => {
    const mock = new MockLLMClient({
      responses: [textResponse('from-queue')],
      responder: () => textResponse('from-responder'),
    });
    const r = await mock.chatWithTools(msgs, tools);
    expect(r.content).toBe('from-responder');
    // responder 模式下队列不被消费
    expect(mock.pendingCount).toBe(1);
  });
});

// ===========================================================================
// 调用历史记录
// ===========================================================================

describe('MockLLMClient — 调用历史', () => {
  it('记录每次调用的 method/callIndex/tools/response，且 callIndex 跨方法递增', async () => {
    const mock = new MockLLMClient({
      responses: [
        toolResponse('register_entity'),
        textResponse('reply'),
      ],
    });

    await mock.chatWithTools(msgs, tools);   // callIndex 0
    await mock.chat(msgs);                    // callIndex 1
    const calls = mock.calls;

    expect(calls).toHaveLength(2);
    expect(calls[0]!.method).toBe('chatWithTools');
    expect(calls[0]!.callIndex).toBe(0);
    expect(calls[0]!.tools).toHaveLength(1);
    expect(calls[0]!.response.toolCalls?.[0]?.name).toBe('register_entity');
    expect(calls[1]!.method).toBe('chat');
    expect(calls[1]!.callIndex).toBe(1);
    // chat 不传 tools → 记录为 undefined
    expect(calls[1]!.tools).toBeUndefined();
  });

  it('calls 返回副本，外部 mutate 不影响内部记录', async () => {
    const mock = new MockLLMClient({ responses: [textResponse('x')] });
    await mock.chatWithTools(msgs, tools);

    const snapshot = mock.calls;
    snapshot.length = 0; // 外部清空副本
    expect(mock.calls).toHaveLength(1); // 内部不受影响
  });
});

// ===========================================================================
// chat 纯文本路径 / chatWithToolsStream 流式契约
// ===========================================================================

describe('MockLLMClient — chat 与流式', () => {
  it('chat 返回 content 字符串', async () => {
    const mock = new MockLLMClient({ responses: [textResponse('纯文本回复')] });
    const text = await mock.chat(msgs);
    expect(text).toBe('纯文本回复');
  });

  it('chat 在 content 缺失时返回空串（纯文本回复允许为空）', async () => {
    const mock = new MockLLMClient({ responses: [{}] });
    expect(await mock.chat(msgs)).toBe('');
  });

  it('chatWithToolsStream 经 onToken 推送 content 并返回相同 ToolCallResult', async () => {
    const mock = new MockLLMClient({
      responses: [{ content: '流式文本', toolCalls: [{ name: 't', arguments: { x: 1 } }] }],
    });
    const tokens: string[] = [];
    const result = await mock.chatWithToolsStream(msgs, tools, (t) => tokens.push(t));

    expect(tokens).toEqual(['流式文本']); // 整段一次推送（确定性，不分片）
    expect(result.content).toBe('流式文本');
    expect(result.toolCalls?.[0]?.name).toBe('t');
  });

  it('chatWithToolsStream 在 content 为空时不调用 onToken（与真实流式无文本时一致）', async () => {
    const mock = new MockLLMClient({
      responses: [{ toolCalls: [{ name: 'no_text', arguments: {} }] }],
    });
    const tokens: string[] = [];
    const result = await mock.chatWithToolsStream(msgs, tools, (t) => tokens.push(t));
    expect(tokens).toHaveLength(0);
    expect(result.toolCalls?.[0]?.name).toBe('no_text');
  });
});

// ===========================================================================
// reasoningContent 回传
// ===========================================================================

describe('MockLLMClient — reasoningContent', () => {
  it('回传 reasoningContent（DeepSeek 思考模式后续请求需原样回传）', async () => {
    const mock = new MockLLMClient({
      responses: [{ content: '答案', reasoningContent: '因为...所以...' }],
    });
    const result = await mock.chatWithTools(msgs, tools);
    expect(result.reasoningContent).toBe('因为...所以...');
  });
});

// ===========================================================================
// 运行时编排
// ===========================================================================

describe('MockLLMClient — 运行时编排', () => {
  it('queueResponse 在运行中追加到队列尾', async () => {
    const mock = new MockLLMClient({ responses: [textResponse('r0')] });
    mock.queueResponse(textResponse('r1'));

    expect(await mock.chat(msgs)).toBe('r0');
    expect(await mock.chat(msgs)).toBe('r1');
  });

  it('resetCalls 清空调用记录但保留未消费队列', async () => {
    const mock = new MockLLMClient({ responses: [textResponse('a'), textResponse('b')] });
    await mock.chat(msgs); // 消费 a
    expect(mock.calls).toHaveLength(1);

    mock.resetCalls();
    expect(mock.calls).toHaveLength(0);
    expect(mock.pendingCount).toBe(1); // b 仍在队列
    expect(await mock.chat(msgs)).toBe('b');
  });

  it('构造时拷贝入参 responses——内部 shift 不污染外部数组', () => {
    const shared = [textResponse('x')];
    const mock = new MockLLMClient({ responses: shared });
    // 仅构造，不消费
    expect(shared).toHaveLength(1); // 外部数组未被 shift
    expect(mock.pendingCount).toBe(1);
  });

  it('setDefaultResponse 运行时设置兜底', async () => {
    const mock = new MockLLMClient({ responses: [textResponse('once')] });
    mock.setDefaultResponse(textResponse('always'));
    await mock.chat(msgs);
    expect(await mock.chat(msgs)).toBe('always');
  });
});

// ===========================================================================
// 防御：参数对象校验
// ===========================================================================

describe('MockLLMClient — 防御', () => {
  it('toolCalls.arguments 为字符串 → 抛错（防 double-stringify 污染 Core）', async () => {
    const mock = new MockLLMClient({
      responses: [{ toolCalls: [{ name: 'bad', arguments: '{"k":"v"}' as unknown as Record<string, unknown> }] }],
    });
    await expect(mock.chatWithTools(msgs, tools)).rejects.toThrow(
      /MOCK_LLM_ERROR.*arguments 必须是对象/,
    );
  });

  it('toolCalls.arguments 为数组 → 抛错', async () => {
    const mock = new MockLLMClient({
      responses: [{ toolCalls: [{ name: 'bad', arguments: [1, 2] as unknown as Record<string, unknown> }] }],
    });
    await expect(mock.chatWithTools(msgs, tools)).rejects.toThrow(/arguments 必须是对象/);
  });
});

// ===========================================================================
// 防御性拷贝：防 defaultResponse/responder 共享引用被 mutate 串扰 + responder 防护
// ===========================================================================
// calls getter 与 toToolCallResult 必须拷贝 response/toolCalls.arguments——否则
// defaultResponse（队列耗尽后多次复用同一对象）会被外部 mutate 串扰到其他 call 记录，
// 或 Agent 侧 mutate toolCalls[i].arguments 回灌 defaultResponse 污染下次返回。
// responder 漏 return（返回 undefined）须显式抛 [MOCK_LLM_ERROR]，而非裸 TypeError。
// ===========================================================================

describe('MockLLMClient — 防御性拷贝', () => {
  it('calls getter 隔离 defaultResponse：mutate calls[1].response 不影响 calls[2] 与内部状态', async () => {
    const mock = new MockLLMClient({
      responses: [textResponse('first')],
      defaultResponse: { content: 'shared', toolCalls: [{ name: 't', arguments: { k: 1 } }] },
    });
    await mock.chatWithTools(msgs, tools); // first
    await mock.chatWithTools(msgs, tools); // defaultResponse（共享引用）
    await mock.chatWithTools(msgs, tools); // defaultResponse（共享引用）

    const calls = mock.calls;
    // mutate calls[1].response——不得串扰到 calls[2] 或内部 defaultResponse
    calls[1]!.response.content = 'MUTATED';
    calls[1]!.response.toolCalls?.push({ name: 'injected', arguments: {} });

    // calls[2] 不受 calls[1] 的 mutate 影响
    expect(calls[2]!.response.content).toBe('shared');
    expect(calls[2]!.response.toolCalls).toHaveLength(1);
    // 内部 defaultResponse 也未被污染——第四次调用仍是原始内容
    const r3 = await mock.chatWithTools(msgs, tools);
    expect(r3.content).toBe('shared');
    expect(r3.toolCalls).toHaveLength(1);
  });

  it('responder 返回 undefined → 抛 [MOCK_LLM_ERROR]（非裸 TypeError）', async () => {
    const mock = new MockLLMClient({
      responder: () => undefined as unknown as MockLLMResponse,
    });
    await expect(mock.chatWithTools(msgs, tools)).rejects.toThrow(
      /MOCK_LLM_ERROR.*responder 返回了 null\/undefined/,
    );
  });

  it('toToolCallResult 拷贝 arguments：Agent mutate 返回值不回灌 defaultResponse', async () => {
    const mock = new MockLLMClient({
      responses: [{ toolCalls: [{ name: 'register_entity', arguments: { name: '韩立', kind: 'entity' } }] }],
      defaultResponse: { toolCalls: [{ name: 'register_entity', arguments: { name: '默认', kind: 'entity' } }] },
    });
    // 第一次返回队列响应；mutate 其 arguments（模拟 Agent 侧 delete 字段）
    const r0 = await mock.chatWithTools(msgs, tools);
    delete (r0.toolCalls![0]!.arguments as Record<string, unknown>)['name'];
    expect(r0.toolCalls![0]!.arguments).toEqual({ kind: 'entity' });

    // 第二次走 defaultResponse——arguments 必须仍是原始 { name:'默认', kind:'entity' }，
    // 不受上一次 mutate 回灌影响
    const r1 = await mock.chatWithTools(msgs, tools);
    expect(r1.toolCalls![0]!.arguments).toEqual({ name: '默认', kind: 'entity' });
  });
});

// ===========================================================================
// Mock × 真实 Agent 冒烟（证明 Mock 能驱动完整 ReAct，无隐藏接口不兼容）
// ===========================================================================
// 这一组不是测 MockLLMClient 自身契约（前面已锁），而是证明它接到真实 NarrativeAgent
// + 真实 Core（:memory:）的 ReAct 循环里不崩——ToolCallResult shape 被正确消费、
// toolCalls.arguments 对象被 Agent 正常 JSON.stringify 传给 ToolRouter、纯文本正确结束循环。
// 裸路径（无 writingStore），register_entity 副作用仅 break（narrative-agent.ts:1617-1621），
// 是最干净的"Mock 驱动真实写入"证明。§18.1：真实 Core + Mock LLM。
// ===========================================================================

/** 构造裸路径最小 Agent：真实 Core（:memory:）+ 真实 ToolRouter + MockLLMClient */
function createMinimalAgent(responses: MockLLMResponse[]) {
  const PROJECT_ID = 'mock-agent-smoke';
  const factStore = new SQLiteFactStoreAdapter(':memory:', PROJECT_ID);
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

  const mock = new MockLLMClient({ responses });
  const agent = new NarrativeAgent({
    llm: mock,
    toolRouter,
    agentStore,
    projectId: PROJECT_ID,
    limits: { maxToolSteps: 8, maxRepeatedToolFailure: 3, maxWallClockMs: 30000 },
  });
  return { agent, mock, db };
}

describe('MockLLMClient × 真实 NarrativeAgent 冒烟', () => {
  it('纯文本响应：第一轮回复即结束循环，status=completed', async () => {
    const { agent, mock } = createMinimalAgent([{ content: '你好，我是助手' }]);
    agent.startSession('smoke-text');

    const result = await agent.processUserInput('你好');

    expect(result.status).toBe('completed');
    expect(result.content).toBe('你好，我是助手');
    // Mock 仅被调用一次（纯文本即结束，无后续 Reason）
    expect(mock.calls).toHaveLength(1);
  });

  it('工具调用响应：Agent 调 register_entity 被权限门拦截（§25 #7），转文本收尾', async () => {
    // 2026-06-18 修正：register_entity 已加入 AGENT_FORBIDDEN_TOOLS（§25 #7：
    // Agent 不得直接注册实体，须经审核通道）。原测试验证"直接写入 Core"，现改为
    // 验证"被 isToolForbiddenForAgent 拦截 + Agent 转文本收尾不崩溃"——同样验证
    // MockLLMClient 接口全链路兼容（toolCalls 被正确消费），且符合新权限模型。
    const { agent, mock, db } = createMinimalAgent([
      // 第 1 轮：Mock 驱动 Agent 调 register_entity（会被权限门拦截）
      { toolCalls: [{ name: 'register_entity', arguments: { name: 'ceshi', kind: 'entity', chapter: 1 } }] },
      // 第 2 轮：拦截后 Agent 收到权限错误，Mock 给纯文本结束循环
      { content: '已为你检测到实体线索，请确认是否注册' },
    ]);
    agent.startSession('smoke-tool');

    const result = await agent.processUserInput('帮我注册一个测试角色');

    // 不崩溃，Agent 转文本收尾
    expect(result.status).not.toBe('failed');
    expect(mock.calls).toHaveLength(2);
    expect(mock.calls[0]!.response.toolCalls?.[0]?.name).toBe('register_entity');

    // 权限门生效：Core 无实体写入（register_entity 被拦，未执行）
    const entities = db.prepare('SELECT name FROM entities WHERE name = ?')
      .all('ceshi') as Array<{ name: string }>;
    expect(entities).toHaveLength(0);
  }, 15000);
});

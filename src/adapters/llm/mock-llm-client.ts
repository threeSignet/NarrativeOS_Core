// =============================================================================
// MockLLMClient — 确定性 LLM Mock（测试基础设施）
// =============================================================================
// §18.1 测试策略：外部 API（DeepSeek LLM）必须 Mock，自己的代码（Core/Writing）
// 用真实实例。本类实现 LLMClient 接口，用预置的响应脚本驱动 ReAct 循环走确定性
// 路径——让 e2e 测试不依赖网络/API key/token 成本，且可精确模拟边界
// （纯文本回复、工具调用、思考链、队列耗尽）。
//
// 设计要点：
//   - 响应源优先级：responder（动态函数）> responses 队列（按序消费）
//     > defaultResponse（兜底）> 抛错
//   - 队列耗尽且无兜底 → 显式抛错（避免静默返回空响应导致 ReAct 误判结束循环 / 隐藏 bug）
//   - 记录每次调用（method/callIndex/messages/tools/options/response）供测试断言
//     "Agent 调了哪些工具、传了什么参"
//   - toolCalls.arguments 强制为对象（Agent 会 JSON.stringify(tc.arguments)；
//     若 Mock 返回字符串会 double-stringify 污染 Core 写入——尽早暴露）
//   - chatWithToolsStream：把 content 经 onToken 整段推送再 resolve，让流式路径同样可测
//
// 与真实实现的对称：DeepSeekLLMClientAdapter 从 HTTP 解析 tool_calls；本类直接返回
// 预置对象。Agent 消费侧（narrative-agent.ts:691-744）对两者无感知。
// =============================================================================

import type {
  LLMClient,
  ChatMessage,
  ChatOptions,
  ToolDefinition,
  ToolCallResult,
} from '../../types.js';

// ---------------------------------------------------------------------------
// 类型定义
// ---------------------------------------------------------------------------

/** 单次 Mock 响应——驱动 ReAct 的 Reason 阶段或纯文本对话 */
export interface MockLLMResponse {
  /**
   * 文本回复。
   * - chatWithTools 路径：toolCalls 为空时此文本成为 Agent 最终回复（结束 ReAct）；
   *   非空时可附带说明（被 Agent 记为 assistant content）。
   * - chat 路径：直接作为返回字符串。
   */
  content?: string;
  /** DeepSeek 思考模式推理链（必须在后续请求原样回传——回传契约测试用） */
  reasoningContent?: string;
  /** 工具调用——非空则驱动 ReAct Act 阶段执行工具；为空（且无 content）则结束循环 */
  toolCalls?: Array<{
    name: string;
    arguments: Record<string, unknown>;
  }>;
}

/** 传给 responder 的调用上下文，支持按历史/工具集动态决定响应 */
export interface MockLLMCallContext {
  /** 第几次调用（0-based，跨 chat/chatWithTools/chatWithToolsStream 共用计数） */
  callIndex: number;
  messages: ChatMessage[];
  tools: ToolDefinition[];
  options?: ChatOptions;
}

/** 调用记录（供测试断言） */
export interface MockLLMCall {
  method: 'chat' | 'chatWithTools' | 'chatWithToolsStream';
  callIndex: number;
  messages: ChatMessage[];
  /** chat 方法不传 tools，此时记为 undefined */
  tools?: ToolDefinition[];
  options?: ChatOptions;
  /** 本次返回的响应（引用；测试约定不 mutate） */
  response: MockLLMResponse;
}

export interface MockLLMClientOptions {
  /** 预置响应队列（按调用顺序消费，确定性路径用） */
  responses?: MockLLMResponse[];
  /** 动态响应生成器（优先于 responses；灵活路径用，如按消息内容决定） */
  responder?: (ctx: MockLLMCallContext) => MockLLMResponse;
  /** 兜底响应（队列耗尽且无 responder 时用；避免 ReAct 因空响应误判） */
  defaultResponse?: MockLLMResponse;
}

// ---------------------------------------------------------------------------
// MockLLMClient
// ---------------------------------------------------------------------------

export class MockLLMClient implements LLMClient {
  /** 待消费的响应队列（运行时可经 queueResponse 追加） */
  private responses: MockLLMResponse[];
  /** 动态响应生成器（构造时确定，不可变） */
  private readonly responder?: (ctx: MockLLMCallContext) => MockLLMResponse;
  /** 兜底响应（可经 setDefaultResponse 运行时替换） */
  private defaultResponse?: MockLLMResponse;
  /** 跨方法的调用计数（也是 responder 的 callIndex） */
  private callIndex = 0;
  /** 调用历史（内部可变，经 calls getter 返回副本暴露） */
  private readonly _calls: MockLLMCall[] = [];

  constructor(options: MockLLMClientOptions = {}) {
    // 拷贝入参队列——避免外部数组被内部 shift 污染（测试可能复用同一数组构造多个实例）
    this.responses = options.responses ? [...options.responses] : [];
    this.responder = options.responder;
    this.defaultResponse = options.defaultResponse;
  }

  /** 供测试断言的调用历史（返回副本，防止外部 mutate 内部状态）。
   *  需深一层拷贝 response：defaultResponse（队列耗尽后兜底）与 responder 返回对象在多次
   *  call 间是同一引用，仅顶层 {...c} 浅拷贝下，外部 mutate calls[i].response.toolCalls
   *  会经共享引用串扰其他 call 记录（甚至回灌 defaultResponse 本体）。拷贝 response 顶层
   *  及其 toolCalls 数组项即可隔离（arguments 是 flat 对象，一层 {...} 足够）。 */
  get calls(): MockLLMCall[] {
    return this._calls.map(c => ({
      ...c,
      response: {
        ...c.response,
        toolCalls: c.response.toolCalls?.map(tc => ({ ...tc })),
      },
    }));
  }

  /** 当前队列剩余响应数（测试可断言"脚本未耗尽"或"已耗尽走兜底"） */
  get pendingCount(): number {
    return this.responses.length;
  }

  /**
   * 追加响应到队列尾。
   * 测试可在 processUserInput 之间动态编排（如先看 Agent 调了什么再决定下一步 Mock）。
   */
  queueResponse(response: MockLLMResponse): void {
    this.responses.push(response);
  }

  /** 运行时设置/替换兜底响应 */
  setDefaultResponse(response: MockLLMResponse): void {
    this.defaultResponse = response;
  }

  /** 清空调用记录（保留未消费队列；跨断言复位用） */
  resetCalls(): void {
    this._calls.length = 0;
  }

  // ===========================================================================
  // LLMClient 接口实现
  // ===========================================================================

  async chat(messages: ChatMessage[], options?: ChatOptions): Promise<string> {
    const response = this.resolveResponse('chat', messages, [], options);
    // chat 是纯文本路径：返回 content（无 content 则空串——纯文本回复允许为空）
    return response.content ?? '';
  }

  async chatWithTools(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    options?: ChatOptions,
  ): Promise<ToolCallResult> {
    const response = this.resolveResponse('chatWithTools', messages, tools, options);
    return toToolCallResult(response);
  }

  async chatWithToolsStream(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    onToken: (token: string) => void,
    options?: ChatOptions,
  ): Promise<ToolCallResult> {
    const response = this.resolveResponse('chatWithToolsStream', messages, tools, options);
    // 流式契约：把 content 经 onToken 推送。
    // 整段一次推送（不分片）——Mock 追求确定性而非模拟真实 token 粒度；分片只增不稳定。
    // 空 content 不调 onToken（无 token 可推），与真实流式在无文本时的行为一致。
    if (response.content) {
      onToken(response.content);
    }
    return toToolCallResult(response);
  }

  // ===========================================================================
  // 内部：响应解析（核心不变式集中于此）
  // ===========================================================================

  /**
   * 按优先级解析本次响应：responder > 队列 > defaultResponse > 抛错
   *
   * 抛错而非静默返回空——空响应会让 ReAct 误判（无 toolCalls 即结束循环，但本应继续），
   * 或让纯文本断言假绿。显式错误让"脚本编排不全"立刻暴露，不留隐藏 bug。
   */
  private resolveResponse(
    method: MockLLMCall['method'],
    messages: ChatMessage[],
    tools: ToolDefinition[],
    options: ChatOptions | undefined,
  ): MockLLMResponse {
    const callIndex = this.callIndex;
    const ctx: MockLLMCallContext = { callIndex, messages, tools, options };

    let response: MockLLMResponse;
    if (this.responder) {
      response = this.responder(ctx);
      // responder 漏 return（某分支返回 undefined）会让下方 response.toolCalls 抛裸 TypeError，
      // 无 [MOCK_LLM_ERROR] 上下文、无 callIndex——调试断崖。显式校验，与队列耗尽分支对称。
      if (response === null || response === undefined) {
        throw new Error(
          `[MOCK_LLM_ERROR] 第 ${callIndex} 次 ${method} 调用的 responder 返回了 null/undefined` +
          `——请确保 responder 在所有分支都返回有效 MockLLMResponse。`,
        );
      }
    } else if (this.responses.length > 0) {
      // shift 返回 T | undefined（noUncheckedIndexedAccess）；length>0 已保证非空，用断言兜底
      response = this.responses.shift()!;
    } else if (this.defaultResponse) {
      response = this.defaultResponse;
    } else {
      throw new Error(
        `[MOCK_LLM_ERROR] 第 ${callIndex} 次 ${method} 调用无预置响应——` +
        `队列已耗尽且未配置 responder/defaultResponse。请补全 Mock 响应脚本。`,
      );
    }

    // 防御：toolCalls 的 arguments 必须是纯对象（Agent 会 JSON.stringify(tc.arguments)）。
    // 若测试误传字符串/数组/null，此处尽早暴露，而非在 Agent 内 double-stringify 后
    // 静默污染 ToolRouter 参数解析、最终写入错误数据到 Core。
    if (response.toolCalls) {
      for (const tc of response.toolCalls) {
        if (
          tc.arguments === null ||
          typeof tc.arguments !== 'object' ||
          Array.isArray(tc.arguments)
        ) {
          throw new Error(
            `[MOCK_LLM_ERROR] toolCall "${tc.name}" 的 arguments 必须是对象，得到 ${Array.isArray(tc.arguments) ? 'array' : typeof tc.arguments}` +
            `（Agent 会 JSON.stringify，传字符串会 double-stringify 污染 Core 写入）`,
          );
        }
      }
    }

    this._calls.push({
      method,
      callIndex,
      // 记录副本，与调用方后续可能的 messages mutate 隔离
      messages: [...messages],
      tools: tools.length > 0 ? [...tools] : undefined,
      options,
      response,
    });
    this.callIndex++;

    return response;
  }
}

// ---------------------------------------------------------------------------
// 辅助：MockLLMResponse → ToolCallResult
// ---------------------------------------------------------------------------

/**
 * 把 Mock 响应转为 LLMClient 接口期望的 ToolCallResult。
 *
 * toolCalls 为空数组时归一化为 undefined——与真实 DeepSeek adapter 一致
 * （chatWithTools 仅在 toolCalls 非空时填充该字段），避免 Agent 把 [] 误判为"有工具调用"。
 */
function toToolCallResult(response: MockLLMResponse): ToolCallResult {
  // 拷贝 arguments（一层）：Agent 侧消费 toolCalls[i].arguments 后若 mutate（如 delete 字段），
  // 会经共享引用回灌到 Mock 的 defaultResponse/responses，污染后续 call 返回。
  const toolCalls = response.toolCalls && response.toolCalls.length > 0
    ? response.toolCalls.map(tc => ({ name: tc.name, arguments: { ...tc.arguments } }))
    : undefined;
  return {
    content: response.content ?? '',
    reasoningContent: response.reasoningContent,
    toolCalls,
  };
}

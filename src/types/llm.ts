// =============================================================================
// LLM 与嵌入服务接口
// =============================================================================
// §13: EmbeddingService / LLMClient / ChatMessage / ChatOptions / ToolDefinition / ToolCallResult

/**
 * EmbeddingService：文本向量化服务接口
 *
 * 默认实现使用硅基流动 BAAI/bge-m3（1024 维）。
 */
export interface EmbeddingService {
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
}

/**
 * LLMClient：大语言模型客户端接口
 *
 * 默认实现使用 DeepSeek API（v4-flash / v4-pro）。
 * 用于 ContextAnalyzer 的深度分析模式（占 20% 调用量）。
 */
export interface LLMClient {
  chat(messages: ChatMessage[], options?: ChatOptions): Promise<string>;
  chatWithTools(messages: ChatMessage[], tools: ToolDefinition[], options?: ChatOptions): Promise<ToolCallResult>;
  /**
   * 流式带工具对话（可选实现）。
   * 当 LLM 返回 token 时实时回调 onToken，同时累积完整结果。
   * 如果适配器不支持流式，NarrativeAgent 自动降级为 chatWithTools。
   */
  chatWithToolsStream?(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    onToken: (token: string) => void,
    options?: ChatOptions,
  ): Promise<ToolCallResult>;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /**
   * DeepSeek 思考模式：assistant 消息的推理链。
   * 必须在后续请求中原样回传，否则 API 返回 400。
   */
  reasoning_content?: string;
  /**
   * 当 role='assistant' 且 LLM 发起工具调用时填充。
   * 每个 tool_call 包含唯一 id，调用方执行后将结果通过 role='tool' + tool_call_id 回传。
   */
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string; };
  }>;
  /**
   * 当 role='tool' 时必须指定，对应 assistant 消息中 tool_calls[].id。
   * 用于将工具执行结果与 LLM 的原始调用意图关联。
   */
  tool_call_id?: string;
}

export interface ChatOptions {
  temperature?: number;
  max_tokens?: number;
  model?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCallResult {
  content: string;
  /** DeepSeek 思考模式：推理链内容，必须在后续请求中原样回传 */
  reasoningContent?: string;
  toolCalls?: Array<{
    name: string;
    arguments: Record<string, unknown>;
  }>;
}

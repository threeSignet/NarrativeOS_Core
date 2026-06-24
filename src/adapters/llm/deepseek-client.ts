// =============================================================================
// DeepSeekLLMClientAdapter — DeepSeek Chat Completions API 适配器
// =============================================================================
// Phase 6A 核心产出。实现 LLMClient 接口，封装 DeepSeek API 的 HTTP 调用、
// 认证、重试策略和 Tool Calling 解析。
//
// API 文档：https://api-docs.deepseek.com/api/create-chat-completion
//
// 设计要点：
//   - DeepSeek Chat Completions API 与 OpenAI 协议完全兼容
//   - getConfig() 从 .env 读取配置（借鉴 siliconflow-embedder 模式）
//   - chat() — 纯文本对话，返回 LLM 回复文本
//   - chatWithTools() — 带 function calling 的对话，解析 tool_calls
//   - 错误处理三层：HTTP 错误 / JSON 解析错误 / 网络错误
//   - 重试策略：429/5xx 指数退避（1s→2s→4s，最多 3 次），401/400 不重试
//   - 注：重试是 LLMClient 新增设计——对话无"零向量降级"语义
//
// 与架构文档的对应关系：
//   §13 LLMClient 接口           → chat / chatWithTools
//   §11.7 适配器清单             → DeepSeekLLMClientAdapter
// =============================================================================

import type { LLMClient, ChatMessage, ChatOptions, ToolDefinition, ToolCallResult } from '../../types.js';

type ParsedToolCall = { id?: string; name: string; arguments: Record<string, unknown> };

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

/** 从 .env 读取 DeepSeek 配置，不缓存到实例字段 */
function getConfig() {
  const apiKey = process.env['DEEPSEEK_API_KEY'] ?? '';
  return {
    apiKey,
    baseUrl: process.env['LLM_BASE_URL'] ?? 'https://api.deepseek.com',
    model: process.env['LLM_MODEL'] ?? 'deepseek-v4-flash',
  };
}

// ---------------------------------------------------------------------------
// DeepSeekLLMClientAdapter
// ---------------------------------------------------------------------------

/** 构造时可注入的覆盖项——优先于 .env 默认值。
 *  apiKey/baseUrl/model 是 adapter 级配置；temperature/maxTokens 作为 per-call 默认
 *  （ChatOptions 同名字段优先）。引入此构造参数是为了让调用方（尤其 live 测试）
 *  能显式注入 apiKey/model，而非静默忽略——避免“传了配置却走 .env 默认”的假信心。 */
export interface DeepSeekAdapterOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  /** 默认 temperature（当 ChatOptions.temperature 未指定时用） */
  temperature?: number;
  /** 默认 max_tokens（当 ChatOptions.max_tokens 未指定时用） */
  maxTokens?: number;
}

export class DeepSeekLLMClientAdapter implements LLMClient {
  /** 构造时注入的覆盖项——refreshConfig 每次重读 env 时仍保留这些覆盖 */
  private readonly overrides: DeepSeekAdapterOptions;
  private config = getConfig();

  constructor(opts: DeepSeekAdapterOptions = {}) {
    this.overrides = opts;
    // 立即合并覆盖项，使 this.config 在构造后即反映最终生效配置
    this.refreshConfig();
  }

  /** 合并 .env 默认值与构造覆盖项，得到最终生效配置 */
  private refreshConfig(): void {
    const env = getConfig();
    this.config = {
      apiKey: this.overrides.apiKey ?? env.apiKey,
      baseUrl: this.overrides.baseUrl ?? env.baseUrl,
      model: this.overrides.model ?? env.model,
    };
  }

  /** 解析本次调用的 temperature（per-call options 优先，回落构造默认） */
  private resolveTemperature(options?: ChatOptions): number | undefined {
    return options?.temperature ?? this.overrides.temperature;
  }

  /** 解析本次调用的 max_tokens（per-call options 优先，回落构造默认） */
  private resolveMaxTokens(options?: ChatOptions): number | undefined {
    return options?.max_tokens ?? this.overrides.maxTokens;
  }

  // =========================================================================
  // chat — 纯文本对话
  // =========================================================================

  /**
   * 发送消息到 DeepSeek，返回 LLM 的文本回复
   *
   * @param messages 对话历史（system/user/assistant/tool）
   * @param options  可选：temperature / max_tokens / model（覆盖 .env 默认值）
   * @returns LLM 返回的文本内容
   */
  async chat(messages: ChatMessage[], options?: ChatOptions): Promise<string> {
    this.validateApiKey();

    const model = options?.model ?? this.config.model;
    const body: Record<string, unknown> = {
      model,
      messages,
      stream: false,
    };
    const temperature = this.resolveTemperature(options);
    if (temperature !== undefined) body['temperature'] = temperature;
    const maxTokens = this.resolveMaxTokens(options);
    if (maxTokens !== undefined) body['max_tokens'] = maxTokens;

    const data = await this.callApi(body);
    // choices[0].message.content 是 DeepSeek 的标准返回格式
    const choices = data?.choices as Array<Record<string, unknown>> | undefined;
    const firstChoice = choices?.[0];
    const message = firstChoice?.message as Record<string, unknown> | undefined;
    const content = message?.content;
    if (typeof content !== 'string') {
      throw new Error(`[LLM_API_ERROR] DeepSeek 返回了意外的响应结构：${JSON.stringify(data).slice(0, 300)}`);
    }
    return content;
  }

  // =========================================================================
  // chatWithTools — 带 function calling 的对话
  // =========================================================================

  /**
   * 发送消息 + 工具定义到 DeepSeek，LLM 可选择调用工具或纯文本回复
   *
   * @param messages 对话历史
   * @param tools    可用工具定义（JSON Schema 格式）
   * @param options  可选配置
   * @returns ToolCallResult，包含 LLM 文本回复和可选的 tool_calls
   */
  async chatWithTools(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    options?: ChatOptions,
  ): Promise<ToolCallResult> {
    this.validateApiKey();

    const model = options?.model ?? this.config.model;
    const body: Record<string, unknown> = {
      model,
      messages,
      tools: tools.map(t => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      })),
      tool_choice: 'auto',
      stream: false,
    };
    const temperature = this.resolveTemperature(options);
    if (temperature !== undefined) body['temperature'] = temperature;
    const maxTokens = this.resolveMaxTokens(options);
    if (maxTokens !== undefined) body['max_tokens'] = maxTokens;

    const data = await this.callApi(body);
    const choices = data?.choices as Array<Record<string, unknown>> | undefined;
    const choice = choices?.[0];
    if (!choice) {
      throw new Error(`[LLM_API_ERROR] DeepSeek 返回了意外的响应结构：${JSON.stringify(data).slice(0, 300)}`);
    }

    const message = (choice as Record<string, unknown>).message as Record<string, unknown> | undefined;
    const content: string = typeof message?.content === 'string' ? message.content : '';
    // DeepSeek 思考模式：捕获 reasoning_content 以便后续请求回传
    const reasoningContent: string | undefined =
      typeof message?.reasoning_content === 'string' ? message.reasoning_content as string : undefined;

    // 解析 tool_calls：DeepSeek 返回的格式与 OpenAI 一致
    const rawToolCalls = message?.tool_calls as Array<Record<string, unknown>> | undefined;
    const toolCalls = rawToolCalls?.map(tc => ({
      id: typeof tc['id'] === 'string' ? tc['id'] as string : '',
      name: (tc.function as Record<string, unknown>)?.name as string,
      arguments: typeof (tc.function as Record<string, unknown>)?.arguments === 'string'
        ? JSON.parse((tc.function as Record<string, unknown>).arguments as string) as Record<string, unknown>
        : ((tc.function as Record<string, unknown>)?.arguments as Record<string, unknown>) ?? {},
    }));
    const fallback = parseDeepSeekTextToolCalls(content);

    // 解析 token usage（DeepSeek API 返回 data.usage，供 evals 成本统计 + /history 汇总）
    const rawUsage = data?.usage as Record<string, unknown> | undefined;
    const usage = rawUsage && typeof rawUsage['prompt_tokens'] === 'number'
      ? {
          prompt_tokens: rawUsage['prompt_tokens'] as number,
          completion_tokens: typeof rawUsage['completion_tokens'] === 'number' ? rawUsage['completion_tokens'] as number : 0,
          prompt_cache_hit_tokens: typeof rawUsage['prompt_cache_hit_tokens'] === 'number' ? rawUsage['prompt_cache_hit_tokens'] as number : undefined,
        }
      : undefined;

    return {
      content: fallback.cleanContent,
      reasoningContent,
      toolCalls: toolCalls && toolCalls.length > 0 ? toolCalls : fallback.toolCalls,
      usage,
    };
  }

  // =========================================================================
  // chatStream — 流式对话（实时输出 token）
  // =========================================================================

  /**
   * 流式对话：将 LLM 返回的每个 token 实时推送到 onToken 回调
   *
   * 用于终端实时输出。不重试（流式重试会重复输出 token，体验差）。
   * 支持 tool_calls 增量累积。
   *
   * @param messages 对话历史
   * @param onToken  每收到一个文本 token 时调用
   * @param options  可选配置
   * @returns 完整回复文本 + 可能的 tool_calls
   */
  async chatStream(
    messages: ChatMessage[],
    onToken: (text: string) => void,
    options?: ChatOptions,
  ): Promise<{ content: string; reasoningContent?: string; toolCalls?: ParsedToolCall[] }> {
    this.validateApiKey();

    const model = options?.model ?? this.config.model;
    const body: Record<string, unknown> = {
      model,
      messages,
      stream: true,
    };
    const temperature = this.resolveTemperature(options);
    if (temperature !== undefined) body['temperature'] = temperature;
    const maxTokens = this.resolveMaxTokens(options);
    if (maxTokens !== undefined) body['max_tokens'] = maxTokens;

    return await this.callApiStream(body, onToken);
  }

  /**
   * chatStream + tools：流式对话，同时支持 tool calling
   */
  async chatStreamWithTools(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    onToken: (token: string) => void,
    options?: ChatOptions,
  ): Promise<{ content: string; reasoningContent?: string; toolCalls?: ParsedToolCall[]; usage?: { prompt_tokens: number; completion_tokens: number; prompt_cache_hit_tokens?: number } }> {
    this.validateApiKey();

    const model = options?.model ?? this.config.model;
    const body: Record<string, unknown> = {
      model,
      messages,
      tools: tools.map(t => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      })),
      tool_choice: 'auto',
      stream: true,
    };
    const temperature = this.resolveTemperature(options);
    if (temperature !== undefined) body['temperature'] = temperature;
    const maxTokens = this.resolveMaxTokens(options);
    if (maxTokens !== undefined) body['max_tokens'] = maxTokens;

    return await this.callApiStream(body, onToken);
  }

  // =========================================================================
  // chatWithToolsStream — LLMClient 接口的可选流式方法
  // =========================================================================

  /**
   * 流式带工具对话（实现 LLMClient.chatWithToolsStream 可选接口）
   *
   * 与 chatStreamWithTools 功能相同，但返回类型适配 ToolCallResult，
   * 以便 NarrativeAgent 层统一消费。
   */
  async chatWithToolsStream(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    onToken: (token: string) => void,
    options?: ChatOptions,
  ): Promise<ToolCallResult> {
    const result = await this.chatStreamWithTools(messages, tools, onToken, options);
    return {
      content: result.content,
      reasoningContent: result.reasoningContent,
      toolCalls: result.toolCalls?.map(tc => ({
        name: tc.name,
        arguments: tc.arguments,
      })),
      usage: result.usage,
    };
  }

  // =========================================================================
  // 内部方法
  // =========================================================================

  /**
   * SSE 流式调用 DeepSeek API
   *
   * 解析 SSE 事件流，提取 delta.content（文本）和 delta.tool_calls（工具调用）。
   * tool_calls 可能分布在多个 chunk 中（name 在一个、arguments 在另一个），
   * 需要按 index 累积。
   */
  private async callApiStream(
    body: Record<string, unknown>,
    onToken: (text: string) => void,
  ): Promise<{ content: string; reasoningContent?: string; toolCalls?: ParsedToolCall[]; usage?: { prompt_tokens: number; completion_tokens: number; prompt_cache_hit_tokens?: number } }> {
    const url = `${this.config.baseUrl}/chat/completions`;

    // P1 修复：加 90s 超时（流式输出通常较长），避免连接建立阶段挂起阻塞 ReAct
    const response = await this.fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify(body),
    }, 90000);

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      throw new Error(
        `[LLM_API_ERROR] DeepSeek Stream API 返回 ${response.status}：${errorBody.slice(0, 500)}`
      );
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('[LLM_API_ERROR] 无法获取响应流');
    }

    const decoder = new TextDecoder();
    let fullContent = '';
    let reasoningContent = '';
    // 流式 usage（DeepSeek 在最后一个 chunk 带 usage 字段）
    let streamUsage: { prompt_tokens: number; completion_tokens: number; prompt_cache_hit_tokens?: number } | undefined;
    // tool_calls 按 index 累积（SSE delta 可能分片到达）
    const toolCallAccum: Map<number, { id: string; name: string; argsChunks: string[] }> = new Map();

    try {
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        // 最后一行可能不完整，保留到下次
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const jsonStr = line.slice(6).trim();
          if (jsonStr === '[DONE]') continue;

          try {
            const event = JSON.parse(jsonStr) as Record<string, unknown>;
            // 流式 usage：DeepSeek 在最后一个 chunk（[DONE] 前）带 usage 字段（无 choices）
            const eventUsage = event['usage'] as Record<string, unknown> | undefined;
            if (eventUsage && typeof eventUsage['prompt_tokens'] === 'number') {
              streamUsage = {
                prompt_tokens: eventUsage['prompt_tokens'] as number,
                completion_tokens: typeof eventUsage['completion_tokens'] === 'number' ? eventUsage['completion_tokens'] as number : 0,
                prompt_cache_hit_tokens: typeof eventUsage['prompt_cache_hit_tokens'] === 'number' ? eventUsage['prompt_cache_hit_tokens'] as number : undefined,
              };
            }
            const choices = event['choices'] as Array<Record<string, unknown>> | undefined;
            if (!choices || choices.length === 0) continue;

            const delta = choices[0]?.['delta'] as Record<string, unknown> | undefined;
            if (!delta) continue;

            // DeepSeek 思考模式的推理内容（不回传会导致 400 错误）
            if (typeof delta['reasoning_content'] === 'string' && delta['reasoning_content'].length > 0) {
              reasoningContent += delta['reasoning_content'];
            }

            // 文本 token
            if (typeof delta['content'] === 'string' && delta['content'].length > 0) {
              const token = delta['content'];
              fullContent += token;
              onToken(token);
            }

            // tool_calls 增量
            const tcList = delta['tool_calls'] as Array<Record<string, unknown>> | undefined;
            if (tcList) {
              for (const tc of tcList) {
                const idx = typeof tc['index'] === 'number' ? tc['index'] : 0;
                if (!toolCallAccum.has(idx)) {
                  toolCallAccum.set(idx, { id: '', name: '', argsChunks: [] });
                }
                const acc = toolCallAccum.get(idx)!;
                if (typeof tc['id'] === 'string') acc.id = tc['id'];
                const fn = tc['function'] as Record<string, unknown> | undefined;
                if (fn) {
                  if (typeof fn['name'] === 'string') acc.name = fn['name'];
                  if (typeof fn['arguments'] === 'string') acc.argsChunks.push(fn['arguments']);
                }
              }
            }
          } catch {
            // 忽略 SSE 解析错误（单行损坏不影响后续）
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    // 组装 tool_calls（保留 LLM 分配的 id 用于 tool 消息回传）
    const nativeToolCalls = toolCallAccum.size > 0
      ? Array.from(toolCallAccum.entries()).map(([idx, acc]) => {
          const argsStr = acc.argsChunks.join('');
          let args: Record<string, unknown> = {};
          try { args = JSON.parse(argsStr); } catch { /* 解析失败返回空对象 */ }
          return { id: acc.id || `call_${acc.name}_${idx}`, name: acc.name, arguments: args };
        })
      : undefined;
    const fallback = parseDeepSeekTextToolCalls(fullContent);

    return {
      content: fallback.cleanContent,
      reasoningContent: reasoningContent || undefined,
      toolCalls: nativeToolCalls && nativeToolCalls.length > 0 ? nativeToolCalls : fallback.toolCalls,
      usage: streamUsage,
    };
  }

  // =========================================================================

  /**
   * 验证 API Key 已配置
   * 在每次 API 调用前检查，确保启动后修改 .env 能生效
   */
  private validateApiKey(): void {
    // 每次调用重新读取 env（支持运行时配置变更），但保留构造时注入的覆盖项
    this.refreshConfig();
    if (!this.config.apiKey) {
      throw new Error(
        '[LLM_API_ERROR] DEEPSEEK_API_KEY 未配置。请在 .env 文件中设置 DEEPSEEK_API_KEY=sk-xxx'
      );
    }
  }

  /**
   * 调用 DeepSeek Chat Completions API（含重试逻辑）
   *
   * @param body 请求体（已包含 model/messages/tools 等）
   * @returns 解析后的 JSON 响应
   */
  private async callApi(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const maxRetries = 3;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const url = `${this.config.baseUrl}/chat/completions`;
        // P1 修复：加 60s 超时，避免 TCP 挂起无限阻塞 ReAct 循环（超时转为可重试的 AbortError）
        const response = await this.fetchWithTimeout(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.config.apiKey}`,
          },
          body: JSON.stringify(body),
        }, 60000);

        // ---- HTTP 错误层 ----
        if (!response.ok) {
          const errorBody = await response.text().catch(() => '');
          const preview = errorBody.slice(0, 500);

          // 不可重试的错误：认证失败、请求参数错误
          if (response.status === 401 || response.status === 400) {
            throw new Error(
              `[LLM_API_ERROR] DeepSeek API 返回 ${response.status}（不可重试）：${preview}`
            );
          }

          // 可重试的错误：限流、服务端错误
          if (response.status === 429 || response.status >= 500) {
            const retryMsg = attempt < maxRetries
              ? `将在 ${1 << attempt}s 后重试（第 ${attempt + 1}/${maxRetries} 次）`
              : `已重试 ${maxRetries} 次，全部失败`;
            throw new Error(
              `[LLM_API_ERROR] DeepSeek API 返回 ${response.status}：${retryMsg}。响应：${preview}`
            );
          }

          // 其他 HTTP 错误
          throw new Error(
            `[LLM_API_ERROR] DeepSeek API 返回 ${response.status}：${preview}`
          );
        }

        // ---- JSON 解析层 ----
        const data = await response.json() as Record<string, unknown>;
        return data;

      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        const isRetryable = this.isRetryableError(lastError);

        if (!isRetryable || attempt >= maxRetries) {
          throw lastError;
        }

        // 指数退避
        const delayMs = (1 << attempt) * 1000; // 1s → 2s → 4s
        console.error(
          `[DeepSeekLLMClient] API 调用失败（第 ${attempt + 1} 次），` +
          `${delayMs}ms 后重试：${lastError.message.slice(0, 200)}`
        );
        await this.sleep(delayMs);
      }
    }

    throw lastError ?? new Error('[LLM_API_ERROR] 未知错误');
  }

  /**
   * 带超时的 fetch 封装
   *
   * P1 修复：原生 fetch 无超时，TCP 挂起或远端不响应会无限阻塞 ReAct 循环
   * （maxWallClockMs 只在 tool step 边界检查，无法中断进行中的 HTTP 请求）。
   * 用 AbortController 强制超时，将网络挂起转化为可重试的 AbortError。
   */
  private async fetchWithTimeout(url: string, options: RequestInit, timeoutMs: number): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 判断错误是否可重试
   *
   * 可重试：429 限流、5xx 服务端错误、网络超时/DNS 错误、请求超时（AbortError）
   * 不可重试：401 认证、400 参数、JSON 解析错误（说明响应格式异常，重试无意义）
   */
  private isRetryableError(error: Error): boolean {
    const msg = error.message;
    // AbortController 触发的请求超时（网络挂起），属瞬时故障，可重试
    if (error.name === 'AbortError' || msg.includes('aborted') || msg.includes('timeout')) return true;
    // 从错误消息中识别 HTTP 状态码（已在 callApi 中写入 message）
    if (msg.includes('429')) return true;
    if (msg.includes('500') || msg.includes('502') || msg.includes('503')) return true;
    // 网络层错误（fetch 抛出的原始异常）
    if (msg.includes('fetch failed') || msg.includes('ECONNREFUSED') ||
        msg.includes('ETIMEDOUT') || msg.includes('ENOTFOUND')) return true;
    return false;
  }

  /**
   * 异步等待（指数退避用）
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// ---------------------------------------------------------------------------
// DeepSeek 文本工具调用兜底解析
// ---------------------------------------------------------------------------

function parseDeepSeekTextToolCalls(content: string): { cleanContent: string; toolCalls?: ParsedToolCall[] } {
  const blockPattern = /<｜｜DSML｜｜tool_calls>[\s\S]*?<\/｜｜DSML｜｜tool_calls>/g;
  const blocks = content.match(blockPattern) ?? [];
  if (blocks.length === 0) {
    return { cleanContent: content };
  }

  const toolCalls: ParsedToolCall[] = [];
  for (const block of blocks) {
    const invokePattern = /<｜｜DSML｜｜invoke\s+name="([^"]+)">([\s\S]*?)<\/｜｜DSML｜｜invoke>/g;
    let invokeMatch: RegExpExecArray | null;
    while ((invokeMatch = invokePattern.exec(block)) !== null) {
      const name = invokeMatch[1]!;
      const body = invokeMatch[2]!;
      toolCalls.push({
        id: `call_${name}_${toolCalls.length}`,
        name,
        arguments: parseDeepSeekParameters(body),
      });
    }
  }

  const cleanContent = content.replace(blockPattern, '').trim();
  return { cleanContent, toolCalls: toolCalls.length > 0 ? toolCalls : undefined };
}

function parseDeepSeekParameters(body: string): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  const paramPattern = /<｜｜DSML｜｜parameter\s+name="([^"]+)"(?:\s+string="([^"]+)")?>([\s\S]*?)<\/｜｜DSML｜｜parameter>/g;
  let paramMatch: RegExpExecArray | null;
  while ((paramMatch = paramPattern.exec(body)) !== null) {
    const key = paramMatch[1]!;
    const isString = paramMatch[2] === 'true';
    const raw = decodeXmlEntities(paramMatch[3]!.trim());
    args[key] = coerceDeepSeekParameter(raw, isString);
  }
  return args;
}

function coerceDeepSeekParameter(raw: string, isString: boolean): unknown {
  if (isString) return raw;
  try {
    return JSON.parse(raw);
  } catch {
    if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    return raw;
  }
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

// =============================================================================
// Phase 6A-1 测试：DeepSeekLLMClientAdapter
// =============================================================================
// 全部使用 mock fetch，不依赖网络。
// 对应验收条件见 docs/phase5-development-plan.md §6A-1。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DeepSeekLLMClientAdapter } from '../../src/adapters/llm/deepseek-client.js';
import type { ChatMessage, ToolDefinition } from '../../src/types.js';

// ---------------------------------------------------------------------------
// 确保 API Key 在测试中可用（mock 不会真的发请求）
// ---------------------------------------------------------------------------
beforeEach(() => {
  process.env['DEEPSEEK_API_KEY'] = 'sk-test-mock-key';
  process.env['LLM_BASE_URL'] = 'https://api.deepseek.com';
  process.env['LLM_MODEL'] = 'deepseek-v4-flash';
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// 辅助：构造 mock fetch 响应
// ---------------------------------------------------------------------------

function mockFetch(body: Record<string, unknown>, status = 200) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as Response);
}

function mockChatResponse(content: string) {
  return mockFetch({
    choices: [{ message: { role: 'assistant', content } }],
  });
}

function mockToolCallResponse(toolCalls: Array<{ name: string; args: Record<string, unknown> }>) {
  return mockFetch({
    choices: [{
      message: {
        role: 'assistant',
        content: '我来调用工具处理这个请求。',
        tool_calls: toolCalls.map(tc => ({
          id: `call_${tc.name}_01`,
          type: 'function',
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.args),
          },
        })),
      },
    }],
  });
}

const sampleMessages: ChatMessage[] = [
  { role: 'system', content: '你是一个写作助手。' },
  { role: 'user', content: '主角韩立进入了筑基期，请帮我更新他的状态。' },
];

const sampleTools: ToolDefinition[] = [
  {
    name: 'propose_event',
    description: '提议一个新事件，包含事实变更。',
    parameters: {
      type: 'object',
      properties: {
        event_type: { type: 'string' },
        chapter: { type: 'number' },
        fact_changes: { type: 'array' },
      },
      required: ['event_type', 'chapter', 'fact_changes'],
    },
  },
];

// =============================================================================
// 测试
// =============================================================================

describe('DeepSeekLLMClientAdapter', () => {
  // ---------------------------------------------------------------------------
  // chat() 基础功能
  // ---------------------------------------------------------------------------

  describe('chat()', () => {
    it('应正确发送消息并返回 LLM 回复', async () => {
      const fetchSpy = mockChatResponse('好的，我来帮你更新韩立的状态...');

      const client = new DeepSeekLLMClientAdapter();
      const reply = await client.chat(sampleMessages);

      expect(reply).toBe('好的，我来帮你更新韩立的状态...');

      // 验证请求格式
      const callArgs = fetchSpy.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(callArgs[1].body as string);
      expect(body.model).toBe('deepseek-v4-flash');
      expect(body.messages).toEqual(sampleMessages);
      expect(body.stream).toBe(false);
    });

    it('应使用 options.model 覆盖默认模型', async () => {
      const fetchSpy = mockChatResponse('ok');
      const client = new DeepSeekLLMClientAdapter();
      await client.chat(sampleMessages, { model: 'deepseek-v4-pro' });

      const body = JSON.parse((fetchSpy.mock.calls[0] as [string, RequestInit])[1].body as string);
      expect(body.model).toBe('deepseek-v4-pro');
    });

    it('应传递 temperature 和 max_tokens', async () => {
      const fetchSpy = mockChatResponse('ok');
      const client = new DeepSeekLLMClientAdapter();
      await client.chat(sampleMessages, { temperature: 0.7, max_tokens: 500 });

      const body = JSON.parse((fetchSpy.mock.calls[0] as [string, RequestInit])[1].body as string);
      expect(body.temperature).toBe(0.7);
      expect(body.max_tokens).toBe(500);
    });
  });

  // ---------------------------------------------------------------------------
  // chatWithTools() 基础功能
  // ---------------------------------------------------------------------------

  describe('chatWithTools()', () => {
    it('LLM 返回 tool_calls 时应正确解析', async () => {
      mockToolCallResponse([
        { name: 'propose_event', args: { event_type: 'breakthrough', chapter: 50 } },
      ]);

      const client = new DeepSeekLLMClientAdapter();
      const result = await client.chatWithTools(sampleMessages, sampleTools);

      expect(result.content).toBe('我来调用工具处理这个请求。');
      expect(result.toolCalls).toBeDefined();
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls![0]!.name).toBe('propose_event');
      expect(result.toolCalls![0]!.arguments).toEqual({
        event_type: 'breakthrough',
        chapter: 50,
      });
    });

    it('LLM 不调用工具时 toolCalls 应为 undefined', async () => {
      mockChatResponse('好的，我了解了。韩立目前是筑基期。不需要工具调用。');

      const client = new DeepSeekLLMClientAdapter();
      const result = await client.chatWithTools(sampleMessages, sampleTools);

      expect(result.content).toBe('好的，我了解了。韩立目前是筑基期。不需要工具调用。');
      expect(result.toolCalls).toBeUndefined();
    });

    it('应解析 DeepSeek 文本退化的 DSML 工具调用', async () => {
      mockChatResponse(`我来记录这个事件。

<｜｜DSML｜｜tool_calls>
<｜｜DSML｜｜invoke name="propose_event">
<｜｜DSML｜｜parameter name="event_type" string="true">breakthrough</｜｜DSML｜｜parameter>
<｜｜DSML｜｜parameter name="chapter" string="false">4</｜｜DSML｜｜parameter>
<｜｜DSML｜｜parameter name="fact_changes" string="false">[{"change_id":"c1","op":"assert","subject":"ent_hanli","predicate":"realm","value":"筑基初期"}]</｜｜DSML｜｜parameter>
</｜｜DSML｜｜invoke>
</｜｜DSML｜｜tool_calls>`);

      const client = new DeepSeekLLMClientAdapter();
      const result = await client.chatWithTools(sampleMessages, sampleTools);

      expect(result.content).toBe('我来记录这个事件。');
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls![0]!.name).toBe('propose_event');
      expect(result.toolCalls![0]!.arguments).toEqual({
        event_type: 'breakthrough',
        chapter: 4,
        fact_changes: [
          { change_id: 'c1', op: 'assert', subject: 'ent_hanli', predicate: 'realm', value: '筑基初期' },
        ],
      });
    });

    it('应正确发送 tools 数组到 API', async () => {
      const fetchSpy = mockChatResponse('ok');
      const client = new DeepSeekLLMClientAdapter();
      await client.chatWithTools(sampleMessages, sampleTools);

      const body = JSON.parse((fetchSpy.mock.calls[0] as [string, RequestInit])[1].body as string);
      expect(body.tools).toBeDefined();
      expect(body.tools).toHaveLength(1);
      expect(body.tools[0].type).toBe('function');
      expect(body.tools[0].function.name).toBe('propose_event');
      expect(body.tool_choice).toBe('auto');
    });
  });

  // ---------------------------------------------------------------------------
  // 错误处理
  // ---------------------------------------------------------------------------

  describe('错误处理', () => {
    it('API Key 未配置时应抛出明确错误', async () => {
      delete process.env['DEEPSEEK_API_KEY'];

      const client = new DeepSeekLLMClientAdapter();
      await expect(client.chat(sampleMessages)).rejects.toThrow('DEEPSEEK_API_KEY');
    });

    it('401 认证错误不应重试，立即抛异常', async () => {
      const fetchSpy = mockFetch(
        { error: { message: 'Authentication Error' } },
        401,
      );

      const client = new DeepSeekLLMClientAdapter();
      await expect(client.chat(sampleMessages)).rejects.toThrow('401');

      // 401 不可重试 → 只应调用一次 fetch
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('400 参数错误不应重试，立即抛异常', async () => {
      const fetchSpy = mockFetch(
        { error: { message: 'Invalid request' } },
        400,
      );

      const client = new DeepSeekLLMClientAdapter();
      await expect(client.chat(sampleMessages)).rejects.toThrow('400');

      // 400 不可重试
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('429 限流应重试，第 2 次成功则返回结果', async () => {
      // 第 1 次返回 429，第 2 次返回 200
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce({
          ok: false,
          status: 429,
          text: async () => 'Rate limit exceeded',
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            choices: [{ message: { role: 'assistant', content: '重试成功了' } }],
          }),
        } as Response);

      // 通过 mock sleep 避免实际等待
      const client = new DeepSeekLLMClientAdapter();
      const sleepSpy = vi.spyOn(client as any, 'sleep').mockResolvedValue(undefined);

      const reply = await client.chat(sampleMessages);
      expect(reply).toBe('重试成功了');
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(sleepSpy).toHaveBeenCalledTimes(1); // 重试前等待了 1 次
    });

    it('429 限流重试 3 次全部失败应抛出异常', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValue({
          ok: false,
          status: 429,
          text: async () => 'Rate limit exceeded',
        } as Response);

      const client = new DeepSeekLLMClientAdapter();
      vi.spyOn(client as any, 'sleep').mockResolvedValue(undefined);

      await expect(client.chat(sampleMessages)).rejects.toThrow(/429/);
      // 1 次初始 + 3 次重试 = 4 次
      expect(fetchSpy).toHaveBeenCalledTimes(4);
    });

    it('网络错误应抛异常', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(
        new Error('fetch failed: ECONNREFUSED'),
      );

      const client = new DeepSeekLLMClientAdapter();
      await expect(client.chat(sampleMessages)).rejects.toThrow('fetch failed');
    });
  });
});

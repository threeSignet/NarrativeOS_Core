// =============================================================================
// Agent 聊天 SSE 客户端——用 EventSource（GET）消费
// =============================================================================
// 关键：用 EventSource 而非 fetch POST。EventSource 是浏览器原生 SSE 客户端，
// 不受 Vite proxy / 中间层缓冲影响（参考 NarrativeOS_Active_1 stream.ts）。
// EventSource 只支持 GET，参数走 query string。
//
// 注意：EventSource 不支持 AbortSignal，停止靠 close()。

export interface AgentTurnResult {
  content: string;
  status: 'running' | 'completed' | 'needs_user_confirmation' | 'needs_user_input' | 'failed' | 'suspended';
  turnId: string;
  pendingProposalIds?: string[];
}

export interface ToolCallEvent {
  type: 'tool_call';
  toolName: string;
  callId: string;
  args: Record<string, unknown>;
}

export interface ToolResultEvent {
  type: 'tool_result';
  toolName: string;
  callId: string;
  success: boolean;
  summary: string;
}

export interface ChatOptions {
  projectId: string;
  input: string;
  clientId?: string;
  chapter?: number;
}

/**
 * 发起一次 Agent 聊天（SSE 流式，EventSource）。
 * @param onEvent 每条 SSE 事件的回调
 * @returns close 函数（调用以停止流）
 */
export function chatWithAgent(
  opts: ChatOptions,
  onEvent: (event: { type: string; [k: string]: unknown }) => void,
  onError?: (err: Event) => void,
): () => void {
  const { projectId, input, clientId, chapter } = opts;
  // query string 传参（EventSource 不支持 body）
  const params = new URLSearchParams({ input });
  if (clientId) params.set('clientId', clientId);
  if (chapter !== undefined) params.set('chapter', String(chapter));
  const url = `/api/projects/${projectId}/agent/chat?${params}`;

  const es = new EventSource(url);
  es.onmessage = (ev: MessageEvent) => {
    try {
      const data = JSON.parse(ev.data) as { type: string; [k: string]: unknown };
      onEvent(data);
      // done/error 后自动关闭
      if (data.type === 'done' || data.type === 'error') {
        es.close();
      }
    } catch {
      // 非 JSON（如 ping 帧），忽略
    }
  };
  es.onerror = (err: Event) => {
    onError?.(err);
    es.close();
  };
  return () => es.close();
}

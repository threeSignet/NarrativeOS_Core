// =============================================================================
// Agent 会话 store——前端聊天状态管理
// =============================================================================
// 职责：
// - 维护消息列表（用户消息 + Agent 回复，按时间序）
// - 流式接收 Agent token，累积到"正在生成"的 assistant 消息
// - 持有 clientId（localStorage 持久化），跨请求续接同一 BFF 会话
// - 暴露 send(input) 动作，封装 SSE 调用 + 状态流转

import { defineStore } from 'pinia';
import { ref, reactive } from 'vue';
import { chatWithAgent, type AgentTurnResult } from '../api/agent';

/** 单条聊天消息（UI 渲染用） */
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  /** agent 消息的回合状态（决定是否显示"待确认"提示） */
  status?: AgentTurnResult['status'];
  /** 是否仍在流式生成中（控制加载态/光标动画） */
  streaming?: boolean;
  /** 关联的 pendingProposalIds（status=needs_user_confirmation 时有值，里程碑③接入审核 UI） */
  pendingProposalIds?: string[];
}

const CLIENT_ID_KEY = 'narrativeos_agent_client_id';

function loadClientId(): string {
  const existing = localStorage.getItem(CLIENT_ID_KEY);
  if (existing) return existing;
  const id = `web_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  localStorage.setItem(CLIENT_ID_KEY, id);
  return id;
}

export const useAgentStore = defineStore('agent', () => {
  const messages = ref<ChatMessage[]>([]);
  const streaming = ref(false);
  let currentController: { close: () => void } | null = null;

  /** 发送一条用户消息并流式接收 Agent 回复（EventSource） */
  function send(projectId: string, input: string): void {
    if (!input.trim() || streaming.value) return;

    const userMsg: ChatMessage = { id: `msg_${Date.now()}_u`, role: 'user', content: input };
    messages.value.push(userMsg);

    // 用 reactive 包装：Vue 3 的 ref<数组> 对数组元素的属性修改不是深度响应式的，
    // 但 reactive 对象的属性修改是。流式 token 频繁改 content，必须 reactive。
    const assistantMsg = reactive<ChatMessage>({
      id: `msg_${Date.now()}_a`, role: 'assistant', content: '', streaming: true,
    });
    messages.value.push(assistantMsg);

    streaming.value = true;

    // EventSource 模式：返回 close 函数（替代 AbortController）
    const close = chatWithAgent(
      { projectId, input, clientId: loadClientId() },
      (event) => {
        switch (event.type) {
          case 'token':
            assistantMsg.content += event.text as string;
            break;
          case 'done':
            assistantMsg.streaming = false;
            const turn = event.turn as AgentTurnResult | undefined;
            assistantMsg.status = turn?.status;
            assistantMsg.pendingProposalIds = turn?.pendingProposalIds;
            // turn.content 是 Agent 的完整回复正文（成功）或错误信息（failed）。
            // 流式 token 累积的是 LLM 文本，但失败时 token 为空、content 在 turn 里。
            // 优先用 turn.content（更完整），仅当 token 已累积且 turn.content 为空时保留累积。
            if (turn?.content) {
              assistantMsg.content = assistantMsg.content
                ? assistantMsg.content + '\n\n' + turn.content
                : turn.content;
            }
            finishStream();
            break;
          case 'error':
            assistantMsg.streaming = false;
            assistantMsg.status = 'failed';
            const msg = event.message as string;
            assistantMsg.content += assistantMsg.content ? `\n\n⚠️ ${msg}` : `⚠️ ${msg}`;
            finishStream();
            break;
        }
      },
      () => {
        // EventSource onerror（连接中断）
        if (assistantMsg.streaming) {
          assistantMsg.streaming = false;
          assistantMsg.status = 'failed';
          assistantMsg.content += assistantMsg.content
            ? '\n\n⚠️ 连接中断'
            : '⚠️ 连接中断';
          finishStream();
        }
      },
    );
    currentController = { close };

    function finishStream() {
      streaming.value = false;
      currentController = null;
    }
  }

  /** 停止当前流式生成 */
  function stop(): void {
    currentController?.close();
    streaming.value = false;
    currentController = null;
  }

  /** 清空会话（前端层面；BFF 会话 id 仍由 clientId 维持） */
  function clear(): void {
    if (streaming.value) stop();
    messages.value = [];
  }

  return { messages, streaming, send, stop, clear };
});

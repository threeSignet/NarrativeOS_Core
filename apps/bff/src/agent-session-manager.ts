// =============================================================================
// Agent 会话状态管理（BFF 内存层）
// =============================================================================
// 职责：为每个客户端 clientId 维护对应的 NarrativeAgent sessionId，
// 使多轮对话能跨 HTTP 请求续接（同进程内 Agent 的 state.messages 自动累积）。
//
// 设计取舍：
// - 单进程内存 Map（BFF 当前单实例）；重启即丢，里程碑①可接受。
// - 不做持久化恢复——Agent 的 pendingProposals 本就是纯内存（ProposalStore），
//   跨进程恢复也不完整，故这里不做更重的承诺。
// - processUserInput 内部会在 sessionId 为空时自动 startSession（narrative-agent.ts:2004），
//   但提前开能让我们立即把 sessionId 回传给前端，避免前端拿到空 sessionId。

/** 客户端标识 → Agent 会话 id 的映射 */
export interface AgentSessionManager {
  /**
   * 确保 clientId 对应一个已开启的 Agent 会话。
   * - 首次：调 agent.startSession()，记录映射
   * - 已有：复用 sessionId（前提：agent 内存 state 仍持有该 session）
   * 返回当前 sessionId（供 SSE session 事件回传前端）。
   */
  ensureSession(clientId: string, agent: { startSession(title?: string): string; getState(): { sessionId: string } }): string;
  /** 清除某客户端的会话映射（切换会话 / 显式重置时用） */
  clear(clientId: string): void;
}

export function createAgentSessionManager(): AgentSessionManager {
  // key: clientId, value: agent sessionId
  const map = new Map<string, string>();

  return {
    ensureSession(clientId, agent) {
      // 已有映射：复用。agent 同进程内 state.messages 仍持有历史，直接续接。
      const existing = map.get(clientId);
      if (existing && agent.getState().sessionId === existing) {
        return existing;
      }
      // 映射丢失或 agent 状态不匹配（如重启）→ 开新会话
      const sessionId = agent.startSession();
      map.set(clientId, sessionId);
      return sessionId;
    },
    clear(clientId) {
      map.delete(clientId);
    },
  };
}

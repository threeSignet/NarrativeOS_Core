// =============================================================================
// /api/agent 路由——Agent 聊天 SSE 流式通道（Fastify 单端口）
// =============================================================================
// 关键：前端用 EventSource（GET）消费，不用 fetch POST。
// 根因（raw TCP + 浏览器双重实证）：
//   - raw TCP 直连 8787：POST 端点 128 chunk 流式 ✅
//   - 浏览器经 Vite proxy：fetch POST 只 1 chunk ❌（Vite http-proxy 对 POST+SSE 缓冲）
//   - NarrativeOS_Active_1 用 EventSource(GET) 经同样的 Vite proxy 流式 ✅
// EventSource 是浏览器原生 SSE 客户端，不受 proxy 缓冲影响。
// 故前端改用 EventSource，后端提供 GET 端点（input 经 query string）。
//
// SSE 事件协议：
//   data: {"type":"session",...}      会话建立
//   data: {"type":"token",...}        LLM 文本 token
//   data: {"type":"tool_call",...}    工具调用开始（E1）
//   data: {"type":"tool_result",...}  工具调用结束（E1）
//   data: {"type":"done",...}         整回合结束
//   data: {"type":"error",...}        错误

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { AgentSessionManager } from '../agent-session-manager.js';
import type { AgentTurnResult } from '../../../../src/agent/narrative-agent.js';

interface AgentLike {
  startSession(title?: string): string;
  getState(): { sessionId: string };
  processUserInput(
    input: string,
    options?: {
      onToken?: (token: string) => void;
      onToolCall?: (toolName: string, args: Record<string, unknown>, callId: string) => void;
      onToolResult?: (toolName: string, callId: string, success: boolean, summary: string) => void;
      chapter?: number;
    },
  ): Promise<AgentTurnResult>;
}

export interface AgentRouteDeps {
  getAgent: () => AgentLike | undefined;
  /** 懒加载确保 agent 装配（防热重载/缓存导致 agent 丢失） */
  ensureAgent: () => Promise<AgentLike | undefined>;
  agentSessions: AgentSessionManager;
}

export function registerAgentRoutes(app: FastifyInstance, deps: AgentRouteDeps) {
  const { ensureAgent, agentSessions } = deps;

  app.get('/api/projects/:pid/agent/chat', async (req: FastifyRequest, reply: FastifyReply) => {
    const query = req.query as Record<string, string | undefined>;
    await handleChat({
      input: query.input, clientId: query.clientId,
      chapter: query.chapter ? Number(query.chapter) : undefined,
      ensureAgent, agentSessions, reply, req,
    });
    return reply;
  });

  app.post('/api/projects/:pid/agent/chat', async (req: FastifyRequest, reply: FastifyReply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    await handleChat({
      input: body.input as string | undefined, clientId: body.clientId as string | undefined,
      chapter: typeof body.chapter === 'number' ? body.chapter : undefined,
      ensureAgent, agentSessions, reply, req,
    });
    return reply;
  });
}

interface ChatParams {
  input?: string; clientId?: string; chapter?: number;
  ensureAgent: () => Promise<AgentLike | undefined>;
  agentSessions: AgentSessionManager;
  reply: FastifyReply; req: FastifyRequest;
}

/** 共享的 SSE 处理逻辑（GET/POST 共用） */
async function handleChat(p: ChatParams): Promise<void> {
  const { input, clientId, chapter, ensureAgent, agentSessions, reply, req } = p;

  if (!input || !input.trim()) {
    reply.raw.writeHead(400, { 'Content-Type': 'application/json' });
    reply.raw.end(JSON.stringify({ error: 'input 不能为空' }));
    return;
  }
  const agent = await ensureAgent();
  if (!agent) {
    reply.raw.writeHead(503, { 'Content-Type': 'application/json' });
    reply.raw.end(JSON.stringify({ error: 'Agent 未装配（initAgent 失败，检查 DEEPSEEK_API_KEY）' }));
    return;
  }

  // 参考 NarrativeOS_Active_1 aggregation-routes.ts:157——不 hijack，writeHead 后 Fastify 放行
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const send = (event: Record<string, unknown>): void => {
    reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  let closed = false;
  req.raw.on('close', () => { closed = true; });

  const cid = clientId || `anon_${Date.now()}`;
  const sessionId = agentSessions.ensureSession(cid, agent);
  send({ type: 'session', sessionId, clientId: cid });

  try {
    const turn = await agent.processUserInput(input, {
      chapter,
      onToken: (token: string) => send({ type: 'token', text: token }),
      onToolCall: (toolName: string, args: Record<string, unknown>, callId: string) =>
        send({ type: 'tool_call', toolName, callId, args }),
      onToolResult: (toolName: string, callId: string, success: boolean, summary: string) =>
        send({ type: 'tool_result', toolName, callId, success, summary }),
    });
    if (!closed) send({ type: 'done', turn });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (!closed) send({ type: 'error', message });
  } finally {
    if (!closed) reply.raw.end();
  }
}

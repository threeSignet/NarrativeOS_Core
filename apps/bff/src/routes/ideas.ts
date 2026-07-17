// =============================================================================
// /api/projects/:pid/ideas 路由——灵感卡片 CRUD（迭代 B1）
// =============================================================================
// §5.1 灵感捕捉。低约束收集区，永远不直接进 Core。
//   GET    /ideas                列出灵感（可选 filter: maturity/kind）
//   GET    /ideas/:id            获取单个灵感
//   POST   /ideas                捕捉灵感 { content, kind?, tags? }
//   PATCH  /ideas/:id            编辑灵感 { content?, summary?, tags?, kind? }
//   POST   /ideas/:id/discard    废弃（maturity → archived）
//   POST   /ideas/:id/restore    恢复（archived → raw）
import type { FastifyInstance } from 'fastify';
import type { IdeaService } from '../../../../src/writing/services/idea-service.js';
import type { WritingTrigger } from '../../../../src/writing/services/context.js';
import type { IdeaKind, IdeaMaturity } from '../../../../src/writing/models/types.js';
import { WritingError, WritingErrorCode } from '../../../../src/writing/errors/error-codes.js';

export interface IdeaRouteDeps {
  getIdeaService: () => IdeaService;
  makeCtx: (opts?: { pid?: string; trigger?: WritingTrigger }) => any;
}

export function registerIdeaRoutes(app: FastifyInstance, deps: IdeaRouteDeps) {
  const { getIdeaService, makeCtx } = deps;

  const statusFor = (code: string): number => {
    if (code === WritingErrorCode.WRITING_OBJECT_NOT_FOUND) return 404;
    if (code === WritingErrorCode.INVALID_STATUS_TRANSITION) return 409;
    return 400;
  };
  const handleErr = (err: unknown, reply: any) => {
    const e = err as WritingError;
    reply.code(statusFor(e?.code ?? ''));
    return { error: e?.message ?? '未知错误', code: e?.code };
  };

  // ---------- 列出灵感 ----------
  app.get('/api/projects/:pid/ideas', async (req, reply) => {
    const { pid } = req.params as { pid: string };
    const query = req.query as { maturity?: IdeaMaturity; kind?: IdeaKind };
    try {
      return getIdeaService().listIdeaCards(makeCtx({ pid }), query);
    } catch (err) { return handleErr(err, reply); }
  });

  // ---------- 获取单个灵感 ----------
  app.get('/api/projects/:pid/ideas/:id', async (req, reply) => {
    const { pid, id } = req.params as { pid: string; id: string };
    try {
      return getIdeaService().getIdeaDetail(makeCtx({ pid }), id);
    } catch (err) { return handleErr(err, reply); }
  });

  // ---------- 捕捉灵感 ----------
  app.post('/api/projects/:pid/ideas', async (req, reply) => {
    const { pid } = req.params as { pid: string };
    const body = req.body as { content: string; kind?: IdeaKind; tags?: string[] };
    if (!body?.content?.trim()) {
      reply.code(400); return { error: '灵感内容不能为空', code: WritingErrorCode.WRITING_STORE_ERROR };
    }
    try {
      return getIdeaService().captureIdea(
        makeCtx({ pid, trigger: 'author_action' }),
        { content: body.content.trim(), kind: body.kind, tags: body.tags },
      );
    } catch (err) { return handleErr(err, reply); }
  });

  // ---------- 编辑灵感 ----------
  app.patch('/api/projects/:pid/ideas/:id', async (req, reply) => {
    const { pid, id } = req.params as { pid: string; id: string };
    const body = req.body as {
      content?: string; summary?: string | null; tags?: string[]; kind?: IdeaKind;
    };
    try {
      return getIdeaService().updateIdea(makeCtx({ pid }), id, body);
    } catch (err) { return handleErr(err, reply); }
  });

  // ---------- 废弃灵感 ----------
  app.post('/api/projects/:pid/ideas/:id/discard', async (req, reply) => {
    const { pid, id } = req.params as { pid: string; id: string };
    try {
      getIdeaService().discardIdea(makeCtx({ pid }), id);
      return { success: true };
    } catch (err) { return handleErr(err, reply); }
  });

  // ---------- 恢复灵感 ----------
  app.post('/api/projects/:pid/ideas/:id/restore', async (req, reply) => {
    const { pid, id } = req.params as { pid: string; id: string };
    try {
      return getIdeaService().restoreIdea(makeCtx({ pid }), id);
    } catch (err) { return handleErr(err, reply); }
  });
}

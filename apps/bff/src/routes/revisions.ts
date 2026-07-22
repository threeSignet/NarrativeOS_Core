// =============================================================================
// /api/projects/:pid/revisions 路由——修订历史只读查看器（迭代 D2）
// =============================================================================
// §19.1 通用修订记录。覆盖草案/正文/候选/计划等所有写作层对象版本历史。
// 只读：记录由各 service 内部产生（recordRevision），此处只查不写。
//   GET /revisions?limit=100     列出项目全部修订（按时间倒序）
//   GET /revisions/:id           获取单条修订
import type { FastifyInstance } from 'fastify';
import type { RevisionService } from '../../../../src/writing/services/revision-service.js';
import { WritingError, WritingErrorCode } from '../../../../src/writing/errors/error-codes.js';

export interface RevisionRouteDeps {
  getRevisionService: () => RevisionService;
  makeCtx: (opts?: { pid?: string }) => any;
}

export function registerRevisionRoutes(app: FastifyInstance, deps: RevisionRouteDeps) {
  const { getRevisionService, makeCtx } = deps;

  app.get('/api/projects/:pid/revisions', async (req, reply) => {
    const { pid } = req.params as { pid: string };
    const query = req.query as { limit?: string };
    const limit = query.limit ? Number(query.limit) : undefined;
    try {
      return getRevisionService().listAllRevisions(makeCtx({ pid }), limit);
    } catch (err) {
      const e = err as WritingError;
      reply.code(400);
      return { error: e?.message ?? '未知错误', code: e?.code };
    }
  });

  app.get('/api/projects/:pid/revisions/:id', async (req, reply) => {
    const { pid, id } = req.params as { pid: string; id: string };
    try {
      return getRevisionService().getRevision(makeCtx({ pid }), id);
    } catch (err) {
      const e = err as WritingError;
      reply.code(e?.code === WritingErrorCode.WRITING_OBJECT_NOT_FOUND ? 404 : 400);
      return { error: e?.message ?? '未知错误', code: e?.code };
    }
  });
}

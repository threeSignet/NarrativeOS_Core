// =============================================================================
// /api/projects/:pid/retcons 路由——Retcon 影响报告只读查看器（迭代 D4）
// =============================================================================
// §10.5/§19.4 Retcon 影响报告。确认前只读，不改变正式图谱。
//   GET  /retcons              列出全部报告
//   GET  /retcons/:id          获取单条报告
//   POST /retcons/:id/status   推进报告状态
import type { FastifyInstance } from 'fastify';
import type { RetconViewService } from '../../../../src/writing/services/retcon-view-service.js';
import { WritingError, WritingErrorCode } from '../../../../src/writing/errors/error-codes.js';

export interface RetconRouteDeps {
  getRetconViewService: () => RetconViewService;
  makeCtx: (opts?: { pid?: string }) => any;
}

export function registerRetconRoutes(app: FastifyInstance, deps: RetconRouteDeps) {
  const { getRetconViewService, makeCtx } = deps;

  // 列出全部报告
  app.get('/api/projects/:pid/retcons', async (req, reply) => {
    try {
      return getRetconViewService().listReports(makeCtx({ pid: req.params.pid }));
    } catch (err) {
      const e = err as WritingError;
      reply.code(400);
      return { error: e?.message ?? '未知错误', code: e?.code };
    }
  });

  // 获取单条报告
  app.get('/api/projects/:pid/retcons/:id', async (req, reply) => {
    const { pid, id } = req.params as { pid: string; id: string };
    try {
      return getRetconViewService().getReport(makeCtx({ pid }), id);
    } catch (err) {
      const e = err as WritingError;
      reply.code(e?.code === WritingErrorCode.WRITING_OBJECT_NOT_FOUND ? 404 : 400);
      return { error: e?.message ?? '未知错误', code: e?.code };
    }
  });

  // 推进报告状态
  app.post('/api/projects/:pid/retcons/:id/status', async (req, reply) => {
    const { pid, id } = req.params as { pid: string; id: string };
    const body = req.body as { status: string };
    try {
      getRetconViewService().updateReportStatus(makeCtx({ pid }), id, body.status as any);
      return getRetconViewService().getReport(makeCtx({ pid }), id);
    } catch (err) {
      const e = err as WritingError;
      reply.code(e?.code === WritingErrorCode.WRITING_OBJECT_NOT_FOUND ? 404 : 400);
      return { error: e?.message ?? '未知错误', code: e?.code };
    }
  });
}

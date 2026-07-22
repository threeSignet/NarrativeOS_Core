// =============================================================================
// /api/projects/:pid/styles 路由——风格指南只读+编辑（迭代 D3）
// =============================================================================
// §18 风格指南/示例/禁用表达。只读查看 + 首次访问自动创建默认指南。
//   GET  /styles                  获取或创建默认风格指南
//   GET  /styles/:id              获取指定指南
//   PATCH /styles/:id             更新指南字段
//   GET  /styles/examples         列出全部风格示例
//   POST /styles/examples         添加风格示例
//   GET  /styles/banned           列出全部禁用表达
//   POST /styles/banned           添加禁用表达
import type { FastifyInstance } from 'fastify';
import type { StyleService } from '../../../../src/writing/services/style-service.js';
import { WritingError, WritingErrorCode } from '../../../../src/writing/errors/error-codes.js';

export interface StyleRouteDeps {
  getStyleService: () => StyleService;
  makeCtx: (opts?: { pid?: string }) => any;
}

export function registerStyleRoutes(app: FastifyInstance, deps: StyleRouteDeps) {
  const { getStyleService, makeCtx } = deps;

  // 获取或创建默认风格指南
  app.get('/api/projects/:pid/styles', async (req, reply) => {
    try {
      return getStyleService().getOrCreateDefaultGuide(makeCtx({ pid: req.params.pid }));
    } catch (err) {
      const e = err as WritingError;
      reply.code(400);
      return { error: e?.message ?? '未知错误', code: e?.code };
    }
  });

  // 获取指定指南
  app.get('/api/projects/:pid/styles/:id', async (req, reply) => {
    const { pid, id } = req.params as { pid: string; id: string };
    try {
      return getStyleService().getGuide(makeCtx({ pid }), id);
    } catch (err) {
      const e = err as WritingError;
      reply.code(e?.code === WritingErrorCode.WRITING_OBJECT_NOT_FOUND ? 404 : 400);
      return { error: e?.message ?? '未知错误', code: e?.code };
    }
  });

  // 更新风格指南
  app.patch('/api/projects/:pid/styles/:id', async (req, reply) => {
    const { pid, id } = req.params as { pid: string; id: string };
    const body = req.body as Record<string, unknown>;
    try {
      getStyleService().updateGuide(makeCtx({ pid }), id, body);
      return getStyleService().getGuide(makeCtx({ pid }), id);
    } catch (err) {
      const e = err as WritingError;
      reply.code(e?.code === WritingErrorCode.WRITING_OBJECT_NOT_FOUND ? 404 : 400);
      return { error: e?.message ?? '未知错误', code: e?.code };
    }
  });

  // 列出全部风格示例
  app.get('/api/projects/:pid/styles/examples', async (req, reply) => {
    try {
      return getStyleService().listExamples(makeCtx({ pid: req.params.pid }));
    } catch (err) {
      const e = err as WritingError;
      reply.code(400);
      return { error: e?.message ?? '未知错误', code: e?.code };
    }
  });

  // 添加风格示例
  app.post('/api/projects/:pid/styles/examples', async (req, reply) => {
    const body = req.body as { kind: string; text: string; note?: string; sourceBlockId?: string };
    try {
      return getStyleService().addExample(makeCtx({ pid: req.params.pid }), body as any);
    } catch (err) {
      const e = err as WritingError;
      reply.code(400);
      return { error: e?.message ?? '未知错误', code: e?.code };
    }
  });

  // 列出全部禁用表达
  app.get('/api/projects/:pid/styles/banned', async (req, reply) => {
    try {
      return getStyleService().listBannedExpressions(makeCtx({ pid: req.params.pid }));
    } catch (err) {
      const e = err as WritingError;
      reply.code(400);
      return { error: e?.message ?? '未知错误', code: e?.code };
    }
  });

  // 添加禁用表达
  app.post('/api/projects/:pid/styles/banned', async (req, reply) => {
    const body = req.body as { pattern: string; reason?: string; category?: string };
    try {
      return getStyleService().addBannedExpression(makeCtx({ pid: req.params.pid }), body);
    } catch (err) {
      const e = err as WritingError;
      reply.code(400);
      return { error: e?.message ?? '未知错误', code: e?.code };
    }
  });
}

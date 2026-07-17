// =============================================================================
// /api/projects/:pid/spatial 路由——空间地图只读视图（迭代 C4）
// =============================================================================
// §9 地理、空间与多层宇宙。本迭代只暴露 SpatialViewService 的树状只读视图。
//   GET /spatial/tree   构建空间树视图（节点按 contains/parent_of 边组成父子树）
import type { FastifyInstance } from 'fastify';
import type { SpatialViewService } from '../../../../src/writing/services/spatial-view-service.js';
import { WritingError, WritingErrorCode } from '../../../../src/writing/errors/error-codes.js';

export interface SpatialRouteDeps {
  getSpatialViewService: () => SpatialViewService;
  makeCtx: (opts?: { pid?: string }) => any;
}

export function registerSpatialRoutes(app: FastifyInstance, deps: SpatialRouteDeps) {
  const { getSpatialViewService, makeCtx } = deps;

  app.get('/api/projects/:pid/spatial/tree', async (req, reply) => {
    const { pid } = req.params as { pid: string };
    const query = req.query as { parentEdgeTypes?: string };
    try {
      const parentEdgeTypes = query.parentEdgeTypes?.split(',').filter(Boolean);
      return getSpatialViewService().buildSpatialTreeView(makeCtx({ pid }), parentEdgeTypes);
    } catch (err) {
      const e = err as WritingError;
      reply.code(e?.code === WritingErrorCode.WRITING_OBJECT_NOT_FOUND ? 404 : 400);
      return { error: e?.message ?? '未知错误', code: e?.code };
    }
  });
}

// =============================================================================
// /api/projects/:pid/graph 路由——关系图谱只读链路（里程碑②）
// =============================================================================
// 复用 GraphService.buildGraphView（合并 Core Fact + 关系候选 + 创作关联 + 检测提示，
// 投影成统一节点+边结构）。返回 GraphView（已是视图友好结构）。
//
// 注意：GraphNodeView.attributes[].predicate 是 Core 谓词（realm/location…），
// 里程碑②先直传（图谱展示标注"属性"），里程碑③做谓词→人话标签映射。
//
// mode 参数：world（正式关系）/ relationship（含候选）/ spatial / timeline …
// 默认 world。

import type { FastifyInstance } from 'fastify';
import type { GraphService } from '../../../../src/writing/services/graph-service.js';
import type { GraphViewMode, GraphFilterState } from '../../../../src/writing/models/types.js';
import type { WritingTrigger } from '../../../../src/writing/services/context.js';
import { WritingError } from '../../../../src/writing/errors/error-codes.js';

export interface GraphRouteDeps {
  getGraphService: () => GraphService;
  makeCtx: (opts?: { pid?: string; trigger?: WritingTrigger }) => any;
}

export function registerGraphRoutes(app: FastifyInstance, deps: GraphRouteDeps) {
  const { getGraphService, makeCtx } = deps;

  // ---------- 关系图谱视图 ----------
  // GET /api/projects/:pid/graph?mode=world&layers=candidate,association
  app.get('/api/projects/:pid/graph', async (req, reply) => {
    const { pid } = req.params as { pid: string };
    const query = req.query as { mode?: string; layers?: string };
    const mode = (query.mode ?? 'world') as GraphViewMode;
    // layers 逗号分隔 → 转 GraphFilterState.layers
    const filters: GraphFilterState | undefined = query.layers
      ? { layers: query.layers.split(',').filter(Boolean) as GraphFilterState['layers'] }
      : undefined;
    try {
      const view = await getGraphService().buildGraphView(makeCtx({ pid }), mode, filters);
      return view;
    } catch (err) {
      const e = err as WritingError;
      reply.code(400);
      return { error: e?.message ?? '图谱构建失败', code: e?.code };
    }
  });
}

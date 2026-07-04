// =============================================================================
// /api/projects/:pid/entities 路由——实体卡只读链路（里程碑②）
// =============================================================================
// 仅暴露只读 GET（list / get）。写入（hints/promote/approve）留里程碑③。
// 返回 EntityCardViewModel（§9.1 人话投影，不裸露 Core ent_ id）。
// debug 模式（?debug=1）附 _debug 块带 coreEntityId，供排障。

import type { FastifyInstance } from 'fastify';
import type { EntityService } from '../../../../src/writing/services/entity-service.js';
import type { WritingTrigger } from '../../../../src/writing/services/context.js';
import { buildEntityCardView } from '../../../../src/writing/view-models/entity-view.js';
import { WritingError, WritingErrorCode } from '../../../../src/writing/errors/error-codes.js';

export interface EntityRouteDeps {
  getEntityService: () => EntityService;
  makeCtx: (opts?: { pid?: string; trigger?: WritingTrigger }) => any;
}

export function registerEntityRoutes(app: FastifyInstance, deps: EntityRouteDeps) {
  const { getEntityService, makeCtx } = deps;

  const statusFor = (code: string): number => {
    if (code === WritingErrorCode.WRITING_OBJECT_NOT_FOUND) return 404;
    return 400;
  };

  // ---------- 列出实体 ----------
  // ?status 省略 → 全部实体（候选+已注册+hint 等，统一数据源，与图谱 nodes 对齐）
  // ?status=registered → 仅已注册；?status=candidate → 仅候选
  app.get('/api/projects/:pid/entities', async (req, reply) => {
    const { pid } = req.params as { pid: string };
    const query = req.query as { status?: string; debug?: string };
    const mode = query.debug ? 'debug' : 'normal';
    try {
      const ctx = makeCtx({ pid });
      const svc = getEntityService();
      const sketches = query.status === 'registered'
        ? svc.findRegisteredEntities(ctx)
        : query.status === 'candidate'
          ? svc.listCandidateQueue(ctx)
          : svc.listAllEntitySketches(ctx);
      return sketches.map((s) => buildEntityCardView(s, mode as 'normal' | 'debug'));
    } catch (err) {
      const e = err as WritingError;
      reply.code(statusFor(e?.code ?? ''));
      return { error: e?.message ?? '未知错误', code: e?.code };
    }
  });

  // ---------- 获取单个实体卡 ----------
  app.get('/api/projects/:pid/entities/:id', async (req, reply) => {
    const { pid, id } = req.params as { pid: string; id: string };
    const query = req.query as { debug?: string };
    const mode = query.debug ? 'debug' : 'normal';
    try {
      const sketch = getEntityService().getEntitySketch(makeCtx({ pid }), id);
      return buildEntityCardView(sketch, mode as 'normal' | 'debug');
    } catch (err) {
      const e = err as WritingError;
      reply.code(statusFor(e?.code ?? ''));
      return { error: e?.message ?? '未知错误', code: e?.code };
    }
  });
}

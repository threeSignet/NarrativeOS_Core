// =============================================================================
// /api/projects/:pid/timeline 路由——时间线只读视图（迭代 C2）
// =============================================================================
// §15 时间线系统。合并 Core 已提交事件 + 写作层章节/场景计划，双轨时间线。
// 只读：不写 Core，不改变世界状态。
//
//   GET /timeline?mode=world|narrative  构建时间线视图
import type { FastifyInstance } from 'fastify';
import type { TimelineService } from '../../../../src/writing/services/timeline-service.js';
import type { TimelineViewMode, TimelineItemSourceLayer } from '../../../../src/writing/models/types.js';
import { WritingError, WritingErrorCode } from '../../../../src/writing/errors/error-codes.js';

export interface TimelineRouteDeps {
  getTimelineService: () => TimelineService;
  makeCtx: (opts?: { pid?: string }) => any;
}

export function registerTimelineRoutes(app: FastifyInstance, deps: TimelineRouteDeps) {
  const { getTimelineService, makeCtx } = deps;

  app.get('/api/projects/:pid/timeline', async (req, reply) => {
    const { pid } = req.params as { pid: string };
    const query = req.query as {
      mode?: TimelineViewMode;
      sourceLayers?: string; // 逗号分隔
      fromChapter?: string;
      toChapter?: string;
    };
    try {
      const ctx = makeCtx({ pid });
      const mode: TimelineViewMode = (query.mode === 'narrative' || query.mode === 'character' || query.mode === 'thread')
        ? query.mode : 'world';

      const filters: any = {};
      if (query.sourceLayers) {
        filters.sourceLayers = query.sourceLayers.split(',').filter(Boolean) as TimelineItemSourceLayer[];
      }
      if (query.fromChapter || query.toChapter) {
        filters.chapterRange = {
          from: query.fromChapter ? Number(query.fromChapter) : 0,
          to: query.toChapter ? Number(query.toChapter) : 9999,
        };
      }

      return getTimelineService().buildTimelineView(ctx, mode, filters);
    } catch (err) {
      const e = err as WritingError;
      reply.code(e?.code === WritingErrorCode.WRITING_OBJECT_NOT_FOUND ? 404 : 400);
      return { error: e?.message ?? '未知错误', code: e?.code };
    }
  });
}

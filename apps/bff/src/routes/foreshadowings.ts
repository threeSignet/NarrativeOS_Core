// =============================================================================
// /api/projects/:pid/foreshadowings 路由——伏笔看板（迭代 C1）
// =============================================================================
// §17 伏笔/暗示/回收/揭示计划。本迭代只暴露 ForeshadowingPlan 看板最小集：
//   GET    /foreshadowings          列出伏笔计划
//   POST   /foreshadowings          创建伏笔 { label, kind, targetReaderEffect, linkedEntityRefs? }
//   POST   /foreshadowings/:id/transition  推进状态
// Hint/Payoff/Reveal 子模型留给后续迭代。
import type { FastifyInstance } from 'fastify';
import type { ForeshadowingService } from '../../../../src/writing/services/foreshadowing-service.js';
import type { WritingTrigger } from '../../../../src/writing/services/context.js';
import type { ForeshadowingKind, ForeshadowingPlanStatus } from '../../../../src/writing/models/types.js';
import { WritingError, WritingErrorCode } from '../../../../src/writing/errors/error-codes.js';

export interface ForeshadowingRouteDeps {
  getForeshadowingService: () => ForeshadowingService;
  makeCtx: (opts?: { pid?: string; trigger?: WritingTrigger }) => any;
}

export function registerForeshadowingRoutes(app: FastifyInstance, deps: ForeshadowingRouteDeps) {
  const { getForeshadowingService, makeCtx } = deps;

  const statusFor = (code: string): number => {
    if (code === WritingErrorCode.WRITING_OBJECT_NOT_FOUND) return 404;
    return 400;
  };
  const handleErr = (err: unknown, reply: any) => {
    const e = err as WritingError;
    reply.code(statusFor(e?.code ?? ''));
    return { error: e?.message ?? '未知错误', code: e?.code };
  };

  // ---------- 列出伏笔 ----------
  app.get('/api/projects/:pid/foreshadowings', async (req, reply) => {
    const { pid } = req.params as { pid: string };
    try {
      return getForeshadowingService().listForeshadowingPlans(makeCtx({ pid }));
    } catch (err) { return handleErr(err, reply); }
  });

  // ---------- 创建伏笔 ----------
  app.post('/api/projects/:pid/foreshadowings', async (req, reply) => {
    const { pid } = req.params as { pid: string };
    const body = req.body as {
      label: string; kind: ForeshadowingKind; targetReaderEffect: string; linkedEntityRefs?: string[];
    };
    if (!body?.label?.trim()) {
      reply.code(400); return { error: '伏笔标签不能为空', code: WritingErrorCode.WRITING_STORE_ERROR };
    }
    try {
      return getForeshadowingService().createForeshadowingPlan(
        makeCtx({ pid, trigger: 'author_action' }),
        {
          label: body.label.trim(),
          kind: body.kind,
          targetReaderEffect: body.targetReaderEffect ?? '',
          linkedEntityRefs: body.linkedEntityRefs,
        },
      );
    } catch (err) { return handleErr(err, reply); }
  });

  // ---------- 推进伏笔状态 ----------
  app.post('/api/projects/:pid/foreshadowings/:id/transition', async (req, reply) => {
    const { pid, id } = req.params as { pid: string; id: string };
    const body = req.body as { targetStatus: ForeshadowingPlanStatus };
    if (!body?.targetStatus) {
      reply.code(400); return { error: '缺少 targetStatus', code: WritingErrorCode.WRITING_STORE_ERROR };
    }
    try {
      getForeshadowingService().updateForeshadowingPlanStatus(makeCtx({ pid }), id, body.targetStatus);
      return { success: true };
    } catch (err) { return handleErr(err, reply); }
  });
}

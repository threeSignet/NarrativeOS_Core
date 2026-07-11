// =============================================================================
// /api/projects/:pid/entities 路由——实体卡 CRUD + 审核态机（里程碑②③）
// =============================================================================
// GET：list（全部/registered/candidate）/ get
// 写入（里程碑③）：create(hint) / promote(hint→candidate) / approve(candidate→approved)
//   / register(approved→registered，进 Core) / deprecate
//
// 实体注册走"短通道"：approveCandidate 自动建 PendingDecision(confirm_entity)，
// 作者确认后 registerReviewedEntity 直接进 Core（不经 §12 Proposal Review）。
// 详见 plan + entity-service.ts:173 注释。

import type { FastifyInstance } from 'fastify';
import type { EntityService } from '../../../../src/writing/services/entity-service.js';
import type { CoreBridgeService } from '../../../../src/writing/core-bridge/core-bridge-service.js';
import type { WritingTrigger } from '../../../../src/writing/services/context.js';
import { buildEntityCardView } from '../../../../src/writing/view-models/entity-view.js';
import { WritingError, WritingErrorCode } from '../../../../src/writing/errors/error-codes.js';

export interface EntityRouteDeps {
  getEntityService: () => EntityService;
  getCoreBridge: () => CoreBridgeService;
  makeCtx: (opts?: { pid?: string; trigger?: WritingTrigger }) => any;
}

export function registerEntityRoutes(app: FastifyInstance, deps: EntityRouteDeps) {
  const { getEntityService, getCoreBridge, makeCtx } = deps;

  const statusFor = (code: string): number => {
    if (code === WritingErrorCode.WRITING_OBJECT_NOT_FOUND) return 404;
    if (code === WritingErrorCode.VERSION_CONFLICT) return 409;
    return 400;
  };
  const handleErr = (err: unknown, reply: any) => {
    const e = err as WritingError;
    reply.code(statusFor(e?.code ?? ''));
    return { error: e?.message ?? '未知错误', code: e?.code };
  };

  // ---------- 列出实体 ----------
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
    } catch (err) { return handleErr(err, reply); }
  });

  // ---------- 获取单个实体卡 ----------
  app.get('/api/projects/:pid/entities/:id', async (req, reply) => {
    const { pid, id } = req.params as { pid: string; id: string };
    const query = req.query as { debug?: string };
    const mode = query.debug ? 'debug' : 'normal';
    try {
      const sketch = getEntityService().getEntitySketch(makeCtx({ pid }), id);
      return buildEntityCardView(sketch, mode as 'normal' | 'debug');
    } catch (err) { return handleErr(err, reply); }
  });

  // ============ 写入路由（里程碑③）============

  // ---------- 创建实体（hint，创建后立即 promote 到 candidate）----------
  // 前端"新建实体"一步到位：建 hint → promote 到 candidate（用户视角=直接建候选）
  app.post('/api/projects/:pid/entities', async (req, reply) => {
    const { pid } = req.params as { pid: string };
    const body = req.body as { displayName?: string; typeLabel?: string; summary?: string };
    if (!body.displayName?.trim() || !body.typeLabel?.trim()) {
      reply.code(400); return { error: 'displayName 和 typeLabel 不能为空' };
    }
    try {
      const ctx = makeCtx({ pid, trigger: 'author_action' });
      const svc = getEntityService();
      // 建 hint
      const hints = svc.detectEntityHints(ctx, [{
        displayName: body.displayName.trim(),
        typeLabel: body.typeLabel.trim(),
        excerpt: body.summary?.trim(),
      }]);
      const hint = hints[0];
      if (!hint) { reply.code(500); return { error: '创建 hint 失败' }; }
      // 立即 promote 到 candidate（前端"新建实体"=候选态，不暴露 hint 中间态）
      const candidate = svc.promoteHintToSketch(ctx, hint.id, {
        displayName: body.displayName.trim(),
        typeLabel: body.typeLabel.trim(),
      });
      return buildEntityCardView(candidate, 'normal');
    } catch (err) { return handleErr(err, reply); }
  });

  // ---------- hint → candidate ----------
  app.post('/api/projects/:pid/entities/:id/promote', async (req, reply) => {
    const { pid, id } = req.params as { pid: string; id: string };
    try {
      const ctx = makeCtx({ pid });
      const sketch = getEntityService().promoteHintToSketch(ctx, id, {
        displayName: '', typeLabel: '', // promote 会用现有 sketch 的值（service 内部）
      } as any);
      return buildEntityCardView(sketch, 'normal');
    } catch (err) { return handleErr(err, reply); }
  });

  // ---------- candidate → approved（自动建 PendingDecision）----------
  app.post('/api/projects/:pid/entities/:id/approve', async (req, reply) => {
    const { pid, id } = req.params as { pid: string; id: string };
    try {
      const ctx = makeCtx({ pid });
      const sketch = getEntityService().approveCandidate(ctx, id);
      return buildEntityCardView(sketch, 'normal');
    } catch (err) { return handleErr(err, reply); }
  });

  // ---------- approved → registered（确认注册进 Core）----------
  // 走 CoreBridge.registerReviewedEntity（短通道，不经 Proposal Review）
  app.post('/api/projects/:pid/entities/:id/register', async (req, reply) => {
    const { pid, id } = req.params as { pid: string; id: string };
    try {
      const ctx = makeCtx({ pid });
      const result = await getCoreBridge().registerReviewedEntity(ctx, id);
      if (!result.success) {
        reply.code(500);
        return { error: result.error?.humanMessage ?? '注册 Core 失败', code: 'CORE_REGISTER_FAILED' };
      }
      // 返回最新实体卡（已 registered + coreEntityId 回写）
      const sketch = getEntityService().getEntitySketch(ctx, id);
      return buildEntityCardView(sketch, 'normal');
    } catch (err) { return handleErr(err, reply); }
  });

  // ---------- 废弃实体 ----------
  app.delete('/api/projects/:pid/entities/:id', async (req, reply) => {
    const { pid, id } = req.params as { pid: string; id: string };
    const body = (req.body ?? {}) as { reason?: string };
    try {
      const ctx = makeCtx({ pid });
      getEntityService().deprecateEntitySketch(ctx, id, body.reason);
      return { success: true };
    } catch (err) { return handleErr(err, reply); }
  });
}

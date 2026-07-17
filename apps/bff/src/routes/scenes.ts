// =============================================================================
// /api/projects/:pid/scenes 路由——场景卡 CRUD（迭代 D1）
// =============================================================================
// §14.3 场景规划。场景归属章节，含目标/冲突/结果/参与者/POV。
//   GET    /scenes?chapterId=xxx   列出场景（可按章节过滤）
//   GET    /scenes/:id             获取单个场景
//   POST   /scenes                 创建场景
//   PATCH  /scenes/:id             更新场景（乐观锁）
//   POST   /scenes/:id/transition  推进状态
import type { FastifyInstance } from 'fastify';
import type { SceneService } from '../../../../src/writing/services/scene-service.js';
import type { WritingTrigger } from '../../../../src/writing/services/context.js';
import type { ScenePurpose, ScenePlanStatus } from '../../../../src/writing/models/types.js';
import { WritingError, WritingErrorCode } from '../../../../src/writing/errors/error-codes.js';

export interface SceneRouteDeps {
  getSceneService: () => SceneService;
  makeCtx: (opts?: { pid?: string; trigger?: WritingTrigger }) => any;
}

export function registerSceneRoutes(app: FastifyInstance, deps: SceneRouteDeps) {
  const { getSceneService, makeCtx } = deps;

  const statusFor = (code: string): number => {
    if (code === WritingErrorCode.WRITING_OBJECT_NOT_FOUND) return 404;
    if (code === WritingErrorCode.VERSION_CONFLICT) return 409;
    if (code === WritingErrorCode.INVALID_STATUS_TRANSITION) return 409;
    return 400;
  };
  const handleErr = (err: unknown, reply: any) => {
    const e = err as WritingError;
    reply.code(statusFor(e?.code ?? ''));
    return { error: e?.message ?? '未知错误', code: e?.code };
  };

  // ---------- 列出场景 ----------
  app.get('/api/projects/:pid/scenes', async (req, reply) => {
    const { pid } = req.params as { pid: string };
    const query = req.query as { chapterId?: string };
    try {
      return getSceneService().listScenes(makeCtx({ pid }), query.chapterId);
    } catch (err) { return handleErr(err, reply); }
  });

  // ---------- 获取单个场景 ----------
  app.get('/api/projects/:pid/scenes/:id', async (req, reply) => {
    const { pid, id } = req.params as { pid: string; id: string };
    try {
      const scene = getSceneService().getScene(makeCtx({ pid }), id);
      if (!scene) { reply.code(404); return { error: '场景不存在', code: WritingErrorCode.WRITING_OBJECT_NOT_FOUND }; }
      return scene;
    } catch (err) { return handleErr(err, reply); }
  });

  // ---------- 创建场景 ----------
  app.post('/api/projects/:pid/scenes', async (req, reply) => {
    const { pid } = req.params as { pid: string };
    const body = req.body as {
      chapterId: string; title: string;
      purpose?: ScenePurpose[]; povEntityId?: string;
      participants?: string[]; expectedOutcome?: string;
    };
    if (!body?.chapterId?.trim() || !body?.title?.trim()) {
      reply.code(400); return { error: '章节ID和标题不能为空', code: WritingErrorCode.WRITING_STORE_ERROR };
    }
    try {
      const ctx = makeCtx({ pid, trigger: 'author_action' });
      // order 自动放该章节末尾
      const existing = getSceneService().listScenes(ctx, body.chapterId);
      const order = existing.length + 1;
      return getSceneService().createScene(ctx, {
        chapterId: body.chapterId,
        order,
        title: body.title.trim(),
        purpose: body.purpose,
        povEntityId: body.povEntityId,
        participants: body.participants,
        expectedOutcome: body.expectedOutcome,
      });
    } catch (err) { return handleErr(err, reply); }
  });

  // ---------- 更新场景 ----------
  app.patch('/api/projects/:pid/scenes/:id', async (req, reply) => {
    const { pid, id } = req.params as { pid: string; id: string };
    const body = req.body as {
      expectedVersion: number;
      title?: string; purpose?: ScenePurpose[];
      povEntityId?: string; participants?: string[]; expectedOutcome?: string;
    };
    if (typeof body?.expectedVersion !== 'number') {
      reply.code(400); return { error: '缺少 expectedVersion', code: WritingErrorCode.WRITING_STORE_ERROR };
    }
    try {
      const updates: Record<string, unknown> = {};
      if (body.title !== undefined) updates.title = body.title;
      if (body.purpose !== undefined) updates.purpose = body.purpose;
      if (body.povEntityId !== undefined) updates.povEntityId = body.povEntityId;
      if (body.participants !== undefined) updates.participants = body.participants;
      if (body.expectedOutcome !== undefined) updates.expectedOutcome = body.expectedOutcome;
      return getSceneService().updateScene(makeCtx({ pid }), id, body.expectedVersion, updates);
    } catch (err) { return handleErr(err, reply); }
  });

  // ---------- 推进状态 ----------
  app.post('/api/projects/:pid/scenes/:id/transition', async (req, reply) => {
    const { pid, id } = req.params as { pid: string; id: string };
    const body = req.body as { targetStatus: ScenePlanStatus };
    if (!body?.targetStatus) {
      reply.code(400); return { error: '缺少 targetStatus', code: WritingErrorCode.WRITING_STORE_ERROR };
    }
    try {
      return getSceneService().transitionSceneStatus(makeCtx({ pid }), id, body.targetStatus);
    } catch (err) { return handleErr(err, reply); }
  });
}

// =============================================================================
// /api/projects/:pid/chapters 路由——章节规划 CRUD + 状态推进 + 重排（迭代 A1）
// =============================================================================
// Feature-Spec §14.2：章节规划是写作层叙事组织，不写 Core。
//   GET    /chapters           列出全部章节（按 order 升序）
//   GET    /chapters/:id       获取单个章节
//   POST   /chapters           创建章节
//   PATCH  /chapters/:id       更新章节（乐观锁，需 expectedVersion + version）
//   POST   /chapters/:id/transition  推进章节状态（planned→drafting→written→revising→done）
//   POST   /chapters/reorder   重排章节顺序（body: { orderedIds: string[] }）

import type { FastifyInstance } from 'fastify';
import type { ChapterService } from '../../../../src/writing/services/chapter-service.js';
import type { WritingTrigger } from '../../../../src/writing/services/context.js';
import type { ChapterPlanStatus } from '../../../../src/writing/models/types.js';
import { WritingError, WritingErrorCode } from '../../../../src/writing/errors/error-codes.js';

export interface ChapterRouteDeps {
  getChapterService: () => ChapterService;
  makeCtx: (opts?: { pid?: string; trigger?: WritingTrigger }) => any;
}

export function registerChapterRoutes(app: FastifyInstance, deps: ChapterRouteDeps) {
  const { getChapterService, makeCtx } = deps;

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

  // ---------- 列出全部章节 ----------
  app.get('/api/projects/:pid/chapters', async (req, reply) => {
    const { pid } = req.params as { pid: string };
    try {
      return getChapterService().listChapters(makeCtx({ pid }));
    } catch (err) { return handleErr(err, reply); }
  });

  // ---------- 获取单个章节 ----------
  app.get('/api/projects/:pid/chapters/:id', async (req, reply) => {
    const { pid, id } = req.params as { pid: string; id: string };
    try {
      const chapter = getChapterService().getChapter(makeCtx({ pid }), id);
      if (!chapter) { reply.code(404); return { error: '章节不存在', code: WritingErrorCode.WRITING_OBJECT_NOT_FOUND }; }
      return chapter;
    } catch (err) { return handleErr(err, reply); }
  });

  // ---------- 创建章节 ----------
  app.post('/api/projects/:pid/chapters', async (req, reply) => {
    const { pid } = req.params as { pid: string };
    const body = req.body as {
      title: string;
      order?: number;
      goals?: string[];
      povEntityId?: string;
    };
    if (!body?.title?.trim()) {
      reply.code(400); return { error: '章节标题不能为空', code: WritingErrorCode.WRITING_STORE_ERROR };
    }
    try {
      const ctx = makeCtx({ pid, trigger: 'author_action' });
      // order 不传时，自动放到末尾（现有章节数 + 1）
      const existing = getChapterService().listChapters(ctx);
      const order = body.order ?? (existing.length + 1);
      return getChapterService().createChapter(ctx, {
        order,
        title: body.title.trim(),
        goals: body.goals,
        povEntityId: body.povEntityId,
      });
    } catch (err) { return handleErr(err, reply); }
  });

  // ---------- 更新章节（乐观锁） ----------
  app.patch('/api/projects/:pid/chapters/:id', async (req, reply) => {
    const { pid, id } = req.params as { pid: string; id: string };
    const body = req.body as {
      expectedVersion: number;
      title?: string;
      goals?: string[];
      povEntityId?: string;
      order?: number;
      proseDocumentId?: string;
    };
    if (typeof body?.expectedVersion !== 'number') {
      reply.code(400); return { error: '缺少 expectedVersion', code: WritingErrorCode.WRITING_STORE_ERROR };
    }
    try {
      const updates: Record<string, unknown> = {};
      if (body.title !== undefined) updates.title = body.title;
      if (body.goals !== undefined) updates.goals = body.goals;
      if (body.povEntityId !== undefined) updates.povEntityId = body.povEntityId;
      if (body.order !== undefined) updates.order = body.order;
      if (body.proseDocumentId !== undefined) updates.proseDocumentId = body.proseDocumentId;
      return getChapterService().updateChapter(makeCtx({ pid }), id, body.expectedVersion, updates);
    } catch (err) { return handleErr(err, reply); }
  });

  // ---------- 推进章节状态 ----------
  app.post('/api/projects/:pid/chapters/:id/transition', async (req, reply) => {
    const { pid, id } = req.params as { pid: string; id: string };
    const body = req.body as { targetStatus: ChapterPlanStatus };
    if (!body?.targetStatus) {
      reply.code(400); return { error: '缺少 targetStatus', code: WritingErrorCode.WRITING_STORE_ERROR };
    }
    try {
      return getChapterService().transitionChapterStatus(makeCtx({ pid }), id, body.targetStatus);
    } catch (err) { return handleErr(err, reply); }
  });

  // ---------- 重排章节顺序 ----------
  app.post('/api/projects/:pid/chapters/reorder', async (req, reply) => {
    const { pid } = req.params as { pid: string };
    const body = req.body as { orderedIds: string[] };
    if (!Array.isArray(body?.orderedIds)) {
      reply.code(400); return { error: '缺少 orderedIds 数组', code: WritingErrorCode.WRITING_STORE_ERROR };
    }
    try {
      getChapterService().reorderChapters(makeCtx({ pid }), body.orderedIds);
      return { success: true, count: body.orderedIds.length };
    } catch (err) { return handleErr(err, reply); }
  });
}

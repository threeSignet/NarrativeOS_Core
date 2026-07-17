// =============================================================================
// /api/projects/:pid/prose 路由——正文文档（迭代 A2）
// =============================================================================
// §13.8 块级正文模型。本迭代只暴露"文档级 + 文本读写"最小集，
// 让前端章节编辑器能读写正文。块级 CRUD（addBlock/moveBlock 等）留给后续迭代。
//
//   GET    /prose/:id              获取文档 + 全部块（聚合视图）
//   POST   /prose                  创建文档 { title, draftId? }
//   POST   /prose/:id/ingest       纯文本批量写入（按空行/标题切分为块）
//   GET    /prose                  列出项目所有文档（概览）

import type { FastifyInstance } from 'fastify';
import type { ProseService } from '../../../../src/writing/services/prose-service.js';
import type { WritingTrigger } from '../../../../src/writing/services/context.js';
import { WritingError, WritingErrorCode } from '../../../../src/writing/errors/error-codes.js';

export interface ProseRouteDeps {
  getProseService: () => ProseService;
  makeCtx: (opts?: { pid?: string; trigger?: WritingTrigger }) => any;
}

export function registerProseRoutes(app: FastifyInstance, deps: ProseRouteDeps) {
  const { getProseService, makeCtx } = deps;

  const statusFor = (code: string): number => {
    if (code === WritingErrorCode.WRITING_OBJECT_NOT_FOUND) return 404;
    return 400;
  };
  const handleErr = (err: unknown, reply: any) => {
    const e = err as WritingError;
    reply.code(statusFor(e?.code ?? ''));
    return { error: e?.message ?? '未知错误', code: e?.code };
  };

  // ---------- 列出项目所有正文文档 ----------
  app.get('/api/projects/:pid/prose', async (req, reply) => {
    const { pid } = req.params as { pid: string };
    try {
      return getProseService().listDocuments(makeCtx({ pid }));
    } catch (err) { return handleErr(err, reply); }
  });

  // ---------- 获取文档 + 全部块 ----------
  app.get('/api/projects/:pid/prose/:id', async (req, reply) => {
    const { pid, id } = req.params as { pid: string; id: string };
    try {
      return getProseService().getDocumentWithBlocks(makeCtx({ pid }), id);
    } catch (err) { return handleErr(err, reply); }
  });

  // ---------- 创建文档 ----------
  app.post('/api/projects/:pid/prose', async (req, reply) => {
    const { pid } = req.params as { pid: string };
    const body = req.body as { title: string; draftId?: string };
    if (!body?.title?.trim()) {
      reply.code(400); return { error: '标题不能为空', code: WritingErrorCode.WRITING_STORE_ERROR };
    }
    try {
      return getProseService().createDocument(makeCtx({ pid, trigger: 'author_action' }), {
        title: body.title.trim(),
        draftId: body.draftId,
      });
    } catch (err) { return handleErr(err, reply); }
  });

  // ---------- 纯文本批量写入（切分为块）----------
  // 前端编辑器把整篇正文（Markdown 串）一次性写入，后端 splitMarkdownToBlocks 切分。
  // 本迭代简化：每次 ingest 先清空旧块再写入新块（全量替换语义），避免块级 diff 复杂度。
  app.post('/api/projects/:pid/prose/:id/ingest', async (req, reply) => {
    const { pid, id } = req.params as { pid: string; id: string };
    const body = req.body as { text: string };
    if (typeof body?.text !== 'string') {
      reply.code(400); return { error: '缺少 text', code: WritingErrorCode.WRITING_STORE_ERROR };
    }
    try {
      const ctx = makeCtx({ pid });
      const svc = getProseService();
      // 全量替换：先取旧块逐个删除，再 ingest 新文本
      const existing = svc.getDocumentWithBlocks(ctx, id);
      for (const b of existing.blocks) {
        // 反向删除避免 order_index 重排干扰
        svc.deleteBlock(ctx, b.id);
      }
      const result = svc.ingestText(ctx, id, body.text);
      return { success: true, addedCount: result.addedCount };
    } catch (err) { return handleErr(err, reply); }
  });
}

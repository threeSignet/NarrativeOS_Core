// =============================================================================
// /api/documents 路由——设定集文档树 CRUD（多项目版）
// =============================================================================
// 项目 id 从 URL 的 :pid 取，按 pid 构造 ctx，不再依赖全局单一激活项目。
// 激活项目的语义在 projects 路由管理，本路由只做文档 CRUD。

import type { FastifyInstance } from 'fastify';
import type { DocumentService } from '../../../../src/writing/services/document-service.js';
import type { WritingTrigger } from '../../../../src/writing/services/context.js';
import { WritingError, WritingErrorCode } from '../../../../src/writing/errors/error-codes.js';

export interface RouteDeps {
  documentService: DocumentService;
  makeCtx: (opts?: { pid?: string; trigger?: WritingTrigger }) => any;
}

export function registerDocumentRoutes(app: FastifyInstance, deps: RouteDeps) {
  const { documentService, makeCtx } = deps;

  const statusFor = (code: string): number => {
    if (code === WritingErrorCode.WRITING_OBJECT_NOT_FOUND) return 404;
    if (code === WritingErrorCode.VERSION_CONFLICT) return 409;
    return 400;
  };

  // ---------- 列出文档树 ----------
  app.get('/api/projects/:pid/documents', async (req) => {
    const { pid } = req.params as { pid: string };
    return documentService.listTree(makeCtx({ pid }));
  });

  // ---------- 获取单个文档 ----------
  app.get('/api/documents/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      // 文档自带 projectId，service 内部校验归属；这里用文档的 ctx
      // 注意：getDocument 需要 ctx.projectId 匹配文档的 projectId。
      // 简化：先用空 ctx 取，service 会校验。实际用一个临时 ctx 即可，
      // 因为 DocumentService.getDocument 只比对 doc.projectId === ctx.projectId。
      // 这里取不到 pid，改为信任 service 内部校验：用激活项目 ctx，
      // 若不匹配 service 抛 NOT_FOUND。
      return documentService.getDocument(makeCtx(), id);
    } catch (err) {
      const e = err as WritingError;
      return reply.code(statusFor(e.code)).send({ error: e.message, code: e.code });
    }
  });

  // ---------- 新建文件夹 / 文档 ----------
  app.post('/api/projects/:pid/documents', async (req, reply) => {
    const { pid } = req.params as { pid: string };
    const body = req.body as {
      kind?: 'folder' | 'document';
      parentId?: string | null;
      title: string;
      template?: string;
      icon?: string;
      content?: string;
      contentFormat?: string;
      tags?: string[];
    };
    try {
      const ctx = makeCtx({ pid });
      if (body.kind === 'folder') {
        return documentService.createFolder(ctx, {
          parentId: body.parentId ?? null,
          title: body.title,
          icon: body.icon,
        });
      }
      return documentService.createDocument(ctx, {
        parentId: body.parentId ?? null,
        title: body.title,
        template: body.template as any,
        icon: body.icon,
        content: body.content,
        contentFormat: body.contentFormat as any,
        tags: body.tags,
      });
    } catch (err) {
      const e = err as WritingError;
      return reply.code(statusFor(e.code)).send({ error: e.message, code: e.code });
    }
  });

  // ---------- 更新（内容/改名/移动）----------
  app.patch('/api/documents/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as {
      expectedVersion: number;
      content?: string;
      contentFormat?: string;
      title?: string;
      parentId?: string | null;
    };
    try {
      const ctx = makeCtx();
      if (body.content !== undefined) {
        return documentService.updateContent(ctx, id, body.expectedVersion, body.content, body.contentFormat as any);
      }
      if (body.title !== undefined) {
        return documentService.rename(ctx, id, body.expectedVersion, body.title);
      }
      if (body.parentId !== undefined) {
        return documentService.move(ctx, id, body.expectedVersion, body.parentId);
      }
      return reply.code(400).send({ error: 'PATCH 需至少包含 content/title/parentId 之一' });
    } catch (err) {
      const e = err as WritingError;
      return reply.code(statusFor(e.code)).send({ error: e.message, code: e.code });
    }
  });

  // ---------- 同级重排 ----------
  app.post('/api/projects/:pid/documents/reorder', async (req) => {
    const { pid } = req.params as { pid: string };
    const body = req.body as { parentId: string | null; orderedIds: string[] };
    documentService.reorder(makeCtx({ pid }), body.parentId, body.orderedIds);
    return { ok: true };
  });

  // ---------- 批量导入文件（txt/md → 文档树子节点） ----------
  // 每个文件：标题取文件名去扩展名（或首行 # ），content 转为 TipTap JSON 段落串。
  // 落点是设定集文档树（DocumentService），与编辑器一致，不接 ProseService。
  app.post('/api/projects/:pid/documents/import', async (req, reply) => {
    const { pid } = req.params as { pid: string };
    const body = req.body as {
      parentId?: string | null;
      files: Array<{ filename: string; content: string }>;
    };
    if (!body.files || !Array.isArray(body.files) || body.files.length === 0) {
      return reply.code(400).send({ error: 'files 不能为空' });
    }
    const ctx = makeCtx({ pid });
    const created: unknown[] = [];
    try {
      for (const f of body.files) {
        if (!f.content || f.content.trim() === '') continue;
        const title = deriveImportTitle(f.filename, f.content);
        const tiptapContent = plainTextToTiptapJson(f.content);
        const doc = documentService.createDocument(ctx, {
          parentId: body.parentId ?? null,
          title,
          content: tiptapContent,
          contentFormat: 'tiptap',
        });
        created.push(doc);
      }
      return { created };
    } catch (err) {
      const e = err as WritingError;
      return reply.code(statusFor(e.code)).send({ error: e.message, code: e.code });
    }
  });

  // ---------- 归档（软删除，文件夹级联）----------
  app.delete('/api/documents/:id', async (req) => {
    const { id } = req.params as { id: string };
    documentService.archive(makeCtx(), id);
    return { ok: true };
  });
}

// =============================================================================
// 导入辅助：纯文本 → TipTap JSON（服务端版，与前端 tiptapConvert 等价）
// =============================================================================

/** 导入文件标题：文件名去扩展名，若为空取首行 # 标题，再兜底日期 */
function deriveImportTitle(filename: string, content: string): string {
  const base = filename.replace(/\.(txt|md|markdown)$/i, '').trim();
  if (base) return base.slice(0, 80);
  const firstLine = content.split('\n').map(l => l.trim()).find(l => l.length > 0);
  if (firstLine) return firstLine.replace(/^#+\s*/, '').slice(0, 80);
  return `导入文档 ${new Date().toLocaleString('zh-CN')}`;
}

/** 纯文本 → TipTap doc JSON 串（按行切段落，识别 # / ## / > / 分隔符） */
function plainTextToTiptapJson(text: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const content: TiptapNode[] = [];
  let paraBuf: string[] = [];

  const flushPara = () => {
    if (paraBuf.length === 0) return;
    content.push({ type: 'paragraph', content: [{ type: 'text', text: paraBuf.join('\n') }] });
    paraBuf = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trimEnd();

    if (/^(\*\*\*|---|\*\s\*\s\*)$/.test(line.trim())) { flushPara(); content.push({ type: 'horizontalRule' }); continue; }
    const hm = /^(#{1,3})\s+(.*)$/.exec(line);
    if (hm) { flushPara(); content.push({ type: 'heading', attrs: { level: hm[1]!.length }, content: [{ type: 'text', text: hm[2]!.trim() }] }); continue; }
    if (/^[-*+]\s+/.test(line)) {
      flushPara();
      const items: TiptapNode[] = [];
      while (i < lines.length && /^[-*+]\s+/.test(lines[i]!.trimEnd())) {
        items.push({ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: lines[i]!.replace(/^[-*+]\s+/, '') }] }] });
        i++;
      }
      content.push({ type: 'bulletList', content: items }); i--; continue;
    }
    if (/^\d+\.\s+/.test(line)) {
      flushPara();
      const items: TiptapNode[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i]!.trimEnd())) {
        items.push({ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: lines[i]!.replace(/^\d+\.\s+/, '') }] }] });
        i++;
      }
      content.push({ type: 'orderedList', content: items }); i--; continue;
    }
    if (/^>\s?/.test(line)) {
      flushPara();
      const quote: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i]!.trimEnd())) { quote.push(lines[i]!.replace(/^>\s?/, '')); i++; }
      content.push({ type: 'blockquote', content: [{ type: 'paragraph', content: [{ type: 'text', text: quote.join('\n') }] }] }); i--; continue;
    }
    if (line.trim() === '') { flushPara(); continue; }
    paraBuf.push(line);
  }
  flushPara();
  if (content.length === 0) content.push({ type: 'paragraph' });
  return JSON.stringify({ type: 'doc', content });
}

interface TiptapNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: TiptapNode[];
  text?: string;
}

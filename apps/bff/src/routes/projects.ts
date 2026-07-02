// =============================================================================
// /api/projects 路由——多项目管理（列出/新建/切换/删除/改名/取当前）
// =============================================================================
import type { FastifyInstance } from 'fastify';
import type { ProjectService } from '../../../../src/writing/services/project-service.js';
import type { SQLiteWritingStore } from '../../../../src/writing/repositories/writing-store.js';
import type { WritingTrigger } from '../../../../src/writing/services/context.js';
import { WritingError, WritingErrorCode } from '../../../../src/writing/errors/error-codes.js';

export interface ProjectRouteDeps {
  projectService: ProjectService;
  writingStore: SQLiteWritingStore;
  activeProjectId: { value: string };
  makeCtx: (opts?: { pid?: string; trigger?: WritingTrigger }) => any;
}

/** 项目对外的精简视图（去技术字段） */
function toView(p: any) {
  return {
    id: p.id,
    title: p.title,
    premise: p.premise ?? '',
    status: p.status,
    version: p.version,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

export function registerProjectRoutes(app: FastifyInstance, deps: ProjectRouteDeps) {
  const { projectService, writingStore, activeProjectId, makeCtx } = deps;

  const statusFor = (code: string): number => {
    if (code === WritingErrorCode.WRITING_OBJECT_NOT_FOUND) return 404;
    if (code === WritingErrorCode.VERSION_CONFLICT) return 409;
    return 400;
  };

  // ---------- 列出全部项目（含文档数统计） ----------
  app.get('/api/projects', async () => {
    const projects = writingStore.listProjects();
    const withCount = projects.map(p => ({
      ...toView(p),
      documentCount: writingStore.listDocuments(p.id).length,
    }));
    return {
      projects: withCount,
      activeId: activeProjectId.value,
    };
  });

  // ---------- 取当前激活项目 ----------
  app.get('/api/projects/current', async () => {
    const project = projectService.getProject(makeCtx());
    return toView(project);
  });

  // ---------- 新建项目 ----------
  app.post('/api/projects', async (req, reply) => {
    const body = req.body as { title: string; premise?: string };
    if (!body.title?.trim()) return reply.code(400).send({ error: '项目名不能为空' });
    try {
      // createProject 内部用 ctx.projectId 作新项目 id 占位，这里用临时 ctx
      const bootstrapCtx = makeCtx({ pid: 'bootstrap', trigger: 'author_action' });
      const project = projectService.createProject(bootstrapCtx, { title: body.title.trim(), premise: body.premise });
      return toView(project);
    } catch (err) {
      const e = err as WritingError;
      return reply.code(statusFor(e.code)).send({ error: e.message, code: e.code });
    }
  });

  // ---------- 切换激活项目 ----------
  app.post('/api/projects/:pid/activate', async (req, reply) => {
    const { pid } = req.params as { pid: string };
    const project = writingStore.getProject(pid);
    if (!project) return reply.code(404).send({ error: '项目不存在' });
    activeProjectId.value = pid;
    return { activeId: pid };
  });

  // ---------- 改项目元信息（名/前提）----------
  app.patch('/api/projects/:pid', async (req, reply) => {
    const { pid } = req.params as { pid: string };
    const body = req.body as { title?: string; premise?: string };
    if (body.title === undefined && body.premise === undefined) {
      return reply.code(400).send({ error: '需至少指定 title 或 premise' });
    }
    try {
      const ctx = makeCtx({ pid });
      const updated = projectService.updateProjectMeta(ctx, {
        ...(body.title !== undefined ? { title: body.title.trim() } : {}),
        ...(body.premise !== undefined ? { premise: body.premise } : {}),
      });
      return toView(updated);
    } catch (err) {
      const e = err as WritingError;
      return reply.code(statusFor(e.code)).send({ error: e.message, code: e.code });
    }
  });

  // ---------- 软删项目（级联）----------
  app.delete('/api/projects/:pid', async (req, reply) => {
    const { pid } = req.params as { pid: string };
    const project = writingStore.getProject(pid);
    if (!project) return reply.code(404).send({ error: '项目不存在' });
    try {
      const ctx = makeCtx({ pid });
      projectService.archiveProject(ctx);
      // 删的是当前激活项目 → 切到剩余的第一个（若有）
      if (activeProjectId.value === pid) {
        const remaining = writingStore.listProjects();
        activeProjectId.value = remaining[0]?.id ?? '';
      }
      return { ok: true, activeId: activeProjectId.value };
    } catch (err) {
      const e = err as WritingError;
      return reply.code(statusFor(e.code)).send({ error: e.message, code: e.code });
    }
  });

  // ---------- 导出项目设定集为 Markdown ----------
  // 把项目下所有文档按树形结构拼成一个 Markdown 文本。
  // 文件夹 → 标题层级（# / ## / ### 按深度）；文档 → 二级标题 + 正文。
  app.get('/api/projects/:pid/export', async (req, reply) => {
    const { pid } = req.params as { pid: string };
    const project = writingStore.getProject(pid);
    if (!project) return reply.code(404).send({ error: '项目不存在' });

    const allDocs = writingStore.listDocuments(pid);

    // 按 parentId 组装树
    const byParent = new Map<string | null, typeof allDocs>();
    for (const d of allDocs) {
      const key = d.parentId;
      if (!byParent.has(key)) byParent.set(key, []);
      byParent.get(key)!.push(d);
    }

    const lines: string[] = [];
    // 文档头部
    lines.push(`# ${project.title}`);
    lines.push('');
    if (project.premise) {
      lines.push(`> ${project.premise}`);
      lines.push('');
    }
    lines.push(`> 导出时间：${new Date().toISOString().slice(0, 19).replace('T', ' ')}`);
    lines.push('');
    lines.push('---');
    lines.push('');

    // 递归生成 Markdown（文件夹=标题，文档=标题+正文）
    const renderNode = (node: typeof allDocs[number], depth: number) => {
      const heading = '#'.repeat(Math.min(depth + 2, 6));
      lines.push(`${heading} ${node.title}`);
      lines.push('');
      if (node.kind === 'document' && node.content) {
        // content 可能是 TipTap JSON / HTML / 纯文本；简单提取文本
        let text = node.content;
        if (text.trim().startsWith('{')) {
          try { text = extractTextFromTiptapJson(JSON.parse(text)); } catch { /* 用原文 */ }
        }
        // HTML 则去标签
        text = text.replace(/<[^>]+>/g, '').trim();
        if (text) { lines.push(text); lines.push(''); }
      }
      const children = (byParent.get(node.id) ?? []).sort((a, b) => a.sortOrder - b.sortOrder);
      for (const c of children) renderNode(c, depth + 1);
    };

    const roots = (byParent.get(null) ?? []).sort((a, b) => a.sortOrder - b.sortOrder);
    for (const r of roots) renderNode(r, 1);

    const markdown = lines.join('\n');
    const filename = encodeURIComponent(`${project.title}-设定集.md`);
    reply.header('Content-Type', 'text/markdown; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="${filename}"`);
    return markdown;
  });
}

/** 从 TipTap JSON 粗略提取纯文本（递归取 text 节点） */
function extractTextFromTiptapJson(node: any): string {
  if (!node) return '';
  if (node.type === 'text') return node.text ?? '';
  if (Array.isArray(node.content)) {
    return node.content.map((c: any) => extractTextFromTiptapJson(c)).join(node.type === 'paragraph' ? '\n' : '');
  }
  return '';
}

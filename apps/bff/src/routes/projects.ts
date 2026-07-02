// =============================================================================
// /api/projects 路由——多项目管理（融合后版，基于 app.db 注册表）
// =============================================================================
// 改造（存储融合）：路由改用 ProjectManager（基于 data/app.db 注册表），
// 替代旧的 writingStore.listProjects（单库单项目模型）。
//
// 关键：列出全部项目走 manager.listProjects()（app.db），每个项目的标题/文档数
// 需打开对应 session 查（项目数少，可接受）。激活项目切换 = manager.openProject。
import type { FastifyInstance } from 'fastify';
import type { ProjectManager } from '../../../../src/session/project-manager.js';
import type { WritingTrigger } from '../../../../src/writing/services/context.js';

export interface ProjectRouteDeps {
  manager: ProjectManager;
  /** 当前激活项目 id（= writingProjectId，可变：切换项目时改） */
  activeProjectId: { value: string };
  /** 切换激活项目（关旧 session 开新 session），由 bootstrap 提供 */
  switchActive: (nameOrId: string) => Promise<void>;
  makeCtx: (opts?: { pid?: string; trigger?: WritingTrigger }) => any;
}

export function registerProjectRoutes(app: FastifyInstance, deps: ProjectRouteDeps) {
  const { manager, activeProjectId, switchActive, makeCtx } = deps;

  // ---------- 列出全部项目（app.db 注册表 + 逐个取标题/文档数） ----------
  app.get('/api/projects', async () => {
    const records = manager.listProjects();
    // 逐个打开 session 取标题/文档数（项目数少，可接受）
    const projects = [];
    for (const r of records) {
      let title = r.name;
      let documentCount = 0;
      let status = 'planning';
      try {
        const session = await manager.openProject(r.name, { withVector: false, withAgent: false });
        const proj = session.writingStore.getProject(r.id);
        if (proj) { title = proj.title; status = proj.status; }
        documentCount = session.writingStore.listDocuments(r.id).length;
      } catch { /* 读不到用默认值 */ }
      projects.push({
        id: r.id,
        name: r.name,
        title,
        status,
        documentCount,
        createdAt: r.createdAt,
        updatedAt: r.lastOpenedAt,
      });
    }
    return { projects, activeId: activeProjectId.value };
  });

  // ---------- 取当前激活项目详情 ----------
  app.get('/api/projects/current', async (_req, reply) => {
    const id = activeProjectId.value;
    const r = manager.getProject(id);
    if (!r) return reply.code(404).send({ error: '当前激活项目不存在' });
    try {
      const session = await manager.openProject(r.name, { withVector: false, withAgent: false });
      const proj = session.writingStore.getProject(id);
      if (!proj) return reply.code(404).send({ error: '项目记录不存在' });
      return {
        id: proj.id, title: proj.title, premise: proj.premise ?? '',
        status: proj.status, version: proj.version,
        createdAt: proj.createdAt, updatedAt: proj.updatedAt,
      };
    } catch (err) {
      return reply.code(500).send({ error: String(err) });
    }
  });

  // ---------- 新建项目 ----------
  app.post('/api/projects', async (req, reply) => {
    const body = req.body as { title: string; premise?: string };
    if (!body.title?.trim()) return reply.code(400).send({ error: '项目名不能为空' });
    try {
      // 项目名（目录名）= 标题；createProject 建目录+装配+写 app.db
      const { record } = manager.createProject({
        name: body.title.trim(),
        title: body.title.trim(),
        premise: body.premise,
      });
      return { id: record.id, title: body.title.trim(), name: record.name };
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ---------- 切换激活项目 ----------
  app.post('/api/projects/:pid/activate', async (req, reply) => {
    const { pid } = req.params as { pid: string };
    // pid 可能是 writingProjectId 或项目名，都能被 manager 解析
    const r = manager.getProject(pid) ?? manager.getProjectByName(pid);
    if (!r) return reply.code(404).send({ error: '项目不存在' });
    await switchActive(r.name);
    return { activeId: activeProjectId.value };
  });

  // ---------- 改项目元信息（名/前提）----------
  app.patch('/api/projects/:pid', async (req, reply) => {
    const { pid } = req.params as { pid: string };
    const body = req.body as { title?: string; premise?: string };
    if (body.title === undefined && body.premise === undefined) {
      return reply.code(400).send({ error: '需至少指定 title 或 premise' });
    }
    const r = manager.getProject(pid);
    if (!r) return reply.code(404).send({ error: '项目不存在' });
    try {
      const session = await manager.openProject(r.name, { withVector: false, withAgent: false });
      const updated = session.projectService.updateProjectMeta(makeCtx({ pid }), {
        ...(body.title !== undefined ? { title: body.title.trim() } : {}),
        ...(body.premise !== undefined ? { premise: body.premise } : {}),
      });
      return {
        id: updated.id, title: updated.title, premise: updated.premise ?? '',
        status: updated.status, version: updated.version,
        createdAt: updated.createdAt, updatedAt: updated.updatedAt,
      };
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ---------- 软删项目（注销注册 + 关 session，不删文件）----------
  app.delete('/api/projects/:pid', async (req, reply) => {
    const { pid } = req.params as { pid: string };
    const r = manager.getProject(pid);
    if (!r) return reply.code(404).send({ error: '项目不存在' });
    manager.unregisterProject(pid);
    // 删的是当前激活项目 → 切到剩余的第一个（若有）
    if (activeProjectId.value === pid) {
      const remaining = manager.listProjects();
      activeProjectId.value = remaining[0]?.id ?? '';
    }
    return { ok: true, activeId: activeProjectId.value };
  });

  // ---------- 导出项目设定集为 Markdown ----------
  app.get('/api/projects/:pid/export', async (req, reply) => {
    const { pid } = req.params as { pid: string };
    const r = manager.getProject(pid);
    if (!r) return reply.code(404).send({ error: '项目不存在' });
    try {
      const session = await manager.openProject(r.name, { withVector: false, withAgent: false });
      const writingStore = session.writingStore;
      const project = writingStore.getProject(pid);
      if (!project) return reply.code(404).send({ error: '项目记录不存在' });
      const allDocs = writingStore.listDocuments(pid);

      // 按 parentId 组装树
      const byParent = new Map<string | null, typeof allDocs>();
      for (const d of allDocs) {
        const key = d.parentId;
        if (!byParent.has(key)) byParent.set(key, []);
        byParent.get(key)!.push(d);
      }

      const lines: string[] = [];
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

      const renderNode = (node: typeof allDocs[number], depth: number) => {
        const heading = '#'.repeat(Math.min(depth + 2, 6));
        lines.push(`${heading} ${node.title}`);
        lines.push('');
        if (node.kind === 'document' && node.content) {
          let text = node.content;
          if (text.trim().startsWith('{')) {
            try { text = extractTextFromTiptapJson(JSON.parse(text)); } catch { /* 用原文 */ }
          }
          text = text.replace(/<[^>]+>/g, '').trim();
          if (text) { lines.push(text); lines.push(''); }
        }
        const children = (byParent.get(node.id) ?? []).sort((a, b) => a.sortOrder - b.sortOrder);
        for (const c of children) renderNode(c, depth + 1);
      };

      const roots = (byParent.get(null) ?? []).sort((a, b) => a.sortOrder - b.sortOrder);
      for (const root of roots) renderNode(root, 1);

      const markdown = lines.join('\n');
      const filename = encodeURIComponent(`${project.title}-设定集.md`);
      reply.header('Content-Type', 'text/markdown; charset=utf-8');
      reply.header('Content-Disposition', `attachment; filename="${filename}"`);
      return markdown;
    } catch (err) {
      return reply.code(500).send({ error: String(err) });
    }
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

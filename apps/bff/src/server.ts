// =============================================================================
// NarrativeOS 起草工作台 BFF 入口（融合后版）
// =============================================================================
// 改造（存储融合阶段6）：bootstrap 改用 ProjectManager + ProjectSession，
// 不再用 drafting.db。激活项目 session 含完整 Core+写作+Agent 装配。
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { bootstrap } from './bootstrap.js';
import { registerProjectRoutes } from './routes/projects.js';
import { registerDocumentRoutes } from './routes/documents.js';

async function main() {
  const services = await bootstrap();
  const app = Fastify({ logger: true });

  await app.register(cors, {
    origin: ['http://localhost:5173', 'http://127.0.0.1:5173'],
    credentials: true,
  });

  // 健康检查
  app.get('/api/health', async () => ({
    ok: true,
    activeProjectId: services.activeProjectId.value,
  }));

  // 项目管理路由（从激活 session 取 service）
  registerProjectRoutes(app, {
    projectService: services.session.projectService,
    writingStore: services.session.writingStore,
    activeProjectId: services.activeProjectId,
    makeCtx: services.makeCtx,
  });

  // 文档 CRUD 路由
  registerDocumentRoutes(app, {
    documentService: services.session.documentService,
    makeCtx: services.makeCtx,
  });

  const port = Number(process.env.PORT ?? 8787);
  const host = process.env.HOST ?? '127.0.0.1';
  try {
    await app.listen({ port, host });
    console.log(`\n  🚀 NarrativeOS 起草工作台 BFF 已启动: http://${host}:${port}`);
    console.log(`  📂 当前激活项目: ${services.activeProjectId.value}`);
    console.log(`  💾 项目库: ${services.session.writingStore ? 'data/projects/<项目>/project.db（融合架构）' : '未装配'}\n`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();

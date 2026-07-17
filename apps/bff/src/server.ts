// =============================================================================
// NarrativeOS 起草工作台 BFF 入口（Fastify 单端口）
// =============================================================================
// dotenv 必须显式指定项目根的 .env——pnpm dev 时 BFF 子进程 CWD=apps/bff/，
// 而 .env 在项目根；dotenv/config 默认找 process.cwd()/.env 会找不到。
import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
config({ path: resolve(__dirname, '../../../.env') });

import Fastify from 'fastify';
import cors from '@fastify/cors';
import { bootstrap } from './bootstrap.js';
import { registerProjectRoutes } from './routes/projects.js';
import { registerDocumentRoutes } from './routes/documents.js';
import { registerAgentRoutes } from './routes/agent.js';
import { registerEntityRoutes } from './routes/entities.js';
import { registerGraphRoutes } from './routes/relations.js';
import { registerDecisionRoutes } from './routes/decisions.js';
import { registerChapterRoutes } from './routes/chapters.js';
import { registerProseRoutes } from './routes/prose.js';
import { registerIdeaRoutes } from './routes/ideas.js';
import { registerForeshadowingRoutes } from './routes/foreshadowings.js';
import { registerTimelineRoutes } from './routes/timelines.js';
import { createAgentSessionManager } from './agent-session-manager.js';

async function main() {
  const services = await bootstrap();
  const app = Fastify({ logger: true });

  await app.register(cors, {
    origin: ['http://localhost:5173', 'http://127.0.0.1:5173'],
    credentials: true,
  });

  app.get('/api/health', async () => ({ ok: true, activeProjectId: services.activeProjectId.value }));
  registerProjectRoutes(app, {
    manager: services.manager, activeProjectId: services.activeProjectId,
    switchActive: services.switchActive, makeCtx: services.makeCtx,
  });
  registerDocumentRoutes(app, {
    getDocumentService: () => services.getActiveSession().documentService,
    makeCtx: services.makeCtx,
  });

  // 实体（里程碑②只读 + 里程碑③写入/审核态机）
  registerEntityRoutes(app, {
    getEntityService: () => services.getActiveSession().entityService,
    getCoreBridge: () => services.getActiveSession().coreBridge,
    makeCtx: services.makeCtx,
  });
  // 待确认决策（里程碑③实体注册 + 里程碑④a关系提交确认）
  registerDecisionRoutes(app, {
    getWorkflowService: () => services.getActiveSession().workflowService,
    getRelationService: () => services.getActiveSession().relationService,
    getCoreBridge: () => services.getActiveSession().coreBridge,
    makeCtx: services.makeCtx,
  });
  registerGraphRoutes(app, {
    getGraphService: () => services.getActiveSession().graphService,
    getRelationService: () => services.getActiveSession().relationService,
    makeCtx: services.makeCtx,
  });

  // 章节规划（迭代 A1）——§14.2 写作层叙事组织，不写 Core
  registerChapterRoutes(app, {
    getChapterService: () => services.getActiveSession().chapterService,
    makeCtx: services.makeCtx,
  });

  // 正文文档（迭代 A2）——§13.8 块级正文，不写 Core
  registerProseRoutes(app, {
    getProseService: () => services.getActiveSession().proseService,
    makeCtx: services.makeCtx,
  });

  // 灵感卡片（迭代 B1）——§5.1 低约束收集区，不写 Core
  registerIdeaRoutes(app, {
    getIdeaService: () => services.getActiveSession().ideaService,
    makeCtx: services.makeCtx,
  });

  // 伏笔看板（迭代 C1）——§17 伏笔/暗示/回收，不写 Core
  registerForeshadowingRoutes(app, {
    getForeshadowingService: () => services.getActiveSession().foreshadowingService,
    makeCtx: services.makeCtx,
  });

  // 时间线（迭代 C2）——§15 双轨时间线只读视图，不写 Core
  registerTimelineRoutes(app, {
    getTimelineService: () => services.getActiveSession().timelineService,
    makeCtx: services.makeCtx,
  });

  // Agent SSE——Fastify 单端口，不 hijack + reply.raw.writeHead（参考 Active_1）
  // getAgent 懒加载兜底：每次请求时确保 agent 装配。
  // 防 tsx watch 热重载后会话缓存命中旧的无 agent session、或进程重启时序问题。
  const agentSessions = createAgentSessionManager();
  const ensureAgent = async () => {
    const session = services.getActiveSession();
    if (!session.agent) {
      console.log('[BFF] agent 未装配，懒加载 initAgent...');
      await session.initAgent();
    }
    return session.agent;
  };
  // 启动时预装配一次（避免首请求慢）
  await ensureAgent();
  registerAgentRoutes(app, {
    getAgent: () => services.getActiveSession().agent,
    ensureAgent,
    agentSessions,
  });

  const port = Number(process.env.PORT ?? 8787);
  const host = process.env.HOST ?? '127.0.0.1';
  try {
    await app.listen({ port, host });
    console.log(`\n  🚀 NarrativeOS BFF 已启动: http://${host}:${port}\n`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();

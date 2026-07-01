// =============================================================================
// NarrativeOS — Phase 7 写作层 CLI
// =============================================================================
// 用法：npm run cli
// 完整写作层闭环：项目 → 灵感 → 蓝图 → 草案 → 实体 → 推演 → 确认 → 提交
//
// 命令：
//   /help     — 帮助
//   /state    — 写作层状态（项目/草案/候选实体/待确认/蓝图）
//   /history  — Agent trace 摘要
//   /auto     — 切换自动确认模式
//   /manual   — 切换手动确认模式
//   /quit     — 退出
// =============================================================================

import * as readline from 'readline';
import Database from 'better-sqlite3';
import { config } from 'dotenv';
import { mkdirSync, existsSync } from 'fs';
import { join } from 'path';
// /review 渲染所需类型——静态 import type 编译期擦除，不引入运行时模块加载（与下方动态 import 共存）
import type { WritingProposalView } from '../writing/models/types.js';
// CLI 命令层（Phase 7 补齐）——handlers 纯函数 + 解析器，静态 import（无副作用）
import {
  parseCommand, type ParsedCommand,
} from './parse-args.js';
import {
  handleWorld, handleEntity, handleDrafts, handleEntities, handleIdeas,
  handleBlueprint, handleProject, handleGoals, handlePending, handleAudit,
  handleIdeaAdd, handleIdeaDiscard, handleGoalAdd, handleDraftAdd, handleDraftAbandon,
  handleEntityDeprecate, handleBlueprintGenerate, handleBlueprintAccept,
  handleBlueprintAcceptSuggestion, handleBlueprintRejectSuggestion,
  handleBlueprintAddSpatialType,
  handleChapter, handleScene, handleTimeline,
  handleGraph, handleRelation, handleAssociation,
  handleSpatial, handleMap,
  type CliDeps,
} from './command-handlers.js';
// 项目选择器（每项目独立 db 文件）
import { selectProject } from './project-selector.js';

config({ quiet: true }); // quiet 抑制 dotenvx 的推广提示（"// tip: ..."广告）

// ---- 主入口：项目选择 → 数据库派生 → 组件实例化 → REPL ----
// 重构为 async main：项目选择（readline 交互）必须在 DB_PATH 确定前执行，
// 而顶层 await 脚本无法在 const 之前插入交互，故包进 async 函数。
async function main(): Promise<void> {
console.log('═'.repeat(56));
console.log('  📖 NarrativeOS · Phase 7 写作层 CLI');
console.log('═'.repeat(56));

// 1. 项目选择（交互式菜单 + 记住上次 + 旧库迁移）
const selected = await selectProject('./data');
const DATA_DIR = selected.dir;
const DB_PATH = join(DATA_DIR, 'cli.db');
const LANCEDB_DIR = join(DATA_DIR, 'lancedb');

console.log(`  📂 项目: ${selected.name}`);
console.log(`  💾 数据库: ${DB_PATH}`);
console.log('  输入 /help 查看命令  |  /quit 退出');
console.log('─'.repeat(56));

// 2. 确保目录存在
mkdirSync(LANCEDB_DIR, { recursive: true });

// 动态导入
const { SQLiteFactStoreAdapter } = await import('../adapters/sqlite/fact-store.js');
const { SQLiteKnowledgeStoreAdapter } = await import('../adapters/sqlite/knowledge-store.js');
const { SQLiteEventStoreAdapter } = await import('../adapters/sqlite/event-store.js');
const { SQLiteThreadStoreAdapter } = await import('../adapters/sqlite/thread-store.js');
const { SQLiteAgentStoreAdapter } = await import('../adapters/sqlite/agent-store.js');
const { SQLiteWritingStore } = await import('../writing/repositories/writing-store.js');
const { DeepSeekLLMClientAdapter } = await import('../adapters/llm/deepseek-client.js');
const { ProposalManager } = await import('../core/proposal-manager.js');
const { RuleEngine } = await import('../core/rule-engine.js');
const { ThreadResolver } = await import('../core/thread-resolver.js');
const { ToolService } = await import('../core/tool-service.js');
const { SchemaExtensionManager } = await import('../core/schema-extension-manager.js');
const { ToolRouter } = await import('../core/tool-router.js');
const { RetconEngine } = await import('../core/retcon-engine.js');
const { NarrativeAgent } = await import('../agent/narrative-agent.js');
const { RealCoreBridge } = await import('../writing/core-bridge/real-bridge.js');
const { AuditService } = await import('../writing/services/audit-service.js');
const { ProjectService } = await import('../writing/services/project-service.js');
const { IdeaService } = await import('../writing/services/idea-service.js');
const { BlueprintService } = await import('../writing/services/blueprint-service.js');
const { DraftService } = await import('../writing/services/draft-service.js');
const { EntityService } = await import('../writing/services/entity-service.js');
const { WorkflowService } = await import('../writing/services/workflow-service.js');
const { makeRequestContext } = await import('../writing/services/context.js');
// W11：错误模型渲染——写作层抛出的 WritingError / StateMachineError 经 ERROR_RECOVERY_MAP
// 映射为作者可读文案（CLI 异常通道的唯一消费点）
const { renderErrorForAuthor } = await import('../writing/errors/error-codes.js');
// 向量检索管线（Push 语义注入 + LanceDB 同步）——Phase 7 闭环基础设施
const { LanceDBTableAdapter } = await import('../adapters/lancedb/table-adapter.js');
const { SiliconFlowEmbeddingService } = await import('../adapters/embedding/siliconflow-embedder.js');
const { RelevantFactRetriever } = await import('../core/relevant-fact-retriever.js');
const { FactRenderer } = await import('../core/fact-renderer.js');
const { SyncQueueConsumer } = await import('../core/sync-queue-consumer.js');

// ---- 初始化 ----
process.stdout.write('🔧 初始化 Core + WritingLayer...');

// Core projectId 用项目名（每项目独立 db 文件后，状态版本在该文件内天然隔离；
// 此处传真实值让 Core 层不再依赖硬编码 'default'，双保险）
const CORE_PROJECT_ID = selected.name;
const factStore = new SQLiteFactStoreAdapter(DB_PATH, CORE_PROJECT_ID);
const db = factStore.getDatabase();
const knowledgeStore = new SQLiteKnowledgeStoreAdapter(db);
const eventStore = new SQLiteEventStoreAdapter(db);
const threadStore = new SQLiteThreadStoreAdapter(db);

const threadResolver = new ThreadResolver();
const ruleEngine = new RuleEngine();
const proposalManager = new ProposalManager(ruleEngine, undefined, threadStore, threadResolver);
const retconEngine = new RetconEngine();
const toolService = new ToolService(factStore, knowledgeStore, eventStore, threadStore, threadResolver);
const schemaExtensionManager = new SchemaExtensionManager(db, CORE_PROJECT_ID);

const toolRouter = new ToolRouter({
  proposalManager, retconEngine, toolService,
  schemaExtensionManager, factStore, knowledgeStore, eventStore, threadStore,
});

// 写作层
const writingStore = new SQLiteWritingStore(db);
writingStore.createTables();

const auditService = new AuditService(writingStore);
const workflowService = new WorkflowService(writingStore, auditService);
// RealCoreBridge 注入 auditService：commit/register 内部落地审计（§7.7 4d/5b），
// 保证「任何调用方提交都被审计」，而非依赖调用方各自记录。
const coreBridge = new RealCoreBridge(toolRouter, writingStore, auditService);

// W5 启动对账（§7.11.5 两阶段提交恢复）：修复"Core 已提交/注册但写作层状态未同步"的孤儿对象。
// commit/register 回写整体失败（partial）时，对象停在提交前状态而 Core 已持久化对应 event/entity，
// 启动时据审计日志回写恢复。无孤儿时为 no-op。
const reconcileResult = coreBridge.reconcile();
const recoveredProposals = reconcileResult.proposals.recovered.length;
const recoveredEntities = reconcileResult.entities.recovered.length;
if (recoveredProposals > 0 || recoveredEntities > 0) {
  console.log(
    `  🔧 启动对账恢复：${recoveredProposals} 个提案、${recoveredEntities} 个实体已从孤儿态恢复`,
  );
}

const projectService = new ProjectService(writingStore, auditService);
const draftService = new DraftService(writingStore, auditService, coreBridge, workflowService);
const entityService = new EntityService(writingStore, auditService, workflowService);
const blueprintService = new BlueprintService(writingStore, auditService);
const ideaServiceInitial = new IdeaService(writingStore, auditService);

// 查找已有项目或创建新项目（新建走 ProjectService 组合初始化：建蓝图+灵感+布局+偏好容器）
let existingProject = writingStore.listProjects()[0];
let writingProjectId: string;

if (existingProject) {
  writingProjectId = existingProject.id;
  console.log(`\n  📂 写作层项目: ${existingProject.title} (${existingProject.id})`);
} else {
  // 新 db 文件首次加载：用项目名建项目（走 ProjectService 完整初始化）
  // 注：此处 ctx 用临时 sessionId（agent 尚未创建），仅用于 createProject 的审计记录
  const bootstrapCtx = makeRequestContext({
    projectId: 'pending', // createProject 内部会用新 id，此处占位
    sessionId: `bootstrap-${Date.now()}`,
    trigger: 'author_action',
  });
  const created = projectService.createProject(bootstrapCtx, {
    title: selected.name,
    premise: '',
  });
  writingProjectId = created.id;
  console.log(`\n  🆕 写作层项目已创建: ${created.title} (${created.id})`);
}

// 重新创建 IdeaService（需要 draftService，存在循环依赖）
const ideaService = new IdeaService(writingStore, auditService, draftService.createDraft.bind(draftService));

// Phase 8：关系与图谱服务
const { RelationService } = await import('../writing/services/relation-service.js');
const { GraphService } = await import('../writing/services/graph-service.js');
const relationService = new RelationService(writingStore, auditService, workflowService, coreBridge);
const graphService = new GraphService(writingStore, coreBridge);

// Phase 9：空间服务
const { SpatialService } = await import('../writing/services/spatial-service.js');
const { SpatialViewService } = await import('../writing/services/spatial-view-service.js');
const spatialService = new SpatialService(writingStore, auditService, workflowService, coreBridge);
const spatialViewService = new SpatialViewService(writingStore);

// Phase 10：章节/场景/时间线服务
const { ChapterService } = await import('../writing/services/chapter-service.js');
const { SceneService } = await import('../writing/services/scene-service.js');
const { TimelineService } = await import('../writing/services/timeline-service.js');
const chapterService = new ChapterService(writingStore, auditService);
const sceneService = new SceneService(writingStore, auditService);
const timelineService = new TimelineService(writingStore);

// Phase 11：读者/伏笔服务
const { ReaderService } = await import('../writing/services/reader-service.js');
const { ForeshadowingService } = await import('../writing/services/foreshadowing-service.js');
const readerService = new ReaderService(writingStore, auditService);
const foreshadowingService = new ForeshadowingService(writingStore, auditService);

// 延迟注入实体检测服务到 ToolRouter（detect_entity_hints 工具需要；entityService/writingProjectId 此时就绪）
toolRouter.setEntityService(entityService, writingProjectId);
toolRouter.setGraphServices(relationService, graphService, writingProjectId);
toolRouter.setSpatialServices(spatialService, spatialViewService, writingProjectId);
toolRouter.setChapterSceneServices(chapterService, sceneService, timelineService, writingProjectId);
toolRouter.setReaderForeshadowingServices(readerService, foreshadowingService, writingProjectId);

// Agent
const llm = new DeepSeekLLMClientAdapter();
const agentStore = new SQLiteAgentStoreAdapter(db);
agentStore.createTables();

// ---- 向量检索管线（Phase 7 闭环基础设施）----
// 此前 CLI 未接入这两条线，导致两个核心问题：
//   1. SyncQueueConsumer 从未创建 → 提交事件的 Fact 只写 SQLite+sync_queue，永远不同步到 LanceDB
//   2. NarrativeAgent 未注入 retriever/renderer → narrative-agent.ts:498 的 Push 注入守卫永远跳过，
//      Agent 的 ReAct 循环拿不到语义召回的相关 Fact（NarrativeOS 的核心能力在 CLI 场景缺失）
// 接线方式参考 tests/integration/push-mode-validation.test.ts:64-77。
// 向量库路径：每项目独立（LANCEDB_DIR 已在 main 开头从 selected.dir 派生）
if (!existsSync(LANCEDB_DIR)) mkdirSync(LANCEDB_DIR, { recursive: true });
// 向量栈可选初始化：init 失败（目录不可写、原生绑定缺失、磁盘满）时降级为 undefined，
// Agent 的 push 守卫（narrative-agent.ts `if (this.retriever && this.renderer)`）会跳过语义召回，
// 确定性查询（/world /entity 走 SQLite）不受影响。此前 init() 裸调会硬崩。
let vectorStore: InstanceType<typeof LanceDBTableAdapter> | undefined;
let retriever: InstanceType<typeof RelevantFactRetriever> | undefined;
let renderer: InstanceType<typeof FactRenderer> | undefined;
let consumer: InstanceType<typeof SyncQueueConsumer> | undefined;
try {
  vectorStore = new LanceDBTableAdapter(LANCEDB_DIR, 'facts');
  await vectorStore.init();
  const embedder = new SiliconFlowEmbeddingService();
  retriever = new RelevantFactRetriever(factStore, knowledgeStore, threadStore, vectorStore, embedder);
  renderer = new FactRenderer();
  consumer = new SyncQueueConsumer(db, vectorStore, embedder);
} catch (err) {
  console.warn(`  ⚠️ 向量检索初始化失败，语义召回不可用（确定性查询照常）：${err instanceof Error ? err.message : err}`);
}

const agent = new NarrativeAgent({
  llm, toolRouter, agentStore,
  projectId: CORE_PROJECT_ID, // Core projectId = 项目名（消除 'default' 硬编码）
  // P0-2 修复：wall-clock 用默认 30 分钟，且已改为"单回合"计时
  // （见 narrative-agent.startNewTurn 每轮重置 sessionStartTime），避免长 CLI 会话误触发 suspended
  limits: { maxToolSteps: 32, maxRepeatedToolFailure: 3, maxWallClockMs: 30 * 60 * 1000 },
  // Phase 7 注入
  writingProjectId,
  writingStore, auditService, workflowService,
  draftService, entityService,
  coreBridge,
  // W2：§8.5.5 聚合容器缺的 3 个服务（上方已实例化），注入后 Agent 可组装 writingLayer，
  // 启用写作层状态注入（assembleWritingContext）+ 题材蓝图感知（buildSystemPrompt 蓝图段）。
  projectService, blueprintService, ideaService,
  // Push 语义检索管线：注入后 agent 每轮 Reason 前主动召回相关 Fact 注入上下文（narrative-agent.ts:498）
  retriever, renderer,
});

agent.startSession('Phase 7 CLI 会话');

// 后台驱动 sync_queue consumer：每 5s 将新提交的 Fact 同步到 LanceDB。
// processPending 是幂等的原子抢占（UPDATE...RETURNING，sync-queue-consumer.ts:72），无 pending 时空转，
// 因此定时器 + 启动清积压并发安全。embedding 失败时 consumer 自动退避重试，不阻塞用户交互；
// 即便未配置 embedding API key，也只是语义检索不工作，确定性查询（/entity、/world 走 SQLite）照常。
const syncTimer = setInterval(() => {
  if (consumer) {
    consumer.processPending().catch((err: unknown) => console.error(`[SyncQueue] 同步失败: ${String(err).slice(0, 120)}`));
  }
}, 5000);
// 启动时立即清一次积压（fire-and-forget，不阻塞就绪）——消费历史提交但未同步的 Fact
if (consumer) {
  consumer.processPending().catch((err: unknown) => console.error(`[SyncQueue] 启动清积压失败: ${String(err).slice(0, 120)}`));
}

console.log(' 就绪 ✅\n');

// ---- ctx 工厂 ----
const ctx = () => makeRequestContext({
  projectId: writingProjectId,
  sessionId: agent.getState().sessionId,
  trigger: 'author_action',
});

// ---- CLI 依赖注入容器（Phase 7 命令层 handlers）----
// 把模块级 services 装配成 CliDeps，传给 command-handlers 的纯函数。
// handlers 不直接访问模块级单例——经此容器注入，便于单元测试。
const cliDeps: CliDeps = {
  projectId: writingProjectId,
  ctx: (visibilityMode) => makeRequestContext({
    projectId: writingProjectId,
    sessionId: agent.getState().sessionId,
    trigger: 'author_action',
    visibilityMode,
  }),
  projectService: projectService as unknown as CliDeps['projectService'],
  draftService: draftService as unknown as CliDeps['draftService'],
  entityService: entityService as unknown as CliDeps['entityService'],
  ideaService: ideaService as unknown as CliDeps['ideaService'],
  blueprintService: blueprintService as unknown as CliDeps['blueprintService'],
  workflowService: workflowService as unknown as CliDeps['workflowService'],
  auditService: auditService as unknown as CliDeps['auditService'],
  coreBridge,
  writingStore,
  // Phase 8（用 unknown 注入——CliDeps 接口未声明这俩字段，handler 用类型擦除访问）
  relationService, graphService,
  // Phase 9：空间服务
  spatialService, spatialViewService,
} as CliDeps & { relationService: unknown; graphService: unknown; spatialService: unknown; spatialViewService: unknown };

/** 把 handler 返回的输出行打印出来（统一 IO） */
function printLines(lines: string[]): void {
  for (const ln of lines) console.log(ln);
  console.log('');
}

// ---- 命令处理 ----
async function handleCommand(input: string): Promise<boolean> {
  const cmd = input.trim();
  const parsed = parseCommand(cmd);

  // /review 族命令带参数，先于精确匹配的 switch 拦截解析
  if (cmd === '/review' || cmd.startsWith('/review ')) {
    return handleReview(cmd);
  }

  // ---- Phase 7 新增命令（command-handlers.ts）----
  // 带 flag/参数的命令必须在此分发（switch 精确匹配处理不了 '/drafts --status x'）
  switch (parsed.name) {
    case '/world': printLines(await handleWorld(cliDeps, parsed)); return false;
    case '/entity': printLines(await handleEntity(cliDeps, parsed)); return false;
    case '/drafts': printLines(handleDrafts(cliDeps, parsed)); return false;
    case '/entities': printLines(handleEntities(cliDeps, parsed)); return false;
    case '/ideas': printLines(handleIdeas(cliDeps, parsed)); return false;
    // /blueprint 移到下方子命令区（支持 generate/accept 等子命令）
    case '/project': printLines(handleProject(cliDeps, parsed)); return false;
    case '/goals': printLines(handleGoals(cliDeps, parsed)); return false;
    case '/pending': printLines(handlePending(cliDeps, parsed)); return false;
    case '/audit': printLines(handleAudit(cliDeps, parsed)); return false;
    // ---- 创建/操作子命令（补齐写作层对象操作入口）----
    case '/idea': {
      const sub = parsed.positional[0];
      if (sub === 'add') { printLines(handleIdeaAdd(cliDeps, { ...parsed, positional: parsed.positional.slice(1) })); return false; }
      if (sub === 'discard') { printLines(handleIdeaDiscard(cliDeps, { ...parsed, positional: parsed.positional.slice(1) })); return false; }
      console.log(`  \x1b[33m用法：/idea add <内容> | /idea discard <id>\x1b[0m\n`);
      return false;
    }
    case '/goal': {
      const sub = parsed.positional[0];
      if (sub === 'add') { printLines(handleGoalAdd(cliDeps, { ...parsed, positional: parsed.positional.slice(1) })); return false; }
      console.log(`  \x1b[33m用法：/goal add <内容> [--kind goal|avoid|style] [--priority high|normal|low]\x1b[0m\n`);
      return false;
    }
    case '/draft': {
      const sub = parsed.positional[0];
      if (sub === 'add') { printLines(handleDraftAdd(cliDeps, { ...parsed, positional: parsed.positional.slice(1) })); return false; }
      if (sub === 'abandon') { printLines(handleDraftAbandon(cliDeps, { ...parsed, positional: parsed.positional.slice(1) })); return false; }
      console.log(`  \x1b[33m用法：/draft add <标题> | /draft abandon <id>\x1b[0m\n`);
      return false;
    }
    case '/blueprint': {
      // /blueprint 子命令分发（generate/accept/accept-suggestion/reject-suggestion/add-spatial-type/查看）
      const sub = parsed.positional[0];
      if (sub === 'generate') { printLines(handleBlueprintGenerate(cliDeps, { ...parsed, positional: parsed.positional.slice(1) })); return false; }
      if (sub === 'accept') { printLines(handleBlueprintAccept(cliDeps, { ...parsed, positional: parsed.positional.slice(1) })); return false; }
      if (sub === 'accept-suggestion') { printLines(handleBlueprintAcceptSuggestion(cliDeps, { ...parsed, positional: parsed.positional.slice(1) })); return false; }
      if (sub === 'reject-suggestion') { printLines(handleBlueprintRejectSuggestion(cliDeps, { ...parsed, positional: parsed.positional.slice(1) })); return false; }
      if (sub === 'add-spatial-type') { printLines(handleBlueprintAddSpatialType(cliDeps, { ...parsed, positional: parsed.positional.slice(1) })); return false; }
      // 无子命令 → 走查看
      printLines(handleBlueprint(cliDeps, parsed)); return false;
    }
    // Phase 8：关系与图谱命令
    case '/graph': printLines(await handleGraph(cliDeps, parsed)); return false;
    case '/relation': printLines(await handleRelation(cliDeps, parsed)); return false;
    case '/association': printLines(handleAssociation(cliDeps, parsed)); return false;
    // Phase 9：空间命令
    case '/spatial': printLines(await handleSpatial(cliDeps, parsed)); return false;
    case '/map': printLines(await handleMap(cliDeps, parsed)); return false;
    // Phase 10：章节/场景/时间线命令
    case '/chapter': printLines(await handleChapter(cliDeps, parsed)); return false;
    case '/scene': printLines(await handleScene(cliDeps, parsed)); return false;
    case '/timeline': printLines(await handleTimeline(cliDeps, parsed)); return false;
  }

  switch (cmd) {
    case '/help':
      console.log(`
  \x1b[1;36m📋 命令清单（Phase 7）\x1b[0m

  \x1b[1;33m审核\x1b[0m
    /pending               待确认事项清单
    /review [pvId]         审核提案视图（factDiff/警告/详情）
    /review resim <pvId>   用最新世界状态重推

  \x1b[1;33m浏览\x1b[0m
    /world                 世界概览（已注册实体 + 最近事件）
    /entity <名称>         单实体档案（例：/entity 沈墨）
    /entities [--status S] 实体草图列表（--raw 显示 Core id）
    /drafts [--status S]   草案列表
    /ideas [--kind K]      灵感卡列表
    /blueprint             当前蓝图查看

  \x1b[1;33m创建/操作\x1b[0m
    /idea add <内容> [--kind K] [--tag T]   捕获灵感
    /idea discard <id>                      归档灵感
    /goal add <内容> [--kind K] [--priority P]   添加写作目标
    /draft add <标题> [--kind K] [--chapter N]   创建草案
    /draft abandon <id>                     废弃草案
    /entity promote <id>                    hint→候选
    /entity approve <id>                    候选→批准（注册到 Core）
    /entity deprecate <id> [--reason R]     废弃实体
    /blueprint generate <描述>              生成蓝图草案
    /blueprint accept <id>                  激活蓝图
    /blueprint accept-suggestion <id>       接受蓝图变更建议
    /blueprint reject-suggestion <id>       拒绝蓝图变更建议

  \x1b[1;33m管理\x1b[0m
    /project [set <字段> <值>]   项目元信息（标题/前提/状态/模式）
    /goals [--status S]    作者目标
    /audit [--limit N] [--result R]   审计日志

  \x1b[1;33m空间\x1b[0m
    /map                   地图概览（空间节点+边）
    /spatial               空间节点/边列表
    /spatial add-node <名> <类型> [描述]   添加空间节点
    /spatial add-edge <源> <目标> <类型>   添加空间边
    /spatial confirm-edge <id>             确认空间边

  \x1b[1;33m章节/场景\x1b[0m
    /chapter list               章节规划列表
    /chapter add <标题> [--order N]  创建章节规划
    /scene list [--chapter <id>]     场景规划列表
    /scene add <chapterId> <标题> [--order N]  创建场景规划
    /timeline                   时间线视图

  \x1b[1;33m系统\x1b[0m
    /state                 总览面板（计数 + 导航）
    /history               Agent trace 摘要
    /auto /manual          自动/手动确认模式
    /quit                  退出

  \x1b[1;36m通用 flag\x1b[0m：--limit N（默认 20，/audit 30）| --raw（显示技术字段）| --status S
  \x1b[1;36m确认/修改\x1b[0m：自然语言输入"确认"/"提交"/"取消"/"修改"
`);
      return false;

    case '/state': {
      const c = ctx();
      const project = writingStore.getProject(writingProjectId);
      const drafts = writingStore.listDrafts(writingProjectId);
      const sketches = writingStore.listEntitySketches(writingProjectId);
      const decisions = workflowService.listPendingDecisions(c);
      const proposalViews = writingStore.listProposalViews(writingProjectId);
      // 用 getLatestBlueprint（含 implicit 种子）而非 getActiveBlueprint，与 /blueprint 一致
      const bp = writingStore.getLatestBlueprint(writingProjectId) as { maturity: string; entityTypes: unknown[] } | undefined;
      // 灵感计数过滤 archived（与 /ideas 一致，归档的不计入活跃计数）
      const ideas = writingStore.listIdeaCards(writingProjectId).filter(i => i.maturity !== 'archived');
      const goals = writingStore.listGoals(writingProjectId);

      console.log(`\n  \x1b[1;33m📋 写作层状态\x1b[0m`);
      console.log(`  项目:      ${project?.title ?? 'N/A'} [${project?.status ?? 'N/A'}]`);
      console.log(`  工作模式:  ${project?.workspaceMode ?? 'N/A'}`);
      console.log(`  蓝图:      ${bp ? `${bp.maturity} (${bp.entityTypes.length} 类型)` : '无'}`);
      console.log(`  灵感:      ${ideas.length} 条`);
      console.log(`  草案:      ${drafts.length} 个`);
      console.log(`  候选实体:  ${sketches.filter(s => s.status === 'candidate' || s.status === 'hint').length} 个`);
      console.log(`  已注册实体: ${sketches.filter(s => s.status === 'registered').length} 个`);
      console.log(`  待确认:    ${decisions.length} 项`);
      console.log(`  审核视图:  ${proposalViews.length} 个`);
      if (goals.length > 0) {
        console.log(`  目标:      ${goals.length} 条`);
        for (const g of goals) console.log(`    - [${g.kind}] ${g.text}`);
      }
      if (decisions.length > 0) {
        console.log(`\n  \x1b[1;33m⏳ 待确认事项：\x1b[0m`);
        for (const d of decisions) {
          console.log(`    [${d.kind}] ${d.title}`);
        }
      }

      // Agent 状态
      const agentState = agent.getState();
      console.log(`\n  \x1b[1;33m🤖 Agent 状态\x1b[0m`);
      console.log(`  状态:       ${agentState.status}`);
      console.log(`  消息数:     ${agentState.messages.length}`);
      console.log(`  提交模式:   ${agentState.commitAuthority}`);
      if (agentState.workingDraft) {
        console.log(`  草案:       ${agentState.workingDraft.summary} [${agentState.workingDraft.status}]`);
      }
      if (agentState.pendingProposalIds.length > 0) {
        console.log(`  待提交:     ${agentState.pendingProposalIds.length} 个提案`);
      }
      console.log(`\n  \x1b[90m导航：/drafts /entities /ideas /goals /pending /world /audit 查看详情\x1b[0m`);
      console.log('');
      return false;
    }

    case '/history': {
      const state = agent.getState();
      const traces = state.traceBuffer;
      if (traces.length === 0) {
        console.log('  \x1b[90m暂无 trace 记录\x1b[0m\n');
        return false;
      }
      console.log(`\n  \x1b[1;33m📜 Trace（最近 ${Math.min(traces.length, 20)} 条）\x1b[0m`);
      for (const t of traces.slice(-20)) {
        const icon = t.status === 'ok' ? '✅' : t.status === 'error' ? '❌' : '⚠️';
        console.log(`  ${icon} [${t.stepType}] ${t.summary}`);
        if (t.toolName) console.log(`      工具: ${t.toolName}`);
        if (t.errorCode) console.log(`      错误: ${t.errorCode}`);
      }
      // token 用量汇总（从 llm_call 类型的 trace 累加）
      const llmTraces = traces.filter(t => t.stepType === 'llm_call' && t.usage);
      if (llmTraces.length > 0) {
        const totalPrompt = llmTraces.reduce((sum, t) => sum + (t.usage!.prompt_tokens), 0);
        const totalCompletion = llmTraces.reduce((sum, t) => sum + (t.usage!.completion_tokens), 0);
        const totalCache = llmTraces.reduce((sum, t) => sum + (t.usage!.prompt_cache_hit_tokens ?? 0), 0);
        console.log(`\n  \x1b[1;36m💰 Token 用量（${llmTraces.length} 次调用）\x1b[0m`);
        console.log(`  Prompt: ${totalPrompt} | Completion: ${totalCompletion} | 总计: ${totalPrompt + totalCompletion}`);
        if (totalCache > 0) console.log(`  缓存命中: ${totalCache}（节省成本）`);
      }
      console.log('');
      return false;
    }

    case '/auto':
      // 真正切换：下一轮输入以 agent_authorized_for_session 提交（仅生效一次）
      lastAutoToggle = true;
      console.log('  ✅ 自动确认模式（下一次输入生效一次）\n');
      return false;

    case '/manual':
      lastAutoToggle = false;
      console.log('  ✅ 手动确认模式\n');
      return false;

    case '/quit':
      console.log('\n  再见！👋\n');
      agent.closeSession();
      return true;

    default:
      // 未知命令友好提示（此前静默 return false，作者易困惑）
      if (cmd.startsWith('/')) {
        console.log(`  \x1b[33m未知命令：${cmd.split(/\s+/)[0]}\x1b[0m`);
        console.log('  \x1b[90m输入 /help 查看完整命令清单\x1b[0m\n');
      }
      return false;
  }
}

// ---- /review 命令：渲染 ProposalView 详情（task #9）----
// W13-b 把 Agent 的 propose_event 物化为可审核 PV 后，作者经此命令查看 factDiff / ruleWarnings /
// humanSummary，而非盲确认裸 proposalId。实体名经 sketch 映射解析（normal 模式不裸露 ent_ id，§9.1）。
async function handleReview(cmd: string): Promise<boolean> {
  const tokens = cmd.split(/\s+/).filter(Boolean); // tokens[0] === '/review'
  const sub = tokens[1];
  const target = tokens[2];

  // 实体名解析映射：coreEntityId → displayName。
  // 仅用于「涉及实体」列表的显示解析——factDiff.entityName 已由 buildProposalReviewData 解析，无需再处理。
  const sketches = writingStore.listEntitySketches(writingProjectId);
  const nameMap = new Map<string, string>();
  for (const s of sketches) {
    if (s.coreEntityId && s.displayName) nameMap.set(s.coreEntityId, s.displayName);
  }
  const resolveName = (id: string): string => nameMap.get(id) ?? '(未命名实体)';

  const warningIcon = (level: string): string =>
    level === 'blocker' ? '🔴' : level === 'warning' ? '🟡' : '🔵';

  // ---- /review resim <pvId>：用最新世界状态重推 ----
  if (sub === 'resim') {
    if (!target) {
      console.log('  \x1b[33m用法：/review resim <pvId>\x1b[0m\n');
      return false;
    }
    try {
      const sim = await coreBridge.simulateProposal(writingProjectId, target);
      console.log(`\n  \x1b[1;33m🔄 重新推演 ${target}\x1b[0m`);
      console.log(`  结论: ${sim.isSafeToCommit ? '✅ 安全可提交' : '⚠️ 发现警告'}`);
      if (sim.consequenceThreads.length > 0) {
        console.log(`  后果线索（${sim.consequenceThreads.length}）：`);
        for (const t of sim.consequenceThreads) {
          console.log(`    [${t.severity}] ${t.type || '(无类型)'} — ${t.description || '(无描述)'}`);
        }
      }
      if (sim.consequenceWarnings.length > 0) {
        console.log('  警告：');
        for (const w of sim.consequenceWarnings) console.log(`    - ${w}`);
      }
      // P1-2 修复后桥接层已回写（real-bridge.ts:152-180）：重推产生新 proposalId 时，
      // 同时重投影 factDiff/ruleWarnings/humanSummary 一并回写 PV，保持一致。
      // 若 PV 原 author_approved，重置为 open 要求重新审核（内容已变）。
      console.log('  \x1b[90m注：重推已更新审核视图（新 proposalId + 新 factDiff）。若之前已批准，需重新确认。\x1b[0m\n');
    } catch (err) {
      console.error(`\n  \x1b[31m❌ 重推失败：${renderErrorForAuthor(err)}\x1b[0m\n`);
    }
    return false;
  }

  // ---- /review <pvId>：单条详情 ----
  if (sub) {
    const pv = writingStore.getProposalView(sub);
    if (!pv) {
      console.log(`  \x1b[33m找不到审核视图：${sub}\x1b[0m\n`);
      return false;
    }
    renderProposalViewDetail(pv, resolveName, warningIcon);
    return false;
  }

  // ---- /review：列出所有待审核 PV ----
  const all = writingStore.listProposalViews(writingProjectId);
  const open = all.filter((p) => p.status === 'open' || p.status === 'author_approved');
  console.log(`\n  \x1b[1;33m🔍 审核视图（待审核 ${open.length} / 共 ${all.length}）\x1b[0m`);
  if (open.length === 0) {
    console.log('  \x1b[90m暂无待审核提案。先用自然语言描述一个事件，Agent 会产出可审核提案。\x1b[0m\n');
    return false;
  }
  for (const p of open) {
    const blockers = (p.ruleWarnings ?? []).filter((w) => w.level === 'blocker').length;
    const warns = (p.ruleWarnings ?? []).filter((w) => w.level === 'warning').length;
    const warnLabel =
      blockers === 0 && warns === 0 ? '无' : `${blockers > 0 ? `🔴×${blockers} ` : ''}${warns > 0 ? `🟡×${warns}` : ''}`.trim();
    console.log(`    [${p.status}] \x1b[1m${p.id}\x1b[0m`);
    console.log(`        ${p.humanSummary ?? '(无摘要)'}`);
    console.log(`        factDiff: ${(p.factDiff ?? []).length} 条 | 警告: ${warnLabel}`);
  }
  console.log('  \x1b[90m用 /review <pvId> 查看详情，/review resim <pvId> 重推\x1b[0m\n');
  return false;
}

/** 渲染单个 ProposalView 的完整详情（factDiff / ruleWarnings / 涉及实体 / 推演输入） */
function renderProposalViewDetail(
  pv: WritingProposalView,
  resolveName: (id: string) => string,
  warningIcon: (level: string) => string,
): void {
  const opTag = (op: string): string =>
    op === 'new' ? '[新增]' : op === 'updated' ? '[更新]' : op === 'retracted' ? '[撤销]' : `[${op}]`;

  console.log(`\n  \x1b[1;33m📝 审核视图详情  ${pv.id}\x1b[0m`);
  console.log(`  状态: ${pv.status} | 类型: ${pv.proposalType}${pv.coreProposalId ? ` | proposalId: ${pv.coreProposalId}` : ''}`);
  console.log(`  摘要: ${pv.humanSummary ?? '(无摘要)'}`);

  const diffs = pv.factDiff ?? [];
  if (diffs.length > 0) {
    console.log(`\n  \x1b[1;36m📋 事实变更（${diffs.length} 条）\x1b[0m`);
    for (const d of diffs) {
      console.log(`    ${opTag(d.op)} \x1b[1m${d.entityName}\x1b[0m · ${d.predicateLabel}`);
      console.log(`        新值: ${d.newValue}`);
      if (d.oldValue !== undefined) console.log(`        旧值: ${d.oldValue}`);
    }
  }

  const warns = pv.ruleWarnings ?? [];
  if (warns.length > 0) {
    console.log(`\n  \x1b[1;36m⚠️ 规则警告（${warns.length} 条）\x1b[0m`);
    for (const w of warns) {
      console.log(`    ${warningIcon(w.level)} [${w.level}] ${w.message}`);
    }
  }

  const involved = pv.involvedEntityIds ?? [];
  if (involved.length > 0) {
    console.log(`\n  \x1b[1;36m👥 涉及实体\x1b[0m`);
    console.log(`    ${involved.map(resolveName).join('、')}`);
  }

  const inputs = pv.simulationInputs;
  if (inputs) {
    console.log(`\n  \x1b[1;36m📐 推演输入\x1b[0m`);
    console.log(`    类型: ${inputs.eventType ?? '?'} | 章节: ${inputs.chapter ?? '?'}`);
  }
  console.log('');
}

// ---- 处理输入 ----
let lastAutoToggle = false;

async function processInput(input: string): Promise<boolean> {
  if (input.startsWith('/')) {
    return await handleCommand(input);
  }

  const startTime = Date.now();
  let tokenCount = 0;

  const onToken = (token: string) => {
    if (tokenCount === 0) {
      process.stdout.write('🤖 \x1b[1;34m');
    }
    tokenCount++;
    process.stdout.write(token);
  };

  try {
    const result = await agent.processUserInput(input, {
      commitAuthority: lastAutoToggle ? 'agent_authorized_for_session' : undefined,
      onToken,
    });
    lastAutoToggle = false;

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    if (tokenCount > 0) {
      process.stdout.write(`\x1b[0m\n   \x1b[90m(${elapsed}s, ${tokenCount} tokens)\x1b[0m\n\n`);
    } else {
      // 快捷路径（CLI 确认通道直接返回，无 LLM）
      console.log(result.content);
      process.stdout.write(`   \x1b[90m(${elapsed}s)\x1b[0m\n\n`);
    }

    // 状态提示
    const pendingDecisions = workflowService.listPendingDecisions(ctx());
    if (pendingDecisions.length > 0) {
      process.stdout.write('  \x1b[33m💡 有待确认事项。说"确认"提交，或"取消"拒绝\x1b[0m\n');
    }
  } catch (err) {
    if (tokenCount > 0) process.stdout.write('\x1b[0m\n');
    // W11：写作层结构化错误（WritingError/StateMachineError）经 renderErrorForAuthor 映射为人话 + 技术细节括注；
    // 普通错误回退到 err.message（行为不变）
    console.error(`\n  \x1b[31m❌ ${renderErrorForAuthor(err)}\x1b[0m\n`);
  }

  return false;
}

// ---- 启动 ----
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: '\x1b[1;32m你>\x1b[0m ',
});

// 动态建议：根据项目状态给不同的入门提示（不硬编码具体题材/角色名）
{
  const sketchesCount = writingStore.listEntitySketches(writingProjectId).length;
  const draftsCount = writingStore.listDrafts(writingProjectId).length;
  let tip: string;
  if (sketchesCount === 0 && draftsCount === 0) {
    tip = `描述你的世界观和主角（例如：这是一个关于${existingProject?.title ?? '这个世界'}的故事，主角叫...）`;
  } else if (draftsCount === 0) {
    tip = '描述一个事件让 Agent 起草（例如：主角在某个场景遇到了什么）';
  } else {
    tip = '用 /drafts 查看草案，/review 审核提案，或继续描述新情节';
  }
  console.log(`💡 试试说：${tip}\n`);
}

rl.prompt();

let processing = false;

rl.on('line', async (line) => {
  const input = line.trim();
  if (!input) { rl.prompt(); return; }
  if (processing) { console.log('  \x1b[90m请等待...\x1b[0m\n'); rl.prompt(); return; }

  processing = true;

  try {
    const quit = await processInput(input);
    if (quit) { rl.close(); return; }
  } catch (err) {
    console.error(`\n  \x1b[31m❌ ${renderErrorForAuthor(err)}\x1b[0m\n`);
  }

  processing = false;
  rl.prompt();
});

rl.on('close', () => {
  // 退出时清理后台同步定时器，避免进程挂起
  if (syncTimer) clearInterval(syncTimer);
  agent.closeSession();
  process.exit(0);
});
} // end of main()

// 启动
main().catch((err) => {
  console.error('\n  \x1b[31m❌ CLI 启动失败：\x1b[0m', err);
  process.exit(1);
});

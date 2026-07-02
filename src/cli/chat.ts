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
import { config } from 'dotenv';
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
  handleReader, handleForeshadow, handleReveal,
  handleProse, handleStyle, handleRevision, handleRetcon, handleImport, handleExport,
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

// 1. 项目选择（交互式菜单 + 记住上次；融合后基于 data/app.db 注册表）
const selected = await selectProject('./data');

console.log(`  📂 项目: ${selected.name}`);
console.log(`  💾 项目库: data/projects/${selected.name}/project.db（融合架构）`);
console.log('  输入 /help 查看命令  |  /quit 退出');
console.log('─'.repeat(56));

// 动态导入（装配已移至 src/session/，此处仅保留 CLI 命令层所需）
const { makeRequestContext } = await import('../writing/services/context.js');
// W11：错误模型渲染——写作层抛出的 WritingError / StateMachineError 经 ERROR_RECOVERY_MAP
// 映射为作者可读文案（CLI 异常通道的唯一消费点）
const { renderErrorForAuthor } = await import('../writing/errors/error-codes.js');

// ---- 初始化 ----
process.stdout.write('🔧 初始化 Core + WritingLayer...');

// 存储融合阶段5：装配改走 ProjectManager + ProjectSession（共享层），
// 替代原内联的 FactStore/WritingStore/Service 群实例化。
// CLI 与 BFF 现共用同一套装配代码（src/session/）。
const { getProjectManager } = await import('../session/project-manager.js');
const manager = getProjectManager('./data');

// 新建项目 → createProject（建目录 + 装配空库 + 建写作层项目 + 写 app.db 注册表）
// 已有项目 → openProject（查 app.db → ProjectSession 打开 + 装配）
const { ProjectSession: ProjectSessionType } = await import('../session/project-session.js');
let session: InstanceType<typeof ProjectSessionType>;
let writingProjectId: string;
if (selected.isNew) {
  const result = manager.createProject({ name: selected.name, title: selected.name });
  session = result.session;
  writingProjectId = result.record.id;
  console.log(`\n  🆕 写作层项目已创建: ${selected.name} (${writingProjectId})`);
} else {
  // 装配向量检索（CLI 需要语义召回 + sync_queue 同步）
  session = await manager.openProject(selected.name, { withVector: true, withAgent: false });
  writingProjectId = session.writingProjectId!;
  console.log(`\n  📂 写作层项目: ${selected.name} (${writingProjectId})`);
}

// 从 session 取出全部 store/service（与原内联实例化的对象等价）
const factStore = session.factStore;
const writingStore = session.writingStore;
const auditService = session.auditService;
const workflowService = session.workflowService;
const coreBridge = session.coreBridge;
const projectService = session.projectService;
const draftService = session.draftService;
const entityService = session.entityService;
const blueprintService = session.blueprintService;
const ideaService = session.ideaService;
const relationService = session.relationService;
const graphService = session.graphService;
const spatialService = session.spatialService;
const spatialViewService = session.spatialViewService;
const chapterService = session.chapterService;
const sceneService = session.sceneService;
const timelineService = session.timelineService;
const readerService = session.readerService;
const foreshadowingService = session.foreshadowingService;
const proseService = session.proseService;
const styleService = session.styleService;
const revisionService = session.revisionService;
const retconViewService = session.retconViewService;
const importExportService = session.importExportService;
const documentService = session.documentService;
const consumer = session.consumer;

// 装配 Agent（异步：含 LLM + AgentStore）
await session.initAgent();
const agent = session.agent;

agent.startSession('Phase 7 CLI 会话');

// 后台驱动 sync_queue consumer：每 5s 将新提交的 Fact 同步到 LanceDB。
// processPending 是幂等的原子抢占（UPDATE...RETURNING），无 pending 时空转，并发安全。
// embedding 失败时自动退避重试，不阻塞用户交互；未配置 key 时仅语义检索不工作，确定性查询照常。
const syncTimer = setInterval(() => {
  if (consumer) {
    consumer.processPending().catch((err: unknown) => console.error(`[SyncQueue] 同步失败: ${String(err).slice(0, 120)}`));
  }
}, 5000);
// 启动时立即清一次积压（fire-and-forget）
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
  // Phase 10：章节/场景/时间线服务
  chapterService, sceneService, timelineService,
  // Phase 11：读者模型/伏笔服务
  readerService, foreshadowingService,
  // Phase 12：正文/风格/修订/Retcon/导入导出服务
  proseService, styleService, revisionService, retconViewService, importExportService,
} as CliDeps & {
  relationService: unknown; graphService: unknown;
  spatialService: unknown; spatialViewService: unknown;
  chapterService: unknown; sceneService: unknown; timelineService: unknown;
  readerService: unknown; foreshadowingService: unknown;
  proseService: unknown; styleService: unknown; revisionService: unknown;
  retconViewService: unknown; importExportService: unknown;
};

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
    // Phase 11：读者模型/伏笔/揭示命令
    case '/reader': printLines(await handleReader(cliDeps, parsed)); return false;
    case '/foreshadow': printLines(await handleForeshadow(cliDeps, parsed)); return false;
    case '/reveal': printLines(await handleReveal(cliDeps, parsed)); return false;
    // Phase 12：正文/风格/修订/Retcon/导入导出命令
    case '/prose': printLines(await handleProse(cliDeps, parsed)); return false;
    case '/style': printLines(await handleStyle(cliDeps, parsed)); return false;
    case '/revision': printLines(await handleRevision(cliDeps, parsed)); return false;
    case '/retcon': printLines(await handleRetcon(cliDeps, parsed)); return false;
    case '/import': printLines(await handleImport(cliDeps, parsed)); return false;
    case '/export': printLines(await handleExport(cliDeps, parsed)); return false;
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

  \x1b[1;33m读者/伏笔\x1b[0m
    /reader [list|<受众id>]    读者群体与认知状态
    /foreshadow                伏笔计划列表
    /reveal                    揭示计划列表

  \x1b[1;33m正文/风格/修订\x1b[0m
    /prose [list|new <标题>|<id>]    正文文档（块级）
    /prose add <id> <文本>           追加段落
    /style                          风格指南（人称/距离/节奏/禁用表达）
    /revision <类型> <id>           对象修订历史

  \x1b[1;33mRetcon/导入导出\x1b[0m
    /retcon [list|<报告id>]         Retcon 影响报告
    /import <文件路径> [类型]       导入已有正文（不写 Core）
    /import list                    导入批次列表
    /export [范围] [文件路径]       导出项目数据为 JSON

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
      // 注：session.agent 经 initAgent 异步装配，类型为宽 any，故 traces 需显式标注
      const typedTraces = traces as Array<{
        stepType: string; status: string; summary: string; toolName?: string; errorCode?: string;
        usage?: { prompt_tokens: number; completion_tokens: number; prompt_cache_hit_tokens?: number };
      }>;
      const llmTraces = typedTraces.filter(t => t.stepType === 'llm_call' && t.usage);
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
    tip = `描述你的世界观和主角（例如：这是一个关于${writingStore.getProject(writingProjectId)?.title ?? '这个世界'}的故事，主角叫...）`;
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

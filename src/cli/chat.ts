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

config();

const DB_PATH = process.env['CLI_DB_PATH'] ?? './data/cli-project.db';

// 确保 data 目录存在
if (!existsSync('./data')) mkdirSync('./data', { recursive: true });

console.log('═'.repeat(56));
console.log('  📖 NarrativeOS · Phase 7 写作层 CLI');
console.log('═'.repeat(56));
console.log(`  DB: ${DB_PATH}`);
console.log('  输入 /help 查看命令  |  /quit 退出');
console.log('─'.repeat(56));

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

// ---- 初始化 ----
process.stdout.write('🔧 初始化 Core + WritingLayer...');

const factStore = new SQLiteFactStoreAdapter(DB_PATH, 'default');
const db = factStore.getDatabase();
const knowledgeStore = new SQLiteKnowledgeStoreAdapter(db);
const eventStore = new SQLiteEventStoreAdapter(db);
const threadStore = new SQLiteThreadStoreAdapter(db);

const threadResolver = new ThreadResolver();
const ruleEngine = new RuleEngine();
const proposalManager = new ProposalManager(ruleEngine, undefined, threadStore, threadResolver);
const retconEngine = new RetconEngine();
const toolService = new ToolService(factStore, knowledgeStore, eventStore, threadStore, threadResolver);
const schemaExtensionManager = new SchemaExtensionManager(db);

const toolRouter = new ToolRouter({
  proposalManager, retconEngine, toolService,
  schemaExtensionManager, factStore, knowledgeStore, eventStore, threadStore,
});

// 写作层
const writingStore = new SQLiteWritingStore(db);
writingStore.createTables();

const auditService = new AuditService(writingStore);
const workflowService = new WorkflowService(writingStore, auditService);
const coreBridge = new RealCoreBridge(toolRouter, writingStore);

const projectService = new ProjectService(writingStore, auditService);
const draftService = new DraftService(writingStore, auditService, coreBridge, workflowService);
const entityService = new EntityService(writingStore, auditService, workflowService);
const blueprintService = new BlueprintService(writingStore, auditService);
const ideaServiceInitial = new IdeaService(writingStore, auditService);

// 查找已有项目或创建新项目
let existingProject = writingStore.listProjects()[0];
let writingProjectId: string;

if (existingProject) {
  writingProjectId = existingProject.id;
  console.log(`\n  📂 已加载项目: ${existingProject.title} (${existingProject.id})`);
} else {
  writingProjectId = writingStore.createProject('新作品', '未命名作品').id;
  console.log(`\n  🆕 已创建项目: ${writingProjectId}`);
}

// 重新创建 IdeaService（需要 draftService，存在循环依赖）
const ideaService = new IdeaService(writingStore, auditService, draftService.createDraft.bind(draftService));

// Agent
const llm = new DeepSeekLLMClientAdapter();
const agentStore = new SQLiteAgentStoreAdapter(db);
agentStore.createTables();

const agent = new NarrativeAgent({
  llm, toolRouter, agentStore,
  projectId: 'default',
  // P0-2 修复：wall-clock 用默认 30 分钟，且已改为"单回合"计时
  // （见 narrative-agent.startNewTurn 每轮重置 sessionStartTime），避免长 CLI 会话误触发 suspended
  limits: { maxToolSteps: 32, maxRepeatedToolFailure: 3, maxWallClockMs: 30 * 60 * 1000 },
  // Phase 7 注入
  writingProjectId,
  writingStore, auditService, workflowService,
  draftService, entityService,
  coreBridge,
});

agent.startSession('Phase 7 CLI 会话');
console.log(' 就绪 ✅\n');

// ---- ctx 工厂 ----
const ctx = () => makeRequestContext({
  projectId: writingProjectId,
  sessionId: agent.getState().sessionId,
  trigger: 'author_action',
});

// ---- 命令处理 ----
async function handleCommand(input: string): Promise<boolean> {
  const cmd = input.trim();

  switch (cmd) {
    case '/help':
      console.log(`
  \x1b[1;36m命令：\x1b[0m
    /help       帮助
    /state      写作层状态（项目/草案/实体/待确认/蓝图）
    /history    Agent trace 摘要
    /auto       自动确认模式
    /manual     手动确认模式
    /quit       退出

  \x1b[1;36m确认/修改：\x1b[0m
    "确认" / "提交" → 确认待处理事项
    "不要" / "取消" → 拒绝
    "修改" / "再改" → 继续修改
`);
      return false;

    case '/state': {
      const c = ctx();
      const project = writingStore.getProject(writingProjectId);
      const drafts = writingStore.listDrafts(writingProjectId);
      const sketches = writingStore.listEntitySketches(writingProjectId);
      const decisions = workflowService.listPendingDecisions(c);
      const proposalViews = writingStore.listProposalViews(writingProjectId);
      const bp = blueprintService.getActiveBlueprint(c);
      const ideas = writingStore.listIdeaCards(writingProjectId);
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
      return false;
  }
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
    console.error(`\n  \x1b[31m❌ ${err instanceof Error ? err.message : String(err)}\x1b[0m\n`);
  }

  return false;
}

// ---- 启动 ----
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: '\x1b[1;32m你>\x1b[0m ',
});

console.log('💡 试试说：帮我创建一个灰域科幻世界，主角叫沈墨，他有嵌合体义肢\n');

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
    console.error(`\n  \x1b[31m❌ ${err instanceof Error ? err.message : String(err)}\x1b[0m\n`);
  }

  processing = false;
  rl.prompt();
});

rl.on('close', () => {
  agent.closeSession();
  process.exit(0);
});

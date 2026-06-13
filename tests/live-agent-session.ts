// =============================================================================
// NarrativeAgent 真实 LLM 集成验证会话
// =============================================================================
// 用法：npm run live:agent
// 使用 NarrativeAgent（而非手写 ReAct 循环）验证端到端写作闭环。
//
// 对应设计文档 §21：将 tests/live-session.ts 改为使用 NarrativeAgent
// =============================================================================

import Database from 'better-sqlite3';
import { config } from 'dotenv';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

config(); // 加载 .env

console.log('═'.repeat(60));
console.log('  Narrative-OS-Core · NarrativeAgent 真实 LLM 集成验证');
console.log('═'.repeat(60));

// 动态导入
const { SQLiteFactStoreAdapter } = await import('../src/adapters/sqlite/fact-store.js');
const { SQLiteKnowledgeStoreAdapter } = await import('../src/adapters/sqlite/knowledge-store.js');
const { SQLiteEventStoreAdapter } = await import('../src/adapters/sqlite/event-store.js');
const { SQLiteThreadStoreAdapter } = await import('../src/adapters/sqlite/thread-store.js');
const { SQLiteAgentStoreAdapter } = await import('../src/adapters/sqlite/agent-store.js');
const { LanceDBTableAdapter } = await import('../src/adapters/lancedb/table-adapter.js');
const { DeepSeekLLMClientAdapter } = await import('../src/adapters/llm/deepseek-client.js');
const { ProposalManager } = await import('../src/core/proposal-manager.js');
const { RuleEngine } = await import('../src/core/rule-engine.js');
const { ThreadResolver } = await import('../src/core/thread-resolver.js');
const { ToolService } = await import('../src/core/tool-service.js');
const { SchemaExtensionManager } = await import('../src/core/schema-extension-manager.js');
const { ToolRouter } = await import('../src/core/tool-router.js');
const { RetconEngine } = await import('../src/core/retcon-engine.js');
const { NarrativeAgent } = await import('../src/agent/narrative-agent.js');

// ---------------------------------------------------------------------------
// 辅助函数
// ---------------------------------------------------------------------------

const D = '─'.repeat(60);
function H(text: string) { console.log(`\n\x1b[1;36m${D}\n  ${text}\n${D}\x1b[0m\n`); }
function A(text: string) { console.log(`\x1b[1;33m👤 用户：${text}\x1b[0m`); }
function R(text: string) { console.log(`\x1b[1;34m🤖 Agent：${text}\x1b[0m\n`); }
function Info(label: string, value: string) { console.log(`  \x1b[90m${label}：${value}\x1b[0m`); }
function Warn(text: string) { console.log(`  \x1b[33m⚠️  ${text}\x1b[0m`); }
function OK(text: string) { console.log(`  \x1b[32m✅ ${text}\x1b[0m`); }
function Fail(text: string) { console.log(`  \x1b[31m❌ ${text}\x1b[0m`); }

function formatFactValue(value: unknown): string {
  if (typeof value === 'object' && value !== null && (value as any).type === 'entity_ref') {
    return (value as any).entityId ?? JSON.stringify(value);
  }
  if (typeof value === 'object' && value !== null) {
    return JSON.stringify(value);
  }
  return String(value);
}

// ---------------------------------------------------------------------------
// 主程序
// ---------------------------------------------------------------------------

console.log('📦 初始化 Core 组件...');

// ---- SQLite ----
const factStore = new SQLiteFactStoreAdapter(':memory:', 'default');
const db = factStore.getDatabase();
const knowledgeStore = new SQLiteKnowledgeStoreAdapter(db);
const eventStore = new SQLiteEventStoreAdapter(db);
const threadStore = new SQLiteThreadStoreAdapter(db);

// ---- LanceDB ----
const lancedbDir = mkdtempSync(join(tmpdir(), 'live-agent-'));
const vectorStore = new LanceDBTableAdapter(lancedbDir, 'facts');
await vectorStore.init();

// ---- Core 组件 ----
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

// ---- LLM ----
const llm = new DeepSeekLLMClientAdapter();

// ---- Agent Store ----
const agentStore = new SQLiteAgentStoreAdapter(db);
agentStore.createTables();

// ---- NarrativeAgent ----
const agent = new NarrativeAgent({
  llm,
  toolRouter,
  agentStore,
  projectId: 'default',
  limits: { maxToolSteps: 32, maxRepeatedToolFailure: 3, maxWallClockMs: 300000 },
});

console.log('   ✅ 就绪\n');

// =============================================================================
// 写作会话
// =============================================================================

const fatalFailures: string[] = [];

// ---- 启动会话 ----
agent.startSession('修仙小说写作辅助');

// ====== 第 1 轮 · 世界观构建 ======
H('第 1 轮 · 世界观构建');
A('我开了一本修仙小说。主角叫韩立，资质普通但性格坚毅。帮我设置初始世界状态。');

const r1 = await agent.processUserInput(
  '我开了一本修仙小说。主角叫韩立，资质普通但性格坚毅。帮我设置初始世界状态。',
  { commitAuthority: 'agent_authorized_for_session' },
);

R(r1.content);
Info('状态', r1.status);
if (r1.draft) Info('草案', `${r1.draft.summary} (${r1.draft.status})`);
if (r1.pendingProposalIds?.length) Warn(`存在未提交的提案：${r1.pendingProposalIds.join(', ')}`);
if (r1.status === 'failed') fatalFailures.push('第 1 轮失败');

// ====== 第 2 轮 · 剧情推进 ======
H('第 2 轮 · 主角突破');
A('韩立在一次采药时误入古修士洞府，获得逆天功法和丹药。三年苦修后从炼气突破到筑基。帮我记录这个事件。');

const r2 = await agent.processUserInput(
  '韩立在一次采药时误入古修士洞府，获得逆天功法和丹药。三年苦修后从炼气突破到筑基。帮我记录这个事件。',
  { commitAuthority: 'agent_authorized_for_session' },
);

R(r2.content);
Info('状态', r2.status);
if (r2.draft) Info('草案', `${r2.draft.summary} (${r2.draft.status})`);
if (r2.pendingProposalIds?.length) Warn(`存在未提交的提案：${r2.pendingProposalIds.join(', ')}`);
if (r2.status === 'failed') fatalFailures.push('第 2 轮失败');

// ====== 第 3 轮 · 状态确认 ======
H('第 3 轮 · 状态确认');
A('让我看看韩立目前的状态。');

const r3 = await agent.processUserInput('让我看看韩立目前的状态。');

R(r3.content);
Info('状态', r3.status);
if (r3.status === 'failed') fatalFailures.push('第 3 轮失败');

// ====== 第 4 轮 · 新角色 + 剧情 ======
H('第 4 轮 · 新角色登场');
A('韩立出关发现洞府门口躺着个受伤女子，名叫南宫婉，被追杀至此。韩立出手相助。帮我注册南宫婉并记录这个相遇事件。');

const r4 = await agent.processUserInput(
  '韩立出关发现洞府门口躺着个受伤女子，名叫南宫婉，被追杀至此。韩立出手相助。帮我注册南宫婉并记录这个相遇事件。',
  { commitAuthority: 'agent_authorized_for_session' },
);

R(r4.content);
Info('状态', r4.status);
if (r4.draft) Info('草案', `${r4.draft.summary} (${r4.draft.status})`);
if (r4.pendingProposalIds?.length) Warn(`存在未提交的提案：${r4.pendingProposalIds.join(', ')}`);
if (r4.status === 'failed') fatalFailures.push('第 4 轮失败');

// ====== 第 5 轮 · 手工验证 Core 写入闭环 ======
H('第 5 轮 · Core 写入闭环验证（手工构造参数）');
console.log('   (补充手工构造参数，验证 Core 管线在无 LLM 时仍可独立闭环)\n');

// 查询当前实体（用于获取韩立的 ID）
const entities = db.prepare('SELECT id, name, kind FROM entities').all() as Array<{ id: string; name: string; kind: string }>;
const hanliEntity = entities.find(e => e.name.includes('韩立') || e.name.toLowerCase().includes('hanli'));
const protagonistId = hanliEntity?.id ?? 'ent_hanli';

// 构造 propose_event
const manualFactChanges = [
  { change_id: 'c1', op: 'assert', subject: protagonistId, predicate: 'realm', value: '筑基初期' },
  { change_id: 'c2', op: 'assert', subject: protagonistId, predicate: 'status', value: '内门弟子' },
  { change_id: 'c3', op: 'assert', subject: protagonistId, predicate: 'technique', value: '三转重元功' },
  { change_id: 'c4', op: 'assert', subject: protagonistId, predicate: 'location', value: '古修士洞府' },
];

console.log(`  📝 propose_event: subject=${protagonistId} | ${manualFactChanges.length} 条 fact_changes`);
const proposeResult = await toolRouter.execute('propose_event', {
  event_type: 'breakthrough',
  event_description: '韩立在古修士洞府苦修三年，以四灵根资质突破至筑基初期',
  chapter: 4,
  subject: protagonistId,
  fact_changes: manualFactChanges,
});

if (proposeResult.success) {
  const pid = (proposeResult.data as any).proposalId;
  OK(`propose_event 成功: proposalId=${pid}`);

  const commitResult = await toolRouter.execute('commit_event', { proposal_id: pid });
  if (commitResult.success) {
    const data = commitResult.data as any;
    OK(`commit_event 成功: event_id=${data.event_id} | facts=${data.committed_fact_count}`);
  } else {
    Fail(`commit_event 失败: ${commitResult.error.message}`);
    fatalFailures.push(`手工 commit_event 失败: ${commitResult.error.message}`);
  }
} else {
  Fail(`propose_event 失败: ${proposeResult.error.message}`);
  fatalFailures.push(`手工 propose_event 失败: ${proposeResult.error.message}`);
}

// ====== 总结 ======
H('会话总结');

// 检查 agent 状态
const agentState = agent.getState();
Info('Agent 状态', agentState.status);
if (agentState.pendingProposalIds.length > 0) {
  Warn(`存在未提交的提案：${agentState.pendingProposalIds.join(', ')}`);
  fatalFailures.push(`Agent 有 ${agentState.pendingProposalIds.length} 个未提交提案`);
}

// 检查 trace 记录
const traces = agentStore.getTracesBySession(agentState.sessionId);
Info('Trace 记录', `${traces.length} 条`);

// 检查 Core 状态
const facts = factStore.query({ mode: 'current' });
const openThreads = threadStore.getOpen();
console.log(`\n📊 当前 Fact: ${facts.length} 条  |  开放线索: ${openThreads.length} 条\n`);

console.log('📋 最近 Fact:');
for (const f of facts.slice(-10)) {
  console.log(`   ${f.subject} → ${f.predicate} = ${formatFactValue(f.value).slice(0, 40)}  [第${f.validFrom}章]`);
}

// 检查已注册实体
console.log(`\n📋 已注册实体 (${entities.length} 个):`);
for (const e of entities) {
  console.log(`   ${e.id} | ${e.name} | ${e.kind}`);
}

// ---- 清理 ----
agent.closeSession();
try { rmSync(lancedbDir, { recursive: true, force: true }); } catch {}

// ---- 最终判定 ----
if (fatalFailures.length > 0) {
  console.log('\n' + '═'.repeat(60) + '\n  验证失败 ❌\n' + '═'.repeat(60));
  for (const failure of fatalFailures) {
    console.log(`   - ${failure}`);
  }
  process.exitCode = 1;
} else {
  console.log('\n' + '═'.repeat(60) + '\n  验证完成 ✅\n' + '═'.repeat(60));
}

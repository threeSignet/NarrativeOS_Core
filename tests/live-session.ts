// =============================================================================
// 真实 LLM 集成验证会话
// =============================================================================
// 用法：npm run live
// 所有输出实时打印到终端，LLM 回复流式逐 token 输出。

import Database from 'better-sqlite3';
import { config } from 'dotenv';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

config(); // 加载 .env

console.log('═'.repeat(60));
console.log('  Narrative-OS-Core · 真实 LLM 集成验证');
console.log('═'.repeat(60));

// 动态导入
const { SQLiteFactStoreAdapter } = await import('../src/adapters/sqlite/fact-store.js');
const { SQLiteKnowledgeStoreAdapter } = await import('../src/adapters/sqlite/knowledge-store.js');
const { SQLiteEventStoreAdapter } = await import('../src/adapters/sqlite/event-store.js');
const { SQLiteThreadStoreAdapter } = await import('../src/adapters/sqlite/thread-store.js');
const { LanceDBTableAdapter } = await import('../src/adapters/lancedb/table-adapter.js');
const { DeepSeekLLMClientAdapter } = await import('../src/adapters/llm/deepseek-client.js');
const { ProposalManager } = await import('../src/core/proposal-manager.js');
const { RuleEngine } = await import('../src/core/rule-engine.js');
const { ThreadResolver } = await import('../src/core/thread-resolver.js');
const { ToolService } = await import('../src/core/tool-service.js');
const { SchemaExtensionManager } = await import('../src/core/schema-extension-manager.js');
const { ToolRouter } = await import('../src/core/tool-router.js');
const { RetconEngine } = await import('../src/core/retcon-engine.js');
import type { ChatMessage } from '../src/types.js';

// ---------------------------------------------------------------------------
type StreamResult = Awaited<ReturnType<DeepSeekLLMClientAdapter['chatStream']>>;
type ToolExecutionResult = any;

const D = '─'.repeat(60);
const MAX_TOOL_TURNS = 32;
function H(text: string) { console.log(`\n\x1b[1;36m${D}\n  ${text}\n${D}\x1b[0m\n`); }
function A(text: string) { console.log(`\x1b[1;33m👤 ${text}\x1b[0m\n`); }
function P(token: string) { process.stdout.write(token); }
function TC(name: string, args: Record<string, unknown>) {
  console.log(`\n  \x1b[1;35m🔧 ${name}\x1b[0m ${JSON.stringify(args).slice(0, 150)}`);
}
function TR(name: string, ok: boolean, summary: string) {
  console.log(`  ${ok ? '\x1b[32m✅' : '\x1b[31m❌'} ${name}: ${summary}\x1b[0m`);
}
function LLM() { console.log(`\x1b[1;34m🤖\x1b[0m `); }
function printAssistantContent(resp: StreamResult) {
  if (resp.content.trim().length > 0) {
    console.log(resp.content);
  }
}

let protagonistId: string | undefined;
const toolWarnings: string[] = [];
const fatalFailures: string[] = [];
const pendingProposalIds = new Set<string>();
const toolFailureCounts = new Map<string, number>();

// ---------------------------------------------------------------------------
// 辅助：构建 assistant 消息（含 reasoning_content 支持 DeepSeek 思考模式）
// ---------------------------------------------------------------------------
function assistantMsg(resp: StreamResult): ChatMessage {
  const msg: any = { role: 'assistant', content: resp.content };
  if (resp.reasoningContent) msg.reasoning_content = resp.reasoningContent;
  if (resp.toolCalls) {
    msg.tool_calls = resp.toolCalls.map(tc => ({
      id: (tc as any).id || `call_${tc.name}`, type: 'function',
      function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
    }));
  }
  return msg;
}

async function executeToolCalls(resp: StreamResult, summary: (name: string, result: ToolExecutionResult) => string) {
  if (!resp.toolCalls?.length) return false;

  for (const tc of resp.toolCalls) {
    const callId = (tc as any).id || `call_${tc.name}`;
    TC(tc.name, tc.arguments);
    const r = await router.execute(tc.name, tc.arguments);
    TR(tc.name, r.success, summary(tc.name, r));
    if (!r.success) {
      toolWarnings.push(`${tc.name}: ${r.error.message}`);
      recordToolFailure(tc.name, r.error.message);
    }
    rememberImportantIds(tc.name, tc.arguments, r);
    rememberProposalLifecycle(tc.name, tc.arguments, r);
    msgs.push({
      role: 'tool',
      content: JSON.stringify(buildToolObservation(tc.name, r)).slice(0, 1600),
      tool_call_id: callId,
    });
  }
  return true;
}

function buildToolObservation(name: string, result: ToolExecutionResult): unknown {
  if (result.success) return result.data;

  const correctionHint = getCorrectionHint(result.error.message);
  return {
    ...result.error,
    correction_hint: correctionHint,
    agent_note: `工具 ${name} 执行失败。不要重复相同参数；请根据 correction_hint 修正后再试。`,
  };
}

function getCorrectionHint(message: string): string {
  if (message.includes('FACT_NOT_CURRENT')) {
    return 'target_fact_id 已失效。请重新调用 get_context_slice 获取最新 fact_index；如果旧状态已被覆盖，不要继续 update/retract 旧 fact，改用 assert 新事实或使用最新 target_fact_id。';
  }
  if (message.includes('FACT_NOT_FOUND')) {
    return '引用的实体、Fact 或 target_fact_id 不存在。请先调用 get_context_slice 或 register_entity 获取 Core 返回的真实 ID。';
  }
  if (message.includes('PROPOSAL_NOT_FOUND')) {
    return 'commit_event 必须使用最近一次 propose_event 返回的 proposal_id，不要使用 event_id 或自行编造 ID。';
  }
  return '请读取错误信息，修正参数后再调用；不要原样重复失败调用。';
}

function recordToolFailure(name: string, message: string) {
  const signature = `${name}:${message}`;
  const next = (toolFailureCounts.get(signature) ?? 0) + 1;
  toolFailureCounts.set(signature, next);
  if (next >= 3) {
    fatalFailures.push(`同一工具错误连续/累计出现 ${next} 次: ${signature}`);
  }
}

function rememberImportantIds(name: string, args: Record<string, unknown>, result: ToolExecutionResult) {
  if (name !== 'register_entity' || !result.success) return;
  const rawName = typeof args['name'] === 'string' ? args['name'].toLowerCase() : '';
  const entityId = typeof result.data?.entity_id === 'string' ? result.data.entity_id : undefined;
  if (!entityId) return;

  if (rawName === 'hanli' || rawName.includes('韩立')) {
    protagonistId = entityId;
  }
}

function rememberProposalLifecycle(name: string, args: Record<string, unknown>, result: ToolExecutionResult) {
  if (!result.success) return;
  const data = result.data as any;
  if (name === 'propose_event' && typeof data?.proposalId === 'string') {
    pendingProposalIds.add(data.proposalId);
  }
  if (name === 'commit_event') {
    const proposalId = typeof args['proposal_id'] === 'string' ? args['proposal_id'] : undefined;
    if (proposalId) pendingProposalIds.delete(proposalId);
  }
}

async function runToolLoop(resp: StreamResult, summary: (name: string, result: ToolExecutionResult) => string, maxTurns = MAX_TOOL_TURNS) {
  let current = resp;
  for (let i = 0; i < maxTurns; i++) {
    const executed = await executeToolCalls(current, summary);
    if (!executed) return current;

    LLM();
    current = await llm.chatStreamWithTools(msgs, tools, P, { model: llmModel });
    console.log('');
    msgs.push(assistantMsg(current));
  }
  // 即使达到轮数上限，也必须回复最后一个 assistant tool_call；
  // 否则下一轮请求会被 DeepSeek/OpenAI 协议拒绝为 400。
  const hadOverflowCalls = await executeToolCalls(current, summary);
  if (hadOverflowCalls) {
    fatalFailures.push(`工具循环达到上限 ${maxTurns} 轮后仍有工具调用，可能存在循环或未完成提交。`);
  }
  return current;
}

function defaultToolSummary(name: string, r: ToolExecutionResult): string {
  if (!r.success) return r.error.message;
  const data = r.data as any;
  if (data?.entity_id) return data.entity_id;
  if (data?.proposalId) return `proposalId=${data.proposalId}`;
  if (data?.event_id) return `event_id=${data.event_id}`;
  if (name === 'get_context_slice') return '档案已获取';
  return 'OK';
}

function formatLiveFactValue(value: unknown): string {
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

// ---- 1. 初始化 ----
console.log('📦 初始化...');

const factStore = new SQLiteFactStoreAdapter(':memory:', 'default');
const db = factStore.getDatabase();
const knowledgeStore = new SQLiteKnowledgeStoreAdapter(db);
const eventStore = new SQLiteEventStoreAdapter(db);
const threadStore = new SQLiteThreadStoreAdapter(db);

const lancedbDir = mkdtempSync(join(tmpdir(), 'live-'));
const vectorStore = new LanceDBTableAdapter(lancedbDir, 'facts');
await vectorStore.init();

const threadResolver = new ThreadResolver();
const proposalManager = new ProposalManager(new RuleEngine(), undefined, threadStore, threadResolver);
const router = new ToolRouter({
  proposalManager, retconEngine: new RetconEngine(),
  toolService: new ToolService(factStore, knowledgeStore, eventStore, threadStore, threadResolver),
  schemaExtensionManager: new SchemaExtensionManager(db),
  factStore, knowledgeStore, eventStore, threadStore,
});
const llm = new DeepSeekLLMClientAdapter();
const llmModel = 'deepseek-v4-flash';
const tools = router.getDefinitions();

console.log('   ✅ 就绪\n');

// ---- 2. system prompt ----
const sys: ChatMessage = {
  role: 'system',
  content: `你是修仙小说写作助手，负责管理故事的世界状态。你拥有以下能力：

1. register_entity — 注册新角色、地点、物品
2. propose_event — 提议事件（沙盒推演），记录世界状态变化。确认安全后必须调用 commit_event 提交！
3. commit_event — 确认提交已通过推演的事件
4. get_context_slice — 查询实体完整档案（操作前先查询）
5. resolve_thread — 手动关闭叙事线索

【propose_event 的 fact_changes 字段】必须直接传数组，不要传 JSON 字符串。例：[{"change_id":"c1","op":"assert","subject":"ent_hanli","predicate":"realm","value":"筑基期"}]。op取值assert/retract/update。

【流程】每次 event 操作必须：先 get_context_slice 查状态 → propose_event 推演 → 确认安全后 commit_event 提交。
【修错】如果工具返回 FACT_NOT_CURRENT / FACT_NOT_FOUND，禁止原样重复调用。必须重新 get_context_slice 获取最新 fact_index；如果旧状态已失效，改用 assert 新状态，不要继续引用旧 target_fact_id。
【提交】每一个成功的 propose_event 都必须继续调用 commit_event，除非你明确告诉用户提案暂不提交。

使用中文回复。`,
};
const msgs: ChatMessage[] = [sys];

// ---- 3. 写作会话 ----

// ====== 第 1 轮 · 世界观构建 ======
H('第 1 轮 · 世界观构建');
A('我开了一本修仙小说。主角叫韩立，资质普通但性格坚毅。帮我设置初始世界状态。');
msgs.push({ role: 'user', content: '我开了一本修仙小说。主角叫韩立，资质普通但性格坚毅。帮我设置初始世界状态。' });

LLM();
let resp = await llm.chatWithTools(msgs, tools, { model: llmModel });
printAssistantContent(resp);
msgs.push(assistantMsg(resp));

resp = await runToolLoop(resp, defaultToolSummary);

// ====== 第 2 轮 · 剧情推进 ======
H('第 2 轮 · 主角突破');
A('韩立在一次采药时误入古修士洞府，获得逆天功法和丹药。三年苦修后从炼气突破到筑基。帮我记录这个事件。');
msgs.push({ role: 'user', content: '韩立在一次采药时误入古修士洞府，获得逆天功法和丹药。三年苦修后从炼气突破到筑基。帮我记录这个事件。' });

LLM();
resp = await llm.chatWithTools(msgs, tools, { model: llmModel });
printAssistantContent(resp);
msgs.push(assistantMsg(resp));

resp = await runToolLoop(resp, defaultToolSummary);

// ====== 第 3 轮 · 状态确认 ======
H('第 3 轮 · 状态确认');
A('让我看看韩立目前的状态。');
msgs.push({ role: 'user', content: '让我看看韩立目前的状态。' });

LLM();
resp = await llm.chatWithTools(msgs, tools, { model: llmModel });
printAssistantContent(resp);
msgs.push(assistantMsg(resp));

resp = await runToolLoop(resp, defaultToolSummary);

// ====== 第 4 轮 · 新角色 ======
H('第 4 轮 · 新角色登场');
A('韩立出关发现洞府门口躺着个受伤女子，名叫南宫婉，被追杀至此。韩立出手相助。帮我注册南宫婉并记录这个相遇事件。');
msgs.push({ role: 'user', content: '韩立出关发现洞府门口躺着个受伤女子，名叫南宫婉，被追杀至此。韩立出手相助。帮我注册南宫婉并记录这个相遇事件。' });

LLM();
resp = await llm.chatWithTools(msgs, tools, { model: llmModel });
printAssistantContent(resp);
msgs.push(assistantMsg(resp));

resp = await runToolLoop(resp, defaultToolSummary);

// ====== 第 5 轮 · 手工验证 Core 写入闭环 ======
H('第 5 轮 · Core 写入闭环验证（手工构造参数）');
console.log('   (补充手工构造参数，验证 Core 管线在无 LLM 时仍可独立闭环)\n');

// Step 1: 构造 propose_event
const manualSubject = protagonistId ?? 'ent_hanli';
const manualFactChanges = [
  { change_id: 'c1', op: 'assert', subject: manualSubject, predicate: 'realm', value: '筑基初期' },
  { change_id: 'c2', op: 'assert', subject: manualSubject, predicate: 'status', value: '内门弟子' },
  { change_id: 'c3', op: 'assert', subject: manualSubject, predicate: 'technique', value: '三转重元功' },
  { change_id: 'c4', op: 'assert', subject: manualSubject, predicate: 'location', value: '古修士洞府' },
];

console.log(`  📝 propose_event: subject=${manualSubject} | 4 条 fact_changes`);
TC('propose_event', { event_type: 'breakthrough', chapter: 4, fact_changes: manualFactChanges });
const proposeResult = await router.execute('propose_event', {
  event_type: 'breakthrough',
  event_description: '韩立在古修士洞府苦修三年，以四灵根资质突破至筑基初期',
  chapter: 4,
  subject: manualSubject,
  fact_changes: manualFactChanges,
});
TR('propose_event', proposeResult.success, proposeResult.success ? `proposalId=${(proposeResult.data as any)?.proposalId}` : proposeResult.error.message);
if (!proposeResult.success) {
  fatalFailures.push(`手工 propose_event 失败: ${proposeResult.error.message}`);
}

if (proposeResult.success) {
  // Step 2: 提交
  const pid = (proposeResult.data as any).proposalId;
  pendingProposalIds.add(pid);
  console.log(`  📝 commit_event: proposalId=${pid}`);
  const commitResult = await router.execute('commit_event', { proposal_id: pid });
  TR('commit_event', commitResult.success,
    commitResult.success
      ? `event_id=${(commitResult.data as any)?.event_id} | facts=${(commitResult.data as any)?.committed_fact_count}`
      : commitResult.error.message);
  if (!commitResult.success) {
    fatalFailures.push(`手工 commit_event 失败: ${commitResult.error.message}`);
  } else {
    pendingProposalIds.delete(pid);
  }
}

// ====== 总结 ======
H('会话总结');
if (toolWarnings.length > 0) {
  fatalFailures.push(`工具调用出现 ${toolWarnings.length} 条错误，live 验证不能判定为全绿。`);
}
if (pendingProposalIds.size > 0) {
  fatalFailures.push(`存在未提交的 proposal: ${Array.from(pendingProposalIds).join(', ')}`);
}
const facts = factStore.query({ mode: 'current' });
const open = threadStore.getOpen();
console.log(`📊 当前 Fact: ${facts.length} 条  |  开放线索: ${open.length} 条\n`);
console.log('📋 最近 Fact:');
for (const f of facts.slice(-8)) {
  console.log(`   ${f.subject} → ${f.predicate} = ${formatLiveFactValue(f.value).slice(0, 30)}  [第${f.validFrom}章]`);
}
try { rmSync(lancedbDir, { recursive: true, force: true }); } catch {}
if (toolWarnings.length > 0) {
  console.log(`\n⚠️  Tool 警告 ${toolWarnings.length} 条：`);
  for (const warning of toolWarnings.slice(0, 6)) {
    console.log(`   - ${warning}`);
  }
}
if (fatalFailures.length > 0) {
  console.log('\n' + '═'.repeat(60) + '\n  验证失败 ❌\n' + '═'.repeat(60));
  for (const failure of fatalFailures) {
    console.log(`   - ${failure}`);
  }
  process.exitCode = 1;
} else {
  console.log('\n' + '═'.repeat(60) + '\n  验证完成 ✅\n' + '═'.repeat(60));
}

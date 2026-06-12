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

const D = '─'.repeat(60);
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

async function executeToolCalls(resp: StreamResult, summary: (name: string, result: any) => string) {
  if (!resp.toolCalls?.length) return false;

  for (const tc of resp.toolCalls) {
    const callId = (tc as any).id || `call_${tc.name}`;
    TC(tc.name, tc.arguments);
    const r = await router.execute(tc.name, tc.arguments);
    TR(tc.name, r.success, summary(tc.name, r));
    msgs.push({
      role: 'tool',
      content: JSON.stringify(r.success ? r.data : r.error).slice(0, 1200),
      tool_call_id: callId,
    });
  }
  return true;
}

async function runToolLoop(resp: StreamResult, summary: (name: string, result: any) => string, maxTurns = 4) {
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
  await executeToolCalls(current, summary);
  return current;
}

function defaultToolSummary(name: string, r: any): string {
  if (!r.success) return r.error.message;
  const data = r.data as any;
  if (data?.entity_id) return data.entity_id;
  if (data?.proposalId) return `proposalId=${data.proposalId}`;
  if (data?.event_id) return `event_id=${data.event_id}`;
  if (name === 'get_context_slice') return '档案已获取';
  return 'OK';
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
const manualFactChanges = [
  { change_id: 'c1', op: 'assert', subject: 'ent_hanli', predicate: 'realm', value: '筑基初期' },
  { change_id: 'c2', op: 'assert', subject: 'ent_hanli', predicate: 'status', value: '内门弟子' },
  { change_id: 'c3', op: 'assert', subject: 'ent_hanli', predicate: 'technique', value: '三转重元功' },
  { change_id: 'c4', op: 'assert', subject: 'ent_hanli', predicate: 'location', value: '古修士洞府' },
];

console.log(`  📝 propose_event: 4 条 fact_changes`);
TC('propose_event', { event_type: 'breakthrough', chapter: 4, fact_changes: manualFactChanges });
const proposeResult = await router.execute('propose_event', {
  event_type: 'breakthrough',
  event_description: '韩立在古修士洞府苦修三年，以四灵根资质突破至筑基初期',
  chapter: 4,
  subject: 'ent_hanli',
  fact_changes: manualFactChanges,
});
TR('propose_event', proposeResult.success, proposeResult.success ? `proposalId=${(proposeResult.data as any)?.proposalId}` : proposeResult.error.message);

if (proposeResult.success) {
  // Step 2: 提交
  const pid = (proposeResult.data as any).proposalId;
  console.log(`  📝 commit_event: proposalId=${pid}`);
  const commitResult = await router.execute('commit_event', { proposal_id: pid });
  TR('commit_event', commitResult.success,
    commitResult.success
      ? `event_id=${(commitResult.data as any)?.event_id} | facts=${(commitResult.data as any)?.committed_fact_count}`
      : commitResult.error.message);
}

// ====== 总结 ======
H('会话总结');
const facts = factStore.query({ mode: 'current' });
const open = threadStore.getOpen();
console.log(`📊 当前 Fact: ${facts.length} 条  |  开放线索: ${open.length} 条\n`);
console.log('📋 最近 Fact:');
for (const f of facts.slice(-8)) {
  console.log(`   ${f.subject} → ${f.predicate} = ${String(f.value).slice(0, 30)}  [第${f.validFrom}章]`);
}
try { rmSync(lancedbDir, { recursive: true, force: true }); } catch {}
console.log('\n' + '═'.repeat(60) + '\n  验证完成 ✅\n' + '═'.repeat(60));

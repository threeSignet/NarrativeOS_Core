// =============================================================================
// NarrativeAgent 交互式会话入口
// =============================================================================
// 用法：npm run chat
// 在终端中与 NarrativeAgent 进行多轮写作会话。
//
// 支持的命令：
//   /help     — 显示帮助
//   /history  — 显示本会话 trace 摘要
//   /state    — 显示当前状态（草案、待提交提案等）
//   /confirm  — 确认提交当前草案（等同于说"就按这个提交"）
//   /reject   — 废弃当前草案
//   /quit     — 退出
// =============================================================================

import * as readline from 'readline';
import Database from 'better-sqlite3';
import { config } from 'dotenv';

config();

console.log('═'.repeat(56));
console.log('  📖 NarrativeAgent · 交互式写作助手');
console.log('═'.repeat(56));
console.log('  输入 /help 查看命令  |  /quit 退出');
console.log('─'.repeat(56));

// 动态导入
const { SQLiteFactStoreAdapter } = await import('../src/adapters/sqlite/fact-store.js');
const { SQLiteKnowledgeStoreAdapter } = await import('../src/adapters/sqlite/knowledge-store.js');
const { SQLiteEventStoreAdapter } = await import('../src/adapters/sqlite/event-store.js');
const { SQLiteThreadStoreAdapter } = await import('../src/adapters/sqlite/thread-store.js');
const { SQLiteAgentStoreAdapter } = await import('../src/adapters/sqlite/agent-store.js');
const { DeepSeekLLMClientAdapter } = await import('../src/adapters/llm/deepseek-client.js');
const { ProposalManager } = await import('../src/core/proposal-manager.js');
const { RuleEngine } = await import('../src/core/rule-engine.js');
const { ThreadResolver } = await import('../src/core/thread-resolver.js');
const { ToolService } = await import('../src/core/tool-service.js');
const { SchemaExtensionManager } = await import('../src/core/schema-extension-manager.js');
const { ToolRouter } = await import('../src/core/tool-router.js');
const { RetconEngine } = await import('../src/core/retcon-engine.js');
const { NarrativeAgent } = await import('../src/agent/narrative-agent.js');

// ---- 初始化 Core 组件 ----
process.stdout.write('🔧 初始化...');

const factStore = new SQLiteFactStoreAdapter(':memory:', 'default');
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

const llm = new DeepSeekLLMClientAdapter();
const agentStore = new SQLiteAgentStoreAdapter(db);
agentStore.createTables();

const agent = new NarrativeAgent({
  llm,
  toolRouter,
  agentStore,
  projectId: 'default',
  limits: { maxToolSteps: 32, maxRepeatedToolFailure: 3, maxWallClockMs: 300000 },
});

agent.startSession('交互式写作会话');
console.log(' 就绪 ✅\n');

// ---- 命令处理 ----
async function handleCommand(input: string): Promise<boolean> {
  const cmd = input.trim();

  switch (cmd) {
    case '/help':
      console.log(`
  \x1b[1;36m可用命令：\x1b[0m
    /help     显示此帮助
    /state    显示当前 Agent 状态（草案、待提交提案等）
    /history  显示本回合 trace 摘要
    /confirm  确认提交当前草案
    /reject   废弃当前草案
    /auto     切换自动提交模式（agent_authorized_for_session）
    /manual   切换手动确认模式（explicit_user_confirmation）
    /quit     退出会话

  \x1b[1;36m自然语言关键词：\x1b[0m
    "就按这个提交" / "确认" / "提交吧" → 确认提交
    "再改一下" / "修改" / "换个方式" → 继续修改草案
    "不要" / "重来" / "废弃"         → 废弃草案
`);
      return false;

    case '/state': {
      const state = agent.getState();
      console.log(`\n  \x1b[1;33m📋 Agent 状态\x1b[0m`);
      console.log(`  会话 ID      ${state.sessionId}`);
      console.log(`  状态         ${state.status}`);
      console.log(`  提交模式     ${state.commitAuthority}`);
      console.log(`  消息数       ${state.messages.length}`);
      console.log(`  Trace 条数   ${state.traceBuffer.length}`);

      if (state.workingDraft) {
        const d = state.workingDraft;
        console.log(`\n  \x1b[1;33m📝 工作草案\x1b[0m`);
        console.log(`  摘要         ${d.summary}`);
        console.log(`  状态         ${d.status}`);
        console.log(`  修订次数     ${d.revisionCount}`);
        if (d.proposalId) console.log(`  提案 ID      ${d.proposalId}`);
      } else {
        console.log(`\n  \x1b[90m  无活跃草案\x1b[0m`);
      }

      if (state.pendingProposalIds.length > 0) {
        console.log(`\n  \x1b[1;33m⏳ 待提交提案\x1b[0m`);
        for (const pid of state.pendingProposalIds) {
          console.log(`    ${pid}`);
        }
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
      console.log(`\n  \x1b[1;33m📜 Trace 记录（最近 ${Math.min(traces.length, 20)} 条）\x1b[0m`);
      for (const t of traces.slice(-20)) {
        const icon = t.status === 'ok' ? '✅' : t.status === 'error' ? '❌' : '⚠️';
        console.log(`  ${icon} [${t.stepType}] ${t.summary}`);
        if (t.errorCode) console.log(`     错误码: ${t.errorCode}`);
        if (t.nextAction) console.log(`     下一步: ${t.nextAction}`);
      }
      console.log('');
      return false;
    }

    case '/confirm':
      return false; // 交给自然语言处理

    case '/reject':
      return false; // 交给自然语言处理

    case '/auto':
      console.log('  ✅ 已切换到自动提交模式（Agent 可自行提交事件）\n');
      return false;

    case '/manual':
      console.log('  ✅ 已切换到手动确认模式（需要用户明确确认后才提交）\n');
      return false;

    case '/quit':
      console.log('\n  再见！👋\n');
      agent.closeSession();
      return true;

    default:
      return false;
  }
}

// ---- 处理用户输入 ----
async function processInput(input: string): Promise<boolean> {
  // 检查是否是命令
  if (input.startsWith('/')) {
    return await handleCommand(input);
  }

  // 处理确认识别——交给 Agent 的自然语言意图检测
  let effectiveCommitAuthority: 'agent_authorized_for_session' | undefined = undefined;
  if (lastAutoToggle) {
    effectiveCommitAuthority = 'agent_authorized_for_session';
    lastAutoToggle = false;
  }

  // 开始输出
  console.log('');
  const startTime = Date.now();
  let tokenCount = 0;

  // 流式回调：实时输出 LLM token
  const onToken = (token: string) => {
    if (tokenCount === 0) {
      // 第一个 token 时打印 header
      process.stdout.write('🤖 \x1b[1;34m');
    }
    tokenCount++;
    process.stdout.write(token);
  };

  try {
    const result = await agent.processUserInput(input, {
      commitAuthority: effectiveCommitAuthority,
      onToken,
    });

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    // 结束流式输出样式
    if (tokenCount > 0) {
      process.stdout.write(`\x1b[0m  \x1b[90m(${elapsed}s, ${tokenCount} tokens)\x1b[0m\n`);
    } else {
      // 无 token 输出（如确认提交等快捷路径直接返回结果）
      process.stdout.write(`🤖 \x1b[1;34m(${elapsed}s)\x1b[0m\n`);
    }
    console.log('');

    printResult(result);
  } catch (err) {
    if (tokenCount > 0) process.stdout.write('\x1b[0m\n');
    console.error(`\n  \x1b[31m❌ 错误: ${err instanceof Error ? err.message : String(err)}\x1b[0m\n`);
  }

  return false;
}

let lastAutoToggle = false;

function printResult(result: Awaited<ReturnType<typeof agent.processUserInput>>) {
  // 内容已通过流式输出实时打印，这里只显示状态指示器
  const indicators: string[] = [];
  if (result.status === 'needs_user_confirmation') {
    indicators.push('⏳ 有待确认的提案');
  } else if (result.status === 'completed') {
    indicators.push('✅ 已完成');
  } else if (result.status === 'failed') {
    indicators.push('❌ 执行失败');
  } else if (result.status === 'suspended') {
    indicators.push('⏸️ 已暂停');
  }

  if (result.draft) {
    indicators.push(`📝 草案: ${result.draft.summary} [${result.draft.status}]`);
  }

  if (result.pendingProposalIds?.length) {
    indicators.push(`📋 ${result.pendingProposalIds.length} 个待提交提案`);
  }

  if (indicators.length > 0) {
    console.log(`  \x1b[90m${indicators.join('  |  ')}\x1b[0m`);
  }
}

// ---- 启动交互循环 ----
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: '\x1b[1;32m你>\x1b[0m ',
});

console.log('💡 试试说：我开了一本修仙小说，主角叫韩立，帮我设置初始世界状态\n');

rl.prompt();

let processing = false;

rl.on('line', async (line) => {
  const input = line.trim();
  if (!input) {
    rl.prompt();
    return;
  }

  // 防止并发
  if (processing) {
    console.log('  \x1b[90m请等待上一个请求完成...\x1b[0m\n');
    rl.prompt();
    return;
  }

  processing = true;

  // /auto 和 /manual 是特殊命令，需要记住状态
  if (input === '/auto') {
    lastAutoToggle = true;
    console.log('  ✅ 已切换到自动提交模式（下一轮生效）\n');
    processing = false;
    rl.prompt();
    return;
  }
  if (input === '/manual') {
    lastAutoToggle = false;
    console.log('  ✅ 已切换到手动确认模式\n');
    processing = false;
    rl.prompt();
    return;
  }

  try {
    const shouldQuit = await processInput(input);
    if (shouldQuit) {
      rl.close();
      return;
    }
  } catch (err) {
    console.error(`\n  \x1b[31m❌ 错误: ${err instanceof Error ? err.message : String(err)}\x1b[0m\n`);
  }

  processing = false;
  // 显示当前状态提示
  const state = agent.getState();
  if (state.pendingProposalIds.length > 0) {
    process.stdout.write('  \x1b[33m💡 说"就按这个提交"确认，或"再改一下"继续修改\x1b[0m\n');
  }
  rl.prompt();
});

rl.on('close', () => {
  agent.closeSession();
  process.exit(0);
});

// =============================================================================
// Evals 运行器——矛盾检出率评估
// =============================================================================
// 独立 tsx 脚本（不是 vitest），加载 dataset.json，每个场景：
//   1. :memory: Core 装配
//   2. 灌 priorFacts（直接 factStore.assert，不走审核通道）
//   3. 真实 DeepSeek 跑 agent.processUserInput(userInput)
//   4. 检查是否调 propose_event / 是否报矛盾 / 是否拒绝提交
//
// 计算指标：矛盾检出率(recall)、误报率(false positive)、提交决策正确率
// 输出 report.json + 控制台汇总（含每场景 token 成本）
//
// 用法：npx tsx tests/evals/run-eval.ts
// 需 DEEPSEEK_API_KEY
// =============================================================================

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { config } from 'dotenv';
import { SQLiteFactStoreAdapter } from '../../src/adapters/sqlite/fact-store.js';
import { SQLiteThreadStoreAdapter } from '../../src/adapters/sqlite/thread-store.js';
import { SQLiteKnowledgeStoreAdapter } from '../../src/adapters/sqlite/knowledge-store.js';
import { SQLiteEventStoreAdapter } from '../../src/adapters/sqlite/event-store.js';
import { SQLiteWritingStore } from '../../src/writing/repositories/writing-store.js';
import { SQLiteAgentStoreAdapter } from '../../src/adapters/sqlite/agent-store.js';
import { ProposalManager } from '../../src/core/proposal-manager.js';
import { RuleEngine } from '../../src/core/rule-engine.js';
import { ThreadResolver } from '../../src/core/thread-resolver.js';
import { RetconEngine } from '../../src/core/retcon-engine.js';
import { ToolService } from '../../src/core/tool-service.js';
import { SchemaExtensionManager } from '../../src/core/schema-extension-manager.js';
import { ToolRouter } from '../../src/core/tool-router.js';
import { NarrativeAgent } from '../../src/agent/narrative-agent.js';
import { DeepSeekLLMClientAdapter } from '../../src/adapters/llm/deepseek-client.js';
import { RealCoreBridge } from '../../src/writing/core-bridge/real-bridge.js';
import { AuditService } from '../../src/writing/services/audit-service.js';
import { WorkflowService } from '../../src/writing/services/workflow-service.js';
import { EntityService } from '../../src/writing/services/entity-service.js';
import { DraftService } from '../../src/writing/services/draft-service.js';
import { makeRequestContext } from '../../src/writing/services/context.js';
import type { EvalDataset, EvalScenario } from './generate-dataset.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

config();

// ---------------------------------------------------------------------------
// 单场景评估
// ---------------------------------------------------------------------------

interface ScenarioResult {
  scenarioId: string;
  title: string;
  contradictionType: string;
  expectedDetect: boolean;
  actualDetect: boolean;
  expectedReject: boolean;
  actualReject: boolean;
  /** Agent 是否调用了 propose_event */
  calledProposeEvent: boolean;
  /** 规则引擎是否硬阻断（isSafeToCommit=false） */
  engineBlocked: boolean;
  /** 规则引擎产出的 critical Thread 数 */
  engineCriticalCount: number;
  /** Agent 是否在回复中提到矛盾/冲突 */
  mentionedContradiction: boolean;
  /** 检出是否正确（true positive / true negative） */
  correct: boolean;
  /** token 用量 */
  usage?: { prompt_tokens: number; completion_tokens: number };
  /** Agent 回复摘要 */
  responseSummary: string;
}

async function runScenario(scenario: EvalScenario): Promise<ScenarioResult> {
  // 1. 装配 :memory: Core + 写作层
  const factStore = new SQLiteFactStoreAdapter(':memory:', 'default');
  const db = factStore.getDatabase();
  const threadStore = new SQLiteThreadStoreAdapter(db);
  const knowledgeStore = new SQLiteKnowledgeStoreAdapter(db);
  const eventStore = new SQLiteEventStoreAdapter(db);
  const threadResolver = new ThreadResolver();
  const proposalManager = new ProposalManager(new RuleEngine(), undefined, threadStore, threadResolver);
  const retconEngine = new RetconEngine();
  const toolService = new ToolService(factStore, knowledgeStore, eventStore, threadStore, threadResolver);
  const schemaExtensionManager = new SchemaExtensionManager(db, 'default');
  const toolRouter = new ToolRouter({
    proposalManager, retconEngine, toolService, schemaExtensionManager,
    factStore, knowledgeStore, eventStore, threadStore,
  });

  const writingStore = new SQLiteWritingStore(db);
  writingStore.createTables();
  const auditService = new AuditService(writingStore);
  const workflowService = new WorkflowService(writingStore, auditService);
  const coreBridge = new RealCoreBridge(toolRouter, writingStore, auditService);
  const entityService = new EntityService(writingStore, auditService, workflowService);
  const draftService = new DraftService(writingStore, auditService, coreBridge, workflowService);
  toolRouter.setEntityService(entityService, 'eval_project');

  // 注册 priorFacts 里的实体（直接写 entities 表，不走审核）
  const entityIds = new Set<string>();
  for (const f of scenario.priorFacts) {
    entityIds.add(f.subject);
  }
  for (const entityId of entityIds) {
    // 直接 INSERT 到 entities 表（种子数据）。
    // first_appearance NOT NULL 必填；registered_at_event 留 null（种子不关联注册事件）。
    db.prepare(
      'INSERT OR IGNORE INTO entities (id, name, kind, first_appearance) VALUES (?, ?, ?, ?)',
    ).run(entityId, entityId.replace('ent_', ''), 'entity', 1);
  }

  // 2. 灌 priorFacts（直接 assert，不走 propose_event）
  // 先建 seed event（fact 的 cause_event 有 FK 约束指向 events 表，必须先有 event 才能 assert fact）
  const seedEvent = eventStore.create({
    type: 'custom',
    description: 'eval 种子事件',
    chapter: 1,
    context: 'global',
  });
  for (const f of scenario.priorFacts) {
    factStore.assert({
      subject: f.subject,
      predicate: f.predicate,
      value: f.value,
      causeEvent: seedEvent.id,
      validFrom: f.chapter,
      context: 'global',
      certainty: 'canonical',
    });
  }

  // 3. 直接测规则引擎（确定性检测，不走 LLM）
  // 用 proposeEvent 跑沙盒推演，检查规则引擎是否产出 critical Thread（硬阻断）
  const proposeResult = proposalManager.proposeEvent({
    subject: scenario.priorFacts[0]?.subject ?? 'ent_test',
    eventType: 'custom',
    eventDescription: scenario.userInput,
    chapter: scenario.currentChapter,
    // 占位 fact_change（proposeEvent 要求至少一条；规则引擎检查基于 subject 快照 + event_description）
    factChanges: [{
      change_id: 'eval_fc_1',
      op: 'assert',
      subject: scenario.priorFacts[0]?.subject ?? 'ent_test',
      predicate: 'status',
      value: 'eval_placeholder',
    }],
    context: 'global',
  }, factStore);

  const engineThreads = proposeResult.consequences.generatedThreads;
  const engineBlocked = !proposeResult.isSafeToCommit;
  const engineCriticalThreads = engineThreads.filter(
    (t: { severity: string }) => t.severity === 'critical',
  );

  // 3b. 跑 Agent（LLM 辅助检测——软检测）
  const agentStore = new SQLiteAgentStoreAdapter(db);
  agentStore.createTables();
  const projectId = writingStore.createProject('eval_project').id;

  const llm = new DeepSeekLLMClientAdapter();
  const agent = new NarrativeAgent({
    llm, toolRouter, agentStore,
    projectId: 'default',
    limits: { maxToolSteps: 10, maxRepeatedToolFailure: 3, maxWallClockMs: 60000 },
    writingProjectId: projectId,
    writingStore, auditService, workflowService, draftService, entityService, coreBridge,
  });

  // 注入世界种子到 system prompt（可选覆盖）
  agent.startSession(`eval_${scenario.id}`);
  const result = await agent.processUserInput(
    `${scenario.worldSeed}\n\n${scenario.userInput}`,
  );

  // 4. 检查结果
  // 是否调 propose_event：查 trace 有没有 propose_event 工具调用
  const traces = agent.getState().traceBuffer;
  const calledProposeEvent = traces.some(t => t.toolName === 'propose_event');

  // 是否调 get_context_slice：查 trace 有没有查证行为（先查后推）
  const calledGetContext = traces.some(t => t.toolName === 'get_context_slice');

  // 矛盾判定（严格）：Agent 明确声明"检测到矛盾/冲突/不一致"且**拒绝继续推演**。
  // 排除"没有矛盾""不冲突"等否定表述——只匹配肯定句式。
  const strongContradictionPatterns = [
    /检测到矛盾/, /发现矛盾/, /存在矛盾/, /有矛盾/,
    /设定冲突/, /存在冲突/, /产生了冲突/,
    /不一致[:：]/, /设定不一致/,
    /不可能.*出现/, /不可能.*发生/,
    /已.*死亡.*不能/, /已.*陨落.*不能/, /已.*销毁.*不能/,
    /时序.*问题/, /悖论/,
  ];
  // 否定模式排除（含这些词的不算矛盾检出）
  const negationPatterns = [/没有.*矛盾/, /不存在.*矛盾/, /无.*冲突/, /不冲突/, /没有.*冲突/];
  const hasStrongContradiction = strongContradictionPatterns.some(p => p.test(result.content))
    && !negationPatterns.some(p => p.test(result.content));
  const mentionedContradiction = hasStrongContradiction;

  // 实际检出 = 规则引擎硬检测 OR Agent 软检测
  // 规则引擎（确定性）：proposeEvent 产出 critical Thread 或 isSafeToCommit=false
  // Agent（概率性）：回复含强矛盾声明且拒绝推演
  const actualDetect = engineBlocked || (mentionedContradiction && !calledProposeEvent);

  // 实际拒绝 = 规则引擎阻断 OR Agent 没调 propose_event
  const actualReject = engineBlocked || !calledProposeEvent;

  // 正确性判断
  const expectedDetect = scenario.expected.shouldDetectContradiction;
  const expectedReject = scenario.expected.shouldRejectCommit;
  // correct = 检出判断正确（true positive 或 true negative）
  const correct = actualDetect === expectedDetect;

  // token 统计
  const llmTraces = traces.filter(t => t.stepType === 'llm_call' && t.usage);
  const totalPrompt = llmTraces.reduce((s, t) => s + (t.usage!.prompt_tokens), 0);
  const totalCompletion = llmTraces.reduce((s, t) => s + (t.usage!.completion_tokens), 0);

  return {
    scenarioId: scenario.id,
    title: scenario.title,
    contradictionType: scenario.contradictionType,
    expectedDetect,
    actualDetect,
    expectedReject,
    actualReject,
    calledProposeEvent,
    engineBlocked,
    engineCriticalCount: engineCriticalThreads.length,
    mentionedContradiction,
    correct,
    usage: llmTraces.length > 0 ? { prompt_tokens: totalPrompt, completion_tokens: totalCompletion } : undefined,
    responseSummary: result.content.slice(0, 200),
  };
}

// ---------------------------------------------------------------------------
// 指标计算 + 报告
// ---------------------------------------------------------------------------

interface EvalMetrics {
  totalScenarios: number;
  /** 矛盾场景数 */
  contradictionScenarios: number;
  /** 控制组场景数 */
  controlScenarios: number;
  /** 矛盾检出率（recall）：应检出的矛盾中实际检出的比例 */
  recall: number;
  /** 误报率（false positive rate）：控制组中被误报矛盾的比例 */
  falsePositiveRate: number;
  /** 提交决策正确率 */
  commitDecisionAccuracy: number;
  /** 总体准确率 */
  overallAccuracy: number;
  /** 总 token 成本 */
  totalPromptTokens: number;
  totalCompletionTokens: number;
}

function calculateMetrics(results: ScenarioResult[]): EvalMetrics {
  const contradictionResults = results.filter(r => r.expectedDetect);
  const controlResults = results.filter(r => !r.expectedDetect);

  const truePositives = contradictionResults.filter(r => r.actualDetect).length;
  const falsePositives = controlResults.filter(r => r.actualDetect).length;

  const recall = contradictionResults.length > 0
    ? truePositives / contradictionResults.length : 0;
  const falsePositiveRate = controlResults.length > 0
    ? falsePositives / controlResults.length : 0;

  const commitCorrect = results.filter(r => r.actualReject === r.expectedReject).length;
  const commitDecisionAccuracy = results.length > 0
    ? commitCorrect / results.length : 0;

  const overallCorrect = results.filter(r => r.correct).length;
  const overallAccuracy = results.length > 0
    ? overallCorrect / results.length : 0;

  const totalPromptTokens = results.reduce((s, r) => s + (r.usage?.prompt_tokens ?? 0), 0);
  const totalCompletionTokens = results.reduce((s, r) => s + (r.usage?.completion_tokens ?? 0), 0);

  return {
    totalScenarios: results.length,
    contradictionScenarios: contradictionResults.length,
    controlScenarios: controlResults.length,
    recall,
    falsePositiveRate,
    commitDecisionAccuracy,
    overallAccuracy,
    totalPromptTokens,
    totalCompletionTokens,
  };
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const datasetPath = path.resolve(__dirname, 'dataset.json');
  if (!fs.existsSync(datasetPath)) {
    console.error('❌ dataset.json 不存在，先运行: npx tsx tests/evals/generate-dataset.ts');
    process.exit(1);
  }

  if (!process.env['DEEPSEEK_API_KEY']) {
    console.error('❌ DEEPSEEK_API_KEY 未配置');
    process.exit(1);
  }

  const dataset: EvalDataset = JSON.parse(fs.readFileSync(datasetPath, 'utf-8'));
  console.log(`\n🧪 NarrativeOS Evals — 矛盾检出率评估`);
  console.log(`   场景数: ${dataset.scenarios.length}（${dataset.scenarios.filter(s => s.expected.shouldDetectContradiction).length} 矛盾 + ${dataset.scenarios.filter(s => !s.expected.shouldDetectContradiction).length} 控制）\n`);

  const results: ScenarioResult[] = [];
  for (let i = 0; i < dataset.scenarios.length; i++) {
    const scenario = dataset.scenarios[i]!;
    process.stdout.write(`  [${i + 1}/${dataset.scenarios.length}] ${scenario.id} ${scenario.title}... `);
    try {
      const result = await runScenario(scenario);
      results.push(result);
      const status = result.correct ? '✅' : '❌';
      const detectLabel = result.actualDetect ? '检出矛盾' : '未检出';
      console.log(`${status} ${detectLabel}${result.usage ? ` (${result.usage.prompt_tokens + result.usage.completion_tokens} tokens)` : ''}`);
    } catch (err) {
      console.log(`💥 错误: ${err instanceof Error ? err.message.slice(0, 100) : err}`);
      results.push({
        scenarioId: scenario.id, title: scenario.title, contradictionType: scenario.contradictionType,
        expectedDetect: scenario.expected.shouldDetectContradiction, actualDetect: false,
        expectedReject: scenario.expected.shouldRejectCommit, actualReject: false,
        calledProposeEvent: false, engineBlocked: false, engineCriticalCount: 0,
        mentionedContradiction: false, correct: false,
        responseSummary: `ERROR: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  // 计算指标
  const metrics = calculateMetrics(results);

  // 控制台汇总
  console.log(`\n${'═'.repeat(50)}`);
  console.log(`  📊 评估结果`);
  console.log(`${'═'.repeat(50)}`);
  console.log(`  矛盾检出率 (recall):    ${(metrics.recall * 100).toFixed(1)}%`);
  console.log(`  误报率 (false positive): ${(metrics.falsePositiveRate * 100).toFixed(1)}%`);
  console.log(`  提交决策正确率:          ${(metrics.commitDecisionAccuracy * 100).toFixed(1)}%`);
  console.log(`  总体准确率:              ${(metrics.overallAccuracy * 100).toFixed(1)}%`);
  console.log(`  Token 成本:              ${metrics.totalPromptTokens} prompt + ${metrics.totalCompletionTokens} completion = ${metrics.totalPromptTokens + metrics.totalCompletionTokens}`);

  // 逐场景详情
  console.log(`\n  逐场景:`);
  for (const r of results) {
    const icon = r.correct ? '✅' : '❌';
    console.log(`  ${icon} ${r.scenarioId} ${r.title}`);
    console.log(`     期望:${r.expectedDetect ? '检出' : '不检出'} | 实际:${r.actualDetect ? '检出' : '不检出'} | propose:${r.calledProposeEvent ? '是' : '否'}`);
  }

  // 写 report.json
  const report = {
    version: '1.0.0',
    runAt: new Date().toISOString(),
    datasetVersion: dataset.version,
    metrics,
    results,
  };
  const reportPath = path.resolve(__dirname, 'report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf-8');
  console.log(`\n📝 报告已写入: ${reportPath}\n`);
}

main().catch((err) => {
  console.error('\n❌ eval 运行失败:', err);
  process.exit(1);
});

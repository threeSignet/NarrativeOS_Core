// =============================================================================
// 写作层端到端集成测试（Phase 7 完整闭环）
// =============================================================================
// 全部使用真实 DeepSeek LLM，无 Mock。所有 Agent 驱动场景需要 DEEPSEEK_API_KEY。
//
// 两套件：
//   A. 纯写作层场景（不经 Agent/LLM，服务层直调）——确定性，无 API key 依赖
//   B. 真实 LLM 端到端（Agent ReAct + DeepSeek + Core + 写作层全链路）
//
// 关键修复（相对原文件）：
//   - createE2EEnv 工厂 LLM 可选（纯写作层场景不需要 LLM）
//   - 修正 RealCoreBridge 三参构造（补 auditService，与生产 chat.ts:101 对齐）
// =============================================================================

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { SQLiteFactStoreAdapter } from '../../src/adapters/sqlite/fact-store.js';
import { SQLiteThreadStoreAdapter } from '../../src/adapters/sqlite/thread-store.js';
import { SQLiteKnowledgeStoreAdapter } from '../../src/adapters/sqlite/knowledge-store.js';
import { SQLiteEventStoreAdapter } from '../../src/adapters/sqlite/event-store.js';
import { SQLiteAgentStoreAdapter } from '../../src/adapters/sqlite/agent-store.js';
import { SQLiteWritingStore } from '../../src/writing/repositories/writing-store.js';
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
import { ProjectService } from '../../src/writing/services/project-service.js';
import { IdeaService } from '../../src/writing/services/idea-service.js';
import { BlueprintService } from '../../src/writing/services/blueprint-service.js';
import { DraftService } from '../../src/writing/services/draft-service.js';
import { EntityService } from '../../src/writing/services/entity-service.js';
import { WorkflowService } from '../../src/writing/services/workflow-service.js';
import { makeRequestContext } from '../../src/writing/services/context.js';
import type { LLMClient } from '../../src/types/llm.js';

/** E2E 环境返回结构——含全部真实栈组件供断言 */
interface E2EEnv {
  db: Database.Database;
  factStore: SQLiteFactStoreAdapter;
  toolRouter: ToolRouter;
  agentStore: SQLiteAgentStoreAdapter;
  agent: NarrativeAgent;
  writingStore: SQLiteWritingStore;
  auditService: AuditService;
  workflowService: WorkflowService;
  coreBridge: RealCoreBridge;
  projectService: ProjectService;
  draftService: DraftService;
  entityService: EntityService;
  blueprintService: BlueprintService;
  ideaService: IdeaService;
  projectId: string;
}

/**
 * 创建完整的端到端环境：Core + WritingLayer + Agent。
 *
 * @param llm 可选的 LLM 客户端——纯写作层场景可不传，Agent 驱动场景传 DeepSeekLLMClientAdapter。
 */
function createE2EEnv(llm?: LLMClient): E2EEnv {
  const factStore = new SQLiteFactStoreAdapter(':memory:', 'default');
  const db = factStore.getDatabase();
  const threadStore = new SQLiteThreadStoreAdapter(db);
  const knowledgeStore = new SQLiteKnowledgeStoreAdapter(db);
  const eventStore = new SQLiteEventStoreAdapter(db);
  const threadResolver = new ThreadResolver();
  const proposalManager = new ProposalManager(
    new RuleEngine(), undefined, threadStore, threadResolver,
  );
  const retconEngine = new RetconEngine();
  const toolService = new ToolService(
    factStore, knowledgeStore, eventStore, threadStore, threadResolver,
  );
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
  const coreBridge = new RealCoreBridge(toolRouter, writingStore, auditService);

  const projectService = new ProjectService(writingStore, auditService);
  const draftService = new DraftService(writingStore, auditService, coreBridge, workflowService);
  const entityService = new EntityService(writingStore, auditService, workflowService);
  const blueprintService = new BlueprintService(writingStore, auditService);
  const ideaService = new IdeaService(writingStore, auditService, draftService.createDraft.bind(draftService));

  // 创建写作层项目（必须在 Agent 之前，Agent 需要 writingProjectId）
  const projectId = writingStore.createProject('灰域科幻测试', '一对兄妹在灰域边缘求生').id;

  // Agent
  const agentStore = new SQLiteAgentStoreAdapter(db);
  agentStore.createTables();

  const agent = new NarrativeAgent({
    llm: llm ?? new DeepSeekLLMClientAdapter(),
    toolRouter,
    agentStore,
    projectId: 'default',
    limits: { maxToolSteps: 20, maxRepeatedToolFailure: 3, maxWallClockMs: 60000 },
    writingProjectId: projectId,
    writingStore,
    auditService,
    workflowService,
    draftService,
    entityService,
    coreBridge,
  });

  return {
    db, factStore, toolRouter, agentStore, agent,
    writingStore, auditService, workflowService, coreBridge,
    projectService, draftService, entityService, blueprintService, ideaService,
    projectId,
  };
}

/** 快捷：取 Core facts 计数 */
function coreFactCount(db: Database.Database): number {
  return (db.prepare('SELECT COUNT(*) as c FROM facts').get() as { c: number }).c;
}

/** 快捷：取 Core entities 计数 */
function coreEntityCount(db: Database.Database): number {
  return (db.prepare('SELECT COUNT(*) as c FROM entities').get() as { c: number }).c;
}

// =============================================================================
// 套件 A：纯写作层场景（不经 Agent/LLM，确定性）
// =============================================================================

describe('写作层端到端 · 纯写作层场景（无 LLM）', () => {
  let env: E2EEnv;

  beforeEach(() => {
    env = createE2EEnv(); // 不传 LLM，纯写作层不调用
  });

  it('E2E-001：创建作品后 Core 中 Fact 数量不变', () => {
    const beforeCount = coreFactCount(env.db);

    const project = env.writingStore.getProject(env.projectId);
    expect(project).toBeDefined();
    expect(project!.title).toBe('灰域科幻测试');
    expect(project!.status).toBe('planning');

    // Core 无任何写入
    expect(coreFactCount(env.db)).toBe(beforeCount);
    expect(coreEntityCount(env.db)).toBe(0);
  });

  it('E2E-002：灵感、蓝图、候选实体全在写作层，不写 Core', () => {
    const ctx = makeRequestContext({ projectId: env.projectId });

    const idea = env.ideaService.captureIdea(ctx, {
      content: '沈墨有嵌合体义肢，沈笙能让灰域退缩',
      kind: 'premise',
      tags: ['主角'],
    });
    expect(idea.maturity).toBe('raw');
    expect(idea.id).toMatch(/^wicd_/);

    const bp = env.blueprintService.generateBlueprintDraft(ctx, {
      naturalLanguageDescription: '灰域科幻世界',
    });
    expect(bp.maturity).toBe('drafted');
    env.blueprintService.acceptBlueprintDraft(ctx, bp.id);
    expect(env.blueprintService.getActiveBlueprint(ctx)!.maturity).toBe('active');

    const hints = env.entityService.detectEntityHints(ctx, [
      { displayName: '沈墨', typeLabel: '角色', excerpt: '有嵌合体义肢' },
      { displayName: '沈笙', typeLabel: '角色', excerpt: '能让灰域退缩' },
      { displayName: '长庚站', typeLabel: '地点', excerpt: '废弃星球首府' },
    ]);
    expect(hints.length).toBe(3);
    expect(hints.every(h => h.status === 'hint')).toBe(true);

    const sketch = env.entityService.promoteHintToSketch(ctx, hints[0]!.id, {
      displayName: '沈墨', typeLabel: '角色',
    });
    expect(sketch.status).toBe('candidate');

    // Core 无写入（候选阶段不落 Core）
    expect(coreEntityCount(env.db)).toBe(0);
  });

  it('E2E-007：关键操作应产生审计日志', () => {
    const ctx = makeRequestContext({ projectId: env.projectId });

    env.entityService.detectEntityHints(ctx, [
      { displayName: '测试角色', typeLabel: '角色' },
    ]);

    const logs = env.auditService.query(ctx);
    expect(logs.length).toBeGreaterThanOrEqual(1);
    expect(logs.map(l => l.action)).toContain('detect_entity_hints');
  });
});

// =============================================================================
// 套件 B：真实 LLM 端到端（需要 DEEPSEEK_API_KEY）
// =============================================================================

const HAS_API_KEY = !!process.env['DEEPSEEK_API_KEY'];
const describeIfReal = HAS_API_KEY ? describe : describe.skip;

describeIfReal('写作层端到端 · 真实 LLM 闭环', () => {
  it('E2E-003：实体候选→批准→CLI确认→Core注册→写作层回写', async () => {
    const env = createE2EEnv();
    const ctx = makeRequestContext({ projectId: env.projectId });

    const hints = env.entityService.detectEntityHints(ctx, [
      { displayName: '沈墨', typeLabel: '角色' },
    ]);
    const sketch = env.entityService.promoteHintToSketch(ctx, hints[0]!.id, {
      displayName: '沈墨', typeLabel: '角色',
    });
    expect(sketch.status).toBe('candidate');

    const approved = env.entityService.approveCandidate(ctx, sketch.id);
    expect(approved.status).toBe('approved');

    const decisions = env.workflowService.listPendingDecisions(ctx);
    expect(decisions.length).toBe(1);
    expect(decisions[0]!.kind).toBe('confirm_entity');

    expect(coreEntityCount(env.db)).toBe(0);

    env.agent.startSession('entity-reg-test');
    await env.agent.processUserInput('确认');

    expect(env.workflowService.listPendingDecisions(ctx).length).toBe(0);
    expect(coreEntityCount(env.db)).toBe(1);

    const registered = env.writingStore.getEntitySketch(sketch.id);
    expect(registered).toBeDefined();
    expect(registered!.status).toBe('registered');
    expect(registered!.coreEntityId).toBeTruthy();
  }, 60000);

  it('E2E-004：草案推演生成 ProposalReview 四件套 + PendingDecision', async () => {
    const env = createE2EEnv();
    const ctx = makeRequestContext({ projectId: env.projectId });

    const hints = env.entityService.detectEntityHints(ctx, [
      { displayName: '沈墨', typeLabel: '角色' },
    ]);
    const sketch = env.entityService.promoteHintToSketch(ctx, hints[0]!.id, {
      displayName: '沈墨', typeLabel: '角色',
    });
    env.entityService.approveCandidate(ctx, sketch.id);
    const regResult = await env.coreBridge.registerReviewedEntity(ctx, sketch.id);
    expect(regResult.success).toBe(true);
    const coreEntityId = regResult.coreEntityId!;

    const draft = env.draftService.createDraft(ctx, {
      kind: 'event',
      chapter: 1,
      title: '第一幕：发现黑晶碎片',
      content: '长庚站的扶梯早就停了。沈墨把沈笙拉到广告牌后面，左臂义肢的关节在冷风里轻轻咬合。黑晶碎片贴着他的掌心发热。',
    });
    env.draftService.markReadyForSimulation(ctx, draft.id);

    const { proposalView } = await env.draftService.simulateDraft(ctx, draft.id, [
      {
        change_id: 'fc_001',
        op: 'assert',
        subject: coreEntityId,
        predicate: 'status',
        value: '发现黑晶碎片',
      },
    ]);

    expect(proposalView.status).toBe('open');
    expect(proposalView.coreProposalId).toBeDefined();
    expect(proposalView.sourceDraftId).toBe(draft.id);
    expect(proposalView.factDiff).toBeDefined();
    expect(proposalView.factDiff.length).toBeGreaterThan(0);
    expect(proposalView.involvedEntityIds).toBeDefined();
    expect(proposalView.humanSummary).toBeDefined();

    expect(env.draftService.getDraft(ctx, draft.id).status).toBe('simulated');

    const decisions = env.workflowService.listPendingDecisions(ctx);
    const confirmProposal = decisions.find(d => d.kind === 'confirm_proposal');
    expect(confirmProposal).toBeDefined();
    expect(confirmProposal!.linkedObjectId).toBe(proposalView.id);

    expect(proposalView.sourceRefs).toEqual([{ kind: 'draft', id: draft.id }]);
  }, 60000);

  it('E2E-005：Agent 对话驱动——propose_event→自动确认→Core写入', async () => {
    const env = createE2EEnv();
    const ctx = makeRequestContext({ projectId: env.projectId });

    const hints = env.entityService.detectEntityHints(ctx, [
      { displayName: '沈墨', typeLabel: '角色' },
    ]);
    const sketch = env.entityService.promoteHintToSketch(ctx, hints[0]!.id, {
      displayName: '沈墨', typeLabel: '角色',
    });
    env.entityService.approveCandidate(ctx, sketch.id);
    env.agent.startSession('agent-driven');
    await env.agent.processUserInput('确认');
    const coreEntityId = env.writingStore.getEntitySketch(sketch.id)!.coreEntityId!;

    const beforeFacts = coreFactCount(env.db);
    const result = await env.agent.processUserInput(
      `沈墨在长庚站发现了一块黑晶碎片。帮我记录这个事件。实体ID是 ${coreEntityId}。`,
      { commitAuthority: 'agent_authorized_for_session' },
    );

    expect(result.status).not.toBe('failed');
    expect(result.content).toBeTruthy();
    expect(coreFactCount(env.db)).toBeGreaterThan(beforeFacts);
  }, 60000);

  it('E2E-006：查询不存在的实体不应导致 Agent 崩溃', async () => {
    const env = createE2EEnv();
    env.agent.startSession('error-recovery');

    const result = await env.agent.processUserInput('查询一个叫"不存在的角色"的实体信息');

    expect(result.status).not.toBe('failed');
    expect(result.content).toBeTruthy();
  }, 60000);

  it('E2E-008：草案修改后旧 ProposalView 自动过期', async () => {
    const env = createE2EEnv();
    const ctx = makeRequestContext({ projectId: env.projectId });

    const hints = env.entityService.detectEntityHints(ctx, [
      { displayName: '测试角色', typeLabel: '角色' },
    ]);
    const sketch = env.entityService.promoteHintToSketch(ctx, hints[0]!.id, {
      displayName: '测试角色', typeLabel: '角色',
    });
    env.entityService.approveCandidate(ctx, sketch.id);
    env.agent.startSession('expire-test');
    await env.agent.processUserInput('确认');
    const coreEntityId = env.writingStore.getEntitySketch(sketch.id)!.coreEntityId!;

    const draft = env.draftService.createDraft(ctx, {
      kind: 'event', chapter: 1,
      title: '测试事件', content: '这是一段测试内容的草案文本。',
    });
    env.draftService.markReadyForSimulation(ctx, draft.id);
    const { proposalView } = await env.draftService.simulateDraft(ctx, draft.id, [
      { change_id: 'fc_001', op: 'assert', subject: coreEntityId, predicate: 'status', value: '测试' },
    ]);
    expect(proposalView.status).toBe('open');

    env.draftService.updateDraftContent(ctx, draft.id, '修改后的草案内容完全不同了。');

    const expiredPV = env.writingStore.getProposalView(proposalView.id);
    expect(expiredPV!.status).toBe('expired');
    expect(env.workflowService.listPendingDecisions(ctx).length).toBe(0);
  }, 60000);

  it('E2E-smoke：真实 LLM 驱动一轮对话不崩溃且流程跑通', async () => {
    const env = createE2EEnv();

    env.agent.startSession('real-smoke');
    const result = await env.agent.processUserInput(
      '你好。我正在写一个科幻故事，主角叫沈墨。简单打个招呼。',
    );

    expect(result.status).not.toBe('failed');
    expect(result.content).toBeTruthy();
    expect(result.content.length).toBeGreaterThan(5);
  }, 120000);
});

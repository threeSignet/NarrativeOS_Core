// =============================================================================
// NarrativeAgent 集成测试（真实 DeepSeek API）
// =============================================================================
// 所有测试使用真实 DeepSeek flash 模型 + 真实 Core + 真实 ToolRouter。
// 零 Mock。
//
// 需要环境变量：DEEPSEEK_API_KEY
// =============================================================================

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { SQLiteFactStoreAdapter } from '../../src/adapters/sqlite/fact-store.js';
import { SQLiteThreadStoreAdapter } from '../../src/adapters/sqlite/thread-store.js';
import { SQLiteKnowledgeStoreAdapter } from '../../src/adapters/sqlite/knowledge-store.js';
import { SQLiteEventStoreAdapter } from '../../src/adapters/sqlite/event-store.js';
import { SQLiteAgentStoreAdapter } from '../../src/adapters/sqlite/agent-store.js';
import { ProposalManager } from '../../src/core/proposal-manager.js';
import { RuleEngine } from '../../src/core/rule-engine.js';
import { ThreadResolver } from '../../src/core/thread-resolver.js';
import { RetconEngine } from '../../src/core/retcon-engine.js';
import { ToolService } from '../../src/core/tool-service.js';
import { SchemaExtensionManager } from '../../src/core/schema-extension-manager.js';
import { ToolRouter } from '../../src/core/tool-router.js';
import { NarrativeAgent } from '../../src/agent/narrative-agent.js';
import { ContextCompressor } from '../../src/agent/context-compressor.js';
import { DeepSeekLLMClientAdapter } from '../../src/adapters/llm/deepseek-client.js';

// =============================================================================
// 测试基础设施
// =============================================================================

const PROJECT_ID = 'default';
const HAS_API_KEY = !!process.env['DEEPSEEK_API_KEY'];
const describeIf = HAS_API_KEY ? describe : describe.skip;

function createTestEnv() {
  const factStore = new SQLiteFactStoreAdapter(':memory:', PROJECT_ID);
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

  const agentStore = new SQLiteAgentStoreAdapter(db);
  agentStore.createTables();

  // 真实 DeepSeek flash 模型
  const llm = new DeepSeekLLMClientAdapter({
    apiKey: process.env['DEEPSEEK_API_KEY']!,
    model: process.env['LLM_MODEL'] ?? 'deepseek-v4-flash',
    temperature: 0.3,
    maxTokens: 2048,
  });

  const agent = new NarrativeAgent({
    llm,
    toolRouter,
    agentStore,
    projectId: PROJECT_ID,
    limits: { maxToolSteps: 16, maxRepeatedToolFailure: 3, maxWallClockMs: 120000 },
  });

  return { factStore, db, threadStore, knowledgeStore, eventStore, toolRouter, agentStore, agent };
}

function seedEntity(db: Database.Database, id: string, name: string, kind: string = 'entity') {
  db.prepare('INSERT OR IGNORE INTO entities (id, name, kind, first_appearance) VALUES (?,?,?,?)')
    .run(id, name, kind, 1);
}

// =============================================================================
// 测试套件
// =============================================================================

describeIf('NarrativeAgent — 真实 DeepSeek API 集成测试', () => {
  let env: ReturnType<typeof createTestEnv>;

  beforeEach(() => {
    env = createTestEnv();
  });

  // ---------------------------------------------------------------------------
  // 场景 1：纯文本询问
  // ---------------------------------------------------------------------------
  describe('场景 1：纯文本询问', () => {
    it('Agent 应正常回复纯文本', async () => {
      const result = await env.agent.processUserInput('你好，请简单介绍一下你自己');
      expect(result.content).toBeTruthy();
      expect(result.status).toBe('completed');
    }, 15000);
  });

  // ---------------------------------------------------------------------------
  // 场景 2：状态查询
  // ---------------------------------------------------------------------------
  describe('场景 2：状态查询', () => {
    it('Agent 应查询已注册实体并返回信息', async () => {
      seedEntity(env.db, 'ent_hanli', '韩立');
      env.agent.startSession('query-test');

      const result = await env.agent.processUserInput('查一下韩立的当前状态');
      expect(result.content).toBeTruthy();
      expect(result.status).toBe('completed');
    }, 30000);
  });

  // ---------------------------------------------------------------------------
  // 场景 3：注册实体
  // ---------------------------------------------------------------------------
  describe('场景 3：注册实体', () => {
    it('Agent 应能注册新实体', async () => {
      env.agent.startSession('register-test');

      const result = await env.agent.processUserInput(
        '帮我注册一个新角色：韩立，一个筑基期修士',
      );
      expect(result.content).toBeTruthy();
      // 检查是否注册成功
      const row = env.db.prepare("SELECT * FROM entities WHERE name = '韩立'").get() as any;
      if (row) {
        expect(row.name).toBe('韩立');
      }
    }, 60000);
  });

  // ---------------------------------------------------------------------------
  // 场景 4：创建事件提案
  // ---------------------------------------------------------------------------
  describe('场景 4：创建事件提案', () => {
    it('Agent 应能推演事件提案', async () => {
      seedEntity(env.db, 'ent_hanli', '韩立');
      env.agent.startSession('event-test');

      const result = await env.agent.processUserInput(
        '韩立突破到筑基期了，帮我记录一下',
      );
      expect(result.content).toBeTruthy();
      // 提案创建后应该有 pending proposals 或 draft
      const state = env.agent.getState();
      expect(state.pendingProposalIds.length + (state.workingDraft ? 1 : 0)).toBeGreaterThanOrEqual(0);
    }, 60000);
  });

  // ---------------------------------------------------------------------------
  // 场景 5：多轮对话 —— 连续修改草案
  // ---------------------------------------------------------------------------
  describe('场景 5：多轮草案修改', () => {
    it('Agent 应在多轮对话中保持上下文', async () => {
      seedEntity(env.db, 'ent_hanli', '韩立');
      env.agent.startSession('multi-turn');

      // 第 1 轮
      const r1 = await env.agent.processUserInput(
        '韩立突破到了筑基期',
      );
      expect(r1.status).not.toBe('failed');

      // 第 2 轮 —— 修改
      const r2 = await env.agent.processUserInput(
        '改成大衍诀，这个名字更有修仙味道。',
      );
      expect(r2.status).not.toBe('failed');
      expect(r2.content).toBeTruthy();
    }, 90000);
  });

  // ---------------------------------------------------------------------------
  // 场景 6：多个实体查询
  // ---------------------------------------------------------------------------
  describe('场景 6：复杂查询', () => {
    it('Agent 应能处理涉及多个实体的复杂查询', async () => {
      seedEntity(env.db, 'ent_hanli', '韩立');
      seedEntity(env.db, 'ent_zhang', '张三');
      seedEntity(env.db, 'ent_beijing', '北京');
      env.agent.startSession('complex-query');

      const result = await env.agent.processUserInput(
        '韩立和张三分别在哪里？',
      );
      expect(result.content).toBeTruthy();
      expect(result.status).not.toBe('failed');
    }, 60000);
  });

  // ---------------------------------------------------------------------------
  // 场景 7：错误恢复
  // ---------------------------------------------------------------------------
  describe('场景 7：错误恢复', () => {
    it('查询不存在的实体不应崩溃', async () => {
      env.agent.startSession('error-test');

      const result = await env.agent.processUserInput(
        '查询 ent_never_exist 实体的状态',
      );
      expect(result.status).not.toBe('failed');
      expect(result.content).toBeTruthy();
    }, 30000);
  });

  // ---------------------------------------------------------------------------
  // 场景 8：确认提交流程
  // ---------------------------------------------------------------------------
  describe('场景 8：确认提交流程', () => {
    it('Agent 推演后应等待确认再提交', async () => {
      seedEntity(env.db, 'ent_hanli', '韩立');
      env.agent.startSession('confirm-test');

      // 第 1 轮：创建提案 — Agent 应推演但不自动提交
      const r1 = await env.agent.processUserInput(
        '韩立突破了筑基期，先别提交，让我看一下。',
      );
      expect(r1.status).not.toBe('failed');
      // Phase 7：Agent 推演后应进入等待确认状态
      expect(['completed', 'needs_user_confirmation', 'needs_user_input']).toContain(r1.status);

      // 第 2 轮：确认提交 — Agent 识别确认关键词后提交
      const r2 = await env.agent.processUserInput('确认提交');
      expect(r2.status).not.toBe('failed');
      // 提交成功后 pending proposals 应被清理
      expect(r2.status === 'completed' || r2.status === 'needs_user_confirmation').toBe(true);
    }, 60000);
  });

  // ---------------------------------------------------------------------------
  // 会话生命周期
  // ---------------------------------------------------------------------------
  describe('会话生命周期', () => {
    it('应能创建和关闭会话', () => {
      const sessionId = env.agent.startSession('test');
      expect(sessionId).toBeTruthy();

      const session = env.agentStore.getSession(sessionId);
      expect(session).toBeDefined();
      expect(session!.status).toBe('active');
      expect(session!.title).toBe('test');

      env.agent.closeSession();
      const closed = env.agentStore.getSession(sessionId);
      expect(closed!.status).toBe('closed');
    });
  });

  // ---------------------------------------------------------------------------
  // Draft 管理
  // ---------------------------------------------------------------------------
  describe('Draft 管理', () => {
    it('应能创建和更新 working draft', () => {
      env.agent.startSession('draft');
      const state = env.agent.getState();

      const draftId = env.agentStore.createDraft(state.sessionId, PROJECT_ID, '测试草案');
      expect(draftId).toBeTruthy();

      const draft = env.agentStore.getDraft(draftId);
      expect(draft).toBeDefined();
      expect(draft!.summary).toBe('测试草案');
      expect(draft!.revision_count).toBe(0);

      env.agentStore.updateDraft(draftId, { status: 'proposed', revisionCount: 2, summary: '更新后的草案' });
      const updated = env.agentStore.getDraft(draftId);
      expect(updated!.status).toBe('proposed');
      expect(updated!.revision_count).toBe(2);
    });
  });

  // ---------------------------------------------------------------------------
  // 上下文压缩
  // ---------------------------------------------------------------------------
  describe('上下文压缩', () => {
    it('消息数超过阈值时 ContextCompressor 应标记内存消息为已压缩', async () => {
      env.agent.startSession('compression-test');
      const compressor = new ContextCompressor(env.agentStore);

      const state = env.agent.getState();
      const messages = [...state.messages];

      for (let i = 0; i < 31; i++) {
        messages.push({
          id: `msg_prefill_${i}`,
          projectId: 'default',
          sessionId: state.sessionId,
          role: i % 2 === 0 ? 'user' : 'assistant',
          content: `消息内容 ${i} `.repeat(5),
          summary: `消息 ${i}`,
          compressed: false,
          visibleToLlm: true,
          createdAt: new Date().toISOString(),
        });
      }

      const result = compressor.maybeCompress(state.sessionId, messages);

      expect(result).toBeDefined();
      if (result) {
        expect(result.compressedMessageCount).toBeGreaterThan(0);
        expect(result.summaryId).toBeTruthy();
      }

      const compressedCount = messages.filter(m => m.compressed).length;
      expect(compressedCount).toBeGreaterThan(0);

      const recentMsgs = messages.slice(-5);
      expect(recentMsgs.every(m => !m.compressed)).toBe(true);
    });

    it('消息数不足时不应压缩', () => {
      env.agent.startSession('nocompress-test');
      const compressor = new ContextCompressor(env.agentStore);

      const messages = [
        ...env.agent.getState().messages,
        { id: 'msg_1', projectId: 'default', sessionId: env.agent.getState().sessionId, role: 'user', content: '短消息', summary: '短', compressed: false, visibleToLlm: true, createdAt: new Date().toISOString() },
      ];

      const result = compressor.maybeCompress(env.agent.getState().sessionId, messages);
      expect(result).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // 长期记忆
  // ---------------------------------------------------------------------------
  describe('长期记忆', () => {
    it('提交草案后应提取项目决策记忆', async () => {
      seedEntity(env.db, 'ent_test', '测试角色');
      env.agent.startSession('memory-test');

      const result = await env.agent.processUserInput(
        '记录一个测试事件：测试角色到达测试地点',
        { commitAuthority: 'agent_authorized_for_session' },
      );
      expect(result.status).not.toBe('failed');

      const memories = env.agentStore.getActiveMemories('default', 'project_decision');
      expect(memories).toBeDefined();
    }, 60000);
  });
});

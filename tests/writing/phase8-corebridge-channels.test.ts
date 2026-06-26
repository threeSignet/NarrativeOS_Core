// =============================================================================
// Phase 8 CoreBridge 提交通道测试
// =============================================================================
// 验证 4 个新增提交通道的正确性：
//   1. commitReviewedThreadChange（线索变更 → resolve_thread）
//   2. commitReviewedKnowledgeChange（知识变更 → propose_event + commit_event）
//   3. commitReviewedWorldPackageChange（Schema 扩展 → commit_schema_extension）
//   4. commitReviewedRetcon（Retcon → commit_retcon）
//
// 范式对齐 core-bridge-audit.test.ts（:memory: SQLite + 真实 Core 栈）
// =============================================================================

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { SQLiteFactStoreAdapter } from '../../src/adapters/sqlite/fact-store.js';
import { SQLiteThreadStoreAdapter } from '../../src/adapters/sqlite/thread-store.js';
import { SQLiteKnowledgeStoreAdapter } from '../../src/adapters/sqlite/knowledge-store.js';
import { SQLiteEventStoreAdapter } from '../../src/adapters/sqlite/event-store.js';
import { SQLiteWritingStore } from '../../src/writing/repositories/writing-store.js';
import { ProposalManager } from '../../src/core/proposal-manager.js';
import { RuleEngine } from '../../src/core/rule-engine.js';
import { ThreadResolver } from '../../src/core/thread-resolver.js';
import { RetconEngine } from '../../src/core/retcon-engine.js';
import { ToolService } from '../../src/core/tool-service.js';
import { SchemaExtensionManager } from '../../src/core/schema-extension-manager.js';
import { ToolRouter } from '../../src/core/tool-router.js';
import { RealCoreBridge } from '../../src/writing/core-bridge/real-bridge.js';
import { AuditService } from '../../src/writing/services/audit-service.js';
import { WorkflowService } from '../../src/writing/services/workflow-service.js';
import { makeRequestContext } from '../../src/writing/services/context.js';
import type { WritingRequestContext } from '../../src/writing/services/context.js';

describe('Phase 8 · CoreBridge 提交通道', () => {
  let db: Database.Database;
  let store: SQLiteWritingStore;
  let toolRouter: ToolRouter;
  let coreBridge: RealCoreBridge;
  let ctx: WritingRequestContext;
  let projectId: string;

  beforeEach(() => {
    const factStore = new SQLiteFactStoreAdapter(':memory:', 'default');
    db = factStore.getDatabase();
    const threadStore = new SQLiteThreadStoreAdapter(db);
    const knowledgeStore = new SQLiteKnowledgeStoreAdapter(db);
    const eventStore = new SQLiteEventStoreAdapter(db);
    const threadResolver = new ThreadResolver();
    const proposalManager = new ProposalManager(new RuleEngine(), undefined, threadStore, threadResolver);
    const retconEngine = new RetconEngine();
    const toolService = new ToolService(factStore, knowledgeStore, eventStore, threadStore, threadResolver);
    const schemaExtensionManager = new SchemaExtensionManager(db);

    toolRouter = new ToolRouter({
      proposalManager, retconEngine, toolService,
      schemaExtensionManager, factStore, knowledgeStore, eventStore, threadStore,
    });

    store = new SQLiteWritingStore(db);
    store.createTables();
    const audit = new AuditService(store);
    const workflowService = new WorkflowService(store, audit);
    coreBridge = new RealCoreBridge(toolRouter, store, audit);
    projectId = store.createProject('Phase 8 测试').id;
    ctx = makeRequestContext({ projectId, trigger: 'author_action' });
  });

  // =========================================================================
  // commitReviewedThreadChange
  // =========================================================================

  describe('commitReviewedThreadChange', () => {
    it('PV 不存在时返回失败', async () => {
      const result = await coreBridge.commitReviewedThreadChange(ctx, 'wpv_not_exist');
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('PV 状态非 author_approved 时返回失败', async () => {
      const pv = store.createProposalView(projectId, {
        proposalType: 'thread',
        status: 'open',
      });
      const result = await coreBridge.commitReviewedThreadChange(ctx, pv.id);
      expect(result.success).toBe(false);
    });

    it('PV 无 simulationInputs 时返回失败', async () => {
      const pv = store.createProposalView(projectId, {
        proposalType: 'thread',
        status: 'author_approved',
      });
      const result = await coreBridge.commitReviewedThreadChange(ctx, pv.id);
      expect(result.success).toBe(false);
    });
  });

  // =========================================================================
  // commitReviewedKnowledgeChange
  // =========================================================================

  describe('commitReviewedKnowledgeChange', () => {
    it('PV 不存在时返回失败', async () => {
      const result = await coreBridge.commitReviewedKnowledgeChange(ctx, 'wpv_not_exist');
      expect(result.success).toBe(false);
    });

    it('PV 状态非 author_approved 时返回失败', async () => {
      const pv = store.createProposalView(projectId, {
        proposalType: 'knowledge',
        status: 'open',
      });
      const result = await coreBridge.commitReviewedKnowledgeChange(ctx, pv.id);
      expect(result.success).toBe(false);
    });

    it('PV 无 simulationInputs 时返回失败', async () => {
      const pv = store.createProposalView(projectId, {
        proposalType: 'knowledge',
        status: 'author_approved',
      });
      const result = await coreBridge.commitReviewedKnowledgeChange(ctx, pv.id);
      expect(result.success).toBe(false);
    });
  });

  // =========================================================================
  // commitReviewedWorldPackageChange
  // =========================================================================

  describe('commitReviewedWorldPackageChange', () => {
    it('PV 不存在时返回失败', async () => {
      const result = await coreBridge.commitReviewedWorldPackageChange(ctx, 'wpv_not_exist');
      expect(result.success).toBe(false);
    });

    it('PV 状态非 author_approved 时返回失败', async () => {
      const pv = store.createProposalView(projectId, {
        proposalType: 'schema_extension',
        status: 'open',
      });
      const result = await coreBridge.commitReviewedWorldPackageChange(ctx, pv.id);
      expect(result.success).toBe(false);
    });

    it('PV 无 coreProposalId 时返回失败', async () => {
      const pv = store.createProposalView(projectId, {
        proposalType: 'schema_extension',
        status: 'author_approved',
      });
      const result = await coreBridge.commitReviewedWorldPackageChange(ctx, pv.id);
      expect(result.success).toBe(false);
    });
  });

  // =========================================================================
  // commitReviewedRetcon
  // =========================================================================

  describe('commitReviewedRetcon', () => {
    it('PV 不存在时返回失败', async () => {
      const result = await coreBridge.commitReviewedRetcon(ctx, 'wpv_not_exist');
      expect(result.success).toBe(false);
    });

    it('PV 状态非 author_approved 时返回失败', async () => {
      const pv = store.createProposalView(projectId, {
        proposalType: 'retcon',
        status: 'open',
      });
      const result = await coreBridge.commitReviewedRetcon(ctx, pv.id);
      expect(result.success).toBe(false);
    });

    it('PV 无 coreProposalId 时返回失败', async () => {
      const pv = store.createProposalView(projectId, {
        proposalType: 'retcon',
        status: 'author_approved',
      });
      const result = await coreBridge.commitReviewedRetcon(ctx, pv.id);
      expect(result.success).toBe(false);
    });
  });

  // =========================================================================
  // 审计验证
  // =========================================================================

  describe('审计验证', () => {
    it('每种提交通道失败时都记录审计', async () => {
      // 不存在的 PV → 失败审计
      await coreBridge.commitReviewedThreadChange(ctx, 'wpv_not_exist');
      await coreBridge.commitReviewedKnowledgeChange(ctx, 'wpv_not_exist');
      await coreBridge.commitReviewedWorldPackageChange(ctx, 'wpv_not_exist');
      await coreBridge.commitReviewedRetcon(ctx, 'wpv_not_exist');

      const logs = store.queryAuditLogs(projectId, { limit: 20 });
      const actions = logs.map(l => l.action);
      expect(actions).toContain('commit_thread_change');
      expect(actions).toContain('commit_knowledge_change');
      expect(actions).toContain('commit_schema_extension');
      expect(actions).toContain('commit_retcon');
      expect(logs.every(l => l.result === 'failure')).toBe(true);
    });
  });
});

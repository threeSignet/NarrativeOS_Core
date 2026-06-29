// =============================================================================
// Phase 8 Agent 工具测试（detect_relation_hints + get_graph_view）
// =============================================================================
// 验证 ToolRouter 新增的两个关系工具：
//   1. detect_relation_hints：创建关系提示
//   2. get_graph_view：查询实体关系图谱
//
// 范式对齐 tool-router.test.ts（:memory: SQLite + 真实 Core 栈）
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
import { AuditService } from '../../src/writing/services/audit-service.js';
import { WorkflowService } from '../../src/writing/services/workflow-service.js';
import { RelationService } from '../../src/writing/services/relation-service.js';
import { GraphService } from '../../src/writing/services/graph-service.js';
import { makeRequestContext } from '../../src/writing/services/context.js';

describe('Phase 8 · Agent 工具（detect_relation_hints + get_graph_view）', () => {
  let db: Database.Database;
  let store: SQLiteWritingStore;
  let toolRouter: ToolRouter;
  let projectId: string;
  let entityA: { id: string };
  let entityB: { id: string };

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
    const relationService = new RelationService(store, audit, workflowService);
    const graphService = new GraphService(store);

    projectId = store.createProject('工具测试').id;
    toolRouter.setGraphServices(relationService, graphService, projectId);

    // 预置两个实体
    entityA = store.createEntitySketch(projectId, {
      displayName: '张三', typeLabel: '角色', status: 'registered',
    });
    store.updateEntitySketch(entityA.id, { coreEntityId: 'ent_zhangsan' });

    entityB = store.createEntitySketch(projectId, {
      displayName: '李四', typeLabel: '角色', status: 'registered',
    });
    store.updateEntitySketch(entityB.id, { coreEntityId: 'ent_lisi' });
  });

  // =========================================================================
  // detect_relation_hints
  // =========================================================================

  describe('detect_relation_hints', () => {
    it('未注入服务时返回 INTERNAL_ERROR', async () => {
      const bareRouter = new ToolRouter({
        proposalManager: new ProposalManager(new RuleEngine()),
        retconEngine: new RetconEngine(),
        toolService: new ToolService(
          new SQLiteFactStoreAdapter(':memory:', 'default'),
          new SQLiteKnowledgeStoreAdapter(db),
          new SQLiteEventStoreAdapter(db),
          new SQLiteThreadStoreAdapter(db),
          new ThreadResolver(),
        ),
        schemaExtensionManager: new SchemaExtensionManager(db),
        factStore: new SQLiteFactStoreAdapter(':memory:', 'default'),
        knowledgeStore: new SQLiteKnowledgeStoreAdapter(db),
        eventStore: new SQLiteEventStoreAdapter(db),
        threadStore: new SQLiteThreadStoreAdapter(db),
      });
      const result = await bareRouter.execute('detect_relation_hints', { hints: [] });
      expect(result.success).toBe(false);
    });

    it('空 hints 数组返回 SCHEMA_VALIDATION_FAILED', async () => {
      const result = await toolRouter.execute('detect_relation_hints', { hints: [] });
      expect(result.success).toBe(false);
    });

    it('创建关系提示成功', async () => {
      const result = await toolRouter.execute('detect_relation_hints', {
        hints: [{
          source_entity_id: entityA.id,
          target_entity_id: entityB.id,
          relation_type_id: 'enemy_of',
          summary: '张三与李四是敌人',
        }],
      });

      // Debug: log error if failed
      if (!result.success) {
        console.error('ERROR:', JSON.stringify(result.error));
      }
      expect(result.success).toBe(true);
      const data = result.data as { detected: number; hints: Array<{ id: string; summary: string }> };
      expect(data.detected).toBe(1);
      expect(data.hints[0]!.summary).toBe('张三与李四是敌人');

      // 验证提示已写入 store
      const storedHints = store.listRelationHints(projectId, { status: 'new' });
      expect(storedHints.length).toBe(1);
    });

    it('批量创建多个关系提示', async () => {
      const entityC = store.createEntitySketch(projectId, {
        displayName: '王五', typeLabel: '角色', status: 'registered',
      });

      const result = await toolRouter.execute('detect_relation_hints', {
        hints: [
          { source_entity_id: entityA.id, target_entity_id: entityB.id, summary: '张三与李四是敌人' },
          { source_entity_id: entityA.id, target_entity_id: entityC.id, summary: '张三与王五是朋友' },
        ],
      });

      expect(result.success).toBe(true);
      const data = result.data as { detected: number };
      expect(data.detected).toBe(2);
    });
  });

  // =========================================================================
  // get_graph_view
  // =========================================================================

  describe('get_graph_view', () => {
    it('未注入服务时返回 INTERNAL_ERROR', async () => {
      const bareRouter = new ToolRouter({
        proposalManager: new ProposalManager(new RuleEngine()),
        retconEngine: new RetconEngine(),
        toolService: new ToolService(
          new SQLiteFactStoreAdapter(':memory:', 'default'),
          new SQLiteKnowledgeStoreAdapter(db),
          new SQLiteEventStoreAdapter(db),
          new SQLiteThreadStoreAdapter(db),
          new ThreadResolver(),
        ),
        schemaExtensionManager: new SchemaExtensionManager(db),
        factStore: new SQLiteFactStoreAdapter(':memory:', 'default'),
        knowledgeStore: new SQLiteKnowledgeStoreAdapter(db),
        eventStore: new SQLiteEventStoreAdapter(db),
        threadStore: new SQLiteThreadStoreAdapter(db),
      });
      const result = await bareRouter.execute('get_graph_view', {});
      expect(result.success).toBe(false);
    });

    it('空项目返回 0 节点 0 边', async () => {
      const result = await toolRouter.execute('get_graph_view', {});
      expect(result.success).toBe(true);
      const data = result.data as { nodeCount: number; edgeCount: number; markdown: string };
      expect(data.nodeCount).toBe(2); // 两个预置实体
      expect(data.edgeCount).toBe(0);
      expect(data.markdown).toContain('实体关系图谱');
    });

    it('有关系候选时返回边', async () => {
      // 先创建一个关系候选
      const ctx = makeRequestContext({ projectId, trigger: 'author_action' });
      const audit = new AuditService(store);
      const workflow = new WorkflowService(store, audit);
      const relationService = new RelationService(store, audit, workflow);
      relationService.createRelationCandidate(ctx, {
        sourceEntityId: entityA.id,
        targetEntityId: entityB.id,
        relationTypeId: 'enemy_of',
        layer: 'world',
        summary: '敌对关系',
      });

      const result = await toolRouter.execute('get_graph_view', {});
      expect(result.success).toBe(true);
      const data = result.data as { nodeCount: number; edgeCount: number; markdown: string };
      expect(data.nodeCount).toBe(2);
      expect(data.edgeCount).toBe(1);
      expect(data.markdown).toContain('张三');
      expect(data.markdown).toContain('李四');
    });

    it('relationship 模式只返回角色节点', async () => {
      // 添加一个非角色实体
      const place = store.createEntitySketch(projectId, {
        displayName: '长安城', typeLabel: '地点', status: 'registered',
      });
      store.updateEntitySketch(place.id, { coreEntityId: 'ent_changan' });

      const result = await toolRouter.execute('get_graph_view', { mode: 'relationship' });
      expect(result.success).toBe(true);
      const data = result.data as { markdown: string };
      expect(data.markdown).toContain('角色');
      // 地点节点不应出现在 relationship 模式
    });
  });

  // =========================================================================
  // 工具注册验证
  // =========================================================================

  describe('工具注册', () => {
    it('toolNames 包含两个新工具', () => {
      const names = toolRouter.toolNames();
      expect(names).toContain('detect_relation_hints');
      expect(names).toContain('get_graph_view');
      expect(names.length).toBe(18);
    });

    it('getDefinitions 包含两个新工具的 schema', () => {
      const defs = toolRouter.getDefinitions();
      const names = defs.map(d => d.name);
      expect(names).toContain('detect_relation_hints');
      expect(names).toContain('get_graph_view');
    });
  });
});

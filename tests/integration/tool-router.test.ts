// =============================================================================
// Phase 6B 测试：ToolRouter
// =============================================================================

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { SQLiteFactStoreAdapter } from '../../src/adapters/sqlite/fact-store.js';
import { SQLiteThreadStoreAdapter } from '../../src/adapters/sqlite/thread-store.js';
import { SQLiteKnowledgeStoreAdapter } from '../../src/adapters/sqlite/knowledge-store.js';
import { SQLiteEventStoreAdapter } from '../../src/adapters/sqlite/event-store.js';
import { ProposalManager } from '../../src/core/proposal-manager.js';
import { RuleEngine } from '../../src/core/rule-engine.js';
import { ThreadResolver } from '../../src/core/thread-resolver.js';
import { RetconEngine } from '../../src/core/retcon-engine.js';
import { ToolService } from '../../src/core/tool-service.js';
import { SchemaExtensionManager } from '../../src/core/schema-extension-manager.js';
import { ToolRouter } from '../../src/core/tool-router.js';
import { ToolErrorCode } from '../../src/types.js';

// =============================================================================
// 测试套件
// =============================================================================

describe('ToolRouter', () => {
  let router: ToolRouter;
  let factStore: SQLiteFactStoreAdapter;
  let db: Database.Database;
  let threadStore: SQLiteThreadStoreAdapter;
  let eventStore: SQLiteEventStoreAdapter;

  beforeEach(() => {
    factStore = new SQLiteFactStoreAdapter(':memory:', 'default');
    db = factStore.getDatabase();
    threadStore = new SQLiteThreadStoreAdapter(db);
    const knowledgeStore = new SQLiteKnowledgeStoreAdapter(db);
    eventStore = new SQLiteEventStoreAdapter(db);
    const threadResolver = new ThreadResolver();

    const proposalManager = new ProposalManager(
      new RuleEngine(), undefined, threadStore, threadResolver,
    );
    const retconEngine = new RetconEngine();
    const toolService = new ToolService(
      factStore, knowledgeStore, eventStore, threadStore, threadResolver,
    );
    const schemaExtensionManager = new SchemaExtensionManager(db);

    router = new ToolRouter({
      proposalManager,
      retconEngine,
      toolService,
      schemaExtensionManager,
      factStore,
      knowledgeStore,
      eventStore,
      threadStore,
    });

    // 注册测试实体
    db.exec(`INSERT INTO entities (id, name, kind, first_appearance) VALUES ('ent_zhangsan', '张三', 'entity', 1)`);
    db.exec(`INSERT INTO entities (id, name, kind, first_appearance) VALUES ('ent_lisi', '李四', 'entity', 1)`);
  });

  // ---------------------------------------------------------------------------
  // 基础功能
  // ---------------------------------------------------------------------------

  describe('基础功能', () => {
    it('getDefinitions() 应返回 10 个工具定义', () => {
      const defs = router.getDefinitions();
      expect(defs).toHaveLength(10);
      const names = defs.map(d => d.name).sort();
      expect(names).toEqual([
        'commit_event', 'commit_retcon', 'commit_schema_extension',
        'get_context_slice', 'get_open_threads', 'propose_event',
        'propose_retcon', 'propose_schema_extension', 'register_entity',
        'resolve_thread',
      ]);
    });

    it('toolNames() 应返回 10 个名称', () => {
      expect(router.toolNames()).toHaveLength(10);
    });

    it('每个 ToolDefinition 应有 name/description/parameters', () => {
      for (const def of router.getDefinitions()) {
        expect(def.name).toBeTruthy();
        expect(def.description).toBeTruthy();
        expect(def.parameters).toBeDefined();
        expect(def.parameters.type).toBe('object');
      }
    });

    it('调用不存在的工具应返回 UNKNOWN_TOOL 错误', async () => {
      const result = await router.execute('nonexistent_tool', {});
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(ToolErrorCode.UNKNOWN_TOOL);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Tool 1: get_context_slice
  // ---------------------------------------------------------------------------

  describe('Tool 1: get_context_slice', () => {
    it('应返回实体档案', async () => {
      const result = await router.execute('get_context_slice', {
        entity_id: 'ent_zhangsan',
        current_chapter: 1,
        entity_names: { ent_zhangsan: '张三', ent_lisi: '李四' },
      });

      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as any;
        expect(data.profileMarkdown).toContain('张三');
        expect(data.factIndex).toBeDefined();
      }
    });

    it('entity_id 缺失应返回 SCHEMA_VALIDATION_FAILED', async () => {
      const result = await router.execute('get_context_slice', {
        current_chapter: 1,
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(ToolErrorCode.SCHEMA_VALIDATION_FAILED);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Tool 2: propose_event
  // ---------------------------------------------------------------------------

  describe('Tool 2: propose_event', () => {
    it('应成功执行沙盒推演', async () => {
      const result = await router.execute('propose_event', {
        event_type: 'test',
        event_description: '测试事件',
        chapter: 1,
        subject: 'ent_zhangsan',
        context: 'global',
        fact_changes: [
          { change_id: 'c1', op: 'assert', subject: 'ent_zhangsan', predicate: 'status', value: '测试状态' },
        ],
      });

      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as any;
        expect(data.proposalId).toBeTruthy();
        expect(data.simulationReportMarkdown).toBeTruthy();
      }
    });

    it('应兼容旧版 changes JSON 字符串参数', async () => {
      const result = await router.execute('propose_event', {
        event_type: 'test_legacy',
        event_description: '测试旧接口',
        chapter: 1,
        subject: 'ent_zhangsan',
        context: 'global',
        changes: '[{"change_id":"c1","op":"assert","subject":"ent_zhangsan","predicate":"status","value":"旧接口状态"}]',
      });

      expect(result.success).toBe(true);
    });

    it('工具定义应向 LLM 暴露结构化 fact_changes 数组', () => {
      const def = router.getDefinitions().find(d => d.name === 'propose_event')!;
      const params = def.parameters as any;

      expect(params.required).toContain('fact_changes');
      expect(params.required).not.toContain('changes');
      expect(params.properties.fact_changes.type).toBe('array');
      expect(params.properties.fact_changes.items.properties.op.enum).toEqual(['assert', 'retract', 'update']);
    });

    it('参数缺失应返回错误', async () => {
      const result = await router.execute('propose_event', {
        event_type: 'test',
        // 缺少 event_description, chapter, fact_changes
      });

      expect(result.success).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Tool 3: commit_event
  // ---------------------------------------------------------------------------

  describe('Tool 3: commit_event', () => {
    it('应成功提交已通过的提案', async () => {
      // 先用 propose_event 创建提案
      const propose = await router.execute('propose_event', {
        event_type: 'test_commit',
        event_description: '测试提交',
        chapter: 1,
        subject: 'ent_zhangsan',
        context: 'global',
        fact_changes: [
          { change_id: 'c1', op: 'assert', subject: 'ent_zhangsan', predicate: 'weapon', value: '青竹剑' },
        ],
      });
      expect(propose.success).toBe(true);
      const proposalId = (propose as any).data.proposalId;

      // 提交
      const result = await router.execute('commit_event', {
        proposal_id: proposalId,
      });

      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as any;
        expect(data.event_id).toBeTruthy();
        expect(data.committed_fact_count).toBeGreaterThan(0);
      }
    });

    it('不存在的 proposal_id 应返回 PROPOSAL_NOT_FOUND', async () => {
      const result = await router.execute('commit_event', {
        proposal_id: 'nonexistent',
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(ToolErrorCode.PROPOSAL_NOT_FOUND);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Tool 6: resolve_thread
  // ---------------------------------------------------------------------------

  describe('Tool 6: resolve_thread', () => {
    beforeEach(() => {
      // 创建测试事件用于 resolution
      const evtId = eventStore.create({
        kind: 'business', type: 'test', chapter: 1, description: '测试',
        params: {}, context: 'global', timestamp: new Date().toISOString(),
        factGroupId: 'evt_resolve_test', resolvedThreads: [], dependentFactIds: [],
      }).id;
      // 存到 this 的变体中以供后续引用——直接用闭包
    });

    it('应成功关闭一条线索', async () => {
      // 先创建一个待关闭的线程
      const event = eventStore.create({
        kind: 'business', type: 'setup', chapter: 1, description: 'setup',
        params: {}, context: 'global', timestamp: new Date().toISOString(),
        factGroupId: 'evt_setup', resolvedThreads: [], dependentFactIds: [],
      });

      const thread = threadStore.create({
        type: 'foreshadowing', direction: 'retroactive', severity: 'major',
        description: '待关闭线索', closeCondition: { customRule: 'manual_only' },
        status: 'UNFILLED', closedBy: null, createdAtEvent: event.id,
        createdAtChapter: 1, milestones: [], relatedEntities: [], upstreamFactIds: [],
      });

      const result = await router.execute('resolve_thread', {
        thread_id: thread.id,
        resolution_event_id: event.id,
        chapter: 1,
        explanation: '测试关闭',
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect((result.data as any).status).toBe('resolved');
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Tool 8: register_entity
  // ---------------------------------------------------------------------------

  describe('Tool 8: register_entity', () => {
    it('应成功注册新实体', async () => {
      const result = await router.execute('register_entity', {
        name: 'wangwu',
        kind: 'entity',
        description: '王五',
        chapter: 1,
      });

      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as any;
        expect(data.entity_id).toMatch(/^ent_/);
        expect(data.entity.name).toBe('wangwu');
      }
    });

    it('name 缺失应返回错误', async () => {
      const result = await router.execute('register_entity', {
        kind: 'entity',
        chapter: 1,
      });

      expect(result.success).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Tool 9/10: schema_extension
  // ---------------------------------------------------------------------------

  describe('Tool 9/10: schema_extension', () => {
    it('应成功提议谓词扩展', async () => {
      const result = await router.execute('propose_schema_extension', {
        chapter: 1,
        new_predicates: [{
          name: 'flight_ability',
          displayName: '飞行能力',
          valueType: 'scalar',
          description: '是否具备飞行能力',
          relationKind: 'state',
        }],
      });

      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as any;
        expect(data.total_proposed).toBe(1);
        expect(data.proposals[0].conflicts).toHaveLength(0);
      }
    });

    it('提交不存在的 proposal 应返回错误', async () => {
      const result = await router.execute('commit_schema_extension', {
        proposal_id: 'nonexistent',
      });

      expect(result.success).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Tool 7: get_open_threads
  // ---------------------------------------------------------------------------

  describe('Tool 7: get_open_threads', () => {
    it('应返回空线索清单', async () => {
      const result = await router.execute('get_open_threads', {
        current_chapter: 1,
      });

      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as any;
        expect(data.totalOpen).toBe(0);
        expect(data.threadsMarkdown).toBeTruthy();
      }
    });
  });
});

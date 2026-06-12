// =============================================================================
// Phase 3B 测试：Tool 6 resolve_thread + Tool 9/10 Schema Extension
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
import { SchemaExtensionManager } from '../../src/core/schema-extension-manager.js';

// =============================================================================
// Tool 6: resolve_thread
// =============================================================================

describe('Tool 6: resolve_thread', () => {
  let manager: ProposalManager;
  let threadStore: SQLiteThreadStoreAdapter;
  let factStore: SQLiteFactStoreAdapter;
  let testEventId: string;
  let testEventId2: string;

  beforeEach(() => {
    factStore = new SQLiteFactStoreAdapter(':memory:', 'default');
    const db = factStore.getDatabase();
    threadStore = new SQLiteThreadStoreAdapter(db);
    db.exec(`INSERT INTO entities (id, name, kind, first_appearance) VALUES ('ent_test', '测试', 'entity', 1)`);
    const eventStore = new SQLiteEventStoreAdapter(db);
    testEventId = eventStore.create({
      kind: 'business', type: 'test', chapter: 1, description: '测试事件',
      params: {}, context: 'global', timestamp: new Date().toISOString(),
      factGroupId: 'evt_test_1', resolvedThreads: [], dependentFactIds: [],
    }).id;
    testEventId2 = eventStore.create({
      kind: 'business', type: 'test2', chapter: 2, description: '测试事件2',
      params: {}, context: 'global', timestamp: new Date().toISOString(),
      factGroupId: 'evt_test_2', resolvedThreads: [], dependentFactIds: [],
    }).id;
    manager = new ProposalManager(new RuleEngine(), undefined, threadStore, new ThreadResolver());
  });

  it('应成功关闭回溯型线索 → FILLED', () => {
    const thread = threadStore.create({
      type: 'foreshadowing', direction: 'retroactive', severity: 'major',
      description: '回溯型测试', closeCondition: { customRule: 'manual_only' },
      status: 'UNFILLED', closedBy: null, createdAtEvent: testEventId,
      createdAtChapter: 1, milestones: [], relatedEntities: [], upstreamFactIds: [],
    });

    const result = manager.resolveThread({
      threadId: thread.id,
      resolutionEventId: testEventId,
      chapter: 1, explanation: '作者确认此线索已填补',
    });

    expect(result.status).toBe('resolved');
    const updated = threadStore.getById(thread.id);
    expect(updated!.status).toBe('FILLED');
    expect(updated!.closedBy).toBe(testEventId);
  });

  it('应成功关闭渐进型线索 → RESOLVED', () => {
    const thread = threadStore.create({
      type: 'foreshadowing', direction: 'progressive', severity: 'major',
      description: '渐进型测试', closeCondition: { customRule: 'manual_only' },
      status: 'HINTED', closedBy: null, createdAtEvent: testEventId,
      createdAtChapter: 1, milestones: [], relatedEntities: [], upstreamFactIds: [],
    });

    const result = manager.resolveThread({
      threadId: thread.id, resolutionEventId: testEventId2, chapter: 1, explanation: '揭示完成',
    });

    expect(result.status).toBe('resolved');
    expect(threadStore.getById(thread.id)!.status).toBe('RESOLVED');
  });

  it('应支持手动指定目标状态（ABANDONED）', () => {
    const thread = threadStore.create({
      type: 'foreshadowing', direction: 'progressive', severity: 'minor',
      description: '放弃测试', closeCondition: {},
      status: 'PLANTED', closedBy: null, createdAtEvent: testEventId,
      createdAtChapter: 1, milestones: [], relatedEntities: [], upstreamFactIds: [],
    });

    const result = manager.resolveThread({
      threadId: thread.id, resolutionEventId: testEventId2,
      chapter: 1, explanation: '剧情方向改变，放弃此线索', newStatus: 'ABANDONED',
    });

    expect(result.status).toBe('resolved');
    expect(threadStore.getById(thread.id)!.status).toBe('ABANDONED');
  });

  it('已关闭线索应拒绝重复关闭', () => {
    const thread = threadStore.create({
      type: 'foreshadowing', direction: 'retroactive', severity: 'major',
      description: '已关闭', closeCondition: {},
      status: 'FILLED', closedBy: testEventId, createdAtEvent: testEventId,
      createdAtChapter: 1, milestones: [], relatedEntities: [], upstreamFactIds: [],
    });

    const result = manager.resolveThread({
      threadId: thread.id, resolutionEventId: testEventId2, chapter: 1, explanation: '再次尝试',
    });

    expect(result.status).toBe('rejected');
    expect(result.message).toContain('ALREADY_CLOSED');
  });

  it('不存在的线索应返回 rejected', () => {
    const result = manager.resolveThread({
      threadId: 'thr_nonexistent',
      resolutionEventId: testEventId,
      chapter: 1, explanation: '不存在',
    });

    expect(result.status).toBe('rejected');
    expect(result.message).toContain('NOT_FOUND');
  });

  it('未配置 ThreadStore 时应返回 rejected', () => {
    const bareManager = new ProposalManager();
    const result = bareManager.resolveThread({
      threadId: 'thr_any', resolutionEventId: 'evt_any', chapter: 1, explanation: '无 store',
    });
    expect(result.status).toBe('rejected');
  });
});

// =============================================================================
// Tool 9/10: propose/commit_schema_extension
// =============================================================================

describe('Tool 9/10: Schema Extension', () => {
  let db: Database.Database;
  let sem: SchemaExtensionManager;

  beforeEach(() => {
    db = new Database(':memory:');
    // 创建与 FactStore 相同的表结构（包括 wp_* 表）
    const factStore = new SQLiteFactStoreAdapter(':memory:', 'default');
    db = factStore.getDatabase();
    sem = new SchemaExtensionManager(db);
  });

  describe('propose_schema_extension', () => {
    it('应成功生成谓词扩展提案', () => {
      const proposal = sem.proposePredicate({
        name: 'teleport_array',
        displayName: '传送阵',
        valueType: 'scalar',
        description: '空间传送设施',
      });

      expect(proposal.proposalId.startsWith('prp_schema_')).toBe(true);
      expect(proposal.extensionType).toBe('predicate');
      expect(proposal.conflicts).toHaveLength(0);
      expect(proposal.summary).toContain('teleport_array');
    });

    it('应与已有谓词检测冲突', () => {
      // 先提交一个谓词
      sem.proposePredicate({ name: 'teleport_array', displayName: '传送阵', valueType: 'scalar' });
      const p1 = sem.getProposal('prp_schema_01')!;
      sem.commitExtension(p1.proposalId);

      // 再次提议同名谓词
      const proposal = sem.proposePredicate({
        name: 'teleport_array', displayName: '重复传送阵', valueType: 'scalar',
      });

      expect(proposal.conflicts.length).toBeGreaterThan(0);
      expect(proposal.conflicts[0]).toContain('已存在');
    });

    it('应成功生成规则扩展提案', () => {
      const proposal = sem.proposeRule({
        id: 'wp_rule_001',
        type: 'constraint',
        name: '测试约束',
        definition: {
          id: 'wp_rule_001', type: 'constraint', name: '测试约束',
          description: '', priority: 1,
          conditions: [{ type: 'subject_match', field: 'status', operator: 'eq', value: 'alive' }],
        },
      });

      expect(proposal.conflicts).toHaveLength(0);
      expect(proposal.extensionType).toBe('rule');
    });

    it('应成功生成实体模板提案', () => {
      const proposal = sem.proposeEntityTemplate({
        name: 'artifact_weapon',
        kind: 'entity',
        defaultPredicates: ['rank', 'owner', 'ability'],
        description: '法器模板',
      });

      expect(proposal.conflicts).toHaveLength(0);
      expect(proposal.extensionType).toBe('entity_template');
    });

    it('应成功生成作用域预设提案', () => {
      const proposal = sem.proposeScopePreset({
        name: 'dream_realm',
        displayName: '梦境领域',
        defaultExitBehavior: 'suggest_discard',
        description: '梦境作用域',
      });

      expect(proposal.conflicts).toHaveLength(0);
      expect(proposal.extensionType).toBe('scope_preset');
    });
  });

  describe('commit_schema_extension', () => {
    it('应成功提交谓词扩展', () => {
      const proposal = sem.proposePredicate({
        name: 'technique',
        displayName: '功法',
        valueType: 'scalar',
        description: '修炼功法',
      });

      const result = sem.commitExtension(proposal.proposalId);

      expect(result.status).toBe('success');
      expect(result.affectedTables).toContain('wp_predicates');
      expect(result.newPredicateNames).toContain('technique');
      expect(result.schemaEventId).toBeDefined();
      expect(result.schemaEventId!.startsWith('evt_schema_')).toBe(true);

      // 验证系统事件
      const event = db.prepare('SELECT * FROM events WHERE id = ?').get(result.schemaEventId!) as any;
      expect(event.kind).toBe('system');
      expect(event.type).toBe('schema');

      // 验证 wp_ 表写入
      const row = db.prepare('SELECT * FROM wp_predicates WHERE name = ?').get('technique') as any;
      expect(row).toBeDefined();
      expect(row.display_name).toBe('功法');
    });

    it('应成功提交规则扩展', () => {
      const proposal = sem.proposeRule({
        id: 'wp_rule_combat',
        type: 'transition',
        name: '战斗规则',
        definition: {
          id: 'wp_rule_combat', type: 'transition', name: '战斗规则',
          description: '检测战斗触发', priority: 1,
          conditions: [{ type: 'subject_match', field: 'action', operator: 'eq', value: 'attack' }],
        },
      });

      const result = sem.commitExtension(proposal.proposalId);

      expect(result.status).toBe('success');
      expect(result.affectedTables).toContain('wp_rules');
      expect(result.newRuleIds).toContain('wp_rule_combat');
    });

    it('应成功提交实体模板扩展', () => {
      const proposal = sem.proposeEntityTemplate({
        name: 'beast_template',
        kind: 'entity',
        defaultPredicates: ['species', 'power_level', 'territory'],
      });

      const result = sem.commitExtension(proposal.proposalId);

      expect(result.status).toBe('success');
      expect(result.affectedTables).toContain('wp_entity_templates');
    });

    it('重复提交应失败', () => {
      const proposal = sem.proposePredicate({
        name: 'unique_pred', displayName: '独有', valueType: 'scalar',
      });
      sem.commitExtension(proposal.proposalId);
      const result2 = sem.commitExtension(proposal.proposalId);

      expect(result2.status).toBe('failed');
      expect(result2.errorMessage).toContain('ALREADY_COMMITTED');
    });

    it('不存在的 proposal 应失败', () => {
      const result = sem.commitExtension('prp_schema_999');
      expect(result.status).toBe('failed');
      expect(result.errorMessage).toContain('PROPOSAL_NOT_FOUND');
    });
  });
});

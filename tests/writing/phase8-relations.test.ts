// =============================================================================
// Phase 8 测试：关系候选 / 创作关联 / 检测提示 / GraphView 投影
// =============================================================================
// 范式对齐 core-bridge-audit.test.ts（:memory: SQLite + 真实栈）
// =============================================================================

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { SQLiteWritingStore } from '../../src/writing/repositories/writing-store.js';
import { AuditService } from '../../src/writing/services/audit-service.js';
import { WorkflowService } from '../../src/writing/services/workflow-service.js';
import { RelationService } from '../../src/writing/services/relation-service.js';
import { GraphService } from '../../src/writing/services/graph-service.js';
import { makeRequestContext } from '../../src/writing/services/context.js';
import type { WritingRequestContext } from '../../src/writing/services/context.js';
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
import { RealCoreBridge } from '../../src/writing/core-bridge/real-bridge.js';

describe('Phase 8 · 关系候选 CRUD + 状态机', () => {
  let store: SQLiteWritingStore;
  let relationService: RelationService;
  let graphService: GraphService;
  let ctx: WritingRequestContext;
  let projectId: string;
  let entityA: { id: string };
  let entityB: { id: string };

  beforeEach(() => {
    const db = new Database(':memory:');
    store = new SQLiteWritingStore(db);
    store.createTables();
    const auditService = new AuditService(store);
    const workflowService = new WorkflowService(store, auditService);
    relationService = new RelationService(store, auditService, workflowService);
    graphService = new GraphService(store);
    projectId = store.createProject('关系测试').id;
    ctx = makeRequestContext({ projectId, trigger: 'author_action' });

    // 预置两个实体
    const hints = store.createEntitySketch(projectId, {
      displayName: '角色A', typeLabel: '角色',
    });
    entityA = hints;
    entityB = store.createEntitySketch(projectId, {
      displayName: '角色B', typeLabel: '角色',
    });
  });

  it('创建关系候选', () => {
    const c = relationService.createRelationCandidate(ctx, {
      sourceEntityId: entityA.id, targetEntityId: entityB.id,
      relationTypeId: 'enemy_of', layer: 'world', direction: 'bidirectional',
    });
    expect(c.id).toMatch(/^wrel_/);
    expect(c.status).toBe('candidate');
    expect(c.layer).toBe('world');
  });

  it('列出关系候选', () => {
    relationService.createRelationCandidate(ctx, {
      sourceEntityId: entityA.id, targetEntityId: entityB.id,
      relationTypeId: 'ally_of',
    });
    const list = relationService.listRelationCandidates(ctx);
    expect(list).toHaveLength(1);
    expect(list[0]!.relationTypeId).toBe('ally_of');
  });

  it('推进状态 candidate → drafted → submitted', () => {
    const c = relationService.createRelationCandidate(ctx, {
      sourceEntityId: entityA.id, targetEntityId: entityB.id,
      relationTypeId: 'disciple_of',
    });
    relationService.advanceRelationCandidate(ctx, c.id, 'drafted');
    expect(store.getRelationCandidate(c.id)!.status).toBe('drafted');
    relationService.advanceRelationCandidate(ctx, c.id, 'submitted');
    expect(store.getRelationCandidate(c.id)!.status).toBe('submitted');
  });

  it('非法状态跳转抛错（candidate → committed 跳过中间态）', () => {
    const c = relationService.createRelationCandidate(ctx, {
      sourceEntityId: entityA.id, targetEntityId: entityB.id,
      relationTypeId: 'knows',
    });
    expect(() => {
      store.updateRelationCandidate(c.id, c.version, { status: 'committed' });
    }).toThrow();
  });

  it('废弃关系候选', () => {
    const c = relationService.createRelationCandidate(ctx, {
      sourceEntityId: entityA.id, targetEntityId: entityB.id,
      relationTypeId: 'test',
    });
    relationService.deprecateRelationCandidate(ctx, c.id);
    expect(store.getRelationCandidate(c.id)!.status).toBe('archived');
  });

  it('合并关系候选', () => {
    const c1 = relationService.createRelationCandidate(ctx, {
      sourceEntityId: entityA.id, targetEntityId: entityB.id,
      relationTypeId: 'enemy_of',
    });
    const c2 = relationService.createRelationCandidate(ctx, {
      sourceEntityId: entityA.id, targetEntityId: entityB.id,
      relationTypeId: 'rival_of',
    });
    relationService.mergeRelationCandidates(ctx, c1.id, c2.id);
    expect(store.getRelationCandidate(c1.id)!.status).toBe('archived');
    expect(store.getRelationCandidate(c2.id)!.status).toBe('candidate');
  });
});

describe('Phase 8 · 检测提示', () => {
  let store: SQLiteWritingStore;
  let relationService: RelationService;
  let ctx: WritingRequestContext;
  let entityA: { id: string };
  let entityB: { id: string };

  beforeEach(() => {
    const db = new Database(':memory:');
    store = new SQLiteWritingStore(db);
    store.createTables();
    const auditService = new AuditService(store);
    const workflowService = new WorkflowService(store, auditService);
    relationService = new RelationService(store, auditService, workflowService);
    const projectId = store.createProject('提示测试').id;
    ctx = makeRequestContext({ projectId, trigger: 'author_action' });
    entityA = store.createEntitySketch(projectId, { displayName: 'A', typeLabel: '角色' });
    entityB = store.createEntitySketch(projectId, { displayName: 'B', typeLabel: '角色' });
  });

  it('创建检测提示', () => {
    const hints = relationService.createRelationHints(ctx, [{
      sourceEntityId: entityA.id, targetEntityId: entityB.id,
      summary: 'A和B可能是师徒关系', confidence: 0.8,
    }]);
    expect(hints).toHaveLength(1);
    expect(hints[0]!.status).toBe('new');
    expect(hints[0]!.confidence).toBe(0.8);
  });

  it('确认提示 → 候选', () => {
    const hints = relationService.createRelationHints(ctx, [{
      sourceEntityId: entityA.id, targetEntityId: entityB.id,
      summary: '可能是兄妹', possibleLayer: 'world',
    }]);
    const candidate = relationService.confirmHintToCandidate(ctx, hints[0]!.id, {
      relationTypeId: 'sibling_of',
    });
    expect(candidate.status).toBe('candidate');
    expect(store.getRelationHint(hints[0]!.id)!.status).toBe('converted_to_candidate');
  });

  it('忽略提示', () => {
    const hints = relationService.createRelationHints(ctx, [{
      sourceEntityId: entityA.id, targetEntityId: entityB.id,
      summary: '可能有关联',
    }]);
    relationService.ignoreHint(ctx, hints[0]!.id);
    expect(store.getRelationHint(hints[0]!.id)!.status).toBe('ignored');
  });
});

describe('Phase 8 · 创作关联', () => {
  let store: SQLiteWritingStore;
  let relationService: RelationService;
  let ctx: WritingRequestContext;

  beforeEach(() => {
    const db = new Database(':memory:');
    store = new SQLiteWritingStore(db);
    store.createTables();
    const auditService = new AuditService(store);
    const workflowService = new WorkflowService(store, auditService);
    relationService = new RelationService(store, auditService, workflowService);
    const projectId = store.createProject('关联测试').id;
    ctx = makeRequestContext({ projectId, trigger: 'author_action' });
  });

  it('创建创作关联', () => {
    const a = relationService.createAssociation(ctx, {
      sourceRef: { objectType: 'entity', objectId: 'ent_1' },
      targetRef: { objectType: 'entity', objectId: 'ent_2' },
      label: '主题呼应', kind: 'echo',
    });
    expect(a.id).toMatch(/^wasc_/);
    expect(a.label).toBe('主题呼应');
    expect(a.kind).toBe('echo');
  });

  it('列出关联', () => {
    relationService.createAssociation(ctx, {
      sourceRef: { objectType: 'entity', objectId: 'a' },
      targetRef: { objectType: 'entity', objectId: 'b' },
      label: '关联1',
    });
    relationService.createAssociation(ctx, {
      sourceRef: { objectType: 'entity', objectId: 'c' },
      targetRef: { objectType: 'entity', objectId: 'd' },
      label: '关联2',
    });
    const list = relationService.listAssociations(ctx);
    expect(list).toHaveLength(2);
  });

  it('归档关联', () => {
    const a = relationService.createAssociation(ctx, {
      sourceRef: { objectType: 'entity', objectId: 'a' },
      targetRef: { objectType: 'entity', objectId: 'b' },
      label: '要归档的',
    });
    relationService.archiveAssociation(ctx, a.id);
    expect(store.getAssociation(a.id)!.status).toBe('archived');
  });
});

describe('Phase 8 · GraphView 投影', () => {
  let store: SQLiteWritingStore;
  let relationService: RelationService;
  let graphService: GraphService;
  let ctx: WritingRequestContext;
  let db: Database.Database;

  beforeEach(() => {
    // 用 factStore 初始化（建 facts 表），writingStore 共用同一个 db
    const factStore = new SQLiteFactStoreAdapter(':memory:', 'default');
    db = factStore.getDatabase();
    // 预置一条 entity_ref Fact（模拟 Core 已提交的关系）
    db.prepare('INSERT OR IGNORE INTO entities (id, name, kind, first_appearance) VALUES (?, ?, ?, ?)').run('ent_A', 'A', 'character', 1);
    db.prepare('INSERT OR IGNORE INTO entities (id, name, kind, first_appearance) VALUES (?, ?, ?, ?)').run('ent_B', 'B', 'character', 1);
    db.prepare(`INSERT OR IGNORE INTO events (id, type, chapter, description, params_json, fact_group_id)
      VALUES (?, 'custom', 1, 'seed', '{}', 'seed_fg')`).run('seed');
    db.prepare(`INSERT INTO facts (id, subject, predicate, value_type, value_entity_ref, certainty, cause_event, valid_from, context, embedding_text)
      VALUES (?, ?, ?, 'entity_ref', ?, 'canonical', 'seed', 1, 'global', '')`)
      .run('fct_rel_1', 'ent_A', 'enemy_of', 'ent_B');

    store = new SQLiteWritingStore(db);
    store.createTables();
    const auditService = new AuditService(store);
    const workflowService = new WorkflowService(store, auditService);
    relationService = new RelationService(store, auditService, workflowService);
    graphService = new GraphService(store);
    const projectId = store.createProject('图谱测试').id;
    ctx = makeRequestContext({ projectId, trigger: 'author_action' });
  });

  it('空项目图谱：0 节点 0 边', async () => {
    const graph = await graphService.buildGraphView(ctx, 'world');
    expect(graph.nodes).toHaveLength(0);
    expect(graph.edges).toHaveLength(0);
  });

  it('Core Fact（entity_ref）正确投影为 committed 边 + 人话 label', async () => {
    // 预置两个已注册实体（coreEntityId 对齐 facts 表的 subject/target）
    const sketchA = store.createEntitySketch(ctx.projectId, { displayName: '沈墨', typeLabel: '角色' });
    db.prepare("UPDATE writing_entity_sketches SET core_entity_id = ?, status = 'registered' WHERE id = ?").run('ent_A', sketchA.id);
    const sketchB = store.createEntitySketch(ctx.projectId, { displayName: '张三', typeLabel: '角色' });
    db.prepare("UPDATE writing_entity_sketches SET core_entity_id = ?, status = 'registered' WHERE id = ?").run('ent_B', sketchB.id);

    const graph = await graphService.buildGraphView(ctx, 'world');
    // 2 个节点
    expect(graph.nodes).toHaveLength(2);
    // 1 条 committed 边（来自 facts 表的 enemy_of）
    const committedEdges = graph.edges.filter(e => e.sourceLayer === 'committed');
    expect(committedEdges).toHaveLength(1);
    expect(committedEdges[0]!.label).toBe('敌人'); // 内置谓词映射 enemy_of → 敌人
  });

  it('有实体+关系候选：节点和边正确投影', async () => {
    const entityA = store.createEntitySketch(ctx.projectId, { displayName: '沈墨', typeLabel: '角色' });
    const entityB = store.createEntitySketch(ctx.projectId, { displayName: '沈笙', typeLabel: '角色' });
    relationService.createRelationCandidate(ctx, {
      sourceEntityId: entityA.id, targetEntityId: entityB.id,
      relationTypeId: 'sibling_of',
    });

    const graph = await graphService.buildGraphView(ctx, 'world');
    expect(graph.nodes).toHaveLength(2);
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]!.sourceLayer).toBe('candidate'); // 候选状态
  });

  it('relationship 模式只保留角色节点', async () => {
    store.createEntitySketch(ctx.projectId, { displayName: '沈墨', typeLabel: '角色' });
    store.createEntitySketch(ctx.projectId, { displayName: '灰域', typeLabel: '概念' });

    const graph = await graphService.buildGraphView(ctx, 'relationship');
    expect(graph.nodes).toHaveLength(1); // 只有角色
    expect(graph.nodes[0]!.label).toBe('沈墨');
  });

  it('创作关联投影为 association 层边', async () => {
    const entityA = store.createEntitySketch(ctx.projectId, { displayName: 'A', typeLabel: '角色' });
    const entityB = store.createEntitySketch(ctx.projectId, { displayName: 'B', typeLabel: '角色' });
    relationService.createAssociation(ctx, {
      sourceRef: { objectType: 'entity', objectId: entityA.id },
      targetRef: { objectType: 'entity', objectId: entityB.id },
      label: '主题呼应',
    });

    const graph = await graphService.buildGraphView(ctx, 'world');
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]!.sourceLayer).toBe('association');
    expect(graph.edges[0]!.label).toBe('主题呼应');
  });

  it('导出 JSON 格式', async () => {
    const entityA = store.createEntitySketch(ctx.projectId, { displayName: 'A', typeLabel: '角色' });
    store.createEntitySketch(ctx.projectId, { displayName: 'B', typeLabel: '角色' });
    relationService.createRelationCandidate(ctx, {
      sourceEntityId: entityA.id, targetEntityId: entityA.id, relationTypeId: 'self',
    });

    const json = await graphService.exportGraph(ctx, 'json');
    const parsed = JSON.parse(json);
    expect(parsed.nodes).toBeDefined();
    expect(parsed.edges).toBeDefined();
  });

  it('导出 GraphML 格式', async () => {
    store.createEntitySketch(ctx.projectId, { displayName: 'A', typeLabel: '角色' });

    const graphml = await graphService.exportGraph(ctx, 'graphml');
    expect(graphml).toContain('<?xml');
    expect(graphml).toContain('<graphml');
    expect(graphml).toContain('<node');
  });
});

describe('Phase 8 · 关系候选完整提交流程（world 层 → Core）', () => {
  let store: SQLiteWritingStore;
  let relationService: RelationService;
  let ctx: WritingRequestContext;
  let workflow: WorkflowService;

  beforeEach(() => {
    // 用 factStore 初始化（建 facts/entities/events 表），writingStore 共用
    const factStore = new SQLiteFactStoreAdapter(':memory:', 'default');
    const db = factStore.getDatabase();

    // 需要完整 Core 栈（ToolRouter + CoreBridge）
    const threadStore = new SQLiteThreadStoreAdapter(db);
    const knowledgeStore = new SQLiteKnowledgeStoreAdapter(db);
    const eventStore = new SQLiteEventStoreAdapter(db);
    const proposalManager = new ProposalManager(new RuleEngine(), undefined, threadStore, new ThreadResolver());
    const retconEngine = new RetconEngine();
    const toolService = new ToolService(factStore, knowledgeStore, eventStore, threadStore, new ThreadResolver());
    const schemaExt = new SchemaExtensionManager(db, 'default');
    const toolRouter = new ToolRouter({
      proposalManager, retconEngine, toolService, schemaExtensionManager: schemaExt,
      factStore, knowledgeStore, eventStore, threadStore,
    });

    store = new SQLiteWritingStore(db);
    store.createTables();
    const auditService = new AuditService(store);
    workflow = new WorkflowService(store, auditService);
    const coreBridge = new RealCoreBridge(toolRouter, store, auditService);
    relationService = new RelationService(store, auditService, workflow, coreBridge);

    const projectId = store.createProject('提交测试').id;
    ctx = makeRequestContext({ projectId, trigger: 'author_action' });
  });

  it('提交 world 层候选 → 生成 PV + 待确认', async () => {
    const db = store.getDatabase();
    // 直接 SQL 预置两个 registered 实体（绕过实体状态机，聚焦测关系提交）
    const sketchA = store.createEntitySketch(ctx.projectId, { displayName: '沈墨', typeLabel: '角色' });
    db.prepare("UPDATE writing_entity_sketches SET status = 'registered', core_entity_id = ? WHERE id = ?").run('ent_shenmo', sketchA.id);
    const sketchB = store.createEntitySketch(ctx.projectId, { displayName: '沈笙', typeLabel: '角色' });
    db.prepare("UPDATE writing_entity_sketches SET status = 'registered', core_entity_id = ? WHERE id = ?").run('ent_shensheng', sketchB.id);

    // 预置 Core entities + events（FK 约束）
    db.prepare('INSERT OR IGNORE INTO entities (id, name, kind, first_appearance) VALUES (?, ?, ?, ?)').run('ent_shenmo', '沈墨', 'character', 1);
    db.prepare('INSERT OR IGNORE INTO entities (id, name, kind, first_appearance) VALUES (?, ?, ?, ?)').run('ent_shensheng', '沈笙', 'character', 1);
    db.prepare('INSERT OR IGNORE INTO events (id, type, chapter, description, params_json, fact_group_id) VALUES (?, ?, ?, ?, ?, ?)').run('seed_evt', 'custom', 1, 'seed', '{}', 'seed_fg');

    // 创建 world 层关系候选
    const candidate = relationService.createRelationCandidate(ctx, {
      sourceEntityId: sketchA.id, targetEntityId: sketchB.id,
      relationTypeId: 'sibling_of', layer: 'world',
    });

    // 提交 → 应生成 PV + PendingDecision
    const result = await relationService.submitRelationCandidate(ctx, candidate.id);

    expect(result.proposalViewId).toBeDefined();
    expect(result.isSafeToCommit).toBe(true);

    // 候选状态 → submitted
    const submitted = store.getRelationCandidate(candidate.id);
    expect(submitted!.status).toBe('submitted');

    // PV 已创建
    const pv = store.getProposalView(result.proposalViewId!);
    expect(pv).toBeDefined();
    expect(pv!.status).toBe('open');

    // PendingDecision 已创建
    const pending = workflow.listPendingDecisions(ctx);
    expect(pending.length).toBeGreaterThanOrEqual(1);
  }, 15000);

  it('非 world 层候选提交抛错', async () => {
    const sketchA = store.createEntitySketch(ctx.projectId, { displayName: 'A', typeLabel: '角色' });
    const sketchB = store.createEntitySketch(ctx.projectId, { displayName: 'B', typeLabel: '角色' });

    const candidate = relationService.createRelationCandidate(ctx, {
      sourceEntityId: sketchA.id, targetEntityId: sketchB.id,
      relationTypeId: 'echo_of', layer: 'authoring', // 非 world 层
    });

    await expect(relationService.submitRelationCandidate(ctx, candidate.id)).rejects.toThrow(/非 world 层/);
  });

  it('未注册实体提交抛错', async () => {
    const sketchA = store.createEntitySketch(ctx.projectId, { displayName: 'A', typeLabel: '角色' });
    const sketchB = store.createEntitySketch(ctx.projectId, { displayName: 'B', typeLabel: '角色' });
    // 不注册到 Core（无 coreEntityId）

    const candidate = relationService.createRelationCandidate(ctx, {
      sourceEntityId: sketchA.id, targetEntityId: sketchB.id,
      relationTypeId: 'sibling_of', layer: 'world',
    });

    await expect(relationService.submitRelationCandidate(ctx, candidate.id)).rejects.toThrow(/必须已注册到 Core/);
  });
});

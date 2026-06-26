// =============================================================================
// Phase 9 测试：SpatialService（空间节点/空间边 CRUD + 状态机 + 不变量）
// =============================================================================

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { SQLiteWritingStore } from '../../src/writing/repositories/writing-store.js';
import { AuditService } from '../../src/writing/services/audit-service.js';
import { WorkflowService } from '../../src/writing/services/workflow-service.js';
import { SpatialService } from '../../src/writing/services/spatial-service.js';
import { makeRequestContext } from '../../src/writing/services/context.js';
import type { WritingRequestContext } from '../../src/writing/services/context.js';

describe('Phase 9 · SpatialService 空间节点 CRUD', () => {
  let store: SQLiteWritingStore;
  let spatialService: SpatialService;
  let ctx: WritingRequestContext;
  let projectId: string;

  beforeEach(() => {
    const db = new Database(':memory:');
    store = new SQLiteWritingStore(db);
    store.createTables();
    const auditService = new AuditService(store);
    const workflowService = new WorkflowService(store, auditService);
    spatialService = new SpatialService(store, auditService, workflowService);
    projectId = store.createProject('空间测试').id;
    ctx = makeRequestContext({ projectId, trigger: 'author_action' });
  });

  it('创建空间节点（maturity=hint）', () => {
    const node = spatialService.createSpatialNode(ctx, {
      label: '青云门',
      typeId: 'sect_domain',
      description: '修仙门派总部',
    });
    expect(node.id).toMatch(/^wsnode_/);
    expect(node.label).toBe('青云门');
    expect(node.typeId).toBe('sect_domain');
    expect(node.maturity).toBe('hint');
    expect(node.status).toBe('active');
  });

  it('更新空间节点（乐观锁）', () => {
    const node = spatialService.createSpatialNode(ctx, { label: 'A', typeId: 'city' });
    spatialService.updateSpatialNode(ctx, node.id, node.version, { label: 'A城' });
    const updated = store.getSpatialNode(node.id)!;
    expect(updated.label).toBe('A城');
    expect(updated.version).toBe(2);
  });

  it('推进成熟度：hint→candidate→confirmed→registered', () => {
    const node = spatialService.createSpatialNode(ctx, { label: 'B', typeId: 'city' });
    spatialService.advanceSpatialNodeMaturity(ctx, node.id, 'candidate');
    expect(store.getSpatialNode(node.id)!.maturity).toBe('candidate');
    spatialService.advanceSpatialNodeMaturity(ctx, node.id, 'confirmed');
    expect(store.getSpatialNode(node.id)!.maturity).toBe('confirmed');
    spatialService.advanceSpatialNodeMaturity(ctx, node.id, 'registered');
    expect(store.getSpatialNode(node.id)!.maturity).toBe('registered');
  });

  it('非法成熟度转换抛错', () => {
    const node = spatialService.createSpatialNode(ctx, { label: 'C', typeId: 'city' });
    expect(() => spatialService.advanceSpatialNodeMaturity(ctx, node.id, 'registered')).toThrow();
  });

  it('废弃空间节点', () => {
    const node = spatialService.createSpatialNode(ctx, { label: 'D', typeId: 'city' });
    spatialService.deprecateSpatialNode(ctx, node.id);
    expect(store.getSpatialNode(node.id)!.status).toBe('deprecated');
  });
});

describe('Phase 9 · SpatialService 空间边 CRUD', () => {
  let store: SQLiteWritingStore;
  let spatialService: SpatialService;
  let ctx: WritingRequestContext;
  let projectId: string;

  beforeEach(() => {
    const db = new Database(':memory:');
    store = new SQLiteWritingStore(db);
    store.createTables();
    const auditService = new AuditService(store);
    const workflowService = new WorkflowService(store, auditService);
    spatialService = new SpatialService(store, auditService, workflowService);
    projectId = store.createProject('空间边测试').id;
    ctx = makeRequestContext({ projectId, trigger: 'author_action' });
  });

  function createTwoNodes() {
    const a = spatialService.createSpatialNode(ctx, { label: '城市A', typeId: 'city' });
    const b = spatialService.createSpatialNode(ctx, { label: '城市B', typeId: 'city' });
    return { a, b };
  }

  it('创建空间边（status=candidate）', () => {
    const { a, b } = createTwoNodes();
    const edge = spatialService.createSpatialEdge(ctx, {
      sourceNodeId: a.id, targetNodeId: b.id, typeId: 'connected_to',
    });
    expect(edge.id).toMatch(/^wsed_/);
    expect(edge.status).toBe('candidate');
    expect(edge.layer).toBe('world');
  });

  it('两端节点不存在抛错', () => {
    expect(() => spatialService.createSpatialEdge(ctx, {
      sourceNodeId: 'nonexistent', targetNodeId: 'nonexistent', typeId: 'x',
    })).toThrow();
  });

  it('确认空间边 candidate→confirmed', () => {
    const { a, b } = createTwoNodes();
    const edge = spatialService.createSpatialEdge(ctx, {
      sourceNodeId: a.id, targetNodeId: b.id, typeId: 'contains',
    });
    spatialService.confirmSpatialEdge(ctx, edge.id);
    expect(store.getSpatialEdge(edge.id)!.status).toBe('confirmed');
  });

  it('提交空间边 confirmed→submitted（仅 world 层）', () => {
    const { a, b } = createTwoNodes();
    const edge = spatialService.createSpatialEdge(ctx, {
      sourceNodeId: a.id, targetNodeId: b.id, typeId: 'contains', layer: 'world',
    });
    spatialService.confirmSpatialEdge(ctx, edge.id);
    spatialService.submitSpatialEdge(ctx, edge.id);
    expect(store.getSpatialEdge(edge.id)!.status).toBe('submitted');
  });

  it('非 world 层边不能提交', () => {
    const { a, b } = createTwoNodes();
    const edge = spatialService.createSpatialEdge(ctx, {
      sourceNodeId: a.id, targetNodeId: b.id, typeId: 'x', layer: 'authoring',
    });
    spatialService.confirmSpatialEdge(ctx, edge.id);
    expect(() => spatialService.submitSpatialEdge(ctx, edge.id)).toThrow();
  });

  it('已提交边不能编辑', () => {
    const { a, b } = createTwoNodes();
    const edge = spatialService.createSpatialEdge(ctx, {
      sourceNodeId: a.id, targetNodeId: b.id, typeId: 'x', layer: 'world',
    });
    spatialService.confirmSpatialEdge(ctx, edge.id);
    spatialService.submitSpatialEdge(ctx, edge.id);
    expect(() => spatialService.updateSpatialEdge(ctx, edge.id, edge.version, { typeId: 'y' })).toThrow();
  });

  it('归档空间边', () => {
    const { a, b } = createTwoNodes();
    const edge = spatialService.createSpatialEdge(ctx, {
      sourceNodeId: a.id, targetNodeId: b.id, typeId: 'x',
    });
    spatialService.archiveSpatialEdge(ctx, edge.id);
    expect(store.getSpatialEdge(edge.id)!.status).toBe('archived');
  });
});

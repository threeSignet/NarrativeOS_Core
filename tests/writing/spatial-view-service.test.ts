// =============================================================================
// Phase 9 测试：SpatialViewService（树状视图 + 导出）
// =============================================================================

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { SQLiteWritingStore } from '../../src/writing/repositories/writing-store.js';
import { AuditService } from '../../src/writing/services/audit-service.js';
import { WorkflowService } from '../../src/writing/services/workflow-service.js';
import { SpatialService } from '../../src/writing/services/spatial-service.js';
import { SpatialViewService } from '../../src/writing/services/spatial-view-service.js';
import { makeRequestContext } from '../../src/writing/services/context.js';
import type { WritingRequestContext } from '../../src/writing/services/context.js';

describe('Phase 9 · SpatialViewService', () => {
  let store: SQLiteWritingStore;
  let spatialService: SpatialService;
  let viewService: SpatialViewService;
  let ctx: WritingRequestContext;
  let projectId: string;

  beforeEach(() => {
    const db = new Database(':memory:');
    store = new SQLiteWritingStore(db);
    store.createTables();
    const auditService = new AuditService(store);
    const workflowService = new WorkflowService(store, auditService);
    spatialService = new SpatialService(store, auditService, workflowService);
    viewService = new SpatialViewService(store);
    projectId = store.createProject('视图测试').id;
    ctx = makeRequestContext({ projectId, trigger: 'author_action' });
  });

  it('空项目返回 null root', () => {
    const tree = viewService.buildSpatialTreeView(ctx);
    expect(tree.root).toBeNull();
    expect(tree.nodeCount).toBe(0);
  });

  it('树状视图：contains 边构建父子层级', () => {
    const continent = spatialService.createSpatialNode(ctx, { label: '大陆', typeId: 'continent' });
    const city = spatialService.createSpatialNode(ctx, { label: '京城', typeId: 'city' });
    const building = spatialService.createSpatialNode(ctx, { label: '皇宫', typeId: 'building' });

    spatialService.createSpatialEdge(ctx, {
      sourceNodeId: continent.id, targetNodeId: city.id, typeId: 'contains', direction: 'directed',
    });
    spatialService.confirmSpatialEdge(ctx, store.listSpatialEdges(projectId)[0]!.id);
    spatialService.createSpatialEdge(ctx, {
      sourceNodeId: city.id, targetNodeId: building.id, typeId: 'contains', direction: 'directed',
    });
    spatialService.confirmSpatialEdge(ctx, store.listSpatialEdges(projectId, { status: 'candidate' })[0]!.id);

    const tree = viewService.buildSpatialTreeView(ctx);
    expect(tree.root).not.toBeNull();
    expect(tree.root!.node.label).toBe('大陆');
    expect(tree.root!.children).toHaveLength(1);
    expect(tree.root!.children[0]!.node.label).toBe('京城');
    expect(tree.root!.children[0]!.children).toHaveLength(1);
    expect(tree.root!.children[0]!.children[0]!.node.label).toBe('皇宫');
    expect(tree.nodeCount).toBe(3);
    expect(tree.edgeCount).toBe(2);
  });

  it('多根节点创建虚拟根', () => {
    spatialService.createSpatialNode(ctx, { label: 'A', typeId: 'city' });
    spatialService.createSpatialNode(ctx, { label: 'B', typeId: 'city' });

    const tree = viewService.buildSpatialTreeView(ctx);
    expect(tree.root).not.toBeNull();
    expect(tree.root!.node.label).toBe('空间结构');
    expect(tree.root!.children).toHaveLength(2);
  });

  it('exportSpatialData 返回完整数据', () => {
    spatialService.createSpatialNode(ctx, { label: 'X', typeId: 'city' });
    const data = viewService.exportSpatialData(ctx);
    expect(data.nodes).toHaveLength(1);
    expect(data.edges).toHaveLength(0);
    expect(data.tree.nodeCount).toBe(1);
  });
});

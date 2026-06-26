// =============================================================================
// Phase 9 · SpatialViewService——空间视图投影
// =============================================================================
// 职责：
//   - 树状层级视图（按 parentId 组装）
//   - 空间数据 JSON 导出
//
// 设计文档：Feature-Spec §9.4
// =============================================================================

import type { SQLiteWritingStore } from '../repositories/writing-store.js';
import type { WritingRequestContext } from './context.js';
import type { WritingSpatialNode, WritingSpatialEdge } from '../models/types.js';

export interface SpatialTreeView {
  root: SpatialTreeNode | null;
  nodeCount: number;
  edgeCount: number;
}

export interface SpatialTreeNode {
  node: WritingSpatialNode;
  children: SpatialTreeNode[];
}

export class SpatialViewService {
  constructor(private store: SQLiteWritingStore) {}

  /**
   * 构建树状层级视图——按 parentId 将空间节点组装为树。
   *
   * @param parentEdgeTypeIds 用于识别父子关系的边类型 ID 列表。
   *   默认 ['contains', 'parent_of']；可通过 Blueprint 或参数覆盖。
   */
  buildSpatialTreeView(
    ctx: WritingRequestContext,
    parentEdgeTypeIds?: string[],
  ): SpatialTreeView {
    const nodes = this.store.listSpatialNodes(ctx.projectId);
    const edges = this.store.listSpatialEdges(ctx.projectId, { status: 'confirmed' });

    if (nodes.length === 0) return { root: null, nodeCount: 0, edgeCount: edges.length };

    // 从 edges 中提取父子关系（typeId 在 parentEdgeTypeIds 中的 directed 边）
    const PARENT_EDGE_TYPES = new Set(parentEdgeTypeIds ?? ['contains', 'parent_of']);
    const childrenMap = new Map<string, string[]>(); // parentId → [childId]

    for (const e of edges) {
      if (e.direction === 'directed' && PARENT_EDGE_TYPES.has(e.typeId)) {
        const existing = childrenMap.get(e.sourceNodeId) ?? [];
        existing.push(e.targetNodeId);
        childrenMap.set(e.sourceNodeId, existing);
      }
    }

    // 找根节点（没有父节点的节点）
    const childIds = new Set<string>();
    for (const children of childrenMap.values()) {
      for (const cid of children) childIds.add(cid);
    }

    const nodeMap = new Map(nodes.map(n => [n.id, n]));
    const roots = nodes.filter(n => !childIds.has(n.id));

    // 递归构建树
    const buildTree = (nodeId: string, visited = new Set<string>()): SpatialTreeNode | null => {
      const node = nodeMap.get(nodeId);
      if (!node || visited.has(nodeId)) return null; // 防循环
      visited.add(nodeId);
      const children = (childrenMap.get(nodeId) ?? [])
        .map(cid => buildTree(cid, visited))
        .filter((t): t is SpatialTreeNode => t !== null);
      return { node, children };
    };

    // 多根节点时创建虚拟根
    let root: SpatialTreeNode | null;
    if (roots.length === 1) {
      root = buildTree(roots[0]!.id);
    } else if (roots.length > 1) {
      root = {
        node: { id: '__virtual_root__', projectId: ctx.projectId, label: '空间结构', typeId: '__virtual__',
          aliases: [], sourceRefs: [], maturity: 'registered', status: 'active',
          properties: {}, version: 0, createdAt: '', updatedAt: '' },
        children: roots.map(r => buildTree(r.id)).filter((t): t is SpatialTreeNode => t !== null),
      };
    } else {
      root = null;
    }

    return { root, nodeCount: nodes.length, edgeCount: edges.length };
  }

  /** 导出空间数据为 JSON（供前端/CLI 消费） */
  exportSpatialData(ctx: WritingRequestContext): {
    nodes: WritingSpatialNode[];
    edges: WritingSpatialEdge[];
    tree: SpatialTreeView;
  } {
    return {
      nodes: this.store.listSpatialNodes(ctx.projectId),
      edges: this.store.listSpatialEdges(ctx.projectId),
      tree: this.buildSpatialTreeView(ctx),
    };
  }
}

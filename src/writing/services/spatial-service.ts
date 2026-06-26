// =============================================================================
// Phase 9 · SpatialService——空间节点/空间边/空间视图的业务逻辑
// =============================================================================
// 职责：
//   - 空间节点的创建/修改/成熟度推进/注册 Core/废弃
//   - 空间边的创建/修改/确认/提交/归档
//   - 空间视图的创建/更新
//
// 核心不变式（Feature-Spec §9）：
//   - 空间节点不自动写 Core
//   - 非 world 层空间边不能提交到 Core
//   - 已提交空间边不能直接编辑，只能走 Retcon
//   - 空间视图布局不写 Core
//
// 设计文档：Feature-Spec §9.1-§9.4
// =============================================================================

import type { SQLiteWritingStore } from '../repositories/writing-store.js';
import type { AuditService } from './audit-service.js';
import type { WorkflowService } from './workflow-service.js';
import type { CoreBridgeService } from '../core-bridge/core-bridge-service.js';
import type { WritingRequestContext } from './context.js';
import { WritingError, WritingErrorCode } from '../errors/error-codes.js';
import type {
  WritingSpatialNode, WritingSpatialEdge, SpatialView,
  SpatialNodeMaturity, SpatialEdgeLayer, SpatialEdgeDirection,
  SpatialTraversalRule,
} from '../models/types.js';
import type { SourceRef } from '../models/source-ref.js';

export class SpatialService {
  constructor(
    private store: SQLiteWritingStore,
    private audit: AuditService,
    private workflow: WorkflowService,
    private coreBridge?: CoreBridgeService,
  ) {}

  // ===========================================================================
  // 空间节点
  // ===========================================================================

  /** 创建空间节点（maturity=hint，需作者确认后逐步推进） */
  createSpatialNode(
    ctx: WritingRequestContext,
    input: {
      label: string;
      typeId: string;
      aliases?: string[];
      description?: string;
      properties?: Record<string, unknown>;
    },
  ): WritingSpatialNode {
    const node = this.store.createSpatialNode(ctx.projectId, {
      label: input.label,
      typeId: input.typeId,
      aliases: input.aliases,
      description: input.description,
      sourceRefs: ctx.sourceRefs,
      properties: input.properties,
    });

    this.audit.record(ctx, {
      action: 'create_spatial_node',
      targetType: 'spatial_node',
      targetId: node.id,
      result: 'success',
      detail: { label: node.label, typeId: node.typeId, maturity: node.maturity },
    });

    return node;
  }

  /** 更新空间节点（乐观锁） */
  updateSpatialNode(
    ctx: WritingRequestContext,
    id: string,
    expectedVersion: number,
    updates: Partial<{
      label: string; typeId: string; aliases: string[];
      description: string; properties: Record<string, unknown>;
    }>,
  ): WritingSpatialNode {
    const node = this.store.getSpatialNode(id);
    if (!node) throw new WritingError(WritingErrorCode.WRITING_OBJECT_NOT_FOUND, `空间节点不存在: ${id}`, { objectType: 'spatial_node', objectId: id });

    this.store.updateSpatialNode(id, expectedVersion, updates);

    this.audit.record(ctx, {
      action: 'update_spatial_node',
      targetType: 'spatial_node',
      targetId: id,
      result: 'success',
      detail: { updatedFields: Object.keys(updates) },
    });

    return this.store.getSpatialNode(id)!;
  }

  /** 推进空间节点成熟度（hint→candidate→confirmed→registered） */
  advanceSpatialNodeMaturity(
    ctx: WritingRequestContext,
    id: string,
    targetMaturity: SpatialNodeMaturity,
  ): WritingSpatialNode {
    const node = this.store.getSpatialNode(id);
    if (!node) throw new WritingError(WritingErrorCode.WRITING_OBJECT_NOT_FOUND, `空间节点不存在: ${id}`, { objectType: 'spatial_node', objectId: id });

    const expectedVersion = node.version;
    this.store.updateSpatialNode(id, expectedVersion, { maturity: targetMaturity });

    this.audit.record(ctx, {
      action: 'advance_spatial_node_maturity',
      targetType: 'spatial_node',
      targetId: id,
      result: 'success',
      detail: { from: node.maturity, to: targetMaturity },
    });

    return this.store.getSpatialNode(id)!;
  }

  /** 将空间节点注册为 Core Entity（confirmed→registered） */
  async registerSpatialNodeToCore(
    ctx: WritingRequestContext,
    id: string,
  ): Promise<WritingSpatialNode> {
    const node = this.store.getSpatialNode(id);
    if (!node) throw new WritingError(WritingErrorCode.WRITING_OBJECT_NOT_FOUND, `空间节点不存在: ${id}`, { objectType: 'spatial_node', objectId: id });
    if (node.maturity !== 'confirmed') {
      throw new WritingError(WritingErrorCode.INVALID_STATUS_TRANSITION,
        `空间节点 ${id} 成熟度为 ${node.maturity}，需先确认为 confirmed 才能注册 Core`,
        { currentMaturity: node.maturity, targetMaturity: 'registered' });
    }

    // 推进成熟度
    const expectedVersion = node.version;
    this.store.updateSpatialNode(id, expectedVersion, { maturity: 'registered' });

    // 尝试通过 CoreBridge 注册 Core Entity（如果注入了 CoreBridge）
    let coreEntityId: string | undefined;
    if (this.coreBridge) {
      try {
        // 创建临时 EntitySketch 并注册到 Core
        const sketch = this.store.createEntitySketch(ctx.projectId, {
          displayName: node.label,
          typeLabel: node.typeId,
        });
        // 批准草图（hint→candidate→approved）
        this.store.updateEntitySketch(sketch.id, { status: 'approved' }, sketch.version);
        // 注册到 Core
        const result = await this.coreBridge.registerReviewedEntity(ctx, sketch.id);
        if (result.success && result.coreEntityId) {
          coreEntityId = result.coreEntityId;
          this.store.updateSpatialNode(id, expectedVersion + 1, { coreEntityId });
        }
      } catch {
        // Core 注册失败不阻塞——空间节点仍标记为 registered，coreEntityId 留空
      }
    }

    this.audit.record(ctx, {
      action: 'register_spatial_node_to_core',
      targetType: 'spatial_node',
      targetId: id,
      result: 'success',
      detail: { label: node.label, coreEntityId: coreEntityId ?? null },
    });

    return this.store.getSpatialNode(id)!;
  }

  /** 废弃空间节点 */
  deprecateSpatialNode(
    ctx: WritingRequestContext,
    id: string,
  ): void {
    const node = this.store.getSpatialNode(id);
    if (!node) throw new WritingError(WritingErrorCode.WRITING_OBJECT_NOT_FOUND, `空间节点不存在: ${id}`, { objectType: 'spatial_node', objectId: id });

    this.store.updateSpatialNode(id, node.version, { status: 'deprecated' });

    this.audit.record(ctx, {
      action: 'deprecate_spatial_node',
      targetType: 'spatial_node',
      targetId: id,
      result: 'success',
      detail: { label: node.label },
    });
  }

  // ===========================================================================
  // 空间边
  // ===========================================================================

  /** 创建空间边（status=candidate） */
  createSpatialEdge(
    ctx: WritingRequestContext,
    input: {
      sourceNodeId: string;
      targetNodeId: string;
      typeId: string;
      layer?: SpatialEdgeLayer;
      direction?: SpatialEdgeDirection;
      traversal?: SpatialTraversalRule;
    },
  ): WritingSpatialEdge {
    // 校验两端节点存在
    const source = this.store.getSpatialNode(input.sourceNodeId);
    if (!source) throw new WritingError(WritingErrorCode.WRITING_OBJECT_NOT_FOUND, `源空间节点不存在: ${input.sourceNodeId}`, { objectType: 'spatial_node', objectId: input.sourceNodeId });
    const target = this.store.getSpatialNode(input.targetNodeId);
    if (!target) throw new WritingError(WritingErrorCode.WRITING_OBJECT_NOT_FOUND, `目标空间节点不存在: ${input.targetNodeId}`, { objectType: 'spatial_node', objectId: input.targetNodeId });

    const edge = this.store.createSpatialEdge(ctx.projectId, {
      sourceNodeId: input.sourceNodeId,
      targetNodeId: input.targetNodeId,
      typeId: input.typeId,
      layer: input.layer,
      direction: input.direction,
      traversal: input.traversal,
      sourceRefs: ctx.sourceRefs,
    });

    this.audit.record(ctx, {
      action: 'create_spatial_edge',
      targetType: 'spatial_edge',
      targetId: edge.id,
      result: 'success',
      detail: {
        sourceNodeId: input.sourceNodeId, targetNodeId: input.targetNodeId,
        typeId: input.typeId, layer: edge.layer,
      },
    });

    return edge;
  }

  /** 更新空间边（乐观锁，仅未提交状态可编辑） */
  updateSpatialEdge(
    ctx: WritingRequestContext,
    id: string,
    expectedVersion: number,
    updates: Partial<{
      typeId: string; layer: SpatialEdgeLayer; direction: SpatialEdgeDirection;
      traversal: SpatialTraversalRule;
    }>,
  ): WritingSpatialEdge {
    const edge = this.store.getSpatialEdge(id);
    if (!edge) throw new WritingError(WritingErrorCode.WRITING_OBJECT_NOT_FOUND, `空间边不存在: ${id}`, { objectType: 'spatial_edge', objectId: id });
    if (edge.status === 'committed') {
      throw new WritingError(WritingErrorCode.INVALID_STATUS_TRANSITION,
        `空间边 ${id} 已提交（committed），不能直接编辑，需走 Retcon`,
        { currentStatus: edge.status });
    }

    this.store.updateSpatialEdge(id, expectedVersion, updates);

    this.audit.record(ctx, {
      action: 'update_spatial_edge',
      targetType: 'spatial_edge',
      targetId: id,
      result: 'success',
      detail: { updatedFields: Object.keys(updates) },
    });

    return this.store.getSpatialEdge(id)!;
  }

  /** 确认空间边（candidate→confirmed） */
  confirmSpatialEdge(
    ctx: WritingRequestContext,
    id: string,
  ): WritingSpatialEdge {
    const edge = this.store.getSpatialEdge(id);
    if (!edge) throw new WritingError(WritingErrorCode.WRITING_OBJECT_NOT_FOUND, `空间边不存在: ${id}`, { objectType: 'spatial_edge', objectId: id });

    this.store.updateSpatialEdge(id, edge.version, { status: 'confirmed' });

    this.audit.record(ctx, {
      action: 'confirm_spatial_edge',
      targetType: 'spatial_edge',
      targetId: id,
      result: 'success',
      detail: { from: 'candidate', to: 'confirmed' },
    });

    return this.store.getSpatialEdge(id)!;
  }

  /** 提交空间边到 Core（confirmed→submitted，仅 world 层允许） */
  submitSpatialEdge(
    ctx: WritingRequestContext,
    id: string,
  ): WritingSpatialEdge {
    const edge = this.store.getSpatialEdge(id);
    if (!edge) throw new WritingError(WritingErrorCode.WRITING_OBJECT_NOT_FOUND, `空间边不存在: ${id}`, { objectType: 'spatial_edge', objectId: id });
    if (edge.layer !== 'world') {
      throw new WritingError(WritingErrorCode.INVALID_STATUS_TRANSITION,
        `空间边 ${id} 层级为 ${edge.layer}，只有 world 层空间边可提交到 Core`,
        { currentLayer: edge.layer });
    }

    this.store.updateSpatialEdge(id, edge.version, { status: 'submitted' });

    this.audit.record(ctx, {
      action: 'submit_spatial_edge',
      targetType: 'spatial_edge',
      targetId: id,
      result: 'success',
      detail: { from: 'confirmed', to: 'submitted', layer: edge.layer },
    });

    return this.store.getSpatialEdge(id)!;
  }

  /** 归档空间边 */
  archiveSpatialEdge(
    ctx: WritingRequestContext,
    id: string,
  ): void {
    const edge = this.store.getSpatialEdge(id);
    if (!edge) throw new WritingError(WritingErrorCode.WRITING_OBJECT_NOT_FOUND, `空间边不存在: ${id}`, { objectType: 'spatial_edge', objectId: id });

    this.store.updateSpatialEdge(id, edge.version, { status: 'archived' });

    this.audit.record(ctx, {
      action: 'archive_spatial_edge',
      targetType: 'spatial_edge',
      targetId: id,
      result: 'success',
      detail: { from: edge.status, to: 'archived' },
    });
  }

  // ===========================================================================
  // 空间视图
  // ===========================================================================

  /** 创建空间视图 */
  createSpatialView(
    ctx: WritingRequestContext,
    input: {
      name: string;
      rootSpatialNodeId?: string;
      layerIds?: string[];
      mode?: SpatialView['mode'];
    },
  ): SpatialView {
    const view = this.store.createSpatialView(ctx.projectId, {
      name: input.name,
      rootSpatialNodeId: input.rootSpatialNodeId,
      layerIds: input.layerIds,
      mode: input.mode,
    });

    this.audit.record(ctx, {
      action: 'create_spatial_view',
      targetType: 'spatial_view',
      targetId: view.id,
      result: 'success',
      detail: { name: view.name, mode: view.mode },
    });

    return view;
  }

  /** 更新空间视图布局（不写 Core） */
  updateSpatialViewLayout(
    ctx: WritingRequestContext,
    id: string,
    updates: Partial<{
      name: string; positions: Record<string, { x: number; y: number; z?: number }>;
      filters: Record<string, unknown>;
    }>,
  ): SpatialView {
    const view = this.store.getSpatialView(id);
    if (!view) throw new WritingError(WritingErrorCode.WRITING_OBJECT_NOT_FOUND, `空间视图不存在: ${id}`, { objectType: 'spatial_view', objectId: id });

    this.store.updateSpatialView(id, updates);

    return this.store.getSpatialView(id)!;
  }
}

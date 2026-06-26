// =============================================================================
// Phase 8 · GraphService——Core Fact → GraphView 投影
// =============================================================================
// 职责：
//   - 从 Core Fact（entity_ref 类型）+ 关系候选 + 创作关联 + 检测提示
//     合并投影成统一的 GraphView（节点+边）
//   - 按过滤器筛选
//   - 导出图谱（JSON/GraphML）
//
// 投影规则（Feature-Spec §10.1）：
//   Core Fact (value_type=entity_ref) → GraphEdgeView (sourceLayer=committed)
//   WritingRelationCandidate (committed) → GraphEdgeView (sourceLayer=committed)
//   WritingRelationCandidate (candidate) → GraphEdgeView (sourceLayer=candidate)
//   AuthoringAssociation → GraphEdgeView (sourceLayer=association)
//   RelationDetectionHint → GraphEdgeView (sourceLayer=hint)
//   Entity Sketch (registered) → GraphNodeView (sourceLayer=committed)
//   Entity Sketch (candidate/hint) → GraphNodeView (sourceLayer=candidate/hint)
//
// 不变式（Feature-Spec §10）：
//   - 图谱布局不写入 Core
//   - 图谱节点不一定等于 Core Entity
//   - 图谱过滤不改变数据
// =============================================================================

import type { SQLiteWritingStore } from '../repositories/writing-store.js';
import type { CoreBridgeService } from '../core-bridge/core-bridge-service.js';
import type { WritingRequestContext } from './context.js';
import type {
  GraphView, GraphNodeView, GraphEdgeView, GraphFilterState, GraphLayoutState,
  GraphViewMode, GraphSourceLayer, WritingObjectRef,
} from '../models/types.js';

export class GraphService {
  constructor(
    private store: SQLiteWritingStore,
    private coreBridge?: CoreBridgeService,
  ) {}

  /**
   * 构建图谱视图——合并所有来源的节点和边。
   *
   * @param mode 视图模式（relationship 只显示角色+关系，world 全部）
   * @param filters 过滤器（按层级/类型/状态）
   */
  async buildGraphView(
    ctx: WritingRequestContext,
    mode: GraphViewMode = 'world',
    filters?: GraphFilterState,
  ): Promise<GraphView> {
    const projectId = ctx.projectId;
    const nodeMap = new Map<string, GraphNodeView>();
    const edges: GraphEdgeView[] = [];

    // 构建关系类型 label 映射（从蓝图 relationTypes 查人话 label）
    // predicate/relationTypeId → 人话标签（如 enemy_of → "敌人"、sibling_of → "兄妹"）
    const relationLabelMap = this.buildRelationLabelMap(projectId);

    // ---- 1. 从实体草图构建节点 ----
    const sketches = this.store.listEntitySketches(projectId) as Array<{
      id: string; displayName: string; typeLabel: string; status: string;
      coreEntityId?: string; summary?: string; tags?: string[];
    }>;

    // 预取 Core 实体关键属性（realm/location/weapon 等），供节点 attributes 字段
    const entityAttributes = this.loadEntityAttributes(projectId, sketches);

    for (const s of sketches) {
      const sourceLayer: GraphSourceLayer =
        s.status === 'registered' ? 'committed' :
        s.status === 'candidate' || s.status === 'approved' ? 'candidate' :
        s.status === 'hint' ? 'hint' : 'view';

      const statusLabel =
        s.status === 'registered' ? '已注册' :
        s.status === 'candidate' ? '候选' :
        s.status === 'approved' ? '已批准' :
        s.status === 'hint' ? '线索' :
        s.status === 'deprecated' ? '已废弃' : s.status;

      // 应用过滤器
      if (filters?.entityTypes && !filters.entityTypes.includes(s.typeLabel)) continue;

      nodeMap.set(s.id, {
        id: s.id,
        label: s.displayName,
        objectRef: { objectType: 'entity', objectId: s.id },
        sourceLayer,
        projectTypeLabel: s.typeLabel,
        statusLabel,
        coreEntityId: s.coreEntityId,
        summary: s.summary ?? undefined,
        tags: s.tags && s.tags.length > 0 ? s.tags : undefined,
        attributes: entityAttributes.get(s.id),
      });
    }

    // ---- 2. 从 Core Fact 构建 committed 边（entity_ref 类型的关系） ----
    // Core 的 facts 表里 value_type='entity_ref' 的行就是关系边：
    //   subject → value_entity_ref，predicate 是关系类型。
    // facts 表和 writing_* 表在同一个 db 文件里，可直接查。
    // 需要把 Core 的 ent_xxx 映射回写作层的 sketch id（节点用 sketch id 标识）。
    const coreToSketch = new Map<string, string>(); // coreEntityId → sketchId
    for (const s of sketches) {
      if (s.coreEntityId) coreToSketch.set(s.coreEntityId, s.id);
    }

    try {
      const db = this.store.getDatabase();
      // 查所有 entity_ref 类型的当前 Fact（valid_to IS NULL = 当前有效）
      const relationFacts = db.prepare(
        `SELECT subject, predicate, value_entity_ref, relation_kind
         FROM facts
         WHERE value_type = 'entity_ref' AND value_entity_ref IS NOT NULL
           AND valid_to IS NULL
         ORDER BY valid_from DESC`,
      ).all() as Array<{ subject: string; predicate: string; value_entity_ref: string; relation_kind: string | null }>;

      for (const f of relationFacts) {
        const sourceSketchId = coreToSketch.get(f.subject);
        const targetSketchId = coreToSketch.get(f.value_entity_ref);

        // 两端实体都必须在写作层注册过（有 sketch），否则节点不在图里
        if (!sourceSketchId || !targetSketchId) continue;
        // 不画自环（subject === target）
        if (sourceSketchId === targetSketchId) continue;

        // 确保节点存在
        this.ensureNode(nodeMap, sourceSketchId, sketches, entityAttributes);
        this.ensureNode(nodeMap, targetSketchId, sketches, entityAttributes);

        edges.push({
          id: `core_${f.subject}_${f.predicate}_${f.value_entity_ref}`,
          label: relationLabelMap.get(f.predicate) ?? f.predicate,
          sourceNodeId: sourceSketchId,
          targetNodeId: targetSketchId,
          objectRef: { objectType: 'entity', objectId: f.subject },
          sourceLayer: 'committed',
          direction: 'directed',
        });
      }
    } catch {
      // facts 表查询失败不阻断——降级为只有写作层的边
    }

    // ---- 3. 从关系候选构建边 ----
    const candidates = this.store.listRelationCandidates(projectId);
    for (const c of candidates) {
      if (filters?.layers && !filters.layers.includes(c.layer)) continue;
      if (filters?.relationTypes && !filters.relationTypes.includes(c.relationTypeId)) continue;

      const sourceLayer: GraphSourceLayer =
        c.status === 'committed' ? 'committed' :
        c.status === 'submitted' || c.status === 'drafted' ? 'candidate' :
        'candidate';

      // 确保两端节点存在
      this.ensureNode(nodeMap, c.sourceEntityId, sketches, entityAttributes);
      this.ensureNode(nodeMap, c.targetEntityId, sketches, entityAttributes);

      edges.push({
        id: c.id,
        label: relationLabelMap.get(c.relationTypeId) ?? c.relationTypeId,
        sourceNodeId: c.sourceEntityId,
        targetNodeId: c.targetEntityId,
        objectRef: { objectType: 'entity', objectId: c.id },
        sourceLayer,
        direction: c.direction,
      });
    }

    // ---- 4. 从创作关联构建边 ----
    const associations = this.store.listAssociations(projectId);
    for (const a of associations) {
      if (a.status === 'archived') continue;

      // 确保两端节点存在（关联可指向非实体对象，但当前只处理实体→实体）
      const sourceId = a.sourceRef.objectId;
      const targetId = a.targetRef.objectId;

      edges.push({
        id: a.id,
        label: a.label,
        sourceNodeId: sourceId,
        targetNodeId: targetId,
        objectRef: { objectType: 'entity', objectId: a.id },
        sourceLayer: 'association',
        direction: 'undirected',
      });
    }

    // ---- 5. 从检测提示构建边 ----
    const hints = this.store.listRelationHints(projectId, { status: 'new' });
    for (const h of hints) {
      this.ensureNode(nodeMap, h.sourceEntityId, sketches, entityAttributes);
      this.ensureNode(nodeMap, h.targetEntityId, sketches, entityAttributes);

      edges.push({
        id: h.id,
        label: h.summary,
        sourceNodeId: h.sourceEntityId,
        targetNodeId: h.targetEntityId,
        sourceLayer: 'hint',
        direction: 'undirected',
      });
    }

    // ---- 6. 按 mode 过滤 ----
    let filteredNodes = [...nodeMap.values()];
    let filteredEdges = edges;

    if (mode === 'relationship') {
      // 人物关系模式：只保留角色类型节点 + 连接它们的边
      const characterNodeIds = new Set(filteredNodes.filter(n => n.projectTypeLabel.includes('角色')).map(n => n.id));
      filteredNodes = filteredNodes.filter(n => characterNodeIds.has(n.id));
      filteredEdges = filteredEdges.filter(e => characterNodeIds.has(e.sourceNodeId) && characterNodeIds.has(e.targetNodeId));
    }

    // ---- 7. 构建空布局（前端填充） ----
    const layout: GraphLayoutState = {
      positions: {},
      layoutType: 'force',
    };

    return {
      id: `graph_${projectId}_${mode}_${Date.now()}`,
      projectId,
      label: `图谱视图（${mode}）`,
      mode,
      nodes: filteredNodes,
      edges: filteredEdges,
      filters: filters ?? {},
      layout,
    };
  }

  /**
   * 从蓝图 relationTypes 构建 predicate/relationTypeId → 人话 label 映射。
   *
   * 蓝图的 BlueprintTypeDef 含 label（人话）和 coreMapping.predicate（Core 谓词）。
   * 映射两种 key：relationTypeId（BlueprintTypeDef.id）和 predicate（Core 谓词）。
   * 没有蓝图或没匹配的 predicate 用内置谓词映射兜底。
   */
  private buildRelationLabelMap(projectId: string): Map<string, string> {
    const map = new Map<string, string>();

    // 内置谓词→人话兜底（Core 常见关系谓词）
    const BUILTIN: Record<string, string> = {
      enemy_of: '敌人', ally_of: '盟友', disciple_of: '师徒',
      sibling_of: '兄妹', parent_of: '父母', child_of: '子女',
      spouse_of: '配偶', friend_of: '朋友', mentor_of: '导师',
      location: '位于', member_of: '成员', leader_of: '领导',
      holds_item: '持有', created_by: '创造者', knows: '知晓',
      serves: '效忠', betrayed_by: '被背叛', rival_of: '对手',
    };
    for (const [k, v] of Object.entries(BUILTIN)) map.set(k, v);

    // 从蓝图查（覆盖内置）
    try {
      const bp = this.store.getLatestBlueprint(projectId) as
        | { relationTypes?: Array<{ id: string; label: string; coreMapping?: { predicate?: string } }> }
        | undefined;
      if (bp?.relationTypes) {
        for (const rt of bp.relationTypes) {
          map.set(rt.id, rt.label);
          if (rt.coreMapping?.predicate) {
            map.set(rt.coreMapping.predicate, rt.label);
          }
        }
      }
    } catch {
      // 蓝图查询失败用内置兜底
    }

    return map;
  }

  /** 确保节点存在于 nodeMap（不存在则从 sketches 创建） */
  private ensureNode(
    nodeMap: Map<string, GraphNodeView>,
    entityId: string,
    sketches: Array<{ id: string; displayName: string; typeLabel: string; status: string; coreEntityId?: string; summary?: string; tags?: string[] }>,
    attributes?: Map<string, Array<{ predicate: string; value: string }>>,
  ): void {
    if (nodeMap.has(entityId)) return;
    const sketch = sketches.find(s => s.id === entityId);
    if (!sketch) return;
    const sourceLayer: GraphSourceLayer =
      sketch.status === 'registered' ? 'committed' :
      sketch.status === 'candidate' || sketch.status === 'approved' ? 'candidate' :
      sketch.status === 'hint' ? 'hint' : 'view';
    nodeMap.set(entityId, {
      id: sketch.id,
      label: sketch.displayName,
      objectRef: { objectType: 'entity', objectId: sketch.id },
      sourceLayer,
      projectTypeLabel: sketch.typeLabel,
      statusLabel: sketch.status,
      coreEntityId: sketch.coreEntityId,
      summary: sketch.summary ?? undefined,
      tags: sketch.tags && sketch.tags.length > 0 ? sketch.tags : undefined,
      attributes: attributes?.get(entityId),
    });
  }

  /**
   * 从 Core facts 表加载每个已注册实体的关键属性（scalar 类型的 Fact）。
   * 返回 sketchId → attributes 映射。
   *
   * 只取常见展示属性（realm/location/weapon/technique/status/mentor），不全量投影。
   * 已废弃/merged 的实体不加载属性（图谱中降级为纯标签节点）。
   */
  private loadEntityAttributes(
    projectId: string,
    sketches: Array<{ id: string; coreEntityId?: string; status: string }>,
  ): Map<string, Array<{ predicate: string; value: string }>> {
    const result = new Map<string, Array<{ predicate: string; value: string }>>();
    const DISPLAY_PREDICATES = new Set([
      'realm', 'location', 'weapon', 'technique', 'status', 'mentor',
      'faction', 'title', 'species', 'element', 'relationship',
    ]);

    // 收集已注册实体的 coreEntityId
    const registeredEntities: Array<{ sketchId: string; coreEntityId: string }> = [];
    for (const s of sketches) {
      if (s.coreEntityId && s.status === 'registered') {
        registeredEntities.push({ sketchId: s.id, coreEntityId: s.coreEntityId });
      }
    }
    if (registeredEntities.length === 0) return result;

    try {
      const db = this.store.getDatabase();
      // 批量查询所有已注册实体的 scalar Fact
      const placeholders = registeredEntities.map(() => '?').join(',');
      const facts = db.prepare(
        `SELECT subject, predicate, value_scalar
         FROM facts
         WHERE subject IN (${placeholders})
           AND value_type = 'scalar' AND value_scalar IS NOT NULL
           AND valid_to IS NULL
         ORDER BY valid_from DESC`,
      ).all(...registeredEntities.map(e => e.coreEntityId)) as Array<{
        subject: string; predicate: string; value_scalar: string;
      }>;

      // 按 subject 分组，每个 predicate 只取最新一条
      const seen = new Set<string>();
      for (const f of facts) {
        if (!DISPLAY_PREDICATES.has(f.predicate)) continue;
        const key = `${f.subject}:${f.predicate}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const sketchId = registeredEntities.find(e => e.coreEntityId === f.subject)?.sketchId;
        if (!sketchId) continue;

        const attrs = result.get(sketchId) ?? [];
        attrs.push({ predicate: f.predicate, value: f.value_scalar });
        result.set(sketchId, attrs);
      }
    } catch {
      // facts 表查询失败不阻断——节点降级为无属性
    }

    return result;
  }

  /**
   * 导出图谱（JSON 或 GraphML 格式）
   */
  async exportGraph(
    ctx: WritingRequestContext,
    format: 'json' | 'graphml' = 'json',
    mode?: GraphViewMode,
  ): Promise<string> {
    const graph = await this.buildGraphView(ctx, mode ?? 'world');

    if (format === 'json') {
      return JSON.stringify(graph, null, 2);
    }

    // GraphML（XML 格式，可被 Gephi/Cytoscape 导入）
    if (format === 'graphml') {
      return this.toGraphML(graph);
    }

    return JSON.stringify(graph);
  }

  /** 把 GraphView 转为 GraphML XML */
  private toGraphML(graph: GraphView): string {
    const nodes = graph.nodes.map(n =>
      `    <node id="${n.id}"><data key="label">${this.escapeXml(n.label)}</data><data key="type">${this.escapeXml(n.projectTypeLabel)}</data><data key="layer">${n.sourceLayer}</data></node>`,
    ).join('\n');

    const edges = graph.edges.map((e, i) =>
      `    <edge id="e${i}" source="${e.sourceNodeId}" target="${e.targetNodeId}"><data key="label">${this.escapeXml(e.label)}</data><data key="layer">${e.sourceLayer}</data></edge>`,
    ).join('\n');

    return `<?xml version="1.0" encoding="UTF-8"?>
<graphml xmlns="http://graphml.graphdrawing.org/xmlns">
  <key id="label" for="node" attr.name="label" attr.type="string"/>
  <key id="type" for="node" attr.name="type" attr.type="string"/>
  <key id="layer" for="node" attr.name="layer" attr.type="string"/>
  <key id="label" for="edge" attr.name="label" attr.type="string"/>
  <key id="layer" for="edge" attr.name="layer" attr.type="string"/>
  <graph edgedefault="undirected">
${nodes}
${edges}
  </graph>
</graphml>`;
  }

  private escapeXml(str: string): string {
    return str.replace(/[<>&'"]/g, (c) => {
      switch (c) { case '<': return '&lt;'; case '>': return '&gt;'; case '&': return '&amp;'; case '\'': return '&apos;'; case '"': return '&quot;'; default: return c; }
    });
  }
}

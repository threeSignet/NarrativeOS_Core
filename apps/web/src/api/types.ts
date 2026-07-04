// 共享类型（镜像后端枚举，前端不直接 import 后端 src）

/** 实体草图状态（镜像 EntitySketchStatus） */
export type EntitySketchStatus =
  | 'hint' | 'candidate' | 'approved' | 'registered' | 'deprecated' | 'merged' | 'error';

/** 图谱来源层（镜像 GraphSourceLayer） */
export type GraphSourceLayer = 'committed' | 'candidate' | 'draft' | 'hint' | 'association' | 'spatial' | 'view';

/** 图谱节点（镜像 GraphNodeView，attributes.predicate 是 Core 谓词，里程碑②直传） */
export interface GraphNode {
  id: string;
  label: string;
  sourceLayer: GraphSourceLayer;
  projectTypeLabel: string;
  statusLabel: string;
  coreEntityId?: string;
  summary?: string;
  tags?: string[];
  attributes?: Array<{ predicate: string; value: string }>;
}

/** 图谱边（镜像 GraphEdgeView） */
export interface GraphEdge {
  id: string;
  label: string;
  sourceNodeId: string;
  targetNodeId: string;
  sourceLayer: GraphSourceLayer;
  direction: 'directed' | 'bidirectional' | 'undirected' | 'hierarchical';
}

/** 完整图谱视图（镜像 GraphView） */
export interface GraphView {
  id: string;
  projectId: string;
  label: string;
  mode: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

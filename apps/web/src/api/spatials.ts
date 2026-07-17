// /api/spatial HTTP 封装——空间地图只读视图（迭代 C4）
import axios from 'axios';
const http = axios.create({ baseURL: '/api' });

export interface SpatialNode {
  id: string; projectId: string;
  label: string; typeId: string;
  aliases: string[]; sourceRefs: string[];
  maturity: string; status: string;
  properties: Record<string, unknown>;
  version: number; createdAt: string; updatedAt: string;
}

export interface SpatialTreeNode {
  node: SpatialNode;
  children: SpatialTreeNode[];
}

export interface SpatialTreeView {
  root: SpatialTreeNode | null;
  nodeCount: number;
  edgeCount: number;
}

export async function getSpatialTree(projectId: string, parentEdgeTypes?: string[]): Promise<SpatialTreeView> {
  const params: Record<string, string> = {};
  if (parentEdgeTypes?.length) params.parentEdgeTypes = parentEdgeTypes.join(',');
  const { data } = await http.get<SpatialTreeView>(`/projects/${projectId}/spatial/tree`, { params });
  return data;
}

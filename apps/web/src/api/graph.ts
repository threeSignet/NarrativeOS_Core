// /api/graph HTTP 封装——关系图谱只读（里程碑②）
import axios from 'axios';
import type { GraphView } from './types';

const http = axios.create({ baseURL: '/api' });

/** 获取关系图谱视图
 * @param mode world（正式关系，默认）/ relationship（含候选）/ spatial / timeline
 * @param layers 逗号分隔的来源层过滤，如 "committed,association"
 */
export async function getGraph(
  projectId: string,
  mode: 'world' | 'relationship' | 'spatial' | 'timeline' = 'world',
  layers?: string,
): Promise<GraphView> {
  const params: Record<string, string> = { mode };
  if (layers) params.layers = layers;
  const { data } = await http.get<GraphView>(`/projects/${projectId}/graph`, { params });
  return data;
}

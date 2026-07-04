// /api/entities HTTP 封装——实体卡只读（里程碑②）
import axios from 'axios';
import type { EntitySketchStatus } from './types';

const http = axios.create({ baseURL: '/api' });

/** 实体卡视图（镜像后端 EntityCardView） */
export interface EntityCard {
  id: string;
  name: string;
  typeLabel: string;
  statusLabel: string;
  status: EntitySketchStatus;
  summary?: string;
  aliases: string[];
  tags: string[];
}

/** 列出实体（status 省略=全部；status=registered/candidate 单类） */
export async function listEntities(projectId: string, status?: 'registered' | 'candidate'): Promise<EntityCard[]> {
  const params = status ? { status } : {};
  const { data } = await http.get<EntityCard[]>(`/projects/${projectId}/entities`, { params });
  return data;
}

/** 获取单个实体卡 */
export async function getEntity(projectId: string, id: string): Promise<EntityCard> {
  const { data } = await http.get<EntityCard>(`/projects/${projectId}/entities/${id}`);
  return data;
}

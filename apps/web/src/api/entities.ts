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

// ===== 写入（里程碑③：审核态机）=====

/** 创建实体（一步到位建 hint + promote 到 candidate） */
export async function createEntity(
  projectId: string,
  input: { displayName: string; typeLabel: string; summary?: string },
): Promise<EntityCard> {
  const { data } = await http.post<EntityCard>(`/projects/${projectId}/entities`, input);
  return data;
}

/** hint → candidate */
export async function promoteEntity(projectId: string, id: string): Promise<EntityCard> {
  const { data } = await http.post<EntityCard>(`/projects/${projectId}/entities/${id}/promote`);
  return data;
}

/** candidate → approved（自动建 PendingDecision） */
export async function approveEntity(projectId: string, id: string): Promise<EntityCard> {
  const { data } = await http.post<EntityCard>(`/projects/${projectId}/entities/${id}/approve`);
  return data;
}

/** approved → registered（确认注册进 Core，走短通道） */
export async function registerEntity(projectId: string, id: string): Promise<EntityCard> {
  const { data } = await http.post<EntityCard>(`/projects/${projectId}/entities/${id}/register`);
  return data;
}

/** 废弃实体 */
export async function deprecateEntity(projectId: string, id: string, reason?: string): Promise<void> {
  await http.delete(`/projects/${projectId}/entities/${id}`, { data: { reason } });
}

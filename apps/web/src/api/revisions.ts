// /api/revisions HTTP 封装——修订历史只读（迭代 D2）
import axios from 'axios';
const http = axios.create({ baseURL: '/api' });

export type RevisionTargetType =
  | 'draft' | 'prose_document' | 'entity_sketch' | 'chapter_plan' | 'scene_plan'
  | 'foreshadowing_plan' | 'reveal_plan' | 'style_guide' | 'other';
export type RevisionAction = 'create' | 'update' | 'delete' | 'restore' | 'reorder';

export interface RevisionRecord {
  id: string; projectId: string;
  targetType: RevisionTargetType; targetId: string;
  action: RevisionAction; summary: string;
  beforeSnapshot?: Record<string, unknown>;
  afterSnapshot?: Record<string, unknown>;
  versionGroupId: string;
  operator: 'author' | 'agent';
  createdAt: string; updatedAt: string;
}

export const TARGET_TYPE_LABELS: Record<RevisionTargetType, string> = {
  draft: '草案', prose_document: '正文', entity_sketch: '实体',
  chapter_plan: '章节', scene_plan: '场景',
  foreshadowing_plan: '伏笔', reveal_plan: '揭示计划',
  style_guide: '风格指南', other: '其他',
};

export const ACTION_LABELS: Record<RevisionAction, string> = {
  create: '创建', update: '更新', delete: '删除', restore: '恢复', reorder: '重排',
};

export const ACTION_COLORS: Record<RevisionAction, string> = {
  create: 'var(--st-committed)', update: 'var(--st-draft)',
  delete: 'var(--danger)', restore: 'var(--success)', reorder: 'var(--st-candidate)',
};

export async function listRevisions(projectId: string, limit?: number): Promise<RevisionRecord[]> {
  const { data } = await http.get<RevisionRecord[]>(`/projects/${projectId}/revisions`, { params: limit ? { limit } : {} });
  return data;
}

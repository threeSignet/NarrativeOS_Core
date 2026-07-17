// /api/ideas HTTP 封装——灵感卡片 CRUD（迭代 B1）
import axios from 'axios';

const http = axios.create({ baseURL: '/api' });

export type IdeaKind =
  | 'premise' | 'character' | 'location' | 'faction'
  | 'item' | 'mechanism' | 'theme' | 'style';

export type IdeaMaturity =
  | 'raw' | 'candidate' | 'structured' | 'ready_for_draft' | 'archived';

export interface IdeaCard {
  id: string;
  projectId: string;
  content: string;
  summary?: string;
  kind: IdeaKind;
  maturity: IdeaMaturity;
  tags: string[];
  source: 'manual' | 'chat' | 'import' | 'prose_selection' | 'agent_suggestion';
  linkedDraftIds: string[];
  createdAt: string;
  updatedAt: string;
}

/** 灵感类型 → 中文标签 */
export const IDEA_KIND_LABELS: Record<IdeaKind, string> = {
  premise: '前提',
  character: '角色',
  location: '地点',
  faction: '势力',
  item: '物品',
  mechanism: '机制',
  theme: '主题',
  style: '风格',
};

/** 成熟度 → 中文标签 */
export const IDEA_MATURITY_LABELS: Record<IdeaMaturity, string> = {
  raw: '原始',
  candidate: '候选',
  structured: '已结构化',
  ready_for_draft: '待转草案',
  archived: '已归档',
};

/** 成熟度 → 状态色（侧栏圆点用） */
export const IDEA_MATURITY_COLORS: Record<IdeaMaturity, string> = {
  raw: 'var(--st-hint)',
  candidate: 'var(--st-candidate)',
  structured: 'var(--st-draft)',
  ready_for_draft: 'var(--st-committed)',
  archived: 'var(--text-3)',
};

export async function listIdeas(
  projectId: string,
  filter?: { maturity?: IdeaMaturity; kind?: IdeaKind },
): Promise<IdeaCard[]> {
  const { data } = await http.get<IdeaCard[]>(`/projects/${projectId}/ideas`, { params: filter });
  return data;
}

export async function getIdea(projectId: string, id: string): Promise<IdeaCard> {
  const { data } = await http.get<IdeaCard>(`/projects/${projectId}/ideas/${id}`);
  return data;
}

export async function captureIdea(
  projectId: string,
  input: { content: string; kind?: IdeaKind; tags?: string[] },
): Promise<IdeaCard> {
  const { data } = await http.post<IdeaCard>(`/projects/${projectId}/ideas`, input);
  return data;
}

export async function updateIdea(
  projectId: string,
  id: string,
  updates: { content?: string; summary?: string | null; tags?: string[]; kind?: IdeaKind },
): Promise<IdeaCard> {
  const { data } = await http.patch<IdeaCard>(`/projects/${projectId}/ideas/${id}`, updates);
  return data;
}

export async function discardIdea(projectId: string, id: string): Promise<void> {
  await http.post(`/projects/${projectId}/ideas/${id}/discard`);
}

export async function restoreIdea(projectId: string, id: string): Promise<IdeaCard> {
  const { data } = await http.post<IdeaCard>(`/projects/${projectId}/ideas/${id}/restore`);
  return data;
}

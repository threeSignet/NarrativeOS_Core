// /api/readers HTTP 封装——读者认知模型（迭代 C3）
import axios from 'axios';
const http = axios.create({ baseURL: '/api' });

export type ReaderAudienceKind = 'target_reader' | 'reread_reader' | 'author_view' | 'custom';
export type ReaderKnowledgeStateValue =
  | 'unknown' | 'hinted' | 'suspected' | 'known' | 'misled' | 'revealed' | 'forgotten_risk';

export interface ReaderAudienceProfile {
  id: string; projectId: string; label: string;
  kind: ReaderAudienceKind; enabled: boolean; notes?: string;
}

export interface ReaderKnowledgeState {
  id: string; audienceId: string;
  /** 叙述位置（后端返回 narrativePositionRef，前端只读不消费） */
  narrativePositionRef?: { objectType: string; objectId: string };
  subjectRef: string; state: ReaderKnowledgeStateValue;
  confidence: number; sourceRefs: string[];
  createdAt: string; updatedAt: string;
}

export const AUDIENCE_KIND_LABELS: Record<ReaderAudienceKind, string> = {
  target_reader: '目标读者',
  reread_reader: '重读者',
  author_view: '作者视角',
  custom: '自定义',
};

export const KNOWLEDGE_STATE_LABELS: Record<ReaderKnowledgeStateValue, string> = {
  unknown: '未知',
  hinted: '已暗示',
  suspected: '已怀疑',
  known: '已知',
  misled: '被误导',
  revealed: '已揭示',
  forgotten_risk: '遗忘风险',
};

export const KNOWLEDGE_STATE_COLORS: Record<ReaderKnowledgeStateValue, string> = {
  unknown: 'var(--st-hint)',
  hinted: 'var(--st-draft)',
  suspected: 'var(--st-candidate)',
  known: 'var(--st-committed)',
  misled: 'var(--st-association)',
  revealed: 'var(--success)',
  forgotten_risk: 'var(--st-deprecated)',
};

export async function listAudiences(projectId: string): Promise<ReaderAudienceProfile[]> {
  const { data } = await http.get<ReaderAudienceProfile[]>(`/projects/${projectId}/readers`);
  return data;
}
export async function createAudience(projectId: string, input: { label: string; kind: ReaderAudienceKind; notes?: string }): Promise<ReaderAudienceProfile> {
  const { data } = await http.post<ReaderAudienceProfile>(`/projects/${projectId}/readers`, input);
  return data;
}
export async function listKnowledgeStates(projectId: string, audienceId: string): Promise<ReaderKnowledgeState[]> {
  const { data } = await http.get<ReaderKnowledgeState[]>(`/projects/${projectId}/readers/${audienceId}/knowledge`);
  return data;
}
export async function createKnowledgeState(projectId: string, audienceId: string, input: { subjectRef: string; state: ReaderKnowledgeStateValue; confidence?: number }): Promise<ReaderKnowledgeState> {
  const { data } = await http.post<ReaderKnowledgeState>(`/projects/${projectId}/readers/${audienceId}/knowledge`, input);
  return data;
}
export async function updateKnowledgeState(projectId: string, kid: string, state: ReaderKnowledgeStateValue, confidence?: number): Promise<void> {
  await http.patch(`/projects/${projectId}/readers/knowledge/${kid}`, { state, confidence });
}

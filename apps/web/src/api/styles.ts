// /api/styles HTTP 封装——风格指南只读+编辑（迭代 D3）
import axios from 'axios';
const http = axios.create({ baseURL: '/api' });

export type NarrativePerson = 'first' | 'third' | 'omniscient' | 'mixed' | 'unspecified';
export type NarrativeDistance = 'close' | 'medium' | 'distant' | 'variable';
export type PacingPreference = 'tight' | 'balanced' | 'slow_burn' | 'variable';
export type DescriptionPreference = 'action' | 'psychology' | 'sensory' | 'environment' | 'dialogue';
export type StyleGuideStatus = 'draft' | 'active' | 'archived';
export type StyleExampleKind = 'positive' | 'negative';

export interface StyleGuide {
  id: string; projectId: string; name: string;
  narrativePerson: NarrativePerson; narrativeDistance: NarrativeDistance;
  pacingPreference: PacingPreference; descriptionPreference: DescriptionPreference[];
  bannedExpressionIds: string[]; exampleIds: string[];
  scope: 'default' | 'variant'; scopeNote?: string;
  status: StyleGuideStatus; version: number;
  createdAt: string; updatedAt: string;
}

export interface StyleExample {
  id: string; projectId: string; kind: StyleExampleKind;
  text: string; note?: string; sourceBlockId?: string;
  createdAt: string; updatedAt: string;
}

export interface BannedExpression {
  id: string; projectId: string; pattern: string;
  reason?: string; category?: string;
  createdAt: string; updatedAt: string;
}

export const PERSON_LABELS: Record<NarrativePerson, string> = {
  first: '第一人称', third: '第三人称', omniscient: '全知视角', mixed: '混合视角', unspecified: '未指定',
};
export const DISTANCE_LABELS: Record<NarrativeDistance, string> = {
  close: '贴近', medium: '适中', distant: '疏离', variable: '灵活切换',
};
export const PACING_LABELS: Record<PacingPreference, string> = {
  tight: '紧凑', balanced: '均衡', slow_burn: '慢热', variable: '灵活切换',
};
export const DESC_LABELS: Record<DescriptionPreference, string> = {
  action: '动作', psychology: '心理', sensory: '感官', environment: '环境', dialogue: '对话',
};
export const STATUS_LABELS: Record<StyleGuideStatus, string> = {
  draft: '草稿', active: '启用', archived: '归档',
};
export const EXAMPLE_KIND_LABELS: Record<StyleExampleKind, string> = {
  positive: '正向示例', negative: '反向示例',
};
export const EXAMPLE_KIND_COLORS: Record<StyleExampleKind, string> = {
  positive: 'var(--success)', negative: 'var(--danger)',
};

// ---- HTTP ----

export async function getOrCreateGuide(projectId: string): Promise<StyleGuide> {
  const { data } = await http.get<StyleGuide>(`/projects/${projectId}/styles`);
  return data;
}

export async function updateGuide(projectId: string, id: string, updates: Partial<Pick<StyleGuide, 'name' | 'narrativePerson' | 'narrativeDistance' | 'pacingPreference' | 'descriptionPreference' | 'status' | 'scopeNote'>>): Promise<StyleGuide> {
  const { data } = await http.patch<StyleGuide>(`/projects/${projectId}/styles/${id}`, updates);
  return data;
}

export async function listExamples(projectId: string): Promise<StyleExample[]> {
  const { data } = await http.get<StyleExample[]>(`/projects/${projectId}/styles/examples`);
  return data;
}

export async function addExample(projectId: string, input: { kind: StyleExampleKind; text: string; note?: string }): Promise<StyleExample> {
  const { data } = await http.post<StyleExample>(`/projects/${projectId}/styles/examples`, input);
  return data;
}

export async function listBanned(projectId: string): Promise<BannedExpression[]> {
  const { data } = await http.get<BannedExpression[]>(`/projects/${projectId}/styles/banned`);
  return data;
}

export async function addBanned(projectId: string, input: { pattern: string; reason?: string; category?: string }): Promise<BannedExpression> {
  const { data } = await http.post<BannedExpression>(`/projects/${projectId}/styles/banned`, input);
  return data;
}

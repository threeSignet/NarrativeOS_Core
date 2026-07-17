// /api/scenes HTTP 封装——场景卡 CRUD（迭代 D1）
import axios from 'axios';
const http = axios.create({ baseURL: '/api' });

export type ScenePurpose =
  | 'setup' | 'conflict' | 'reveal' | 'transition'
  | 'payoff' | 'reversal' | 'character' | 'worldbuilding';

export type ScenePlanStatus = 'planned' | 'drafting' | 'written' | 'reviewing' | 'done' | 'cut';

export interface ScenePlan {
  id: string; projectId: string;
  chapterId: string; order: number; title: string;
  purpose: ScenePurpose[];
  povEntityId?: string;
  spatialNodeId?: string; temporalRef?: string;
  participants: string[];
  expectedOutcome?: string;
  linkedProseBlockIds: string[];
  status: ScenePlanStatus;
  version: number;
  createdAt: string; updatedAt: string;
}

export const SCENE_PURPOSE_LABELS: Record<ScenePurpose, string> = {
  setup: '铺垫', conflict: '冲突', reveal: '揭示', transition: '过渡',
  payoff: '回收', reversal: '反转', character: '角色', worldbuilding: '世界观',
};

export const SCENE_STATUS_LABELS: Record<ScenePlanStatus, string> = {
  planned: '已计划', drafting: '写作中', written: '已完稿',
  reviewing: '审核中', done: '已完成', cut: '已删除',
};

export const SCENE_STATUS_COLORS: Record<ScenePlanStatus, string> = {
  planned: 'var(--st-hint)', drafting: 'var(--st-draft)', written: 'var(--st-committed)',
  reviewing: 'var(--st-candidate)', done: 'var(--success)', cut: 'var(--st-deprecated)',
};

const STATUS_FLOW: ScenePlanStatus[] = ['planned', 'drafting', 'written', 'reviewing', 'done'];

export function nextSceneStatus(s: ScenePlanStatus): ScenePlanStatus | null {
  const i = STATUS_FLOW.indexOf(s);
  return i >= 0 && i < STATUS_FLOW.length - 1 ? STATUS_FLOW[i + 1]! : null;
}

export async function listScenes(projectId: string, chapterId?: string): Promise<ScenePlan[]> {
  const { data } = await http.get<ScenePlan[]>(`/projects/${projectId}/scenes`, { params: chapterId ? { chapterId } : {} });
  return data;
}

export async function createScene(projectId: string, input: {
  chapterId: string; title: string;
  purpose?: ScenePurpose[]; povEntityId?: string; participants?: string[]; expectedOutcome?: string;
}): Promise<ScenePlan> {
  const { data } = await http.post<ScenePlan>(`/projects/${projectId}/scenes`, input);
  return data;
}

export async function updateScene(projectId: string, id: string, expectedVersion: number, updates: Partial<Pick<ScenePlan, 'title' | 'purpose' | 'povEntityId' | 'participants' | 'expectedOutcome'>>): Promise<ScenePlan> {
  const { data } = await http.patch<ScenePlan>(`/projects/${projectId}/scenes/${id}`, { expectedVersion, ...updates });
  return data;
}

export async function transitionSceneStatus(projectId: string, id: string, targetStatus: ScenePlanStatus): Promise<ScenePlan> {
  const { data } = await http.post<ScenePlan>(`/projects/${projectId}/scenes/${id}/transition`, { targetStatus });
  return data;
}

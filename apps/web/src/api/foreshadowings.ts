// /api/foreshadowings HTTP 封装——伏笔看板（迭代 C1）
import axios from 'axios';

const http = axios.create({ baseURL: '/api' });

export type ForeshadowingKind =
  | 'clue' | 'suspense' | 'misdirection' | 'red_herring'
  | 'theme_echo' | 'world_rule_hint';

export type ForeshadowingPlanStatus =
  | 'planned' | 'active' | 'payoff_planned' | 'paid_off' | 'abandoned' | 'archived';

export interface ForeshadowingPlan {
  id: string;
  projectId: string;
  label: string;
  kind: ForeshadowingKind;
  targetReaderEffect: string;
  linkedEntityRefs: string[];
  linkedThreadId?: string;
  revealPlanId?: string;
  status: ForeshadowingPlanStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
}

/** 伏笔类型 → 中文标签 */
export const FORESHADOWING_KIND_LABELS: Record<ForeshadowingKind, string> = {
  clue: '线索',
  suspense: '悬念',
  misdirection: '误导',
  red_herring: '红鲱鱼',
  theme_echo: '主题呼应',
  world_rule_hint: '世界规则暗示',
};

/** 伏笔状态 → 中文标签 */
export const FORESHADOWING_STATUS_LABELS: Record<ForeshadowingPlanStatus, string> = {
  planned: '已计划',
  active: '铺设中',
  payoff_planned: '回收计划',
  paid_off: '已回收',
  abandoned: '已放弃',
  archived: '已归档',
};

/** 伏笔状态 → 颜色（看板列/圆点用） */
export const FORESHADOWING_STATUS_COLORS: Record<ForeshadowingPlanStatus, string> = {
  planned: 'var(--st-hint)',
  active: 'var(--st-draft)',
  payoff_planned: 'var(--st-candidate)',
  paid_off: 'var(--st-committed)',
  abandoned: 'var(--st-deprecated)',
  archived: 'var(--text-3)',
};

/** 状态推进顺序（planned → active → payoff_planned → paid_off；abandoned/archived 为终态分支） */
export const STATUS_FLOW: ForeshadowingPlanStatus[] = ['planned', 'active', 'payoff_planned', 'paid_off'];

export async function listForeshadowings(projectId: string): Promise<ForeshadowingPlan[]> {
  const { data } = await http.get<ForeshadowingPlan[]>(`/projects/${projectId}/foreshadowings`);
  return data;
}

export async function createForeshadowing(
  projectId: string,
  input: { label: string; kind: ForeshadowingKind; targetReaderEffect: string; linkedEntityRefs?: string[] },
): Promise<ForeshadowingPlan> {
  const { data } = await http.post<ForeshadowingPlan>(`/projects/${projectId}/foreshadowings`, input);
  return data;
}

export async function transitionForeshadowingStatus(
  projectId: string,
  id: string,
  targetStatus: ForeshadowingPlanStatus,
): Promise<{ success: boolean }> {
  const { data } = await http.post(`/projects/${projectId}/foreshadowings/${id}/transition`, { targetStatus });
  return data;
}

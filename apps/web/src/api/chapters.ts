// /api/chapters HTTP 封装——章节规划 CRUD + 状态推进 + 重排（迭代 A1）
import axios from 'axios';

const http = axios.create({ baseURL: '/api' });

/** 章节规划状态（镜像后端 ChapterPlanStatus） */
export type ChapterStatus = 'planned' | 'drafting' | 'written' | 'revising' | 'done';

/** 章节规划视图（镜像后端 ChapterPlan，§14.2） */
export interface ChapterPlan {
  id: string;
  projectId: string;
  order: number;
  title: string;
  goals: string[];
  povEntityId?: string;
  linkedSceneIds: string[];
  linkedThreadIds: string[];
  linkedDraftIds: string[];
  /** 关联的正文文档 ID（一章一正文，迭代 A2） */
  proseDocumentId?: string;
  status: ChapterStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
}

/** 章节状态 → 中文标签（§9.1 投影） */
export const CHAPTER_STATUS_LABELS: Record<ChapterStatus, string> = {
  planned: '计划中',
  drafting: '写作中',
  written: '已完稿',
  revising: '修订中',
  done: '已完成',
};

/** 章节状态 → 推进颜色（侧栏圆点用） */
export const CHAPTER_STATUS_COLORS: Record<ChapterStatus, string> = {
  planned: 'var(--st-hint)',
  drafting: 'var(--st-draft)',
  written: 'var(--st-committed)',
  revising: 'var(--st-candidate)',
  done: 'var(--success)',
};

/** 列出全部章节（按 order 升序） */
export async function listChapters(projectId: string): Promise<ChapterPlan[]> {
  const { data } = await http.get<ChapterPlan[]>(`/projects/${projectId}/chapters`);
  return data;
}

/** 获取单个章节 */
export async function getChapter(projectId: string, id: string): Promise<ChapterPlan> {
  const { data } = await http.get<ChapterPlan>(`/projects/${projectId}/chapters/${id}`);
  return data;
}

/** 创建章节（order 不传则自动放末尾） */
export async function createChapter(
  projectId: string,
  input: { title: string; order?: number; goals?: string[]; povEntityId?: string },
): Promise<ChapterPlan> {
  const { data } = await http.post<ChapterPlan>(`/projects/${projectId}/chapters`, input);
  return data;
}

/** 更新章节（乐观锁，需传当前 version 作为 expectedVersion） */
export async function updateChapter(
  projectId: string,
  id: string,
  expectedVersion: number,
  updates: Partial<Pick<ChapterPlan, 'title' | 'goals' | 'povEntityId' | 'order' | 'proseDocumentId'>>,
): Promise<ChapterPlan> {
  const { data } = await http.patch<ChapterPlan>(`/projects/${projectId}/chapters/${id}`, {
    expectedVersion,
    ...updates,
  });
  return data;
}

/** 推进章节状态 */
export async function transitionChapterStatus(
  projectId: string,
  id: string,
  targetStatus: ChapterStatus,
): Promise<ChapterPlan> {
  const { data } = await http.post<ChapterPlan>(`/projects/${projectId}/chapters/${id}/transition`, {
    targetStatus,
  });
  return data;
}

/** 重排章节顺序 */
export async function reorderChapters(projectId: string, orderedIds: string[]): Promise<{ success: boolean; count: number }> {
  const { data } = await http.post(`/projects/${projectId}/chapters/reorder`, { orderedIds });
  return data;
}

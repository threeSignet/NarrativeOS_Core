// /api/projects HTTP 封装——多项目管理
import axios from 'axios';

const http = axios.create({ baseURL: '/api' });

/** 项目对外视图（与 BFF toView 对齐） */
export interface ProjectView {
  id: string;
  title: string;
  premise: string;
  status: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  /** 项目下文档数（仅 listProjects 返回） */
  documentCount?: number;
}

/** 列出全部项目 + 当前激活 id */
export async function listProjects(): Promise<{ projects: ProjectView[]; activeId: string }> {
  const { data } = await http.get<{ projects: ProjectView[]; activeId: string }>('/projects');
  return data;
}

/** 取当前激活项目 */
export async function fetchCurrentProject(): Promise<ProjectView> {
  const { data } = await http.get<ProjectView>('/projects/current');
  return data;
}

/** 新建项目 */
export async function createProject(title: string, premise?: string): Promise<ProjectView> {
  const { data } = await http.post<ProjectView>('/projects', { title, premise });
  return data;
}

/** 切换激活项目 */
export async function activateProject(pid: string): Promise<string> {
  const { data } = await http.post<{ activeId: string }>(`/projects/${pid}/activate`);
  return data.activeId;
}

/** 改项目元信息（名 / 前提） */
export async function updateProject(
  pid: string,
  patch: { title?: string; premise?: string },
): Promise<ProjectView> {
  const { data } = await http.patch<ProjectView>(`/projects/${pid}`, patch);
  return data;
}

/** 软删项目（级联）——返回新的激活 id（若删的是当前激活） */
export async function deleteProject(pid: string): Promise<string> {
  const { data } = await http.delete<{ ok: boolean; activeId: string }>(`/projects/${pid}`);
  return data.activeId;
}

/** 导出项目设定集为 Markdown（触发浏览器下载） */
export async function exportProject(pid: string, title: string): Promise<void> {
  const res = await http.get(`/projects/${pid}/export`, { responseType: 'blob' });
  // 触发浏览器下载
  const url = window.URL.createObjectURL(new Blob([res.data], { type: 'text/markdown;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${title}-设定集.md`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  window.URL.revokeObjectURL(url);
}

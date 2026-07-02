// /api/documents HTTP 封装——对接 BFF
import axios from 'axios';
import type { DocumentNode } from '../shell/types';

const http = axios.create({ baseURL: '/api' });

export interface CreateDocumentInput {
  kind?: 'folder' | 'document';
  parentId: string | null;
  title: string;
  template?: string;
  icon?: string;
  content?: string;
  contentFormat?: string;
  tags?: string[];
}

/** 列出项目文档树 */
export async function listDocuments(projectId: string): Promise<DocumentNode[]> {
  const { data } = await http.get<DocumentNode[]>(`/projects/${projectId}/documents`);
  return data;
}

/** 新建文件夹 / 文档 */
export async function createDocument(projectId: string, input: CreateDocumentInput): Promise<DocumentNode> {
  const { data } = await http.post<DocumentNode>(`/projects/${projectId}/documents`, input);
  return data;
}

/** 获取单个文档 */
export async function getDocument(id: string): Promise<DocumentNode> {
  const { data } = await http.get<DocumentNode>(`/documents/${id}`);
  return data;
}

/** 更新（内容/改名/移动——按传入字段分流，BFF 端处理） */
export async function updateDocument(
  id: string,
  expectedVersion: number,
  patch: { content?: string; contentFormat?: string; title?: string; parentId?: string | null },
): Promise<DocumentNode> {
  const { data } = await http.patch<DocumentNode>(`/documents/${id}`, { expectedVersion, ...patch });
  return data;
}

/** 同级重排 */
export async function reorderDocuments(projectId: string, parentId: string | null, orderedIds: string[]): Promise<void> {
  await http.post(`/projects/${projectId}/documents/reorder`, { parentId, orderedIds });
}

/** 批量导入文件（txt/md → 文档树子节点），返回新建的文档数组 */
export async function importFiles(
  projectId: string,
  parentId: string | null,
  files: Array<{ filename: string; content: string }>,
): Promise<DocumentNode[]> {
  const { data } = await http.post<{ created: DocumentNode[] }>(`/projects/${projectId}/documents/import`, { parentId, files });
  return data.created;
}

/** 归档（软删除，文件夹级联） */
export async function archiveDocument(id: string): Promise<void> {
  await http.delete(`/documents/${id}`);
}

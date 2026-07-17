// /api/prose HTTP 封装——正文文档读写（迭代 A2）
// §13.8 块级正文模型。前端编辑器用 Markdown 串读写，后端 ingestText 切分为块。
import axios from 'axios';

const http = axios.create({ baseURL: '/api' });

/** 正文文档（镜像后端 ProseDocument） */
export interface ProseDocument {
  id: string;
  projectId: string;
  title: string;
  versionId: string;
  mode: 'edit' | 'preview' | 'split';
  draftId?: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

/** 正文块（镜像后端 ProseBlock） */
export interface ProseBlock {
  id: string;
  documentId: string;
  kind: 'chapter_title' | 'scene_heading' | 'paragraph' | 'dialogue' | 'note' | 'separator';
  orderIndex: number;
  text: string;
  sceneId?: string;
  sourceRefs: string[];
}

/** 文档 + 块聚合视图（GET /prose/:id 返回） */
export interface ProseDocumentWithBlocks {
  document: ProseDocument;
  blocks: ProseBlock[];
}

/**
 * 块序列 → Markdown 串（前端读取用）。
 * chapter_title → # text；scene_heading → ## text；separator → ***；note → > text；其余 → 原文。
 * 段落间空行分隔。
 */
export function blocksToMarkdown(blocks: ProseBlock[]): string {
  const lines: string[] = [];
  for (const b of blocks) {
    switch (b.kind) {
      case 'chapter_title': lines.push(`# ${b.text}`); break;
      case 'scene_heading': lines.push(`## ${b.text}`); break;
      case 'separator': lines.push('***'); break;
      case 'note': lines.push(`> ${b.text}`); break;
      default: lines.push(b.text); // paragraph / dialogue
    }
    lines.push(''); // 块间空行
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** 获取文档 + 全部块 */
export async function getProseDocument(projectId: string, id: string): Promise<ProseDocumentWithBlocks> {
  const { data } = await http.get<ProseDocumentWithBlocks>(`/projects/${projectId}/prose/${id}`);
  return data;
}

/** 创建文档 */
export async function createProseDocument(
  projectId: string,
  input: { title: string; draftId?: string },
): Promise<ProseDocument> {
  const { data } = await http.post<ProseDocument>(`/projects/${projectId}/prose`, input);
  return data;
}

/** 纯文本批量写入（全量替换语义：先清旧块再写新块） */
export async function ingestProseText(
  projectId: string,
  id: string,
  text: string,
): Promise<{ success: boolean; addedCount: number }> {
  const { data } = await http.post(`/projects/${projectId}/prose/${id}/ingest`, { text });
  return data;
}

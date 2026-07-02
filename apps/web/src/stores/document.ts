// 文档树 store——管理项目全部文档，提供树形结构 + CRUD
import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import type { DocumentNode } from '../shell/types';
import * as api from '../api/documents';

export const useDocumentStore = defineStore('document', () => {
  // 全部文档（扁平，由 tree 计算属性组装成树）
  const documents = ref<DocumentNode[]>([]);
  // 当前选中节点 id
  const selectedId = ref<string | null>(null);
  // 展开的文件夹 id 集合
  const expanded = ref<Set<string>>(new Set());

  // ---------- VS Code 式就地创建：待提交的占位 ----------
  // 触发 + 按钮 / 右键新建后，树里出现一个内联 input 行，
  // 输入名字 Enter 提交（调 API）、Esc 取消（清占位）。
  // pendingCreate 为 null 表示没有进行中的创建。
  const pendingCreate = ref<{
    parentId: string | null;
    kind: 'folder' | 'document';
    /** 占位在树里出现的深度（决定缩进） */
    depth: number;
  } | null>(null);

  /** 发起一次就地创建（在指定父节点下，插一个占位行） */
  function startCreate(parentId: string | null, kind: 'folder' | 'document', depth: number) {
    // 创建前展开父文件夹（若 parentId 是文件夹）
    if (parentId) expanded.value.add(parentId);
    pendingCreate.value = { parentId, kind, depth };
  }

  /** 取消创建（Esc 或失焦） */
  function cancelCreate() {
    pendingCreate.value = null;
  }

  /** 提交创建（Enter）——空名校验，调 API，成功后清占位 */
  async function commitCreate(projectId: string, title: string): Promise<DocumentNode | null> {
    if (!pendingCreate.value) return null;
    const { parentId, kind } = pendingCreate.value;
    const trimmed = title.trim();
    if (!trimmed) { pendingCreate.value = null; return null; }
    pendingCreate.value = null; // 先清，避免重复提交
    try {
      const doc = kind === 'folder'
        ? await createFolder(projectId, parentId, trimmed)
        : await createDocument(projectId, parentId, trimmed);
      selectedId.value = doc.id;
      return doc;
    } catch (err) {
      console.error('创建失败', err);
      return null;
    }
  }

  /** 文档树（按 parentId 组装 + sortOrder 排序） */
  interface TreeNode extends DocumentNode {
    children: TreeNode[];
  }

  const tree = computed<TreeNode[]>(() => buildTree(documents.value));

  function buildTree(docs: DocumentNode[]): TreeNode[] {
    const byParent = new Map<string | null, DocumentNode[]>();
    for (const d of docs) {
      const key = d.parentId;
      if (!byParent.has(key)) byParent.set(key, []);
      byParent.get(key)!.push(d);
    }
    const make = (parentId: string | null): TreeNode[] => {
      const children = (byParent.get(parentId) ?? [])
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map(d => ({ ...d, children: make(d.id) }));
      return children;
    };
    return make(null);
  }

  function findById(id: string): DocumentNode | undefined {
    return documents.value.find(d => d.id === id);
  }

  async function loadTree(projectId: string) {
    documents.value = await api.listDocuments(projectId);
  }

  function select(id: string | null) {
    selectedId.value = id;
  }

  function toggleExpand(id: string) {
    if (expanded.value.has(id)) expanded.value.delete(id);
    else expanded.value.add(id);
  }

  // ---------- CRUD（操作后本地同步更新） ----------

  async function createFolder(projectId: string, parentId: string | null, title: string) {
    const doc = await api.createDocument(projectId, { kind: 'folder', parentId, title });
    documents.value.push(doc);
    if (parentId) expanded.value.add(parentId);
    return doc;
  }

  async function createDocument(projectId: string, parentId: string | null, title: string) {
    const doc = await api.createDocument(projectId, { kind: 'document', parentId, title });
    documents.value.push(doc);
    if (parentId) expanded.value.add(parentId);
    return doc;
  }

  async function rename(id: string, expectedVersion: number, newTitle: string) {
    const updated = await api.updateDocument(id, expectedVersion, { title: newTitle });
    patchLocal(updated);
    return updated;
  }

  async function updateContent(id: string, expectedVersion: number, content: string) {
    const updated = await api.updateDocument(id, expectedVersion, { content });
    patchLocal(updated);
    return updated;
  }

  async function move(id: string, expectedVersion: number, newParentId: string | null) {
    const updated = await api.updateDocument(id, expectedVersion, { parentId: newParentId });
    patchLocal(updated);
    return updated;
  }

  async function reorder(projectId: string, parentId: string | null, orderedIds: string[]) {
    await api.reorderDocuments(projectId, parentId, orderedIds);
    // 本地重排 sortOrder
    orderedIds.forEach((id, idx) => {
      const d = documents.value.find(x => x.id === id);
      if (d) d.sortOrder = idx;
    });
  }

  /** 批量导入文件到指定父节点下，返回新建文档数 */
  async function importFiles(projectId: string, parentId: string | null, files: Array<{ filename: string; content: string }>): Promise<number> {
    const created = await api.importFiles(projectId, parentId, files);
    for (const d of created) documents.value.push(d);
    if (parentId) expanded.value.add(parentId);
    return created.length;
  }

  async function archive(id: string) {
    await api.archiveDocument(id);
    // 级联删除后代（BFF 已级联软删，本地也要清）
    const toRemove = new Set<string>([id]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const d of documents.value) {
        if (d.parentId && toRemove.has(d.parentId) && !toRemove.has(d.id)) {
          toRemove.add(d.id);
          changed = true;
        }
      }
    }
    documents.value = documents.value.filter(d => !toRemove.has(d.id));
  }

  /** 用 BFF 返回的最新对象覆盖本地对应记录 */
  function patchLocal(updated: DocumentNode) {
    const idx = documents.value.findIndex(d => d.id === updated.id);
    if (idx !== -1) documents.value[idx] = updated;
  }

  return {
    documents, selectedId, expanded, tree,
    pendingCreate, startCreate, cancelCreate, commitCreate,
    findById, loadTree, select, toggleExpand,
    createFolder, createDocument, rename, updateContent, move, reorder, importFiles, archive,
  };
});

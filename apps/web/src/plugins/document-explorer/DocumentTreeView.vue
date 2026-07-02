<script setup lang="ts">
// 文档树侧栏视图：顶部标题 + 新建/导入按钮 + 搜索 + 递归树 + 就地创建占位行
import { ref, computed, watch } from 'vue';
import { useUiStore } from '../../stores/ui';
import { useDocumentStore } from '../../stores/document';
import { useToast } from '../../composables/useToast';
import DocumentTreeNode from './DocumentTreeNode.vue';
import CreateInputRow from './CreateInputRow.vue';

const ui = useUiStore();
const docs = useDocumentStore();
const toast = useToast();

const search = ref('');

// 项目级导入：选一个或多个 txt/md → 批量建子文档
const importInput = ref<HTMLInputElement | null>(null);

function triggerImport() {
  importInput.value?.click();
}

// 命令面板触发的导入请求：监听 importRequested 计数变化，打开文件选择器
watch(() => ui.importRequested, (n) => {
  if (n > 0) triggerImport();
});

async function onImportChosen(e: Event) {
  const input = e.target as HTMLInputElement;
  const fileList = input.files;
  if (!fileList || fileList.length === 0) return;
  // 落点：当前选中文件夹内部，否则根级
  const sel = selectedNode.value;
  const parentId = sel?.kind === 'folder' ? sel.id : null;
  try {
    const files: Array<{ filename: string; content: string }> = [];
    for (const f of Array.from(fileList)) {
      files.push({ filename: f.name, content: await f.text() });
    }
    const n = await docs.importFiles(ui.projectId, parentId, files);
    toast.success(n > 0 ? `已导入 ${n} 个文档` : '文件为空，未导入');
  } catch (err: any) {
    toast.error('导入失败：' + (err?.response?.data?.error || '未知错误'));
  } finally {
    input.value = '';
  }
}

// 搜索过滤后的树（按标题匹配，保留匹配节点的祖先链）
const filteredTree = computed(() => {
  if (!search.value.trim()) return docs.tree;
  const q = search.value.toLowerCase();
  const matchChain = (nodes: any[]): any[] => {
    const result: any[] = [];
    for (const n of nodes) {
      const selfMatch = n.title.toLowerCase().includes(q);
      const kids = matchChain(n.children);
      if (selfMatch || kids.length > 0) {
        result.push({ ...n, children: kids });
      }
    }
    return result;
  };
  return matchChain(docs.tree);
});

// 搜索时自动展开全部
const effectiveExpanded = computed(() => {
  if (search.value.trim()) return null; // null = 全展开（TreeNode 判定）
  return docs.expanded;
});

// 当前选中节点（决定 + 按钮的创建落点：选中文件夹内部，否则根级）
const selectedNode = computed(() => docs.selectedId ? docs.findById(docs.selectedId) : undefined);

// VS Code 行为：点 + 在"当前选中文件夹内部"创建；若选中的是文档或无选中，则在根级创建
function newFolder() {
  const sel = selectedNode.value;
  const parentId = sel?.kind === 'folder' ? sel.id : null;
  const depth = sel?.kind === 'folder' ? 1 : 0;
  docs.startCreate(parentId, 'folder', depth);
}
function newDocument() {
  const sel = selectedNode.value;
  const parentId = sel?.kind === 'folder' ? sel.id : null;
  const depth = sel?.kind === 'folder' ? 1 : 0;
  docs.startCreate(parentId, 'document', depth);
}

// 根级占位（pendingCreate.parentId === null 时在树顶显示）
const isRootPending = computed(() => docs.pendingCreate?.parentId === null);
</script>

<template>
  <div class="side-head">
    <span class="side-title">文档</span>
    <div class="side-actions">
      <button class="icon-btn" title="导入文件（txt/md）" @click="triggerImport">
        <svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
      </button>
      <button class="icon-btn" title="新建文件夹" @click="newFolder">
        <svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><path d="M12 11v4M10 13h4"/></svg>
      </button>
      <button class="icon-btn" title="新建文档" @click="newDocument">
        <svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6M12 12v4M10 14h4"/></svg>
      </button>
    </div>
  </div>

  <input
    ref="importInput"
    type="file"
    accept=".txt,.md,.markdown,text/plain,text/markdown"
    multiple
    class="hidden-import"
    @change="onImportChosen"
  />

  <div class="side-search">
    <svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>
    <input v-model="search" placeholder="搜索文档…" />
  </div>

  <div class="side-body">
    <!-- 根级占位创建行 -->
    <CreateInputRow
      v-if="isRootPending"
      :key="'root-' + docs.pendingCreate!.kind"
      :depth="0"
      :kind="docs.pendingCreate!.kind"
    />

    <DocumentTreeNode
      v-for="node in filteredTree"
      :key="node.id"
      :node="node"
      :depth="0"
      :expanded-set="effectiveExpanded"
    />
    <div v-if="filteredTree.length === 0 && !isRootPending" class="empty-state" style="height: auto; padding: var(--sp-6) var(--sp-3);">
      <div class="es-desc">{{ search ? '无匹配文档' : '点击右上 + 新建第一个文档' }}</div>
    </div>
  </div>
</template>

<style scoped>
.hidden-import { display: none; }
</style>

<script setup lang="ts">
// 文档树侧栏视图：顶部标题 + 新建/导入按钮 + 搜索 + 递归树 + 就地创建占位行
import { ref, computed, watch } from 'vue';
import { useUiStore } from '../../stores/ui';
import { useDocumentStore } from '../../stores/document';
import { useToast } from '../../composables/useToast';
import { UiSideHead, UiButton, UiIcon, UiSearchBar, UiSideBody, UiEmpty } from '../../components';
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
  <UiSideHead title="文档">
    <template #actions>
      <UiButton icon variant="ghost" size="sm" title="导入文件（txt/md）" @click="triggerImport">
        <UiIcon name="import" :size="15" />
      </UiButton>
      <UiButton icon variant="ghost" size="sm" title="新建文件夹" @click="newFolder">
        <UiIcon name="folder-plus" :size="15" />
      </UiButton>
      <UiButton icon variant="ghost" size="sm" title="新建文档" @click="newDocument">
        <UiIcon name="file-plus" :size="15" />
      </UiButton>
    </template>
  </UiSideHead>

  <input
    ref="importInput"
    type="file"
    accept=".txt,.md,.markdown,text/plain,text/markdown"
    multiple
    class="hidden-import"
    @change="onImportChosen"
  />

  <UiSearchBar v-model="search" placeholder="搜索文档…" />

  <UiSideBody>
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
    <UiEmpty
      v-if="filteredTree.length === 0 && !isRootPending"
      :description="search ? '无匹配文档' : '点击右上 + 新建第一个文档'"
    />
  </UiSideBody>
</template>

<style scoped>
/* 隐藏的文件选择 input（触发文件导入对话框） */
.hidden-import { display: none; }
</style>

<script setup lang="ts">
// 文档树节点：递归渲染 + 展开/折叠/选中/就地改名/右键菜单/HTML5 拖拽
import { computed, ref, nextTick } from 'vue';
import { useUiStore } from '../../stores/ui';
import { useDocumentStore } from '../../stores/document';
import { useToast } from '../../composables/useToast';
import { useConfirm } from '../../composables/useConfirm';
import type { DocumentNode } from '../../shell/types';
import CreateInputRow from './CreateInputRow.vue';

const props = defineProps<{
  node: DocumentNode & { children: any[] };
  depth: number;
  /** null=全展开（搜索态）；Set=正常展开集合 */
  expandedSet: Set<string> | null;
}>();

const ui = useUiStore();
const docs = useDocumentStore();
const toast = useToast();
const confirm = useConfirm();

const isExpanded = computed(() => {
  if (props.expandedSet === null) return true; // 搜索态全展开
  return props.expandedSet.has(props.node.id);
});
const hasChildren = computed(() => props.node.children.length > 0);
const isSelected = computed(() => docs.selectedId === props.node.id);
const isFolder = computed(() => props.node.kind === 'folder');

// 该文件夹内部是否有待创建占位（决定子列表首位是否插占位行）
const hasPendingCreate = computed(() => docs.pendingCreate?.parentId === props.node.id);
// 占位行必须在该文件夹展开时才可见
const showPendingCreate = computed(() => isFolder.value && isExpanded.value && hasPendingCreate.value);

// ---------- 就地重命名 ----------
const isRenaming = ref(false);
const renameValue = ref('');
const renameInput = ref<HTMLInputElement | null>(null);

async function startRename() {
  renameValue.value = props.node.title;
  isRenaming.value = true;
  await nextTick();
  renameInput.value?.focus();
  renameInput.value?.select();
}

async function commitRename() {
  if (!isRenaming.value) return;
  const v = renameValue.value.trim();
  isRenaming.value = false;
  if (!v || v === props.node.title) return;
  try {
    await docs.rename(props.node.id, props.node.version, v);
    ui.renameTab(props.node.id, v);
  } catch (err) {
    const msg = (err as any)?.response?.data?.error;
    toast.error('重命名失败：' + (msg || '版本冲突，请刷新'));
  }
}

function cancelRename() { isRenaming.value = false; }

function onRenameKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter') { e.preventDefault(); commitRename(); }
  else if (e.key === 'Escape') { e.preventDefault(); cancelRename(); }
}

// ---------- 右键菜单 ----------
const showMenu = ref(false);
const menuX = ref(0);
const menuY = ref(0);

function onContextMenu(e: MouseEvent) {
  e.preventDefault();
  docs.select(props.node.id);
  menuX.value = e.clientX;
  menuY.value = e.clientY;
  showMenu.value = true;
  document.addEventListener('click', closeMenu, { once: true });
}
function closeMenu() { showMenu.value = false; }

// VS Code 行为：在文件夹上右键新建 → 在该文件夹【内部】创建；
// 在文档上右键新建 → 在该文档【同级】（即其父下）创建。
function menuNewFolder() {
  closeMenu();
  const inFolder = isFolder.value;
  const parentId = inFolder ? props.node.id : props.node.parentId;
  const childDepth = inFolder ? props.depth + 1 : props.depth;
  if (inFolder) docs.select(props.node.id); // 选中文件夹，占位渲染在其内部
  docs.startCreate(parentId, 'folder', childDepth);
}

function menuNewDocument() {
  closeMenu();
  const inFolder = isFolder.value;
  const parentId = inFolder ? props.node.id : props.node.parentId;
  const childDepth = inFolder ? props.depth + 1 : props.depth;
  if (inFolder) docs.select(props.node.id);
  docs.startCreate(parentId, 'document', childDepth);
}

function menuRename() { closeMenu(); startRename(); }

async function menuArchive() {
  closeMenu();
  const ok = await confirm({
    title: `归档「${props.node.title}」？`,
    message: isFolder.value ? '文件夹内全部内容将一并归档。' : '归档后可在数据库中恢复，但界面不再显示。',
    confirmText: '归档',
    danger: true,
  });
  if (!ok) return;
  await docs.archive(props.node.id);
  if (ui.activeTabId === props.node.id) ui.activeTabId = null;
}

// ---------- 拖拽 ----------
const dragOver = ref(false);

function onDragStart(e: DragEvent) {
  e.dataTransfer?.setData('text/plain', props.node.id);
  e.dataTransfer!.effectAllowed = 'move';
}

function onDragOver(e: DragEvent) {
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  dragOver.value = true;
}

function onDragLeave() { dragOver.value = false; }

async function onDrop(e: DragEvent) {
  e.preventDefault();
  e.stopPropagation();
  dragOver.value = false;
  const draggedId = e.dataTransfer?.getData('text/plain');
  if (!draggedId || draggedId === props.node.id) return;

  const dragged = docs.findById(draggedId);
  if (!dragged) return;

  // 落点的父节点：拖到文件夹上=进入文件夹内部（落末尾）；拖到文档上=与该文档同级
  const targetParent = isFolder.value ? props.node.id : props.node.parentId;

  // 防循环：不能拖入自身或自身后代（store.move 已校验，这里提前拦避免无谓请求）
  if (targetParent === draggedId) return;

  // 防止拖到自己的后代文件夹里（会形成环）
  if (isFolder.value && dragged.kind === 'folder') {
    const descendantIds = collectDescendants(dragged.id);
    if (descendantIds.has(props.node.id)) {
      toast.error('不能把文件夹拖入它自己的子文件夹');
      return;
    }
  }

  try {
    // 跨文件夹：先 move（落到目标父节点末尾），再 reorder 到目标位置
    if (dragged.parentId !== targetParent) {
      await docs.move(draggedId, dragged.version, targetParent);
      if (isFolder.value) docs.expanded.add(props.node.id);
    }

    // 同级排序：把 dragged 插到当前节点之前（拖到文件夹上则放末尾）
    const siblings = docs.documents
      .filter(d => d.parentId === targetParent && d.id !== draggedId)
      .sort((a, b) => a.sortOrder - b.sortOrder);

    let orderedIds: string[];
    if (isFolder.value) {
      // 拖到文件夹上 → 落到该文件夹子列表末尾
      orderedIds = [...siblings.map(s => s.id), draggedId];
    } else {
      // 拖到文档上 → 插到该文档之前
      const idx = siblings.findIndex(s => s.id === props.node.id);
      orderedIds = [
        ...siblings.slice(0, Math.max(0, idx)).map(s => s.id),
        draggedId,
        ...siblings.slice(Math.max(0, idx)).map(s => s.id),
      ];
    }
    await docs.reorder(ui.projectId, targetParent, orderedIds);
  } catch (err) {
    const msg = (err as any)?.response?.data?.error;
    toast.error('移动失败：' + (msg || '未知错误'));
  }
}

/** 收集某节点的全部后代 id（防循环用） */
function collectDescendants(id: string): Set<string> {
  const result = new Set<string>();
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop()!;
    const kids = docs.documents.filter(d => d.parentId === cur);
    for (const k of kids) {
      if (!result.has(k.id)) { result.add(k.id); stack.push(k.id); }
    }
  }
  return result;
}

// 点击：文件夹=展开切换，文档=打开编辑
function onClick() {
  docs.select(props.node.id);
  if (isFolder.value) {
    docs.toggleExpand(props.node.id);
  } else {
    ui.openTab({ docId: props.node.id, title: props.node.title, editorType: 'writing-document' });
  }
}

// 双击进入就地重命名
function onDblClick() { startRename(); }
</script>

<template>
  <div>
    <div
      class="tree-node"
      :class="{ 'is-selected': isSelected, 'is-folder': isFolder, 'is-drop-target': dragOver }"
      :style="{ paddingLeft: depth * 14 + 'px' }"
      draggable="true"
      @click="onClick"
      @dblclick.stop="onDblClick"
      @contextmenu="onContextMenu"
      @dragstart="onDragStart"
      @dragover="onDragOver"
      @dragleave="onDragLeave"
      @drop="onDrop"
    >
      <span class="twisty" v-if="isFolder" @click.stop="docs.toggleExpand(node.id)">
        <svg v-if="isExpanded" class="ico" style="width:12px;height:12px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="m6 9 6 6 6-6"/></svg>
        <svg v-else class="ico" style="width:12px;height:12px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="m9 6 6 6-6 6"/></svg>
      </span>
      <span class="twisty placeholder" v-else></span>

      <svg v-if="isFolder" class="node-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
        <path v-if="isExpanded" d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z M3 11h18" />
        <path v-else d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
      </svg>
      <svg v-else class="node-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" /><path d="M14 2v6h6" />
      </svg>

      <span class="node-title truncate" v-if="!isRenaming">{{ node.title }}</span>
      <input
        v-else
        ref="renameInput"
        v-model="renameValue"
        class="rename-input"
        @click.stop
        @dblclick.stop
        @keydown="onRenameKeydown"
        @blur="commitRename"
      />
      <span v-if="node.wordCount && !isRenaming" class="node-meta faint mono">{{ node.wordCount }}字</span>
    </div>

    <!-- 文件夹展开后：若有待创建占位，插在子列表首位 -->
    <CreateInputRow
      v-if="showPendingCreate"
      :key="node.id + '-pending-' + docs.pendingCreate!.kind"
      :depth="depth + 1"
      :kind="docs.pendingCreate!.kind"
    />

    <!-- 递归子节点 -->
    <template v-if="isExpanded && hasChildren">
      <DocumentTreeNode
        v-for="child in node.children"
        :key="child.id"
        :node="child"
        :depth="depth + 1"
        :expanded-set="expandedSet"
      />
    </template>

    <!-- 右键菜单 -->
    <div v-if="showMenu" class="ctx-menu" :style="{ left: menuX + 'px', top: menuY + 'px' }" @click.stop>
      <button class="ctx-item" @click="menuNewFolder">新建文件夹</button>
      <button class="ctx-item" @click="menuNewDocument">新建文档</button>
      <div class="ctx-sep"></div>
      <button class="ctx-item" @click="menuRename">重命名</button>
      <button class="ctx-item ctx-danger" @click="menuArchive">归档</button>
    </div>
  </div>
</template>

<style scoped>
.tree-node {
  display: flex; align-items: center; gap: 4px;
  padding: 4px var(--sp-3) 4px 6px;
  cursor: pointer;
  border-left: 2px solid transparent;
  user-select: none;
  transition: background var(--t-fast);
}
.tree-node:hover { background: var(--bg-3); }
.tree-node.is-selected {
  background: var(--accent-bg);
  border-left-color: var(--accent);
}
.tree-node.is-drop-target {
  background: var(--accent-bg);
  outline: 1px dashed var(--accent-border);
  outline-offset: -1px;
}
.twisty {
  width: 16px; height: 16px;
  display: inline-flex; align-items: center; justify-content: center;
  color: var(--text-3); flex-shrink: 0;
}
.twisty.placeholder { width: 16px; }
.node-ico { width: 16px; height: 16px; color: var(--text-2); flex-shrink: 0; }
.node-title { flex: 1; font-size: var(--fs-13); color: var(--text); min-width: 0; }
.tree-node.is-folder .node-title { font-weight: 500; }
.node-meta { font-size: 10px; flex-shrink: 0; }
.rename-input {
  flex: 1; min-width: 0;
  background: var(--bg-input);
  border: 1px solid var(--accent-border);
  border-radius: var(--r-xs);
  padding: 1px 6px;
  font-size: var(--fs-13); color: var(--text);
  font-family: var(--font-ui);
}
.rename-input:focus { outline: none; border-color: var(--accent); }

.ctx-menu {
  position: fixed; z-index: 100;
  min-width: 160px;
  background: var(--bg-elev);
  border: 1px solid var(--border-2);
  border-radius: var(--r-sm);
  box-shadow: var(--shadow-pop);
  padding: 4px 0;
}
.ctx-item {
  display: block; width: 100%; text-align: left;
  padding: 6px 12px;
  font-size: var(--fs-sm); color: var(--text);
}
.ctx-item:hover { background: var(--bg-3); }
.ctx-danger { color: var(--danger); }
.ctx-danger:hover { background: var(--danger-bg); }
.ctx-sep { height: 1px; background: var(--border); margin: 4px 0; }
</style>

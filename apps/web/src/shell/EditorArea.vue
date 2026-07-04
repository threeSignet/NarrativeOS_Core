<script setup lang="ts">
// 编辑区：多标签 + 动态编辑器组件（按 tab.editorType 选组件）
// 设置页（项目设置 / 应用设置）作为特殊标签存在（VS Code 式）：
// 与文档标签并列在标签栏，点 × 关闭，激活时主区渲染对应设置页而非编辑器。
// 文档标签支持双击就地改名（替代编辑器内标题输入框）。
import { computed, ref, nextTick } from 'vue';
import { useUiStore } from '../stores/ui';
import { useDocumentStore } from '../stores/document';
import { getEditorComponent, getMainView, getActivityItems } from './plugin-registry';
import type { DocumentNode } from './types';
import ProjectSettingsPage from './ProjectSettingsPage.vue';
import AppSettingsPage from './AppSettingsPage.vue';

const ui = useUiStore();
const docs = useDocumentStore();

// 当前激活标签
const activeTab = computed(() => ui.tabs.find(t => t.docId === ui.activeTabId));
// 激活标签是否为设置类（决定主区渲染设置页还是编辑器）
const isSettingsTab = computed(() =>
  activeTab.value?.editorType === 'app-settings' || activeTab.value?.editorType === 'project-settings',
);

// 当前激活标签对应的文档（设置标签无对应文档）
const activeDoc = computed<DocumentNode | undefined>(() => {
  if (!ui.activeTabId || isSettingsTab.value) return undefined;
  return docs.findById(ui.activeTabId);
});

// 当前激活标签用的编辑器组件
const editorComp = computed(() => {
  const tab = activeTab.value;
  if (!tab) return undefined;
  return getEditorComponent(tab.editorType);
});

// 当前活动栏对应的模块主区视图（模块独占模式，如实体关系图谱）
const mainView = computed(() => getMainView(ui.activeActivity));
// 模块标题（从活动栏项的 title 取）
const moduleTitle = computed(() => {
  const item = getActivityItems().find((a) => a.id === ui.activeActivity);
  return item?.title ?? '';
});

function activateTab(docId: string) {
  ui.activeTabId = docId;
}

function closeTab(docId: string) {
  ui.closeTab(docId);
}

// ---------- 双击标签就地改名 ----------
const renamingId = ref<string | null>(null);
const renameValue = ref('');
let renameInputEl: HTMLInputElement | null = null;
/** 函数式 ref：v-for 中静态 ref 会变成数组，这里只关心正在编辑的那一个 */
function setRenameInput(el: Element | { $el?: Element } | null) {
  renameInputEl = (el as HTMLInputElement) ?? null;
}

/** 双击文档标签 → 进入就地编辑（设置标签不可改名） */
async function startRename(docId: string, editorType: string, currentTitle: string) {
  if (editorType === 'app-settings' || editorType === 'project-settings') return;
  renamingId.value = docId;
  renameValue.value = currentTitle;
  await nextTick();
  renameInputEl?.focus();
  renameInputEl?.select();
}

async function commitRename(docId: string) {
  const v = renameValue.value.trim();
  renamingId.value = null;
  if (!v) return;
  const doc = docs.findById(docId);
  if (!doc || v === doc.title) return;
  try {
    const updated = await docs.rename(docId, doc.version, v);
    ui.renameTab(docId, updated.title);
  } catch { /* 版本冲突等：放弃，store 层未改 */ }
}

function cancelRename() { renamingId.value = null; }

function onRenameKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLInputElement).blur(); }
  else if (e.key === 'Escape') { e.preventDefault(); cancelRename(); }
}
</script>

<template>
  <main class="main">
    <!-- 模块独占模式：显示模块标题栏（无标签） -->
    <div v-if="mainView" class="main-head module-head">
      <span class="module-title">{{ moduleTitle }}</span>
    </div>
    <!-- 文档/设置模式：标签栏（有标签时显示） -->
    <div v-else class="main-head" v-if="ui.tabs.length > 0">
      <div class="tabs-row">
        <div
          v-for="tab in ui.tabs"
          :key="tab.docId"
          class="tab"
          :class="{ 'is-active': tab.docId === ui.activeTabId, 'is-settings': tab.editorType === 'app-settings' || tab.editorType === 'project-settings' }"
          @click="activateTab(tab.docId)"
          @dblclick="startRename(tab.docId, tab.editorType, tab.title)"
        >
          <svg v-if="tab.editorType === 'app-settings'" class="tab-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/></svg>
          <svg v-else-if="tab.editorType === 'project-settings'" class="tab-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/></svg>
          <!-- 就地改名输入框（双击进入） -->
          <input
            v-if="renamingId === tab.docId"
            :ref="setRenameInput"
            v-model="renameValue"
            class="tab-rename-input"
            @click.stop
            @dblclick.stop
            @keydown="onRenameKeydown"
            @blur="commitRename(tab.docId)"
          />
          <span v-else class="tab-title">{{ tab.title }}</span>
          <button class="tab-close" @click.stop="closeTab(tab.docId)">×</button>
        </div>
      </div>
    </div>

    <div class="main-body">
      <!-- 设置标签：渲染对应设置页（显式标签，最高优先级） -->
      <AppSettingsPage v-if="activeTab?.editorType === 'app-settings'" />
      <ProjectSettingsPage v-else-if="activeTab?.editorType === 'project-settings'" />

      <!-- 模块独占主区：活动栏切到带 mainView 的模块时，直接渲染（不经标签） -->
      <component
        v-else-if="mainView"
        :is="mainView"
        :key="ui.activeActivity"
      />
      <!-- 文档标签：渲染文档编辑器（需 activeDoc） -->
      <component
        v-else-if="editorComp && activeDoc"
        :is="editorComp"
        :doc="activeDoc"
        :key="activeDoc.id"
      />
      <!-- 无文档：空状态 -->
      <div v-else class="empty-state">
        <svg class="ico" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/></svg>
        <div class="es-title">打开一个文档开始编辑</div>
        <div class="es-desc">在左侧文档树选择或新建文档</div>
      </div>
    </div>
  </main>
</template>

<style scoped>
.tabs-row {
  display: flex; align-items: stretch;
  height: 100%; width: 100%;
  overflow-x: auto;
}
.tab {
  display: flex; align-items: center; gap: 6px;
  padding: 0 var(--sp-3);
  border-right: 1px solid var(--border);
  color: var(--text-2); font-size: var(--fs-sm);
  cursor: pointer; white-space: nowrap;
  transition: background var(--t-fast);
}
.tab:hover { background: var(--bg-3); }
.tab.is-active { color: var(--text); background: var(--bg); border-top: 2px solid var(--accent); margin-top: -1px; padding-top: 1px; }
/* 设置类标签：斜体以区分普通文档 */
.tab.is-settings .tab-title { font-style: italic; }
.tab-ico { width: 14px; height: 14px; color: var(--text-3); fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; flex-shrink: 0; }
.tab.is-active .tab-ico { color: var(--text-2); }
.tab-title { max-width: 160px; overflow: hidden; text-overflow: ellipsis; }
.tab-rename-input {
  width: 120px; padding: 1px 4px;
  background: var(--bg-input); border: 1px solid var(--accent);
  border-radius: var(--r-xs); color: var(--text);
  font-size: var(--fs-sm); font-family: var(--font-ui);
}
.tab-rename-input:focus { outline: none; }
.tab-close {
  width: 18px; height: 18px; border-radius: var(--r-xs);
  display: inline-flex; align-items: center; justify-content: center;
  color: var(--text-3); font-size: 16px; line-height: 1;
}
.tab-close:hover { background: var(--bg-3); color: var(--text); }

/* 模块独占模式：标题栏 */
.module-head {
  display: flex; align-items: center;
  padding: 0 var(--sp-3);
}
.module-title {
  font-size: var(--fs-sm); font-weight: 600; color: var(--text-2);
  letter-spacing: 0.04em;
}
</style>

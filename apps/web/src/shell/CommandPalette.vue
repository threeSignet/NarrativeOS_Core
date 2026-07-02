<script setup lang="ts">
// =============================================================================
// 命令面板（Cmd/Ctrl+K）——VS Code 式全局搜索 + 命令执行
// =============================================================================
// 两大类结果（混合排序）：
//   1. 文档跳转：模糊匹配文档标题（含路径），选中 → 打开对应文档标签
//   2. 命令：常用操作（新建文档/文件夹、导入、打开设置、切换主题等）
//
// 交互：
//   - 输入实时过滤；↑↓ 选择；Enter 执行；Esc 关闭
//   - 无结果时显示空状态
//   - 点击遮罩关闭
// =============================================================================
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue';
import { useUiStore } from '../stores/ui';
import { useDocumentStore } from '../stores/document';
import { usePreferences, type Theme } from '../composables/usePreferences';

const ui = useUiStore();
const docs = useDocumentStore();
const { prefs, set } = usePreferences();

const query = ref('');
const selectedIndex = ref(0);
const inputEl = ref<HTMLInputElement | null>(null);

// ---------- 命令定义 ----------
interface Command {
  id: string;
  title: string;
  hint?: string;      // 右侧辅助说明（如快捷键）
  group: 'command';
  icon: 'file' | 'folder' | 'import' | 'settings' | 'app-settings' | 'theme' | 'sidebar';
  run: () => void;
}
interface DocItem {
  id: string;
  title: string;
  path: string;       // 祖先标题拼成的路径，便于区分同名
  docId: string;
  editorType: string;
  group: 'document';
}
type Item = Command | DocItem;

/** 静态命令清单（与当前项目/状态绑定） */
const commands = computed<Command[]>(() => {
  const sel = docs.selectedId ? docs.findById(docs.selectedId) : undefined;
  const parentId = sel?.kind === 'folder' ? sel.id : null;
  return [
    { id: 'new-doc', title: '新建文档', hint: '', group: 'command', icon: 'file',
      run: () => { docs.startCreate(parentId, 'document', sel?.kind === 'folder' ? 1 : 0); close(); } },
    { id: 'new-folder', title: '新建文件夹', group: 'command', icon: 'folder',
      run: () => { docs.startCreate(parentId, 'folder', sel?.kind === 'folder' ? 1 : 0); close(); } },
    { id: 'import', title: '导入文件（txt/md）', group: 'command', icon: 'import',
      run: () => { ui.setActiveActivity('document-explorer'); if (ui.sidebarHidden) ui.toggleSidebar(); ui.requestImport(); close(); } },
    { id: 'toggle-sidebar', title: ui.sidebarHidden ? '显示侧栏' : '隐藏侧栏', group: 'command', icon: 'sidebar',
      run: () => { ui.toggleSidebar(); close(); } },
    { id: 'toggle-theme', title: prefs.value.theme === 'dark' ? '切换到浅色主题' : '切换到深色主题', group: 'command', icon: 'theme',
      run: () => { set('theme', (prefs.value.theme === 'dark' ? 'light' : 'dark') as Theme); close(); } },
    { id: 'project-settings', title: '打开项目设置', group: 'command', icon: 'settings',
      run: () => { ui.openSettings(); close(); } },
    { id: 'app-settings', title: '打开应用设置（编辑器/外观）', group: 'command', icon: 'app-settings',
      run: () => { ui.openAppSettings(); close(); } },
  ];
});

// ---------- 文档列表（带路径） ----------
/** 构造 id→路径 映射（祖先标题拼接） */
const docItems = computed<DocItem[]>(() => {
  const byId = new Map(docs.documents.map(d => [d.id, d]));
  const pathOf = (id: string): string => {
    const parts: string[] = [];
    let cur = byId.get(id);
    while (cur) {
      parts.unshift(cur.title);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    return parts.slice(0, -1).join(' / '); // 去掉自身标题，留祖先路径
  };
  return docs.documents
    .filter(d => d.kind === 'document')
    .map(d => ({
      id: d.id, docId: d.id, title: d.title,
      path: pathOf(d.id),
      // editorType 必须与 manifest 注册的 id 一致（'writing-document'），
      // 否则 getEditorComponent 返回 undefined，编辑器不渲染。
      editorType: 'writing-document',
      group: 'document' as const,
    }));
});

// ---------- 过滤 ----------
const filtered = computed<Item[]>(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) {
    // 空查询：显示全部命令 + 全部文档（命令在前）
    return [...commands.value, ...docItems.value];
  }
  const cmdHits = commands.value.filter(c => c.title.toLowerCase().includes(q));
  const docHits = docItems.value.filter(d =>
    d.title.toLowerCase().includes(q) || d.path.toLowerCase().includes(q),
  );
  return [...cmdHits, ...docHits];
});

// 选中项保持在范围内
watch(filtered, () => {
  if (selectedIndex.value >= filtered.value.length) selectedIndex.value = 0;
});

// ---------- 执行 ----------
function execute(item: Item) {
  if (item.group === 'command') {
    (item as Command).run();
  } else {
    const d = item as DocItem;
    ui.openTab({ docId: d.docId, title: d.title, editorType: d.editorType });
    close();
  }
}

function selectIndex(i: number) {
  if (filtered.value.length === 0) return;
  selectedIndex.value = (i + filtered.value.length) % filtered.value.length;
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'ArrowDown') { e.preventDefault(); selectIndex(selectedIndex.value + 1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); selectIndex(selectedIndex.value - 1); }
  else if (e.key === 'Enter') { e.preventDefault(); const it = filtered.value[selectedIndex.value]; if (it) execute(it); }
  else if (e.key === 'Escape') { e.preventDefault(); close(); }
}

// ---------- 打开/关闭 + 自动聚焦 ----------
function close() { ui.closeCommandPalette(); }

// 面板打开时聚焦输入框、重置查询
watch(() => ui.commandPaletteOpen, async (open) => {
  if (open) {
    query.value = '';
    selectedIndex.value = 0;
    await nextTick();
    inputEl.value?.focus();
  }
});

// 打开期间阻止背景滚动；卸载时恢复
let prevOverflow = '';
onMounted(() => { prevOverflow = document.body.style.overflow; });
onBeforeUnmount(() => { document.body.style.overflow = prevOverflow; });
</script>

<template>
  <transition name="cp-fade">
    <div v-if="ui.commandPaletteOpen" class="cp-overlay" @click="close">
      <div class="cp-panel" @click.stop>
        <!-- 输入区 -->
        <div class="cp-input-row">
          <svg class="cp-search-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>
          <input
            ref="inputEl"
            v-model="query"
            class="cp-input"
            placeholder="输入文档名或命令…"
            @keydown="onKeydown"
            spellcheck="false"
          />
          <kbd class="cp-kbd">Esc 关闭</kbd>
        </div>

        <!-- 结果列表 -->
        <div class="cp-list" v-if="filtered.length > 0">
          <button
            v-for="(item, i) in filtered"
            :key="item.group + '-' + item.id"
            class="cp-item"
            :class="{ 'is-selected': i === selectedIndex, 'is-cmd': item.group === 'command' }"
            @mousemove="selectedIndex = i"
            @click="execute(item)"
          >
            <!-- 图标 -->
            <span class="cp-icon" v-if="item.group === 'command'">
              <svg v-if="(item as any).icon === 'file'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/></svg>
              <svg v-else-if="(item as any).icon === 'folder'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/></svg>
              <svg v-else-if="(item as any).icon === 'import'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
              <svg v-else-if="(item as any).icon === 'sidebar'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="16" rx="2"/><line x1="9" y1="4" x2="9" y2="20"/></svg>
              <svg v-else-if="(item as any).icon === 'theme'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2"/></svg>
              <svg v-else-if="(item as any).icon === 'settings'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M12 1v6m0 10v6M4.2 4.2l4.3 4.3m7 7l4.3 4.3M1 12h6m10 0h6M4.2 19.8l4.3-4.3m7-7l4.3-4.3"/></svg>
              <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/></svg>
            </span>
            <span class="cp-icon" v-else>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/></svg>
            </span>

            <!-- 文本 -->
            <span class="cp-text">
              <span class="cp-title">{{ item.title }}</span>
              <span class="cp-path" v-if="item.group === 'document' && (item as DocItem).path">{{ (item as DocItem).path }}</span>
            </span>

            <!-- 分组标签 -->
            <span class="cp-tag" :class="item.group">{{ item.group === 'command' ? '命令' : '文档' }}</span>
          </button>
        </div>
        <div v-else class="cp-empty">无匹配结果</div>

        <!-- 底部提示 -->
        <div class="cp-foot">
          <span><kbd>↑</kbd><kbd>↓</kbd> 选择</span>
          <span><kbd>↵</kbd> 执行</span>
          <span><kbd>Esc</kbd> 关闭</span>
        </div>
      </div>
    </div>
  </transition>
</template>

<style scoped>
.cp-overlay {
  position: fixed; inset: 0;
  background: rgba(0, 0, 0, 0.4);
  backdrop-filter: blur(2px);
  z-index: 500;
  display: flex; justify-content: center;
  align-items: flex-start;
  padding-top: 12vh;
}
.cp-panel {
  width: 560px; max-width: 92vw;
  background: var(--bg-elev);
  border: 1px solid var(--border-2);
  border-radius: var(--r-md);
  box-shadow: var(--shadow-pop);
  overflow: hidden;
  display: flex; flex-direction: column;
  max-height: 70vh;
}

/* 输入区 */
.cp-input-row {
  display: flex; align-items: center; gap: var(--sp-2);
  padding: var(--sp-2) var(--sp-3);
  border-bottom: 1px solid var(--border);
}
.cp-search-ico { width: 16px; height: 16px; color: var(--text-3); flex-shrink: 0; }
.cp-input {
  flex: 1; border: none; background: transparent;
  font-size: var(--fs-md); color: var(--text);
  font-family: var(--font-ui);
}
.cp-input:focus { outline: none; }
.cp-kbd {
  font-family: var(--font-mono); font-size: var(--fs-xs);
  color: var(--text-3); flex-shrink: 0;
}

/* 列表 */
.cp-list { flex: 1; overflow-y: auto; padding: var(--sp-1); }
.cp-item {
  display: flex; align-items: center; gap: var(--sp-2);
  width: 100%; text-align: left;
  padding: var(--sp-2) var(--sp-3);
  border-radius: var(--r-sm);
  color: var(--text); font-size: var(--fs-sm);
  transition: background var(--t-fast);
}
.cp-item.is-selected { background: var(--accent-bg); }
.cp-item.is-cmd .cp-title { color: var(--text); }
.cp-icon { width: 18px; height: 18px; flex-shrink: 0; color: var(--text-3); display: inline-flex; }
.cp-icon svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
.cp-item.is-selected .cp-icon { color: var(--accent); }
.cp-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.cp-title { color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cp-path { font-size: var(--fs-xs); color: var(--text-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cp-tag {
  font-size: 10px; padding: 1px 6px; border-radius: var(--r-pill);
  border: 1px solid var(--border-2); color: var(--text-3); flex-shrink: 0;
}
.cp-tag.command { color: var(--accent); border-color: var(--accent-border); }

.cp-empty { padding: var(--sp-6); text-align: center; color: var(--text-3); font-size: var(--fs-sm); }

/* 底部 */
.cp-foot {
  display: flex; gap: var(--sp-4);
  padding: var(--sp-2) var(--sp-3);
  border-top: 1px solid var(--border);
  font-size: var(--fs-xs); color: var(--text-3);
}
.cp-foot kbd {
  font-family: var(--font-mono);
  background: var(--bg-3); padding: 0 4px; border-radius: var(--r-xs);
  border: 1px solid var(--border-2); margin-right: 2px;
}

/* 过渡 */
.cp-fade-enter-active, .cp-fade-leave-active { transition: opacity var(--t-fast); }
.cp-fade-enter-from, .cp-fade-leave-to { opacity: 0; }
.cp-fade-enter-active .cp-panel, .cp-fade-leave-active .cp-panel { transition: transform var(--t); }
.cp-fade-enter-from .cp-panel, .cp-fade-leave-to .cp-panel { transform: translateY(-12px); }
</style>

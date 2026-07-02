<script setup lang="ts">
// =============================================================================
// 富文本设定文档编辑器——TipTap + 工具栏 + 离线双写自动保存
// =============================================================================
// 能力（要求①②③ 全覆盖）：
//   - 段落/标题/列表/引用/加粗斜体/删除线/代码/分隔线 + 格式工具栏
//   - 文档级：导入文本 / 导出 Markdown / 复制纯文本（位于工具栏右侧）
//   - 自动保存：sync-engine 防抖 + 本地双写 + 离线回放（无阻塞 alert）
//   - 启动恢复：本地有比服务端更新的草稿时弹非阻塞确认
//   - 外观可调：字号/行距/段距/宽度/字体（由 usePreferences 驱动 CSS 变量）
//   - 文档标题不在编辑器内编辑——改为在标签栏双击标签就地改名
// =============================================================================
import { watch, ref, onMounted, onBeforeUnmount } from 'vue';
import { useEditor, EditorContent } from '@tiptap/vue-3';
import StarterKit from '@tiptap/starter-kit';
import { useUiStore } from '../../stores/ui';
import { useLocalDraftsStore } from '../../stores/localDrafts';
import { useConfirm } from '../../composables/useConfirm';
import { useToast } from '../../composables/useToast';
import { syncEngine } from '../../services/sync-engine';
import EditorToolbar from './EditorToolbar.vue';
import type { DocumentNode } from '../../shell/types';
import {
  plainTextToTiptapDoc,
  contentStringToMarkdown,
  contentStringToPlainText,
} from '../../utils/tiptapConvert';

const props = defineProps<{ doc: DocumentNode }>();
const ui = useUiStore();
const local = useLocalDraftsStore();
const confirm = useConfirm();
const toast = useToast();

// 正文：从 doc.content 初始化。优先 TipTap JSON，否则 HTML/空。
// 注意：若启动恢复检测到本地草稿，会在 onMounted 中覆盖。
const initialContent = (() => {
  if (!props.doc.content) return '';
  const c = props.doc.content.trim();
  if (c.startsWith('{')) {
    try { return JSON.parse(c); } catch { return c; }
  }
  return c;
})();

const editor = useEditor({
  content: initialContent,
  extensions: [StarterKit],
  editorProps: {
    attributes: {
      class: 'prose-editor',
      'data-placeholder': '开始写下你的设定…',
    },
  },
});

// ---------- 启动恢复：本地有更新草稿则提示恢复 ----------
onMounted(async () => {
  const snap = local.load(props.doc.id);
  if (snap && snap.version >= props.doc.version && snap.content !== props.doc.content) {
    const ok = await confirm({
      title: '检测到未保存的本地内容',
      message: `此文档在「${new Date(snap.savedAt).toLocaleString('zh-CN')}」有本地暂存的改动，比服务端更新。是否恢复本地内容？`,
      confirmText: '恢复本地',
      cancelText: '丢弃本地',
    });
    if (ok && editor.value) {
      try {
        editor.value.commands.setContent(JSON.parse(snap.content));
      } catch { /* 解析失败忽略 */ }
      toast.success('已恢复本地未保存的内容');
    } else {
      // 丢弃：清本地草稿，以服务端为准
      local.clear(props.doc.id);
    }
  }
});

// ---------- 自动保存（防抖，委托 sync-engine） ----------
// 标题不再在此编辑（改由标签栏双击改名），schedule 只处理正文内容。
function scheduleSave() {
  if (!editor.value) return;
  ui.syncState = 'syncing';
  const json = JSON.stringify(editor.value.getJSON());
  syncEngine.schedule(props.doc.id, props.doc.version, json);
}

// 监听编辑器更新 → 防抖保存
watch(() => editor.value, (ed) => {
  if (!ed) return;
  ed.on('update', scheduleSave);
}, { immediate: true });

// 切换文档时：flush 旧的，新文档由 props.doc.id key 变化自动重建
watch(() => props.doc.id, (newId, oldId) => {
  if (oldId) void syncEngine.flush(oldId);
});

// 离开前 flush
onBeforeUnmount(() => {
  void syncEngine.flush(props.doc.id);
});

// ---------- 文档级：导入 / 导出 / 复制（位于工具栏右侧） ----------
const fileInput = ref<HTMLInputElement | null>(null);

/** 触发文件选择器（导入文本到当前文档） */
function triggerImport() {
  fileInput.value?.click();
}

/** 读取选中的文件，把内容转为 TipTap 结构覆盖当前文档 */
async function onFileChosen(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file || !editor.value) return;
  try {
    const text = await file.text();
    const doc = plainTextToTiptapDoc(text);
    editor.value.commands.setContent(doc);
    scheduleSave(); // 触发保存
    toast.success(`已导入「${file.name}」`);
  } catch (err) {
    toast.error('导入失败：' + (err instanceof Error ? err.message : '未知错误'));
  } finally {
    // 重置 input，使同一文件可再次选择
    input.value = '';
  }
}

/** 导出当前文档为 Markdown 并下载 */
function exportMarkdown() {
  const json = editor.value ? JSON.stringify(editor.value.getJSON()) : props.doc.content;
  const md = contentStringToMarkdown(json);
  const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${props.doc.title || '文档'}.md`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  toast.success('已导出 Markdown');
}

/** 复制纯文本到剪贴板 */
async function copyPlainText() {
  const json = editor.value ? JSON.stringify(editor.value.getJSON()) : props.doc.content;
  const text = contentStringToPlainText(json);
  try {
    await navigator.clipboard.writeText(text);
    toast.success('已复制到剪贴板');
  } catch {
    // 降级：execCommand
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); toast.success('已复制到剪贴板'); }
    catch { toast.error('复制失败，请手动选择复制'); }
    document.body.removeChild(ta);
  }
}

/** 点击正文区空白处也聚焦编辑器（VS Code / Notion 行为） */
function focusEditor() {
  editor.value?.commands.focus();
}
</script>

<template>
  <div class="doc-editor-wrap">
    <!-- 格式工具栏（右侧插槽放导入/导出/复制） -->
    <EditorToolbar :editor="editor">
      <template #actions>
        <button class="doc-action-btn" title="导入文本（覆盖当前文档）" @click="triggerImport">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        </button>
        <button class="doc-action-btn" title="导出为 Markdown" @click="exportMarkdown">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
        </button>
        <button class="doc-action-btn" title="复制纯文本" @click="copyPlainText">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
        </button>
      </template>
    </EditorToolbar>

    <!-- 隐藏的文件选择器 -->
    <input
      ref="fileInput"
      type="file"
      accept=".txt,.md,.markdown,text/plain,text/markdown"
      class="hidden-file"
      @change="onFileChosen"
    />

    <!-- 正文：点击空白区也聚焦编辑器 -->
    <div class="doc-editor-scroll" @click="focusEditor">
      <EditorContent :editor="editor" />
    </div>
  </div>
</template>

<style scoped>
.doc-editor-wrap {
  height: 100%; display: flex; flex-direction: column;
  background: var(--editor-bg);
}
.hidden-file { display: none; }
/* 工具栏右侧动作按钮（插槽内容由本组件渲染，故样式定义在此）。
   尺寸与 EditorToolbar 的 .tb-btn 对齐。 */
.doc-action-btn {
  width: 28px; height: 28px;
  display: inline-flex; align-items: center; justify-content: center;
  color: var(--text-3); border-radius: var(--r-sm);
  transition: background var(--t-fast), color var(--t-fast);
  flex-shrink: 0;
}
.doc-action-btn svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
.doc-action-btn:hover { background: var(--bg-3); color: var(--text); }

.doc-editor-scroll {
  flex: 1; overflow-y: auto;
  display: flex; justify-content: center;
  cursor: text;
}
.doc-editor-scroll :deep(> div) {
  flex: 1;
  max-width: var(--editor-width);
  width: 100%;
  display: flex;
  flex-direction: column;
}
.doc-editor-scroll :deep(.prose-editor) {
  flex: 1;
  max-width: var(--editor-width); width: 100%;
  min-height: 300px;
  padding: var(--sp-6) var(--sp-4) var(--sp-8);
  color: var(--editor-text);
  font-size: var(--fs-editor);
  line-height: var(--editor-line-height);
  font-family: var(--editor-font-family);
}
.doc-editor-scroll :deep(.prose-editor:focus) { outline: none; }
.doc-editor-scroll :deep(.prose-editor p) { margin: var(--editor-para-gap) 0; }
.doc-editor-scroll :deep(.prose-editor h1) { font-size: var(--fs-2xl); margin: var(--sp-4) 0 var(--sp-2); font-family: var(--font-ui); }
.doc-editor-scroll :deep(.prose-editor h2) { font-size: var(--fs-xl); margin: var(--sp-4) 0 var(--sp-2); font-family: var(--font-ui); }
.doc-editor-scroll :deep(.prose-editor h3) { font-size: var(--fs-lg); margin: var(--sp-3) 0 var(--sp-2); font-family: var(--font-ui); }
.doc-editor-scroll :deep(.prose-editor ul),
.doc-editor-scroll :deep(.prose-editor ol) {
  /* 序号/圆点用 outside 定位落在 padding-left 区，必须留足宽度避免溢出左边界。
     li>p 嵌套结构下默认外边距会叠加，这里统一归零保证内容左对齐。 */
  list-style-position: outside;
  padding-left: 1.8em; margin: var(--editor-para-gap) 0;
}
.doc-editor-scroll :deep(.prose-editor li) { margin: 2px 0; padding-left: 0; }
.doc-editor-scroll :deep(.prose-editor li > p),
.doc-editor-scroll :deep(.prose-editor li > ul),
.doc-editor-scroll :deep(.prose-editor li > ol) { margin: 0; }
/* 有序列号与无序圆点用主题色，清晰可辨 */
.doc-editor-scroll :deep(.prose-editor ul li::marker) { color: var(--text-3); }
.doc-editor-scroll :deep(.prose-editor ol li::marker) { color: var(--text-3); font-variant-numeric: tabular-nums; }
.doc-editor-scroll :deep(.prose-editor blockquote) {
  border-left: 3px solid var(--accent);
  padding-left: var(--sp-3); margin: var(--sp-3) 0;
  color: var(--text-2); font-style: italic;
}
.doc-editor-scroll :deep(.prose-editor hr) {
  border: none; border-top: 1px solid var(--border-2);
  margin: var(--sp-4) 0;
}
.doc-editor-scroll :deep(.prose-editor code) {
  font-family: var(--font-mono); font-size: .92em;
  background: var(--bg-3); padding: 1px 5px; border-radius: var(--r-xs);
}
.doc-editor-scroll :deep(.ProseMirror p.is-editor-empty:first-child::before) {
  content: attr(data-placeholder);
  color: var(--text-3); pointer-events: none; float: left; height: 0;
}
</style>

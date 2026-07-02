<script setup lang="ts">
// =============================================================================
// 富文本工具栏——TipTap 编辑器顶部固定格式条
// =============================================================================
// 设计目标：让作者脱离 AI 也能完成全部文本编辑（要求①）。
// 全部能力来自 StarterKit 既有扩展，无需额外安装包。
// 按钮态联动编辑器选区（editor.isActive），激活态高亮。
// 工具组：撤销/重做 ｜ 行内标记 ｜ 标题 ｜ 列表 ｜ 块级 ｜ 清除格式
import { computed } from 'vue';
import type { Editor } from '@tiptap/vue-3';

const props = defineProps<{ editor: Editor | undefined }>();
const editor = computed(() => props.editor);

// 通用命令封装：编辑器未就绪时静默忽略（如初始化瞬间）
function run(fn: (e: Editor) => void) {
  const e = editor.value;
  if (!e) return;
  fn(e);
}

function toggleBold() { run(e => e.chain().focus().toggleBold().run()); }
function toggleItalic() { run(e => e.chain().focus().toggleItalic().run()); }
function toggleStrike() { run(e => e.chain().focus().toggleStrike().run()); }
function toggleCode() { run(e => e.chain().focus().toggleCode().run()); }
function toggleH1() { run(e => e.chain().focus().toggleHeading({ level: 1 }).run()); }
function toggleH2() { run(e => e.chain().focus().toggleHeading({ level: 2 }).run()); }
function toggleH3() { run(e => e.chain().focus().toggleHeading({ level: 3 }).run()); }
function toggleBullet() { run(e => e.chain().focus().toggleBulletList().run()); }
function toggleOrder() { run(e => e.chain().focus().toggleOrderedList().run()); }
function toggleQuote() { run(e => e.chain().focus().toggleBlockquote().run()); }
function insertHr() { run(e => e.chain().focus().setHorizontalRule().run()); }
function undo() { run(e => e.chain().focus().undo().run()); }
function redo() { run(e => e.chain().focus().redo().run()); }
function clearFormat() { run(e => e.chain().focus().unsetAllMarks().clearNodes().run()); }

// 激活态判定（联动选区）
const is = (name: string, attrs?: Record<string, unknown>) =>
  editor.value?.isActive(name, attrs) ?? false;
</script>

<template>
  <div class="editor-toolbar" v-if="editor">
   <div class="tb-left">
    <!-- 撤销 / 重做 -->
    <div class="tb-group">
      <button class="tb-btn" :disabled="!editor.can().undo()" title="撤销 (Ctrl+Z)" @click="undo">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/></svg>
      </button>
      <button class="tb-btn" :disabled="!editor.can().redo()" title="重做 (Ctrl+Shift+Z)" @click="redo">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 14 5-5-5-5"/><path d="M20 9H9a5 5 0 0 0 0 10h3"/></svg>
      </button>
    </div>

    <span class="tb-sep"></span>

    <!-- 行内标记 -->
    <div class="tb-group">
      <button class="tb-btn" :class="{ on: is('bold') }" title="加粗 (Ctrl+B)" @click="toggleBold">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4h7a4 4 0 0 1 0 8H6z"/><path d="M6 12h8a4 4 0 0 1 0 8H6z"/></svg>
      </button>
      <button class="tb-btn" :class="{ on: is('italic') }" title="斜体 (Ctrl+I)" @click="toggleItalic">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="5" x2="5" y2="19"/><line x1="15" y1="5" x2="5" y2="5"/><line x1="19" y1="19" x2="9" y2="19"/></svg>
      </button>
      <button class="tb-btn" :class="{ on: is('strike') }" title="删除线" @click="toggleStrike">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4H9a3 3 0 0 0-2.83 4"/><path d="M14 12a3 3 0 0 1 0 6H8a3 3 0 0 1-2.83-4"/><line x1="4" y1="12" x2="20" y2="12"/></svg>
      </button>
      <button class="tb-btn tb-mono" :class="{ on: is('code') }" title="行内代码" @click="toggleCode">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
      </button>
    </div>

    <span class="tb-sep"></span>

    <!-- 标题 -->
    <div class="tb-group">
      <button class="tb-btn tb-text" :class="{ on: is('heading', { level: 1 }) }" title="标题 1" @click="toggleH1">H1</button>
      <button class="tb-btn tb-text" :class="{ on: is('heading', { level: 2 }) }" title="标题 2" @click="toggleH2">H2</button>
      <button class="tb-btn tb-text" :class="{ on: is('heading', { level: 3 }) }" title="标题 3" @click="toggleH3">H3</button>
    </div>

    <span class="tb-sep"></span>

    <!-- 列表 -->
    <div class="tb-group">
      <button class="tb-btn" :class="{ on: is('bulletList') }" title="无序列表" @click="toggleBullet">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><circle cx="3.5" cy="6" r="1.3" fill="currentColor" stroke="none"/><circle cx="3.5" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="3.5" cy="18" r="1.3" fill="currentColor" stroke="none"/></svg>
      </button>
      <button class="tb-btn" :class="{ on: is('orderedList') }" title="有序列表" @click="toggleOrder">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="10" y1="6" x2="21" y2="6"/><line x1="10" y1="12" x2="21" y2="12"/><line x1="10" y1="18" x2="21" y2="18"/><path d="M4 6h1v4"/><path d="M4 10h2"/><path d="M6 17H4v-1h2v-1H4"/></svg>
      </button>
    </div>

    <span class="tb-sep"></span>

    <!-- 块级 -->
    <div class="tb-group">
      <button class="tb-btn" :class="{ on: is('blockquote') }" title="引用" @click="toggleQuote">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21c3 0 5-2 5-5V7a3 3 0 0 0-3-3H4a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h1"/><path d="M14 21c3 0 5-2 5-5V7a3 3 0 0 0-3-3h-1a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h1"/></svg>
      </button>
      <button class="tb-btn" title="分隔线" @click="insertHr">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="12" x2="20" y2="12"/></svg>
      </button>
    </div>

    <span class="tb-sep"></span>

    <!-- 清除格式 -->
    <div class="tb-group">
      <button class="tb-btn" title="清除格式" @click="clearFormat">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7V5h16v2"/><path d="M9 19h6"/><path d="M12 5v14"/><line x1="4" y1="4" x2="20" y2="20"/></svg>
      </button>
    </div>
   </div>
    <!-- 右侧动作插槽（导入/导出/复制等，由 DocumentEditor 注入） -->
    <div class="tb-actions">
      <slot name="actions" />
    </div>
  </div>
</template>

<style scoped>
.editor-toolbar {
  display: flex; align-items: center;
  justify-content: space-between;
  gap: 2px;
  padding: 4px var(--sp-4);
  border-bottom: 1px solid var(--border);
  background: var(--bg-2);
  flex-shrink: 0;
  /* 工具栏宽度跟随编辑器正文宽度居中 */
  max-width: var(--editor-width, 720px);
  width: 100%;
  margin: 0 auto;
  flex-wrap: wrap;
}
.tb-left { display: flex; align-items: center; gap: 2px; flex-wrap: wrap; }
.tb-actions { display: flex; align-items: center; gap: 1px; flex-shrink: 0; }
.tb-group { display: flex; align-items: center; gap: 1px; }
.tb-sep {
  width: 1px; height: 18px;
  background: var(--border-2);
  margin: 0 4px;
  flex-shrink: 0;
}
.tb-btn {
  width: 28px; height: 28px;
  display: inline-flex; align-items: center; justify-content: center;
  color: var(--text-2);
  border-radius: var(--r-sm);
  transition: background var(--t-fast), color var(--t-fast);
  flex-shrink: 0;
}
.tb-btn svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
.tb-btn:hover:not(:disabled) { background: var(--bg-3); color: var(--text); }
.tb-btn:disabled { opacity: .4; cursor: not-allowed; }
.tb-btn.on { background: var(--accent-bg); color: var(--accent); }
/* 文字按钮（H1/H2/H3） */
.tb-btn.tb-text {
  width: auto; padding: 0 7px;
  font-size: var(--fs-xs); font-weight: 600;
  font-family: var(--font-ui);
}
</style>

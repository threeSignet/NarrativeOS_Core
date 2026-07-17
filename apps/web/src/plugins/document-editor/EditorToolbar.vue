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
import { UiButton, UiIcon } from '../../components';

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
      <UiButton icon variant="ghost" :disabled="!editor.can().undo()" title="撤销 (Ctrl+Z)" @click="undo">
        <UiIcon name="undo" :size="16" />
      </UiButton>
      <UiButton icon variant="ghost" :disabled="!editor.can().redo()" title="重做 (Ctrl+Shift+Z)" @click="redo">
        <UiIcon name="redo" :size="16" />
      </UiButton>
    </div>

    <span class="tb-sep"></span>

    <!-- 行内标记 -->
    <div class="tb-group">
      <UiButton icon variant="ghost" :active="is('bold')" title="加粗 (Ctrl+B)" @click="toggleBold">
        <UiIcon name="bold" :size="16" :stroke-width="2.4" />
      </UiButton>
      <UiButton icon variant="ghost" :active="is('italic')" title="斜体 (Ctrl+I)" @click="toggleItalic">
        <UiIcon name="italic" :size="16" />
      </UiButton>
      <UiButton icon variant="ghost" :active="is('strike')" title="删除线" @click="toggleStrike">
        <UiIcon name="strike" :size="16" />
      </UiButton>
      <UiButton icon variant="ghost" :active="is('code')" title="行内代码" @click="toggleCode">
        <UiIcon name="code" :size="16" />
      </UiButton>
    </div>

    <span class="tb-sep"></span>

    <!-- 标题 -->
    <div class="tb-group">
      <UiButton variant="ghost" size="sm" :active="is('heading', { level: 1 })" title="标题 1" @click="toggleH1">H1</UiButton>
      <UiButton variant="ghost" size="sm" :active="is('heading', { level: 2 })" title="标题 2" @click="toggleH2">H2</UiButton>
      <UiButton variant="ghost" size="sm" :active="is('heading', { level: 3 })" title="标题 3" @click="toggleH3">H3</UiButton>
    </div>

    <span class="tb-sep"></span>

    <!-- 列表 -->
    <div class="tb-group">
      <UiButton icon variant="ghost" :active="is('bulletList')" title="无序列表" @click="toggleBullet">
        <UiIcon name="list-bullet" :size="16" />
      </UiButton>
      <UiButton icon variant="ghost" :active="is('orderedList')" title="有序列表" @click="toggleOrder">
        <UiIcon name="list-ordered" :size="16" />
      </UiButton>
    </div>

    <span class="tb-sep"></span>

    <!-- 块级 -->
    <div class="tb-group">
      <UiButton icon variant="ghost" :active="is('blockquote')" title="引用" @click="toggleQuote">
        <UiIcon name="quote" :size="16" />
      </UiButton>
      <UiButton icon variant="ghost" title="分隔线" @click="insertHr">
        <UiIcon name="hr" :size="16" />
      </UiButton>
    </div>

    <span class="tb-sep"></span>

    <!-- 清除格式 -->
    <div class="tb-group">
      <UiButton icon variant="ghost" title="清除格式" @click="clearFormat">
        <UiIcon name="clear-format" :size="16" />
      </UiButton>
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
</style>

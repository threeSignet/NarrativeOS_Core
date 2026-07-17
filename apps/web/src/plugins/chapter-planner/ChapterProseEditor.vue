<script setup lang="ts">
// =============================================================================
// 章节正文编辑器——TipTap 富文本 + 自动保存到 ProseDocument（迭代 A2）
// =============================================================================
// 与 DocumentEditor 的区别：
//   - DocumentEditor 编辑"设定文档"（writing_documents 表）
//   - ChapterProseEditor 编辑"章节正文"（writing_prose_documents/blocks，§13.8 块级模型）
//   - 保存方式：DocumentEditor 用 sync-engine 双写；本组件直接调 chapter.saveProse
//     （后端 ingestText 全量替换块，A2 简化模型，不维护块级 diff）
//
// 关键：编辑器内容用 TipTap JSON，保存时转 Markdown 串发给后端。
// 读取时后端返回块序列，转 Markdown 再解析回 TipTap。
import { watch, ref, onBeforeUnmount, computed } from 'vue';
import { useEditor, EditorContent } from '@tiptap/vue-3';
import StarterKit from '@tiptap/starter-kit';
import { useUiStore } from '../../stores/ui';
import { useChapterStore } from '../../stores/chapter';
import { useEntityStore } from '../../stores/entity';
import { useToast } from '../../composables/useToast';
import { UiButton, UiIcon, UiInput } from '../../components';
import { contentStringToMarkdown, plainTextToTiptapDoc } from '../../utils/tiptapConvert';
import EditorToolbar from '../document-editor/EditorToolbar.vue';

const ui = useUiStore();
const chapter = useChapterStore();
const entity = useEntityStore();
const toast = useToast();

// 已注册实体（POV 下拉用）。加载一次，切到章节活动栏时
const registeredEntities = computed(() => entity.entities.filter((e) => e.status === 'registered'));
async function ensureEntitiesLoaded() {
  if (ui.projectId && entity.entities.length === 0) {
    await entity.loadEntities(ui.projectId);
  }
}

const editor = useEditor({
  content: '',
  extensions: [StarterKit],
  editorProps: {
    attributes: {
      class: 'prose-editor',
      'data-placeholder': '写下这一章的故事…',
    },
  },
});

// 跟踪是否有内容未保存
const dirty = ref(false);
let saveTimer: ReturnType<typeof setTimeout> | undefined;

function scheduleSave() {
  if (!editor.value || !chapter.activeProseDocId || !ui.projectId) return;
  dirty.value = true;
  ui.syncState = 'syncing';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void doSave(), 1000);
}

async function doSave() {
  if (!editor.value || !ui.projectId || !chapter.activeProseDocId) return;
  try {
    const json = JSON.stringify(editor.value.getJSON());
    const md = contentStringToMarkdown(json);
    await chapter.saveProse(ui.projectId, md);
    dirty.value = false;
    ui.syncState = 'saved';
  } catch (e: any) {
    ui.syncState = 'error';
    toast.error('正文保存失败：' + (e?.message || '未知'));
  }
}

watch(() => editor.value, (ed) => {
  if (!ed) return;
  ed.on('update', scheduleSave);
}, { immediate: true });

const activeChapter = computed(() => chapter.selected());

// 章节规划编辑：goals（标签式）+ POV（实体下拉）
const goalInput = ref('');
const showInfoBar = ref(true);

function addGoal() {
  const g = goalInput.value.trim();
  if (!g || !activeChapter.value || activeChapter.value.goals.includes(g)) return;
  activeChapter.value.goals.push(g);
  goalInput.value = '';
  void saveChapterMeta();
}
function removeGoal(g: string) {
  if (!activeChapter.value) return;
  activeChapter.value.goals = activeChapter.value.goals.filter((x) => x !== g);
  void saveChapterMeta();
}
function onGoalKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter') { e.preventDefault(); addGoal(); }
  else if (e.key === 'Backspace' && !goalInput.value && activeChapter.value?.goals.length) {
    activeChapter.value.goals.pop();
    void saveChapterMeta();
  }
}
async function onPovChange(e: Event) {
  if (!activeChapter.value) return;
  activeChapter.value.povEntityId = (e.target as HTMLSelectElement).value || undefined;
  void saveChapterMeta();
}

/** 保存章节元信息（goals/povEntityId/title），乐观锁 */
async function saveChapterMeta() {
  if (!ui.projectId || !activeChapter.value) return;
  try {
    await chapter.editMeta(ui.projectId, activeChapter.value.id, {
      goals: activeChapter.value.goals,
      povEntityId: activeChapter.value.povEntityId,
    });
  } catch (e: any) {
    toast.error('章节信息保存失败：' + (e?.message || '版本冲突'));
  }
}

// 选中章节变化时加载正文
watch(() => chapter.selectedId, async (id, oldId) => {
  if (!id || id === oldId || !ui.projectId) return;
  void ensureEntitiesLoaded(); // POV 下拉需要已注册实体
  if (editor.value) editor.value.commands.setContent('');
  activeProseText.value = '';
  try {
    const md = await chapter.getOrCreateProse(ui.projectId, id);
    // Markdown → TipTap
    if (editor.value && md) {
      const doc = plainTextToTiptapDoc(md);
      editor.value.commands.setContent(doc);
    }
  } catch (e: any) {
    toast.error('打开正文失败：' + (e?.message || '未知'));
  }
});

const activeProseText = ref('');

onBeforeUnmount(() => {
  clearTimeout(saveTimer);
  void doSave();
});

function focusEditor() {
  editor.value?.commands.focus();
}
</script>

<template>
  <div class="prose-editor-wrap">
    <!-- 章节规划信息条：标题 + goals 标签 + POV 下拉（可折叠） -->
    <div v-if="activeChapter" class="chapter-info-bar">
      <div class="info-bar-head">
        <span class="info-chapter-label">第 {{ activeChapter.order }} 章</span>
        <span class="info-chapter-title">{{ activeChapter.title }}</span>
        <UiButton icon variant="ghost" size="sm" :title="showInfoBar ? '收起规划' : '展开规划'" @click="showInfoBar = !showInfoBar">
          <UiIcon :name="showInfoBar ? 'chevron-down' : 'chevron-right'" :size="14" />
        </UiButton>
      </div>
      <div v-if="showInfoBar" class="info-bar-body">
        <div class="info-field">
          <label class="info-label">章节目标</label>
          <div class="goals-box">
            <span v-for="g in activeChapter.goals" :key="g" class="goal-chip">
              {{ g }}
              <button class="goal-remove" title="移除" @click="removeGoal(g)">×</button>
            </span>
            <input
              v-model="goalInput"
              class="goal-input"
              placeholder="输入目标回车添加…"
              @keydown="onGoalKeydown"
            />
          </div>
        </div>
        <div class="info-field">
          <label class="info-label">POV 视角</label>
          <select
            class="pov-select"
            :value="activeChapter.povEntityId ?? ''"
            @change="onPovChange"
          >
            <option value="">无（上帝视角）</option>
            <option v-for="e in registeredEntities" :key="e.id" :value="e.id">{{ e.name }}（{{ e.typeLabel }}）</option>
          </select>
        </div>
      </div>
    </div>

    <EditorToolbar :editor="editor" />
    <div class="prose-editor-scroll" @click="focusEditor">
      <EditorContent :editor="editor" />
    </div>
    <!-- 无选中章节时的空状态 -->
    <div v-if="!chapter.selectedId" class="no-chapter-hint">
      <UiIcon name="file" :size="32" />
      <div>从左侧选择一章开始写作</div>
    </div>
  </div>
</template>

<style scoped>
.prose-editor-wrap {
  height: 100%; display: flex; flex-direction: column;
  background: var(--editor-bg);
  position: relative;
}

/* 章节规划信息条 */
.chapter-info-bar {
  flex-shrink: 0;
  background: var(--bg-2);
  border-bottom: 1px solid var(--border);
}
.info-bar-head {
  display: flex; align-items: center; gap: var(--sp-2);
  padding: var(--sp-2) var(--sp-4);
  max-width: var(--editor-width, 720px); margin: 0 auto; width: 100%;
}
.info-chapter-label { font-size: var(--fs-xs); color: var(--text-3); font-family: var(--font-mono); }
.info-chapter-title { font-size: var(--fs-md); font-weight: 500; color: var(--text); flex: 1; }
.info-bar-body {
  display: flex; gap: var(--sp-4);
  padding: 0 var(--sp-4) var(--sp-3);
  max-width: var(--editor-width, 720px); margin: 0 auto; width: 100%;
  flex-wrap: wrap;
}
.info-field { flex: 1; min-width: 200px; display: flex; flex-direction: column; gap: 4px; }
.info-label { font-size: var(--fs-xs); color: var(--text-3); font-weight: 600; }
.goals-box {
  display: flex; flex-wrap: wrap; gap: 4px; align-items: center;
  background: var(--bg-input); border: 1px solid var(--border); border-radius: var(--r-sm);
  padding: 4px 6px; min-height: 30px;
}
.goal-chip {
  display: inline-flex; align-items: center; gap: 4px;
  font-size: var(--fs-xs); padding: 2px 8px;
  background: var(--accent-bg); color: var(--accent);
  border: 1px solid var(--accent-border); border-radius: var(--r-pill);
}
.goal-remove { font-size: 14px; line-height: 1; color: var(--text-3); cursor: pointer; }
.goal-remove:hover { color: var(--danger); }
.goal-input {
  flex: 1; min-width: 120px; background: transparent; border: none; outline: none;
  font-size: var(--fs-sm); color: var(--text); font-family: inherit;
}
.pov-select {
  background: var(--bg-input); border: 1px solid var(--border); border-radius: var(--r-sm);
  padding: 4px 8px; font-size: var(--fs-sm); color: var(--text); font-family: inherit;
}
.pov-select:focus { outline: none; border-color: var(--border-focus); }

.prose-editor-scroll {
  flex: 1; overflow-y: auto;
  display: flex; justify-content: center;
  cursor: text;
}
.prose-editor-scroll :deep(> div) {
  flex: 1; max-width: var(--editor-width); width: 100%;
  display: flex; flex-direction: column;
}
.prose-editor-scroll :deep(.prose-editor) {
  flex: 1; max-width: var(--editor-width); width: 100%;
  min-height: 300px;
  padding: var(--sp-6) var(--sp-4) var(--sp-8);
  color: var(--editor-text);
  font-size: var(--fs-editor);
  line-height: var(--editor-line-height);
  font-family: var(--editor-font-family);
}
.prose-editor-scroll :deep(.prose-editor:focus) { outline: none; }
.prose-editor-scroll :deep(.prose-editor p) { margin: var(--editor-para-gap) 0; }
.prose-editor-scroll :deep(.prose-editor h1) { font-size: var(--fs-2xl); margin: var(--sp-4) 0 var(--sp-2); font-family: var(--font-ui); }
.prose-editor-scroll :deep(.prose-editor h2) { font-size: var(--fs-xl); margin: var(--sp-4) 0 var(--sp-2); font-family: var(--font-ui); }
.prose-editor-scroll :deep(.prose-editor h3) { font-size: var(--fs-lg); margin: var(--sp-3) 0 var(--sp-2); font-family: var(--font-ui); }
.prose-editor-scroll :deep(.prose-editor ul),
.prose-editor-scroll :deep(.prose-editor ol) {
  list-style-position: outside; padding-left: 1.8em; margin: var(--editor-para-gap) 0;
}
.prose-editor-scroll :deep(.prose-editor li) { margin: 2px 0; padding-left: 0; }
.prose-editor-scroll :deep(.prose-editor li > p) { margin: 0; }
.prose-editor-scroll :deep(.prose-editor blockquote) {
  border-left: 3px solid var(--accent); padding-left: var(--sp-3);
  margin: var(--sp-3) 0; color: var(--text-2); font-style: italic;
}
.prose-editor-scroll :deep(.prose-editor hr) {
  border: none; border-top: 1px solid var(--border-2); margin: var(--sp-4) 0;
}
.prose-editor-scroll :deep(.prose-editor code) {
  font-family: var(--font-mono); font-size: .92em;
  background: var(--bg-3); padding: 1px 5px; border-radius: var(--r-xs);
}
.prose-editor-scroll :deep(.ProseMirror p.is-editor-empty:first-child::before) {
  content: attr(data-placeholder);
  color: var(--text-3); pointer-events: none; float: left; height: 0;
}
.no-chapter-hint {
  position: absolute; inset: 0;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: var(--sp-3); color: var(--text-3); pointer-events: none;
  background: var(--editor-bg);
}
</style>

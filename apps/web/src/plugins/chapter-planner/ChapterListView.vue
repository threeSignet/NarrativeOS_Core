<script setup lang="ts">
// 章节规划侧栏——章节列表 + 新建/重命名/状态推进（迭代 A1）
// 复用 Ui 组件:UiSideHead/UiButton/UiIcon/UiEmpty/UiInlineForm/UiInput/UiStatusDot
import { ref, watch, computed, nextTick } from 'vue';
import { useUiStore } from '../../stores/ui';
import { useChapterStore } from '../../stores/chapter';
import { useToast } from '../../composables/useToast';
import {
  UiSideHead, UiButton, UiIcon, UiBadge, UiEmpty, UiInlineForm, UiInput, UiStatusDot,
} from '../../components';
import { CHAPTER_STATUS_LABELS, CHAPTER_STATUS_COLORS, type ChapterStatus, type ChapterPlan } from '../../api/chapters';

const ui = useUiStore();
const chapter = useChapterStore();
const toast = useToast();

// 激活时加载章节
watch(() => [ui.activeActivity, ui.projectId] as const, async ([active, pid]) => {
  if (active === 'chapter-planner' && pid) {
    await chapter.loadChapters(pid);
  }
}, { immediate: true });

// ===== 新建章节表单 =====
const showCreate = ref(false);
const newTitle = ref('');

async function onCreate() {
  if (!ui.projectId || !newTitle.value.trim()) return;
  try {
    const created = await chapter.create(ui.projectId, { title: newTitle.value.trim() });
    toast.success(`已创建章节：${created.title}`);
    newTitle.value = '';
    showCreate.value = false;
  } catch (e: any) {
    toast.error('创建失败：' + (e?.response?.data?.error || e?.message));
  }
}

// ===== 就地重命名 =====
const renamingId = ref<string | null>(null);
const renameValue = ref('');
// v-for 内的 ref 会收集成数组，用函数 ref 存当前重命名 input 的 DOM
const renameInputEl = ref<HTMLInputElement | null>(null);
function setRenameInput(el: Element | { $el: Element } | null) {
  renameInputEl.value = (el as HTMLInputElement) ?? null;
}

async function startRename(c: ChapterPlan) {
  renamingId.value = c.id;
  renameValue.value = c.title;
  await nextTick();
  renameInputEl.value?.focus();
  renameInputEl.value?.select();
}

async function commitRename(c: ChapterPlan) {
  if (!ui.projectId || renamingId.value !== c.id) return;
  const v = renameValue.value.trim();
  renamingId.value = null;
  if (!v || v === c.title) return;
  try {
    await chapter.rename(ui.projectId, c.id, v);
    toast.success('已重命名');
  } catch (e: any) {
    toast.error('重命名失败：' + (e?.response?.data?.error || '版本冲突，请刷新'));
  }
}

function onRenameKeydown(e: KeyboardEvent, c: ChapterPlan) {
  if (e.key === 'Enter') { e.preventDefault(); commitRename(c); }
  else if (e.key === 'Escape') { e.preventDefault(); renamingId.value = null; }
}

// ===== 状态推进 =====
// 章节状态顺序：planned → drafting → written → revising → done
const STATUS_FLOW: ChapterStatus[] = ['planned', 'drafting', 'written', 'revising', 'done'];

async function advanceStatus(c: ChapterPlan) {
  if (!ui.projectId) return;
  const idx = STATUS_FLOW.indexOf(c.status);
  if (idx < 0 || idx >= STATUS_FLOW.length - 1) return;
  const next = STATUS_FLOW[idx + 1]!;
  try {
    await chapter.transition(ui.projectId, c.id, next);
    toast.success(`${c.title} → ${CHAPTER_STATUS_LABELS[next]}`);
  } catch (e: any) {
    toast.error('状态推进失败：' + (e?.response?.data?.error || e?.message));
  }
}

function selectChapter(id: string) {
  chapter.select(id);
  // A3 将在此触发"打开章节正文编辑器"，当前迭代仅选中
}

// 章节序号格式（第 N 章）
function chapterLabel(c: ChapterPlan, i: number): string {
  return `第 ${i + 1} 章`;
}
</script>

<template>
  <UiSideHead title="章节">
    <template #actions>
      <UiButton icon variant="ghost" size="sm" title="新建章节" @click="showCreate = !showCreate">
        <UiIcon name="plus" :size="15" />
      </UiButton>
      <UiBadge v-if="chapter.chapters.length" :text="chapter.chapters.length" />
    </template>
  </UiSideHead>

  <!-- 新建章节表单 -->
  <UiInlineForm v-model:open="showCreate">
    <UiInput
      v-model="newTitle"
      placeholder="章节标题（如：初遇）"
      @enter="onCreate"
    />
    <template #actions>
      <UiButton size="sm" :disabled="chapter.acting" @click="showCreate = false">取消</UiButton>
      <UiButton variant="primary" size="sm" :disabled="!newTitle.trim() || chapter.acting" @click="onCreate">创建</UiButton>
    </template>
  </UiInlineForm>

  <!-- 章节列表 -->
  <div class="chapter-side-body">
    <div v-if="chapter.loading" class="state-msg">加载中…</div>
    <div v-else-if="chapter.error" class="state-msg is-error">{{ chapter.error }}</div>
    <UiEmpty
      v-else-if="chapter.chapters.length === 0"
      title="暂无章节"
      description="点上方 + 新建第一章，开始你的故事"
    />

    <div
      v-for="(c, i) in chapter.chapters"
      :key="c.id"
      class="chapter-row"
      :class="{ 'is-selected': chapter.selectedId === c.id }"
      @click="selectChapter(c.id)"
      @dblclick="startRename(c)"
    >
      <UiStatusDot :color="CHAPTER_STATUS_COLORS[c.status]" />
      <div class="chapter-info">
        <div class="chapter-label">{{ chapterLabel(c, i) }}</div>
        <div v-if="renamingId !== c.id" class="chapter-title">{{ c.title }}</div>
        <input
          v-else
          :ref="setRenameInput"
          v-model="renameValue"
          class="rename-input"
          @click.stop
          @dblclick.stop
          @keydown="onRenameKeydown($event, c)"
          @blur="commitRename(c)"
        />
      </div>
      <div class="chapter-ops" @click.stop>
        <!-- 状态推进按钮（非 done 才显示） -->
        <UiButton
          v-if="c.status !== 'done'"
          variant="ghost"
          size="sm"
          :title="`推进到：${CHAPTER_STATUS_LABELS[STATUS_FLOW[STATUS_FLOW.indexOf(c.status) + 1]!]}`"
          :disabled="chapter.acting"
          @click="advanceStatus(c)"
        >{{ CHAPTER_STATUS_LABELS[c.status] }} →</UiButton>
        <span v-else class="done-mark">✓ {{ CHAPTER_STATUS_LABELS.done }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.chapter-side-body { flex: 1; overflow-y: auto; }
.state-msg { padding: var(--sp-3); font-size: var(--fs-sm); color: var(--text-3); }
.state-msg.is-error { color: var(--warning); }

.chapter-row {
  display: flex; align-items: center; gap: var(--sp-2);
  padding: 6px var(--sp-3); cursor: pointer;
  border-left: 2px solid transparent;
  transition: background var(--t-fast);
}
.chapter-row:hover { background: var(--bg-3); }
.chapter-row.is-selected { background: var(--accent-bg); border-left-color: var(--accent); }
.chapter-info { flex: 1; min-width: 0; }
.chapter-label { font-size: var(--fs-xs); color: var(--text-3); }
.chapter-title {
  font-size: var(--fs-sm); color: var(--text);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.rename-input {
  width: 100%;
  background: var(--bg-input);
  border: 1px solid var(--accent-border);
  border-radius: var(--r-xs);
  padding: 1px 6px;
  font-size: var(--fs-sm); color: var(--text);
  font-family: inherit;
}
.rename-input:focus { outline: none; border-color: var(--accent); }

.chapter-ops { display: flex; gap: 2px; flex-shrink: 0; }
.done-mark { font-size: var(--fs-xs); color: var(--success); white-space: nowrap; }
</style>

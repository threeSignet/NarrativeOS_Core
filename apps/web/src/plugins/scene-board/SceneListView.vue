<script setup lang="ts">
// 场景卡侧栏——按章节分组 + 新建场景（迭代 D1）
import { ref, watch, computed } from 'vue';
import { useUiStore } from '../../stores/ui';
import { useSceneStore } from '../../stores/scene';
import { useChapterStore } from '../../stores/chapter';
import { useToast } from '../../composables/useToast';
import {
  UiSideHead, UiButton, UiIcon, UiBadge, UiEmpty, UiInlineForm, UiInput, UiSelect, UiStatusDot,
} from '../../components';
import { SCENE_PURPOSE_LABELS, SCENE_STATUS_LABELS, SCENE_STATUS_COLORS, nextSceneStatus, type ScenePurpose } from '../../api/scenes';

const ui = useUiStore();
const scene = useSceneStore();
const chapter = useChapterStore();
const toast = useToast();

watch(() => [ui.activeActivity, ui.projectId] as const, async ([active, pid]) => {
  if (active === 'scene-board' && pid) {
    await Promise.all([chapter.loadChapters(pid), scene.loadScenes(pid)]);
  }
}, { immediate: true });

// 新建场景表单
const showCreate = ref(false);
const newChapterId = ref('');
const newTitle = ref('');
const newPurpose = ref<ScenePurpose>('conflict');

const PURPOSE_OPTIONS = Object.entries(SCENE_PURPOSE_LABELS) as [ScenePurpose, string][];

async function onCreate() {
  if (!ui.projectId || !newChapterId.value || !newTitle.value.trim()) return;
  try {
    await scene.create(ui.projectId, {
      chapterId: newChapterId.value,
      title: newTitle.value.trim(),
      purpose: [newPurpose.value],
    });
    toast.success('已创建场景');
    newTitle.value = '';
    showCreate.value = false;
  } catch (e: any) { toast.error('创建失败：' + (e?.message)); }
}

async function onAdvance(s: typeof scene.scenes[number]) {
  if (!ui.projectId) return;
  const next = nextSceneStatus(s.status);
  if (!next) return;
  try {
    await scene.transition(ui.projectId, s.id, next);
    toast.success(`${s.title} → ${SCENE_STATUS_LABELS[next]}`);
  } catch (e: any) { toast.error('推进失败：' + (e?.message)); }
}
</script>

<template>
  <UiSideHead title="场景">
    <template #actions>
      <UiButton icon variant="ghost" size="sm" title="新建场景" :disabled="chapter.chapters.length === 0" @click="showCreate = !showCreate">
        <UiIcon name="plus" :size="15" />
      </UiButton>
      <UiBadge v-if="scene.scenes.length" :text="scene.scenes.length" />
    </template>
  </UiSideHead>

  <UiInlineForm v-model:open="showCreate">
    <UiSelect v-model="newChapterId">
      <option value="" disabled>选择章节…</option>
      <option v-for="c in chapter.chapters" :key="c.id" :value="c.id">第 {{ c.order }} 章 · {{ c.title }}</option>
    </UiSelect>
    <UiInput v-model="newTitle" placeholder="场景标题（如：雨夜对峙）" />
    <UiSelect v-model="newPurpose">
      <option v-for="[p, label] in PURPOSE_OPTIONS" :key="p" :value="p">{{ label }}</option>
    </UiSelect>
    <template #actions>
      <UiButton size="sm" :disabled="scene.acting" @click="showCreate = false">取消</UiButton>
      <UiButton variant="primary" size="sm" :disabled="!newChapterId || !newTitle.trim() || scene.acting" @click="onCreate">创建</UiButton>
    </template>
  </UiInlineForm>

  <div class="scene-side-body">
    <div v-if="scene.loading" class="state-msg">加载中…</div>
    <div v-else-if="scene.error" class="state-msg is-error">{{ scene.error }}</div>
    <UiEmpty v-else-if="chapter.chapters.length === 0" title="无章节" description="先在章节模块创建章节，再为它添加场景" />
    <UiEmpty v-else-if="scene.scenes.length === 0" title="暂无场景" description="点上方 + 为章节创建第一个场景" />

    <template v-for="g in scene.groupedByChapter" :key="g.chapterId">
      <div class="chapter-group-title">第 {{ g.chapterOrder }} 章 · {{ g.chapterTitle }}（{{ g.items.length }}）</div>
      <div
        v-for="s in g.items" :key="s.id"
        class="scene-row"
        :class="{ 'is-selected': scene.selectedId === s.id }"
        @click="scene.select(s.id)"
      >
        <UiStatusDot :color="SCENE_STATUS_COLORS[s.status]" />
        <div class="scene-info">
          <div class="scene-title">{{ s.title }}</div>
          <div class="scene-meta">
            <span v-for="p in s.purpose" :key="p" class="purpose-tag">{{ SCENE_PURPOSE_LABELS[p] }}</span>
          </div>
        </div>
        <div class="scene-ops" @click.stop>
          <UiButton v-if="nextSceneStatus(s.status)" variant="ghost" size="sm" :disabled="scene.acting" @click="onAdvance(s)">→</UiButton>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.scene-side-body { flex: 1; overflow-y: auto; }
.state-msg { padding: var(--sp-3); font-size: var(--fs-sm); color: var(--text-3); }
.state-msg.is-error { color: var(--warning); }
.chapter-group-title {
  font-size: var(--fs-xs); font-weight: 600; color: var(--text-3);
  padding: var(--sp-3) var(--sp-3) var(--sp-1);
  letter-spacing: 0.04em;
}
.scene-row {
  display: flex; align-items: center; gap: var(--sp-2);
  padding: 6px var(--sp-3); cursor: pointer;
  border-left: 2px solid transparent;
}
.scene-row:hover { background: var(--bg-3); }
.scene-row.is-selected { background: var(--accent-bg); border-left-color: var(--accent); }
.scene-info { flex: 1; min-width: 0; }
.scene-title { font-size: var(--fs-sm); color: var(--text); }
.scene-meta { display: flex; gap: 4px; margin-top: 2px; }
.purpose-tag { font-size: 10px; padding: 0 6px; border-radius: var(--r-pill); background: var(--bg-3); color: var(--text-2); }
.scene-ops { flex-shrink: 0; }
</style>

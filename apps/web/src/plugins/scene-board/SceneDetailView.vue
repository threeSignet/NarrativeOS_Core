<script setup lang="ts">
// 场景详情编辑——主区（迭代 D1）
import { ref, watch, computed } from 'vue';
import { useUiStore } from '../../stores/ui';
import { useSceneStore } from '../../stores/scene';
import { useEntityStore } from '../../stores/entity';
import { useToast } from '../../composables/useToast';
import { UiButton, UiEmpty, UiInput, UiTextArea, UiStatusDot, UiChip } from '../../components';
import { SCENE_PURPOSE_LABELS, SCENE_STATUS_LABELS, SCENE_STATUS_COLORS, type ScenePurpose } from '../../api/scenes';

const ui = useUiStore();
const scene = useSceneStore();
const entity = useEntityStore();
const toast = useToast();

const selected = computed(() => scene.selected());

const title = ref('');
const expectedOutcome = ref('');
const purposeSet = ref<Set<ScenePurpose>>(new Set());
const povEntityId = ref('');

watch(selected, async (s) => {
  if (s) {
    title.value = s.title;
    expectedOutcome.value = s.expectedOutcome ?? '';
    purposeSet.value = new Set(s.purpose);
    povEntityId.value = s.povEntityId ?? '';
    // 加载实体供 POV 选择
    if (ui.projectId && entity.entities.length === 0) await entity.loadEntities(ui.projectId);
  }
}, { immediate: true });

const PURPOSE_KEYS = Object.keys(SCENE_PURPOSE_LABELS) as ScenePurpose[];
function togglePurpose(p: ScenePurpose) {
  const s = new Set(purposeSet.value);
  if (s.has(p)) s.delete(p); else s.add(p);
  purposeSet.value = s;
}
const registeredEntities = computed(() => entity.entities.filter((e) => e.status === 'registered'));

async function onSave() {
  if (!ui.projectId || !selected.value) return;
  try {
    await scene.edit(ui.projectId, selected.value.id, selected.value.version, {
      title: title.value,
      purpose: Array.from(purposeSet.value),
      povEntityId: povEntityId.value || undefined,
      expectedOutcome: expectedOutcome.value || undefined,
    });
    toast.success('已保存');
  } catch (e: any) { toast.error('保存失败：' + (e?.message)); }
}
</script>

<template>
  <div class="scene-detail-wrap">
    <UiEmpty v-if="!selected" block icon="chat" title="未选择场景" description="从左侧选择一个场景查看和编辑" />

    <div v-else class="sd-content">
      <div class="sd-head">
        <UiStatusDot :color="SCENE_STATUS_COLORS[selected.status]" />
        <span class="status-label">{{ SCENE_STATUS_LABELS[selected.status] }}</span>
        <div class="head-actions">
          <UiButton variant="primary" size="sm" :disabled="scene.acting" @click="onSave">保存</UiButton>
        </div>
      </div>

      <div class="sd-section">
        <label class="field-label">场景标题</label>
        <UiInput v-model="title" />
      </div>

      <div class="sd-section">
        <label class="field-label">场景功能（可多选）</label>
        <div class="purpose-chips">
          <UiChip v-for="p in PURPOSE_KEYS" :key="p" :active="purposeSet.has(p)" @click="togglePurpose(p)">
            {{ SCENE_PURPOSE_LABELS[p] }}
          </UiChip>
        </div>
      </div>

      <div class="sd-section">
        <label class="field-label">POV 视角</label>
        <select class="pov-select" v-model="povEntityId">
          <option value="">无</option>
          <option v-for="e in registeredEntities" :key="e.id" :value="e.id">{{ e.name }}（{{ e.typeLabel }}）</option>
        </select>
      </div>

      <div class="sd-section">
        <label class="field-label">预期结果</label>
        <UiTextArea v-model="expectedOutcome" :rows="3" placeholder="这个场景应该达成什么效果…" />
      </div>

      <div v-if="selected.participants.length" class="sd-section">
        <label class="field-label">参与者（{{ selected.participants.length }}）</label>
        <div class="participants">{{ selected.participants.join(', ') }}</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.scene-detail-wrap { height: 100%; overflow-y: auto; background: var(--bg); }
.sd-content { max-width: 720px; margin: 0 auto; padding: var(--sp-6) var(--sp-4); display: flex; flex-direction: column; gap: var(--sp-4); }
.sd-head { display: flex; align-items: center; gap: var(--sp-2); padding-bottom: var(--sp-2); border-bottom: 1px solid var(--border); }
.status-label { font-size: var(--fs-sm); font-weight: 500; color: var(--text); }
.head-actions { margin-left: auto; }
.sd-section { display: flex; flex-direction: column; gap: 6px; }
.field-label { font-size: var(--fs-xs); font-weight: 600; color: var(--text-3); letter-spacing: 0.04em; }
.purpose-chips { display: flex; flex-wrap: wrap; gap: 4px; }
.pov-select {
  background: var(--bg-input); border: 1px solid var(--border); border-radius: var(--r-sm);
  padding: 5px 8px; font-size: var(--fs-sm); color: var(--text); font-family: inherit;
}
.participants { font-size: var(--fs-sm); color: var(--text-2); font-family: var(--font-mono); }
</style>

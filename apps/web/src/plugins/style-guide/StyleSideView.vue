<script setup lang="ts">
// 风格指南侧栏——偏好设置（迭代 D3）
import { watch, ref } from 'vue';
import { useUiStore } from '../../stores/ui';
import { useStyleStore } from '../../stores/style';
import { useToast } from '../../composables/useToast';
import { UiSideHead, UiBadge, UiChip, UiInput, UiButton } from '../../components';
import {
  PERSON_LABELS, DISTANCE_LABELS, PACING_LABELS, DESC_LABELS, STATUS_LABELS,
  type NarrativePerson, type NarrativeDistance, type PacingPreference, type DescriptionPreference,
} from '../../api/styles';

const ui = useUiStore();
const style = useStyleStore();
const toast = useToast();

watch(() => [ui.activeActivity, ui.projectId] as const, async ([active, pid]) => {
  if (active === 'style-guide' && pid) await style.loadGuide(pid);
}, { immediate: true });

const PERSON_KEYS = Object.keys(PERSON_LABELS) as NarrativePerson[];
const DISTANCE_KEYS = Object.keys(DISTANCE_LABELS) as NarrativeDistance[];
const PACING_KEYS = Object.keys(PACING_LABELS) as PacingPreference[];
const DESC_KEYS = Object.keys(DESC_LABELS) as DescriptionPreference[];

function toggleDesc(d: DescriptionPreference) {
  if (!style.guide) return;
  const set = new Set(style.guide.descriptionPreference);
  if (set.has(d)) set.delete(d); else set.add(d);
  style.guide.descriptionPreference = Array.from(set);
}

async function saveField(field: string, value: unknown) {
  if (!ui.projectId || !style.guide) return;
  try {
    await style.editGuide(ui.projectId, { [field]: value } as any);
    toast.success('已保存');
  } catch (e: any) { toast.error('保存失败：' + e?.message); }
}
</script>

<template>
  <UiSideHead title="风格指南">
    <template #actions>
      <UiBadge v-if="style.guide" :text="STATUS_LABELS[style.guide.status]" />
    </template>
  </UiSideHead>

  <div class="style-side-body">
    <div v-if="style.loading" class="state-msg">加载中…</div>
    <div v-else-if="style.error" class="state-msg is-error">{{ style.error }}</div>

    <template v-else-if="style.guide">
      <!-- 指南名称 -->
      <div class="field-group">
        <label class="field-label">指南名称</label>
        <UiInput v-model="style.guide.name" @blur="saveField('name', style.guide!.name)" />
      </div>

      <!-- 叙述人称 -->
      <div class="field-group">
        <label class="field-label">叙述人称</label>
        <div class="chip-row">
          <UiChip v-for="p in PERSON_KEYS" :key="p" :active="style.guide!.narrativePerson === p"
            @click="style.guide!.narrativePerson = p; saveField('narrativePerson', p)">
            {{ PERSON_LABELS[p] }}
          </UiChip>
        </div>
      </div>

      <!-- 叙述距离 -->
      <div class="field-group">
        <label class="field-label">叙述距离</label>
        <div class="chip-row">
          <UiChip v-for="d in DISTANCE_KEYS" :key="d" :active="style.guide!.narrativeDistance === d"
            @click="style.guide!.narrativeDistance = d; saveField('narrativeDistance', d)">
            {{ DISTANCE_LABELS[d] }}
          </UiChip>
        </div>
      </div>

      <!-- 节奏偏好 -->
      <div class="field-group">
        <label class="field-label">节奏偏好</label>
        <div class="chip-row">
          <UiChip v-for="p in PACING_KEYS" :key="p" :active="style.guide!.pacingPreference === p"
            @click="style.guide!.pacingPreference = p; saveField('pacingPreference', p)">
            {{ PACING_LABELS[p] }}
          </UiChip>
        </div>
      </div>

      <!-- 描写偏好（多选） -->
      <div class="field-group">
        <label class="field-label">描写偏好（多选）</label>
        <div class="chip-row">
          <UiChip v-for="d in DESC_KEYS" :key="d" :active="style.guide!.descriptionPreference.includes(d)"
            @click="toggleDesc(d); saveField('descriptionPreference', style.guide!.descriptionPreference)">
            {{ DESC_LABELS[d] }}
          </UiChip>
        </div>
      </div>

      <!-- 适用范围 -->
      <div class="field-group">
        <label class="field-label">适用范围</label>
        <div class="scope-row">
          <UiChip :active="style.guide!.scope === 'default'" @click="saveField('scope', 'default')">全书默认</UiChip>
          <UiChip :active="style.guide!.scope === 'variant'" @click="saveField('scope', 'variant')">局部变体</UiChip>
        </div>
      </div>

      <!-- 范围说明 -->
      <div v-if="style.guide!.scope === 'variant'" class="field-group">
        <label class="field-label">范围说明</label>
        <UiInput :modelValue="style.guide!.scopeNote ?? ''" @update:modelValue="(v: string) => { style.guide!.scopeNote = v; }" placeholder="如：第5-8章回忆段落" @blur="saveField('scopeNote', style.guide!.scopeNote)" />
      </div>
    </template>
  </div>
</template>

<style scoped>
.style-side-body { flex: 1; overflow-y: auto; padding: var(--sp-2) var(--sp-3); display: flex; flex-direction: column; gap: var(--sp-3); }
.state-msg { padding: var(--sp-3); font-size: var(--fs-sm); color: var(--text-3); }
.state-msg.is-error { color: var(--warning); }
.field-group { display: flex; flex-direction: column; gap: 4px; }
.field-label { font-size: var(--fs-xs); font-weight: 600; color: var(--text-3); letter-spacing: 0.04em; }
.chip-row, .scope-row { display: flex; flex-wrap: wrap; gap: 4px; }
</style>

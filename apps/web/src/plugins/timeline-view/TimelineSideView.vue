<script setup lang="ts">
// 时间线侧栏——模式切换 + 来源层过滤（迭代 C2）
import { watch } from 'vue';
import { useUiStore } from '../../stores/ui';
import { useTimelineStore } from '../../stores/timeline';
import { UiSideHead, UiButton, UiBadge, UiChip } from '../../components';
import { TIMELINE_LAYER_LABELS, TIMELINE_LAYER_COLORS, type TimelineItemSourceLayer, type TimelineViewMode } from '../../api/timelines';

const ui = useUiStore();
const tl = useTimelineStore();

watch(() => [ui.activeActivity, ui.projectId] as const, async ([active, pid]) => {
  if (active === 'timeline-view' && pid) await tl.loadTimeline(pid);
}, { immediate: true });

const LAYER_KEYS = Object.keys(TIMELINE_LAYER_LABELS) as TimelineItemSourceLayer[];

async function onModeChange(m: TimelineViewMode) {
  if (!ui.projectId || tl.mode === m) return;
  await tl.switchMode(ui.projectId, m);
}
</script>

<template>
  <UiSideHead title="时间线">
    <template #actions>
      <UiBadge v-if="tl.view" :text="tl.view.items.length" />
    </template>
  </UiSideHead>

  <!-- 模式切换 -->
  <div class="mode-switch">
    <UiChip :active="tl.mode === 'world'" @click="onModeChange('world')">世界时间</UiChip>
    <UiChip :active="tl.mode === 'narrative'" @click="onModeChange('narrative')">叙述顺序</UiChip>
  </div>

  <!-- 来源层过滤 -->
  <div class="layer-filters">
    <div class="filter-title">来源层</div>
    <div class="filter-chips">
      <UiChip
        v-for="layer in LAYER_KEYS" :key="layer"
        :active="!tl.hiddenLayers.has(layer)"
        :color="TIMELINE_LAYER_COLORS[layer]"
        @click="tl.toggleLayer(layer)"
      >{{ TIMELINE_LAYER_LABELS[layer] }}</UiChip>
    </div>
  </div>

  <div class="tl-side-body">
    <div v-if="tl.loading" class="state-msg">加载中…</div>
    <div v-else-if="tl.error" class="state-msg is-error">{{ tl.error }}</div>
    <div v-else-if="tl.filteredItems.length === 0" class="state-msg">无时间线条目</div>
    <template v-else>
      <div class="tl-summary">
        <span>共 {{ tl.filteredItems.length }} 条</span>
        <span class="dot-sep">·</span>
        <span>{{ tl.groupedByChapter.length }} 个章节</span>
      </div>
      <div class="tl-hint">主区显示完整时间轴</div>
    </template>
  </div>
</template>

<style scoped>
.mode-switch { display: flex; gap: 4px; padding: var(--sp-2); }
.layer-filters { padding: 0 var(--sp-2) var(--sp-1); }
.filter-title { font-size: var(--fs-xs); font-weight: 600; color: var(--text-3); margin-bottom: 4px; }
.filter-chips { display: flex; flex-wrap: wrap; gap: 4px; }
.tl-side-body { flex: 1; overflow-y: auto; padding: var(--sp-2) var(--sp-3); }
.state-msg { padding: var(--sp-3); font-size: var(--fs-sm); color: var(--text-3); }
.state-msg.is-error { color: var(--warning); }
.tl-summary { font-size: var(--fs-xs); color: var(--text-2); display: flex; gap: 4px; align-items: center; }
.dot-sep { color: var(--text-3); }
.tl-hint { font-size: var(--fs-xs); color: var(--text-3); margin-top: 4px; }
</style>

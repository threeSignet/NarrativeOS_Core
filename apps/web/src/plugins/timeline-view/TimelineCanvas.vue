<script setup lang="ts">
// 时间线主区——按章节分组的垂直时间轴（迭代 C2）
import { computed } from 'vue';
import { useTimelineStore } from '../../stores/timeline';
import { UiEmpty, UiStatusDot } from '../../components';
import { TIMELINE_LAYER_LABELS, TIMELINE_LAYER_COLORS, type TimelineItemView } from '../../api/timelines';

const tl = useTimelineStore();

function itemLabel(it: TimelineItemView): string {
  // statusLabel 可能是 "计划:标题" / "场景:标题" / "已提交" 等，取冒号后更简洁
  const colon = it.statusLabel.indexOf(':');
  return colon >= 0 ? it.statusLabel.slice(colon + 1) : it.label;
}
</script>

<template>
  <div class="timeline-canvas">
    <UiEmpty
      v-if="!tl.loading && tl.filteredItems.length === 0"
      block
      icon="graph-empty"
      title="时间线为空"
      description="已提交的事件和章节计划会按时间顺序出现在这里"
    />

    <div v-else class="timeline-scroll">
      <div
        v-for="[chapter, items] in tl.groupedByChapter" :key="chapter"
        class="chapter-group"
      >
        <div class="chapter-marker">
          <div class="chapter-dot"></div>
          <div class="chapter-label">第 {{ chapter }} 章</div>
          <div class="chapter-count">{{ items.length }} 条</div>
        </div>
        <div class="chapter-items">
          <div v-for="it in items" :key="it.id" class="timeline-item">
            <UiStatusDot :color="TIMELINE_LAYER_COLORS[it.sourceLayer]" />
            <div class="item-body">
              <div class="item-label">{{ itemLabel(it) }}</div>
              <div class="item-meta">
                <span class="layer-tag" :style="{ color: TIMELINE_LAYER_COLORS[it.sourceLayer] }">
                  {{ TIMELINE_LAYER_LABELS[it.sourceLayer] }}
                </span>
                <span v-if="it.worldTime?.order !== undefined" class="order-tag">
                  场景 {{ it.worldTime.order }}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.timeline-canvas { height: 100%; overflow-y: auto; background: var(--bg); }
.timeline-scroll { max-width: 760px; margin: 0 auto; padding: var(--sp-6) var(--sp-4); }

.chapter-group { margin-bottom: var(--sp-5); }
.chapter-marker {
  display: flex; align-items: center; gap: var(--sp-2);
  margin-bottom: var(--sp-2);
  padding-bottom: 4px;
  border-bottom: 1px solid var(--border);
}
.chapter-dot { width: 10px; height: 10px; border-radius: 50%; background: var(--accent); flex-shrink: 0; }
.chapter-label { font-size: var(--fs-md); font-weight: 600; color: var(--text); }
.chapter-count { font-size: var(--fs-xs); color: var(--text-3); margin-left: auto; }

.chapter-items { display: flex; flex-direction: column; gap: 2px; padding-left: 20px; border-left: 2px solid var(--border); margin-left: 4px; }
.timeline-item {
  display: flex; align-items: flex-start; gap: var(--sp-2);
  padding: var(--sp-2) var(--sp-3);
  position: relative;
}
.timeline-item::before {
  content: ''; position: absolute; left: -25px; top: 14px;
  width: 10px; height: 1px; background: var(--border-2);
}
.item-body { flex: 1; min-width: 0; }
.item-label { font-size: var(--fs-sm); color: var(--text); line-height: 1.4; }
.item-meta { font-size: var(--fs-xs); color: var(--text-3); margin-top: 2px; display: flex; gap: var(--sp-2); }
.layer-tag { font-weight: 500; }
.order-tag { color: var(--text-3); }
</style>

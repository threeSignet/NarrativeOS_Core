<script setup lang="ts">
// 修订历史主区——垂直时间线列表（迭代 D2）
import { useRevisionStore } from '../../stores/revision';
import { UiEmpty, UiStatusDot } from '../../components';
import { TARGET_TYPE_LABELS, ACTION_LABELS, ACTION_COLORS } from '../../api/revisions';

const rev = useRevisionStore();

function formatTime(t: string): string {
  try { return new Date(t).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }); }
  catch { return t; }
}
</script>

<template>
  <div class="rev-canvas">
    <UiEmpty
      v-if="!rev.loading && rev.filteredRecords.length === 0"
      block icon="graph-empty"
      title="暂无修订记录"
      description="各模块的创建/更新/删除操作会自动记录到这里"
    />

    <div v-else class="rev-scroll">
      <div
        v-for="r in rev.filteredRecords" :key="r.id"
        class="rev-item"
      >
        <UiStatusDot :color="ACTION_COLORS[r.action]" />
        <div class="rev-item-body">
          <div class="rev-item-head">
            <span class="rev-action" :style="{ color: ACTION_COLORS[r.action] }">{{ ACTION_LABELS[r.action] }}</span>
            <span class="rev-target">{{ TARGET_TYPE_LABELS[r.targetType] }}</span>
            <span class="rev-operator">{{ r.operator === 'agent' ? 'AI' : '作者' }}</span>
            <span class="rev-time">{{ formatTime(r.createdAt) }}</span>
          </div>
          <div class="rev-summary-text">{{ r.summary }}</div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.rev-canvas { height: 100%; overflow-y: auto; background: var(--bg); }
.rev-scroll { max-width: 760px; margin: 0 auto; padding: var(--sp-6) var(--sp-4); }
.rev-item {
  display: flex; align-items: flex-start; gap: var(--sp-2);
  padding: var(--sp-2) var(--sp-3);
  border-bottom: 1px solid var(--border);
}
.rev-item-body { flex: 1; min-width: 0; }
.rev-item-head { display: flex; align-items: center; gap: var(--sp-2); margin-bottom: 2px; }
.rev-action { font-size: var(--fs-sm); font-weight: 600; }
.rev-target { font-size: var(--fs-xs); color: var(--accent); }
.rev-operator { font-size: var(--fs-xs); color: var(--text-3); padding: 0 6px; border-radius: var(--r-pill); background: var(--bg-3); }
.rev-time { font-size: var(--fs-xs); color: var(--text-3); font-family: var(--font-mono); margin-left: auto; }
.rev-summary-text { font-size: var(--fs-sm); color: var(--text-2); line-height: 1.4; }
</style>

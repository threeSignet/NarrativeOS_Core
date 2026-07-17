<script setup lang="ts">
// 空间地图侧栏——统计信息（迭代 C4）
import { watch } from 'vue';
import { useUiStore } from '../../stores/ui';
import { useSpatialStore } from '../../stores/spatial';
import { UiSideHead, UiBadge } from '../../components';

const ui = useUiStore();
const spatial = useSpatialStore();

watch(() => [ui.activeActivity, ui.projectId] as const, async ([active, pid]) => {
  if (active === 'spatial-map' && pid) await spatial.loadTree(pid);
}, { immediate: true });
</script>

<template>
  <UiSideHead title="空间">
    <template #actions>
      <UiBadge v-if="spatial.tree" :text="spatial.tree.nodeCount" />
    </template>
  </UiSideHead>

  <div class="spatial-side-body">
    <div v-if="spatial.loading" class="state-msg">加载中…</div>
    <div v-else-if="spatial.error" class="state-msg is-error">{{ spatial.error }}</div>
    <template v-else-if="spatial.tree">
      <div class="stat-card">
        <div class="stat-num">{{ spatial.tree.nodeCount }}</div>
        <div class="stat-label">空间节点</div>
      </div>
      <div class="stat-card">
        <div class="stat-num">{{ spatial.tree.edgeCount }}</div>
        <div class="stat-label">空间关系</div>
      </div>
      <div v-if="spatial.tree.nodeCount === 0" class="empty-hint">
        还没有空间节点。空间结构通过 Agent 工具或 §9 蓝图生成后会出现这里。
      </div>
      <div v-else class="legend">
        <div class="legend-title">说明</div>
        <div class="legend-desc">主区显示空间结构树，按 contains/parent_of 关系组织父子层级。</div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.spatial-side-body { flex: 1; overflow-y: auto; padding: var(--sp-3); }
.state-msg { padding: var(--sp-3); font-size: var(--fs-sm); color: var(--text-3); }
.state-msg.is-error { color: var(--warning); }
.stat-card {
  background: var(--bg-elev, var(--bg-2)); border: 1px solid var(--border);
  border-radius: var(--r-md); padding: var(--sp-3); margin-bottom: var(--sp-2); text-align: center;
}
.stat-num { font-size: var(--fs-2xl); font-weight: 600; color: var(--accent); font-family: var(--font-mono); }
.stat-label { font-size: var(--fs-xs); color: var(--text-3); margin-top: 2px; }
.empty-hint { font-size: var(--fs-sm); color: var(--text-3); line-height: 1.5; padding: var(--sp-3); }
.legend { margin-top: var(--sp-3); padding-top: var(--sp-3); border-top: 1px solid var(--border); }
.legend-title { font-size: var(--fs-xs); font-weight: 600; color: var(--text-2); margin-bottom: 4px; }
.legend-desc { font-size: var(--fs-xs); color: var(--text-3); line-height: 1.5; }
</style>

<script setup lang="ts">
// 空间地图主区——递归树视图（迭代 C4）
import { computed, ref } from 'vue';
import { useSpatialStore } from '../../stores/spatial';
import { UiEmpty } from '../../components';
import SpatialNodeItem from './SpatialNodeItem.vue';

const spatial = useSpatialStore();
const root = computed(() => spatial.tree?.root ?? null);

const expanded = ref<Set<string>>(new Set());
function toggle(id: string) {
  const s = new Set(expanded.value);
  if (s.has(id)) s.delete(id); else s.add(id);
  expanded.value = s;
}

const isEmpty = computed(() => {
  if (!root.value) return true;
  // 虚拟根且无子节点 = 空
  if (root.value.node.id === '__virtual_root__' && root.value.children.length === 0) return true;
  return false;
});
</script>

<template>
  <div class="spatial-canvas">
    <UiEmpty
      v-if="!spatial.loading && isEmpty"
      block icon="graph-empty"
      title="空间结构为空"
      description="空间节点通过 Agent 工具（register_spatial_node）或蓝图生成后，会按层级展示在这里"
    />

    <div v-else-if="root && !isEmpty" class="tree-scroll">
      <div class="tree-root-label">空间结构（{{ spatial.tree?.nodeCount }} 节点 / {{ spatial.tree?.edgeCount }} 关系）</div>
      <SpatialNodeItem :tree-node="root" :depth="0" :expanded="expanded" @toggle="toggle" />
    </div>
  </div>
</template>

<style scoped>
.spatial-canvas { height: 100%; overflow-y: auto; background: var(--bg); }
.tree-scroll { max-width: 760px; margin: 0 auto; padding: var(--sp-6) var(--sp-4); }
.tree-root-label { font-size: var(--fs-xs); color: var(--text-3); margin-bottom: var(--sp-2); }
</style>

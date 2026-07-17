<script setup lang="ts">
// 空间树递归节点项（迭代 C4）
// 自引用递归组件：渲染一个空间节点 + 其子节点（展开时）
import { computed } from 'vue';
import UiIcon from '../../components/base/UiIcon.vue';
import type { SpatialTreeNode } from '../../api/spatials';

const props = defineProps<{
  treeNode: SpatialTreeNode;
  depth: number;
  expanded: Set<string>;
}>();
const emit = defineEmits<{ (e: 'toggle', id: string): void }>();

const node = computed(() => props.treeNode.node);
const children = computed(() => props.treeNode.children);
const hasChildren = computed(() => children.value.length > 0);
const isOpen = computed(() => props.expanded.has(node.value.id));
const isVirtual = computed(() => node.value.id === '__virtual_root__');
</script>

<template>
  <div class="spatial-node-wrap">
    <div
      v-if="!isVirtual"
      class="spatial-node-row"
      :class="{ 'has-children': hasChildren, 'is-open': isOpen }"
      :style="{ paddingLeft: depth * 16 + 8 + 'px' }"
      @click="hasChildren ? emit('toggle', node.id) : undefined"
    >
      <UiIcon v-if="hasChildren" :name="isOpen ? 'chevron-down' : 'chevron-right'" :size="12" />
      <span v-else class="twisty-placeholder"></span>
      <span class="node-label">{{ node.label }}</span>
      <span class="node-type">{{ node.typeId }}</span>
    </div>
    <template v-if="hasChildren && isOpen">
      <SpatialNodeItem
        v-for="child in children"
        :key="child.node.id"
        :tree-node="child"
        :depth="isVirtual ? 0 : depth + 1"
        :expanded="expanded"
        @toggle="(id: string) => emit('toggle', id)"
      />
    </template>
  </div>
</template>

<style scoped>
.spatial-node-row {
  display: flex; align-items: center; gap: 6px;
  padding: 4px 8px; cursor: default;
  border-radius: var(--r-xs);
}
.spatial-node-row.has-children { cursor: pointer; }
.spatial-node-row.has-children:hover { background: var(--bg-3); }
.node-label { font-size: var(--fs-sm); color: var(--text); flex: 1; }
.node-type { font-size: var(--fs-xs); color: var(--text-3); font-family: var(--font-mono); }
.twisty-placeholder { width: 12px; display: inline-block; }
</style>

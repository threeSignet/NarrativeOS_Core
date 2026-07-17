<script setup lang="ts">
// =============================================================================
// 侧栏搜索框——收敛 2 处散落的 <div class="side-search"> 手写
// =============================================================================
// 出现位置（迁移前）：DocumentTreeView / EntityGraphSideView
// 结构：左侧放大镜图标 + input（v-model）+ 聚焦态 border 变色
// 内置搜索图标，调用方只需 v-model + placeholder
import UiIcon from '../base/UiIcon.vue';

defineProps<{
  /** v-model 绑定值 */
  modelValue: string;
  /** 占位文字 */
  placeholder?: string;
}>();

defineEmits<{
  (e: 'update:modelValue', value: string): void;
}>();
</script>

<template>
  <div class="ui-search">
    <UiIcon name="search" :size="14" class="ui-search-icon" />
    <input
      :value="modelValue"
      :placeholder="placeholder"
      @input="$emit('update:modelValue', ($event.target as HTMLInputElement).value)"
    />
  </div>
</template>

<style scoped>
.ui-search {
  margin: var(--sp-2) var(--sp-2) var(--sp-1);
  position: relative;
}
.ui-search input {
  width: 100%;
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  padding: 5px 8px 5px 26px;
  font-size: var(--fs-sm);
  color: var(--text);
  font-family: inherit;
}
.ui-search input:focus { outline: none; border-color: var(--border-focus); }
.ui-search-icon {
  position: absolute;
  left: 7px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--text-3);
  pointer-events: none;
}
</style>

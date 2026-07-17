<script setup lang="ts">
// =============================================================================
// 侧栏头部——收敛 3 处散落的 <div class="side-head"> 手写
// =============================================================================
// 出现位置（迁移前）：DocumentTreeView / EntityGraphSideView / AgentPanel
// 结构：左侧标题（小号大写）+ 右侧操作按钮区（插槽）
// 高度固定 42px（--h-main-header），与全局 .side-head 一致
defineProps<{
  /** 标题文字（小号大写显示） */
  title: string;
}>();
</script>

<template>
  <div class="ui-side-head">
    <span class="ui-side-title">{{ title }}</span>
    <!-- 右侧操作区：放 UiButton icon 系列 -->
    <div class="ui-side-actions">
      <slot name="actions" />
    </div>
  </div>
</template>

<style scoped>
.ui-side-head {
  height: var(--h-main-header);
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 var(--sp-3);
  border-bottom: 1px solid var(--border);
}
.ui-side-title {
  font-size: var(--fs-xs);
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-2);
}
.ui-side-actions { display: flex; gap: 2px; align-items: center; }
</style>

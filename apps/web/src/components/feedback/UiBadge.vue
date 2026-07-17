<script setup lang="ts">
// =============================================================================
// 计数徽章——收敛散落的 entity-count 小标签
// =============================================================================
// 出现位置（迁移前）：EntityGraphSideView 侧栏头部的实体计数（entity-count）
// 用途：显示一个数字（如实体总数、待确认数），pill 形小标签
defineProps<{
  /** 显示文字（通常是数字，也可传"3 项"等） */
  text: string | number;
}>();
</script>

<template>
  <span class="ui-badge">{{ text }}</span>
</template>

<style scoped>
.ui-badge {
  font-size: var(--fs-xs);
  color: var(--text-3);
  background: var(--bg-3);
  padding: 1px 6px;
  border-radius: var(--r-pill);
  line-height: 1.4;
}
</style>

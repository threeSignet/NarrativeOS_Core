<script setup lang="ts">
// =============================================================================
// 侧栏底部固定面板——收敛散落的 decisions-panel
// =============================================================================
// 出现位置（迁移前）：EntityGraphSideView 的待确认决策面板
// 角色：侧栏底部固定区，不随主体滚动。border-top + 浅色背景 + 自身滚动（内容多时）
// 典型用法：待确认决策、批量操作栏、状态摘要
withDefaults(defineProps<{
  /** 标题（如"待确认 · 3"），不传则不显示标题行 */
  title?: string;
  /** 标题色调，默认 accent；可传 warning/danger 等 */
  titleTone?: 'accent' | 'warning' | 'danger';
  /** 最大高度 px，超出滚动（待确认决策面板原为 200px） */
  maxHeight?: number;
}>(), {
  titleTone: 'accent',
  maxHeight: 200,
});
</script>

<template>
  <div class="ui-panel-footer" :style="{ maxHeight: maxHeight + 'px' }">
    <div v-if="title" class="ui-panel-footer-title" :data-tone="titleTone">{{ title }}</div>
    <div class="ui-panel-footer-body">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.ui-panel-footer {
  border-top: 1px solid var(--border-2);
  background: var(--accent-bg);
  overflow-y: auto;
  flex-shrink: 0;
}
.ui-panel-footer-title {
  font-size: var(--fs-xs);
  font-weight: 600;
  padding: 6px var(--sp-3);
  letter-spacing: 0.04em;
  color: var(--accent);
}
.ui-panel-footer-title[data-tone="warning"] { color: var(--warning); }
.ui-panel-footer-title[data-tone="danger"] { color: var(--danger); }
.ui-panel-footer-body { padding-bottom: 2px; }
</style>

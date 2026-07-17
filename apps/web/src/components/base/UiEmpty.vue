<script setup lang="ts">
// =============================================================================
// 通用空状态——收敛 4 处散落的 <div class="empty-state"> 手写 + 内联 style
// =============================================================================
// 出现位置（迁移前）：
//   - DocumentTreeView：树空（搜索无果 / 无文档），height:auto
//   - EntityGraphSideView：实体列表空，height:auto
//   - AgentPanel：无消息，height:auto
//   - GraphCanvas：图谱空，height:100%（撑满主区）
//
// block prop 解决高度差异：
//   - false（默认，侧栏用）：height:auto，只占内容高度，上下留 padding
//   - true（主区用）：height:100%，垂直居中撑满父容器
withDefaults(defineProps<{
  /** 标题（主文字） */
  title?: string;
  /** 描述（副文字） */
  description?: string;
  /** 图标名（传给 UiIcon），不传则不显示图标 */
  icon?: string;
  /** 图标尺寸 px，默认 32 */
  iconSize?: number;
  /** 是否撑满父容器（主区用 true，侧栏用 false） */
  block?: boolean;
}>(), {
  iconSize: 32,
  block: false,
});
</script>

<template>
  <div class="ui-empty" :class="{ 'is-block': block }">
    <!-- 图标：可用具名 slot 自定义（如复杂多色图标），否则用 UiIcon 按 name 渲染 -->
    <slot name="icon">
      <span v-if="icon" class="ui-empty-icon">
        <!-- 用 inline svg 包一层保证尺寸；UiIcon 已处理 stroke 风格 -->
        <svg :width="iconSize" :height="iconSize" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <template v-if="icon === 'chat'"><path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2z"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></template>
          <template v-else-if="icon === 'graph-empty'"><circle cx="6" cy="6" r="2"/><circle cx="18" cy="6" r="2"/><circle cx="12" cy="18" r="2"/><path d="M8 7h8M8 7l3 9M16 7l-3 9"/></template>
        </svg>
      </span>
    </slot>
    <div v-if="title" class="ui-empty-title">{{ title }}</div>
    <div v-if="description" class="ui-empty-desc"><slot name="description">{{ description }}</slot></div>
    <!-- 默认插槽：自定义内容（如带操作按钮的空状态） -->
    <slot />
  </div>
</template>

<style scoped>
.ui-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--sp-2);
  color: var(--text-3);
  text-align: center;
  /* 默认（侧栏）：高度自适应，上下留呼吸空间 */
  padding: var(--sp-6) var(--sp-3);
}
/* block 模式（主区）：撑满父容器，垂直居中 */
.ui-empty.is-block { height: 100%; padding: var(--sp-6); }

.ui-empty-icon { opacity: 0.5; display: inline-flex; }
.ui-empty-title { font-size: var(--fs-md); color: var(--text-2); }
/* 侧栏内的标题略小（侧栏宽度有限，大标题显挤） */
.ui-empty:not(.is-block) .ui-empty-title { font-size: var(--fs-sm); }
.ui-empty-desc { font-size: var(--fs-sm); line-height: 1.5; }
</style>

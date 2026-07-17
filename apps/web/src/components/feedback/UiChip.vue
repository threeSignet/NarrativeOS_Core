<script setup lang="ts">
// =============================================================================
// 过滤芯片——收敛 filter-chip / layer-chip 两套散落类
// =============================================================================
// 收敛目标：
//   .filter-chip（shell.css 全局，灰色，active 态用 accent）
//   .layer-chip（EntityGraphSideView scoped，自定义颜色 --lc，active/inactive 切换）
//
// 设计：
//   - color prop 传入自定义主题色（来源层用），不传则用默认灰色
//   - active 切换：active=true 高亮，false 半透明+删除线（对齐 layer-chip.is-off）
//   - 可点击切换（emit click）
import { computed } from 'vue';

const props = withDefaults(defineProps<{
  /** 是否激活（高亮态） */
  active?: boolean;
  /** 自定义主题色（CSS 色值或变量），不传用默认灰 */
  color?: string;
  /** 禁用 */
  disabled?: boolean;
}>(), {
  active: false,
});

const emit = defineEmits<{
  (e: 'click', ev: MouseEvent): void;
  (e: 'update:active', value: boolean): void;
}>();

/** 有自定义色时，用 color-mix 生成浅色背景 + 半透明边框 */
const styleObj = computed(() => {
  if (!props.color) return {};
  return {
    '--chip-color': props.color,
    borderColor: `color-mix(in srgb, ${props.color} 50%, transparent)`,
    color: props.color,
    background: `color-mix(in srgb, ${props.color} 12%, transparent)`,
  } as Record<string, string>;
});

function onClick(ev: MouseEvent) {
  if (props.disabled) return;
  emit('click', ev);
  emit('update:active', !props.active);
}
</script>

<template>
  <button
    type="button"
    class="ui-chip"
    :class="{ 'is-active': active, 'is-off': !active, 'has-color': !!color }"
    :style="styleObj"
    :disabled="disabled"
    @click="onClick"
  >
    <slot />
  </button>
</template>

<style scoped>
.ui-chip {
  font: inherit;
  font-size: var(--fs-xs);
  padding: 2px 8px;
  border-radius: var(--r-pill);
  border: 1px solid var(--border-2);
  color: var(--text-2);
  background: transparent;
  cursor: pointer;
  transition: all var(--t-fast);
}
.ui-chip:hover:not(:disabled) { color: var(--text); border-color: var(--text-3); }
/* 默认色（无 color prop）激活态：用 accent */
.ui-chip:not(.has-color).is-active {
  background: var(--accent-bg);
  color: var(--accent);
  border-color: var(--accent-border);
}
/* 自定义色激活态：样式已通过 inline style 应用，is-active 仅作语义标记，无需额外样式覆盖 */
/* 关闭态：半透明 + 删除线（对齐 layer-chip.is-off） */
.ui-chip.is-off { opacity: 0.5; }
.ui-chip.has-color.is-off { text-decoration: line-through; }
.ui-chip:disabled { cursor: not-allowed; }
</style>

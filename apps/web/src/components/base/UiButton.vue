<script setup lang="ts">
// =============================================================================
// 通用按钮组件——收敛全应用散落的 7 套按钮类
// =============================================================================
// 收敛目标（迁移后逐步删除这些散落类）：
//   .btn / .btn--primary / .btn--ghost / .btn--sm   （全局 shell.css，保留作基类）
//   .icon-btn                                       （侧栏头部图标按钮，24px）
//   .op-btn / .op--primary / .op--ghost             （实体行内操作按钮，10px）
//   .tb-btn / .tb-btn.on                            （编辑器工具栏，28px + active 态）
//   .doc-action-btn                                 （文档编辑器右侧动作，28px）
//   .filter-chip / .layer-chip                      （过滤芯片，单独由 UiChip 承载，不在此）
//
// 设计：
//   - variant 四态：default / primary / ghost / danger
//   - size 两档：md（默认）/ sm（紧凑，实体行内操作用）
//   - icon=true：纯图标按钮（方形，替代 icon-btn/tb-btn/doc-action-btn）
//   - active=true：选中态高亮（编辑器工具栏 B/I/H1 等联动选区用）
//   - title 透传为原生 title（tooltip）
//   - 内部复用全局 .btn 基类 + variant 修饰，保持与现有 ConfirmDialog/CommandPalette 一致
const props = withDefaults(defineProps<{
  /** 视觉变体 */
  variant?: 'default' | 'primary' | 'ghost' | 'danger';
  /** 尺寸：md 默认 / sm 紧凑（行内小操作） */
  size?: 'md' | 'sm';
  /** 纯图标按钮（方形，居中单个图标） */
  icon?: boolean;
  /** 选中态（编辑器工具栏联动选区用） */
  active?: boolean;
  /** 禁用 */
  disabled?: boolean;
  /** tooltip 文字 */
  title?: string;
  /** 原生 type，默认 button（避免误触发表单提交） */
  type?: 'button' | 'submit' | 'reset';
}>(), {
  variant: 'default',
  size: 'md',
  icon: false,
  active: false,
  disabled: false,
  type: 'button',
});

const emit = defineEmits<{
  (e: 'click', ev: MouseEvent): void;
}>();

function onClick(ev: MouseEvent) {
  if (props.disabled) return;
  emit('click', ev);
}
</script>

<template>
  <button
    :type="type"
    class="ui-btn"
    :class="[
      `ui-btn--${variant}`,
      `ui-btn--${size}`,
      { 'ui-btn--icon': icon, 'is-active': active, 'is-disabled': disabled },
    ]"
    :disabled="disabled"
    :title="title"
    @click="onClick"
  >
    <slot />
  </button>
</template>

<style scoped>
/* 基础按钮：对齐全局 .btn（shell.css），但用 scoped 类自包含，便于未来脱离全局类。
   尺寸基准：md 高 28px、sm 高 22px；icon 模式方形。 */
.ui-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  font: inherit;
  font-size: var(--fs-sm);
  border-radius: var(--r-sm);
  border: 1px solid var(--border-2);
  background: var(--bg-elev);
  color: var(--text);
  cursor: pointer;
  white-space: nowrap;
  transition: background var(--t-fast), color var(--t-fast), border-color var(--t-fast), opacity var(--t-fast);
}
.ui-btn:hover:not(.is-disabled) { background: var(--bg-3); border-color: var(--text-3); }
.ui-btn :deep(svg) { width: 14px; height: 14px; flex-shrink: 0; }

/* 尺寸 */
.ui-btn--md { padding: 5px 12px; }
.ui-btn--sm { padding: 2px 8px; font-size: var(--fs-xs); }
.ui-btn--sm :deep(svg) { width: 12px; height: 12px; }

/* 图标模式：方形，对齐 .icon-btn(24)/.tb-btn(28)。
   md 图标按钮 28px（工具栏）、sm 图标按钮 24px（侧栏头部）。 */
.ui-btn--icon { padding: 0; }
.ui-btn--icon.ui-btn--md { width: 28px; height: 28px; }
.ui-btn--icon.ui-btn--sm { width: 24px; height: 24px; }
.ui-btn--icon :deep(svg) { width: 16px; height: 16px; }
.ui-btn--icon.ui-btn--sm :deep(svg) { width: 15px; height: 15px; }

/* 变体 */
.ui-btn--primary { background: var(--accent); color: var(--accent-fg); border-color: var(--accent); font-weight: 500; }
.ui-btn--primary:hover:not(.is-disabled) { background: var(--accent-hover); border-color: var(--accent-hover); }
.ui-btn--ghost { background: transparent; border-color: transparent; color: var(--text-2); }
.ui-btn--ghost:hover:not(.is-disabled) { background: var(--bg-3); color: var(--text); border-color: transparent; }
.ui-btn--danger { color: var(--danger); }
.ui-btn--danger:hover:not(.is-disabled) { background: var(--danger-bg); border-color: var(--danger); }

/* 选中态（工具栏 B/I/H1 等） */
.ui-btn.is-active { background: var(--accent-bg); color: var(--accent); border-color: var(--accent-border); }

/* 禁用 */
.ui-btn.is-disabled { opacity: 0.5; cursor: not-allowed; }
.ui-btn:disabled { opacity: 0.5; cursor: not-allowed; }
</style>

<script setup lang="ts">
// =============================================================================
// 折叠式内联表单——收敛 create-form + form-actions 模式
// =============================================================================
// 出现位置（迁移前）：EntityGraphSideView 的新建实体/新建关系表单
// 行为：open=true 时展开显示，false 时折叠隐藏。
//       通过 v-model:open 双向绑定（点 + 按钮展开，提交/取消后收起）。
// 结构：字段区（默认插槽，放 UiInput/UiSelect/UiTextArea）+ 操作区（actions 插槽，放 UiButton）
const props = defineProps<{
  /** 是否展开（v-model:open） */
  open: boolean;
}>();

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void;
}>();

/** 取消：通知父组件收起 */
function cancel() {
  emit('update:open', false);
}
</script>

<template>
  <div v-if="open" class="ui-inline-form" @click.stop>
    <!-- 字段区：调用方放表单控件 -->
    <div class="ui-inline-form-fields">
      <slot />
    </div>
    <!-- 操作区：默认提供取消按钮；具名 actions 插槽可覆盖全部按钮 -->
    <div class="ui-inline-form-actions">
      <slot name="actions" :cancel="cancel">
        <button type="button" class="ui-inline-form-cancel" @click="cancel">取消</button>
      </slot>
    </div>
  </div>
</template>

<style scoped>
.ui-inline-form {
  padding: var(--sp-2);
  border-bottom: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.ui-inline-form-fields { display: flex; flex-direction: column; gap: 6px; }
.ui-inline-form-actions { display: flex; justify-content: flex-end; gap: 6px; }
/* 默认取消按钮样式（与 UiButton default+sm 一致，但此处用原生 button 保持插槽可选性） */
.ui-inline-form-cancel {
  padding: 3px 8px;
  font-size: var(--fs-xs);
  border-radius: var(--r-sm);
  border: 1px solid var(--border-2);
  background: var(--bg-elev);
  color: var(--text);
  cursor: pointer;
  font: inherit;
}
.ui-inline-form-cancel:hover { background: var(--bg-3); }
</style>

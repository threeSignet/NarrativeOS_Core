<script setup lang="ts">
// =============================================================================
// 下拉选择框——收敛 create-form 内的 .form-input（select 版）
// =============================================================================
// 统一样式与 UiInput 一致（复用同一套表单控件视觉）
defineProps<{
  modelValue: string;
  disabled?: boolean;
}>();

defineEmits<{
  (e: 'update:modelValue', value: string): void;
}>();
</script>

<template>
  <select
    class="ui-select"
    :value="modelValue"
    :disabled="disabled"
    @change="$emit('update:modelValue', ($event.target as HTMLSelectElement).value)"
  >
    <slot />
  </select>
</template>

<style scoped>
.ui-select {
  width: 100%;
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  padding: 6px 8px;
  font-size: var(--fs-sm);
  color: var(--text);
  font-family: inherit;
  cursor: pointer;
}
.ui-select:focus { outline: none; border-color: var(--border-focus); }
.ui-select:disabled { opacity: 0.6; cursor: not-allowed; }
</style>

<script setup lang="ts">
// =============================================================================
// 文本输入框——收敛 create-form 内的 .form-input（input 版）
// =============================================================================
// 统一样式：bg-input 背景 + border + 聚焦态 border-focus
// 支持原生 input 的常用属性透传（placeholder/disabled/type）
withDefaults(defineProps<{
  modelValue: string;
  placeholder?: string;
  disabled?: boolean;
  /** 原生 type，默认 text */
  type?: string;
}>(), {
  type: 'text',
});

defineEmits<{
  (e: 'update:modelValue', value: string): void;
  (e: 'enter'): void;
}>();
</script>

<template>
  <input
    :type="type"
    class="ui-input"
    :value="modelValue"
    :placeholder="placeholder"
    :disabled="disabled"
    @input="$emit('update:modelValue', ($event.target as HTMLInputElement).value)"
    @keydown.enter="$emit('enter')"
  />
</template>

<style scoped>
.ui-input {
  width: 100%;
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  padding: 6px 8px;
  font-size: var(--fs-sm);
  color: var(--text);
  font-family: inherit;
}
.ui-input:focus { outline: none; border-color: var(--border-focus); }
.ui-input:disabled { opacity: 0.6; cursor: not-allowed; }
</style>

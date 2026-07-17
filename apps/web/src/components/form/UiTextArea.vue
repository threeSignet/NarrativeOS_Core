<script setup lang="ts">
// =============================================================================
// 多行文本框——收敛 create-form 内的 .form-input（textarea 版）
// =============================================================================
// 与 UiInput 视觉一致，额外支持 rows 和垂直缩放
withDefaults(defineProps<{
  modelValue: string;
  placeholder?: string;
  disabled?: boolean;
  rows?: number;
  /** 是否禁用垂直缩放（输入框内固定高度），默认允许垂直缩放 */
  noResize?: boolean;
}>(), {
  rows: 2,
});

defineEmits<{
  (e: 'update:modelValue', value: string): void;
  /** 原生 keydown 透传（聊天框 Enter 发送等场景需要） */
  (e: 'keydown', ev: KeyboardEvent): void;
}>();
</script>

<template>
  <textarea
    class="ui-textarea"
    :class="{ 'no-resize': noResize }"
    :value="modelValue"
    :placeholder="placeholder"
    :disabled="disabled"
    :rows="rows"
    @input="$emit('update:modelValue', ($event.target as HTMLTextAreaElement).value)"
    @keydown="$emit('keydown', $event)"
  />
</template>

<style scoped>
.ui-textarea {
  width: 100%;
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  padding: 6px 8px;
  font-size: var(--fs-sm);
  color: var(--text);
  font-family: inherit;
  resize: vertical;
}
.ui-textarea:focus { outline: none; border-color: var(--border-focus); }
.ui-textarea:disabled { opacity: 0.6; cursor: not-allowed; }
.ui-textarea.no-resize { resize: none; }
</style>

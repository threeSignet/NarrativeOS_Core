<script setup lang="ts">
// 新建项目模态对话框——项目名 + 一句话前提（可选）
// 取代之前的 window.prompt，提供像样的引导输入。
import { ref, watch, nextTick } from 'vue';

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'create', payload: { title: string; premise: string }): void;
}>();

const title = ref('');
const premise = ref('');
const titleInput = ref<HTMLInputElement | null>(null);

// 打开时重置 + 聚焦
watch(() => props.open, async (v) => {
  if (v) {
    title.value = '';
    premise.value = '';
    await nextTick();
    titleInput.value?.focus();
  }
});

function submit() {
  const t = title.value.trim();
  if (!t) { titleInput.value?.focus(); return; }
  emit('create', { title: t, premise: premise.value.trim() });
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
  else if (e.key === 'Escape') { emit('close'); }
}
</script>

<template>
  <transition name="modal">
    <div v-if="open" class="modal-mask" @click.self="emit('close')">
      <div class="modal-box" @keydown="onKeydown">
        <h2 class="modal-title">新建小说项目</h2>

        <label class="modal-label">作品名称 <span class="req">*</span></label>
        <input ref="titleInput" v-model="title" class="modal-input" placeholder="例如：青云纪" maxlength="60" />

        <label class="modal-label">一句话前提 <span class="opt">（可选）</span></label>
        <textarea v-model="premise" class="modal-input" rows="3" placeholder="这个故事讲的是…（用于后续 Agent 初始化世界观）" maxlength="500"></textarea>

        <div class="modal-actions">
          <button class="btn btn--ghost" @click="emit('close')">取消</button>
          <button class="btn btn--primary" :disabled="!title.trim()" @click="submit">创建</button>
        </div>
      </div>
    </div>
  </transition>
</template>

<style scoped>
.modal-mask {
  position: fixed; inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex; align-items: center; justify-content: center;
  z-index: 300;
}
.modal-box {
  width: 480px; max-width: 92vw;
  background: var(--bg-elev);
  border: 1px solid var(--border-2);
  border-radius: var(--r-md);
  box-shadow: var(--shadow-pop);
  padding: var(--sp-5);
}
.modal-title { font-size: var(--fs-lg); font-weight: 600; margin-bottom: var(--sp-4); }
.modal-label {
  display: block; font-size: var(--fs-xs); color: var(--text-2);
  margin: var(--sp-3) 0 var(--sp-1);
  text-transform: uppercase; letter-spacing: .04em;
}
.req { color: var(--danger); }
.opt { color: var(--text-3); text-transform: none; letter-spacing: 0; }
.modal-input {
  width: 100%; padding: 8px 10px;
  background: var(--bg-input); border: 1px solid var(--border);
  border-radius: var(--r-sm); color: var(--text); font-size: var(--fs-sm);
  font-family: var(--font-ui); resize: vertical;
}
.modal-input:focus { outline: none; border-color: var(--accent); }
.modal-actions {
  display: flex; justify-content: flex-end; gap: var(--sp-2);
  margin-top: var(--sp-5);
}

.modal-enter-active, .modal-leave-active { transition: opacity var(--t); }
.modal-enter-from, .modal-leave-to { opacity: 0; }
.modal-enter-active .modal-box, .modal-leave-active .modal-box { transition: transform var(--t); }
.modal-enter-from .modal-box, .modal-leave-to .modal-box { transform: scale(0.96); }
</style>

<script setup lang="ts">
// 删除项目确认对话框——必须输入项目名才能删（GitHub 式防误删）
import { ref, watch, nextTick, computed } from 'vue';

const props = defineProps<{ open: boolean; projectTitle: string }>();
const emit = defineEmits<{ (e: 'close'): void; (e: 'confirm'): void }>();

const inputValue = ref('');
const inputEl = ref<HTMLInputElement | null>(null);

watch(() => props.open, async (v) => {
  if (v) {
    inputValue.value = '';
    await nextTick();
    inputEl.value?.focus();
  }
});

// 名字完全匹配才能删
const canDelete = computed(() => inputValue.value.trim() === props.projectTitle);

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && canDelete.value) { e.preventDefault(); emit('confirm'); }
  else if (e.key === 'Escape') { emit('close'); }
}
</script>

<template>
  <transition name="modal">
    <div v-if="open" class="modal-mask" @click.self="emit('close')">
      <div class="modal-box danger" @keydown="onKeydown">
        <h2 class="modal-title">删除项目「{{ projectTitle }}」</h2>
        <p class="modal-warn">
          此操作不可撤销。项目下全部设定文档、文件夹将被永久归档。
        </p>
        <p class="modal-instr">
          请输入项目名 <code>{{ projectTitle }}</code> 以确认删除：
        </p>
        <input ref="inputEl" v-model="inputValue" class="modal-input" :placeholder="projectTitle" />
        <div class="modal-actions">
          <button class="btn btn--ghost" @click="emit('close')">取消</button>
          <button class="btn btn--danger" :disabled="!canDelete" @click="emit('confirm')">
            我已了解后果，删除项目
          </button>
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
.modal-box.danger { border-color: color-mix(in srgb, var(--danger) 40%, var(--border-2)); }
.modal-title { font-size: var(--fs-lg); font-weight: 600; margin-bottom: var(--sp-3); }
.modal-warn { font-size: var(--fs-sm); color: var(--text-2); line-height: 1.6; margin-bottom: var(--sp-3); }
.modal-instr { font-size: var(--fs-sm); color: var(--text); margin-bottom: var(--sp-2); }
.modal-instr code {
  font-family: var(--font-mono); font-weight: 600;
  background: var(--bg-3); padding: 2px 6px; border-radius: var(--r-xs);
  color: var(--danger);
}
.modal-input {
  width: 100%; padding: 8px 10px;
  background: var(--bg-input); border: 1px solid var(--border);
  border-radius: var(--r-sm); color: var(--text); font-size: var(--fs-sm);
  font-family: var(--font-ui);
}
.modal-input:focus { outline: none; border-color: var(--danger); }
.modal-actions { display: flex; justify-content: flex-end; gap: var(--sp-2); margin-top: var(--sp-5); }

.modal-enter-active, .modal-leave-active { transition: opacity var(--t); }
.modal-enter-from, .modal-leave-to { opacity: 0; }
</style>

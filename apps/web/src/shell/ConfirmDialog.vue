<script setup lang="ts">
// 通用确认对话框——替代 window.confirm，挂载在 App 根
import { useConfirmStore } from '../stores/confirm';

const confirmStore = useConfirmStore();

function onKeydown(e: KeyboardEvent) {
  if (!confirmStore.current) return;
  if (e.key === 'Enter') { e.preventDefault(); confirmStore.accept(); }
  else if (e.key === 'Escape') { e.preventDefault(); confirmStore.reject(); }
}
</script>

<template>
  <transition name="modal">
    <div v-if="confirmStore.current" class="modal-mask" @click.self="confirmStore.reject">
      <div class="modal-box" :class="{ danger: confirmStore.current.danger }" @keydown="onKeydown" tabindex="0">
        <h2 class="modal-title">{{ confirmStore.current.title }}</h2>
        <p v-if="confirmStore.current.message" class="modal-message">{{ confirmStore.current.message }}</p>
        <div class="modal-actions">
          <button class="btn btn--ghost" @click="confirmStore.reject">
            {{ confirmStore.current.cancelText ?? '取消' }}
          </button>
          <button
            class="btn"
            :class="confirmStore.current.danger ? 'btn--danger' : 'btn--primary'"
            @click="confirmStore.accept"
          >
            {{ confirmStore.current.confirmText ?? '确认' }}
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
  z-index: 400;
}
.modal-box {
  width: 420px; max-width: 92vw;
  background: var(--bg-elev);
  border: 1px solid var(--border-2);
  border-radius: var(--r-md);
  box-shadow: var(--shadow-pop);
  padding: var(--sp-5);
  outline: none;
}
.modal-box.danger { border-color: color-mix(in srgb, var(--danger) 40%, var(--border-2)); }
.modal-title { font-size: var(--fs-md); font-weight: 600; margin-bottom: var(--sp-2); }
.modal-message { font-size: var(--fs-sm); color: var(--text-2); line-height: 1.6; margin-bottom: var(--sp-4); white-space: pre-wrap; }
.modal-actions { display: flex; justify-content: flex-end; gap: var(--sp-2); }

.modal-enter-active, .modal-leave-active { transition: opacity var(--t); }
.modal-enter-from, .modal-leave-to { opacity: 0; }
</style>

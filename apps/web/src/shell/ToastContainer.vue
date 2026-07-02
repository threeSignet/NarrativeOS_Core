<script setup lang="ts">
// Toast 容器——固定右上角，渲染所有活动 toast
import { useToastStore } from '../stores/toast';
import type { ToastType } from '../stores/toast';

const toastStore = useToastStore();

const iconFor = (type: ToastType) => {
  switch (type) {
    case 'success': return '✓';
    case 'error': return '✕';
    case 'warning': return '!';
    case 'info': return 'i';
  }
};
</script>

<template>
  <div class="toast-container">
    <transition-group name="toast">
      <div
        v-for="t in toastStore.toasts"
        :key="t.id"
        class="toast"
        :class="`toast--${t.type}`"
        @click="toastStore.dismiss(t.id)"
      >
        <span class="toast-icon">{{ iconFor(t.type) }}</span>
        <span class="toast-msg">{{ t.message }}</span>
      </div>
    </transition-group>
  </div>
</template>

<style scoped>
.toast-container {
  position: fixed;
  top: 48px; right: 16px;
  z-index: 500;
  display: flex; flex-direction: column; gap: 8px;
  pointer-events: none;
}
.toast {
  display: flex; align-items: flex-start; gap: 10px;
  min-width: 280px; max-width: 380px;
  padding: 10px 14px;
  background: var(--bg-elev);
  border: 1px solid var(--border-2);
  border-left: 3px solid var(--text-3);
  border-radius: var(--r-md);
  box-shadow: var(--shadow-md);
  font-size: var(--fs-sm); color: var(--text);
  pointer-events: auto;
  cursor: pointer;
  line-height: 1.5;
}
.toast--success { border-left-color: var(--success); }
.toast--error   { border-left-color: var(--danger); }
.toast--warning { border-left-color: var(--warning); }
.toast--info    { border-left-color: var(--accent); }

.toast-icon {
  width: 18px; height: 18px; flex-shrink: 0;
  display: inline-flex; align-items: center; justify-content: center;
  border-radius: 50%;
  font-size: 11px; font-weight: 700; font-family: var(--font-mono);
}
.toast--success .toast-icon { background: var(--success-bg); color: var(--success); }
.toast--error   .toast-icon { background: var(--danger-bg);  color: var(--danger); }
.toast--warning .toast-icon { background: var(--warning-bg); color: var(--warning); }
.toast--info    .toast-icon { background: var(--accent-bg);  color: var(--accent); }
.toast-msg { flex: 1; }

.toast-enter-active, .toast-leave-active { transition: all var(--t); }
.toast-enter-from { opacity: 0; transform: translateX(20px); }
.toast-leave-to   { opacity: 0; transform: translateX(20px); }
</style>

// Toast store——全局轻提示（右上角浮现，自动消失）
// 替代所有 alert 用法。四种类型：success / error / warning / info
import { defineStore } from 'pinia';
import { ref } from 'vue';

export type ToastType = 'success' | 'error' | 'warning' | 'info';

export interface ToastItem {
  id: number;
  type: ToastType;
  message: string;
  /** 自动消失时长（ms），0 = 不自动消失 */
  duration: number;
}

let nextId = 1;

export const useToastStore = defineStore('toast', () => {
  const toasts = ref<ToastItem[]>([]);

  function show(message: string, type: ToastType = 'info', duration = 3200) {
    const id = nextId++;
    toasts.value.push({ id, type, message, duration });
    if (duration > 0) {
      setTimeout(() => dismiss(id), duration);
    }
    return id;
  }

  function dismiss(id: number) {
    const idx = toasts.value.findIndex(t => t.id === id);
    if (idx !== -1) toasts.value.splice(idx, 1);
  }

  // 便捷方法
  const success = (msg: string, d?: number) => show(msg, 'success', d);
  const error = (msg: string, d?: number) => show(msg, 'error', d ?? 4500); // 错误提示显示久一点
  const warning = (msg: string, d?: number) => show(msg, 'warning', d);
  const info = (msg: string, d?: number) => show(msg, 'info', d);

  return { toasts, show, dismiss, success, error, warning, info };
});

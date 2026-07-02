// confirm store——全局二次确认（替代 window.confirm）
// 用法：const ok = await useConfirm()({ title, message, danger: true })
import { defineStore } from 'pinia';
import { ref } from 'vue';

export interface ConfirmOptions {
  title: string;
  message?: string;
  /** 确认按钮文字（默认"确认"） */
  confirmText?: string;
  /** 取消按钮文字（默认"取消"） */
  cancelText?: string;
  /** 危险操作（确认按钮变红） */
  danger?: boolean;
}

interface PendingConfirm extends ConfirmOptions {
  resolve: (ok: boolean) => void;
}

export const useConfirmStore = defineStore('confirm', () => {
  const current = ref<PendingConfirm | null>(null);

  /** 发起一次确认，返回 Promise<boolean>（true=确认，false=取消） */
  function confirm(options: ConfirmOptions): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      current.value = { ...options, resolve };
    });
  }

  /** 用户点确认 */
  function accept() {
    if (current.value) {
      current.value.resolve(true);
      current.value = null;
    }
  }

  /** 用户点取消 / 关闭 */
  function reject() {
    if (current.value) {
      current.value.resolve(false);
      current.value = null;
    }
  }

  return { current, confirm, accept, reject };
});

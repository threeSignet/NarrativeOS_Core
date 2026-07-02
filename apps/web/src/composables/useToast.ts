// useToast——便捷封装，任何组件用 const toast = useToast() 即可调用
import { useToastStore } from '../stores/toast';

export function useToast() {
  const store = useToastStore();
  return {
    success: store.success,
    error: store.error,
    warning: store.warning,
    info: store.info,
    show: store.show,
    dismiss: store.dismiss,
  };
}

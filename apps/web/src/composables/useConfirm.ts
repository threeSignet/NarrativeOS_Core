// useConfirm——便捷封装，const confirm = useConfirm(); await confirm({...})
import { useConfirmStore } from '../stores/confirm';
import type { ConfirmOptions } from '../stores/confirm';

export function useConfirm() {
  const store = useConfirmStore();
  return (options: ConfirmOptions) => store.confirm(options);
}

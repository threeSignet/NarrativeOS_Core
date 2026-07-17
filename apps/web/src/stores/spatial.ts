// Spatial store——空间地图只读树视图（迭代 C4）
import { defineStore } from 'pinia';
import { ref } from 'vue';
import { getSpatialTree, type SpatialTreeView } from '../api/spatials';

export const useSpatialStore = defineStore('spatial', () => {
  const tree = ref<SpatialTreeView | null>(null);
  const loading = ref(false);
  const error = ref('');

  async function loadTree(projectId: string) {
    loading.value = true; error.value = '';
    try {
      tree.value = await getSpatialTree(projectId);
    } catch (e: any) {
      error.value = e?.response?.data?.error ?? e?.message ?? '加载失败';
    } finally {
      loading.value = false;
    }
  }

  function clear() { tree.value = null; error.value = ''; }

  return { tree, loading, error, loadTree, clear };
});

// Revision store——修订历史只读（迭代 D2）
import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { listRevisions, type RevisionRecord, type RevisionTargetType } from '../api/revisions';

export const useRevisionStore = defineStore('revision', () => {
  const records = ref<RevisionRecord[]>([]);
  const loading = ref(false);
  const error = ref('');
  const targetTypeFilter = ref<RevisionTargetType | null>(null);

  const filteredRecords = computed(() => {
    if (!targetTypeFilter.value) return records.value;
    return records.value.filter((r) => r.targetType === targetTypeFilter.value);
  });

  async function loadRevisions(projectId: string) {
    loading.value = true; error.value = '';
    try { records.value = await listRevisions(projectId, 200); }
    catch (e: any) { error.value = e?.response?.data?.error ?? e?.message ?? '加载失败'; }
    finally { loading.value = false; }
  }

  function clear() { records.value = []; error.value = ''; targetTypeFilter.value = null; }

  return { records, loading, error, targetTypeFilter, filteredRecords, loadRevisions, clear };
});

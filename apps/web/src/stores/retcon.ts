// Retcon store——Retcon 影响报告只读+状态推进（迭代 D4）
import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { listRetcons, updateRetconStatus, type RetconImpactReport, type RetconReportStatus } from '../api/retcons';

export const useRetconStore = defineStore('retcon', () => {
  const reports = ref<RetconImpactReport[]>([]);
  const selectedId = ref<string | null>(null);
  const loading = ref(false);
  const error = ref('');
  const statusFilter = ref<RetconReportStatus | null>(null);

  const filteredReports = computed(() => {
    if (!statusFilter.value) return reports.value;
    return reports.value.filter(r => r.status === statusFilter.value);
  });

  const selected = computed(() => reports.value.find(r => r.id === selectedId.value) ?? null);

  async function loadReports(projectId: string) {
    loading.value = true; error.value = '';
    try { reports.value = await listRetcons(projectId); }
    catch (e: any) { error.value = e?.response?.data?.error ?? e?.message ?? '加载失败'; }
    finally { loading.value = false; }
  }

  function select(id: string | null) { selectedId.value = id; }

  async function advanceStatus(projectId: string, id: string, status: RetconReportStatus) {
    const updated = await updateRetconStatus(projectId, id, status);
    const idx = reports.value.findIndex(r => r.id === id);
    if (idx >= 0) reports.value[idx] = updated;
  }

  function clear() { reports.value = []; selectedId.value = null; error.value = ''; statusFilter.value = null; }

  return { reports, selectedId, loading, error, statusFilter, filteredReports, selected, loadReports, select, advanceStatus, clear };
});

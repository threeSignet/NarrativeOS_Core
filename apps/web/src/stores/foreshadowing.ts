// Foreshadowing store——伏笔看板列表 + 创建 + 状态推进（迭代 C1）
import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import {
  listForeshadowings, createForeshadowing, transitionForeshadowingStatus,
  STATUS_FLOW,
  type ForeshadowingPlan, type ForeshadowingKind, type ForeshadowingPlanStatus,
} from '../api/foreshadowings';

export const useForeshadowingStore = defineStore('foreshadowing', () => {
  const plans = ref<ForeshadowingPlan[]>([]);
  const loading = ref(false);
  const error = ref('');
  const acting = ref(false);

  /** 按状态分组的伏笔（看板列） */
  const groupedByStatus = computed(() => {
    const groups = new Map<ForeshadowingPlanStatus, ForeshadowingPlan[]>();
    for (const s of STATUS_FLOW) groups.set(s, []);
    groups.set('abandoned', []);
    for (const p of plans.value) {
      if (groups.has(p.status)) groups.get(p.status)!.push(p);
    }
    return groups;
  });

  async function loadPlans(projectId: string) {
    loading.value = true; error.value = '';
    try {
      plans.value = await listForeshadowings(projectId);
    } catch (e: any) {
      error.value = e?.response?.data?.error ?? e?.message ?? '加载失败';
    } finally {
      loading.value = false;
    }
  }

  async function create(projectId: string, input: { label: string; kind: ForeshadowingKind; targetReaderEffect: string }) {
    acting.value = true; error.value = '';
    try {
      const created = await createForeshadowing(projectId, input);
      plans.value.push(created);
      return created;
    } catch (e: any) {
      error.value = e?.response?.data?.error ?? e?.message ?? '创建失败';
      throw e;
    } finally { acting.value = false; }
  }

  async function transition(projectId: string, id: string, target: ForeshadowingPlanStatus) {
    acting.value = true; error.value = '';
    try {
      await transitionForeshadowingStatus(projectId, id, target);
      const idx = plans.value.findIndex((p) => p.id === id);
      if (idx >= 0) plans.value[idx] = { ...plans.value[idx]!, status: target };
    } catch (e: any) {
      error.value = e?.response?.data?.error ?? e?.message ?? '状态推进失败';
      throw e;
    } finally { acting.value = false; }
  }

  function clear() { plans.value = []; error.value = ''; }

  return { plans, loading, error, acting, groupedByStatus, loadPlans, create, transition, clear };
});

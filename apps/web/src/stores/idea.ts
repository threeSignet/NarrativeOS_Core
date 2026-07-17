// Idea store——灵感卡片列表 + CRUD（迭代 B1）
import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import {
  listIdeas, captureIdea, updateIdea, discardIdea, restoreIdea,
  type IdeaCard, type IdeaKind, type IdeaMaturity,
} from '../api/ideas';

export const useIdeaStore = defineStore('idea', () => {
  const ideas = ref<IdeaCard[]>([]);
  const selectedId = ref<string | null>(null);
  const loading = ref(false);
  const error = ref('');
  const acting = ref(false);
  /** 搜索关键词 */
  const query = ref('');
  /** 类型过滤（null=全部） */
  const kindFilter = ref<IdeaKind | null>(null);
  /** 是否显示已归档 */
  const showArchived = ref(false);

  const selected = () => ideas.value.find((i) => i.id === selectedId.value) ?? null;

  /** 过滤后的灵感（搜索 + 类型 + 归档） */
  const filteredIdeas = computed(() => {
    let list = ideas.value;
    if (!showArchived.value) list = list.filter((i) => i.maturity !== 'archived');
    if (kindFilter.value) list = list.filter((i) => i.kind === kindFilter.value);
    if (query.value.trim()) {
      const q = query.value.toLowerCase();
      list = list.filter((i) =>
        i.content.toLowerCase().includes(q) ||
        (i.summary?.toLowerCase().includes(q)) ||
        i.tags.some((t) => t.toLowerCase().includes(q)),
      );
    }
    return list;
  });

  async function loadIdeas(projectId: string) {
    loading.value = true; error.value = '';
    try {
      ideas.value = await listIdeas(projectId);
    } catch (e: any) {
      error.value = e?.response?.data?.error ?? e?.message ?? '加载失败';
    } finally {
      loading.value = false;
    }
  }

  function select(id: string | null) { selectedId.value = id; }

  async function capture(projectId: string, input: { content: string; kind?: IdeaKind; tags?: string[] }) {
    acting.value = true; error.value = '';
    try {
      const created = await captureIdea(projectId, input);
      ideas.value.unshift(created);
      return created;
    } catch (e: any) {
      error.value = e?.response?.data?.error ?? e?.message ?? '捕捉失败';
      throw e;
    } finally { acting.value = false; }
  }

  async function edit(projectId: string, id: string, updates: Parameters<typeof updateIdea>[2]) {
    acting.value = true; error.value = '';
    try {
      const updated = await updateIdea(projectId, id, updates);
      const idx = ideas.value.findIndex((i) => i.id === id);
      if (idx >= 0) ideas.value[idx] = updated;
      return updated;
    } catch (e: any) {
      error.value = e?.response?.data?.error ?? e?.message ?? '编辑失败';
      throw e;
    } finally { acting.value = false; }
  }

  async function discard(projectId: string, id: string) {
    acting.value = true; error.value = '';
    try {
      await discardIdea(projectId, id);
      const idx = ideas.value.findIndex((i) => i.id === id);
      if (idx >= 0) ideas.value[idx] = { ...ideas.value[idx]!, maturity: 'archived' };
    } catch (e: any) {
      error.value = e?.response?.data?.error ?? e?.message ?? '废弃失败';
      throw e;
    } finally { acting.value = false; }
  }

  async function restore(projectId: string, id: string) {
    acting.value = true; error.value = '';
    try {
      const updated = await restoreIdea(projectId, id);
      const idx = ideas.value.findIndex((i) => i.id === id);
      if (idx >= 0) ideas.value[idx] = updated;
      return updated;
    } catch (e: any) {
      error.value = e?.response?.data?.error ?? e?.message ?? '恢复失败';
      throw e;
    } finally { acting.value = false; }
  }

  function clear() {
    ideas.value = []; selectedId.value = null; error.value = '';
    query.value = ''; kindFilter.value = null; showArchived.value = false;
  }

  return {
    ideas, selectedId, loading, error, acting, query, kindFilter, showArchived,
    selected, filteredIdeas, loadIdeas, select, capture, edit, discard, restore, clear,
  };
});

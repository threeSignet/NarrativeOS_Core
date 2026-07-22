// Style store——风格指南只读+编辑（迭代 D3）
import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import {
  getOrCreateGuide, updateGuide, listExamples, addExample, listBanned, addBanned,
  type StyleGuide, type StyleExample, type BannedExpression,
  type NarrativePerson, type NarrativeDistance, type PacingPreference, type DescriptionPreference,
} from '../api/styles';

export const useStyleStore = defineStore('style', () => {
  const guide = ref<StyleGuide | null>(null);
  const examples = ref<StyleExample[]>([]);
  const banned = ref<BannedExpression[]>([]);
  const loading = ref(false);
  const error = ref('');

  // ---- 加载 ----
  async function loadGuide(projectId: string) {
    loading.value = true; error.value = '';
    try {
      guide.value = await getOrCreateGuide(projectId);
      const [ex, ban] = await Promise.all([listExamples(projectId), listBanned(projectId)]);
      examples.value = ex;
      banned.value = ban;
    } catch (e: any) { error.value = e?.response?.data?.error ?? e?.message ?? '加载失败'; }
    finally { loading.value = false; }
  }

  // ---- 指南编辑 ----
  async function editGuide(projectId: string, updates: Partial<Pick<StyleGuide, 'name' | 'narrativePerson' | 'narrativeDistance' | 'pacingPreference' | 'descriptionPreference' | 'status' | 'scopeNote'>>) {
    if (!guide.value) return;
    const saved = await updateGuide(projectId, guide.value.id, updates);
    guide.value = saved;
  }

  // ---- 示例 ----
  async function createExample(projectId: string, kind: StyleExample['kind'], text: string, note?: string) {
    const ex = await addExample(projectId, { kind, text, note });
    examples.value.push(ex);
    return ex;
  }

  // ---- 禁用表达 ----
  async function createBanned(projectId: string, pattern: string, reason?: string, category?: string) {
    const b = await addBanned(projectId, { pattern, reason, category });
    banned.value.push(b);
    return b;
  }

  function clear() { guide.value = null; examples.value = []; banned.value = []; error.value = ''; }

  return { guide, examples, banned, loading, error, loadGuide, editGuide, createExample, createBanned, clear };
});

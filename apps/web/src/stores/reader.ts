// Reader store——读者群体 + 认知状态（迭代 C3）
import { defineStore } from 'pinia';
import { ref } from 'vue';
import {
  listAudiences, createAudience, listKnowledgeStates, createKnowledgeState, updateKnowledgeState,
  type ReaderAudienceProfile, type ReaderKnowledgeState, type ReaderAudienceKind, type ReaderKnowledgeStateValue,
} from '../api/readers';

export const useReaderStore = defineStore('reader', () => {
  const audiences = ref<ReaderAudienceProfile[]>([]);
  const selectedId = ref<string | null>(null);
  const knowledgeStates = ref<ReaderKnowledgeState[]>([]);
  const loading = ref(false);
  const error = ref('');
  const acting = ref(false);

  const selected = () => audiences.value.find((a) => a.id === selectedId.value) ?? null;

  async function loadAudiences(projectId: string) {
    loading.value = true; error.value = '';
    try {
      audiences.value = await listAudiences(projectId);
      if (audiences.value.length > 0 && !selectedId.value) selectedId.value = audiences.value[0]!.id;
      if (selectedId.value) await loadKnowledge(projectId, selectedId.value);
    } catch (e: any) {
      error.value = e?.response?.data?.error ?? e?.message ?? '加载失败';
    } finally { loading.value = false; }
  }

  async function loadKnowledge(projectId: string, audienceId: string) {
    try {
      knowledgeStates.value = await listKnowledgeStates(projectId, audienceId);
    } catch (e: any) {
      error.value = e?.message;
    }
  }

  async function select(projectId: string, id: string) {
    selectedId.value = id;
    await loadKnowledge(projectId, id);
  }

  async function create(projectId: string, input: { label: string; kind: ReaderAudienceKind; notes?: string }) {
    acting.value = true; error.value = '';
    try {
      const created = await createAudience(projectId, input);
      audiences.value.push(created);
      return created;
    } catch (e: any) {
      error.value = e?.response?.data?.error ?? e?.message;
      throw e;
    } finally { acting.value = false; }
  }

  async function addKnowledge(projectId: string, input: { subjectRef: string; state: ReaderKnowledgeStateValue; confidence?: number }) {
    if (!selectedId.value) return;
    acting.value = true; error.value = '';
    try {
      const ks = await createKnowledgeState(projectId, selectedId.value, input);
      knowledgeStates.value.push(ks);
    } catch (e: any) {
      error.value = e?.response?.data?.error ?? e?.message;
      throw e;
    } finally { acting.value = false; }
  }

  async function editKnowledge(projectId: string, kid: string, state: ReaderKnowledgeStateValue, confidence?: number) {
    acting.value = true; error.value = '';
    try {
      await updateKnowledgeState(projectId, kid, state, confidence);
      const idx = knowledgeStates.value.findIndex((k) => k.id === kid);
      if (idx >= 0) knowledgeStates.value[idx] = { ...knowledgeStates.value[idx]!, state, confidence: confidence ?? knowledgeStates.value[idx]!.confidence };
    } catch (e: any) {
      error.value = e?.response?.data?.error ?? e?.message;
      throw e;
    } finally { acting.value = false; }
  }

  function clear() { audiences.value = []; selectedId.value = null; knowledgeStates.value = []; error.value = ''; }

  return { audiences, selectedId, knowledgeStates, loading, error, acting, selected, loadAudiences, loadKnowledge, select, create, addKnowledge, editKnowledge, clear };
});

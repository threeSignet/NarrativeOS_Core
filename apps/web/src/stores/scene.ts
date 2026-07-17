// Scene store——场景卡列表 + CRUD + 状态推进（迭代 D1）
import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import {
  listScenes, createScene, updateScene, transitionSceneStatus,
  type ScenePlan, type ScenePurpose, type ScenePlanStatus,
} from '../api/scenes';
import { useChapterStore } from './chapter';

export const useSceneStore = defineStore('scene', () => {
  const scenes = ref<ScenePlan[]>([]);
  const selectedId = ref<string | null>(null);
  const loading = ref(false);
  const error = ref('');
  const acting = ref(false);

  const selected = () => scenes.value.find((s) => s.id === selectedId.value) ?? null;

  /** 按章节分组 */
  const groupedByChapter = computed(() => {
    const chapterStore = useChapterStore();
    const groups = new Map<string, ScenePlan[]>();
    for (const s of scenes.value) {
      if (!groups.has(s.chapterId)) groups.set(s.chapterId, []);
      groups.get(s.chapterId)!.push(s);
    }
    // 附带章节标题
    return Array.from(groups.entries()).map(([chapterId, items]) => {
      const ch = chapterStore.chapters.find((c) => c.id === chapterId);
      return { chapterId, chapterTitle: ch?.title ?? '(未知章节)', chapterOrder: ch?.order ?? 0, items: items.sort((a, b) => a.order - b.order) };
    }).sort((a, b) => a.chapterOrder - b.chapterOrder);
  });

  async function loadScenes(projectId: string) {
    loading.value = true; error.value = '';
    try { scenes.value = await listScenes(projectId); }
    catch (e: any) { error.value = e?.response?.data?.error ?? e?.message ?? '加载失败'; }
    finally { loading.value = false; }
  }

  function select(id: string | null) { selectedId.value = id; }

  async function create(projectId: string, input: { chapterId: string; title: string; purpose?: ScenePurpose[]; expectedOutcome?: string }) {
    acting.value = true; error.value = '';
    try { const created = await createScene(projectId, input); scenes.value.push(created); return created; }
    catch (e: any) { error.value = e?.response?.data?.error ?? e?.message; throw e; }
    finally { acting.value = false; }
  }

  async function edit(projectId: string, id: string, expectedVersion: number, updates: Parameters<typeof updateScene>[3]) {
    acting.value = true; error.value = '';
    try {
      const updated = await updateScene(projectId, id, expectedVersion, updates);
      const i = scenes.value.findIndex((s) => s.id === id);
      if (i >= 0) scenes.value[i] = updated;
      return updated;
    } catch (e: any) { error.value = e?.response?.data?.error ?? e?.message; throw e; }
    finally { acting.value = false; }
  }

  async function transition(projectId: string, id: string, target: ScenePlanStatus) {
    acting.value = true; error.value = '';
    try {
      const updated = await transitionSceneStatus(projectId, id, target);
      const i = scenes.value.findIndex((s) => s.id === id);
      if (i >= 0) scenes.value[i] = updated;
    } catch (e: any) { error.value = e?.response?.data?.error ?? e?.message; throw e; }
    finally { acting.value = false; }
  }

  function clear() { scenes.value = []; selectedId.value = null; error.value = ''; }

  return { scenes, selectedId, loading, error, acting, selected, groupedByChapter, loadScenes, select, create, edit, transition, clear };
});

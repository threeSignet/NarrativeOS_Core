// Chapter store——章节列表 + CRUD + 状态推进 + 重排（迭代 A1）
import { defineStore } from 'pinia';
import { ref } from 'vue';
import {
  listChapters,
  createChapter,
  updateChapter,
  transitionChapterStatus,
  reorderChapters,
  type ChapterPlan,
  type ChapterStatus,
} from '../api/chapters';

export const useChapterStore = defineStore('chapter', () => {
  const chapters = ref<ChapterPlan[]>([]);
  const selectedId = ref<string | null>(null);
  const loading = ref(false);
  const error = ref('');
  /** 写操作进行中（防重复点击） */
  const acting = ref(false);

  const selected = () => chapters.value.find((c) => c.id === selectedId.value) ?? null;

  /** 加载章节列表（按 order 升序） */
  async function loadChapters(projectId: string) {
    loading.value = true; error.value = '';
    try {
      chapters.value = await listChapters(projectId);
    } catch (e: any) {
      error.value = e?.response?.data?.error ?? e?.message ?? '加载失败';
    } finally {
      loading.value = false;
    }
  }

  function select(id: string | null) {
    selectedId.value = id;
  }

  /** 新建章节（order 自动放末尾） */
  async function create(projectId: string, input: { title: string; goals?: string[] }) {
    acting.value = true; error.value = '';
    try {
      const created = await createChapter(projectId, input);
      chapters.value.push(created);
      chapters.value.sort((a, b) => a.order - b.order);
      return created;
    } catch (e: any) {
      error.value = e?.response?.data?.error ?? e?.message ?? '创建失败';
      throw e;
    } finally {
      acting.value = false;
    }
  }

  /** 改标题（乐观锁，失败抛错由调用方提示） */
  async function rename(projectId: string, id: string, newTitle: string) {
    const ch = chapters.value.find((c) => c.id === id);
    if (!ch) return;
    acting.value = true; error.value = '';
    try {
      const updated = await updateChapter(projectId, id, ch.version, { title: newTitle });
      const idx = chapters.value.findIndex((c) => c.id === id);
      if (idx >= 0) chapters.value[idx] = updated;
    } catch (e: any) {
      error.value = e?.response?.data?.error ?? e?.message ?? '重命名失败';
      throw e;
    } finally {
      acting.value = false;
    }
  }

  /** 推进章节状态 */
  async function transition(projectId: string, id: string, target: ChapterStatus) {
    acting.value = true; error.value = '';
    try {
      const updated = await transitionChapterStatus(projectId, id, target);
      const idx = chapters.value.findIndex((c) => c.id === id);
      if (idx >= 0) chapters.value[idx] = updated;
    } catch (e: any) {
      error.value = e?.response?.data?.error ?? e?.message ?? '状态推进失败';
      throw e;
    } finally {
      acting.value = false;
    }
  }

  /** 重排（传新的顺序 id 数组） */
  async function reorder(projectId: string, orderedIds: string[]) {
    acting.value = true; error.value = '';
    try {
      await reorderChapters(projectId, orderedIds);
      // 本地按新顺序重排
      const map = new Map(chapters.value.map((c) => [c.id, c]));
      chapters.value = orderedIds
        .map((id, i) => {
          const c = map.get(id);
          return c ? { ...c, order: i + 1 } : null;
        })
        .filter((c): c is ChapterPlan => c !== null);
    } catch (e: any) {
      error.value = e?.response?.data?.error ?? e?.message ?? '重排失败';
      throw e;
    } finally {
      acting.value = false;
    }
  }

  function clear() {
    chapters.value = [];
    selectedId.value = null;
    error.value = '';
  }

  return {
    chapters, selectedId, loading, error, acting,
    selected, loadChapters, select, create, rename, transition, reorder, clear,
  };
});

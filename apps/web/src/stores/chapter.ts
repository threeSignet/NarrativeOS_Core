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
import { getProseDocument, createProseDocument, blocksToMarkdown, ingestProseText } from '../api/prose';

export const useChapterStore = defineStore('chapter', () => {
  const chapters = ref<ChapterPlan[]>([]);
  const selectedId = ref<string | null>(null);
  const loading = ref(false);
  const error = ref('');
  /** 写操作进行中（防重复点击） */
  const acting = ref(false);
  /** 当前打开章节的正文 Markdown（A2：点章节 → 加载/创建正文 → 编辑器读写） */
  const activeProseText = ref('');
  /** 当前打开的正文文档 id（关联到 selectedId 对应章节的 proseDocumentId） */
  const activeProseDocId = ref<string | null>(null);
  /** 正文保存状态 */
  const proseSync = ref<'saved' | 'syncing' | 'error'>('saved');

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

  /**
   * 打开某章节的正文：若章节有 proseDocumentId 则读取，否则创建空文档并回填关联。
   * 返回正文 Markdown 串供编辑器初始化。
   * A2 核心联动逻辑：章节 ↔ 正文 一对一。
   */
  async function getOrCreateProse(projectId: string, chapterId: string): Promise<string> {
    const ch = chapters.value.find((c) => c.id === chapterId);
    if (!ch) throw new Error('章节不存在');
    acting.value = true; error.value = '';
    try {
      // 已有正文文档 → 读取块转 Markdown
      if (ch.proseDocumentId) {
        const withBlocks = await getProseDocument(projectId, ch.proseDocumentId);
        activeProseDocId.value = withBlocks.document.id;
        activeProseText.value = blocksToMarkdown(withBlocks.blocks);
        proseSync.value = 'saved';
        return activeProseText.value;
      }
      // 无正文文档 → 创建空文档，标题沿用章节标题，回填 proseDocumentId 到章节
      const doc = await createProseDocument(projectId, { title: ch.title });
      await updateChapter(projectId, chapterId, ch.version, { proseDocumentId: doc.id });
      // 更新本地章节的 proseDocumentId + version
      const idx = chapters.value.findIndex((c) => c.id === chapterId);
      if (idx >= 0) {
        chapters.value[idx] = { ...chapters.value[idx]!, proseDocumentId: doc.id, version: ch.version + 1 };
      }
      activeProseDocId.value = doc.id;
      activeProseText.value = '';
      proseSync.value = 'saved';
      return '';
    } catch (e: any) {
      error.value = e?.response?.data?.error ?? e?.message ?? '正文加载失败';
      proseSync.value = 'error';
      throw e;
    } finally {
      acting.value = false;
    }
  }

  /** 保存正文（全量替换语义）。防抖由调用方（编辑器）负责。 */
  async function saveProse(projectId: string, text: string): Promise<void> {
    if (!activeProseDocId.value) return;
    proseSync.value = 'syncing';
    try {
      await ingestProseText(projectId, activeProseDocId.value, text);
      activeProseText.value = text;
      proseSync.value = 'saved';
    } catch (e: any) {
      error.value = e?.response?.data?.error ?? e?.message ?? '正文保存失败';
      proseSync.value = 'error';
      throw e;
    }
  }

  function clear() {
    chapters.value = [];
    selectedId.value = null;
    error.value = '';
    activeProseText.value = '';
    activeProseDocId.value = null;
    proseSync.value = 'saved';
  }

  return {
    chapters, selectedId, loading, error, acting,
    activeProseText, activeProseDocId, proseSync,
    selected, loadChapters, select, create, rename, transition, reorder,
    getOrCreateProse, saveProse, clear,
  };
});

// Timeline store——时间线只读视图 + 模式切换 + 来源层过滤（迭代 C2）
import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { getTimeline, type TimelineView, type TimelineViewMode, type TimelineItemSourceLayer } from '../api/timelines';

export const useTimelineStore = defineStore('timeline', () => {
  const view = ref<TimelineView | null>(null);
  const loading = ref(false);
  const error = ref('');
  /** 时间线模式：world=世界时间顺序，narrative=叙述顺序 */
  const mode = ref<TimelineViewMode>('world');
  /** 被隐藏的来源层（默认全显） */
  const hiddenLayers = ref<Set<TimelineItemSourceLayer>>(new Set());

  function toggleLayer(layer: TimelineItemSourceLayer) {
    const s = new Set(hiddenLayers.value);
    if (s.has(layer)) s.delete(layer); else s.add(layer);
    hiddenLayers.value = s;
  }

  /** 过滤后的条目（按隐藏层） */
  const filteredItems = computed(() => {
    if (!view.value) return [];
    return view.value.items.filter((i) => !hiddenLayers.value.has(i.sourceLayer));
  });

  /** 按章节分组的条目（时间轴主区展示用） */
  const groupedByChapter = computed(() => {
    const groups = new Map<number, typeof filteredItems.value>();
    for (const item of filteredItems.value) {
      const ch = item.worldTime?.chapter ?? 0;
      if (!groups.has(ch)) groups.set(ch, []);
      groups.get(ch)!.push(item);
    }
    return Array.from(groups.entries()).sort((a, b) => a[0] - b[0]);
  });

  async function loadTimeline(projectId: string) {
    loading.value = true; error.value = '';
    try {
      view.value = await getTimeline(projectId, { mode: mode.value });
    } catch (e: any) {
      error.value = e?.response?.data?.error ?? e?.message ?? '加载失败';
    } finally {
      loading.value = false;
    }
  }

  async function switchMode(projectId: string, m: TimelineViewMode) {
    mode.value = m;
    await loadTimeline(projectId);
  }

  function clear() { view.value = null; error.value = ''; hiddenLayers.value = new Set(); }

  return { view, loading, error, mode, hiddenLayers, filteredItems, groupedByChapter, loadTimeline, switchMode, toggleLayer, clear };
});

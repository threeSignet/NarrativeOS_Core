// /api/timeline HTTP 封装——时间线只读视图（迭代 C2）
import axios from 'axios';

const http = axios.create({ baseURL: '/api' });

export type TimelineViewMode = 'world' | 'narrative' | 'character' | 'thread';

export type TimelineItemSourceLayer =
  | 'committed' | 'planned' | 'draft' | 'candidate' | 'retcon_preview';

export interface TimelineItemView {
  id: string;
  label: string;
  sourceLayer: TimelineItemSourceLayer;
  worldTime?: { chapter: number; order?: number };
  narrativeOrder?: number;
  statusLabel: string;
  involvedEntityIds?: string[];
}

export interface TimelineView {
  id: string;
  projectId: string;
  mode: TimelineViewMode;
  items: TimelineItemView[];
  filters: Record<string, unknown>;
}

/** 来源层 → 中文标签 */
export const TIMELINE_LAYER_LABELS: Record<TimelineItemSourceLayer, string> = {
  committed: '已提交',
  planned: '计划',
  draft: '草案',
  candidate: '候选',
  retcon_preview: '追溯预览',
};

/** 来源层 → 颜色（时间轴圆点用，对齐图谱层色） */
export const TIMELINE_LAYER_COLORS: Record<TimelineItemSourceLayer, string> = {
  committed: 'var(--st-committed)',
  planned: 'var(--st-draft)',
  draft: 'var(--st-candidate)',
  candidate: 'var(--st-hint)',
  retcon_preview: 'var(--st-association)',
};

export async function getTimeline(
  projectId: string,
  opts?: { mode?: TimelineViewMode; sourceLayers?: TimelineItemSourceLayer[]; fromChapter?: number; toChapter?: number },
): Promise<TimelineView> {
  const params: Record<string, string> = {};
  if (opts?.mode) params.mode = opts.mode;
  if (opts?.sourceLayers?.length) params.sourceLayers = opts.sourceLayers.join(',');
  if (opts?.fromChapter !== undefined) params.fromChapter = String(opts.fromChapter);
  if (opts?.toChapter !== undefined) params.toChapter = String(opts.toChapter);
  const { data } = await http.get<TimelineView>(`/projects/${projectId}/timeline`, { params });
  return data;
}

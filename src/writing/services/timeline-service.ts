// =============================================================================
// Phase 10 · TimelineService——时间线视图投影
// =============================================================================
// 职责：
//   - 合并 Core 已提交事件 + 写作层章节/场景计划 + 草案
//   - 双轨时间线：世界时间 vs 叙述顺序
//   - 来源区分：committed/planned/draft/candidate
//
// 核心边界（Feature-Spec §15）：
//   - 世界时间不等于章节顺序
//   - 计划时间线不等于 Core EventLog
//   - 已提交事件时间来自 Core
//   - 时间线视图不改变世界状态
// =============================================================================

import type { SQLiteWritingStore } from '../repositories/writing-store.js';
import type { WritingRequestContext } from './context.js';
import type {
  TimelineView, TimelineItemView, TimelineFilter,
  TimelineViewMode, TimelineItemSourceLayer,
} from '../models/types.js';

export class TimelineService {
  constructor(private store: SQLiteWritingStore) {}

  /**
   * 构建时间线视图——合并 Core 事件 + 写作层计划/草案
   *
   * @param mode 时间线模式：world=世界时间顺序，narrative=叙述顺序
   * @param filters 过滤器
   */
  buildTimelineView(
    ctx: WritingRequestContext,
    mode: TimelineViewMode = 'world',
    filters?: TimelineFilter,
  ): TimelineView {
    const items: TimelineItemView[] = [];

    // 1. Core 已提交事件（直接读 events 表，对齐 GraphService 读 facts 表模式）
    const committedEvents = this.getCommittedEvents(ctx.projectId);
    for (const e of committedEvents) {
      if (this.isFilteredByEntity(e.involvedEntityIds, filters)) continue;
      items.push({
        id: e.id,
        label: e.description,
        sourceRef: { objectType: 'entity', objectId: e.id },
        sourceLayer: 'committed',
        worldTime: { chapter: e.chapter },
        narrativeOrder: e.narrativeOrder,
        statusLabel: '已提交',
        involvedEntityIds: e.involvedEntityIds,
      });
    }

    // 2. 章节规划（planned 状态）
    const chapters = this.store.listChapterPlans(ctx.projectId);
    for (const ch of chapters) {
      if (ch.status === 'planned' || ch.status === 'drafting') {
        items.push({
          id: ch.id,
          label: ch.title,
          sourceRef: { objectType: 'chapter', objectId: ch.id },
          sourceLayer: 'planned',
          worldTime: { chapter: ch.order },
          narrativeOrder: ch.order,
          statusLabel: `计划:${ch.title}`,
        });
      }
    }

    // 3. 场景规划（planned/drafting 状态）
    const scenes = this.store.listScenePlans(ctx.projectId);
    for (const sc of scenes) {
      if (sc.status === 'planned' || sc.status === 'drafting') {
        const chapter = chapters.find(c => c.id === sc.chapterId);
        items.push({
          id: sc.id,
          label: sc.title,
          sourceRef: { objectType: 'entity', objectId: sc.id },
          sourceLayer: 'planned',
          worldTime: { chapter: chapter?.order ?? 0, order: sc.order },
          narrativeOrder: (chapter?.order ?? 0) * 1000 + sc.order,
          statusLabel: `场景:${sc.title}`,
          involvedEntityIds: sc.participants,
        });
      }
    }

    // 4. 按 mode 排序
    if (mode === 'world' || mode === 'narrative') {
      items.sort((a, b) => {
        const aKey = (a.worldTime?.chapter ?? 0) * 1000 + (a.worldTime?.order ?? 0);
        const bKey = (b.worldTime?.chapter ?? 0) * 1000 + (b.worldTime?.order ?? 0);
        return aKey - bKey;
      });
    }

    // 5. 应用过滤
    let filteredItems = items;
    if (filters?.sourceLayers) {
      const layerSet = new Set(filters.sourceLayers);
      filteredItems = filteredItems.filter(i => layerSet.has(i.sourceLayer));
    }
    if (filters?.chapterRange) {
      filteredItems = filteredItems.filter(i => {
        const ch = i.worldTime?.chapter ?? 0;
        return ch >= filters.chapterRange!.from && ch <= filters.chapterRange!.to;
      });
    }

    return {
      id: `timeline_${ctx.projectId}_${mode}_${Date.now()}`,
      projectId: ctx.projectId,
      mode,
      items: filteredItems,
      filters: filters ?? {},
    };
  }

  /**
   * 从 Core events 表读取已提交事件
   * 与 GraphService 读 facts 表同模式：直接查 SQLite，不经过 Core 接口
   */
  private getCommittedEvents(projectId: string): Array<{
    id: string; description: string; chapter: number;
    narrativeOrder: number; involvedEntityIds: string[];
  }> {
    try {
      const db = this.store.getDatabase();
      const rows = db.prepare(
        `SELECT id, description, chapter, params_json FROM events
         WHERE kind = 'business' ORDER BY chapter ASC, id ASC`
      ).all() as Array<{ id: string; description: string; chapter: number; params_json: string }>;

      return rows.map(r => {
        let involvedEntityIds: string[] = [];
        try {
          const params = JSON.parse(r.params_json) as Record<string, unknown>;
          if (typeof params['subject'] === 'string') involvedEntityIds.push(params['subject'] as string);
        } catch { /* params 解析失败不阻断 */ }

        return {
          id: r.id,
          description: r.description,
          chapter: r.chapter,
          narrativeOrder: r.chapter,
          involvedEntityIds,
        };
      });
    } catch {
      return [];
    }
  }

  /** 检查实体过滤 */
  private isFilteredByEntity(entityIds: string[], filters?: TimelineFilter): boolean {
    if (!filters?.entityIds || filters.entityIds.length === 0) return false;
    return !entityIds.some(id => filters.entityIds!.includes(id));
  }
}

// =============================================================================
// Phase 10 测试：TimelineService
// =============================================================================

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { SQLiteWritingStore } from '../../src/writing/repositories/writing-store.js';
import { AuditService } from '../../src/writing/services/audit-service.js';
import { ChapterService } from '../../src/writing/services/chapter-service.js';
import { SceneService } from '../../src/writing/services/scene-service.js';
import { TimelineService } from '../../src/writing/services/timeline-service.js';
import { SQLiteFactStoreAdapter } from '../../src/adapters/sqlite/fact-store.js';
import { makeRequestContext } from '../../src/writing/services/context.js';
import type { WritingRequestContext } from '../../src/writing/services/context.js';

describe('Phase 10 · TimelineService', () => {
  let store: SQLiteWritingStore;
  let chapterService: ChapterService;
  let sceneService: SceneService;
  let timelineService: TimelineService;
  let ctx: WritingRequestContext;
  let projectId: string;
  let db: Database.Database;

  beforeEach(() => {
    const factStore = new SQLiteFactStoreAdapter(':memory:', 'default');
    db = factStore.getDatabase();
    store = new SQLiteWritingStore(db);
    store.createTables();
    const auditService = new AuditService(store);
    chapterService = new ChapterService(store, auditService);
    sceneService = new SceneService(store, auditService);
    timelineService = new TimelineService(store);
    projectId = store.createProject('时间线测试').id;
    ctx = makeRequestContext({ projectId, trigger: 'author_action' });
  });

  it('空项目返回空时间线', () => {
    const timeline = timelineService.buildTimelineView(ctx);
    expect(timeline.items).toHaveLength(0);
    expect(timeline.mode).toBe('world');
  });

  it('Core 已提交事件出现在时间线', () => {
    // 插入 Core events 表数据
    db.prepare(`INSERT INTO events (id, kind, type, chapter, description, params_json, fact_group_id)
      VALUES (?, 'business', 'test', 1, '测试事件', '{}', 'fg1')`).run('evt_1');

    const timeline = timelineService.buildTimelineView(ctx);
    expect(timeline.items).toHaveLength(1);
    expect(timeline.items[0]!.sourceLayer).toBe('committed');
    expect(timeline.items[0]!.label).toBe('测试事件');
    expect(timeline.items[0]!.worldTime?.chapter).toBe(1);
  });

  it('章节规划出现在时间线', () => {
    chapterService.createChapter(ctx, { order: 1, title: '第一章' });
    chapterService.createChapter(ctx, { order: 2, title: '第二章' });

    const timeline = timelineService.buildTimelineView(ctx);
    const plannedItems = timeline.items.filter(i => i.sourceLayer === 'planned');
    expect(plannedItems).toHaveLength(2);
    expect(plannedItems[0]!.label).toBe('第一章');
    expect(plannedItems[1]!.label).toBe('第二章');
  });

  it('场景规划出现在时间线', () => {
    const ch = chapterService.createChapter(ctx, { order: 1, title: 'Ch1' });
    sceneService.createScene(ctx, { chapterId: ch.id, order: 1, title: '开场' });
    sceneService.createScene(ctx, { chapterId: ch.id, order: 2, title: '冲突' });

    const timeline = timelineService.buildTimelineView(ctx);
    const plannedItems = timeline.items.filter(i => i.sourceLayer === 'planned');
    expect(plannedItems.length).toBeGreaterThanOrEqual(2);
  });

  it('过滤器按 sourceLayer 过滤', () => {
    db.prepare(`INSERT INTO events (id, kind, type, chapter, description, params_json, fact_group_id)
      VALUES (?, 'business', 'test', 1, '事件', '{}', 'fg1')`).run('evt_f');
    chapterService.createChapter(ctx, { order: 1, title: 'Ch1' });

    const all = timelineService.buildTimelineView(ctx);
    expect(all.items.length).toBeGreaterThanOrEqual(2);

    const committedOnly = timelineService.buildTimelineView(ctx, 'world', { sourceLayers: ['committed'] });
    expect(committedOnly.items.every(i => i.sourceLayer === 'committed')).toBe(true);
  });

  it('过滤器按 chapterRange 过滤', () => {
    db.prepare(`INSERT INTO events (id, kind, type, chapter, description, params_json, fact_group_id)
      VALUES (?, 'business', 'test', 5, 'Ch5事件', '{}', 'fg1')`).run('evt_r');
    db.prepare(`INSERT INTO events (id, kind, type, chapter, description, params_json, fact_group_id)
      VALUES (?, 'business', 'test', 10, 'Ch10事件', '{}', 'fg1')`).run('evt_r2');

    const filtered = timelineService.buildTimelineView(ctx, 'world', { chapterRange: { from: 1, to: 6 } });
    expect(filtered.items.every(i => (i.worldTime?.chapter ?? 0) <= 6)).toBe(true);
  });
});

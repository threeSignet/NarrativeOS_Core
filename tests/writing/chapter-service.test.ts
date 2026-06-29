// =============================================================================
// Phase 10 测试：ChapterService + SceneService
// =============================================================================

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { SQLiteWritingStore } from '../../src/writing/repositories/writing-store.js';
import { AuditService } from '../../src/writing/services/audit-service.js';
import { ChapterService } from '../../src/writing/services/chapter-service.js';
import { SceneService } from '../../src/writing/services/scene-service.js';
import { makeRequestContext } from '../../src/writing/services/context.js';
import type { WritingRequestContext } from '../../src/writing/services/context.js';

describe('Phase 10 · ChapterService', () => {
  let store: SQLiteWritingStore;
  let chapterService: ChapterService;
  let sceneService: SceneService;
  let ctx: WritingRequestContext;
  let projectId: string;

  beforeEach(() => {
    const db = new Database(':memory:');
    store = new SQLiteWritingStore(db);
    store.createTables();
    const auditService = new AuditService(store);
    chapterService = new ChapterService(store, auditService);
    sceneService = new SceneService(store, auditService);
    projectId = store.createProject('章节测试').id;
    ctx = makeRequestContext({ projectId, trigger: 'author_action' });
  });

  it('创建章节规划', () => {
    const ch = chapterService.createChapter(ctx, { order: 1, title: '第一章' });
    expect(ch.id).toMatch(/^wcplan_/);
    expect(ch.title).toBe('第一章');
    expect(ch.order).toBe(1);
    expect(ch.status).toBe('planned');
  });

  it('更新章节规划（乐观锁）', () => {
    const ch = chapterService.createChapter(ctx, { order: 1, title: 'A' });
    chapterService.updateChapter(ctx, ch.id, ch.version, { title: 'A改' });
    const updated = store.getChapterPlan(ch.id)!;
    expect(updated.title).toBe('A改');
    expect(updated.version).toBe(2);
  });

  it('推进章节状态', () => {
    const ch = chapterService.createChapter(ctx, { order: 1, title: 'A' });
    chapterService.transitionChapterStatus(ctx, ch.id, 'drafting');
    expect(store.getChapterPlan(ch.id)!.status).toBe('drafting');
    chapterService.transitionChapterStatus(ctx, ch.id, 'written');
    expect(store.getChapterPlan(ch.id)!.status).toBe('written');
  });

  it('非法状态转换抛错', () => {
    const ch = chapterService.createChapter(ctx, { order: 1, title: 'A' });
    expect(() => chapterService.transitionChapterStatus(ctx, ch.id, 'done')).toThrow();
  });

  it('重排章节顺序', () => {
    const ch1 = chapterService.createChapter(ctx, { order: 1, title: 'A' });
    const ch2 = chapterService.createChapter(ctx, { order: 2, title: 'B' });
    chapterService.reorderChapters(ctx, [ch2.id, ch1.id]);
    const list = store.listChapterPlans(projectId);
    expect(list[0]!.title).toBe('B');
    expect(list[1]!.title).toBe('A');
  });
});

describe('Phase 10 · SceneService', () => {
  let store: SQLiteWritingStore;
  let chapterService: ChapterService;
  let sceneService: SceneService;
  let ctx: WritingRequestContext;
  let projectId: string;

  beforeEach(() => {
    const db = new Database(':memory:');
    store = new SQLiteWritingStore(db);
    store.createTables();
    const auditService = new AuditService(store);
    chapterService = new ChapterService(store, auditService);
    sceneService = new SceneService(store, auditService);
    projectId = store.createProject('场景测试').id;
    ctx = makeRequestContext({ projectId, trigger: 'author_action' });
  });

  function createChapter() {
    return chapterService.createChapter(ctx, { order: 1, title: '第一章' });
  }

  it('创建场景规划', () => {
    const ch = createChapter();
    const sc = sceneService.createScene(ctx, {
      chapterId: ch.id, order: 1, title: '开场',
      purpose: ['setup'], participants: ['ent_a'],
    });
    expect(sc.id).toMatch(/^wsplan_/);
    expect(sc.title).toBe('开场');
    expect(sc.chapterId).toBe(ch.id);
    expect(sc.status).toBe('planned');
    expect(sc.purpose).toEqual(['setup']);
    expect(sc.participants).toEqual(['ent_a']);
  });

  it('创建场景自动关联到章节', () => {
    const ch = createChapter();
    sceneService.createScene(ctx, { chapterId: ch.id, order: 1, title: 'S1' });
    sceneService.createScene(ctx, { chapterId: ch.id, order: 2, title: 'S2' });
    const updated = store.getChapterPlan(ch.id)!;
    expect(updated.linkedSceneIds).toHaveLength(2);
  });

  it('章节不存在抛错', () => {
    expect(() => sceneService.createScene(ctx, {
      chapterId: 'nonexistent', order: 1, title: 'X',
    })).toThrow();
  });

  it('更新场景规划', () => {
    const ch = createChapter();
    const sc = sceneService.createScene(ctx, { chapterId: ch.id, order: 1, title: 'A' });
    sceneService.updateScene(ctx, sc.id, sc.version, { title: 'A改', spatialNodeId: 'wsnode_test' });
    const updated = store.getScenePlan(sc.id)!;
    expect(updated.title).toBe('A改');
    expect(updated.spatialNodeId).toBe('wsnode_test');
  });

  it('推进场景状态', () => {
    const ch = createChapter();
    const sc = sceneService.createScene(ctx, { chapterId: ch.id, order: 1, title: 'A' });
    sceneService.transitionSceneStatus(ctx, sc.id, 'drafting');
    expect(store.getScenePlan(sc.id)!.status).toBe('drafting');
    sceneService.transitionSceneStatus(ctx, sc.id, 'written');
    expect(store.getScenePlan(sc.id)!.status).toBe('written');
    sceneService.transitionSceneStatus(ctx, sc.id, 'reviewing');
    expect(store.getScenePlan(sc.id)!.status).toBe('reviewing');
    sceneService.transitionSceneStatus(ctx, sc.id, 'done');
    expect(store.getScenePlan(sc.id)!.status).toBe('done');
  });

  it('非法场景状态转换抛错', () => {
    const ch = createChapter();
    const sc = sceneService.createScene(ctx, { chapterId: ch.id, order: 1, title: 'A' });
    expect(() => sceneService.transitionSceneStatus(ctx, sc.id, 'done')).toThrow();
  });

  it('按章节过滤场景', () => {
    const ch1 = chapterService.createChapter(ctx, { order: 1, title: 'Ch1' });
    const ch2 = chapterService.createChapter(ctx, { order: 2, title: 'Ch2' });
    sceneService.createScene(ctx, { chapterId: ch1.id, order: 1, title: 'S1' });
    sceneService.createScene(ctx, { chapterId: ch2.id, order: 1, title: 'S2' });
    const ch1Scenes = store.listScenePlans(projectId, { chapterId: ch1.id });
    expect(ch1Scenes).toHaveLength(1);
    expect(ch1Scenes[0]!.title).toBe('S1');
  });
});

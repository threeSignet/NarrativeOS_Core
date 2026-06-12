// =============================================================================
// SQLiteThreadStoreAdapter 集成测试
// =============================================================================
// Phase 2A 最小版：create / getById / updateStatus / addMilestone / getOpen / getByFilters
// 包含 cst_ 兼容性测试和 I-9 边界测试

import { describe, it, expect, beforeEach } from 'vitest';
import { SQLiteFactStoreAdapter } from '../../src/adapters/sqlite/fact-store.js';
import { SQLiteThreadStoreAdapter } from '../../src/adapters/sqlite/thread-store.js';
import type { ThreadMilestone, NarrativeThread } from '../../src/types.js';

// ---------------------------------------------------------------------------
// 测试夹具
// ---------------------------------------------------------------------------

/**
 * 创建基础测试环境：注册实体和事件以满足 threads 表的外键约束
 */
function setupFixtures(factStore: SQLiteFactStoreAdapter): void {
  const db = factStore.getDatabase();
  db.exec("INSERT OR IGNORE INTO entities (id, name, kind, first_appearance) VALUES ('ent_claine', '克莱恩', 'entity', 1)");
  db.exec("INSERT OR IGNORE INTO entities (id, name, kind, first_appearance) VALUES ('ent_dunn', '邓恩', 'entity', 1)");
  db.exec("INSERT OR IGNORE INTO entities (id, name, kind, first_appearance) VALUES ('ent_melanie', '梅兰妮', 'entity', 1)");
  db.exec("INSERT OR IGNORE INTO events (id, kind, type, chapter, description, params_json, fact_group_id) VALUES ('evt_ch10', 'business', 'discovery', 10, '发现线索', '{}', 'evt_ch10')");
  db.exec("INSERT OR IGNORE INTO events (id, kind, type, chapter, description, params_json, fact_group_id) VALUES ('evt_ch50', 'business', 'revelation', 50, '真相揭示', '{}', 'evt_ch50')");
  db.exec("INSERT OR IGNORE INTO events (id, kind, type, chapter, description, params_json, fact_group_id) VALUES ('evt_ch100', 'business', 'finale', 100, '最终决战', '{}', 'evt_ch100')");
}

/**
 * 创建一个标准的渐进型伏笔 thread
 */
function createProgressiveThread(overrides: Partial<NarrativeThread> = {}): Omit<NarrativeThread, 'id'> {
  return {
    type: 'foreshadowing',
    direction: 'progressive',
    severity: 'major',
    description: '克莱恩的真实身份伏笔',
    closeCondition: {
      requiredEventType: 'revelation',
      withinChapters: 100,
      minHints: 3,
    },
    status: 'PLANTED',
    closedBy: null,
    createdAtEvent: 'evt_ch10',
    createdAtChapter: 10,
    milestones: [],
    relatedEntities: ['ent_claine', 'ent_dunn'],
    upstreamFactIds: [],
    tags: ['main_arc', 'identity'],
    arcTag: 'arc_main',
    ...overrides,
  };
}

describe('SQLiteThreadStoreAdapter', () => {
  let factStore: SQLiteFactStoreAdapter;
  let threadStore: SQLiteThreadStoreAdapter;

  beforeEach(() => {
    factStore = new SQLiteFactStoreAdapter(':memory:', 'test_thread');
    setupFixtures(factStore);
    threadStore = new SQLiteThreadStoreAdapter(factStore.getDatabase());
  });

  // -------------------------------------------------------------------
  // create
  // -------------------------------------------------------------------

  describe('create', () => {
    it('应创建 Thread 并自动生成 thr_ 前缀 ID', () => {
      const t = threadStore.create(createProgressiveThread());
      expect(t.id).toMatch(/^thr_/);
      expect(t.type).toBe('foreshadowing');
      expect(t.direction).toBe('progressive');
      expect(t.severity).toBe('major');
      expect(t.status).toBe('PLANTED');
      expect(t.closedBy).toBeNull();
    });

    it('ID 应优先使用 tags[0] 作为片段', () => {
      const t = threadStore.create(createProgressiveThread({ tags: ['main_arc'] }));
      // tags[0] = 'main_arc' → 清洗后 main_arc
      expect(t.id).toMatch(/^thr_main_arc_10$/);
    });

    it('无 tags 时应使用 type 作为 ID 片段', () => {
      const t = threadStore.create(createProgressiveThread({ tags: undefined }));
      expect(t.id).toMatch(/^thr_foreshadowing_10$/);
    });

    it('同一 base ID 已存在时应追加序号', () => {
      const t1 = threadStore.create(createProgressiveThread());
      const t2 = threadStore.create(createProgressiveThread());
      expect(t1.id).not.toBe(t2.id);
      expect(t2.id).toMatch(/_\d{2}$/);
    });

    it('应正确序列化并返回所有 JSON 字段', () => {
      const t = threadStore.create(createProgressiveThread());

      // closeCondition
      expect(t.closeCondition).toEqual({
        requiredEventType: 'revelation',
        withinChapters: 100,
        minHints: 3,
      });

      // relatedEntities
      expect(t.relatedEntities).toEqual(['ent_claine', 'ent_dunn']);

      // upstreamFactIds
      expect(t.upstreamFactIds).toEqual([]);

      // milestones
      expect(t.milestones).toEqual([]);

      // tags
      expect(t.tags).toEqual(['main_arc', 'identity']);

      // arcTag
      expect(t.arcTag).toBe('arc_main');
    });

    it('应支持回溯型线索', () => {
      const t = threadStore.create(createProgressiveThread({
        type: 'causal_gap',
        direction: 'retroactive',
        severity: 'critical',
        status: 'UNFILLED',
      }));
      expect(t.type).toBe('causal_gap');
      expect(t.direction).toBe('retroactive');
      expect(t.status).toBe('UNFILLED');
    });
  });

  // -------------------------------------------------------------------
  // create + getById 往返
  // -------------------------------------------------------------------

  describe('create + getById 往返', () => {
    it('创建后应能通过 getById 完整取回', () => {
      const created = threadStore.create(createProgressiveThread());
      const fetched = threadStore.getById(created.id);

      expect(fetched).toBeDefined();
      expect(fetched!.id).toBe(created.id);
      expect(fetched!.type).toBe(created.type);
      expect(fetched!.direction).toBe(created.direction);
      expect(fetched!.severity).toBe(created.severity);
      expect(fetched!.description).toBe(created.description);
      expect(fetched!.closeCondition).toEqual(created.closeCondition);
      expect(fetched!.status).toBe(created.status);
      expect(fetched!.closedBy).toBe(created.closedBy);
      expect(fetched!.createdAtEvent).toBe(created.createdAtEvent);
      expect(fetched!.createdAtChapter).toBe(created.createdAtChapter);
      expect(fetched!.milestones).toEqual(created.milestones);
      expect(fetched!.relatedEntities).toEqual(created.relatedEntities);
      expect(fetched!.upstreamFactIds).toEqual(created.upstreamFactIds);
      expect(fetched!.tags).toEqual(created.tags);
      expect(fetched!.arcTag).toBe(created.arcTag);
    });

    it('不存在的 ID 应返回 undefined', () => {
      expect(threadStore.getById('thr_nonexistent_99')).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------
  // cst_ 兼容查询
  // -------------------------------------------------------------------

  describe('cst_ 兼容查询', () => {
    it('getById 传入 cst_ 前缀时应按 thr_ 查询', () => {
      const created = threadStore.create(createProgressiveThread({ tags: ['mystery'] }));
      // 实际 ID 为 thr_mystery_10
      const cstId = 'cst_mystery_10';

      const fetched = threadStore.getById(cstId);
      expect(fetched).toBeDefined();
      expect(fetched!.id).toBe(created.id);
    });

    it('updateStatus 传入 cst_ 前缀时应正常更新', () => {
      threadStore.create(createProgressiveThread({ tags: ['mystery'] }));
      const cstId = 'cst_mystery_10';

      threadStore.updateStatus(cstId, 'HINTED');
      const fetched = threadStore.getById(cstId);
      expect(fetched!.status).toBe('HINTED');
    });

    it('addMilestone 传入 cst_ 前缀时应正常追加', () => {
      threadStore.create(createProgressiveThread({ tags: ['mystery'] }));
      const cstId = 'cst_mystery_10';

      threadStore.addMilestone(cstId, {
        status: 'HINTED',
        chapter: 30,
        description: '再次暗示',
        createdAt: new Date().toISOString(),
      });

      const fetched = threadStore.getById(cstId);
      expect(fetched!.milestones.length).toBe(1);
    });
  });

  // -------------------------------------------------------------------
  // updateStatus
  // -------------------------------------------------------------------

  describe('updateStatus', () => {
    it('应更新 Thread 状态', () => {
      const created = threadStore.create(createProgressiveThread());
      threadStore.updateStatus(created.id, 'HINTED');

      const fetched = threadStore.getById(created.id);
      expect(fetched!.status).toBe('HINTED');
    });

    it('传入 closedBy 时应更新 closed_by', () => {
      const created = threadStore.create(createProgressiveThread());
      threadStore.updateStatus(created.id, 'RESOLVED', 'evt_ch100');

      const fetched = threadStore.getById(created.id);
      expect(fetched!.status).toBe('RESOLVED');
      expect(fetched!.closedBy).toBe('evt_ch100');
    });

    it('未传入 closedBy 时应保留已有 closed_by', () => {
      const created = threadStore.create(createProgressiveThread());
      // 先设置 closed_by
      threadStore.updateStatus(created.id, 'RESOLVED', 'evt_ch100');
      // 再次更新但不传 closedBy
      threadStore.updateStatus(created.id, 'ABANDONED');

      const fetched = threadStore.getById(created.id);
      expect(fetched!.status).toBe('ABANDONED');
      expect(fetched!.closedBy).toBe('evt_ch100');
    });

    it('找不到记录时应抛出可读错误', () => {
      expect(() => threadStore.updateStatus('thr_nonexistent_99', 'HINTED')).toThrow(/THREAD_NOT_FOUND/);
    });
  });

  // -------------------------------------------------------------------
  // addMilestone
  // -------------------------------------------------------------------

  describe('addMilestone', () => {
    it('应追加里程碑到空数组', () => {
      const created = threadStore.create(createProgressiveThread());

      threadStore.addMilestone(created.id, {
        status: 'HINTED',
        chapter: 30,
        description: '再次暗示',
        createdAt: new Date().toISOString(),
      });

      const fetched = threadStore.getById(created.id);
      expect(fetched!.milestones.length).toBe(1);
      expect(fetched!.milestones[0]!.status).toBe('HINTED');
      expect(fetched!.milestones[0]!.id).toMatch(/^ms_/);
    });

    it('应追加多个里程碑（有序）', () => {
      const created = threadStore.create(createProgressiveThread());

      threadStore.addMilestone(created.id, {
        status: 'HINTED', chapter: 20, description: '第一次暗示',
        createdAt: new Date().toISOString(),
      });
      threadStore.addMilestone(created.id, {
        status: 'HINTED', chapter: 30, description: '第二次暗示',
        createdAt: new Date().toISOString(),
      });

      const fetched = threadStore.getById(created.id);
      expect(fetched!.milestones.length).toBe(2);
      expect(fetched!.milestones[0]!.description).toBe('第一次暗示');
      expect(fetched!.milestones[1]!.description).toBe('第二次暗示');
    });

    it('应将 Thread 的 status 更新为里程碑的 status', () => {
      const created = threadStore.create(createProgressiveThread());
      expect(created.status).toBe('PLANTED');

      threadStore.addMilestone(created.id, {
        status: 'PARTIALLY_REVEALED', chapter: 40, description: '部分揭示',
        createdAt: new Date().toISOString(),
      });

      const fetched = threadStore.getById(created.id);
      expect(fetched!.status).toBe('PARTIALLY_REVEALED');
    });

    it('HINTED 里程碑应递增 hint_count', () => {
      const created = threadStore.create(createProgressiveThread());

      threadStore.addMilestone(created.id, {
        status: 'HINTED', chapter: 20, description: '第一次暗示',
        createdAt: new Date().toISOString(),
      });
      threadStore.addMilestone(created.id, {
        status: 'HINTED', chapter: 30, description: '第二次暗示',
        createdAt: new Date().toISOString(),
      });

      const fetched = threadStore.getById(created.id);
      const db = factStore.getDatabase();
      const row = db.prepare('SELECT hint_count FROM threads WHERE id = ?').get(created.id) as { hint_count: number };
      expect(row.hint_count).toBe(2);
    });

    it('RESOLVED 里程碑带 eventId 时应设置 closed_by', () => {
      const created = threadStore.create(createProgressiveThread());

      threadStore.addMilestone(created.id, {
        status: 'RESOLVED', chapter: 50, eventId: 'evt_ch50',
        description: '真相揭示', createdAt: new Date().toISOString(),
      });

      const fetched = threadStore.getById(created.id);
      expect(fetched!.status).toBe('RESOLVED');
      expect(fetched!.closedBy).toBe('evt_ch50');
    });

    it('FILLED 里程碑带 eventId 时应设置 closed_by', () => {
      const created = threadStore.create(createProgressiveThread({
        type: 'causal_gap', direction: 'retroactive', status: 'UNFILLED',
      }));

      threadStore.addMilestone(created.id, {
        status: 'FILLED', chapter: 50, eventId: 'evt_ch50',
        description: '原因补完', createdAt: new Date().toISOString(),
      });

      const fetched = threadStore.getById(created.id);
      expect(fetched!.status).toBe('FILLED');
      expect(fetched!.closedBy).toBe('evt_ch50');
    });

    it('找不到记录时应抛出可读错误', () => {
      expect(() => threadStore.addMilestone('thr_nonexistent_99', {
        status: 'HINTED', chapter: 1, description: 'test',
        createdAt: new Date().toISOString(),
      })).toThrow(/THREAD_NOT_FOUND/);
    });
  });

  // -------------------------------------------------------------------
  // getOpen
  // -------------------------------------------------------------------

  describe('getOpen', () => {
    it('应返回所有开放状态的 Thread', () => {
      threadStore.create(createProgressiveThread({ status: 'UNFILLED', tags: ['a'] }));
      threadStore.create(createProgressiveThread({ status: 'PLANTED', tags: ['b'] }));
      threadStore.create(createProgressiveThread({ status: 'HINTED', tags: ['c'] }));
      threadStore.create(createProgressiveThread({ status: 'PARTIALLY_REVEALED', tags: ['d'] }));

      const open = threadStore.getOpen();
      expect(open.length).toBe(4);
    });

    it('应排除所有终态 Thread', () => {
      threadStore.create(createProgressiveThread({ status: 'UNFILLED', tags: ['a'] }));
      threadStore.create(createProgressiveThread({ status: 'FILLED', tags: ['b'] }));
      threadStore.create(createProgressiveThread({ status: 'RESOLVED', tags: ['c'] }));
      threadStore.create(createProgressiveThread({ status: 'ABANDONED', tags: ['d'] }));
      threadStore.create(createProgressiveThread({ status: 'OBSOLETE', tags: ['e'] }));

      const open = threadStore.getOpen();
      expect(open.length).toBe(1);
      expect(open[0]!.status).toBe('UNFILLED');
    });

    it('应使用稳定排序（按 created_at_chapter ASC）', () => {
      // 按不同章节创建，需要不同的事件
      const db = factStore.getDatabase();
      db.exec("INSERT OR IGNORE INTO events (id, kind, type, chapter, description, params_json, fact_group_id) VALUES ('evt_ch5', 'business', 'hint', 5, '{}', '{}', 'evt_ch5')");
      db.exec("INSERT OR IGNORE INTO events (id, kind, type, chapter, description, params_json, fact_group_id) VALUES ('evt_ch20', 'business', 'hint', 20, '{}', '{}', 'evt_ch20')");

      threadStore.create(createProgressiveThread({ createdAtChapter: 20, createdAtEvent: 'evt_ch20', tags: ['a'] }));
      threadStore.create(createProgressiveThread({ createdAtChapter: 5, createdAtEvent: 'evt_ch5', tags: ['b'] }));

      const open = threadStore.getOpen();
      expect(open[0]!.createdAtChapter).toBeLessThan(open[1]!.createdAtChapter);
    });
  });

  // -------------------------------------------------------------------
  // getByFilters
  // -------------------------------------------------------------------

  describe('getByFilters', () => {
    beforeEach(() => {
      // 创建多种线索用于过滤测试
      const db = factStore.getDatabase();
      db.exec("INSERT OR IGNORE INTO events (id, kind, type, chapter, description, params_json, fact_group_id) VALUES ('evt_ch5', 'business', 'hint', 5, '{}', '{}', 'evt_ch5')");
      db.exec("INSERT OR IGNORE INTO events (id, kind, type, chapter, description, params_json, fact_group_id) VALUES ('evt_ch20', 'business', 'hint', 20, '{}', '{}', 'evt_ch20')");

      threadStore.create(createProgressiveThread({
        type: 'foreshadowing', direction: 'progressive', severity: 'major',
        createdAtChapter: 10, tags: ['main_arc'], arcTag: 'arc_main',
        relatedEntities: ['ent_claine'],
      }));
      threadStore.create(createProgressiveThread({
        type: 'causal_gap', direction: 'retroactive', severity: 'critical',
        createdAtChapter: 5, createdAtEvent: 'evt_ch5',
        tags: ['side_arc'], arcTag: 'arc_side',
        relatedEntities: ['ent_dunn'],
      }));
      threadStore.create(createProgressiveThread({
        type: 'mystery', direction: 'progressive', severity: 'minor',
        createdAtChapter: 20, createdAtEvent: 'evt_ch20',
        tags: ['humor'], arcTag: undefined,
        relatedEntities: ['ent_claine', 'ent_melanie'],
      }));
    });

    it('按 direction 过滤', () => {
      const retro = threadStore.getByFilters({ direction: 'retroactive' });
      expect(retro.length).toBe(1);
      expect(retro[0]!.type).toBe('causal_gap');
    });

    it('按 type 过滤', () => {
      const foreshadowing = threadStore.getByFilters({ type: ['foreshadowing'] });
      expect(foreshadowing.length).toBe(1);
      expect(foreshadowing[0]!.type).toBe('foreshadowing');
    });

    it('按 severity 过滤', () => {
      const critical = threadStore.getByFilters({ severity: ['critical'] });
      expect(critical.length).toBe(1);
      expect(critical[0]!.severity).toBe('critical');
    });

    it('按 status 过滤', () => {
      const planted = threadStore.getByFilters({ status: ['PLANTED'] });
      expect(planted.length).toBe(3); // 所有都是 PLANTED
    });

    it('按 relatedEntity 过滤', () => {
      const claineThreads = threadStore.getByFilters({ relatedEntity: 'ent_claine' });
      expect(claineThreads.length).toBe(2); // main_arc + humor
    });

    it('relatedEntity 过滤应精确匹配实体 ID，不受 SQL LIKE 通配符影响', () => {
      threadStore.create(createProgressiveThread({
        createdAtChapter: 30,
        tags: ['wildcard_false_positive'],
        relatedEntities: ['entXclaine'],
      }));
      threadStore.create(createProgressiveThread({
        createdAtChapter: 31,
        tags: ['wildcard_exact'],
        relatedEntities: ['ent_claine'],
      }));

      const claineThreads = threadStore.getByFilters({ relatedEntity: 'ent_claine' });
      expect(claineThreads.length).toBe(3);
      expect(claineThreads.every(t => t.relatedEntities.includes('ent_claine'))).toBe(true);
      expect(claineThreads.some(t => t.relatedEntities.includes('entXclaine'))).toBe(false);
    });

    it('按 arcTag 过滤', () => {
      const mainArc = threadStore.getByFilters({ arcTag: 'arc_main' });
      expect(mainArc.length).toBe(1);
      expect(mainArc[0]!.arcTag).toBe('arc_main');
    });

    it('按 excludeArcTags 排除', () => {
      const noSideArc = threadStore.getByFilters({ excludeArcTags: ['arc_side'] });
      // 应排除 arc_side，保留 arc_main 和 arcTag=null 的
      expect(noSideArc.length).toBe(2);
      expect(noSideArc.every(t => t.arcTag !== 'arc_side')).toBe(true);
    });

    it('按 nearChapter + window 过滤', () => {
      // 章节在 [5, 25] 范围内，即 created_at_chapter 在 10 和 20 的
      const near = threadStore.getByFilters({ nearChapter: 15, window: 10 });
      // chapter 10 ∈ [5,25] ✓, chapter 5 ∈ [5,25] ✓, chapter 20 ∈ [5,25] ✓
      expect(near.length).toBe(3);

      // 缩小窗口：[12, 18]，只有 chapter 10 不在范围内
      const narrow = threadStore.getByFilters({ nearChapter: 15, window: 3 });
      expect(narrow.length).toBe(0);

      // 窗口 [0, 20]，所有三个 chapter (5, 10, 20) 都在范围内
      const medium = threadStore.getByFilters({ nearChapter: 10, window: 10 });
      expect(medium.length).toBe(3);
    });

    it('按 closedByEvent 过滤', () => {
      // 先关闭一个线索
      const mainArc = threadStore.getByFilters({ arcTag: 'arc_main' });
      threadStore.updateStatus(mainArc[0]!.id, 'RESOLVED', 'evt_ch50');

      const closedByEvt = threadStore.getByFilters({ closedByEvent: 'evt_ch50' });
      expect(closedByEvt.length).toBe(1);
      expect(closedByEvt[0]!.closedBy).toBe('evt_ch50');
    });

    it('组合过滤', () => {
      const progressiveMajor = threadStore.getByFilters({
        direction: 'progressive',
        severity: ['major'],
      });
      expect(progressiveMajor.length).toBe(1);
      expect(progressiveMajor[0]!.type).toBe('foreshadowing');
    });
  });

  // -------------------------------------------------------------------
  // I-9 边界：ThreadStore 操作不得新增或修改 Fact/Knowledge/Event 行数
  // -------------------------------------------------------------------

  describe('I-9 边界：ThreadStore 不影响其他表', () => {
    it('ThreadStore 操作不应新增 Fact 行', () => {
      const factCountBefore = (factStore.getDatabase().prepare('SELECT COUNT(*) as cnt FROM facts').get() as { cnt: number }).cnt;

      threadStore.create(createProgressiveThread());
      threadStore.addMilestone(threadStore.getByFilters({})[0]!.id, {
        status: 'HINTED', chapter: 20, description: 'test',
        createdAt: new Date().toISOString(),
      });

      const factCountAfter = (factStore.getDatabase().prepare('SELECT COUNT(*) as cnt FROM facts').get() as { cnt: number }).cnt;
      expect(factCountAfter).toBe(factCountBefore);
    });

    it('ThreadStore 操作不应新增 Knowledge 行', () => {
      const knCountBefore = (factStore.getDatabase().prepare('SELECT COUNT(*) as cnt FROM knowledge').get() as { cnt: number }).cnt;

      threadStore.create(createProgressiveThread());
      threadStore.updateStatus(threadStore.getByFilters({})[0]!.id, 'RESOLVED', 'evt_ch50');

      const knCountAfter = (factStore.getDatabase().prepare('SELECT COUNT(*) as cnt FROM knowledge').get() as { cnt: number }).cnt;
      expect(knCountAfter).toBe(knCountBefore);
    });

    it('ThreadStore 操作不应新增 Event 行', () => {
      const evtCountBefore = (factStore.getDatabase().prepare('SELECT COUNT(*) as cnt FROM events').get() as { cnt: number }).cnt;

      threadStore.create(createProgressiveThread());

      const evtCountAfter = (factStore.getDatabase().prepare('SELECT COUNT(*) as cnt FROM events').get() as { cnt: number }).cnt;
      expect(evtCountAfter).toBe(evtCountBefore);
    });
  });
});

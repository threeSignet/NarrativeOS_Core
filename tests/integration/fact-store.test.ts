// =============================================================================
// SQLiteFactStoreAdapter 集成测试
// =============================================================================
// 使用 :memory: SQLite 数据库（测试间完全隔离，测试后无需清理文件）。
// 覆盖 FactStore 接口的全部方法：assert / retract / update / applyFactGroup / query / getSnapshot 等。

import { describe, it, expect, beforeEach } from 'vitest';
import { SQLiteFactStoreAdapter } from '../../src/adapters/sqlite/fact-store.js';
import type { Fact, FactGroup, FactChange, FactValue, EntityRef } from '../../src/types.js';

// ---------------------------------------------------------------------------
// 测试辅助
// ---------------------------------------------------------------------------

function makeEntityRef(entityId: string): EntityRef {
  return { type: 'entity_ref', entityId };
}

function setupEntities(store: SQLiteFactStoreAdapter): void {
  const db = store.getDatabase();
  // 注册测试实体
  const entities = [
    "INSERT OR IGNORE INTO entities (id, name, kind, first_appearance) VALUES ('ent_zhangsan', '张三', 'entity', 1)",
    "INSERT OR IGNORE INTO entities (id, name, kind, first_appearance) VALUES ('ent_lisi', '李四', 'entity', 1)",
    "INSERT OR IGNORE INTO entities (id, name, kind, first_appearance) VALUES ('ent_chenlao', '陈老', 'entity', 1)",
    "INSERT OR IGNORE INTO entities (id, name, kind, first_appearance) VALUES ('ent_zhuxianjian', '诛仙剑', 'entity', 1)",
    "INSERT OR IGNORE INTO entities (id, name, kind, first_appearance) VALUES ('ent_qingyunzong', '青云宗', 'entity', 1)",
    // 注册事件以便外键约束
    "INSERT OR IGNORE INTO events (id, kind, type, chapter, description, params_json, fact_group_id) VALUES ('evt_origin_01', 'business', 'origin', 1, '初始设定', '{}', 'evt_origin_01')",
    "INSERT OR IGNORE INTO events (id, kind, type, chapter, description, params_json, fact_group_id) VALUES ('evt_tribulation_50', 'business', 'tribulation', 50, '渡劫事件', '{}', 'evt_tribulation_50')",
    "INSERT OR IGNORE INTO events (id, kind, type, chapter, description, params_json, fact_group_id) VALUES ('evt_conflict_30', 'business', 'conflict', 30, '冲突事件', '{}', 'evt_conflict_30')",
    "INSERT OR IGNORE INTO events (id, kind, type, chapter, description, params_json, fact_group_id) VALUES ('evt_encounter_55', 'business', 'encounter', 55, '奇遇事件', '{}', 'evt_encounter_55')",
  ];
  for (const sql of entities) {
    db.exec(sql);
  }
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

describe('SQLiteFactStoreAdapter', () => {
  let store: SQLiteFactStoreAdapter;

  beforeEach(() => {
    store = new SQLiteFactStoreAdapter(':memory:', 'test_project');
    setupEntities(store);
  });

  // -------------------------------------------------------------------
  // assert
  // -------------------------------------------------------------------

  describe('assert', () => {
    it('应创建 Fact 并自动生成 ID', () => {
      const fact = store.assert({
        subject: 'ent_zhangsan',
        predicate: 'realm',
        value: '金丹期',
        certainty: 'canonical',
        causeEvent: 'evt_origin_01',
        validFrom: 1,
        validTo: null,
        embeddingText: '张三 的修炼境界是 金丹期（第1章）',
      });

      expect(fact.id).toMatch(/^fct_origin_01_\d{2}$/);
      expect(fact.subject).toBe('ent_zhangsan');
      expect(fact.predicate).toBe('realm');
      expect(fact.value).toBe('金丹期');
      expect(fact.certainty).toBe('canonical');
      expect(fact.validTo).toBeNull();
    });

    it('应在 assert 内部生成 embeddingText（§3.1.2 格式，非空）', () => {
      // 回归守卫：assert 签名 Omit<Fact,'id'|'embeddingText'> 不接收 embeddingText，
      // 须由 assert 内部生成，保证 embedding_text 列非空——sync_queue consumer 据此向量化。
      // 此前曾误改为留空 ''，导致语义检索召回质量下降（见 push-mode §5A-6 第5章召回失败的回归）。
      const fact = store.assert({
        subject: 'ent_zhangsan',
        predicate: 'realm',
        value: '金丹期',
        certainty: 'canonical',
        causeEvent: 'evt_origin_01',
        validFrom: 1,
        validTo: null,
      });

      // 核心断言：永不为空
      expect(fact.embeddingText).not.toBe('');
      // §3.1.2 格式：主体显示名 + 谓词 + 值 + 章节
      expect(fact.embeddingText).toContain('张三');   // 实体显示名解析（ent_zhangsan → 张三）
      expect(fact.embeddingText).toContain('金丹期'); // 值
      expect(fact.embeddingText).toContain('第1章');  // 章节标记
    });

    it('entity_ref 值的 embeddingText 应解析为目标实体显示名（非裸 ID）', () => {
      const fact = store.assert({
        subject: 'ent_zhangsan',
        predicate: 'enemy_of',
        value: makeEntityRef('ent_lisi'),
        certainty: 'canonical',
        causeEvent: 'evt_conflict_30',
        validFrom: 30,
        validTo: null,
      });

      expect(fact.embeddingText).toContain('李四');          // 目标实体显示名
      expect(fact.embeddingText).not.toContain('ent_lisi');  // 不应残留裸实体 ID
    });

    it('同一事件内的第二个 Fact ID 序号应递增', () => {
      const f1 = store.assert({
        subject: 'ent_zhangsan', predicate: 'realm', value: '金丹期',
        certainty: 'canonical', causeEvent: 'evt_origin_01', validFrom: 1, validTo: null,
        embeddingText: '',
      });
      const f2 = store.assert({
        subject: 'ent_zhangsan', predicate: 'meridian', value: '天灵根',
        certainty: 'canonical', causeEvent: 'evt_origin_01', validFrom: 1, validTo: null,
        embeddingText: '',
      });

      expect(f1.id).toBe('fct_origin_01_01');
      expect(f2.id).toBe('fct_origin_01_02');
    });

    it('EntityRef 类型值应正确存储和读取', () => {
      const fact = store.assert({
        subject: 'ent_zhangsan',
        predicate: 'enemy_of',
        value: makeEntityRef('ent_lisi'),
        certainty: 'canonical',
        causeEvent: 'evt_conflict_30',
        validFrom: 30,
        validTo: null,
        embeddingText: '张三 与李四的关系是 敌对（第30章）',
      });

      const retrieved = store.getById(fact.id);
      expect(retrieved).toBeDefined();
      const val = retrieved!.value as EntityRef;
      expect(val.type).toBe('entity_ref');
      expect(val.entityId).toBe('ent_lisi');
    });

    it('各种标量类型（string/number/boolean）应正确往返', () => {
      const strFact = store.assert({
        subject: 'ent_zhangsan', predicate: 'nickname', value: '小张',
        certainty: 'canonical', causeEvent: 'evt_origin_01', validFrom: 1, validTo: null,
        embeddingText: '',
      });
      const numFact = store.assert({
        subject: 'ent_zhangsan', predicate: 'hp', value: 8500,
        certainty: 'canonical', causeEvent: 'evt_origin_01', validFrom: 1, validTo: null,
        embeddingText: '',
      });
      const boolFact = store.assert({
        subject: 'ent_zhangsan', predicate: 'is_alive', value: true,
        certainty: 'canonical', causeEvent: 'evt_origin_01', validFrom: 1, validTo: null,
        embeddingText: '',
      });

      expect(store.getById(strFact.id)!.value).toBe('小张');
      expect(store.getById(numFact.id)!.value).toBe(8500);
      expect(store.getById(boolFact.id)!.value).toBe(true);
    });
  });

  // -------------------------------------------------------------------
  // retract
  // -------------------------------------------------------------------

  describe('retract', () => {
    it('应设置 validTo 而非物理删除', () => {
      const fact = store.assert({
        subject: 'ent_zhangsan', predicate: 'status', value: 'alive',
        certainty: 'canonical', causeEvent: 'evt_origin_01', validFrom: 1, validTo: null,
        embeddingText: '',
      });

      store.retract(fact.id, 50);

      const retrieved = store.getById(fact.id);
      expect(retrieved).toBeDefined();
      expect(retrieved!.validTo).toBe(50);
    });

    it('重复 retract 已失效的 Fact 应报错', () => {
      const fact = store.assert({
        subject: 'ent_zhangsan', predicate: 'status', value: 'alive',
        certainty: 'canonical', causeEvent: 'evt_origin_01', validFrom: 1, validTo: null,
        embeddingText: '',
      });
      store.retract(fact.id, 50);
      expect(() => store.retract(fact.id, 60)).toThrow();
    });
  });

  // -------------------------------------------------------------------
  // update
  // -------------------------------------------------------------------

  describe('update', () => {
    it('应 retract 旧 Fact + assert 新 Fact', () => {
      const oldFact = store.assert({
        subject: 'ent_zhangsan', predicate: 'realm', value: '筑基期',
        certainty: 'canonical', causeEvent: 'evt_origin_01', validFrom: 1, validTo: null,
        embeddingText: '',
      });

      const newFact = store.update(oldFact.id, '金丹期', 'evt_tribulation_50', 50);

      // 旧 Fact 已失效
      expect(store.getById(oldFact.id)!.validTo).toBe(50);
      // 新 Fact 当前有效
      expect(newFact.validTo).toBeNull();
      expect(newFact.value).toBe('金丹期');
      expect(newFact.causeEvent).toBe('evt_tribulation_50');
      expect(newFact.validFrom).toBe(50);
    });
  });

  // -------------------------------------------------------------------
  // applyFactGroup
  // -------------------------------------------------------------------

  describe('applyFactGroup', () => {
    it('应原子执行多个变更并返回 idMap', () => {
      const group: FactGroup = {
        id: 'evt_tribulation_50',
        causeEvent: 'evt_tribulation_50',
        changes: [
          { changeId: 'chg_1', op: 'assert' as const, payload: {
            subject: 'ent_zhangsan', predicate: 'realm', value: '元婴期',
            certainty: 'canonical' as const, validFrom: 50, validTo: null,
          }},
          { changeId: 'chg_2', op: 'assert' as const, payload: {
            subject: 'ent_zhangsan', predicate: 'lifespan', value: 5000,
            certainty: 'canonical' as const, validFrom: 50, validTo: null,
          }},
        ],
      };

      const idMap = store.applyFactGroup(group);
      expect(idMap.size).toBe(2);
      expect(idMap.get('chg_1')).toMatch(/^fct_/);
      expect(idMap.get('chg_2')).toMatch(/^fct_/);

      // 验证两个 Fact 都已写入
      expect(store.getById(idMap.get('chg_1')!)!.value).toBe('元婴期');
      expect(store.getById(idMap.get('chg_2')!)!.value).toBe(5000);
    });

    it('中途失败应回滚整个 FactGroup', () => {
      // 先创建一条 Fact 用于后续 retract
      const existingFact = store.assert({
        subject: 'ent_zhangsan', predicate: 'realm', value: '筑基期',
        certainty: 'canonical', causeEvent: 'evt_origin_01', validFrom: 1, validTo: null,
        embeddingText: '',
      });

      const group: FactGroup = {
        id: 'evt_tribulation_50',
        causeEvent: 'evt_tribulation_50',
        changes: [
          { changeId: 'chg_ok', op: 'assert' as const, payload: {
            subject: 'ent_zhangsan', predicate: 'lifespan', value: 5000,
            certainty: 'canonical' as const, validFrom: 50, validTo: null,
          }},
          // 这条 retract 指向不存在的 Fact，应触发错误
          { changeId: 'chg_bad', op: 'retract' as const, targetFactId: 'fct_nonexistent' },
        ],
      };

      expect(() => store.applyFactGroup(group)).toThrow();

      // chg_ok 应该被回滚（不会出现在数据库中）
      const facts = store.getFactsByEvent('evt_tribulation_50');
      expect(facts.length).toBe(0);

      // 旧 Fact 应未被修改
      expect(store.getById(existingFact.id)!.validTo).toBeNull();
    });

    it('缺少基础字段时不应静默写入 unknown Fact', () => {
      const group: FactGroup = {
        id: 'evt_tribulation_50',
        causeEvent: 'evt_tribulation_50',
        changes: [
          { changeId: 'chg_bad', op: 'assert' as const, payload: {
            predicate: 'realm',
            value: '元婴期',
            certainty: 'canonical' as const,
            validFrom: 50,
            validTo: null,
          } as any },
        ],
      };

      expect(() => store.applyFactGroup(group)).toThrow('assert 缺少 subject');
      expect(store.query({ subject: 'unknown' }).length).toBe(0);
    });

    it('update 应支持 subject/predicate/value 的完整新 Fact 语义', () => {
      const oldFact = store.assert({
        subject: 'ent_zhangsan', predicate: 'realm', value: '筑基期',
        certainty: 'canonical', causeEvent: 'evt_origin_01', validFrom: 1, validTo: null,
        embeddingText: '',
      });

      const group: FactGroup = {
        id: 'evt_tribulation_50',
        causeEvent: 'evt_tribulation_50',
        changes: [
          { changeId: 'chg_update', op: 'update' as const, targetFactId: oldFact.id, payload: {
            predicate: 'public_realm',
            value: '金丹期',
            certainty: 'canonical' as const,
            validFrom: 50,
            context: 'global',
          }},
        ],
      };

      const idMap = store.applyFactGroup(group);
      const newFact = store.getById(idMap.get('chg_update')!)!;

      expect(store.getById(oldFact.id)!.validTo).toBe(50);
      expect(newFact.subject).toBe('ent_zhangsan');
      expect(newFact.predicate).toBe('public_realm');
      expect(newFact.value).toBe('金丹期');
      expect(newFact.validFrom).toBe(50);
    });
  });

  // -------------------------------------------------------------------
  // query
  // -------------------------------------------------------------------

  describe('query', () => {
    beforeEach(() => {
      // 预置一批测试数据
      store.assert({
        subject: 'ent_zhangsan', predicate: 'realm', value: '金丹期',
        certainty: 'canonical', causeEvent: 'evt_origin_01', validFrom: 1, validTo: null,
        embeddingText: '张三 的修炼境界是 金丹期（第1章）',
      });
      store.assert({
        subject: 'ent_zhangsan', predicate: 'meridian', value: '天灵根',
        certainty: 'canonical', causeEvent: 'evt_origin_01', validFrom: 1, validTo: null,
        embeddingText: '张三 的经脉是 天灵根（第1章）',
      });
      store.assert({
        subject: 'ent_lisi', predicate: 'realm', value: '元婴期',
        certainty: 'canonical', causeEvent: 'evt_origin_01', validFrom: 1, validTo: null,
        embeddingText: '李四 的修炼境界是 元婴期（第1章）',
      });
      store.assert({
        subject: 'ent_zhangsan', predicate: 'enemy_of',
        value: makeEntityRef('ent_lisi'),
        certainty: 'canonical', causeEvent: 'evt_conflict_30', validFrom: 30, validTo: null,
        embeddingText: '张三 与李四的关系是 敌对（第30章）',
      });
    });

    it('按 subject 查询应返回该实体的所有 Fact', () => {
      const results = store.query({ subject: 'ent_zhangsan' });
      expect(results.length).toBeGreaterThanOrEqual(2);
      expect(results.every(f => f.subject === 'ent_zhangsan')).toBe(true);
    });

    it('按 subject + predicate 查询', () => {
      const results = store.query({ subject: 'ent_zhangsan', predicate: 'realm' });
      expect(results.length).toBe(1);
      expect(results[0]!.value).toBe('金丹期');
    });

    it('时间切片：atChapter 应排除该时间点之后才生效的 Fact', () => {
      // 第 30 章的 enemy_of 在第 20 章时还不存在
      const results = store.query({ subject: 'ent_zhangsan', atChapter: 20 });
      const predicates = results.map(f => f.predicate);
      expect(predicates).toContain('realm');
      expect(predicates).toContain('meridian');
      expect(predicates).not.toContain('enemy_of'); // 第 30 章才生效
    });

    it('反向关系查询：按 valueEntityRef 查找指向某实体的关系', () => {
      const results = store.query({ valueEntityRef: 'ent_lisi' });
      expect(results.length).toBe(1);
      expect(results[0]!.subject).toBe('ent_zhangsan');
      expect(results[0]!.predicate).toBe('enemy_of');
    });

    it('按 certainty 过滤', () => {
      // 默认排除 potential 和 orphaned
      const results = store.query({ subject: 'ent_zhangsan' });
      expect(results.every(f => f.certainty === 'canonical')).toBe(true);
    });
  });

  // -------------------------------------------------------------------
  // getSnapshot
  // -------------------------------------------------------------------

  describe('getSnapshot', () => {
    it('应返回实体在指定章节的完整状态快照', () => {
      store.assert({
        subject: 'ent_zhangsan', predicate: 'realm', value: '筑基期',
        certainty: 'canonical', causeEvent: 'evt_origin_01', validFrom: 1, validTo: null,
        embeddingText: '',
      });
      store.assert({
        subject: 'ent_zhangsan', predicate: 'meridian', value: '天灵根',
        certainty: 'canonical', causeEvent: 'evt_origin_01', validFrom: 1, validTo: null,
        embeddingText: '',
      });

      const snapshot = store.getSnapshot('ent_zhangsan', 1);
      expect(snapshot['realm']).toBe('筑基期');
      expect(snapshot['meridian']).toBe('天灵根');
    });

    it('同 predicate 多条记录时取最新 validFrom 的值', () => {
      // 第 1 章：筑基期
      const oldFact = store.assert({
        subject: 'ent_zhangsan', predicate: 'realm', value: '筑基期',
        certainty: 'canonical', causeEvent: 'evt_origin_01', validFrom: 1, validTo: null,
        embeddingText: '',
      });
      // 第 50 章：突破到金丹期
      store.update(oldFact.id, '金丹期', 'evt_tribulation_50', 50);

      // 第 30 章快照：还是筑基期
      const snap30 = store.getSnapshot('ent_zhangsan', 30);
      expect(snap30['realm']).toBe('筑基期');

      // 第 60 章快照：已突破金丹期
      const snap60 = store.getSnapshot('ent_zhangsan', 60);
      expect(snap60['realm']).toBe('金丹期');
    });
  });

  // -------------------------------------------------------------------
  // getFactsByEvent
  // -------------------------------------------------------------------

  describe('getFactsByEvent', () => {
    it('应返回指定事件产生的所有 Fact', () => {
      store.assert({
        subject: 'ent_zhangsan', predicate: 'realm', value: '金丹期',
        certainty: 'canonical', causeEvent: 'evt_tribulation_50', validFrom: 50, validTo: null,
        embeddingText: '',
      });
      store.assert({
        subject: 'ent_zhangsan', predicate: 'hp', value: 8500,
        certainty: 'canonical', causeEvent: 'evt_tribulation_50', validFrom: 50, validTo: null,
        embeddingText: '',
      });

      const facts = store.getFactsByEvent('evt_tribulation_50');
      expect(facts.length).toBe(2);
      expect(facts.every(f => f.causeEvent === 'evt_tribulation_50')).toBe(true);
    });
  });

  // -------------------------------------------------------------------
  // getRelationsTargeting
  // -------------------------------------------------------------------

  describe('getRelationsTargeting', () => {
    it('应返回所有指向目标实体的关系 Fact', () => {
      store.assert({
        subject: 'ent_zhangsan', predicate: 'enemy_of',
        value: makeEntityRef('ent_lisi'),
        certainty: 'canonical', causeEvent: 'evt_conflict_30', validFrom: 30, validTo: null,
        embeddingText: '',
      });
      store.assert({
        subject: 'ent_chenlao', predicate: 'disciple_of',
        value: makeEntityRef('ent_lisi'),
        certainty: 'canonical', causeEvent: 'evt_origin_01', validFrom: 1, validTo: null,
        embeddingText: '',
      });

      const relations = store.getRelationsTargeting('ent_lisi');
      expect(relations.length).toBeGreaterThanOrEqual(2);
      expect(relations.every(f => {
        const v = f.value as EntityRef;
        return v.type === 'entity_ref' && v.entityId === 'ent_lisi';
      })).toBe(true);
    });
  });

  // -------------------------------------------------------------------
  // 乐观锁
  // -------------------------------------------------------------------

  describe('乐观锁 state_version', () => {
    it('初始版本应为 0', () => {
      expect(store.getStateVersion('test_project')).toBe(0);
    });

    it('tryUpdateStateVersion 成功时返回 true', () => {
      expect(store.tryUpdateStateVersion('test_project', 0)).toBe(true);
      expect(store.getStateVersion('test_project')).toBe(1);
    });

    it('tryUpdateStateVersion 版本冲突时返回 false', () => {
      store.tryUpdateStateVersion('test_project', 0); // v0→v1
      expect(store.tryUpdateStateVersion('test_project', 0)).toBe(false); // 仍用 v0 提交
      expect(store.getStateVersion('test_project')).toBe(1); // 版本未变
    });
  });

  // -------------------------------------------------------------------
  // WAL 模式
  // -------------------------------------------------------------------

  describe('WAL 模式', () => {
    it(':memory: 数据库 journal_mode 为 memory（文件数据库返回 wal）', () => {
      const db = store.getDatabase();
      const result = db.pragma('journal_mode') as Array<{ journal_mode: string }>;
      // :memory: 数据库不支持 WAL（内存数据库无需日志），返回 'memory'
      // 文件数据库（如 project.db）应返回 'wal'
      expect(['wal', 'memory']).toContain(result[0]!.journal_mode);
    });
  });
});

// =============================================================================
// 真实叙事场景端到端测试
// =============================================================================
// 使用完整引擎模拟修仙小说中的典型叙事场景，验证各组件在真实数据下的正确性。
//
// 场景设计：
//   - 世界：仙侠修炼世界观
//   - 角色：张三（主角）、李四（对手）、王长老（导师）、小师妹
//   - 事件：初始设定 → 张三渡劫 → 王长老受伤 → 李四偷袭 → 张三复仇
//   - 验证：Fact 写入/查询、Knowledge 传播/合并/封印、Thread 生成/关闭
// =============================================================================

import { describe, it, expect, beforeEach } from 'vitest';
import { SQLiteFactStoreAdapter } from '../../src/adapters/sqlite/fact-store.js';
import { SQLiteKnowledgeStoreAdapter } from '../../src/adapters/sqlite/knowledge-store.js';
import { SQLiteEventStoreAdapter } from '../../src/adapters/sqlite/event-store.js';
import { SQLiteThreadStoreAdapter } from '../../src/adapters/sqlite/thread-store.js';
import { RuleEngine } from '../../src/core/rule-engine.js';
import { ThreadResolver } from '../../src/core/thread-resolver.js';
import { ProposalManager } from '../../src/core/proposal-manager.js';
import type {
  FactStore,
  NarrativeEvent,
  NarrativeThread,
  FactChangeInput,
  Knowledge,
  KnowledgeHint,
  KnowledgeBroadcast,
} from '../../src/types.js';

// =============================================================================
// 修仙世界初始化
// =============================================================================

interface WorldState {
  factStore: SQLiteFactStoreAdapter;
  knowledgeStore: SQLiteKnowledgeStoreAdapter;
  eventStore: SQLiteEventStoreAdapter;
  threadStore: SQLiteThreadStoreAdapter;
  manager: ProposalManager;
  originEventId: string;
}

let w: WorldState;

function initWorld() {
  const factStore = new SQLiteFactStoreAdapter(':memory:', 'default');
  const db = factStore.getDatabase();
  const knowledgeStore = new SQLiteKnowledgeStoreAdapter(db);
  const eventStore = new SQLiteEventStoreAdapter(db);
  const threadStore = new SQLiteThreadStoreAdapter(db);
  const ruleEngine = new RuleEngine();
  const threadResolver = new ThreadResolver();
  const manager = new ProposalManager(ruleEngine, undefined, threadStore, threadResolver);

  // 注册实体
  db.exec(`
    INSERT INTO entities (id, name, kind, first_appearance) VALUES
      ('ent_zhangsan', '张三', 'entity', 1),
      ('ent_lisi', '李四', 'entity', 1),
      ('ent_wang', '王长老', 'entity', 1),
      ('ent_xiaomei', '小师妹', 'entity', 1),
      ('ent_taixumen', '太虚门', 'entity', 1),
      ('ent_qingyunfeng', '青云峰', 'place', 1),
      ('ent_zhuxianjian', '诛仙剑', 'entity', 5);
  `);

  // 初始世界观事件
  const originEvent: Omit<NarrativeEvent, 'id'> = {
    kind: 'business',
    type: 'world_origin',
    chapter: 1,
    description: '太虚门世界的初始设定',
    params: {},
    context: 'global',
    timestamp: new Date().toISOString(),
    factGroupId: 'evt_world_origin_1_01',
    resolvedThreads: [],
    dependentFactIds: [],
  };
  const committedOrigin = eventStore.create(originEvent);
  const originEventId = committedOrigin.id;

  // 初始 Fact：角色状态
  factStore.assert({
    subject: 'ent_zhangsan', predicate: 'realm', value: '筑基期',
    certainty: 'canonical', causeEvent: originEventId, validFrom: 1, validTo: null,
    embeddingText: '张三的修炼境界是筑基期（第1章）',
  });
  factStore.assert({
    subject: 'ent_zhangsan', predicate: 'status', value: 'alive',
    certainty: 'canonical', causeEvent: originEventId, validFrom: 1, validTo: null,
    embeddingText: '张三的状态是存活（第1章）',
  });
  factStore.assert({
    subject: 'ent_zhangsan', predicate: 'location', value: '青云峰',
    certainty: 'canonical', causeEvent: originEventId, validFrom: 1, validTo: null,
    embeddingText: '张三在青云峰（第1章）',
  });
  factStore.assert({
    subject: 'ent_lisi', predicate: 'realm', value: '金丹期',
    certainty: 'canonical', causeEvent: originEventId, validFrom: 1, validTo: null,
    embeddingText: '李四的修炼境界是金丹期（第1章）',
  });
  factStore.assert({
    subject: 'ent_lisi', predicate: 'status', value: 'alive',
    certainty: 'canonical', causeEvent: originEventId, validFrom: 1, validTo: null,
    embeddingText: '李四的状态是存活（第1章）',
  });
  factStore.assert({
    subject: 'ent_lisi', predicate: 'location', value: '太虚门',
    certainty: 'canonical', causeEvent: originEventId, validFrom: 1, validTo: null,
    embeddingText: '李四在太虚门（第1章）',
  });
  factStore.assert({
    subject: 'ent_wang', predicate: 'status', value: 'alive',
    certainty: 'canonical', causeEvent: originEventId, validFrom: 1, validTo: null,
    embeddingText: '王长老的状态是存活（第1章）',
  });
  factStore.assert({
    subject: 'ent_wang', predicate: 'realm', value: '元婴期',
    certainty: 'canonical', causeEvent: originEventId, validFrom: 1, validTo: null,
    embeddingText: '王长老的修炼境界是元婴期（第1章）',
  });

  return {
    factStore, knowledgeStore, eventStore, threadStore, manager, originEventId,
  };
}

// =============================================================================
// 场景一：张三渡劫突破金丹期
// =============================================================================

describe('场景一：张三渡劫突破', () => {
  beforeEach(() => {
    w = initWorld();
  });

  it('渡劫事件应提升境界、触发规则引擎（无违规）、自动传播知识', () => {
    const { factStore, knowledgeStore, manager, eventStore } = w;

    // ---- propose ----
    const factChanges: FactChangeInput[] = [
      { change_id: 'chg_realm', op: 'update', target_fact_id: factStore.query({ subject: 'ent_zhangsan', predicate: 'realm' })[0]!.id, value: '金丹期' },
    ];

    const proposal = manager.proposeEvent({
      eventType: 'tribulation',
      eventDescription: '张三在青云峰渡劫突破金丹期',
      chapter: 50,
      factChanges,
      subject: 'ent_zhangsan',
    }, factStore);

    // 张三活着渡劫 → 无规则违规 → isSafeToCommit=true
    expect(proposal.isSafeToCommit).toBe(true);
    // subject_auto 传播：张三应自己知道自己突破了
    expect(proposal.consequences.proposedKnowledge!.length).toBeGreaterThanOrEqual(1);
    expect(proposal.consequences.proposedKnowledge!.some(pk => pk.entityId === 'ent_zhangsan')).toBe(true);

    // ---- commit ----
    const result = manager.commitEvent(proposal.proposalId, factStore, knowledgeStore, eventStore);

    // 验证：境界已变为金丹期（旧 Fact 已 retract，当前只有一个有效的 realm Fact）
    const realmFacts = factStore.query({ subject: 'ent_zhangsan', predicate: 'realm' });
    expect(realmFacts.length).toBe(1); // 只有一条当前有效的
    expect(realmFacts[0]!.value).toBe('金丹期');
    expect(realmFacts[0]!.validTo).toBeNull();

    // 验证：张三的知识自动传播
    const zhangKnowledge = knowledgeStore.getKnownFacts('ent_zhangsan', 50);
    const realmK = zhangKnowledge.find(k => {
      const f = factStore.getById(k.factId);
      return f?.predicate === 'realm' && f?.validTo === null;
    });
    expect(realmK).toBeDefined();
    expect(realmK!.source).toBe('self_action');
    expect(realmK!.confidence).toBe(1.0);

    // 验证：返回值
    expect(result.eventId).toBeDefined();
    expect(result.committedFactCount).toBeGreaterThan(0);
    expect(result.committedKnowledgeCount).toBeGreaterThanOrEqual(1);
  });
});

// =============================================================================
// 场景二：同场景目击传播
// =============================================================================

describe('场景二：同场景目击传播', () => {
  beforeEach(() => {
    w = initWorld();
  });

  it('与主角同地点的角色应目击事件', () => {
    const { factStore } = w;

    // 让李四也在青云峰（与张三同地点）
    const liLocation = factStore.query({ subject: 'ent_lisi', predicate: 'location' })[0];
    const originEventId = w.originEventId;
    factStore.update(liLocation!.id, '青云峰', originEventId, 1);

    const { manager, knowledgeStore, eventStore } = w;

    const factChanges: FactChangeInput[] = [
      { change_id: 'chg_1', op: 'assert', subject: 'ent_zhangsan', predicate: 'ability', value: '御剑飞行' },
    ];

    const proposal = manager.proposeEvent({
      eventType: 'cultivation',
      eventDescription: '张三在青云峰修炼御剑飞行',
      chapter: 30,
      factChanges,
      subject: 'ent_zhangsan',
    }, factStore);

    manager.commitEvent(proposal.proposalId, factStore, knowledgeStore, eventStore);

    // 张三应该知晓（self_action）
    const zhangK = knowledgeStore.getKnownFacts('ent_zhangsan', 30);
    expect(zhangK.some(k => k.source === 'self_action')).toBe(true);

    // 李四与张三同在青云峰 → 应目击（witnessed）
    const liK = knowledgeStore.getKnownFacts('ent_lisi', 30);
    // 李四的 location=青云峰，张三的 location=青云峰 → witness 传播
    expect(liK.some(k => k.source === 'witnessed')).toBe(true);

    // 王长老在太虚门 → 不应目击（地点不同）
    const wangKBeforeChangingLocation = knowledgeStore.getKnownFacts('ent_wang', 30);
    // 王长老没有 location Fact，所以 witness 规则找不到他的位置 → 不传播
    expect(wangKBeforeChangingLocation).toHaveLength(0);
  });
});

// =============================================================================
// 场景三：规则引擎产生 Thread + 自动关闭
// =============================================================================

describe('场景三：线索生成与自动关闭', () => {
  beforeEach(() => {
    w = initWorld();
  });

  it('死亡实体作为事件主体应产生 critical 线索', () => {
    const { factStore, manager, knowledgeStore, eventStore } = w;

    // 先让张三死于第 100 章
    const zhangStatus = factStore.query({ subject: 'ent_zhangsan', predicate: 'status' })[0];
    factStore.update(zhangStatus!.id, 'dead', w.originEventId, 100);

    // 尝试在第 101 章让张三作为事件主体
    const proposal = manager.proposeEvent({
      eventType: 'battle',
      eventDescription: '张三出战（但张三已死亡）',
      chapter: 101,
      factChanges: [
        { change_id: 'chg_1', op: 'assert', subject: 'ent_lisi', predicate: 'note', value: '一场不可能的战斗' },
      ],
      subject: 'ent_zhangsan',
    }, factStore);

    // dead_entity_action 规则产生 critical 线索 → isSafeToCommit=false
    expect(proposal.isSafeToCommit).toBe(false);
    expect(proposal.consequences.generatedThreads.length).toBeGreaterThanOrEqual(1);
    const deadThread = proposal.consequences.generatedThreads.find(t => t.type === 'rule_violation');
    expect(deadThread).toBeDefined();
    expect(deadThread!.severity).toBe('critical');
    expect(deadThread!.description).toContain('ent_zhangsan');
  });

  it('渐进型线索在匹配事件后自动关闭', () => {
    const { factStore, manager, threadStore, knowledgeStore, eventStore } = w;

    // ---- 第一幕：张三获得诛仙剑（产生 foreshadowing 线索） ----
    const prop1 = manager.proposeEvent({
      eventType: 'encounter',
      eventDescription: '张三在第5章获得诛仙剑',
      chapter: 5,
      factChanges: [
        { change_id: 'chg_sword', op: 'assert', subject: 'ent_zhangsan', predicate: 'item', value: '诛仙剑' },
      ],
      subject: 'ent_zhangsan',
    }, factStore);

    // Rule Engine 可能有规则产生 Thread（depends on built-in rules）
    // 如果有，测试生成和关闭；如果没有，手动创建线索验证关闭逻辑
    manager.commitEvent(prop1.proposalId, factStore, knowledgeStore, eventStore);

    // 手动创建一条"诛仙剑下落不明"的伏笔（模拟 LLM 或 Rule Engine 产出的复杂伏笔）
    const swordThread = threadStore.create({
      type: 'foreshadowing',
      direction: 'progressive',
      severity: 'major',
      description: '诛仙剑遗失在远古战场，需要找回才能对抗大劫',
      closeCondition: {
        requiredEventType: 'sword_found',
        withinChapters: 300,
      },
      status: 'PLANTED',
      closedBy: null,
      createdAtEvent: w.originEventId,
      createdAtChapter: 5,
      milestones: [],
      relatedEntities: ['ent_zhangsan', 'ent_zhuxianjian'],
      upstreamFactIds: [],
      tags: ['main_plot', 'artifact'],
    });
    expect(threadStore.getOpen().length).toBeGreaterThanOrEqual(1);

    // ---- 第二幕：第 100 章找回诛仙剑（触发关闭） ----
    const prop2 = manager.proposeEvent({
      eventType: 'sword_found',
      eventDescription: '张三在第100章从远古战场找回诛仙剑',
      chapter: 100,
      factChanges: [
        { change_id: 'chg_found', op: 'assert', subject: 'ent_zhangsan', predicate: 'item', value: '诛仙剑' },
      ],
      subject: 'ent_zhangsan',
    }, factStore);

    manager.commitEvent(prop2.proposalId, factStore, knowledgeStore, eventStore);

    // 验证线索被自动关闭
    const closed = threadStore.getById(swordThread.id);
    expect(closed!.status).toBe('RESOLVED'); // 渐进型自动关闭 → RESOLVED
    expect(closed!.closedBy).toBeDefined();
  });
});

// =============================================================================
// 场景四：记忆封印与知识可见性
// =============================================================================

describe('场景四：记忆封印与知识可见性', () => {
  beforeEach(() => {
    w = initWorld();
  });

  it('封印记忆后应不可见，恢复后重新可见', () => {
    const { factStore, manager, knowledgeStore, eventStore } = w;

    // ---- 张三在战斗中学会禁术 ----
    const prop1 = manager.proposeEvent({
      eventType: 'battle',
      eventDescription: '张三在生死战中悟出禁术',
      chapter: 80,
      factChanges: [
        { change_id: 'chg_jinshu', op: 'assert', subject: 'ent_zhangsan', predicate: 'ability', value: '灵魂燃烧' },
      ],
      subject: 'ent_zhangsan',
    }, factStore);

    manager.commitEvent(prop1.proposalId, factStore, knowledgeStore, eventStore);

    // 张三应该知道自己学会了禁术
    const k80 = knowledgeStore.getKnownFacts('ent_zhangsan', 80);
    expect(k80.some(k => {
      const f = factStore.getById(k.factId);
      return f?.predicate === 'ability' && f?.value === '灵魂燃烧';
    })).toBe(true);

    // ---- 王长老用秘术封印张三对禁术的记忆 ----
    const abilityFact = factStore.query({ subject: 'ent_zhangsan', predicate: 'ability' }).find(f => f.validTo === null)!;

    const prop2 = manager.proposeEvent({
      eventType: 'memory_seal',
      eventDescription: '王长老担心张三走火入魔，封印了他对灵魂燃烧的记忆',
      chapter: 81,
      factChanges: [
        { change_id: 'chg_note', op: 'assert', subject: 'ent_zhangsan', predicate: 'note', value: '记忆已被封印' },
      ],
      subject: 'ent_wang',
      knowledgeChanges: [{
        op: 'seal',
        target_entity_id: 'ent_zhangsan',
        fact_id_scope: 'explicit',
        fact_ids: [abilityFact.id],
      }],
    }, factStore);

    manager.commitEvent(prop2.proposalId, factStore, knowledgeStore, eventStore);

    // 第 81 章后，张三不应再"知道"禁术（confidence <= 0 默认过滤）
    const k81 = knowledgeStore.getKnownFacts('ent_zhangsan', 81);
    expect(k81.some(k => k.factId === abilityFact.id)).toBe(false);

    // 但 includeSealed=true 时应能看到封印记录
    const sealed = knowledgeStore.query({
      entityId: 'ent_zhangsan',
      factId: abilityFact.id,
      atChapter: 81,
    });
    const sealedRecord = sealed.find(k => k.source === 'memory_seal');
    expect(sealedRecord).toBeDefined();
    expect(sealedRecord!.confidence).toBe(0);

    // ---- 王长老恢复记忆 ----
    const prop3 = manager.proposeEvent({
      eventType: 'memory_restore',
      eventDescription: '王长老临终前恢复张三的记忆',
      chapter: 120,
      factChanges: [
        { change_id: 'chg_event', op: 'assert', subject: 'ent_wang', predicate: 'status', value: 'dead' },
      ],
      subject: 'ent_wang',
      knowledgeChanges: [{
        op: 'restore',
        target_entity_id: 'ent_zhangsan',
        fact_id_scope: 'explicit',
        fact_ids: [abilityFact.id],
      }],
    }, factStore);

    manager.commitEvent(prop3.proposalId, factStore, knowledgeStore, eventStore);

    // 第 120 章后，张三重新知道禁术
    const k120 = knowledgeStore.getKnownFacts('ent_zhangsan', 120);
    expect(k120.some(k => k.factId === abilityFact.id)).toBe(true);
  });
});

// =============================================================================
// 场景五：知识广播 + 细粒度覆盖
// =============================================================================

describe('场景五：知识广播与细粒度覆盖', () => {
  beforeEach(() => {
    w = initWorld();
  });

  it('门派大会信息广播给所有参与者，但掌门自己以 revelation 方式知晓', () => {
    const { factStore, manager, knowledgeStore, eventStore } = w;

    const factChanges: FactChangeInput[] = [
      { change_id: 'chg_meeting', op: 'assert', subject: 'ent_taixumen', predicate: 'announcement', value: '三个月后召开门派大比' },
    ];

    // broadcast (tier 2): 太虚门所有弟子以 informed 方式知晓
    const broadcast: KnowledgeBroadcast = {
      visibility: 'explicit_entities',
      target_entity_ids: ['ent_zhangsan', 'ent_lisi', 'ent_wang', 'ent_xiaomei'],
      source: 'informed',
      confidence: 0.9,
    };

    // hint (tier 3): 王长老身为掌门（假设），实际以 revelation 方式早就知晓
    const hints: KnowledgeHint[] = [
      { entityId: 'ent_wang', factIndex: 0, source: 'revelation', confidence: 1.0 },
    ];

    const proposal = manager.proposeEvent({
      eventType: 'announcement',
      eventDescription: '太虚门宣布举行门派大比',
      chapter: 40,
      factChanges,
      subject: 'ent_wang',
      knowledgeBroadcast: broadcast,
      knowledgeHints: hints,
    }, factStore);

    manager.commitEvent(proposal.proposalId, factStore, knowledgeStore, eventStore);

    // 普通弟子：informed/0.9
    const zhangK = knowledgeStore.getKnownFacts('ent_zhangsan', 40);
    expect(zhangK.length).toBeGreaterThanOrEqual(1);
    if (zhangK.length > 0) {
      expect(zhangK[0]!.source).toBe('informed');
      expect(zhangK[0]!.confidence).toBe(0.9);
    }

    // 王长老：hints 覆盖 broadcast → revelation/1.0
    const wangK = knowledgeStore.getKnownFacts('ent_wang', 40);
    expect(wangK.length).toBeGreaterThanOrEqual(1);
    if (wangK.length > 0) {
      expect(wangK[0]!.source).toBe('revelation');
      expect(wangK[0]!.confidence).toBe(1.0);
    }
  });
});

// =============================================================================
// 场景六：完整查询链（QueryEngine 综合使用）
// =============================================================================

describe('场景六：QueryEngine 综合查询', () => {
  beforeEach(() => {
    w = initWorld();
  });

  it('在完整世界状态后执行多种查询', async () => {
    const { factStore, manager, knowledgeStore, eventStore } = w;

    // 执行几个事件
    const prop1 = manager.proposeEvent({
      eventType: 'tribulation',
      eventDescription: '张三渡劫金丹期',
      chapter: 50,
      factChanges: [
        { change_id: 'chg_1', op: 'update', target_fact_id: factStore.query({ subject: 'ent_zhangsan', predicate: 'realm' })[0]!.id, value: '金丹期' },
      ],
      subject: 'ent_zhangsan',
    }, factStore);
    manager.commitEvent(prop1.proposalId, factStore, knowledgeStore, eventStore);

    // 查询所有 Fact
    const allFacts = factStore.query({ mode: 'current' });
    expect(allFacts.length).toBeGreaterThan(5);

    // 查询张三的当前状态快照
    const snapshot = factStore.getSnapshot('ent_zhangsan', 50);
    expect(snapshot['realm']).toBe('金丹期');

    // 查询张三知道的所有事情
    const zhangK = knowledgeStore.getKnownFacts('ent_zhangsan', 50);
    expect(zhangK.length).toBeGreaterThan(0);

    // 查询所有事件
    const events = eventStore.getByChapterRange(1, 50);
    // origin + tribulation = 2 business events
    const businessEvents = events.filter(e => e.kind === 'business');
    expect(businessEvents.length).toBeGreaterThanOrEqual(2);

    // 查询实体
    const db = factStore.getDatabase();
    const entities = db.prepare("SELECT * FROM entities WHERE kind = 'entity'").all() as any[];
    expect(entities.length).toBeGreaterThanOrEqual(4);
  });
});

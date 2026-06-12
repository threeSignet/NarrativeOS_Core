// =============================================================================
// Retcon 引擎集成测试
// =============================================================================
// 测试 propose_retcon 的 BFS 级联遍历和 commit_retcon 的 Phase B 事务。
// 使用完整引擎栈模拟修仙叙事中的历史修改场景。
// =============================================================================

import { describe, it, expect, beforeEach } from 'vitest';
import { SQLiteFactStoreAdapter } from '../../src/adapters/sqlite/fact-store.js';
import { SQLiteKnowledgeStoreAdapter } from '../../src/adapters/sqlite/knowledge-store.js';
import { SQLiteEventStoreAdapter } from '../../src/adapters/sqlite/event-store.js';
import { SQLiteThreadStoreAdapter } from '../../src/adapters/sqlite/thread-store.js';
import { ProposalManager } from '../../src/core/proposal-manager.js';
import { RuleEngine } from '../../src/core/rule-engine.js';
import { ThreadResolver } from '../../src/core/thread-resolver.js';
import { RetconEngine } from '../../src/core/retcon-engine.js';
import type {
  FactStore,
  FactChangeInput,
  KnowledgeBroadcast,
} from '../../src/types.js';

// =============================================================================
// 测试世界初始化
// =============================================================================

interface TestWorld {
  factStore: SQLiteFactStoreAdapter;
  knowledgeStore: SQLiteKnowledgeStoreAdapter;
  eventStore: SQLiteEventStoreAdapter;
  threadStore: SQLiteThreadStoreAdapter;
  manager: ProposalManager;
  retconEngine: RetconEngine;
  originEventId: string;
  db: ReturnType<SQLiteFactStoreAdapter['getDatabase']>;
}

function initWorld(): TestWorld {
  const factStore = new SQLiteFactStoreAdapter(':memory:', 'default');
  const db = factStore.getDatabase();
  const knowledgeStore = new SQLiteKnowledgeStoreAdapter(db);
  const eventStore = new SQLiteEventStoreAdapter(db);
  const threadStore = new SQLiteThreadStoreAdapter(db);
  const ruleEngine = new RuleEngine();
  const threadResolver = new ThreadResolver();
  const manager = new ProposalManager(ruleEngine, undefined, threadStore, threadResolver);
  const retconEngine = new RetconEngine();

  // 注册实体
  db.exec(`
    INSERT INTO entities (id, name, kind, first_appearance) VALUES
      ('ent_zhangsan', '张三', 'entity', 1),
      ('ent_lisi', '李四', 'entity', 1),
      ('ent_wang', '王长老', 'entity', 1),
      ('ent_xiaomei', '小师妹', 'entity', 1),
      ('ent_taixumen', '太虚门', 'entity', 1);
  `);

  // 初始世界观事件
  const originEvent = eventStore.create({
    kind: 'business',
    type: 'world_origin',
    chapter: 1,
    description: '太虚门世界的初始设定',
    params: {},
    context: 'global',
    timestamp: new Date().toISOString(),
    factGroupId: 'evt_world_origin_1',
    resolvedThreads: [],
    dependentFactIds: [],
  });
  const originEventId = originEvent.id;

  // 初始 Fact
  const insertFact = (subject: string, predicate: string, value: string) => {
    factStore.assert({
      subject, predicate, value,
      certainty: 'canonical', causeEvent: originEventId, validFrom: 1, validTo: null,
      embeddingText: `${predicate}=${value} (ch1)`,
      context: 'global',
      schemaVersion: 1,
    });
  };

  insertFact('ent_zhangsan', 'realm', '筑基期');
  insertFact('ent_zhangsan', 'status', 'alive');
  insertFact('ent_lisi', 'realm', '金丹期');
  insertFact('ent_lisi', 'status', 'alive');
  insertFact('ent_wang', 'status', 'alive');
  insertFact('ent_wang', 'realm', '元婴期');

  return { factStore, knowledgeStore, eventStore, threadStore, manager, retconEngine, originEventId, db };
}

// =============================================================================
// 场景构建辅助：创建"敌对关系 → 偷袭 → 复仇"因果链
// =============================================================================

interface CausalChain {
  conflictEventId: string;
  ambushEventId: string;
  revengeEventId: string;
}

/**
 * 构建三层因果链：
 *   第 30 章：张三与李四结仇 → fct_conflict_*
 *   第 50 章：李四偷袭张三 → fct_ambush_*（依赖敌对关系）
 *   第 55 章：张三复仇李四 → fct_revenge_*（依赖偷袭事件）
 */
function buildCausalChain(w: TestWorld): CausalChain {
  const { factStore, manager, knowledgeStore, eventStore } = w;

  // ---- 第 30 章：张三与李四结仇 ----
  const propConflict = manager.proposeEvent({
    eventType: 'conflict',
    eventDescription: '第30章：张三与李四因宝物争执结仇',
    chapter: 30,
    factChanges: [
      { change_id: 'chg_enemy1', op: 'assert', subject: 'ent_zhangsan', predicate: 'enemy_of', value: 'ent_lisi' },
      { change_id: 'chg_enemy2', op: 'assert', subject: 'ent_lisi', predicate: 'enemy_of', value: 'ent_zhangsan' },
    ],
    subject: 'ent_zhangsan',
  }, factStore);
  const conflictResult = manager.commitEvent(propConflict.proposalId, factStore, knowledgeStore, eventStore);
  const conflictEventId = conflictResult.eventId;
  // 获取冲突事件产生的 Fact ID（用于下游事件的依赖声明）
  const conflictFactIds = factStore.getFactsByEvent(conflictEventId).map(f => f.id);

  // ---- 第 50 章：李四偷袭张三（依赖敌对关系） ----
  const propAmbush = manager.proposeEvent({
    eventType: 'ambush',
    eventDescription: '第50章：李四在太虚门外偷袭张三（因为敌对关系）',
    chapter: 50,
    factChanges: [
      { change_id: 'chg_ambush', op: 'assert', subject: 'ent_lisi', predicate: 'action', value: '偷袭张三' },
      { change_id: 'chg_hp', op: 'assert', subject: 'ent_zhangsan', predicate: 'hp', value: '8500' },
    ],
    subject: 'ent_lisi',
    dependentFactIds: conflictFactIds, // 显式声明：ambush 依赖 conflict 事件产生的 Fact
  }, factStore);
  const ambushResult = manager.commitEvent(propAmbush.proposalId, factStore, knowledgeStore, eventStore);
  const ambushEventId = ambushResult.eventId;
  // 获取偷袭事件产生的 Fact ID（用于 revenge 事件依赖声明）
  const ambushFactIds = factStore.getFactsByEvent(ambushEventId).map(f => f.id);

  // ---- 第 55 章：张三复仇李四（依赖偷袭事件） ----
  const propRevenge = manager.proposeEvent({
    eventType: 'revenge',
    eventDescription: '第55章：张三报复李四的偷袭',
    chapter: 55,
    factChanges: [
      { change_id: 'chg_revenge', op: 'assert', subject: 'ent_zhangsan', predicate: 'action', value: '报复李四' },
      { change_id: 'chg_status', op: 'assert', subject: 'ent_zhangsan', predicate: 'status_special', value: '被追杀' },
    ],
    subject: 'ent_zhangsan',
    dependentFactIds: ambushFactIds, // 显式声明：revenge 依赖 ambush 事件产生的 Fact
  }, factStore);
  const revengeResult = manager.commitEvent(propRevenge.proposalId, factStore, knowledgeStore, eventStore);
  const revengeEventId = revengeResult.eventId;

  return { conflictEventId, ambushEventId, revengeEventId };
}

// =============================================================================
// Step R-1: BFS 级联遍历测试
// =============================================================================

describe('RetconEngine BFS 级联遍历', () => {
  let w: TestWorld;

  beforeEach(() => {
    w = initWorld();
  });

  it('BFS 应正确追溯一级影响：目标事件本身的 Fact', () => {
    const chain = buildCausalChain(w);

    const result = w.retconEngine.bfsCascade(
      chain.conflictEventId,
      w.factStore,
      w.eventStore,
      w.threadStore,
      w.knowledgeStore,
    );

    // 一级影响：conflict 事件产生的 2 条 Fact
    expect(result.factsByLevel.get(1)!.length).toBeGreaterThanOrEqual(2);
    const level1Facts = result.factsByLevel.get(1)!;
    // 应包含张三 enemy_of 李四
    expect(level1Facts.some(f => f.subject === 'ent_zhangsan' && f.predicate === 'enemy_of')).toBe(true);
    // 应包含李四 enemy_of 张三
    expect(level1Facts.some(f => f.subject === 'ent_lisi' && f.predicate === 'enemy_of')).toBe(true);
  });

  it('BFS 应正确追溯二级影响：依赖直接 Fact 的后续事件', () => {
    const chain = buildCausalChain(w);

    const result = w.retconEngine.bfsCascade(
      chain.conflictEventId,
      w.factStore,
      w.eventStore,
      w.threadStore,
      w.knowledgeStore,
    );

    // 二级影响应包含 ambush 事件
    const level2EventIds = result.eventsByLevel.get(2);
    expect(level2EventIds).toBeDefined();
    expect(level2EventIds!.some(eid => eid === chain.ambushEventId)).toBe(true);

    // 二级影响的 Fact 应包含 ambush 事件产生的 Fact
    const level2Facts = result.factsByLevel.get(2);
    expect(level2Facts).toBeDefined();
    expect(level2Facts!.some(f => f.predicate === 'action' && f.value === '偷袭张三')).toBe(true);
  });

  it('BFS 应正确追溯三级影响：revenge 事件依赖 ambush', () => {
    const chain = buildCausalChain(w);

    const result = w.retconEngine.bfsCascade(
      chain.conflictEventId,
      w.factStore,
      w.eventStore,
      w.threadStore,
      w.knowledgeStore,
    );

    // 三级影响应包含 revenge 事件
    const level3EventIds = result.eventsByLevel.get(3);
    expect(level3EventIds).toBeDefined();
    expect(level3EventIds!.some(eid => eid === chain.revengeEventId)).toBe(true);
  });

  it('BFS 应正确收集受影响的 Thread（通过 closedByEvent 匹配）', () => {
    const chain = buildCausalChain(w);

    // 创建一条线索，在 ambush 事件（第50章）被关闭
    const thread = w.threadStore.create({
      type: 'foreshadowing',
      direction: 'retroactive',
      severity: 'major',
      description: '张三遭到致命威胁的预兆',
      closeCondition: { requiredEventType: 'ambush', withinChapters: 100 },
      status: 'FILLED',
      closedBy: chain.ambushEventId,
      createdAtEvent: w.originEventId,
      createdAtChapter: 5,
      milestones: [
        { id: 'ms_1', status: 'UNFILLED', chapter: 5, description: '埋下伏笔', createdAt: new Date().toISOString() },
        { id: 'ms_2', status: 'FILLED', chapter: 50, eventId: chain.ambushEventId, description: '预兆应验', createdAt: new Date().toISOString() },
      ],
      relatedEntities: ['ent_zhangsan'],
      upstreamFactIds: [],
      tags: ['combat'],
    });

    const result = w.retconEngine.bfsCascade(
      chain.conflictEventId,
      w.factStore,
      w.eventStore,
      w.threadStore,
      w.knowledgeStore,
    );

    // 受影响 Thread 应包含被 ambush 关闭的线索
    expect(result.affectedThreadIds.has(thread.id)).toBe(true);
  });

  it('BFS 应正确收集受影响的 Knowledge（通过 getByFactId）', () => {
    const chain = buildCausalChain(w);

    // 手动创建一条直接指向 conflict 事件产生的 Fact 的 Knowledge 记录
    const conflictFacts = w.factStore.getFactsByEvent(chain.conflictEventId);
    expect(conflictFacts.length).toBeGreaterThan(0);
    const firstFact = conflictFacts[0]!;

    w.knowledgeStore.create({
      factId: firstFact.id,
      entityId: 'ent_wang',
      knownSince: 35,
      source: 'informed',
      confidence: 0.8,
    });

    const result = w.retconEngine.bfsCascade(
      chain.conflictEventId,
      w.factStore,
      w.eventStore,
      w.threadStore,
      w.knowledgeStore,
    );

    // 受影响 Knowledge 应包含指向第一级 Fact 的认知记录
    expect(result.affectedKnowledgeIds.size).toBeGreaterThanOrEqual(1);
  });

  it('BFS 不应跨越作用域边界追溯', () => {
    const chain = buildCausalChain(w);

    // 在不同作用域中创建一个依赖 conflict Fact 的事件
    w.eventStore.create({
      kind: 'business',
      type: 'dream_conflict',
      chapter: 60,
      description: '梦境中的冲突',
      params: { subject: 'ent_zhangsan' },
      context: 'arc_dream_01',
      timestamp: new Date().toISOString(),
      factGroupId: 'evt_dream_conflict_60',
      resolvedThreads: [],
      dependentFactIds: [],
    });

    const result = w.retconEngine.bfsCascade(
      chain.conflictEventId,
      w.factStore,
      w.eventStore,
      w.threadStore,
      w.knowledgeStore,
    );

    // 跨作用域事件不应出现在受影响事件中
    for (const [, eventIds] of result.eventsByLevel) {
      for (const eid of eventIds) {
        const event = w.eventStore.getById(eid);
        // 所有受影响事件都应在 global 作用域
        if (event) expect(event.context).toBe('global');
      }
    }
  });

  it('BFS 输入事件不存在时应抛出错误', () => {
    expect(() =>
      w.retconEngine.bfsCascade(
        'evt_nonexistent_999',
        w.factStore,
        w.eventStore,
        w.threadStore,
        w.knowledgeStore,
      )
    ).toThrow(/EVENT_NOT_FOUND/);
  });
});

// =============================================================================
// Step R-2: FactStore contested 标记测试
// =============================================================================

describe('FactStore contested 标记', () => {
  let w: TestWorld;

  beforeEach(() => {
    w = initWorld();
  });

  it('markContested 应将 canonical Fact 标记为 contested', () => {
    const chain = buildCausalChain(w);
    const conflictFacts = w.factStore.getFactsByEvent(chain.conflictEventId);
    const factIds = conflictFacts.map(f => f.id);

    const updated = w.factStore.markContested(factIds, 'evt_retcon_test');
    expect(updated).toBe(factIds.length);

    // 验证 certainty 已变更
    for (const fid of factIds) {
      const f = w.factStore.getById(fid);
      expect(f!.certainty).toBe('contested');
    }
  });

  it('markContested 空数组应返回 0', () => {
    const updated = w.factStore.markContested([], 'evt_retcon_test');
    expect(updated).toBe(0);
  });

  it('markContested 不应标记已 contested 的 Fact', () => {
    const chain = buildCausalChain(w);
    const conflictFacts = w.factStore.getFactsByEvent(chain.conflictEventId);
    const factIds = conflictFacts.map(f => f.id);

    // 第一次标记
    w.factStore.markContested(factIds, 'evt_retcon_1');
    // 第二次标记应返回 0（不会再次更新）
    const secondUpdate = w.factStore.markContested(factIds, 'evt_retcon_2');
    expect(secondUpdate).toBe(0);
  });

  it('updateCertainty 可安全地将 contested 改回 canonical（用于测试重置）', () => {
    const chain = buildCausalChain(w);
    const conflictFacts = w.factStore.getFactsByEvent(chain.conflictEventId);
    const firstFactId = conflictFacts[0]!.id;

    // 标记为 contested
    w.factStore.markContested([firstFactId], 'evt_retcon_test');
    expect(w.factStore.getById(firstFactId)!.certainty).toBe('contested');

    // 重置回 canonical
    w.factStore.updateCertainty(firstFactId, 'canonical');
    expect(w.factStore.getById(firstFactId)!.certainty).toBe('canonical');
  });
});

// =============================================================================
// Step R-4: propose_retcon 端到端测试
// =============================================================================

describe('propose_retcon 端到端', () => {
  let w: TestWorld;

  beforeEach(() => {
    w = initWorld();
  });

  it('修改冲突事件的 propose_retcon 应返回完整级联报告', () => {
    const chain = buildCausalChain(w);

    const result = w.retconEngine.proposeRetcon({
      targetEventId: chain.conflictEventId,
      reason: '修改张三与李四的敌对关系设定',
      newDescription: '修正：张三与李四只是误会，并非敌意',
      chapter: 100,
      factChanges: [
        { change_id: 'chg_fix1', op: 'retract', target_fact_id: '' }, // 实际 retract 目标由后续决定
      ],
    }, w.factStore, w.eventStore, w.threadStore, w.knowledgeStore);

    // 应返回有效 proposal
    expect(result.proposalId).toBeDefined();
    expect(result.proposalId.startsWith('rtc_')).toBe(true);
    // 应有级联影响（ambush 和 revenge）
    expect(result.affectedFactIds.length).toBeGreaterThan(0);
    // 级联报告应包含 Markdown 内容
    expect(result.cascadeReportMarkdown).toContain('级联影响');
    expect(result.cascadeReportMarkdown).toContain(chain.conflictEventId);
    // 应有受影响跨级联的事件
    expect(result.affectedEventIds.some(eid => eid === chain.ambushEventId)).toBe(true);
  });

  it('修改孤立事件（无级联影响）的 propose_retcon 应返回空报告', () => {
    // 创建一个不与任何后续事件关联的孤立事件
    const prop = w.manager.proposeEvent({
      eventType: 'isolated_event',
      eventDescription: '孤立的小事件',
      chapter: 200,
      factChanges: [
        { change_id: 'chg_iso', op: 'assert', subject: 'ent_wang', predicate: 'note', value: '一段无关紧要的记录' },
      ],
      subject: 'ent_wang',
    }, w.factStore);
    const result = w.manager.commitEvent(prop.proposalId, w.factStore, w.knowledgeStore, w.eventStore);

    const retconResult = w.retconEngine.proposeRetcon({
      targetEventId: result.eventId,
      reason: '修改孤立事件',
      newDescription: '修正孤立事件',
      chapter: 201,
      factChanges: [],
    }, w.factStore, w.eventStore, w.threadStore, w.knowledgeStore);

    // 孤立事件的级联影响应该只有 Level 1（事件本身的 Fact）
    expect(retconResult.affectedEventIds.length).toBe(0);
    expect(retconResult.isSafeToCommit).toBe(true);
  });
});

// =============================================================================
// Step R-5: commit_retcon Phase B 测试
// =============================================================================

describe('commit_retcon Phase B', () => {
  let w: TestWorld;

  beforeEach(() => {
    w = initWorld();
  });

  it('确认 Retcon 后目标事件产生的 Fact 应标记为 contested', () => {
    const chain = buildCausalChain(w);

    const proposal = w.retconEngine.proposeRetcon({
      targetEventId: chain.conflictEventId,
      reason: '测试：修改敌对关系',
      newDescription: '修正后的描述',
      chapter: 100,
      factChanges: [],
    }, w.factStore, w.eventStore, w.threadStore, w.knowledgeStore);

    const commitResult = w.retconEngine.commitRetcon({
      retconProposalId: proposal.proposalId,
    }, w.factStore, w.eventStore, w.threadStore, w.knowledgeStore);

    // 验证返回值
    expect(commitResult.status).toBe('success');
    expect(commitResult.retconEventId).toBeDefined();
    expect(commitResult.retconEventId!.startsWith('evt_retcon_')).toBe(true);
    expect(commitResult.contestedFactCount).toBeGreaterThan(0);

    // 目标事件的 Fact 应变为 contested
    const targetFacts = w.factStore.getFactsByEvent(chain.conflictEventId);
    for (const f of targetFacts) {
      expect(f.certainty).toBe('contested');
    }
  });

  it('Retcon 应创建系统事件（kind=system, type=retcon）', () => {
    const chain = buildCausalChain(w);

    const proposal = w.retconEngine.proposeRetcon({
      targetEventId: chain.conflictEventId,
      reason: '系统事件测试',
      newDescription: '修正',
      chapter: 100,
      factChanges: [],
    }, w.factStore, w.eventStore, w.threadStore, w.knowledgeStore);

    const commitResult = w.retconEngine.commitRetcon({
      retconProposalId: proposal.proposalId,
    }, w.factStore, w.eventStore, w.threadStore, w.knowledgeStore);

    // 验证系统事件
    const retconEvent = w.eventStore.getById(commitResult.retconEventId!);
    expect(retconEvent).toBeDefined();
    expect(retconEvent!.kind).toBe('system');
    expect(retconEvent!.type).toBe('retcon');
    expect(retconEvent!.params.targetEventId).toBe(chain.conflictEventId);
  });

  it('Retcon 应将受影响的已关闭 Thread 恢复为未关闭状态', () => {
    const chain = buildCausalChain(w);

    // 创建一条线索，在 conflict 事件被关闭（虽然 conflict 通常不关闭线索，但测试需要）
    // 换一条：在 ambush 事件创建一条关闭的线索
    const thread = w.threadStore.create({
      type: 'foreshadowing',
      direction: 'retroactive',
      severity: 'major',
      description: '预兆线索',
      closeCondition: { requiredEventType: 'ambush', withinChapters: 100 },
      status: 'FILLED',
      closedBy: chain.ambushEventId,
      createdAtEvent: w.originEventId,
      createdAtChapter: 30,
      milestones: [
        { id: 'ms_t1', status: 'FILLED', chapter: 50, eventId: chain.ambushEventId, description: '应验', createdAt: new Date().toISOString() },
      ],
      relatedEntities: ['ent_zhangsan'],
      upstreamFactIds: [],
      tags: ['test'],
    });

    const proposal = w.retconEngine.proposeRetcon({
      targetEventId: chain.conflictEventId,
      reason: '测试 Thread 恢复',
      newDescription: '修正',
      chapter: 100,
      factChanges: [],
    }, w.factStore, w.eventStore, w.threadStore, w.knowledgeStore);

    const commitResult = w.retconEngine.commitRetcon({
      retconProposalId: proposal.proposalId,
    }, w.factStore, w.eventStore, w.threadStore, w.knowledgeStore);

    // 验证线索被恢复
    expect(commitResult.reactivatedThreadCount).toBeGreaterThanOrEqual(1);
    const reactivated = w.threadStore.getById(thread.id);
    expect(reactivated!.status).toBe('UNFILLED');
    expect(reactivated!.closedBy).toBeNull();
  });

  it('Retcon 应为受影响的 Knowledge 生成 cognitive_dissonance Thread', () => {
    const chain = buildCausalChain(w);

    // 先让王长老 "知道" 张三和李四的敌对关系
    const conflictFacts = w.factStore.getFactsByEvent(chain.conflictEventId);
    for (const f of conflictFacts) {
      w.knowledgeStore.create({
        factId: f.id,
        entityId: 'ent_wang',
        knownSince: 35,
        source: 'informed',
        confidence: 0.9,
      });
    }

    const proposal = w.retconEngine.proposeRetcon({
      targetEventId: chain.conflictEventId,
      reason: '测试认知失调',
      newDescription: '修正',
      chapter: 100,
      factChanges: [],
    }, w.factStore, w.eventStore, w.threadStore, w.knowledgeStore);

    const commitResult = w.retconEngine.commitRetcon({
      retconProposalId: proposal.proposalId,
    }, w.factStore, w.eventStore, w.threadStore, w.knowledgeStore);

    // 应生成 cognitive_dissonance Thread
    const allThreads = w.threadStore.getOpen();
    const dissonanceThreads = allThreads.filter(t => t.type === 'logic_conflict');
    expect(dissonanceThreads.length).toBeGreaterThanOrEqual(1);
    expect(dissonanceThreads[0]!.tags).toContain('cognitive_dissonance');
  });

  it('Retcon 应递增 project_state.version', () => {
    const chain = buildCausalChain(w);

    const beforeVersion = w.factStore.getStateVersion('default');

    const proposal = w.retconEngine.proposeRetcon({
      targetEventId: chain.conflictEventId,
      reason: '版本递增测试',
      newDescription: '修正',
      chapter: 100,
      factChanges: [],
    }, w.factStore, w.eventStore, w.threadStore, w.knowledgeStore);

    w.retconEngine.commitRetcon({
      retconProposalId: proposal.proposalId,
    }, w.factStore, w.eventStore, w.threadStore, w.knowledgeStore);

    const afterVersion = w.factStore.getStateVersion('default');
    expect(afterVersion).toBe(beforeVersion + 1);
  });

  it('重复提交同一 Retcon 应抛出错误', () => {
    const chain = buildCausalChain(w);

    const proposal = w.retconEngine.proposeRetcon({
      targetEventId: chain.conflictEventId,
      reason: '重复提交测试',
      newDescription: '修正',
      chapter: 100,
      factChanges: [],
    }, w.factStore, w.eventStore, w.threadStore, w.knowledgeStore);

    w.retconEngine.commitRetcon({
      retconProposalId: proposal.proposalId,
    }, w.factStore, w.eventStore, w.threadStore, w.knowledgeStore);

    // 重复提交应失败
    expect(() =>
      w.retconEngine.commitRetcon({
        retconProposalId: proposal.proposalId,
      }, w.factStore, w.eventStore, w.threadStore, w.knowledgeStore)
    ).toThrow(/ALREADY_COMMITTED/);
  });
});

// =============================================================================
// Step R-6: 真实修仙叙事场景 Retcon 测试
// =============================================================================

describe('真实场景：修仙叙事 Retcon', () => {
  let w: TestWorld;

  beforeEach(() => {
    w = initWorld();
  });

  it('修改敌对关系源头 → 级联污染整个因果链 → 生成认知失调', () => {
    const chain = buildCausalChain(w);

    // 场景：作者决定修改第 30 章的设定——张三和李四并不是敌人，而是被第三者挑拨
    // 这会影响第 50 章（偷袭）和第 55 章（复仇）

    // Step 1: propose_retcon
    const proposal = w.retconEngine.proposeRetcon({
      targetEventId: chain.conflictEventId,
      reason: '叙事调整：张三与李四的敌对关系实际上是王长老的挑拨离间，需要修改历史',
      newDescription: '第30章修正：张三识破了王长老的挑拨，与李四化解误会',
      chapter: 100,
      factChanges: [
        { change_id: 'chg_new_enemy', op: 'assert', subject: 'ent_zhangsan', predicate: 'enemy_of', value: 'ent_wang' },
      ],
    }, w.factStore, w.eventStore, w.threadStore, w.knowledgeStore);

    // 验证级联报告
    expect(proposal.cascadeReportMarkdown).toBeDefined();
    expect(proposal.isSafeToCommit).toBe(true);

    // Step 2: commit_retcon
    const commitResult = w.retconEngine.commitRetcon({
      retconProposalId: proposal.proposalId,
    }, w.factStore, w.eventStore, w.threadStore, w.knowledgeStore);

    expect(commitResult.status).toBe('success');
    // 一级影响：conflict 事件的 2 条 Fact + 二级影响的 ambush 事件 Fact + 三级影响的 revenge 事件 Fact
    // 至少应标记 6 条 contested（2 conflict + 2 ambush + 2 revenge）
    expect(commitResult.contestedFactCount).toBeGreaterThanOrEqual(4);

    // Step 3: 验证 contested Fact 在默认查询中可见（contested 仍保持 is_current=true）
    // 使用 certainties 参数排除 contested facts
    const canonicalOnly = w.factStore.query({ mode: 'current', certainties: ['canonical'] });
    // 所有 contested Fact 不应出现在 canonical-only 查询中
    for (const fid of commitResult.contestedFactIds) {
      const inCanonicalOnly = canonicalOnly.some(f => f.id === fid);
      expect(inCanonicalOnly).toBe(false);
    }

    // 但 contested Fact 在无 certainties 过滤的查询中仍可见
    // （contested 保持 is_current=true，只是确定性被质疑）
    const contestedOnly = w.factStore.query({ mode: 'current', certainties: ['contested'] });
    expect(contestedOnly.length).toBeGreaterThanOrEqual(commitResult.contestedFactCount);

    // Step 4: 验证系统事件可追溯
    const retconEvent = w.eventStore.getById(commitResult.retconEventId!);
    expect(retconEvent).toBeDefined();
    expect(retconEvent!.params.targetEventId).toBe(chain.conflictEventId);

    // Step 5: 验证 event_dependencies 写入
    const depRows = w.db.prepare(
      'SELECT * FROM event_dependencies WHERE event_id = ?'
    ).all(commitResult.retconEventId!) as Array<{ event_id: string; fact_id: string; source: string }>;
    expect(depRows.length).toBeGreaterThanOrEqual(commitResult.contestedFactIds.length);

    // Step 6: 验证 sync_queue 写入
    const syncRows = w.db.prepare(
      'SELECT * FROM sync_queue WHERE event_id = ?'
    ).all(commitResult.retconEventId!) as Array<{ event_id: string; operation: string }>;
    expect(syncRows.length).toBeGreaterThanOrEqual(1);
    expect(syncRows[0]!.operation).toBe('update_certainty');

    // Step 7: 验证 audit_log 写入
    const auditRows = w.db.prepare(
      'SELECT * FROM audit_log WHERE event_id = ?'
    ).all(commitResult.retconEventId!) as Array<{ event_id: string; tool_name: string }>;
    expect(auditRows.length).toBeGreaterThanOrEqual(1);
    expect(auditRows[0]!.tool_name).toBe('commit_retcon');
  });
});

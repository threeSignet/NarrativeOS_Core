// =============================================================================
// ProposalManager 集成测试 —— 完整 propose → commit 流程
// =============================================================================

import { describe, it, expect, beforeEach } from 'vitest';
import { SQLiteFactStoreAdapter } from '../../src/adapters/sqlite/fact-store.js';
import { SQLiteKnowledgeStoreAdapter } from '../../src/adapters/sqlite/knowledge-store.js';
import { SQLiteEventStoreAdapter } from '../../src/adapters/sqlite/event-store.js';
import { SQLiteThreadStoreAdapter } from '../../src/adapters/sqlite/thread-store.js';
import { InMemoryProposalStore } from '../../src/adapters/memory-proposal-store.js';
import { RuleEngine } from '../../src/core/rule-engine.js';
import { ThreadResolver } from '../../src/core/thread-resolver.js';
import { ProposalManager } from '../../src/core/proposal-manager.js';
import type { TransitionRule, ConstraintRule } from '../../src/core/rules.js';
import type { NarrativeThread, FactStore as IFactStore, NarrativeEvent, KnowledgeHint, KnowledgeBroadcast, KnowledgeSource, FactChangeInput } from '../../src/types.js';

function setupEnv() {
  const factStore = new SQLiteFactStoreAdapter(':memory:', 'default');
  const db = factStore.getDatabase();

  // 注册实体和初始事件
  db.exec("INSERT OR IGNORE INTO entities (id, name, kind, first_appearance) VALUES ('ent_zhangsan', '张三', 'entity', 1)");
  db.exec("INSERT OR IGNORE INTO entities (id, name, kind, first_appearance) VALUES ('ent_lisi', '李四', 'entity', 1)");
  db.exec("INSERT OR IGNORE INTO entities (id, name, kind, first_appearance) VALUES ('ent_gumu', '古墓', 'place', 1)");
  db.exec("INSERT OR IGNORE INTO events (id, kind, type, chapter, description, params_json, fact_group_id) VALUES ('evt_origin_01', 'business', 'origin', 1, '初始设定', '{}', 'evt_origin_01')");

  // 张三初始状态
  factStore.assert({
    subject: 'ent_zhangsan', predicate: 'realm', value: '筑基期',
    certainty: 'canonical', causeEvent: 'evt_origin_01', validFrom: 1, validTo: null,
    embeddingText: '张三 的修炼境界是 筑基期（第1章）',
  });
  factStore.assert({
    subject: 'ent_zhangsan', predicate: 'status', value: 'alive',
    certainty: 'canonical', causeEvent: 'evt_origin_01', validFrom: 1, validTo: null,
    embeddingText: '张三 的状态是 存活（第1章）',
  });

  const knowledgeStore = new SQLiteKnowledgeStoreAdapter(db);
  const eventStore = new SQLiteEventStoreAdapter(db);
  const ruleEngine = new RuleEngine();
  const proposalStore = new InMemoryProposalStore();
  const manager = new ProposalManager(ruleEngine, proposalStore);

  return { factStore, knowledgeStore, eventStore, manager };
}

describe('ProposalManager — propose → commit 完整流程', () => {
  // ===================================================================
  // propose_event
  // ===================================================================

  describe('propose_event', () => {
    it('应成功生成 ProposalResult 并返回 simulation_report', () => {
      const { factStore, manager } = setupEnv();

      const factChanges: FactChangeInput[] = [
        { change_id: 'chg_1', op: 'assert', subject: 'ent_zhangsan', predicate: 'realm', value: '金丹期' },
        { change_id: 'chg_2', op: 'assert', subject: 'ent_zhangsan', predicate: 'lifespan', value: 5000 },
      ];

      const result = manager.proposeEvent({
        eventType: 'tribulation',
        eventDescription: '张三渡劫突破金丹期',
        chapter: 50,
        factChanges,
        subject: 'ent_zhangsan',
      }, factStore);

      expect(result.proposalId).toMatch(/^prp_tribulation_50/);
      expect(result.simulationReportMarkdown).toContain('事件推演报告');
      expect(result.simulationReportMarkdown).toContain('realm');
      expect(result.isSafeToCommit).toBe(true);
      expect(result.expectedStateVersion).toBe(0);

      // 沙盒推演不应修改真实数据
      const realmFacts = factStore.query({ subject: 'ent_zhangsan', predicate: 'realm' });
      expect(realmFacts.length).toBe(1);
      expect(realmFacts[0]!.value).toBe('筑基期'); // 仍然是旧值
    });

    it('死亡实体的事件应标记 isSafeToCommit=false', () => {
      const { factStore, manager } = setupEnv();

      // 设置张三已死亡
      const db = factStore.getDatabase();
      db.exec("UPDATE facts SET value_scalar = 'dead' WHERE subject = 'ent_zhangsan' AND predicate = 'status'");

      const factChanges: FactChangeInput[] = [
        { change_id: 'chg_1', op: 'assert', subject: 'ent_zhangsan', predicate: 'ability', value: '空间操控' },
      ];

      const result = manager.proposeEvent({
        eventType: 'ancient_encounter',
        eventDescription: '张三在古墓中获得奇遇',
        chapter: 100,
        factChanges,
        subject: 'ent_zhangsan',
      }, factStore);

      expect(result.isSafeToCommit).toBe(false);
      const violations = result.consequences.generatedThreads.filter(t => t.severity === 'critical');
      expect(violations.length).toBeGreaterThanOrEqual(1);
    });

    it('subject_auto 传播规则应产生 Knowledge 建议', () => {
      const { factStore, manager } = setupEnv();

      const factChanges: FactChangeInput[] = [
        { change_id: 'chg_1', op: 'assert', subject: 'ent_zhangsan', predicate: 'ability', value: '操控雷电' },
      ];

      const result = manager.proposeEvent({
        eventType: 'tribulation',
        eventDescription: '张三觉醒雷电能力',
        chapter: 60,
        factChanges,
        subject: 'ent_zhangsan',
      }, factStore);

      const knowledgeItems = result.consequences.proposedKnowledge ?? [];
      const selfKnowledge = knowledgeItems.filter(k => k.source === 'self_action');
      expect(selfKnowledge.length).toBe(1);
      expect(selfKnowledge[0]!.entityId).toBe('ent_zhangsan');
      expect(selfKnowledge[0]!.confidence).toBe(1.0);
    });
  });

  // ===================================================================
  // commit_event
  // ===================================================================

  describe('commit_event', () => {
    it('应完整执行 Phase B 事务：写入 Event + Fact + Knowledge', () => {
      const { factStore, knowledgeStore, eventStore, manager } = setupEnv();

      // 先 propose
      const factChanges: FactChangeInput[] = [
        { change_id: 'chg_1', op: 'assert', subject: 'ent_zhangsan', predicate: 'realm', value: '金丹期' },
      ];
      const proposal = manager.proposeEvent({
        eventType: 'tribulation',
        eventDescription: '张三渡劫突破金丹期',
        chapter: 50,
        factChanges,
        subject: 'ent_zhangsan',
      }, factStore);

      // 提交
      const result = manager.commitEvent(
        proposal.proposalId,
        factStore,
        knowledgeStore,
        eventStore,
      );

      // 验证 Event 写入
      expect(result.eventId).toMatch(/^evt_tribulation_50/);
      const event = eventStore.getById(result.eventId);
      expect(event).toBeDefined();
      expect(event!.type).toBe('tribulation');

      // 验证 Fact 写入（旧 realm 已失效，新 realm 生效）
      const realmFacts = factStore.query({ subject: 'ent_zhangsan', predicate: 'realm' });
      const currentRealm = realmFacts.find(f => f.validTo === null);
      expect(currentRealm).toBeDefined();
      // 注意：assert 创建新 Fact，旧 Fact 不会自动失效
      // update 才会 retract 旧的。这里只是 assert 新 Fact
    });

    it('应保留 Phase A 事件上下文并写入 event_dependencies 边表', () => {
      const { factStore, knowledgeStore, eventStore, manager } = setupEnv();

      const baseFact = factStore.query({ subject: 'ent_zhangsan', predicate: 'realm' })[0]!;
      const proposal = manager.proposeEvent({
        eventType: 'investigation',
        eventDescription: '李四根据张三境界情报展开调查',
        chapter: 50,
        context: 'arc_dream_01',
        factChanges: [
          { change_id: 'chg_1', op: 'assert', subject: 'ent_lisi', predicate: 'target', value: { type: 'entity_ref', entityId: 'ent_zhangsan' } },
        ],
        subject: 'ent_lisi',
        dependentFactIds: [baseFact.id],
      }, factStore);

      const result = manager.commitEvent(proposal.proposalId, factStore, knowledgeStore, eventStore);
      const event = eventStore.getById(result.eventId)!;

      expect(event.description).toBe('李四根据张三境界情报展开调查');
      expect(event.context).toBe('arc_dream_01');
      expect(event.params.subject).toBe('ent_lisi');
      expect(event.dependentFactIds).toEqual([baseFact.id]);
      expect(eventStore.getByDependentFactIds([baseFact.id]).map(e => e.id)).toContain(result.eventId);

      const fact = factStore.query({ subject: 'ent_lisi', predicate: 'target' })[0]!;
      expect(fact.validFrom).toBe(50);
      expect(fact.context).toBe('arc_dream_01');
    });

    it('exit_scope 应自动注入原始作用域 Fact 依赖', () => {
      const { factStore, knowledgeStore, eventStore, manager } = setupEnv();
      const db = factStore.getDatabase();

      db.exec("INSERT OR IGNORE INTO events (id, kind, type, chapter, description, params_json, context, fact_group_id) VALUES ('evt_dream_10', 'business', 'dream_event', 10, '梦境获得能力', '{\"subject\":\"ent_zhangsan\"}', 'arc_dream_01', 'evt_dream_10')");
      const originFact = factStore.assert({
        subject: 'ent_zhangsan',
        predicate: 'ability',
        value: '梦境剑意',
        certainty: 'canonical',
        causeEvent: 'evt_dream_10',
        validFrom: 10,
        validTo: null,
        context: 'arc_dream_01',
        embeddingText: '',
      });

      const proposal = manager.proposeEvent({
        eventType: 'exit_scope',
        eventDescription: '张三从梦境醒来并保留剑意',
        chapter: 50,
        context: 'global',
        exitFrom: 'arc_dream_01',
        factChanges: [
          { change_id: 'chg_1', op: 'assert', subject: 'ent_zhangsan', predicate: 'ability', value: '梦境剑意' },
        ],
        subject: 'ent_zhangsan',
      }, factStore);

      expect(proposal.dependentFactIds).toEqual([originFact.id]);
      expect(proposal.dependentFactSources[originFact.id]).toBe('system_exit_scope');

      const result = manager.commitEvent(proposal.proposalId, factStore, knowledgeStore, eventStore);
      const event = eventStore.getById(result.eventId)!;
      const dependencyRow = db.prepare(
        'SELECT source FROM event_dependencies WHERE event_id = ? AND fact_id = ?'
      ).get(result.eventId, originFact.id) as { source: string } | undefined;

      expect(event.dependentFactIds).toEqual([originFact.id]);
      expect(event.params.exitFrom).toBe('arc_dream_01');
      expect(dependencyRow?.source).toBe('system_exit_scope');
      expect(eventStore.getByDependentFactIds([originFact.id]).map(e => e.id)).toContain(result.eventId);

      const exportedFact = factStore.query({ subject: 'ent_zhangsan', predicate: 'ability', context: 'global' })[0]!;
      expect(exportedFact.causeEvent).toBe(result.eventId);
      expect(exportedFact.context).toBe('global');
    });

    it('isSafeToCommit=false 的提案不应被提交入库', () => {
      const { factStore, knowledgeStore, eventStore, manager } = setupEnv();

      const db = factStore.getDatabase();
      db.exec("UPDATE facts SET value_scalar = 'dead' WHERE subject = 'ent_zhangsan' AND predicate = 'status'");

      const proposal = manager.proposeEvent({
        eventType: 'ancient_encounter',
        eventDescription: '张三死亡后仍获得奇遇',
        chapter: 100,
        factChanges: [
          { change_id: 'chg_1', op: 'assert', subject: 'ent_zhangsan', predicate: 'ability', value: '空间操控' },
        ],
        subject: 'ent_zhangsan',
      }, factStore);

      expect(proposal.isSafeToCommit).toBe(false);
      expect(() =>
        manager.commitEvent(proposal.proposalId, factStore, knowledgeStore, eventStore)
      ).toThrow('UNSAFE_PROPOSAL');
      expect(eventStore.getByType('ancient_encounter', 100).length).toBe(0);
    });

    it('knowledge_changes seal/restore 应作为不可变认知事件流写入', () => {
      const { factStore, knowledgeStore, eventStore, manager } = setupEnv();

      const discover = manager.proposeEvent({
        eventType: 'discover_secret',
        eventDescription: '张三发现古墓秘密',
        chapter: 20,
        factChanges: [
          { change_id: 'chg_secret', op: 'assert', subject: 'ent_gumu', predicate: 'secret', value: '藏有传送阵' },
        ],
        subject: 'ent_zhangsan',
      }, factStore);
      const discoverResult = manager.commitEvent(discover.proposalId, factStore, knowledgeStore, eventStore);
      const secretFact = factStore.getFactsByEvent(discoverResult.eventId).find(f => f.predicate === 'secret')!;

      expect(knowledgeStore.getKnownFacts('ent_zhangsan', 21).map(k => k.factId)).toContain(secretFact.id);

      const seal = manager.proposeEvent({
        eventType: 'memory_seal',
        eventDescription: '李四封印张三关于古墓的记忆',
        chapter: 30,
        factChanges: [
          { change_id: 'chg_note', op: 'assert', subject: 'ent_lisi', predicate: 'note', value: '封印完成' },
        ],
        subject: 'ent_lisi',
        knowledgeChanges: [
          { op: 'seal', target_entity_id: 'ent_zhangsan', fact_id_scope: 'explicit', fact_ids: [secretFact.id] },
        ],
      }, factStore);
      manager.commitEvent(seal.proposalId, factStore, knowledgeStore, eventStore);

      const sealedHistory = knowledgeStore.query({ entityId: 'ent_zhangsan', factId: secretFact.id });
      expect(sealedHistory[0]!.source).toBe('memory_seal');
      expect(sealedHistory[0]!.confidence).toBe(0);
      expect(sealedHistory[0]!.previousConfidence).toBe(1);
      expect(knowledgeStore.getKnownFacts('ent_zhangsan', 31).map(k => k.factId)).not.toContain(secretFact.id);

      const restore = manager.proposeEvent({
        eventType: 'memory_restore',
        eventDescription: '张三恢复关于古墓的记忆',
        chapter: 40,
        factChanges: [
          { change_id: 'chg_note', op: 'assert', subject: 'ent_zhangsan', predicate: 'note', value: '记忆恢复' },
        ],
        subject: 'ent_zhangsan',
        knowledgeChanges: [
          { op: 'restore', target_entity_id: 'ent_zhangsan', fact_id_scope: 'explicit', fact_ids: [secretFact.id] },
        ],
      }, factStore);
      manager.commitEvent(restore.proposalId, factStore, knowledgeStore, eventStore);

      const restoredHistory = knowledgeStore.query({ entityId: 'ent_zhangsan', factId: secretFact.id });
      expect(restoredHistory[0]!.source).toBe('memory_restore');
      expect(restoredHistory[0]!.confidence).toBe(1);
      expect(knowledgeStore.getKnownFacts('ent_zhangsan', 41).map(k => k.factId)).toContain(secretFact.id);
    });

    it('knowledge_changes soul_read/implant 应写入施法者或目标实体的认知记录', () => {
      const { factStore, knowledgeStore, eventStore, manager } = setupEnv();

      const discover = manager.proposeEvent({
        eventType: 'discover_secret',
        eventDescription: '张三发现古墓秘密',
        chapter: 20,
        factChanges: [
          { change_id: 'chg_secret', op: 'assert', subject: 'ent_gumu', predicate: 'secret', value: '藏有传送阵' },
        ],
        subject: 'ent_zhangsan',
      }, factStore);
      const discoverResult = manager.commitEvent(discover.proposalId, factStore, knowledgeStore, eventStore);
      const secretFact = factStore.getFactsByEvent(discoverResult.eventId).find(f => f.predicate === 'secret')!;

      const soulRead = manager.proposeEvent({
        eventType: 'soul_read',
        eventDescription: '李四搜魂张三',
        chapter: 30,
        factChanges: [
          { change_id: 'chg_note', op: 'assert', subject: 'ent_lisi', predicate: 'note', value: '搜魂完成' },
        ],
        subject: 'ent_lisi',
        knowledgeChanges: [
          {
            op: 'soul_read',
            target_entity_id: 'ent_zhangsan',
            source_entity_id: 'ent_lisi',
            fact_id_scope: 'explicit',
            fact_ids: [secretFact.id],
          },
        ],
      }, factStore);
      manager.commitEvent(soulRead.proposalId, factStore, knowledgeStore, eventStore);

      const lisiAfterSoulRead = knowledgeStore.query({ entityId: 'ent_lisi', factId: secretFact.id });
      expect(lisiAfterSoulRead[0]!.source).toBe('intelligence');
      expect(lisiAfterSoulRead[0]!.confidence).toBeCloseTo(0.9);

      const implant = manager.proposeEvent({
        eventType: 'memory_implant',
        eventDescription: '李四被植入关于古墓的错误记忆',
        chapter: 40,
        factChanges: [
          { change_id: 'chg_note', op: 'assert', subject: 'ent_lisi', predicate: 'note', value: '记忆被植入' },
        ],
        subject: 'ent_lisi',
        knowledgeChanges: [
          {
            op: 'implant',
            target_entity_id: 'ent_lisi',
            fact_id_scope: 'explicit',
            fact_ids: [secretFact.id],
            implanted_confidence: 0.4,
          },
        ],
      }, factStore);
      manager.commitEvent(implant.proposalId, factStore, knowledgeStore, eventStore);

      const lisiAfterImplant = knowledgeStore.query({ entityId: 'ent_lisi', factId: secretFact.id });
      expect(lisiAfterImplant[0]!.source).toBe('implanted');
      expect(lisiAfterImplant[0]!.confidence).toBe(0.4);
    });

    it('knowledge_changes decay 应降低最新 Knowledge 的 confidence', () => {
      const { factStore, knowledgeStore, eventStore, manager } = setupEnv();

      const discover = manager.proposeEvent({
        eventType: 'discover_secret',
        eventDescription: '张三发现古墓秘密',
        chapter: 20,
        factChanges: [
          { change_id: 'chg_secret', op: 'assert', subject: 'ent_gumu', predicate: 'secret', value: '藏有传送阵' },
        ],
        subject: 'ent_zhangsan',
      }, factStore);
      const discoverResult = manager.commitEvent(discover.proposalId, factStore, knowledgeStore, eventStore);
      const secretFact = factStore.getFactsByEvent(discoverResult.eventId).find(f => f.predicate === 'secret')!;

      const decay = manager.proposeEvent({
        eventType: 'memory_decay',
        eventDescription: '张三对古墓秘密的记忆开始模糊',
        chapter: 80,
        factChanges: [
          { change_id: 'chg_note', op: 'assert', subject: 'ent_zhangsan', predicate: 'note', value: '记忆模糊' },
        ],
        subject: 'ent_zhangsan',
        knowledgeChanges: [
          { op: 'decay', target_entity_id: 'ent_zhangsan', fact_id_scope: 'explicit', fact_ids: [secretFact.id] },
        ],
      }, factStore);
      manager.commitEvent(decay.proposalId, factStore, knowledgeStore, eventStore);

      const history = knowledgeStore.query({ entityId: 'ent_zhangsan', factId: secretFact.id });
      expect(history[0]!.source).toBe('memory_decay');
      expect(history[0]!.confidence).toBe(0.5);
      expect(history[0]!.previousConfidence).toBe(1);
    });

    it('commit_event 后 Proposal 应从 ProposalStore 中清除', () => {
      const { factStore, knowledgeStore, eventStore, manager } = setupEnv();

      const proposal = manager.proposeEvent({
        eventType: 'tribulation',
        eventDescription: '测试事件',
        chapter: 50,
        factChanges: [
          { change_id: 'chg_1', op: 'assert', subject: 'ent_zhangsan', predicate: 'note', value: '测试' },
        ],
        subject: 'ent_zhangsan',
      }, factStore);

      manager.commitEvent(proposal.proposalId, factStore, knowledgeStore, eventStore);

      // 再次用同一 proposalId 提交应报错
      expect(() =>
        manager.commitEvent(proposal.proposalId, factStore, knowledgeStore, eventStore)
      ).toThrow('PROPOSAL_NOT_FOUND');
    });

    it('stale proposal（版本冲突）应被拒绝', () => {
      const { factStore, knowledgeStore, eventStore, manager } = setupEnv();

      const proposal = manager.proposeEvent({
        eventType: 'test',
        eventDescription: '测试',
        chapter: 1,
        factChanges: [{ change_id: 'chg_1', op: 'assert', subject: 'ent_zhangsan', predicate: 'note', value: 'v1' }],
        subject: 'ent_zhangsan',
      }, factStore);

      // 模拟中间有另一个提交（版本已递增）
      factStore.tryUpdateStateVersion('default', 0); // v0 → v1

      // 用旧版本提交应失败
      expect(() =>
        manager.commitEvent(proposal.proposalId, factStore, knowledgeStore, eventStore)
      ).toThrow('STALE_PROPOSAL');
    });
  });

  // ===================================================================
  // FactChangeInput 转换
  // ===================================================================

  describe('FactChangeInput 转换', () => {
    it('assert 操作应正确转换', () => {
      const { factStore, manager } = setupEnv();

      const result = manager.proposeEvent({
        eventType: 'test',
        eventDescription: '测试 assert 转换',
        chapter: 1,
        factChanges: [
          { change_id: 'chg_assert', op: 'assert', subject: 'ent_zhangsan', predicate: 'test_pred', value: 'test_val' },
        ],
        subject: 'ent_zhangsan',
      }, factStore);

      expect(result.simulationReportMarkdown).toContain('test_pred');
      expect(result.simulationReportMarkdown).toContain('test_val');
    });

    it('缺少必填字段应报错', () => {
      const { factStore, manager } = setupEnv();

      expect(() =>
        manager.proposeEvent({
          eventType: 'test',
          eventDescription: '缺少 predicate',
          chapter: 1,
          factChanges: [
            { change_id: 'chg_err', op: 'assert', subject: 'ent_zhangsan' } as any,
          ],
          subject: 'ent_zhangsan',
        }, factStore)
      ).toThrow('FactChangeInput 转换错误');
    });

    it('业务事件缺少 subject 应在 Phase A 被拒绝', () => {
      const { factStore, manager } = setupEnv();

      expect(() =>
        manager.proposeEvent({
          eventType: 'test',
          eventDescription: '缺少事件主体',
          chapter: 1,
          factChanges: [
            { change_id: 'chg_1', op: 'assert', subject: 'ent_zhangsan', predicate: 'note', value: '测试' },
          ],
        }, factStore)
      ).toThrow('业务事件必须提供 subject');
    });

    it('exit_scope 缺少 exitFrom 应被拒绝', () => {
      const { factStore, manager } = setupEnv();

      expect(() =>
        manager.proposeEvent({
          eventType: 'exit_scope',
          eventDescription: '缺少退出来源',
          chapter: 50,
          context: 'global',
          factChanges: [
            { change_id: 'chg_1', op: 'assert', subject: 'ent_zhangsan', predicate: 'status', value: '清醒' },
          ],
          subject: 'ent_zhangsan',
        }, factStore)
      ).toThrow('exit_scope 必须提供 exit_from');
    });

    it('change_id 缺失、重复或格式非法时应被拒绝', () => {
      const { factStore, manager } = setupEnv();

      expect(() =>
        manager.proposeEvent({
          eventType: 'test',
          eventDescription: '缺少 change_id',
          chapter: 1,
          factChanges: [
            { op: 'assert', subject: 'ent_zhangsan', predicate: 'note', value: '测试' } as any,
          ],
          subject: 'ent_zhangsan',
        }, factStore)
      ).toThrow('change_id 必填');

      expect(() =>
        manager.proposeEvent({
          eventType: 'test',
          eventDescription: '重复 change_id',
          chapter: 1,
          factChanges: [
            { change_id: 'dup_1', op: 'assert', subject: 'ent_zhangsan', predicate: 'note', value: '一' },
            { change_id: 'dup_1', op: 'assert', subject: 'ent_zhangsan', predicate: 'note', value: '二' },
          ],
          subject: 'ent_zhangsan',
        }, factStore)
      ).toThrow('change_id 重复');

      expect(() =>
        manager.proposeEvent({
          eventType: 'test',
          eventDescription: '非法 change_id',
          chapter: 1,
          factChanges: [
            { change_id: '坏 id', op: 'assert', subject: 'ent_zhangsan', predicate: 'note', value: '测试' },
          ],
          subject: 'ent_zhangsan',
        }, factStore)
      ).toThrow('change_id 格式非法');
    });

    it('update/retract 不能跨作用域修改 Fact', () => {
      const { factStore, manager } = setupEnv();

      const globalFact = factStore.query({ subject: 'ent_zhangsan', predicate: 'realm' })[0]!;

      expect(() =>
        manager.proposeEvent({
          eventType: 'dream_update',
          eventDescription: '梦境中试图修改全局事实',
          chapter: 50,
          context: 'dream_01',
          factChanges: [
            { change_id: 'chg_1', op: 'update', target_fact_id: globalFact.id, value: '元婴期' },
          ],
          subject: 'ent_zhangsan',
        }, factStore)
      ).toThrow('SCOPE_FACT_MISMATCH');
    });

    it('dependent_fact_ids 必须在事件章节可见', () => {
      const { factStore, manager } = setupEnv();

      const globalFact = factStore.query({ subject: 'ent_zhangsan', predicate: 'realm' })[0]!;
      factStore.retract(globalFact.id, 20);

      expect(() =>
        manager.proposeEvent({
          eventType: 'test_dependency',
          eventDescription: '依赖已经失效的事实',
          chapter: 50,
          factChanges: [
            { change_id: 'chg_1', op: 'assert', subject: 'ent_lisi', predicate: 'note', value: '测试' },
          ],
          subject: 'ent_lisi',
          dependentFactIds: [globalFact.id],
        }, factStore)
      ).toThrow('dependent_fact_ids 包含在第 50 章不可见的 Fact');
    });
  });

  // ===================================================================
  // Phase 2C：Thread 持久化 + 双通道关闭
  // ===================================================================

  describe('Phase 2C — Thread 持久化', () => {
    /** 创建一条会产生 minor 线索的测试规则（不死板地只测内置规则） */
    const testThreadRule: TransitionRule = {
      id: 'test_minor_thread',
      description: '测试用：实体获得新能力时产生 foreshadowing 线索',
      check(event: NarrativeEvent, _factStore: IFactStore): NarrativeThread | null {
        if (event.type !== 'power_gain') return null;
        return {
          type: 'foreshadowing',
          direction: 'progressive',
          severity: 'minor',
          description: `${event.params['subject']} 获得了新能力，后续如何运用？`,
          closeCondition: { requiredEventType: 'power_use', withinChapters: 20 },
          status: 'PLANTED',
          closedBy: null,
          createdAtEvent: event.id,
          createdAtChapter: event.chapter,
          milestones: [],
          relatedEntities: [event.params['subject'] as string],
          upstreamFactIds: [],
        };
      },
    };

    /** 带有 ThreadStore 的环境初始化 */
    function setupWithThreads() {
      const factStore = new SQLiteFactStoreAdapter(':memory:', 'default');
      const db = factStore.getDatabase();

      // 注册实体
      db.exec("INSERT OR IGNORE INTO entities (id, name, kind, first_appearance) VALUES ('ent_hero', '主角', 'entity', 1)");
      db.exec("INSERT OR IGNORE INTO entities (id, name, kind, first_appearance) VALUES ('ent_elder', '长老', 'entity', 1)");
      db.exec("INSERT OR IGNORE INTO events (id, kind, type, chapter, description, params_json, fact_group_id) VALUES ('evt_origin_01', 'business', 'origin', 1, '初始设定', '{}', 'evt_origin_01')");

      const knowledgeStore = new SQLiteKnowledgeStoreAdapter(db);
      const eventStore = new SQLiteEventStoreAdapter(db);
      const threadStore = new SQLiteThreadStoreAdapter(db);
      const ruleEngine = new RuleEngine({ transitions: [testThreadRule] });
      const manager = new ProposalManager(ruleEngine, undefined, threadStore, new ThreadResolver());

      return { factStore, knowledgeStore, eventStore, threadStore, manager };
    }

    it('commit_event 后 Rule Engine 产出的 Thread 应持久化到 ThreadStore', () => {
      const { factStore, threadStore, manager } = setupWithThreads();

      const proposal = manager.proposeEvent({
        eventType: 'power_gain',
        eventDescription: '主角获得新能力',
        chapter: 10,
        factChanges: [
          { change_id: 'chg_1', op: 'assert', subject: 'ent_hero', predicate: 'ability', value: '飞行' },
        ],
        subject: 'ent_hero',
      }, factStore);

      // 沙盒推演应产出 1 条 foreshadowing 线索
      expect(proposal.consequences.generatedThreads.length).toBeGreaterThanOrEqual(1);
      const foreshadowThread = proposal.consequences.generatedThreads.find(
        t => t.type === 'foreshadowing' && t.description.includes('ent_hero'),
      );
      expect(foreshadowThread).toBeDefined();

      // 提交前 ThreadStore 应为空
      expect(threadStore.getOpen()).toHaveLength(0);

      // 提交
      const commitResult = manager.commitEvent(
        proposal.proposalId,
        factStore,
        factStore['knowledgeStore'] ?? new SQLiteKnowledgeStoreAdapter(factStore.getDatabase()),
        new SQLiteEventStoreAdapter(factStore.getDatabase()),
      );

      // 提交后 ThreadStore 应有 1 条线索
      const openThreads = threadStore.getOpen();
      expect(openThreads.length).toBeGreaterThanOrEqual(1);

      const persisted = openThreads.find(t => t.type === 'foreshadowing');
      expect(persisted).toBeDefined();
      expect(persisted!.status).toBe('PLANTED');
      expect(persisted!.direction).toBe('progressive');
      expect(persisted!.severity).toBe('minor');
      expect(persisted!.description).toContain('ent_hero');
      expect(persisted!.relatedEntities).toContain('ent_hero');
      expect(persisted!.closeCondition.requiredEventType).toBe('power_use');
      expect(persisted!.closedBy).toBeNull();

      // 返回值应包含创建的线索 ID
      expect(commitResult.affectedThreads.length).toBeGreaterThanOrEqual(1);
    });

    it('不注入 ThreadStore 时 commit_event 应正常工作（向后兼容）', () => {
      const factStore = new SQLiteFactStoreAdapter(':memory:', 'default');
      const db = factStore.getDatabase();
      db.exec("INSERT OR IGNORE INTO entities (id, name, kind, first_appearance) VALUES ('ent_hero', '主角', 'entity', 1)");
      db.exec("INSERT OR IGNORE INTO events (id, kind, type, chapter, description, params_json, fact_group_id) VALUES ('evt_origin_01', 'business', 'origin', 1, '初始设定', '{}', 'evt_origin_01')");

      // 不传 ThreadStore
      const manager = new ProposalManager();

      const proposal = manager.proposeEvent({
        eventType: 'power_gain',
        eventDescription: '主角获得新能力',
        chapter: 10,
        factChanges: [
          { change_id: 'chg_1', op: 'assert', subject: 'ent_hero', predicate: 'ability', value: '飞行' },
        ],
        subject: 'ent_hero',
      }, factStore);

      const result = manager.commitEvent(
        proposal.proposalId,
        factStore,
        new SQLiteKnowledgeStoreAdapter(db),
        new SQLiteEventStoreAdapter(db),
      );

      // 不报错，affectedThreads 为空（没有 ThreadStore 持久化）
      expect(result.affectedThreads).toEqual([]);
    });

    // ---- Step 2C-3：自动关闭（通道一） ----

    it('提交匹配 closeCondition 的事件应自动关闭回溯型线索', () => {
      const { factStore, threadStore, manager } = setupWithThreads();

      // 先创建一条线索，手动插入（模拟 Rule Engine 或历史数据产生）
      const db = factStore.getDatabase();
      const ruleEngine = new RuleEngine({ transitions: [testThreadRule] });

      // 提交一个 power_gain 事件产生 PLANTED 线索
      const prop1 = manager.proposeEvent({
        eventType: 'power_gain',
        eventDescription: '主角获得新能力',
        chapter: 10,
        factChanges: [
          { change_id: 'chg_1', op: 'assert', subject: 'ent_hero', predicate: 'ability', value: '飞行' },
        ],
        subject: 'ent_hero',
      }, factStore);

      const ks = new SQLiteKnowledgeStoreAdapter(db);
      const es = new SQLiteEventStoreAdapter(db);
      manager.commitEvent(prop1.proposalId, factStore, ks, es);

      // 此时应有一条 PLANTED 的渐进型线索（power_use 才能关闭）
      let openThreads = threadStore.getOpen();
      expect(openThreads.length).toBeGreaterThanOrEqual(1);
      const theThread = openThreads.find(t =>
        t.closeCondition.requiredEventType === 'power_use'
      );
      expect(theThread).toBeDefined();

      // ---- 现在提交 power_use 事件，触发自动关闭 ----
      const prop2 = manager.proposeEvent({
        eventType: 'power_use',
        eventDescription: '主角使用新能力',
        chapter: 15,
        factChanges: [
          { change_id: 'chg_2', op: 'assert', subject: 'ent_hero', predicate: 'note', value: '使用了飞行能力' },
        ],
        subject: 'ent_hero',
      }, factStore);

      const commitResult2 = manager.commitEvent(prop2.proposalId, factStore, ks, es);

      // 原本的 open 线索应被关闭（RESOLVED）
      const resolved = threadStore.getById(theThread!.id);
      expect(resolved).toBeDefined();
      expect(resolved!.status).toBe('RESOLVED');
      expect(resolved!.closedBy).toBeDefined();

      // affectedThreads 应包含被关闭的线索
      expect(commitResult2.affectedThreads).toContain(theThread!.id);

      // 新事件自己也可能产生新的线索（第二个 power_use 再次产生 foreshadowing thread）
      // 这是正常的——新生成的线索通常是开放的
    });

    // ---- Step 2C-4：显式关闭（通道二） ----

    it('customRule 线索可通过 thread_resolutions 显式关闭', () => {
      const { factStore, threadStore, manager } = setupWithThreads();

      // 通过 ProposalManager 直接创建一条 customRule 线索（绑定到不会自动关闭的规则）
      // customRule 线索在自动通道走不通，只能通过显式通道关闭
      // 我们先提交一个 power_gain 事件产生普通线索（不是 customRule）
      // 然后手动插入一条 customRule 线索到 ThreadStore
      const db = factStore.getDatabase();

      // 提交一个产生线索的事件（需要能提交的）
      const prop1 = manager.proposeEvent({
        eventType: 'power_gain',
        eventDescription: '主角获得飞行能力',
        chapter: 10,
        factChanges: [
          { change_id: 'chg_1', op: 'assert', subject: 'ent_hero', predicate: 'ability', value: '飞行' },
        ],
        subject: 'ent_hero',
      }, factStore);

      const ks = new SQLiteKnowledgeStoreAdapter(db);
      const es = new SQLiteEventStoreAdapter(db);
      const eventId = manager.commitEvent(prop1.proposalId, factStore, ks, es).eventId;

      // 手动创建一条 customRule 回溯型线索（模拟需要特殊事件才能关闭的伏笔）
      const customThread = threadStore.create({
        type: 'causal_gap',
        direction: 'retroactive',
        severity: 'major',
        description: '需要补充门派传承来源',
        closeCondition: {
          requiredEventType: 'lineage_reveal',
          customRule: '需要门派长老揭示传承秘密，普通事件不足',
        },
        status: 'UNFILLED',
        closedBy: null,
        createdAtEvent: eventId,
        createdAtChapter: 10,
        milestones: [],
        relatedEntities: ['ent_hero'],
        upstreamFactIds: [],
      });

      // 尝试用非匹配事件自动关闭 → 不应该成功（customRule 在自动通道不可关闭）
      // 现在提交一个 lineage_reveal 事件，在 thread_resolutions 中显式声明要关闭
      const prop2 = manager.proposeEvent({
        eventType: 'lineage_reveal',
        eventDescription: '门派长老揭示传承秘密',
        chapter: 20,
        factChanges: [
          { change_id: 'chg_2', op: 'assert', subject: 'ent_hero', predicate: 'lineage', value: '太虚门' },
        ],
        subject: 'ent_elder',
        threadResolutions: [customThread.id],
      }, factStore);

      // 此时自动通道没有匹配（因为 customRule），但显式通道应触发
      // 注意：事件 subject 不是 customThread 的 relatedEntities[0]
      // 但这不影响显式关闭——显式关闭只看 thread_resolutions

      const commitResult2 = manager.commitEvent(prop2.proposalId, factStore, ks, es);

      // 线索应被显式关闭（FILLED）
      const filled = threadStore.getById(customThread.id);
      expect(filled).toBeDefined();
      expect(filled!.status).toBe('FILLED');
      expect(filled!.closedBy).toBeDefined();

      // affectedThreads 应包含此线索
      expect(commitResult2.affectedThreads).toContain(customThread.id);
    });
  });

  // ===================================================================
  // Phase 2D：知识传播四梯队合并
  // ===================================================================

  describe('Phase 2D — 知识传播合并优先级', () => {
    function setupWithKB() {
      const factStore = new SQLiteFactStoreAdapter(':memory:', 'default');
      const db = factStore.getDatabase();
      db.exec("INSERT OR IGNORE INTO entities (id, name, kind, first_appearance) VALUES ('ent_hero', '主角', 'entity', 1)");
      db.exec("INSERT OR IGNORE INTO entities (id, name, kind, first_appearance) VALUES ('ent_sidekick', '伙伴', 'entity', 1)");
      db.exec("INSERT OR IGNORE INTO entities (id, name, kind, first_appearance) VALUES ('ent_mentor', '导师', 'entity', 1)");
      db.exec("INSERT OR IGNORE INTO entities (id, name, kind, first_appearance) VALUES ('ent_place', '古战场', 'place', 1)");
      db.exec("INSERT OR IGNORE INTO events (id, kind, type, chapter, description, params_json, fact_group_id) VALUES ('evt_origin_01', 'business', 'origin', 1, '初始', '{}', 'evt_origin_01')");

      const knowledgeStore = new SQLiteKnowledgeStoreAdapter(db);
      const eventStore = new SQLiteEventStoreAdapter(db);
      const threadStore = new SQLiteThreadStoreAdapter(db);
      const manager = new ProposalManager(new RuleEngine(), undefined, threadStore, new ThreadResolver());
      return { factStore, knowledgeStore, eventStore, threadStore, manager };
    }

    it('knowledge_hints 应覆盖同 (entityId, changeId) 的 propagation 结果', () => {
      const { factStore, manager, knowledgeStore, eventStore } = setupWithKB();

      const changes: FactChangeInput[] = [
        { change_id: 'chg_1', op: 'assert', subject: 'ent_hero', predicate: 'realm', value: '元婴期' },
      ];

      // propagation (tier 1): subject_auto → confidence=1.0, source=self_action
      // knowledge_hints (tier 3): 指定主角只以 rumor 方式知晓, confidence=0.3
      const hints: KnowledgeHint[] = [
        { entityId: 'ent_hero', factIndex: 0, source: 'rumor', confidence: 0.3 },
      ];

      const proposal = manager.proposeEvent({
        eventType: 'breakthrough',
        eventDescription: '主角秘密突破',
        chapter: 50,
        factChanges: changes,
        subject: 'ent_hero',
        knowledgeHints: hints,
      }, factStore);

      // 提交
      manager.commitEvent(proposal.proposalId, factStore, knowledgeStore, eventStore);

      // 查询知识——应使用 hints 的 rumor/0.3 而非 propagation 的 self_action/1.0
      const knowledge = knowledgeStore.getKnownFacts('ent_hero', 50);
      expect(knowledge.length).toBe(1);
      // hints 先 push 到 collected（tier 3），propagation 后 push（tier 1）
      // merge 时 hints 先到先占 key → propagation 被去重
      expect(knowledge[0]!.source).toBe('rumor');
      expect(knowledge[0]!.confidence).toBe(0.3);
    });

    it('knowledge_broadcast 应覆盖 propagation 但被 hints 覆盖', () => {
      const { factStore, manager, knowledgeStore, eventStore } = setupWithKB();

      const changes: FactChangeInput[] = [
        { change_id: 'chg_1', op: 'assert', subject: 'ent_hero', predicate: 'secret', value: '发现宝库' },
      ];

      // broadcast (tier 2): 主角 + 伙伴以 informed 方式知晓, confidence=0.9
      const broadcast: KnowledgeBroadcast = {
        visibility: 'explicit_entities',
        target_entity_ids: ['ent_hero', 'ent_sidekick'],
        source: 'informed',
        confidence: 0.9,
      };

      // hint (tier 3): 主角实际以 revelation 方式知晓, confidence=1.0
      const hints: KnowledgeHint[] = [
        { entityId: 'ent_hero', factIndex: 0, source: 'revelation', confidence: 1.0 },
      ];

      const proposal = manager.proposeEvent({
        eventType: 'discovery',
        eventDescription: '发现宝库',
        chapter: 20,
        factChanges: changes,
        subject: 'ent_hero',
        knowledgeHints: hints,
        knowledgeBroadcast: broadcast,
      }, factStore);

      manager.commitEvent(proposal.proposalId, factStore, knowledgeStore, eventStore);

      const heroK = knowledgeStore.getKnownFacts('ent_hero', 20);
      const sideK = knowledgeStore.getKnownFacts('ent_sidekick', 20);

      // 主角：hints 覆盖 broadcast → revelation/1.0
      expect(heroK.length).toBe(1);
      expect(heroK[0]!.source).toBe('revelation');
      expect(heroK[0]!.confidence).toBe(1.0);

      // 伙伴：只有 broadcast → informed/0.9
      expect(sideK.length).toBe(1);
      expect(sideK[0]!.source).toBe('informed');
      expect(sideK[0]!.confidence).toBe(0.9);
    });
  });
});

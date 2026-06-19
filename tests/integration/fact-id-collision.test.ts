// =============================================================================
// P1-1b 回归测试：Fact ID 唯一性——多词事件类型连续提交不冲突
// =============================================================================
// 背景：assert() 此前按 split('_') 取 [0..2] 拼接 Fact ID（type/chapter/seq），
// 对多词事件类型（如 character_intro）会误解析——evt_character_intro_1_02 被切成
// ['character','intro','1','02']，eventSeq 只取到 '1'，末尾真正区分事件的全局序号 '02'
// 被丢弃。于是同族事件 evt_character_intro_1 与 evt_character_intro_1_02 的首条 Fact
// 都生成 fct_character_intro_1_01，命中 facts.id 的 UNIQUE 约束，第二次 commit_event
// 抛 "UNIQUE constraint failed: facts.id" 直接失败。
//
// 这是 writing-loop 场景 B/E 的真实根因（非 LLM / 超时）。本测试用确定性路径（无 LLM）
// 锁定修复：连续提交两个同族多词事件，断言两次均成功、Fact ID 互不相同。
//
// 修复后 ID 规则：fct_{causeEvent 去前缀}_{事件内序号}
//   事件1 evt_character_intro_1     → fct_character_intro_1_01
//   事件2 evt_character_intro_1_02  → fct_character_intro_1_02_01
// 单词类型同样兼容（evt_tribulation_50 → fct_tribulation_50_01，与旧格式逐字一致）。
// =============================================================================

import { describe, it, expect, beforeEach } from 'vitest';
import { SQLiteFactStoreAdapter } from '../../src/adapters/sqlite/fact-store.js';
import { SQLiteThreadStoreAdapter } from '../../src/adapters/sqlite/thread-store.js';
import { SQLiteKnowledgeStoreAdapter } from '../../src/adapters/sqlite/knowledge-store.js';
import { SQLiteEventStoreAdapter } from '../../src/adapters/sqlite/event-store.js';
import { ProposalManager } from '../../src/core/proposal-manager.js';
import { RuleEngine } from '../../src/core/rule-engine.js';
import { ThreadResolver } from '../../src/core/thread-resolver.js';
import { RetconEngine } from '../../src/core/retcon-engine.js';
import { ToolService } from '../../src/core/tool-service.js';
import { SchemaExtensionManager } from '../../src/core/schema-extension-manager.js';
import { ToolRouter } from '../../src/core/tool-router.js';

describe('P1-1b Fact ID 唯一性：多词事件类型连续提交不冲突', () => {
  let router: ToolRouter;
  let factStore: SQLiteFactStoreAdapter;

  beforeEach(() => {
    // ---- 真实 Core 栈（:memory:，无 Embedding / LLM）----
    factStore = new SQLiteFactStoreAdapter(':memory:', 'default');
    const db = factStore.getDatabase();
    const threadStore = new SQLiteThreadStoreAdapter(db);
    const knowledgeStore = new SQLiteKnowledgeStoreAdapter(db);
    const eventStore = new SQLiteEventStoreAdapter(db);
    const threadResolver = new ThreadResolver();

    const proposalManager = new ProposalManager(
      new RuleEngine(), undefined, threadStore, threadResolver,
    );
    const retconEngine = new RetconEngine();
    const toolService = new ToolService(
      factStore, knowledgeStore, eventStore, threadStore, threadResolver,
    );
    const schemaExtensionManager = new SchemaExtensionManager(db);

    router = new ToolRouter({
      proposalManager, retconEngine, toolService,
      schemaExtensionManager, factStore, knowledgeStore, eventStore, threadStore,
    });

    // 注册被引用的实体（供 fact_changes.subject 引用）
    db.exec(`INSERT INTO entities (id, name, kind, first_appearance) VALUES ('ent_hero', '主角', 'entity', 1)`);
  });

  /** 提议并提交一个事件，返回提交结果 + 产生的 Fact 列表 */
  async function proposeAndCommit(
    eventType: string,
    chapter: number,
    predicate: string,
    value: string,
  ) {
    const propose = await router.execute('propose_event', {
      event_type: eventType,
      event_description: `${predicate} 设定`,
      chapter,
      subject: 'ent_hero',
      context: 'global',
      fact_changes: [
        { change_id: 'c1', op: 'assert', subject: 'ent_hero', predicate, value },
      ],
    });
    if (!propose.success) throw new Error(`propose_event 失败：${propose.error.message}`);
    const proposalId = (propose as { data: { proposalId: string } }).data.proposalId;

    const commit = await router.execute('commit_event', { proposal_id: proposalId });
    return { commit, proposalId };
  }

  it('同族多词事件类型（character_intro）连续提交：两次 commit 均成功，Fact ID 互不相同', async () => {
    // 事件 1：evt_character_intro_1（eventIdSeq=1，无后缀）
    const r1 = await proposeAndCommit('character_intro', 1, 'realm', '炼气期');
    expect(r1.commit.success).toBe(true);

    // 事件 2：evt_character_intro_1_02（eventIdSeq=2）
    // 旧代码此处必失败：fct_character_intro_1_01 与事件1首条 Fact 撞 facts.id UNIQUE
    const r2 = await proposeAndCommit('character_intro', 1, 'weapon', '诛仙剑');
    expect(r2.commit.success).toBe(true);

    const facts = factStore.query({ subject: 'ent_hero', mode: 'current' });
    const ids = facts.map(f => f.id);

    // 所有 Fact ID 互不相同（UNIQUE 约束的本意）
    expect(new Set(ids).size).toBe(ids.length);

    // 两次提交的 Fact 均落库（predicate 覆盖 realm + weapon）
    expect(facts.some(f => f.predicate === 'realm' && String(f.value) === '炼气期')).toBe(true);
    expect(facts.some(f => f.predicate === 'weapon' && String(f.value) === '诛仙剑')).toBe(true);

    // 锁定修复后的 ID 格式（文档化预期，防回归）。
    // EventStore.create 为每个事件分配 evt_{type}_{chapter}_{seq}（seq=COUNT+1，首事件即 _01）：
    //   事件1 evt_character_intro_1_01 → fct_character_intro_1_01_01
    //   事件2 evt_character_intro_1_02 → fct_character_intro_1_02_01（含事件全局序号 02，旧代码丢失的部分）
    // 旧代码两者都退化为 fct_character_intro_1_01（eventSeq 只取到 split 的 [2]='1'）→ UNIQUE 冲突。
    expect(ids).toContain('fct_character_intro_1_01_01');
    expect(ids).toContain('fct_character_intro_1_02_01');
  });

  it('单词事件类型行为不变（向后兼容）：evt_tribulation_50_01 → fct_tribulation_50_01_01', async () => {
    // 单词类型不受多词解析缺陷影响——新旧代码对此格式产出一致，本测试锁定未被破坏
    const r = await proposeAndCommit('tribulation', 50, 'status', '渡劫中');
    expect(r.commit.success).toBe(true);

    const facts = factStore.query({ subject: 'ent_hero', predicate: 'status', mode: 'current' });
    expect(facts.map(f => f.id)).toContain('fct_tribulation_50_01_01');
  });
});

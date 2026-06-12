// =============================================================================
// Phase 5 端到端集成验证
// =============================================================================

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SQLiteFactStoreAdapter } from '../../src/adapters/sqlite/fact-store.js';
import { SQLiteKnowledgeStoreAdapter } from '../../src/adapters/sqlite/knowledge-store.js';
import { SQLiteEventStoreAdapter } from '../../src/adapters/sqlite/event-store.js';
import { SQLiteThreadStoreAdapter } from '../../src/adapters/sqlite/thread-store.js';
import { LanceDBTableAdapter } from '../../src/adapters/lancedb/table-adapter.js';
import { SiliconFlowEmbeddingService } from '../../src/adapters/embedding/siliconflow-embedder.js';
import { ProposalManager } from '../../src/core/proposal-manager.js';
import { RuleEngine } from '../../src/core/rule-engine.js';
import { ThreadResolver } from '../../src/core/thread-resolver.js';
import { RetconEngine } from '../../src/core/retcon-engine.js';
import { FactRenderer } from '../../src/core/fact-renderer.js';
import { ContextAnalyzer } from '../../src/core/context-analyzer.js';
import { RelevantFactRetriever } from '../../src/core/relevant-fact-retriever.js';
import { SyncQueueConsumer } from '../../src/core/sync-queue-consumer.js';
import { ToolService } from '../../src/core/tool-service.js';
import { SchemaExtensionManager } from '../../src/core/schema-extension-manager.js';
import type { FactChangeInput, KnowledgeBroadcast } from '../../src/types.js';
import { tmpdir } from 'os';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';

// ---------------------------------------------------------------------------
let lancedbDir: string;
let factStore: SQLiteFactStoreAdapter;
let knowledgeStore: SQLiteKnowledgeStoreAdapter;
let eventStore: SQLiteEventStoreAdapter;
let threadStore: SQLiteThreadStoreAdapter;
let vectorStore: LanceDBTableAdapter;
let embedder: SiliconFlowEmbeddingService;
let manager: ProposalManager;
let retconEngine: RetconEngine;
let toolService: ToolService;

const entityNames: Record<string, string> = {
  ent_zhangsan: '张三', ent_lisi: '李四', ent_wang: '王长老',
  ent_xiaomei: '小师妹', ent_taixumen: '太虚门', ent_zhuxianjian: '诛仙剑',
};

beforeAll(async () => {
  lancedbDir = mkdtempSync(join(tmpdir(), 'e2e-'));
  vectorStore = new LanceDBTableAdapter(lancedbDir, 'facts');
  await vectorStore.init();
  embedder = new SiliconFlowEmbeddingService();

  factStore = new SQLiteFactStoreAdapter(':memory:', 'default');
  const db = factStore.getDatabase();
  knowledgeStore = new SQLiteKnowledgeStoreAdapter(db);
  eventStore = new SQLiteEventStoreAdapter(db);
  threadStore = new SQLiteThreadStoreAdapter(db);
  manager = new ProposalManager(new RuleEngine(), undefined, threadStore, new ThreadResolver());
  retconEngine = new RetconEngine();
  toolService = new ToolService(factStore, knowledgeStore, eventStore, threadStore, new ThreadResolver());

  for (const [id, name] of Object.entries(entityNames)) {
    db.prepare('INSERT INTO entities (id, name, kind, first_appearance) VALUES (?,?,?,?)')
      .run(id, name, 'entity', 1);
  }

  const origin = eventStore.create({
    kind: 'business', type: 'world_origin', chapter: 1, description: '初始设定',
    params: {}, context: 'global', timestamp: new Date().toISOString(),
    factGroupId: 'evt_origin', resolvedThreads: [], dependentFactIds: [],
  });

  const initFacts: [string,string,string,string][] = [
    ['ent_zhangsan','realm','筑基期','张三修炼筑基期'],
    ['ent_zhangsan','status','alive','张三存活'],
    ['ent_lisi','realm','金丹期','李四修炼金丹期'],
    ['ent_lisi','status','alive','李四存活'],
    ['ent_wang','realm','元婴期','王长老修炼元婴期'],
  ];
  const allFacts = initFacts.map(([s,p,v,t]) => factStore.assert({
    subject:s,predicate:p,value:v,certainty:'canonical',causeEvent:origin.id,
    validFrom:1,validTo:null,embeddingText:t,context:'global',schemaVersion:1,
  }));
  const texts = allFacts.map(f => f.embeddingText);
  const vectors = await embedder.embedBatch(texts);
  await vectorStore.add(allFacts.map((f,i) => ({
    id:f.id,vector:vectors[i]!,subject:f.subject,predicate:f.predicate,
    valid_from:1,valid_to:null,is_current:true,certainty:'canonical',context:'global',
  })));
}, 60000);

afterAll(() => { try { rmSync(lancedbDir,{recursive:true,force:true}); } catch {} });

// =============================================================================

describe('完整 Push 管廊', () => {
  it('propse→commit→检索→渲染 完整链路', async () => {
    const retriever = new RelevantFactRetriever(factStore, knowledgeStore, threadStore, vectorStore, embedder);
    const renderer = new FactRenderer();

    // 写出前检索
    const before = await retriever.retrieve(new ContextAnalyzer(factStore).analyze({
      chapter: 50, entityIds: ['ent_zhangsan'], text: '张三渡劫', context: 'global',
    }), { topK: 5 });
    const beforeMd = renderer.renderRelevantFacts(before, entityNames);
    expect(beforeMd).toContain('张三');
    expect(beforeMd).toContain('筑基期');

    // 提议+提交
    const prop = manager.proposeEvent({
      eventType:'tribulation', eventDescription:'张三渡劫突破', chapter:50,
      factChanges: [
        { change_id:'r', op:'update', target_fact_id: factStore.query({subject:'ent_zhangsan',predicate:'realm'})[0]!.id, value:'金丹期' },
        { change_id:'e', op:'assert', subject:'ent_zhangsan', predicate:'event', value:'渡劫成功' },
      ],
      subject:'ent_zhangsan',
      knowledgeBroadcast: { visibility:'explicit_entities', target_entity_ids:['ent_lisi','ent_wang'], source:'witnessed', confidence:0.9 },
    }, factStore);

    expect(prop.isSafeToCommit).toBe(true);
    const r = manager.commitEvent(prop.proposalId, factStore, knowledgeStore, eventStore);
    expect(r.eventId).toBeDefined();

    // 向量同步
    const consumer = new SyncQueueConsumer(factStore.getDatabase(), vectorStore, embedder);
    const newFacts = factStore.query({ mode:'current', subject:'ent_zhangsan' }).filter(f => f.validFrom===50);
    for (const sf of newFacts) consumer.insertEntry(r.eventId, 'insert_vector', [sf.id]);
    factStore.getDatabase().prepare("UPDATE sync_queue SET next_retry_at = datetime('now') WHERE status='pending'").run();
    await consumer.processPending();

    // 写后检索——新数据可见
    const after = await retriever.retrieve(new ContextAnalyzer(factStore).analyze({
      chapter: 51, entityIds: ['ent_zhangsan'], text: '金丹修士', context: 'global',
    }), { topK: 10 });
    const afterMd = renderer.renderRelevantFacts(after, entityNames);
    expect(afterMd).toContain('金丹期');
  }, 60000);
});

describe('Retcon 端到端', () => {
  it('BFS 级联 + 线索恢复', () => {
    const p1 = manager.proposeEvent({
      eventType:'conflict', eventDescription:'结仇', chapter:30, subject:'ent_zhangsan',
      factChanges: [{ change_id:'c', op:'assert', subject:'ent_zhangsan', predicate:'enemy_of', value:'ent_lisi' }],
    }, factStore);
    const r1 = manager.commitEvent(p1.proposalId, factStore, knowledgeStore, eventStore);
    const conflictFacts = factStore.getFactsByEvent(r1.eventId).map(f=>f.id);

    const p2 = manager.proposeEvent({
      eventType:'ambush', eventDescription:'偷袭', chapter:50, subject:'ent_lisi',
      factChanges: [{ change_id:'a', op:'assert', subject:'ent_zhangsan', predicate:'hp', value:'8500' }],
      dependentFactIds: conflictFacts,
    }, factStore);
    const r2 = manager.commitEvent(p2.proposalId, factStore, knowledgeStore, eventStore);

    // 创建线索并在第50章事件关闭
    const t = threadStore.create({
      type:'foreshadowing', direction:'retroactive', severity:'major', description:'预兆',
      closeCondition:{ requiredEventType:'ambush', withinChapters:100 },
      status:'FILLED', closedBy: r2.eventId, createdAtEvent: r1.eventId, createdAtChapter:30,
      milestones:[], relatedEntities:['ent_zhangsan'], upstreamFactIds:[], tags:[],
    });

    // Retcon 修改第30章事件
    const proposal = retconEngine.proposeRetcon({
      targetEventId: r1.eventId, reason:'调整敌对原因', newDescription:'修正', chapter:100, factChanges:[],
    }, factStore, eventStore, threadStore, knowledgeStore);

    expect(proposal.proposalId.startsWith('rtc_')).toBe(true);
    expect(proposal.cascadeReportMarkdown).toContain('级联影响');

    const result = retconEngine.commitRetcon({
      retconProposalId: proposal.proposalId,
    }, factStore, eventStore, threadStore, knowledgeStore);

    expect(result.status).toBe('success');
    expect(result.contestedFactCount).toBeGreaterThan(0);

    // 线索恢复
    const updated = threadStore.getById(t.id);
    expect(updated!.status).toBe('UNFILLED');
  }, 30000);
});

describe('Tool + 知识完整流程', () => {
  it('get_context_slice → get_open_threads', async () => {
    const slice = await toolService.getContextSlice({
      entityId:'ent_zhangsan', currentChapter:60, entityNames,
    });
    expect(slice.profileMarkdown).toContain('张三');
    expect(slice.factIndex.length).toBeGreaterThan(0);

    const threads = await toolService.getOpenThreads({ currentChapter:60 });
    expect(threads.threadsMarkdown).toBeDefined();
    expect(threads.totalOpen).toBeGreaterThanOrEqual(0);
  });

  it('知识记忆→封印→恢复', () => {
    const p = manager.proposeEvent({
      eventType:'obtain', eventDescription:'获得诛仙剑', chapter:200, subject:'ent_zhangsan',
      factChanges: [{ change_id:'s', op:'assert', subject:'ent_zhangsan', predicate:'item', value:'诛仙剑' }],
    }, factStore);
    manager.commitEvent(p.proposalId, factStore, knowledgeStore, eventStore);

    // 张三知道
    expect(knowledgeStore.getKnownFacts('ent_zhangsan',200).some(k => {
      const f = factStore.getById(k.factId); return f?.predicate==='item';
    })).toBe(true);

    // 封印
    const sword = factStore.query({subject:'ent_zhangsan',predicate:'item'}).find(f=>f.validTo===null)!;
    const sp = manager.proposeEvent({
      eventType:'seal', eventDescription:'封印记忆', chapter:201, subject:'ent_wang',
      factChanges: [{ change_id:'x', op:'assert', subject:'ent_zhangsan', predicate:'note', value:'记忆封印' }],
      knowledgeChanges: [{ op:'seal', target_entity_id:'ent_zhangsan', fact_id_scope:'explicit', fact_ids:[sword.id] }],
    }, factStore);
    manager.commitEvent(sp.proposalId, factStore, knowledgeStore, eventStore);

    expect(knowledgeStore.getKnownFacts('ent_zhangsan',201).some(k=>k.factId===sword.id)).toBe(false);

    // 恢复
    const rp = manager.proposeEvent({
      eventType:'restore', eventDescription:'恢复记忆', chapter:300, subject:'ent_wang',
      factChanges: [{ change_id:'y', op:'assert', subject:'ent_wang', predicate:'status', value:'dead' }],
      knowledgeChanges: [{ op:'restore', target_entity_id:'ent_zhangsan', fact_id_scope:'explicit', fact_ids:[sword.id] }],
    }, factStore);
    manager.commitEvent(rp.proposalId, factStore, knowledgeStore, eventStore);

    expect(knowledgeStore.getKnownFacts('ent_zhangsan',300).some(k=>k.factId===sword.id)).toBe(true);
  });
});

describe('Rule Engine 约束', () => {
  it('死亡实体规则违规', () => {
    const dp = manager.proposeEvent({
      eventType:'death', eventDescription:'死亡', chapter:400, subject:'ent_lisi',
      factChanges: [{ change_id:'d', op:'assert', subject:'ent_lisi', predicate:'status', value:'dead' }],
    }, factStore);
    manager.commitEvent(dp.proposalId, factStore, knowledgeStore, eventStore);

    const bp = manager.proposeEvent({
      eventType:'attack', eventDescription:'死人行动', chapter:401, subject:'ent_lisi',
      factChanges: [{ change_id:'b', op:'assert', subject:'ent_zhangsan', predicate:'note', value:'异常' }],
    }, factStore);

    expect(bp.isSafeToCommit).toBe(false);
    expect(bp.consequences.generatedThreads.some(t=>t.type==='rule_violation'&&t.severity==='critical')).toBe(true);
  });
});

describe('Schema 扩展', () => {
  it('提议→提交 完整流程', () => {
    const sem = new SchemaExtensionManager(factStore.getDatabase());
    const p = sem.proposePredicate({ name:'teleport', displayName:'传送阵', valueType:'scalar', description:'空间传送' });
    expect(p.conflicts).toHaveLength(0);
    const r = sem.commitExtension(p.proposalId);
    expect(r.status).toBe('success');
    expect(r.newPredicateNames).toContain('teleport');
  });
});

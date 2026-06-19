// =============================================================================
// W8 集成测试：RealCoreBridge.readCurrentWorldSnapshot 聚合（真实 Core）
// =============================================================================
// 验证 W8 修复：旧实现缺 entity_id + 硬编码 chapter=1 → 现为聚合方案
// （枚举已注册实体 + 逐一 get_context_slice + 章节推导/覆盖 + 多实体容错）。
//
// 真实 Core（:memory: SQLite + 真实 ToolRouter，propose+commit 落真实 Fact）+ 真实 RealCoreBridge。
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
import { SQLiteWritingStore } from '../../src/writing/repositories/writing-store.js';
import { AuditService } from '../../src/writing/services/audit-service.js';
import { RealCoreBridge } from '../../src/writing/core-bridge/real-bridge.js';
import { buildWorldSnapshotView } from '../../src/writing/view-models/world-snapshot.js';

/** ToolRouter 成功/失败包装 */
type Wrapper<T> = { success: true; data: T } | { success: false; error: { code: string; message: string } };

describe('W8 RealCoreBridge.readCurrentWorldSnapshot 聚合', () => {
  let router: ToolRouter;
  let store: SQLiteWritingStore;
  let bridge: RealCoreBridge;
  let projectId: string;

  beforeEach(async () => {
    // ---- 真实 Core 栈 ----
    const factStore = new SQLiteFactStoreAdapter(':memory:', 'default');
    const db = factStore.getDatabase();
    const threadStore = new SQLiteThreadStoreAdapter(db);
    const knowledgeStore = new SQLiteKnowledgeStoreAdapter(db);
    const eventStore = new SQLiteEventStoreAdapter(db);
    const proposalManager = new ProposalManager(
      new RuleEngine(), undefined, threadStore, new ThreadResolver(),
    );
    const toolService = new ToolService(
      factStore, knowledgeStore, eventStore, threadStore, new ThreadResolver(),
    );
    const router_ = new ToolRouter({
      proposalManager, retconEngine: new RetconEngine(), toolService,
      schemaExtensionManager: new SchemaExtensionManager(db),
      factStore, knowledgeStore, eventStore, threadStore,
    });
    router = router_;

    // 注册两个 Core 实体
    db.exec(`INSERT INTO entities (id, name, kind, first_appearance) VALUES ('ent_hero', '主角', 'entity', 1)`);
    db.exec(`INSERT INTO entities (id, name, kind, first_appearance) VALUES ('ent_villain', '反派', 'entity', 1)`);

    // 为 ent_hero 提交一条 location Fact（chapter 5），ent_villain 无 Fact
    const propose = (await router.execute('propose_event', {
      event_type: 'custom', event_description: '主角抵达废弃站台',
      chapter: 5, subject: 'ent_hero',
      fact_changes: [{ change_id: 'c1', op: 'assert', subject: 'ent_hero', predicate: 'location', value: '废弃站台' }],
    })) as Wrapper<{ proposalId: string }>;
    expect(propose.success).toBe(true);
    const commit = (await router.execute('commit_event', { proposal_id: propose.data.proposalId })) as Wrapper<unknown>;
    expect(commit.success).toBe(true);

    // ---- 写作层 ----
    store = new SQLiteWritingStore(db);
    store.createTables();
    const audit = new AuditService(store);
    bridge = new RealCoreBridge(router, store, audit);

    projectId = store.createProject('W8 测试作品').id;

    // 两个已注册实体草图（coreEntityId 回填），供 readCurrentWorldSnapshot 枚举
    const hero = store.createEntitySketch(projectId, { displayName: '主角', typeLabel: '角色', status: 'registered' });
    store.updateEntitySketch(hero.id, { coreEntityId: 'ent_hero' });
    const villain = store.createEntitySketch(projectId, { displayName: '反派', typeLabel: '角色', status: 'registered' });
    store.updateEntitySketch(villain.id, { coreEntityId: 'ent_villain' });

    // 草案 chapter=5 → getCurrentChapter 推导为 5
    const draft = store.createDraft(projectId, {
      kind: 'event', chapter: 5, title: '抵达', content: '主角穿过荒原抵达废弃站台查看异象。',
    });
    store.updateDraft(draft.id, draft.version, { status: 'ready_to_simulate' });
  });

  it('聚合两个已注册实体；章节推导为 5；ent_hero 档案含已提交 Fact', async () => {
    const snap = await bridge.readCurrentWorldSnapshot(projectId);

    expect(snap.currentChapter).toBe(5);          // 推导自 draft chapter
    expect(snap.totalEntities).toBe(2);
    expect(snap.entities).toHaveLength(2);

    const hero = snap.entities.find((e) => e.coreEntityId === 'ent_hero')!;
    expect(hero.displayName).toBe('主角');
    expect(hero.typeLabel).toBe('角色');
    expect(hero.profileMarkdown).toContain('废弃站台'); // 已提交 Fact 渲染进档案
    expect(hero.factIndex.some((f) => f.predicate === 'location' && f.value === '废弃站台')).toBe(true);

    // ent_villain 无 Fact：factIndex 空，但无 error（Core 对无 Fact 实体返回空档案而非报错）
    const villain = snap.entities.find((e) => e.coreEntityId === 'ent_villain')!;
    expect(villain.factIndex).toEqual([]);
    expect(villain.error).toBeUndefined();
  });

  it('显式 currentChapter 覆盖推导值；章节视角影响 Fact 可见性', async () => {
    // 覆盖为 chapter 1：ent_hero 的 location Fact validFrom=5，在 ch1 不可见
    const snap = await bridge.readCurrentWorldSnapshot(projectId, { currentChapter: 1 });

    expect(snap.currentChapter).toBe(1);
    const hero = snap.entities.find((e) => e.coreEntityId === 'ent_hero')!;
    expect(hero.factIndex).toEqual([]); // ch1 看不到 ch5 才确立的 Fact
    expect(hero.profileMarkdown).not.toContain('废弃站台');
  });

  it('端到端投影为 ViewModel：normal 模式不泄漏 ent_/fct_', async () => {
    const snap = await bridge.readCurrentWorldSnapshot(projectId);
    const vm = buildWorldSnapshotView(snap, 'normal');

    expect(vm.entityCount).toBe(2);
    expect(vm.entities.some((e) => e.name === '主角' && e.attributeCount >= 1)).toBe(true);
    // 深度扫描：normal ViewModel 序列化无任何 Core 前缀
    expect(JSON.stringify(vm)).not.toMatch(/ent_|fct_|evt_/);
  });

  it('无 writingStore 时抛配置错误（防止静默返回空快照）', async () => {
    const bareBridge = new RealCoreBridge(router); // 不注入 writingStore
    await expect(bareBridge.readCurrentWorldSnapshot(projectId)).rejects.toThrow(/writingStore/);
  });
});

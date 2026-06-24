// =============================================================================
// 乐观锁单元测试（W3 + P1-2 三热表补全）
// =============================================================================
// 验证 writing_drafts / writing_blueprints / writing_projects / writing_entity_sketches /
// writing_proposal_views 的乐观锁语义：
//   1. version 初始为 1
//   2. 每次 update 成功后 version + 1
//   3. 过期版本（expectedVersion != 库中 version）→ 抛 VERSION_CONFLICT
//   4. 不存在的对象 → 抛 WRITING_OBJECT_NOT_FOUND
//   5. 空更新（无字段）→ 不写库、版本不推进
//   6. 传 expectedVersion 时启用乐观锁，不传时向后兼容（无锁）
//
// 纯 SQLite :memory:，无 Core / LLM 依赖。

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { SQLiteWritingStore } from '../../src/writing/repositories/writing-store.js';
import { WritingError, WritingErrorCode } from '../../src/writing/errors/error-codes.js';

describe('W3 乐观锁（writing_drafts）', () => {
  let store: SQLiteWritingStore;

  beforeEach(() => {
    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    store = new SQLiteWritingStore(db);
    store.createTables();
  });

  function makeDraft(): { id: string; version: number } {
    const project = store.createProject('测试');
    const draft = store.createDraft(project.id, { kind: 'event', content: '初始内容' });
    return { id: draft.id, version: draft.version };
  }

  it('version 初始为 1', () => {
    const draft = makeDraft();
    expect(draft.version).toBe(1);
  });

  it('正确版本号写入成功并推进 version，返回 newVersion', () => {
    const draft = makeDraft();

    const r1 = store.updateDraft(draft.id, 1, { content: '第二次内容' });
    expect(r1.newVersion).toBe(2);
    expect(store.getDraft(draft.id)!.version).toBe(2);

    const r2 = store.updateDraft(draft.id, 2, { status: 'ready_to_simulate' });
    expect(r2.newVersion).toBe(3);
    expect(store.getDraft(draft.id)!.version).toBe(3);
  });

  it('过期版本号应抛 VERSION_CONFLICT，且 detail 携带 expected/actual', () => {
    const draft = makeDraft();
    // 先推进到 version 2
    store.updateDraft(draft.id, 1, { content: '新内容' });
    expect(store.getDraft(draft.id)!.version).toBe(2);

    // 用过期的 1 去写 → 冲突
    try {
      store.updateDraft(draft.id, 1, { content: '基于旧副本的修改' });
      throw new Error('应抛出 VERSION_CONFLICT');
    } catch (err) {
      expect(err).toBeInstanceOf(WritingError);
      const e = err as WritingError;
      expect(e.code).toBe(WritingErrorCode.VERSION_CONFLICT);
      expect(e.detail).toMatchObject({ expected: 1, actual: 2, draftId: draft.id });
    }
  });

  it('不存在的草案应抛 WRITING_OBJECT_NOT_FOUND（而非 VERSION_CONFLICT）', () => {
    try {
      store.updateDraft('wdft_not_exist', 1, { content: 'x' });
      throw new Error('应抛出 WRITING_OBJECT_NOT_FOUND');
    } catch (err) {
      expect(err).toBeInstanceOf(WritingError);
      expect((err as WritingError).code).toBe(WritingErrorCode.WRITING_OBJECT_NOT_FOUND);
    }
  });

  it('空更新不写库、版本不推进，回显 expectedVersion', () => {
    const draft = makeDraft();
    const r = store.updateDraft(draft.id, 1, {});
    expect(r.newVersion).toBe(1);
    expect(store.getDraft(draft.id)!.version).toBe(1);
  });

  it('真实并发场景：两个写者基于同一旧版本，仅第一个成功', () => {
    const draft = makeDraft();

    // 写者 A 基于 version 1 写入成功 → version 2
    const a = store.updateDraft(draft.id, 1, { content: 'A 的修改' });
    expect(a.newVersion).toBe(2);

    // 写者 B 仍基于旧版本 1 写入 → 必须失败（丢失更新被阻止）
    expect(() => store.updateDraft(draft.id, 1, { content: 'B 的修改' }))
      .toThrow(WritingError);
    // 最终内容是 A 的，B 的被拒
    expect(store.getDraft(draft.id)!.content).toBe('A 的修改');
  });
});

describe('W3 乐观锁（writing_blueprints）', () => {
  let store: SQLiteWritingStore;

  beforeEach(() => {
    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    store = new SQLiteWritingStore(db);
    store.createTables();
  });

  it('正确版本号写入成功并推进 version', () => {
    const project = store.createProject('测试');
    const bp = store.createBlueprint(project.id, { maturity: 'drafted' });
    expect(bp.version).toBe(1);

    const r = store.updateBlueprint(bp.id, 1, { maturity: 'active' });
    expect(r.newVersion).toBe(2);
    expect(store.getBlueprint(bp.id)!.version).toBe(2);
  });

  it('过期版本号应抛 VERSION_CONFLICT', () => {
    const project = store.createProject('测试');
    const bp = store.createBlueprint(project.id, { maturity: 'drafted' });
    store.updateBlueprint(bp.id, 1, { maturity: 'active' }); // → 2

    try {
      store.updateBlueprint(bp.id, 1, { maturity: 'evolving' });
      throw new Error('应抛出 VERSION_CONFLICT');
    } catch (err) {
      expect((err as WritingError).code).toBe(WritingErrorCode.VERSION_CONFLICT);
      expect((err as WritingError).detail).toMatchObject({ expected: 1, actual: 2, blueprintId: bp.id });
    }
  });

  it('不存在的蓝图应抛 WRITING_OBJECT_NOT_FOUND', () => {
    try {
      store.updateBlueprint('wblp_not_exist', 1, { maturity: 'active' });
      throw new Error('应抛出 WRITING_OBJECT_NOT_FOUND');
    } catch (err) {
      expect((err as WritingError).code).toBe(WritingErrorCode.WRITING_OBJECT_NOT_FOUND);
    }
  });
});

// =============================================================================
// P1-2：三热表乐观锁（Project / EntitySketch / ProposalView）
// =============================================================================

describe('P1-2 乐观锁（writing_projects）', () => {
  let store: SQLiteWritingStore;

  beforeEach(() => {
    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    store = new SQLiteWritingStore(db);
    store.createTables();
  });

  it('version 初始为 1', () => {
    const project = store.createProject('测试');
    expect(project.version).toBe(1);
  });

  it('传 expectedVersion 时启用乐观锁，成功后 version + 1', () => {
    const project = store.createProject('测试');
    store.updateProject(project.id, { title: '新标题' }, 1);
    expect(store.getProject(project.id)!.version).toBe(2);
  });

  it('不传 expectedVersion 时向后兼容（无锁）', () => {
    const project = store.createProject('测试');
    store.updateProject(project.id, { title: '新标题' }); // 无 expectedVersion
    expect(store.getProject(project.id)!.version).toBe(2);
  });

  it('过期版本号应抛 VERSION_CONFLICT', () => {
    const project = store.createProject('测试');
    store.updateProject(project.id, { title: 'A' }, 1); // → 2

    try {
      store.updateProject(project.id, { title: 'B' }, 1); // 仍用 1
      throw new Error('应抛出 VERSION_CONFLICT');
    } catch (err) {
      expect(err).toBeInstanceOf(WritingError);
      expect((err as WritingError).code).toBe(WritingErrorCode.VERSION_CONFLICT);
      expect((err as WritingError).detail).toMatchObject({ expected: 1, actual: 2 });
    }
  });

  it('不存在的项目应抛 WRITING_OBJECT_NOT_FOUND', () => {
    try {
      store.updateProject('wp_not_exist', { title: 'x' }, 1);
      throw new Error('应抛出 WRITING_OBJECT_NOT_FOUND');
    } catch (err) {
      expect((err as WritingError).code).toBe(WritingErrorCode.WRITING_OBJECT_NOT_FOUND);
    }
  });
});

describe('P1-2 乐观锁（writing_entity_sketches）', () => {
  let store: SQLiteWritingStore;

  beforeEach(() => {
    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    store = new SQLiteWritingStore(db);
    store.createTables();
  });

  it('version 初始为 1', () => {
    const project = store.createProject('测试');
    const sketch = store.createEntitySketch(project.id, { displayName: '角色A', typeLabel: '角色' });
    expect(sketch.version).toBe(1);
  });

  it('传 expectedVersion 时启用乐观锁', () => {
    const project = store.createProject('测试');
    const sketch = store.createEntitySketch(project.id, { displayName: '角色A', typeLabel: '角色' });
    store.updateEntitySketch(sketch.id, { displayName: '角色B' }, 1);
    expect(store.getEntitySketch(sketch.id)!.version).toBe(2);
  });

  it('不传 expectedVersion 时向后兼容（无锁）', () => {
    const project = store.createProject('测试');
    const sketch = store.createEntitySketch(project.id, { displayName: '角色A', typeLabel: '角色' });
    store.updateEntitySketch(sketch.id, { displayName: '角色B' });
    expect(store.getEntitySketch(sketch.id)!.version).toBe(2);
  });

  it('过期版本号应抛 VERSION_CONFLICT', () => {
    const project = store.createProject('测试');
    const sketch = store.createEntitySketch(project.id, { displayName: '角色A', typeLabel: '角色' });
    store.updateEntitySketch(sketch.id, { displayName: 'B' }, 1); // → 2

    try {
      store.updateEntitySketch(sketch.id, { displayName: 'C' }, 1);
      throw new Error('应抛出 VERSION_CONFLICT');
    } catch (err) {
      expect(err).toBeInstanceOf(WritingError);
      expect((err as WritingError).code).toBe(WritingErrorCode.VERSION_CONFLICT);
      expect((err as WritingError).detail).toMatchObject({ expected: 1, actual: 2 });
    }
  });

  it('不存在的草图应抛 WRITING_OBJECT_NOT_FOUND', () => {
    try {
      store.updateEntitySketch('wes_not_exist', { displayName: 'x' }, 1);
      throw new Error('应抛出 WRITING_OBJECT_NOT_FOUND');
    } catch (err) {
      expect((err as WritingError).code).toBe(WritingErrorCode.WRITING_OBJECT_NOT_FOUND);
    }
  });
});

describe('P1-2 乐观锁（writing_proposal_views）', () => {
  let store: SQLiteWritingStore;

  beforeEach(() => {
    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    store = new SQLiteWritingStore(db);
    store.createTables();
  });

  it('version 初始为 1', () => {
    const project = store.createProject('测试');
    const pv = store.createProposalView(project.id, { proposalType: 'event' });
    expect(pv.version).toBe(1);
  });

  it('传 expectedVersion 时启用乐观锁', () => {
    const project = store.createProject('测试');
    const pv = store.createProposalView(project.id, { proposalType: 'event' });
    store.updateProposalView(pv.id, { status: 'author_approved' }, 1);
    expect(store.getProposalView(pv.id)!.version).toBe(2);
  });

  it('不传 expectedVersion 时向后兼容（无锁）', () => {
    const project = store.createProject('测试');
    const pv = store.createProposalView(project.id, { proposalType: 'event' });
    store.updateProposalView(pv.id, { status: 'author_approved' });
    expect(store.getProposalView(pv.id)!.version).toBe(2);
  });

  it('过期版本号应抛 VERSION_CONFLICT', () => {
    const project = store.createProject('测试');
    const pv = store.createProposalView(project.id, { proposalType: 'event' });
    store.updateProposalView(pv.id, { status: 'author_approved' }, 1); // → 2

    try {
      store.updateProposalView(pv.id, { status: 'committed' }, 1);
      throw new Error('应抛出 VERSION_CONFLICT');
    } catch (err) {
      expect(err).toBeInstanceOf(WritingError);
      expect((err as WritingError).code).toBe(WritingErrorCode.VERSION_CONFLICT);
      expect((err as WritingError).detail).toMatchObject({ expected: 1, actual: 2 });
    }
  });

  it('不存在的审核视图应抛 WRITING_OBJECT_NOT_FOUND', () => {
    try {
      store.updateProposalView('wpv_not_exist', { status: 'committed' }, 1);
      throw new Error('应抛出 WRITING_OBJECT_NOT_FOUND');
    } catch (err) {
      expect((err as WritingError).code).toBe(WritingErrorCode.WRITING_OBJECT_NOT_FOUND);
    }
  });
});

// =============================================================================
// 乐观锁单元测试（W3）
// =============================================================================
// 验证 writing_drafts / writing_blueprints 的乐观锁语义：
//   1. version 初始为 1
//   2. 每次 updateDraft / updateBlueprint 成功后 version + 1，并返回 newVersion
//   3. 过期版本（expectedVersion != 库中 version）→ 抛 VERSION_CONFLICT，detail 携带 expected/actual
//   4. 不存在的对象 → 抛 WRITING_OBJECT_NOT_FOUND（不是 VERSION_CONFLICT）
//   5. 空更新（无字段）→ 不写库、版本不推进，直接回显 expectedVersion
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

// =============================================================================
// Phase 12 测试：RevisionService——通用修订记录（§19.1）
// =============================================================================

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { SQLiteWritingStore } from '../../src/writing/repositories/writing-store.js';
import { AuditService } from '../../src/writing/services/audit-service.js';
import { RevisionService } from '../../src/writing/services/revision-service.js';
import { makeRequestContext } from '../../src/writing/services/context.js';
import type { WritingRequestContext } from '../../src/writing/services/context.js';

describe('Phase 12 · RevisionService', () => {
  let store: SQLiteWritingStore;
  let service: RevisionService;
  let ctx: WritingRequestContext;

  beforeEach(() => {
    const db = new Database(':memory:');
    store = new SQLiteWritingStore(db);
    store.createTables();
    service = new RevisionService(store, new AuditService(store));
    const projectId = store.createProject('修订测试').id;
    ctx = makeRequestContext({ projectId, trigger: 'author_action' });
  });

  it('recordRevision 记录修订 + 自动生成 versionGroupId', () => {
    const record = service.recordRevision(ctx, {
      targetType: 'draft', targetId: 'wdft_1', action: 'update',
      summary: '修改草案内容',
      afterSnapshot: { content: '新内容' },
    });
    expect(record.id).toMatch(/^wrev_/);
    expect(record.versionGroupId).toBe('draft_wdft_1'); // 自动生成
    expect(record.action).toBe('update');
  });

  it('同一对象多次修订归入同组', () => {
    service.recordRevision(ctx, { targetType: 'draft', targetId: 'wdft_1', action: 'create', summary: '创建' });
    service.recordRevision(ctx, { targetType: 'draft', targetId: 'wdft_1', action: 'update', summary: '改一' });
    service.recordRevision(ctx, { targetType: 'draft', targetId: 'wdft_1', action: 'update', summary: '改二' });

    const records = service.listRevisionsByTarget(ctx, 'draft', 'wdft_1');
    expect(records).toHaveLength(3);
    // 倒序：最新在前
    expect(records[0]!.summary).toBe('改二');
    expect(records[2]!.summary).toBe('创建');
    // 全部同组
    expect(new Set(records.map(r => r.versionGroupId)).size).toBe(1);
  });

  it('listRevisionsByGroup 按组查询', () => {
    service.recordRevision(ctx, {
      targetType: 'prose_document', targetId: 'wpd_1', action: 'create',
      summary: '创建文档', versionGroupId: 'g1',
    });
    service.recordRevision(ctx, {
      targetType: 'draft', targetId: 'wdft_2', action: 'update',
      summary: '另一对象', versionGroupId: 'g1', // 跨类型同组（手动指定）
    });
    const groupRecords = service.listRevisionsByGroup('g1');
    expect(groupRecords).toHaveLength(2);
  });

  it('restoreRevision 返回快照并记一条 restore 记录', () => {
    const original = service.recordRevision(ctx, {
      targetType: 'draft', targetId: 'wdft_1', action: 'update',
      summary: '改之前', afterSnapshot: { content: '旧内容' },
    });
    const result = service.restoreRevision(ctx, original.id);
    expect(result.snapshot).toEqual({ content: '旧内容' });
    expect(result.targetType).toBe('draft');

    // 验证 restore 本身也记了一条
    const records = service.listRevisionsByTarget(ctx, 'draft', 'wdft_1');
    expect(records).toHaveLength(2);
    expect(records[0]!.action).toBe('restore');
  });

  it('修订记录不写 Core（§19.1 不触发 Retcon）', () => {
    // RevisionService 不依赖 Core store，无 Core 写入路径
    service.recordRevision(ctx, {
      targetType: 'entity_sketch', targetId: 'wesk_1', action: 'update',
      summary: '改名候选实体',
    });
    expect(service.listRevisionsByTarget(ctx, 'entity_sketch', 'wesk_1')).toHaveLength(1);
  });

  it('operator 区分 author/agent', () => {
    service.recordRevision(ctx, {
      targetType: 'draft', targetId: 'wdft_1', action: 'create',
      summary: '作者创建', operator: 'author',
    });
    service.recordRevision(ctx, {
      targetType: 'draft', targetId: 'wdft_1', action: 'update',
      summary: 'Agent 建议', operator: 'agent',
    });
    const records = service.listRevisionsByTarget(ctx, 'draft', 'wdft_1');
    expect(records.find(r => r.operator === 'author')).toBeDefined();
    expect(records.find(r => r.operator === 'agent')).toBeDefined();
  });
});

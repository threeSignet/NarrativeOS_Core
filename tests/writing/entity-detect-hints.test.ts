// =============================================================================
// W16 测试：EntityService.detectEntityHints 返回值带重名标记
// =============================================================================
// 验证 Phase7-Refinement §7.6 detectEntityHints 契约：
//   1. 查重标记进入返回值（duplicateSuspected），而非仅审计 detail（§7.6 主流程3）
//   2. 查重范围：仅 candidate/approved/registered 算重复（hint 不算）
//   3. 状态保持 'hint'（duplicate 也只是标记，不阻止创建）
//   4. 审计只记一条汇总（count + duplicateSuspectedCount），不逐个记录（§7.6 副作用4「不逐个记录，太多噪音」）
//
// 使用真实 EntityService + store/audit（:memory:），无 Core/LLM。
// detectEntityHints 不依赖 coreBridge/workflow 运行时，但构造要求 3 依赖齐备。
// =============================================================================

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { SQLiteWritingStore } from '../../src/writing/repositories/writing-store.js';
import { AuditService } from '../../src/writing/services/audit-service.js';
import { WorkflowService } from '../../src/writing/services/workflow-service.js';
import { EntityService } from '../../src/writing/services/entity-service.js';
import { makeRequestContext } from '../../src/writing/services/context.js';

describe('W16 EntityService.detectEntityHints 返回值带重名标记', () => {
  let db: Database.Database;
  let store: SQLiteWritingStore;
  let entityService: EntityService;
  let projectId: string;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    store = new SQLiteWritingStore(db);
    store.createTables();
    const audit = new AuditService(store);
    const workflow = new WorkflowService(store, audit);
    entityService = new EntityService(store, audit, workflow);
    projectId = store.createProject('W16 测试作品').id;
  });

  it('无重名 → 返回值 duplicateSuspected=false，状态 hint', () => {
    const ctx = makeRequestContext({ projectId });
    const hints = entityService.detectEntityHints(ctx, [
      { displayName: '沈墨', typeLabel: '角色', excerpt: '主角' },
    ]);

    expect(hints.length).toBe(1);
    // §7.6 主流程3：返回值标记 duplicate_suspected（无同名已确认实体 → false）
    expect(hints[0]!.duplicateSuspected).toBe(false);
    // 状态保持 hint
    expect(hints[0]!.status).toBe('hint');
    // 交叉类型：返回值仍是 sketch，字段可读
    expect(hints[0]!.displayName).toBe('沈墨');
  });

  it('有重名（同名 registered 已存在）→ 返回值 duplicateSuspected=true，状态仍 hint', () => {
    // 预置同名 registered 实体（模拟已登记的既有实体）
    store.createEntitySketch(projectId, {
      displayName: '沈墨', typeLabel: '角色', status: 'registered',
    });

    const ctx = makeRequestContext({ projectId });
    const hints = entityService.detectEntityHints(ctx, [
      { displayName: '沈墨', typeLabel: '角色' },
    ]);

    // §7.6：已存在同名 registered → 标记 duplicate_suspected，但状态保持 hint（不阻止创建）
    expect(hints[0]!.duplicateSuspected).toBe(true);
    expect(hints[0]!.status).toBe('hint');
  });

  it('查重范围：同名 hint 不算重复（仅 candidate/approved/registered 触发）', () => {
    // 预置同名 hint（低置信度提示，不构成「已确认实体」）
    store.createEntitySketch(projectId, {
      displayName: '沈墨', typeLabel: '角色', status: 'hint',
    });

    const ctx = makeRequestContext({ projectId });
    const hints = entityService.detectEntityHints(ctx, [
      { displayName: '沈墨', typeLabel: '角色' },
    ]);

    // §7.6：hint 不在查重范围 → duplicateSuspected=false
    expect(hints[0]!.duplicateSuspected).toBe(false);
  });

  it('审计只记一条汇总（count + duplicateSuspectedCount），不逐个记录（§7.6 副作用4）', () => {
    // 预置同名 candidate（沈墨重复）
    store.createEntitySketch(projectId, {
      displayName: '沈墨', typeLabel: '角色', status: 'candidate',
    });

    const ctx = makeRequestContext({ projectId });
    entityService.detectEntityHints(ctx, [
      { displayName: '沈墨', typeLabel: '角色' },  // 重复
      { displayName: '沈笙', typeLabel: '角色' },  // 不重复
    ]);

    const logs = store.queryAuditLogs(projectId, { action: 'detect_entity_hints' });
    // §7.6 副作用4：只记一条汇总审计——不逐个记 duplicate（契约明示「不逐个记录，太多噪音」）
    expect(logs.length).toBe(1);
    const detail = logs[0]!.detail as Record<string, unknown>;
    expect(detail.count).toBe(2);
    expect(detail.duplicateSuspectedCount).toBe(1);
  });
});

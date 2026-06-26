// =============================================================================
// G2 listAuditLogs 测试（CLI /audit 的数据源）
// =============================================================================
// 验证 SQLiteWritingStore.listAuditLogs 与 AuditService.list：
//   - result 过滤维度（success/failure/partial）—— 与 queryAuditLogs 的关键差异
//   - action / targetType / targetId 过滤
//   - limit 默认 30（CLI-Layer-Design §4.10）
//   - created_at DESC 排序
//
// 范式对齐 core-bridge-audit.test.ts（:memory: SQLite + 真实栈）。
// 设计文档：CLI-Layer-Design.md §6 G2（行 333）、§4.10（行 289-295）。
// =============================================================================

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { SQLiteWritingStore } from '../../src/writing/repositories/writing-store.js';
import { AuditService } from '../../src/writing/services/audit-service.js';
import { makeRequestContext } from '../../src/writing/services/context.js';
import type { WritingRequestContext } from '../../src/writing/services/context.js';

describe('G2 listAuditLogs（store 层 result 过滤）', () => {
  let db: Database.Database;
  let store: SQLiteWritingStore;
  let auditService: AuditService;
  let projectId: string;
  let ctx: WritingRequestContext;

  beforeEach(() => {
    db = new Database(':memory:');
    store = new SQLiteWritingStore(db);
    store.createTables();
    auditService = new AuditService(store);
    projectId = store.createProject('G2 测试作品').id;
    ctx = makeRequestContext({ projectId, trigger: 'author_action' });
  });

  /** 写一条审计记录的快捷方法 */
  function log(action: string, result: 'success' | 'failure' | 'partial', extra?: {
    targetType?: string; targetId?: string;
  }) {
    auditService.record(ctx, {
      action, result,
      targetType: extra?.targetType ?? 'draft',
      targetId: extra?.targetId ?? `t_${action}`,
    });
  }

  it('result 过滤：只返回指定结果的记录', () => {
    log('commit_proposal', 'success');
    log('commit_proposal', 'failure');
    log('commit_proposal', 'partial');
    log('register_entity', 'success');

    const failures = store.listAuditLogs(projectId, { result: 'failure' });
    expect(failures).toHaveLength(1);
    expect(failures[0]!.result).toBe('failure');
    expect(failures[0]!.action).toBe('commit_proposal');

    const partials = store.listAuditLogs(projectId, { result: 'partial' });
    expect(partials).toHaveLength(1);
    expect(partials[0]!.result).toBe('partial');

    const successes = store.listAuditLogs(projectId, { result: 'success' });
    expect(successes).toHaveLength(2);
    expect(successes.every(l => l.result === 'success')).toBe(true);
  });

  it('action 过滤：只返回指定 action 的记录', () => {
    log('commit_proposal', 'success');
    log('register_entity', 'success');
    log('detect_entity_hints', 'success');

    const commits = store.listAuditLogs(projectId, { action: 'commit_proposal' });
    expect(commits).toHaveLength(1);
    expect(commits[0]!.action).toBe('commit_proposal');
  });

  it('result + action 组合过滤', () => {
    log('commit_proposal', 'success');
    log('commit_proposal', 'failure');
    log('register_entity', 'failure');

    const failedCommits = store.listAuditLogs(projectId, {
      action: 'commit_proposal', result: 'failure',
    });
    expect(failedCommits).toHaveLength(1);
    expect(failedCommits[0]!.action).toBe('commit_proposal');
    expect(failedCommits[0]!.result).toBe('failure');
  });

  it('limit 默认 30（CLI-Layer-Design §4.10）', () => {
    // 写 35 条
    for (let i = 0; i < 35; i++) {
      log(`action_${i}`, 'success');
    }
    // 不传 limit → 默认 30
    const all = store.listAuditLogs(projectId);
    expect(all).toHaveLength(30);
    // 显式 limit 覆盖默认
    const ten = store.listAuditLogs(projectId, { limit: 10 });
    expect(ten).toHaveLength(10);
  });

  it('created_at DESC 排序（最新在前）', () => {
    // 直接用显式时间戳插入，避免依赖 SQLite datetime('now') 秒精度导致同秒记录排序不稳定。
    // 修复：原实现用 setTimeout 1100ms 强制跨秒，CI 上可能 flaky（高负载时秒边界漂移）。
    const insertAt = (action: string, createdAt: string) => {
      db.prepare(
        `INSERT INTO writing_audit_logs (id, project_id, action, target_type, target_id, trigger_source, result, detail_json, source_refs_json, created_at)
         VALUES (?, ?, ?, 'draft', ?, 'author_action', 'success', '{}', '[]', ?)`
      ).run(`wal_${action}`, projectId, action, `t_${action}`, createdAt);
    };
    insertAt('first', '2026-06-25 10:00:00');
    insertAt('second', '2026-06-25 10:00:01');
    insertAt('third', '2026-06-25 10:00:02');

    const all = store.listAuditLogs(projectId);
    expect(all[0]!.action).toBe('third');
    expect(all[1]!.action).toBe('second');
    expect(all[2]!.action).toBe('first');
  });

  it('targetType / targetId 过滤', () => {
    log('commit_proposal', 'success', { targetType: 'proposal_view', targetId: 'pv_001' });
    log('commit_proposal', 'success', { targetType: 'entity_sketch', targetId: 'sk_002' });

    const byType = store.listAuditLogs(projectId, { targetType: 'proposal_view' });
    expect(byType).toHaveLength(1);
    expect(byType[0]!.targetId).toBe('pv_001');

    const byId = store.listAuditLogs(projectId, { targetId: 'sk_002' });
    expect(byId).toHaveLength(1);
    expect(byId[0]!.targetType).toBe('entity_sketch');
  });

  it('空结果：无记录返回空数组', () => {
    expect(store.listAuditLogs(projectId)).toEqual([]);
    expect(store.listAuditLogs(projectId, { result: 'failure' })).toEqual([]);
  });

  it('不影响现有 queryAuditLogs（兼容性）', () => {
    // listAuditLogs 新增不应破坏 queryAuditLogs 既有行为
    log('commit_proposal', 'failure');
    log('commit_proposal', 'success');
    // queryAuditLogs 不支持 result 过滤，返回全部
    const queried = store.queryAuditLogs(projectId, { action: 'commit_proposal' });
    expect(queried).toHaveLength(2);
    // listAuditLogs 支持 result 过滤
    const listed = store.listAuditLogs(projectId, { action: 'commit_proposal', result: 'failure' });
    expect(listed).toHaveLength(1);
  });
});

describe('G2 AuditService.list（service 层包装）', () => {
  let store: SQLiteWritingStore;
  let auditService: AuditService;
  let ctx: WritingRequestContext;

  beforeEach(() => {
    const db = new Database(':memory:');
    store = new SQLiteWritingStore(db);
    store.createTables();
    auditService = new AuditService(store);
    const projectId = store.createProject('G2 service 测试').id;
    ctx = makeRequestContext({ projectId, trigger: 'author_action' });
  });

  it('list 走 ctx.projectId，与 query 并列且不互相影响', () => {
    auditService.record(ctx, { action: 'commit_proposal', result: 'success' });
    auditService.record(ctx, { action: 'commit_proposal', result: 'failure' });
    auditService.record(ctx, { action: 'register_entity', result: 'success' });

    // list 支持 result 过滤
    const failures = auditService.list(ctx, { result: 'failure' });
    expect(failures).toHaveLength(1);
    expect(failures[0]!.action).toBe('commit_proposal');

    // query 仍按原签名工作（无 result 维度）
    const all = auditService.query(ctx, { action: 'commit_proposal' });
    expect(all).toHaveLength(2);
  });

  it('list limit 默认 30', () => {
    for (let i = 0; i < 32; i++) {
      auditService.record(ctx, { action: `act_${i}`, result: 'success' });
    }
    expect(auditService.list(ctx)).toHaveLength(30);
  });
});

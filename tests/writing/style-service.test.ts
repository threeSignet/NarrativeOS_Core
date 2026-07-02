// =============================================================================
// Phase 12 测试：StyleService——风格指南（§18）
// =============================================================================

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { SQLiteWritingStore } from '../../src/writing/repositories/writing-store.js';
import { AuditService } from '../../src/writing/services/audit-service.js';
import { StyleService } from '../../src/writing/services/style-service.js';
import { makeRequestContext } from '../../src/writing/services/context.js';
import type { WritingRequestContext } from '../../src/writing/services/context.js';

describe('Phase 12 · StyleService', () => {
  let store: SQLiteWritingStore;
  let service: StyleService;
  let ctx: WritingRequestContext;

  beforeEach(() => {
    const db = new Database(':memory:');
    store = new SQLiteWritingStore(db);
    store.createTables();
    service = new StyleService(store, new AuditService(store));
    const projectId = store.createProject('风格测试').id;
    ctx = makeRequestContext({ projectId, trigger: 'author_action' });
  });

  it('getOrCreateDefaultGuide 首次创建、二次复用（1:1）', () => {
    const first = service.getOrCreateDefaultGuide(ctx);
    const second = service.getOrCreateDefaultGuide(ctx);
    expect(first.id).toBe(second.id);
    expect(first.scope).toBe('default');
    expect(first.status).toBe('draft');
    expect(first.narrativePerson).toBe('unspecified'); // 默认值
  });

  it('updateGuide 更新风格字段', () => {
    const guide = service.getOrCreateDefaultGuide(ctx);
    service.updateGuide(ctx, guide.id, {
      narrativePerson: 'third',
      narrativeDistance: 'close',
      pacingPreference: 'tight',
      descriptionPreference: ['action', 'sensory'],
    });
    const refreshed = service.getGuide(ctx, guide.id);
    expect(refreshed.narrativePerson).toBe('third');
    expect(refreshed.narrativeDistance).toBe('close');
    expect(refreshed.pacingPreference).toBe('tight');
    expect(refreshed.descriptionPreference).toEqual(['action', 'sensory']);
    expect(refreshed.version).toBe(2);
  });

  it('addExample 添加正/反向示例', () => {
    const pos = service.addExample(ctx, { kind: 'positive', text: '月光如水' });
    const neg = service.addExample(ctx, { kind: 'negative', text: '然后他就死了', note: '太突兀' });
    const list = service.listExamples(ctx);
    expect(list).toHaveLength(2);
    expect(pos.kind).toBe('positive');
    expect(neg.note).toBe('太突兀');
  });

  it('addBannedExpression 添加禁用表达', () => {
    const banned = service.addBannedExpression(ctx, { pattern: '然后', reason: '过度使用', category: '套路句' });
    const list = service.listBannedExpressions(ctx);
    expect(list).toHaveLength(1);
    expect(banned.pattern).toBe('然后');
    expect(banned.category).toBe('套路句');
  });

  it('listGuides 返回项目所有指南', () => {
    service.getOrCreateDefaultGuide(ctx);
    const guides = service.listGuides(ctx);
    expect(guides).toHaveLength(1);
    expect(guides[0]!.scope).toBe('default');
  });

  it('跨项目访问被拒绝', () => {
    const guide = service.getOrCreateDefaultGuide(ctx);
    const otherProjectId = store.createProject('其他').id;
    const otherCtx = makeRequestContext({ projectId: otherProjectId, trigger: 'author_action' });
    expect(() => service.getGuide(otherCtx, guide.id)).toThrow();
  });

  it('风格指南不写 Core（无 Core 交互）', () => {
    // StyleService 不依赖任何 Core store；验证无 Core 写入路径
    const guide = service.getOrCreateDefaultGuide(ctx);
    service.updateGuide(ctx, guide.id, { narrativePerson: 'first' });
    service.addExample(ctx, { kind: 'positive', text: '示例' });
    service.addBannedExpression(ctx, { pattern: '禁词' });
    // 仅验证不抛错（无 Core 调用即满足 §18.1 验收）
    expect(service.listGuides(ctx)).toHaveLength(1);
    expect(service.listExamples(ctx)).toHaveLength(1);
    expect(service.listBannedExpressions(ctx)).toHaveLength(1);
  });
});

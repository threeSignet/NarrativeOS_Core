// =============================================================================
// ThreadResolver 集成测试
// =============================================================================
// 覆盖四个核心方法 + 状态转换校验：
//   1. isThreadClosable（closeCondition 各字段逐项检查）
//   2. resolveThreads（双通道关闭、合并去重、错误处理）
//   3. getExpiringThreads（回溯型线索 deadline 预警）
//   4. getHintableThreads（渐进型线索可暗示判定）
//   5. validateTransition（回溯型 + 渐进型状态机校验）
// =============================================================================

import { describe, it, expect } from 'vitest';
import { ThreadResolver } from '../../src/core/thread-resolver.js';
import type { NarrativeThread, NarrativeEvent } from '../../src/types.js';

// ---------------------------------------------------------------------------
// 测试数据工厂
// ---------------------------------------------------------------------------

/** 创建一个标准的叙事事件 */
function makeEvent(overrides: Partial<NarrativeEvent> & { type: string; chapter: number }): NarrativeEvent {
  return {
    id: overrides.id ?? `evt_${overrides.type}_${overrides.chapter}`,
    kind: 'business',
    type: overrides.type,
    chapter: overrides.chapter,
    description: overrides.description ?? `测试事件：${overrides.type}`,
    params: overrides.params ?? { subject: 'ent_hero' },
    context: 'global',
    timestamp: new Date().toISOString(),
    factGroupId: overrides.factGroupId ?? `evt_${overrides.type}_${overrides.chapter}`,
    resolvedThreads: [],
    dependentFactIds: [],
  };
}

/** 创建一个回溯型线索 */
function makeRetroactiveThread(overrides: {
  id?: string;
  status?: NarrativeThread['status'];
  requiredEventType?: string;
  withinChapters?: number;
  customRule?: string;
  createdAtChapter?: number;
  relatedEntities?: string[];
  milestones?: NarrativeThread['milestones'];
}): NarrativeThread {
  return {
    id: overrides.id ?? 'thr_test_10',
    type: 'causal_gap',
    direction: 'retroactive',
    severity: 'major',
    description: '测试回溯型线索',
    closeCondition: {
      ...(overrides.requiredEventType ? { requiredEventType: overrides.requiredEventType } : {}),
      ...(overrides.withinChapters !== undefined ? { withinChapters: overrides.withinChapters } : {}),
      ...(overrides.customRule ? { customRule: overrides.customRule } : {}),
    },
    status: overrides.status ?? 'UNFILLED',
    closedBy: null,
    createdAtEvent: 'evt_setup_10',
    createdAtChapter: overrides.createdAtChapter ?? 10,
    milestones: overrides.milestones ?? [],
    relatedEntities: overrides.relatedEntities ?? ['ent_hero'],
    upstreamFactIds: [],
  };
}

/** 创建一个渐进型线索 */
function makeProgressiveThread(overrides: {
  id?: string;
  status?: NarrativeThread['status'];
  minHints?: number;
  customRule?: string;
  createdAtChapter?: number;
  relatedEntities?: string[];
  milestones?: NarrativeThread['milestones'];
}): NarrativeThread {
  return {
    id: overrides.id ?? 'thr_foreshadow_10',
    type: 'foreshadowing',
    direction: 'progressive',
    severity: 'minor',
    description: '测试渐进型线索',
    closeCondition: {
      ...(overrides.minHints !== undefined ? { minHints: overrides.minHints } : {}),
      ...(overrides.customRule ? { customRule: overrides.customRule } : {}),
    },
    status: overrides.status ?? 'PLANTED',
    closedBy: null,
    createdAtEvent: 'evt_setup_10',
    createdAtChapter: overrides.createdAtChapter ?? 10,
    milestones: overrides.milestones ?? [],
    relatedEntities: overrides.relatedEntities ?? ['ent_hero'],
    upstreamFactIds: [],
  };
}

// ===========================================================================
// 测试套件
// ===========================================================================

describe('ThreadResolver', () => {
  const resolver = new ThreadResolver();

  // =========================================================================
  // isThreadClosable
  // =========================================================================

  describe('isThreadClosable', () => {
    // ---- 回溯型 ----

    it('回溯型 UNFILLED + requiredEventType 匹配 → true', () => {
      const thread = makeRetroactiveThread({
        status: 'UNFILLED',
        requiredEventType: 'encounter',
      });
      const event = makeEvent({ type: 'encounter', chapter: 15 });
      expect(resolver.isThreadClosable(thread, event)).toBe(true);
    });

    it('回溯型 UNFILLED + requiredEventType 不匹配 → false', () => {
      const thread = makeRetroactiveThread({
        status: 'UNFILLED',
        requiredEventType: 'encounter',
      });
      const event = makeEvent({ type: 'battle', chapter: 15 });
      expect(resolver.isThreadClosable(thread, event)).toBe(false);
    });

    it('回溯型 UNFILLED + withinChapters 未过期 → true', () => {
      const thread = makeRetroactiveThread({
        status: 'UNFILLED',
        requiredEventType: 'encounter',
        withinChapters: 10,
        createdAtChapter: 10,
      });
      // deadline = 10 + 10 = 20，event.chapter=20 刚好不超期
      const event = makeEvent({ type: 'encounter', chapter: 20 });
      expect(resolver.isThreadClosable(thread, event)).toBe(true);
    });

    it('回溯型 UNFILLED + withinChapters 已过期 → false', () => {
      const thread = makeRetroactiveThread({
        status: 'UNFILLED',
        requiredEventType: 'encounter',
        withinChapters: 5,
        createdAtChapter: 10,
      });
      // deadline = 10 + 5 = 15，event.chapter=16 超期
      const event = makeEvent({ type: 'encounter', chapter: 16 });
      expect(resolver.isThreadClosable(thread, event)).toBe(false);
    });

    it('回溯型 FILLED（已关闭）→ false', () => {
      const thread = makeRetroactiveThread({
        status: 'FILLED',
        requiredEventType: 'encounter',
      });
      const event = makeEvent({ type: 'encounter', chapter: 15 });
      expect(resolver.isThreadClosable(thread, event)).toBe(false);
    });

    it('回溯型 UNFILLED + customRule → false（只能显式关闭）', () => {
      const thread = makeRetroactiveThread({
        status: 'UNFILLED',
        requiredEventType: 'encounter',
        customRule: '需要补充复活事件',
      });
      const event = makeEvent({ type: 'encounter', chapter: 15 });
      expect(resolver.isThreadClosable(thread, event)).toBe(false);
    });

    it('回溯型 UNFILLED + 无 closeCondition（空条件）→ true', () => {
      // 没有 requiredEventType 也没有其他条件，任何事件都可关闭
      const thread = makeRetroactiveThread({ status: 'UNFILLED' });
      const event = makeEvent({ type: 'anything', chapter: 15 });
      expect(resolver.isThreadClosable(thread, event)).toBe(true);
    });

    // ---- 渐进型 ----

    it('渐进型 PLANTED + 无 minHints → true', () => {
      const thread = makeProgressiveThread({ status: 'PLANTED' });
      const event = makeEvent({ type: 'hint', chapter: 15 });
      expect(resolver.isThreadClosable(thread, event)).toBe(true);
    });

    it('渐进型 PLANTED + minHints 未达标 → false', () => {
      const thread = makeProgressiveThread({
        status: 'PLANTED',
        minHints: 3,
        milestones: [
          { id: 'ms_1', status: 'HINTED', chapter: 12, description: '暗示1', createdAt: '' },
          { id: 'ms_2', status: 'HINTED', chapter: 13, description: '暗示2', createdAt: '' },
        ],
      });
      // 只有 2 次暗示，需要 3 次
      const event = makeEvent({ type: 'reveal', chapter: 15 });
      expect(resolver.isThreadClosable(thread, event)).toBe(false);
    });

    it('渐进型 HINTED + minHints 已达标 → true', () => {
      const thread = makeProgressiveThread({
        status: 'HINTED',
        minHints: 2,
        milestones: [
          { id: 'ms_1', status: 'HINTED', chapter: 12, description: '暗示1', createdAt: '' },
          { id: 'ms_2', status: 'HINTED', chapter: 13, description: '暗示2', createdAt: '' },
        ],
      });
      // 正好 2 次暗示
      const event = makeEvent({ type: 'reveal', chapter: 15 });
      expect(resolver.isThreadClosable(thread, event)).toBe(true);
    });

    it('渐进型 PARTIALLY_REVEALED 跳过 minHints 检查 → true', () => {
      const thread = makeProgressiveThread({
        status: 'PARTIALLY_REVEALED',
        minHints: 5, // 要求 5 次但只有 1 次，但因为 PARTIALLY_REVEALED 跳过此检查
        milestones: [
          { id: 'ms_1', status: 'HINTED', chapter: 12, description: '暗示1', createdAt: '' },
        ],
      });
      const event = makeEvent({ type: 'reveal', chapter: 15 });
      expect(resolver.isThreadClosable(thread, event)).toBe(true);
    });

    it('渐进型 RESOLVED（已关闭）→ false', () => {
      const thread = makeProgressiveThread({ status: 'RESOLVED' });
      const event = makeEvent({ type: 'reveal', chapter: 15 });
      expect(resolver.isThreadClosable(thread, event)).toBe(false);
    });

    it('渐进型 PLANTED + customRule → false', () => {
      const thread = makeProgressiveThread({
        status: 'PLANTED',
        customRule: '需要特定仪式',
      });
      const event = makeEvent({ type: 'reveal', chapter: 15 });
      expect(resolver.isThreadClosable(thread, event)).toBe(false);
    });
  });

  // =========================================================================
  // resolveThreads（双通道关闭）
  // =========================================================================

  describe('resolveThreads', () => {
    it('通道一：自动关闭匹配的回溯型线索', () => {
      const thread1 = makeRetroactiveThread({
        id: 'thr_auto_10',
        status: 'UNFILLED',
        requiredEventType: 'encounter',
      });
      const thread2 = makeRetroactiveThread({
        id: 'thr_no_match_10',
        status: 'UNFILLED',
        requiredEventType: 'battle',
      });
      const event = makeEvent({ type: 'encounter', chapter: 15 });

      const result = resolver.resolveThreads(event, [thread1, thread2]);

      expect(result.resolved).toHaveLength(1);
      expect(result.resolved[0]!.id).toBe('thr_auto_10');
      expect(result.stillOpen).toHaveLength(1);
      expect(result.stillOpen[0]!.id).toBe('thr_no_match_10');
      expect(result.resolutions).toHaveLength(1);
      expect(result.resolutions[0]!.channel).toBe('auto');
      expect(result.resolutions[0]!.newStatus).toBe('FILLED');
      expect(result.resolutions[0]!.needsMilestone).toBe(false);
    });

    it('通道二：显式关闭作者声明的线索（跳过 closeCondition）', () => {
      const thread = makeRetroactiveThread({
        id: 'thr_custom_10',
        status: 'UNFILLED',
        customRule: '需要补充复活事件',
      });
      // customRule 线索在自动通道不可关闭，但可通过显式通道关闭
      const event = makeEvent({ type: 'resurrection', chapter: 15 });

      const result = resolver.resolveThreads(event, [thread], ['thr_custom_10']);

      expect(result.resolved).toHaveLength(1);
      expect(result.resolutions[0]!.channel).toBe('explicit');
      expect(result.resolutions[0]!.newStatus).toBe('FILLED');
      expect(result.errors).toHaveLength(0);
    });

    it('双通道互补不互斥——同一线索同时满足两个通道（去重）', () => {
      const thread = makeRetroactiveThread({
        id: 'thr_both_10',
        status: 'UNFILLED',
        requiredEventType: 'encounter',
      });
      const event = makeEvent({ type: 'encounter', chapter: 15 });

      // 既在自动通道匹配，又在显式声明中
      const result = resolver.resolveThreads(event, [thread], ['thr_both_10']);

      // 只关闭一次（去重）
      expect(result.resolved).toHaveLength(1);
      expect(result.resolutions).toHaveLength(1);
      // 自动通道优先（先执行），所以 channel 是 auto
      expect(result.resolutions[0]!.channel).toBe('auto');
    });

    it('渐进型线索关闭时追加里程碑', () => {
      const thread = makeProgressiveThread({
        id: 'thr_prog_10',
        status: 'PLANTED',
      });
      const event = makeEvent({ type: 'reveal', chapter: 15 });

      const result = resolver.resolveThreads(event, [thread]);

      expect(result.resolved).toHaveLength(1);
      expect(result.resolutions[0]!.newStatus).toBe('RESOLVED');
      expect(result.resolutions[0]!.needsMilestone).toBe(true);
      expect(result.resolutions[0]!.milestoneStatus).toBe('RESOLVED');
    });

    it('显式关闭已关闭线索 → THREAD_ALREADY_CLOSED 错误', () => {
      const thread = makeRetroactiveThread({
        id: 'thr_closed_10',
        status: 'FILLED',
      });
      const event = makeEvent({ type: 'encounter', chapter: 15 });

      const result = resolver.resolveThreads(event, [thread], ['thr_closed_10']);

      expect(result.resolved).toHaveLength(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('THREAD_ALREADY_CLOSED');
    });

    it('显式关闭不存在的线索 → THREAD_NOT_FOUND 错误', () => {
      const event = makeEvent({ type: 'encounter', chapter: 15 });

      const result = resolver.resolveThreads(event, [], ['thr_nonexistent']);

      expect(result.resolved).toHaveLength(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('THREAD_NOT_FOUND');
    });

    it('混合场景：多条线索，部分自动、部分显式、部分不动', () => {
      const t1 = makeRetroactiveThread({
        id: 'thr_auto_close',
        status: 'UNFILLED',
        requiredEventType: 'encounter',
      });
      const t2 = makeRetroactiveThread({
        id: 'thr_explicit_close',
        status: 'UNFILLED',
        customRule: '需要特殊事件',
      });
      const t3 = makeProgressiveThread({
        id: 'thr_stays_open',
        status: 'PLANTED',
        minHints: 3,
      });
      const t4 = makeRetroactiveThread({
        id: 'thr_auto_2',
        status: 'UNFILLED',
        requiredEventType: 'encounter',
      });
      const event = makeEvent({ type: 'encounter', chapter: 15 });

      const result = resolver.resolveThreads(
        event,
        [t1, t2, t3, t4],
        ['thr_explicit_close'],
      );

      // t1, t4 自动关闭；t2 显式关闭；t3 不动
      expect(result.resolved).toHaveLength(3);
      expect(result.stillOpen).toHaveLength(1);
      expect(result.stillOpen[0]!.id).toBe('thr_stays_open');

      const autoActions = result.resolutions.filter(r => r.channel === 'auto');
      const explicitActions = result.resolutions.filter(r => r.channel === 'explicit');
      expect(autoActions).toHaveLength(2); // t1, t4
      expect(explicitActions).toHaveLength(1); // t2
    });
  });

  // =========================================================================
  // getExpiringThreads
  // =========================================================================

  describe('getExpiringThreads', () => {
    it('在预警窗口内的回溯型线索 → 返回', () => {
      const thread = makeRetroactiveThread({
        status: 'UNFILLED',
        withinChapters: 10,
        createdAtChapter: 10,
      });
      // deadline = 20，currentChapter=16，window=5 → 16 >= 20-5=15，且 16 < 20
      const result = resolver.getExpiringThreads([thread], 16, 5);
      expect(result).toHaveLength(1);
    });

    it('刚到 deadline 的线索 → 不算"即将超期"（算"已超期"）', () => {
      const thread = makeRetroactiveThread({
        status: 'UNFILLED',
        withinChapters: 10,
        createdAtChapter: 10,
      });
      // deadline = 20，currentChapter=20 → 不算"即将超期"
      const result = resolver.getExpiringThreads([thread], 20, 5);
      expect(result).toHaveLength(0);
    });

    it('远在预警窗口外的线索 → 不返回', () => {
      const thread = makeRetroactiveThread({
        status: 'UNFILLED',
        withinChapters: 10,
        createdAtChapter: 10,
      });
      // deadline = 20，currentChapter=10，window=5 → 10 < 20-5=15
      const result = resolver.getExpiringThreads([thread], 10, 5);
      expect(result).toHaveLength(0);
    });

    it('未定义 withinChapters 的线索 → 不返回（无 deadline 概念）', () => {
      const thread = makeRetroactiveThread({
        status: 'UNFILLED',
        // 不设置 withinChapters
      });
      const result = resolver.getExpiringThreads([thread], 50, 5);
      expect(result).toHaveLength(0);
    });

    it('渐进型线索 → 不返回（只有回溯型有 deadline）', () => {
      const thread = makeProgressiveThread({
        status: 'PLANTED',
        createdAtChapter: 10,
      });
      // 即使渐进型线索有类似的 closeCondition.withinChapters（虽然实际不会设置）
      const result = resolver.getExpiringThreads([thread], 50, 5);
      expect(result).toHaveLength(0);
    });

    it('已关闭的回溯型线索 → 不返回', () => {
      const thread = makeRetroactiveThread({
        status: 'FILLED',
        withinChapters: 10,
        createdAtChapter: 10,
      });
      const result = resolver.getExpiringThreads([thread], 16, 5);
      expect(result).toHaveLength(0);
    });

    it('默认预警窗口为 5 章', () => {
      const thread = makeRetroactiveThread({
        status: 'UNFILLED',
        withinChapters: 10,
        createdAtChapter: 10,
      });
      // deadline=20, currentChapter=15, window=5 → 15 >= 15, 15 < 20
      const result = resolver.getExpiringThreads([thread], 15);
      expect(result).toHaveLength(1);
    });
  });

  // =========================================================================
  // getHintableThreads
  // =========================================================================

  describe('getHintableThreads', () => {
    it('渐进型 PLANTED + 事件主体在线索 relatedEntities 中 → 返回', () => {
      const thread = makeProgressiveThread({
        status: 'PLANTED',
        relatedEntities: ['ent_hero', 'ent_sword'],
      });
      const event = makeEvent({
        type: 'discovery',
        chapter: 15,
        params: { subject: 'ent_hero' },
      });

      const result = resolver.getHintableThreads([thread], event);
      expect(result).toHaveLength(1);
    });

    it('渐进型 HINTED（可再次暗示）→ 返回', () => {
      const thread = makeProgressiveThread({
        status: 'HINTED',
        relatedEntities: ['ent_hero'],
      });
      const event = makeEvent({
        type: 'discovery',
        chapter: 15,
        params: { subject: 'ent_hero' },
      });

      const result = resolver.getHintableThreads([thread], event);
      expect(result).toHaveLength(1);
    });

    it('渐进型但事件主体不在线索 relatedEntities 中 → 不返回', () => {
      const thread = makeProgressiveThread({
        status: 'PLANTED',
        relatedEntities: ['ent_villain'],
      });
      const event = makeEvent({
        type: 'discovery',
        chapter: 15,
        params: { subject: 'ent_hero' },
      });

      const result = resolver.getHintableThreads([thread], event);
      expect(result).toHaveLength(0);
    });

    it('回溯型线索 → 不返回（只建议渐进型线索的暗示）', () => {
      const thread = makeRetroactiveThread({
        status: 'UNFILLED',
        relatedEntities: ['ent_hero'],
      });
      const event = makeEvent({
        type: 'encounter',
        chapter: 15,
        params: { subject: 'ent_hero' },
      });

      const result = resolver.getHintableThreads([thread], event);
      expect(result).toHaveLength(0);
    });

    it('渐进型 RESOLVED / PARTIALLY_REVEALED → 不返回', () => {
      const t1 = makeProgressiveThread({
        id: 'thr_resolved',
        status: 'RESOLVED',
        relatedEntities: ['ent_hero'],
      });
      const t2 = makeProgressiveThread({
        id: 'thr_partial',
        status: 'PARTIALLY_REVEALED',
        relatedEntities: ['ent_hero'],
      });
      const event = makeEvent({
        type: 'discovery',
        chapter: 15,
        params: { subject: 'ent_hero' },
      });

      const result = resolver.getHintableThreads([t1, t2], event);
      expect(result).toHaveLength(0);
    });

    it('事件无 subject → 不返回任何线索', () => {
      const thread = makeProgressiveThread({
        status: 'PLANTED',
        relatedEntities: ['ent_hero'],
      });
      const event = makeEvent({
        type: 'system_event',
        chapter: 15,
        params: {}, // 无 subject
      });

      const result = resolver.getHintableThreads([thread], event);
      expect(result).toHaveLength(0);
    });
  });

  // =========================================================================
  // validateTransition（状态机校验）
  // =========================================================================

  describe('validateTransition', () => {
    // ---- 回溯型合法路径 ----

    it('回溯型 UNFILLED → FILLED → 合法', () => {
      const thread = makeRetroactiveThread({ status: 'UNFILLED' });
      const result = resolver.validateTransition(thread, 'FILLED');
      expect(result.valid).toBe(true);
    });

    it('回溯型 UNFILLED → ABANDONED → 合法', () => {
      const thread = makeRetroactiveThread({ status: 'UNFILLED' });
      const result = resolver.validateTransition(thread, 'ABANDONED');
      expect(result.valid).toBe(true);
    });

    it('回溯型 UNFILLED → OBSOLETE → 合法', () => {
      const thread = makeRetroactiveThread({ status: 'UNFILLED' });
      const result = resolver.validateTransition(thread, 'OBSOLETE');
      expect(result.valid).toBe(true);
    });

    it('回溯型 FILLED → UNFILLED → 合法（Retcon 撤回）', () => {
      const thread = makeRetroactiveThread({ status: 'FILLED' });
      const result = resolver.validateTransition(thread, 'UNFILLED');
      expect(result.valid).toBe(true);
    });

    // ---- 回溯型非法路径 ----

    it('回溯型 UNFILLED → RESOLVED → 非法', () => {
      const thread = makeRetroactiveThread({ status: 'UNFILLED' });
      const result = resolver.validateTransition(thread, 'RESOLVED');
      expect(result.valid).toBe(false);
    });

    it('回溯型 FILLED → FILLED → 非法（重复关闭）', () => {
      const thread = makeRetroactiveThread({ status: 'FILLED' });
      const result = resolver.validateTransition(thread, 'FILLED');
      expect(result.valid).toBe(false);
    });

    // ---- 渐进型合法路径 ----

    it('渐进型 PLANTED → HINTED → 合法', () => {
      const thread = makeProgressiveThread({ status: 'PLANTED' });
      const result = resolver.validateTransition(thread, 'HINTED');
      expect(result.valid).toBe(true);
    });

    it('渐进型 PLANTED → RESOLVED → 合法（直接回收）', () => {
      const thread = makeProgressiveThread({ status: 'PLANTED' });
      const result = resolver.validateTransition(thread, 'RESOLVED');
      expect(result.valid).toBe(true);
    });

    it('渐进型 HINTED → HINTED → 合法（多次暗示）', () => {
      const thread = makeProgressiveThread({ status: 'HINTED' });
      const result = resolver.validateTransition(thread, 'HINTED');
      expect(result.valid).toBe(true);
    });

    it('渐进型 HINTED → RESOLVED → 合法', () => {
      const thread = makeProgressiveThread({ status: 'HINTED' });
      const result = resolver.validateTransition(thread, 'RESOLVED');
      expect(result.valid).toBe(true);
    });

    it('渐进型 任意 → ABANDONED → 合法', () => {
      for (const status of ['PLANTED', 'HINTED', 'PARTIALLY_REVEALED'] as const) {
        const thread = makeProgressiveThread({ status });
        const result = resolver.validateTransition(thread, 'ABANDONED');
        expect(result.valid).toBe(true);
      }
    });

    it('渐进型 任意 → OBSOLETE → 合法', () => {
      for (const status of ['PLANTED', 'HINTED', 'PARTIALLY_REVEALED'] as const) {
        const thread = makeProgressiveThread({ status });
        const result = resolver.validateTransition(thread, 'OBSOLETE');
        expect(result.valid).toBe(true);
      }
    });

    it('渐进型 PARTIALLY_REVEALED → RESOLVED → 合法', () => {
      const thread = makeProgressiveThread({ status: 'PARTIALLY_REVEALED' });
      const result = resolver.validateTransition(thread, 'RESOLVED');
      expect(result.valid).toBe(true);
    });

    // ---- 渐进型非法路径 ----

    it('渐进型 PLANTED → UNFILLED → 非法', () => {
      const thread = makeProgressiveThread({ status: 'PLANTED' });
      const result = resolver.validateTransition(thread, 'UNFILLED');
      expect(result.valid).toBe(false);
    });

    it('渐进型 RESOLVED → PLANTED → 非法', () => {
      const thread = makeProgressiveThread({ status: 'RESOLVED' });
      const result = resolver.validateTransition(thread, 'PLANTED');
      expect(result.valid).toBe(false);
    });

    it('渐进型 ABANDONED → RESOLVED → 非法（终态不可恢复）', () => {
      const thread = makeProgressiveThread({ status: 'ABANDONED' });
      const result = resolver.validateTransition(thread, 'RESOLVED');
      expect(result.valid).toBe(false);
    });

    it('非法转换包含原因描述', () => {
      const thread = makeRetroactiveThread({ id: 'thr_test', status: 'UNFILLED' });
      const result = resolver.validateTransition(thread, 'RESOLVED');
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('thr_test');
      expect(result.reason).toContain('UNFILLED');
      expect(result.reason).toContain('RESOLVED');
    });
  });
});

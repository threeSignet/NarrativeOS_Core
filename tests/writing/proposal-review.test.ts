// =============================================================================
// W7 测试：Proposal Review 四件套投影（buildProposalReviewData）
// =============================================================================
// 验证 §12/§34 ProposalView 的审核数据生成：
//   1. factDiff——assert/update/retract 映射，实体名/谓词/值人话化，§9.1 不泄漏 ent_/谓词。
//   2. involvedEntityIds——主体去重（保留原始 ent_ id，内部存储字段）。
//   3. ruleWarnings——severity→level 映射（critical/major-violation→blocker，major→warning，minor/info→info）。
//   4. humanSummary——确定性模板摘要，含事件/变更数/涉及实体/安全状态，无 ent_ 泄漏。
//
// 使用纯函数投影 + 受控输入，不依赖 Core / LLM。
// =============================================================================

import { describe, it, expect } from 'vitest';
import { buildProposalReviewData } from '../../src/writing/view-models/proposal-review.js';
import type { SimulationResult } from '../../src/writing/core-bridge/core-bridge-service.js';

/** 构造最小 SimulationResult（只填 consequence 相关字段） */
function sim(over: Partial<SimulationResult> = {}): SimulationResult {
  return {
    proposalId: 'prop_test',
    isSafeToCommit: true,
    report: '',
    consequenceThreads: [],
    consequenceWarnings: [],
    ...over,
  };
}

/** ent_ → 中文名 解析器（模拟 entity sketches 映射） */
const resolve = (id: string): string | undefined =>
  ({ ent_shensheng: '沈笙', ent_heijing: '黑晶碎片', ent_changeng: '长庚站' } as Record<string, string>)[id];

describe('W7 buildProposalReviewData · factDiff', () => {
  it('assert → new，实体名/谓词标签/值人话化，无 ent_ 泄漏', () => {
    const data = buildProposalReviewData({
      eventDescription: '沈笙发现黑晶碎片发热',
      factChanges: [
        { op: 'assert', subject: 'ent_shensheng', predicate: 'location', value: '废弃站台' },
        { op: 'assert', subject: 'ent_heijing', predicate: 'status', value: '发热' },
      ],
      simulation: sim(),
      resolveEntityName: resolve,
    });

    expect(data.factDiff).toHaveLength(2);
    expect(data.factDiff[0]).toMatchObject({
      op: 'new',
      entityName: '沈笙',
      predicateLabel: '位置',
      newValue: '废弃站台',
    });
    expect(data.factDiff[0]!.humanDescription).toContain('沈笙');
    expect(data.factDiff[0]!.humanDescription).toContain('位置');
    // §9.1：整个 factDiff 序列化后绝不出现 ent_ 前缀
    expect(JSON.stringify(data.factDiff)).not.toMatch(/ent_/);
  });

  it('未命中谓词映射降级为「属性」（不裸露 Core predicate）', () => {
    const data = buildProposalReviewData({
      eventDescription: 'e',
      factChanges: [{ op: 'assert', subject: 'ent_shensheng', predicate: 'some_custom_token', value: 'v' }],
      simulation: sim(),
      resolveEntityName: resolve,
    });
    expect(data.factDiff[0]!.predicateLabel).toBe('属性');
    // 原始 predicate token 不泄漏
    expect(JSON.stringify(data.factDiff)).not.toContain('some_custom_token');
  });

  it('update → updated，retract → retracted', () => {
    const data = buildProposalReviewData({
      eventDescription: 'e',
      factChanges: [
        { op: 'update', subject: 'ent_shensheng', predicate: 'realm', value: '筑基期' },
        { op: 'retract', subject: 'ent_heijing', predicate: 'status', target_fact_id: 'fct_x' },
      ],
      simulation: sim(),
      resolveEntityName: resolve,
    });
    expect(data.factDiff[0]!.op).toBe('updated');
    expect(data.factDiff[1]!.op).toBe('retracted');
    // retract 的 target_fact_id 不应泄漏到人话字段
    expect(JSON.stringify(data.factDiff)).not.toMatch(/fct_/);
  });

  it('值为实体引用（ent_）时解析为显示名', () => {
    const data = buildProposalReviewData({
      eventDescription: 'e',
      factChanges: [{ op: 'assert', subject: 'ent_shensheng', predicate: 'location', value: 'ent_changeng' }],
      simulation: sim(),
      resolveEntityName: resolve,
    });
    expect(data.factDiff[0]!.newValue).toBe('长庚站');
    expect(JSON.stringify(data.factDiff)).not.toMatch(/ent_changeng/);
  });

  it('未注册实体（无 sketch）回退占位，不裸露 ent_', () => {
    const data = buildProposalReviewData({
      eventDescription: 'e',
      factChanges: [{ op: 'assert', subject: 'ent_unknown', predicate: 'status', value: 'v' }],
      simulation: sim(),
      resolveEntityName: resolve,
    });
    expect(data.factDiff[0]!.entityName).toBe('(未命名实体)');
    expect(JSON.stringify(data.factDiff)).not.toMatch(/ent_unknown/);
  });
});

describe('W7 buildProposalReviewData · involvedEntityIds', () => {
  it('主体去重，保留原始 ent_ id（内部存储字段）', () => {
    const data = buildProposalReviewData({
      eventDescription: 'e',
      factChanges: [
        { op: 'assert', subject: 'ent_shensheng', predicate: 'location', value: 'a' },
        { op: 'assert', subject: 'ent_shensheng', predicate: 'status', value: 'b' },
        { op: 'assert', subject: 'ent_heijing', predicate: 'status', value: 'c' },
      ],
      simulation: sim(),
      resolveEntityName: resolve,
    });
    expect(data.involvedEntityIds).toEqual(['ent_shensheng', 'ent_heijing']);
  });
});

describe('W7 buildProposalReviewData · ruleWarnings', () => {
  it('severity → level 映射：critical→blocker，major+rule_violation→blocker，major→warning，minor→info', () => {
    const data = buildProposalReviewData({
      eventDescription: 'e',
      factChanges: [],
      simulation: sim({
        isSafeToCommit: false,
        consequenceThreads: [
          { severity: 'critical', type: 'logic_conflict', description: '致命冲突' },
          { severity: 'major', type: 'rule_violation', description: '规则违反' },
          { severity: 'major', type: 'foreshadow', description: '主要伏笔' },
          { severity: 'minor', type: 'foreshadow', description: '次要伏笔' },
        ],
      }),
    });
    const levels = data.ruleWarnings.map((w) => w.level);
    expect(levels).toEqual(['blocker', 'blocker', 'warning', 'info']);
    expect(data.ruleWarnings[0]!.message).toBe('致命冲突');
  });

  it('consequenceWarnings → info 级', () => {
    const data = buildProposalReviewData({
      eventDescription: 'e',
      factChanges: [],
      simulation: sim({ consequenceWarnings: ['线程数接近上限', '推理深度告警'] }),
    });
    const infos = data.ruleWarnings.filter((w) => w.level === 'info');
    expect(infos.map((w) => w.message)).toEqual(['线程数接近上限', '推理深度告警']);
  });

  it('防御兜底：isSafeToCommit=false 但无 blocker 线程 → 补一条 blocker', () => {
    const data = buildProposalReviewData({
      eventDescription: 'e',
      factChanges: [],
      simulation: sim({ isSafeToCommit: false, consequenceThreads: [], consequenceWarnings: [] }),
    });
    expect(data.ruleWarnings).toHaveLength(1);
    expect(data.ruleWarnings[0]!.level).toBe('blocker');
  });

  it('安全提交且无后果 → ruleWarnings 为空', () => {
    const data = buildProposalReviewData({
      eventDescription: 'e',
      factChanges: [],
      simulation: sim({ isSafeToCommit: true }),
    });
    expect(data.ruleWarnings).toEqual([]);
  });
});

describe('W7 buildProposalReviewData · humanSummary', () => {
  it('确定性模板：含事件描述/变更数/涉及实体/安全状态，无 ent_ 泄漏', () => {
    const data = buildProposalReviewData({
      eventDescription: '沈笙发现黑晶碎片发热',
      factChanges: [
        { op: 'assert', subject: 'ent_shensheng', predicate: 'location', value: '废弃站台' },
        { op: 'assert', subject: 'ent_heijing', predicate: 'status', value: '发热' },
      ],
      simulation: sim({ isSafeToCommit: true }),
      resolveEntityName: resolve,
    });
    expect(data.humanSummary).toContain('沈笙发现黑晶碎片发热');
    expect(data.humanSummary).toContain('2 项设定');
    expect(data.humanSummary).toContain('沈笙');
    expect(data.humanSummary).toContain('黑晶碎片');
    expect(data.humanSummary).toContain('推演通过');
    // §9.1：摘要绝不泄漏 ent_
    expect(data.humanSummary).not.toMatch(/ent_/);
  });

  it('不安全提交 → 摘要含「需作者裁决」', () => {
    const data = buildProposalReviewData({
      eventDescription: 'e',
      factChanges: [],
      simulation: sim({ isSafeToCommit: false }),
    });
    expect(data.humanSummary).toContain('需作者裁决');
  });
});

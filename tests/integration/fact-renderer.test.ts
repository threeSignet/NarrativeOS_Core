// =============================================================================
// FactRenderer 集成测试
// =============================================================================
// 测试 5 种渲染格式的输出质量和边界情况。
// 对照架构文档 §8.2 接口定义 + §8.3/§8.4 输出示例。
// =============================================================================

import { describe, it, expect, beforeEach } from 'vitest';
import { FactRenderer } from '../../src/core/fact-renderer.js';
import type { Fact, NarrativeThread, Knowledge, FactValue } from '../../src/types.js';

// =============================================================================
// 测试数据
// =============================================================================

const entityNames: Record<string, string> = {
  ent_zhangsan: '张三',
  ent_lisi: '李四',
  ent_wang: '王长老',
  ent_zhuxianjian: '诛仙剑',
  ent_taixumen: '太虚门',
  ent_heihushan: '黑虎山',
};

function makeSnapshot(predicates: Record<string, FactValue>): Record<string, FactValue> {
  return predicates;
}

function makeFact(overrides: Partial<Fact> & { id: string; subject: string; predicate: string }): Fact {
  return {
    value: 'unknown',
    certainty: 'potential',
    causeEvent: 'evt_test_1',
    validFrom: 1,
    validTo: null,
    context: 'global',
    embeddingText: '',
    schemaVersion: 1,
    ...overrides,
  };
}

function makeThread(overrides: Partial<NarrativeThread>): NarrativeThread {
  return {
    id: 'thr_test_1',
    type: 'foreshadowing',
    direction: 'progressive',
    severity: 'major',
    description: '测试线索',
    closeCondition: {},
    status: 'PLANTED',
    closedBy: null,
    createdAtEvent: 'evt_test_1',
    createdAtChapter: 1,
    milestones: [],
    relatedEntities: [],
    upstreamFactIds: [],
    tags: [],
    ...overrides,
  };
}

// =============================================================================
// Step 3A-1: renderEntityProfile
// =============================================================================

describe('FactRenderer.renderEntityProfile', () => {
  let renderer: FactRenderer;

  beforeEach(() => {
    renderer = new FactRenderer();
  });

  it('应渲染实体档案标题和章节视角', () => {
    const result = renderer.renderEntityProfile(
      'ent_zhangsan',
      makeSnapshot({ realm: '金丹期' }),
      [],
      [],
      250,
      entityNames,
    );

    expect(result).toContain('## 张三（ent_zhangsan）');
    expect(result).toContain('第250章');
  });

  it('应渲染核心属性列表（标量值）', () => {
    const result = renderer.renderEntityProfile(
      'ent_zhangsan',
      makeSnapshot({
        realm: '金丹期',
        status: 'alive',
        hp: '8500',
      }),
      [],
      [],
      250,
      entityNames,
    );

    expect(result).toContain('realm：金丹期');
    expect(result).toContain('status：alive');
    expect(result).toContain('hp：8500');
    expect(result).toContain('### 核心属性');
  });

  it('应渲染 EntityRef 值为可读实体名', () => {
    const result = renderer.renderEntityProfile(
      'ent_zhangsan',
      makeSnapshot({
        location: { type: 'entity_ref', entityId: 'ent_heihushan' } as unknown as FactValue,
      }),
      [],
      [],
      250,
      { ...entityNames, ent_heihushan: '黑虎山' },
    );

    expect(result).toContain('黑虎山');
    expect(result).toContain('ent_heihushan');
  });

  it('应渲染关系列表（主动→和被动←方向区分）', () => {
    const relations: Fact[] = [
      makeFact({ id: 'fct_1', subject: 'ent_zhangsan', predicate: 'enemy_of', value: { type: 'entity_ref', entityId: 'ent_lisi' } as unknown as FactValue, causeEvent: 'evt_conflict_30', validFrom: 30 }),
      makeFact({ id: 'fct_2', subject: 'ent_wang', predicate: 'master_of', value: { type: 'entity_ref', entityId: 'ent_zhangsan' } as unknown as FactValue, causeEvent: 'evt_apprentice_05', validFrom: 5 }),
    ];

    const result = renderer.renderEntityProfile(
      'ent_zhangsan',
      makeSnapshot({ realm: '金丹期' }),
      relations,
      [],
      250,
      entityNames,
    );

    expect(result).toContain('### 关系');
    // 主动关系：张三 enemy_of 李四（→）
    expect(result).toContain('李四');
    expect(result).toContain('enemy_of');
    // 被动关系：王长老 master_of 张三（←）
    expect(result).toContain('王长老');
    expect(result).toContain('master_of');
  });

  it('应渲染未关闭叙事线索清单及超期状态', () => {
    const threads: NarrativeThread[] = [
      makeThread({
        id: 'thr_miracle_50',
        type: 'foreshadowing',
        direction: 'retroactive',
        severity: 'critical',
        description: '绝脉体质突破缺乏逻辑支撑',
        closeCondition: { requiredEventType: 'encounter', withinChapters: 60 },
        status: 'UNFILLED',
        createdAtChapter: 50,
      }),
      makeThread({
        id: 'thr_hint_100',
        type: 'foreshadowing',
        direction: 'progressive',
        severity: 'major',
        description: '诛仙剑似乎有隐藏能力',
        closeCondition: { minHints: 3 },
        status: 'HINTED',
        createdAtChapter: 100,
        milestones: [
          { id: 'ms_1', status: 'PLANTED', chapter: 100, description: '初次暗示', createdAt: '2026-01-01' },
          { id: 'ms_2', status: 'HINTED', chapter: 120, description: '再次暗示', createdAt: '2026-01-02' },
        ],
      }),
    ];

    const result = renderer.renderEntityProfile(
      'ent_zhangsan',
      makeSnapshot({ realm: '金丹期' }),
      [],
      threads,
      250,
      entityNames,
    );

    expect(result).toContain('### 📋 未关闭叙事线索');
    expect(result).toContain('thr_miracle_50');
    expect(result).toContain('已超期'); // 截止第60章，当前第250章
    expect(result).toContain('[critical]');
    expect(result).toContain('thr_hint_100');
    expect(result).toContain('HINTED');
    expect(result).toContain('暗示进度：1/3');
    // 渐进型未超期的线索不应显示超期
  });

  it('空关系和无线索时应正常渲染不崩溃', () => {
    const result = renderer.renderEntityProfile(
      'ent_zhangsan',
      makeSnapshot({ realm: '筑基期' }),
      [],
      [],
      1,
      entityNames,
    );

    expect(result).toContain('张三');
    expect(result).toContain('筑基期');
    // 不应包含关系section（无关系时）
    // 不应包含线索section（无线索时）
  });

  it('实体名未在 entityNames 中时应使用原始 ID', () => {
    const result = renderer.renderEntityProfile(
      'ent_unknown',
      makeSnapshot({ realm: '未知境界' }),
      [],
      [],
      1,
      entityNames,
    );

    expect(result).toContain('ent_unknown');
  });
});

// =============================================================================
// Step 3A-2: renderThreadSummary
// =============================================================================

describe('FactRenderer.renderThreadSummary', () => {
  let renderer: FactRenderer;

  beforeEach(() => {
    renderer = new FactRenderer();
  });

  it('应按回溯型/渐进型分组渲染线索清单', () => {
    const threads: NarrativeThread[] = [
      makeThread({
        id: 'thr_retro_1',
        direction: 'retroactive',
        type: 'foreshadowing',
        severity: 'critical',
        description: '回溯型线索',
        status: 'UNFILLED',
        closeCondition: { requiredEventType: 'tribulation', withinChapters: 100 },
        createdAtChapter: 50,
      }),
      makeThread({
        id: 'thr_prog_1',
        direction: 'progressive',
        type: 'foreshadowing',
        severity: 'major',
        description: '渐进型线索',
        status: 'HINTED',
        closeCondition: { minHints: 3 },
        createdAtChapter: 80,
        milestones: [
          { id: 'ms_1', status: 'PLANTED', chapter: 80, description: '埋种', createdAt: '2026-01-01' },
          { id: 'ms_2', status: 'HINTED', chapter: 90, description: '暗示', createdAt: '2026-01-02' },
        ],
      }),
    ];

    const result = renderer.renderThreadSummary(threads, 200);

    expect(result).toContain('回溯型线索');
    expect(result).toContain('渐进型线索');
    expect(result).toContain('thr_retro_1');
    expect(result).toContain('thr_prog_1');
  });

  it('应正确计算超期状态', () => {
    const threads: NarrativeThread[] = [
      makeThread({
        id: 'thr_expired',
        direction: 'retroactive',
        type: 'foreshadowing',
        severity: 'critical',
        description: '已超期',
        status: 'UNFILLED',
        closeCondition: { withinChapters: 50 },
        createdAtChapter: 10,
      }),
      makeThread({
        id: 'thr_expiring',
        direction: 'retroactive',
        type: 'foreshadowing',
        severity: 'major',
        description: '即将超期',
        status: 'UNFILLED',
        closeCondition: { withinChapters: 80 },
        createdAtChapter: 70,
      }),
    ];

    const result = renderer.renderThreadSummary(threads, 75);

    // thr_expired: 截止=10+50=60章，当前75章 → 已超期15章
    expect(result).toContain('超期');
    // thr_expiring: 截止=70+80=150章，当前75章 → 未超期，但仍在清单中出现
    expect(result).toContain('thr_expiring');
    expect(result).toContain('已超期15章'); // thr_expired 超期15章（60-75=-15）
  });

  it('无线索时应返回空清单消息', () => {
    const result = renderer.renderThreadSummary([], 100);
    expect(result).toContain('暂无');
    expect(result).not.toContain('###');
  });

  it('severity 应正确渲染标签', () => {
    const threads: NarrativeThread[] = [
      makeThread({ id: 't1', direction: 'progressive', severity: 'critical', status: 'PLANTED', description: '严重', closeCondition: {} }),
      makeThread({ id: 't2', direction: 'progressive', severity: 'major', status: 'PLANTED', description: '重要', closeCondition: {} }),
      makeThread({ id: 't3', direction: 'progressive', severity: 'minor', status: 'PLANTED', description: '次要', closeCondition: {} }),
    ];

    const result = renderer.renderThreadSummary(threads, 1);
    expect(result).toContain('🔴');
    expect(result).toContain('🟡');
    expect(result).toContain('⚪');
  });
});

// =============================================================================
// Step 3A-3: renderSimulationReport
// =============================================================================

describe('FactRenderer.renderSimulationReport', () => {
  let renderer: FactRenderer;

  beforeEach(() => {
    renderer = new FactRenderer();
  });

  it('SAFE_TO_COMMIT 状态应正确渲染', () => {
    const result = renderer.renderSimulationReport(
      'prp_test_1',
      {
        generatedFacts: [],
        generatedThreads: [],
        proposedKnowledge: [],
        warnings: [],
      },
      true,
    );

    expect(result).toContain('prp_test_1');
    expect(result).toContain('SAFE_TO_COMMIT');
  });

  it('UNSAFE_TO_COMMIT 状态应正确渲染并包含警告', () => {
    const result = renderer.renderSimulationReport(
      'prp_test_2',
      {
        generatedFacts: [],
        generatedThreads: [
          makeThread({
            id: 'thr_violation_1',
            type: 'rule_violation',
            direction: 'retroactive',
            severity: 'critical',
            description: '已死亡实体作为事件主体',
            status: 'UNFILLED',
            closeCondition: {},
          }),
        ],
        proposedKnowledge: [],
        warnings: ['规则违规：dead_entity_action'],
      },
      false,
    );

    expect(result).toContain('UNSAFE_TO_COMMIT');
    expect(result).toContain('thr_violation_1');
    expect(result).toContain('dead_entity_action');
  });

  it('包含推理 Fact 时应在报告中展示', () => {
    const result = renderer.renderSimulationReport(
      'prp_test_3',
      {
        generatedFacts: [
          makeFact({
            id: 'fct_inferred_1',
            subject: 'ent_zhangsan',
            predicate: 'enemy_of',
            value: { type: 'entity_ref', entityId: 'ent_lisi' } as unknown as FactValue,
            certainty: 'potential',
          }) as Fact,
        ],
        generatedThreads: [],
        proposedKnowledge: [],
        warnings: [],
      },
      true,
    );

    expect(result).toContain('推理规则产生');
    expect(result).toContain('fct_inferred_1');
  });

  it('无推理 Fact 和无线索时应显示无产出', () => {
    const result = renderer.renderSimulationReport(
      'prp_clean',
      { generatedFacts: [], generatedThreads: [], proposedKnowledge: [], warnings: [] },
      true,
    );

    expect(result).toContain('（无）');
  });
});

// =============================================================================
// Step 3A-4: renderKnowledgePerspective
// =============================================================================

describe('FactRenderer.renderKnowledgePerspective', () => {
  let renderer: FactRenderer;

  beforeEach(() => {
    renderer = new FactRenderer();
  });

  it('应按确信度分组渲染知识视角', () => {
    const knowledge: Knowledge[] = [
      { id: 'k1', factId: 'fct_1', entityId: 'ent_zhangsan', knownSince: 50, source: 'self_action', confidence: 1.0 },
      { id: 'k2', factId: 'fct_2', entityId: 'ent_zhangsan', knownSince: 50, source: 'informed', confidence: 0.8 },
      { id: 'k3', factId: 'fct_3', entityId: 'ent_zhangsan', knownSince: 50, source: 'rumor', confidence: 0.4 },
    ];

    const facts: Fact[] = [
      makeFact({ id: 'fct_1', subject: 'ent_zhangsan', predicate: 'realm', value: '金丹期', validFrom: 50 }),
      makeFact({ id: 'fct_2', subject: 'ent_zhangsan', predicate: 'ability', value: '御剑飞行', validFrom: 50 }),
      makeFact({ id: 'fct_3', subject: 'ent_lisi', predicate: 'secret', value: '隐藏实力', validFrom: 50 }),
    ];

    const result = renderer.renderKnowledgePerspective(
      'ent_zhangsan',
      knowledge,
      facts,
      50,
      entityNames,
    );

    expect(result).toContain('张三');
    expect(result).toContain('完全确定');
    expect(result).toContain('高度确信');
    expect(result).toContain('不确定');
    expect(result).toContain('self_action');
    expect(result).toContain('informed');
    expect(result).toContain('rumor');
  });

  it('空知识视角应返回提示消息', () => {
    const result = renderer.renderKnowledgePerspective(
      'ent_unknown',
      [],
      [],
      50,
      entityNames,
    );

    expect(result).toContain('无确定认知');
  });
});

// =============================================================================
// Step 3A-5: renderRelevantFacts
// =============================================================================

describe('FactRenderer.renderRelevantFacts', () => {
  let renderer: FactRenderer;

  beforeEach(() => {
    renderer = new FactRenderer();
  });

  it('应渲染多实体混合 Fact 集合', () => {
    const factSet = {
      entitySnapshots: {
        ent_zhangsan: { realm: '金丹期' as FactValue, status: 'alive' as FactValue },
        ent_lisi: { realm: '金丹期' as FactValue },
      },
      entityRelations: [
        makeFact({ id: 'fct_rel_1', subject: 'ent_zhangsan', predicate: 'enemy_of', value: { type: 'entity_ref', entityId: 'ent_lisi' } as unknown as FactValue, validFrom: 30 }),
      ],
      semanticFacts: [
        makeFact({ id: 'fct_sem_1', subject: 'ent_taixumen', predicate: 'announcement', value: '门派大比', validFrom: 40 }),
      ],
      openThreads: [
        makeThread({ id: 'thr_1', severity: 'major', description: '主线线索', status: 'PLANTED', closeCondition: {} }),
      ],
    };

    const result = renderer.renderRelevantFacts(factSet, entityNames);

    expect(result).toContain('张三');
    expect(result).toContain('李四');
    expect(result).toContain('太虚门');
    expect(result).toContain('enemy_of');
    expect(result).toContain('门派大比');
    expect(result).toContain('thr_1');
  });

  it('空集合应返回空字符串', () => {
    const result = renderer.renderRelevantFacts(
      { entitySnapshots: {}, entityRelations: [], semanticFacts: [], openThreads: [] },
      entityNames,
    );

    expect(result).toBe('');
  });
});

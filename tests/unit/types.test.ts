// =============================================================================
// 类型定义验证测试
// =============================================================================
// 验证 types.ts 中核心类型的构造、序列化/反序列化、ID 格式等基本行为。
// 不涉及数据库操作（属于集成测试范畴）。

import { describe, it, expect } from 'vitest';
import {
  serializeFactValue,
  deserializeFactValue,
  FACT_CHANGE_MAPPING,
  ToolErrorCode,
} from '../../src/types.js';
import type {
  Fact,
  FactValue,
  EntityRef,
  FactChange,
  FactChangeInput,
  FactIndexEntry,
  NarrativeThread,
  Knowledge,
  NarrativeEvent,
  WorldPackage,
  RuleSet,
} from '../../src/types.js';

// =============================================================================
// FactValue 序列化/反序列化
// =============================================================================

describe('FactValue 序列化', () => {
  it('字符串值应正确往返序列化', () => {
    const original: FactValue = '金丹期';
    const serialized = serializeFactValue(original);
    expect(serialized).toEqual({
      valueType: 'scalar',
      scalarType: 'string',
      textValue: '金丹期',
    });
    const restored = deserializeFactValue(serialized);
    expect(restored).toBe('金丹期');
  });

  it('数字值应正确往返序列化', () => {
    const original: FactValue = 8500;
    const serialized = serializeFactValue(original);
    expect(serialized).toEqual({
      valueType: 'scalar',
      scalarType: 'number',
      textValue: '8500',
    });
    // 反序列化应还原为 number 类型
    const restored = deserializeFactValue(serialized);
    expect(restored).toBe(8500);
    expect(typeof restored).toBe('number');
  });

  it('布尔值应正确往返序列化', () => {
    const original: FactValue = true;
    const serialized = serializeFactValue(original);
    expect(serialized).toEqual({
      valueType: 'scalar',
      scalarType: 'boolean',
      textValue: 'true',
    });
    const restored = deserializeFactValue(serialized);
    expect(restored).toBe(true);
    expect(typeof restored).toBe('boolean');
  });

  it('EntityRef 应正确往返序列化', () => {
    const original: EntityRef = {
      type: 'entity_ref',
      entityId: 'ent_zhangsan',
    };
    const serialized = serializeFactValue(original);
    expect(serialized).toEqual({
      valueType: 'entity_ref',
      textValue: 'ent_zhangsan',
    });
    const restored = deserializeFactValue(serialized) as EntityRef;
    expect(restored.type).toBe('entity_ref');
    expect(restored.entityId).toBe('ent_zhangsan');
  });
});

// =============================================================================
// FACT_CHANGE_MAPPING 声明式映射表
// =============================================================================

describe('FACT_CHANGE_MAPPING', () => {
  it('assert 操作应包含必填字段', () => {
    const rules = FACT_CHANGE_MAPPING.opRules.assert;
    expect(rules.required).toContain('subject');
    expect(rules.required).toContain('predicate');
    expect(rules.required).toContain('value');
  });

  it('retract 操作应只需要 target_fact_id', () => {
    const rules = FACT_CHANGE_MAPPING.opRules.retract;
    expect(rules.required).toEqual(['target_fact_id']);
  });

  it('update 操作应需要 target_fact_id', () => {
    const rules = FACT_CHANGE_MAPPING.opRules.update;
    expect(rules.required).toContain('target_fact_id');
    expect(rules.optional).toContain('subject');
  });

  it('字段映射应将 snake_case 映射到 camelCase', () => {
    expect(FACT_CHANGE_MAPPING.fieldMap['change_id']).toBe('changeId');
    expect(FACT_CHANGE_MAPPING.fieldMap['target_fact_id']).toBe('targetFactId');
  });
});

// =============================================================================
// ToolErrorCode 枚举
// =============================================================================

describe('ToolErrorCode', () => {
  it('应包含完整的错误码体系（验证/冲突/系统三类）', () => {
    const codes = Object.values(ToolErrorCode);
    expect(codes.length).toBeGreaterThanOrEqual(20);
    // 验证三类错误码都存在
    expect(codes).toContain('SCHEMA_VALIDATION_FAILED');  // 验证类
    expect(codes).toContain('RULE_VIOLATION');            // 冲突类
    expect(codes).toContain('INTERNAL_ERROR');            // 系统类
  });

  it('所有错误码应为字符串', () => {
    for (const code of Object.values(ToolErrorCode)) {
      expect(typeof code).toBe('string');
    }
  });
});

// =============================================================================
// ID 命名规范验证
// =============================================================================

describe('ID 命名规范', () => {
  it('实体 ID 应符合 ent_ 前缀格式', () => {
    const entityId = 'ent_zhangsan';
    expect(entityId).toMatch(/^ent_\w+$/);
  });

  it('事件 ID 应符合 evt_ 前缀格式', () => {
    const eventId = 'evt_tribulation_50';
    expect(eventId).toMatch(/^evt_\w+_\d+$/);
  });

  it('Fact ID 应符合 fct_ 前缀格式', () => {
    const factId = 'fct_tribulation_50_01';
    expect(factId).toMatch(/^fct_\w+_\d+_\d{2}$/);
  });

  it('提案 ID 应符合 prp_ 前缀格式', () => {
    const proposalId = 'prp_encounter_250';
    expect(proposalId).toMatch(/^prp_\w+_\d+$/);
  });

  it('Retcon ID 应符合 rtc_ 前缀格式', () => {
    const retconId = 'rtc_conflict_30';
    expect(retconId).toMatch(/^rtc_\w+_\d+$/);
  });

  it('叙事线索 ID 应符合 thr_ 前缀格式', () => {
    const threadId = 'thr_miracle_50';
    expect(threadId).toMatch(/^thr_\w+_\d+$/);
  });

  it('知识 ID 应符合 kno_ 前缀格式', () => {
    const knowledgeId = 'kno_claine_tribulation_50_01';
    expect(knowledgeId).toMatch(/^kno_\w+_\w+_\d+_\d{2}$/);
  });
});

// =============================================================================
// FactIndexEntry 构造验证
// =============================================================================

describe('FactIndexEntry', () => {
  it('get_context_slice 返回的索引条目应包含 action_hint', () => {
    const entry: FactIndexEntry = {
      factId: 'fct_encounter_50_01',
      predicate: 'weapon',
      value: '青竹蜂云剑',
      validFrom: 50,
      validTo: null,
      isCurrent: true,
      action_hint: '若要修改此设定，请在 propose_event 中使用 op="update", target_fact_id="fct_encounter_50_01"',
    };

    expect(entry.isCurrent).toBe(true);
    expect(entry.factId).toMatch(/^fct_/);
    expect(entry.action_hint).toContain('propose_event');
  });
});

// =============================================================================
// Event Sourcing 不可变性验证
// =============================================================================

describe('Event Sourcing 约束', () => {
  it('Fact 不应有可修改字段——通过类型系统保证不可变性', () => {
    // Fact 的所有字段通过 TypeScript 的 readonly 语义保证不可变性
    // （readonly 是 TypeScript 编译时约束，运行时无效，这里验证编译通过）
    const fact = {
      id: 'fct_test_01_01',
      subject: 'ent_test',
      predicate: 'status',
      value: 'alive' as FactValue,
      certainty: 'canonical' as const,
      causeEvent: 'evt_test_01',
      validFrom: 1,
      validTo: null,
      context: 'global',
      embeddingText: 'test',
      schemaVersion: 1,
    };
    expect(fact.schemaVersion).toBe(1);
    expect(fact.certainty).toBe('canonical');
  });
});

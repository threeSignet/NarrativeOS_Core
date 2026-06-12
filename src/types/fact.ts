// =============================================================================
// Fact 核心类型 — 世界状态的最小原子单元
// =============================================================================
// §4: Fact / FactChange / FactChangeInput / FactGroup / FactIndexEntry
// §18-19: FACT_CHANGE_MAPPING + 序列化工具函数

import type { FactValue, EntityRef, FactScalarType, Certainty } from './base.js';
import type { RelationKind } from './entity.js';

/**
 * Fact：世界状态的最小原子单元，不可变
 *
 * 关系也是 Fact——没有独立的 GraphEdge 类型，关系通过 predicate 字段表达。
 * 所有世界状态统一为 (subject, predicate, value, time) 四元组。
 */
export interface Fact {
  id: string;              // 'fct_{type}_{chapter}[_{eventSeq}]_{factSeq}'
  subject: string;         // 主体实体 ID，如 'ent_zhangsan'
  predicate: string;       // 谓词：'realm' | 'enemy_of' | 'disciple_of' | ...
  value: FactValue;        // 值：标量或另一个实体的引用

  certainty: Certainty;    // 确定性标记
  causeEvent: string;      // 产生此事实的事件 ID（溯源核心）
  validFrom: number;       // 叙事生效章节号
  validTo: number | null;  // null = 当前仍有效

  relationKind?: RelationKind; // 关系语义类别（可选元数据）
  context: string;         // 作用域（默认 'global'），见 ContextScope
  embeddingText: string;   // 向量化输入文本，用于 LanceDB 语义检索
  schemaVersion: number;   // Fact 结构版本号，默认 1。用于 Schema Evolution 时按版本反序列化
}

/**
 * FactChange：引擎内部的 Fact 变更指令
 *
 * LLM 通过 Tool Interface 提交 FactChangeInput，系统在 propose_event 时将其转换为 FactChange。
 * 两者职责不同：FactChangeInput 追求 LLM 填写便利（snake_case），FactChange 保证引擎内部类型安全。
 */
export interface FactChange {
  changeId?: string;       // 对应 FactChangeInput.change_id，propose_event 阶段的临时 ID
  op: 'assert' | 'retract' | 'update';
  targetFactId?: string;   // retract / update 时必填，指定要操作的目标 Fact
  payload?: Partial<Omit<Fact, 'id' | 'causeEvent' | 'embeddingText'>>; // assert / update 时的新数据
}

/**
 * FactChangeInput：LLM 面向的外部接口（字段扁平、命名 snake_case）
 *
 * Tool Interface 层的转换引擎是通用函数（约 20 行），通过 FACT_CHANGE_MAPPING 声明式映射表转换。
 */
export interface FactChangeInput {
  change_id?: string;           // 变更临时 ID（可选，用于 knowledge_hints 引用）
  op: 'assert' | 'retract' | 'update';
  target_fact_id?: string;      // retract / update 时必填
  subject?: string;             // assert 时必填
  predicate?: string;           // assert 时可选（update 时若提供则变更）
  value?: FactValue;            // assert 时必填
  relation_kind?: RelationKind; // LLM 可选标注关系语义
  certainty?: Certainty;        // 默认 canonical，沙盒推演中为 potential
}

/**
 * FactGroup：一个 Event 产生的所有 FactChange 的原子集合
 *
 * 要么全部成功，要么全部回滚。
 */
export interface FactGroup {
  id: string;              // 与 causeEvent 一致，如 'evt_tribulation_50'
  causeEvent: string;      // 绑定的事件 ID（所有 Fact 的 causeEvent 都是这个）
  changes: FactChange[];   // 原子执行的变更集
}

/**
 * Fact 索引条目 —— LLM 执行 update/retract 操作的"手术刀柄"
 *
 * get_context_slice 返回此索引，LLM 从中提取 target_fact_id 执行后续操作。
 * ID 传递契约：LLM 严禁凭空捏造 Fact ID，必须从最近一次返回中提取。
 */
export interface FactIndexEntry {
  factId: string;          // 如 'fct_encounter_50_02'
  predicate: string;       // 如 'weapon'
  value: string;           // 如 '青竹蜂云剑'（已渲染为可读文本）
  validFrom: number;       // 如 50
  validTo: number | null;  // null = 当前仍有效
  isCurrent: boolean;      // true = 当前活跃状态
  context?: string;        // 所属作用域（非 global 时标注）
  action_hint?: string;    // 给 LLM 的防呆操作提示
}

// =============================================================================
// FACT_CHANGE_MAPPING：声明式字段映射表
// =============================================================================

/**
 * FactChangeInput → FactChange 的声明式映射表
 *
 * 字段映射声明：外部 key（snake_case）→ 内部 key（camelCase）
 */
export const FACT_CHANGE_MAPPING = {
  fieldMap: {
    'change_id':      'changeId',
    'subject':        'subject',
    'predicate':      'predicate',
    'value':          'value',
    'target_fact_id': 'targetFactId',
  } as Record<string, string>,
  // 按 op 定义必填/可选字段
  opRules: {
    assert:  { required: ['subject', 'predicate', 'value'] },
    retract: { required: ['target_fact_id'] },
    update:  { required: ['target_fact_id'], optional: ['subject', 'predicate', 'value'] },
  } as Record<string, { required: string[]; optional?: string[] }>,
} as const;

// =============================================================================
// 序列化工具函数
// =============================================================================

/**
 * 将 FactValue 序列化为 SQLite 可存储的格式
 *
 * @param value - 原始 FactValue（string | number | boolean | EntityRef）
 * @returns { valueType: 'scalar' | 'entity_ref', scalarType?: FactScalarType, textValue: string }
 *   保证反序列化时能区分 "1"、1、true 三种不同类型
 */
export function serializeFactValue(value: FactValue): {
  valueType: 'scalar' | 'entity_ref';
  scalarType?: FactScalarType;
  textValue: string;
} {
  if (typeof value === 'object' && value !== null && (value as EntityRef).type === 'entity_ref') {
    return {
      valueType: 'entity_ref',
      textValue: (value as EntityRef).entityId,
    };
  }
  const jsType: FactScalarType = typeof value as FactScalarType;
  return {
    valueType: 'scalar',
    scalarType: jsType,
    textValue: String(value),
  };
}

/**
 * 从 SQLite 存储格式反序列化为 FactValue
 *
 * @param serialized - serializeFactValue 的返回值
 * @returns 原始 FactValue
 */
export function deserializeFactValue(serialized: {
  valueType: 'scalar' | 'entity_ref';
  scalarType?: FactScalarType;
  textValue: string;
}): FactValue {
  if (serialized.valueType === 'entity_ref') {
    return {
      type: 'entity_ref',
      entityId: serialized.textValue,
    } as EntityRef;
  }
  switch (serialized.scalarType) {
    case 'number':
      return Number(serialized.textValue);
    case 'boolean':
      return serialized.textValue === 'true';
    default:
      return serialized.textValue;
  }
}

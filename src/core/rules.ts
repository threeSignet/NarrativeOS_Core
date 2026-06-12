// =============================================================================
// Rule Engine 核心类型定义
// =============================================================================
// 定义四种规则接口（Transition / Inference / Constraint / Propagation）。
// 所有规则的输入只有 FactStore + NarrativeEvent，不读取 KnowledgeStore（I-10 不变式）。
// =============================================================================

import type {
  Fact,
  FactStore,
  FactGroup,
  NarrativeEvent,
  NarrativeThread,
  ProposedKnowledge,
} from '../types.js';

// ---------------------------------------------------------------------------
// 规则接口
// ---------------------------------------------------------------------------

/**
 * TransitionRule（状态转换规则）
 *
 * 判定"事件 + 当前状态"的组合是否合法。
 * 输入：事件 + 当前事实状态
 * 输出：NarrativeThread（违规/线索）或 null（通过）
 *
 * 例：绝脉体质 + 突破事件 → logic_conflict 线索
 */
export interface TransitionRule {
  id: string;
  description: string;
  /** 检查事件是否违规，返回 null 表示无违规 */
  check(event: NarrativeEvent, factStore: FactStore): NarrativeThread | null;
}

/**
 * InferenceRule（推理规则）
 *
 * 从已有 Fact 推导必然成立的新 Fact。
 * 输入：新 assert 的 Fact + 当前事实状态
 * 输出：推导出的新 Fact 列表（空 = 无推导）
 *
 * 例：A enemy_of B → B enemy_of A（双向敌对推导）
 */
export interface InferenceRule {
  id: string;
  description: string;
  /** 基于新 Fact 推导更多 Fact，返回 [] 表示无推理 */
  infer(newFact: Fact, factStore: FactStore): Omit<Fact, 'id' | 'embeddingText'>[];
}

/**
 * ConstraintRule（约束规则）
 *
 * 检查 Fact 集合是否违反硬约束。
 * 输入：FactGroup 的所有变更 + 当前事实状态
 * 输出：NarrativeThread（违规）或 null（通过）
 *
 * 例：已死亡实体不能作为新事件的行动主体
 */
export interface ConstraintRule {
  id: string;
  description: string;
  /** 检查约束条件，返回 null 表示无违规 */
  check(event: NarrativeEvent, factStore: FactStore): NarrativeThread | null;
}

/**
 * PropagationRule（知识传播规则）
 *
 * 从事件 + 实体关系推导"谁在事件后知道了什么"。
 * 输入：事件 + FactGroup + 当前事实状态
 * 输出：建议的 Knowledge 条目列表
 *
 * 不读取 KnowledgeStore（I-10 不变式）——只基于客观状态推导。
 *
 * 例：事件主体自动知晓 + 同场景目击传播
 */
export interface PropagationRule {
  id: string;
  description: string;
  /** 推导知识传播建议，返回 [] 表示无需传播 */
  propagate(
    event: NarrativeEvent,
    factGroup: FactGroup,
    factStore: FactStore,
  ): ProposedKnowledge[];
}

// ---------------------------------------------------------------------------
// 复杂度预算（§5.2）
// ---------------------------------------------------------------------------

/**
 * 规则引擎复杂度预算常量
 *
 * 硬性上限，防止传播链爆炸。超过上限时停止推理并返回错误。
 */
export const COMPLEXITY_BUDGET = {
  /** 单次推理最大深度（防止规则链无限递归） */
  MAX_INFERENCE_DEPTH: 10,
  /** 单次推理最大生成 Fact 数 */
  MAX_GENERATED_FACTS: 100,
  /** 单次推理最大生成 Thread 数 */
  MAX_GENERATED_THREADS: 50,
  /** 传播规则单次触发最大 Knowledge 数 */
  MAX_PROPAGATED_KNOWLEDGE: 200,
} as const;

// ---------------------------------------------------------------------------
// 沙盒推演结果类型
// ---------------------------------------------------------------------------

/**
 * 沙盒推演状态：跟踪复杂度预算消耗
 */
export interface SandboxState {
  inferenceDepth: number;
  generatedFactCount: number;
  generatedThreadCount: number;
  propagatedKnowledgeCount: number;
  budgetExhausted: boolean;
  exhaustionReason?: string;
}

// =============================================================================
// Rule Engine 类型 — 四类规则 + 沙盒推演结果
// =============================================================================
// §9: RuleType / DeclarativeRule / EventConsequence / ProposedKnowledge

import type { Fact } from './fact.js';
import type { NarrativeThread } from './thread.js';
import type { KnowledgeSource } from './knowledge.js';

/**
 * 规则类型
 *
 * 排序按执行优先级：
 *   1. Transition  — detect pattern → generate consequence（可产生新 Fact）
 *   2. Inference   — detect pattern → derive new Fact
 *   3. Constraint  — prevent invalid state（纯判定，不产生新 Fact）
 *   4. Propagation — derive Knowledge from Event + entity relations
 */
export type RuleType = 'transition' | 'inference' | 'constraint' | 'propagation';

/**
 * 声明式规则定义（World Package 中存储的 JSON 格式规则）
 *
 * 规则通过 DeclarativeRuleEvaluator 解释执行，不包含可执行代码。
 * 对于超出声明式表达力的复杂规则，使用 TypeScript 硬编码规则（附录 H.5 第三层）。
 */
export interface DeclarativeRule {
  id: string;
  type: RuleType;
  name: string;
  description: string;
  priority: number;        // 规则优先级（同类型规则按 priority 升序执行）

  // 触发条件：声明式条件表达式
  conditions: RuleCondition[];

  // 规则产出
  consequences?: RuleConsequence[]; // Transition / Inference / Propagation 的产出

  // 约束规则特有
  violationMessage?: string;        // Constraint 违规时的错误消息
  violationSeverity?: 'minor' | 'major' | 'critical';

  // 传播规则特有
  propagationConfig?: PropagationConfig;
}

/**
 * 规则条件表达式
 */
export interface RuleCondition {
  type: 'subject_match' | 'predicate_match' | 'value_match' | 'entity_count' |
        'snapshot_gte' | 'snapshot_lte' | 'snapshot_sequence_jump' |
        'thread_count' | 'chapter_range';
  field?: string;          // 检查的字段
  operator?: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'not_in';
  value?: unknown;         // 比较值
  conditions?: RuleCondition[]; // 嵌套条件（AND 逻辑）
}

/**
 * 规则产出
 */
export interface RuleConsequence {
  type: 'assert_fact' | 'create_thread' | 'propose_knowledge' | 'update_math';
  params: Record<string, unknown>;
}

/**
 * 知识传播配置
 */
export interface PropagationConfig {
  autoSubject?: boolean;         // 事件主体自动知晓
  witnessEntities?: boolean;     // 同场景目击传播
  factionShare?: boolean;        // 阵营广播
  witnessMaxDistance?: number;   // 目击传播的最大关联距离
}

/**
 * 事件后果：Rule Engine 沙盒推演的完整结果集
 */
export interface EventConsequence {
  generatedFacts: Fact[];               // 规则推导出的新事实（certainty='potential'）
  generatedThreads: NarrativeThread[];   // 违规/伏笔产生的叙事线索
  proposedKnowledge: ProposedKnowledge[]; // 知识传播规则建议的 Knowledge 条目
  warnings: string[];                   // 给 LLM 的警告信息（非阻塞）
}

/**
 * 建议的 Knowledge 条目（Rule Engine 沙盒推演产出）
 *
 * tier 定义（§3.6 合并优先级）：
 *   3 — knowledge_hints（LLM 细粒度，最高优先级）
 *   2 — knowledge_broadcast（LLM 粗粒度广播）
 *   1 — propagation（Rule Engine 传播规则产出，如 witness）
 *   0 — subject_auto（事件主体自动知晓，最低优先级）
 */
export interface ProposedKnowledge {
  entityId: string;          // 谁获得了新知识
  changeId: string;           // 对应 FactChangeInput.change_id（稳定引用，非数组下标）
  source: KnowledgeSource;    // 知识来源
  confidence: number;         // 确信度
  reason: string;             // 推导理由（展示在审计报告中，如"该角色与事件主体同在古墓"）
  tier: number;               // 合并优先级（0-3），高 tier 覆盖低 tier
}

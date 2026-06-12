// =============================================================================
// World Package 类型 — 题材配置注入
// =============================================================================
// §5: ContextScopeConfig
// §10: WorldPackage / PredicateDefinition / RuleSet / EntityTemplate / ContextScopePreset
//      ValidationReport / ConsistencyViolation

import type { EntityKind, RelationKind } from './entity.js';
import type { DeclarativeRule } from './rule.js';

/**
 * ContextScope：作用域继承 + 遮蔽机制
 *
 * 处理副本、梦境、秘境、异世界等特殊空间中的状态隔离。
 * MVP 阶段统一为 context 字段处理。Phase 2 计划拆分为 Timeline + RealityLayer + ContextScope。
 *
 * 核心规则：
 *   - 进入作用域：设置 context 为非 global 值（如 arc_dream_01）
 *   - 退出作用域：作者逐条决定哪些 Fact 持久化到 global
 *   - 遮蔽机制：局部 Fact 遮蔽同 subject+predicate 的全局 Fact
 *   - 全局时间轴：所有作用域共享同一单调递增的章节号
 */
export interface ContextScopeConfig {
  name: string;                    // 作用域名称，如 'arc_dream_01'
  displayName: string;             // 人类可读名称
  parentContext: string;           // 父作用域（通常为 'global'）
  defaultExitBehavior: 'suggest_promote' | 'suggest_discard';
  worldPackageId?: string;         // 绑定的 World Package ID（可选）
  description?: string;
}

/**
 * World Package：一个完整的世界观配置
 *
 * Core 引擎是题材无关的通用框架。所有题材特定的规则、谓词映射、实体模板
 * 都通过 World Package 注入引擎。
 *
 * 不变式：World Package 是数据，不是代码。
 *   - ✅ 允许声明：谓词、关系映射、规则元数据、实体模板
 *   - ❌ 禁止执行：function / eval / execute 或任何可执行代码
 */
export interface WorldPackage {
  id: string;                    // 如 'xianxia_cultivation' | 'lotm_sequences'
  name: string;                  // 如 '仙侠修炼体系' | '诡秘序列体系'
  version: string;

  // 谓词注册表：定义这个世界观中合法的 predicate 及其中文标签
  predicates: PredicateDefinition[];

  // 规则集：这个世界观的状态转换规则、推理规则、约束规则、传播规则
  rules: RuleSet;

  // 谓词→关系语义映射：覆盖默认的 PREDICATE_RELATION_MAP
  predicateRelationMap: Record<string, RelationKind>;

  // 谓词→中文映射：覆盖默认的 PREDICATE_ZH_MAP
  predicateZhMap: Record<string, string>;

  // 实体模板：这个世界观中常见的实体类型预设
  entityTemplates?: EntityTemplate[];

  // 作用域预设：这个世界观中常见的作用域配置
  scopePresets?: ContextScopePreset[];

  // 谓词别名：旧名称 → 当前推荐名称。只影响新写入和渲染提示，不物理改写历史 Fact。
  predicateAliases?: Record<string, string>;
}

/**
 * 谓词定义：注册一个合法的 predicate
 */
export interface PredicateDefinition {
  name: string;            // 谓词名，如 'realm' | 'sequence' | 'spell_slot'
  displayName: string;     // 中文名，如 '修炼境界' | '序列' | '法术位'
  valueType: 'scalar' | 'entity_ref' | 'enum';
  enumValues?: string[];   // valueType='enum' 时的合法值列表
  sequenceOrder?: string[]; // 可选：有序枚举的递进序列（如 ['炼气','筑基','结丹','元婴']）
  description: string;      // 谓词的语义说明（帮助 LLM 理解）
  relationKind: RelationKind; // 默认的关系语义类别
  deprecated?: boolean;     // 旧谓词保留解释能力，但不再建议新 Fact 使用
  replacementPredicate?: string; // deprecated 时可选，指向推荐的新谓词
}

/**
 * 规则集
 */
export interface RuleSet {
  transitions: DeclarativeRule[];
  inferences: DeclarativeRule[];
  constraints: DeclarativeRule[];
  propagations: DeclarativeRule[];
}

/**
 * 一致性后验校验报告
 *
 * RuleEngine.validateConsistency() 在 commit_event Phase B 中执行，
 * 角色是诊断性后验审计（diagnostic post-hoc audit），不是阻塞性二次校验。
 * 真正的约束检查已在 Phase A 沙盒推演中完成。
 *
 * 对应架构文档 §5.2 和 §10.1 Phase B 数据流。
 */
export interface ValidationReport {
  violations: ConsistencyViolation[];
  warnings: string[];
}

/**
 * 一致性违规条目
 */
export interface ConsistencyViolation {
  factIds: string[];        // 相关 Fact 的 ID
  ruleId: string;           // 触发违规的规则 ID
  description: string;      // 人类可读的违规描述
  severity: 'warning' | 'error'; // 诊断级别
}

/**
 * 实体模板：预定义常见实体类型的属性组合
 */
export interface EntityTemplate {
  kind: EntityKind;
  name: string;            // 模板名，如 'character_cultivator'
  extends?: string;        // 继承的父模板名
  defaultPredicates: string[]; // 此类实体通常有哪些 predicate
  overridePredicates?: Record<string, Partial<PredicateDefinition>>;
  description: string;
}

/**
 * 作用域预设：预定义常见的作用域配置
 */
export interface ContextScopePreset {
  name: string;            // 如 'dream' | 'dungeon' | 'legend_world'
  displayName: string;
  defaultExitBehavior: 'suggest_promote' | 'suggest_discard';
  inheritsGlobalRules: boolean;
  overrideRules?: RuleSet;
  description: string;
}

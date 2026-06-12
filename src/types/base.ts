// =============================================================================
// 基础值类型 — 所有其他类型的基石
// =============================================================================
// §1: FactValue / EntityRef / FactScalarType
// §2: Certainty 确定性枚举

/**
 * Fact 的值类型：标量值或实体引用
 * 当前不支持数组或嵌套对象。有序列表应拆成多条 Fact 或使用 PredicateDefinition.sequenceOrder 表达顺序。
 */
export type FactValue = string | number | boolean | EntityRef;

/**
 * 关系 Fact 的目标引用 —— 表达 subject → targetEntity 的关系
 */
export interface EntityRef {
  type: 'entity_ref';
  entityId: string; // 如 'ent_lisi'
}

/**
 * Fact 值的 SQLite 序列化辅助：标记标量子类型，避免 "1"、1、true 反序列化混淆
 */
export type FactScalarType = 'string' | 'number' | 'boolean';

/**
 * Fact 的真实性状态
 *
 * 合法状态转换路径：
 *   canonical → contested   （Retcon 标记）
 *   canonical → orphaned    （上游依赖断裂）
 *   contested → canonical   （作者通过新 Fact 替代，不是直接 UPDATE）
 *   contested → orphaned    （作者确认放弃）
 *   potential → canonical   （沙盒推演确认提交）
 *   potential → orphaned    （沙盒推演被拒绝）
 *   orphaned  → canonical   （Retcon 撤回恢复依赖链）
 *
 * 简化：当前仅实现 potential→canonical 和 canonical→contested。
 * orphaned 相关转换推迟到后续迭代。
 */
export type Certainty = 'canonical' | 'contested' | 'potential' | 'orphaned';

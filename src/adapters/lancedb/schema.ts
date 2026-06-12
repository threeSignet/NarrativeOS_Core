// =============================================================================
// LanceDB 存储适配层 —— 领域类型 ↔ LanceDB 安全格式转换
// =============================================================================
// 问题背景（Spike 2 验证结论）：
//   vectordb@0.21.2（以及 @lancedb/lancedb@0.30+）的 schema 推断有以下限制：
//   1. null 值在初始数据中会触发 "non-nullable but contains null" 错误
//   2. boolean 字段在 .where() 过滤中不可靠（需用 integer 0/1）
//   3. string 枚举在 .where() 过滤中语法不稳定
//
// 解决策略（适配器层转换，领域模型不变）：
//   - validTo: null → -1 哨兵值（-1 = "当前仍有效"，≥0 = 失效章节号）
//   - isCurrent: boolean → 0/1 integer
//   - certainty: string → integer 枚举（1=canonical, 2=contested, 3=potential, 4=orphaned）
//
// 转换原则：
//   1. 领域类型（types.ts）保持纯正——null/boolean/string 是业务逻辑的正确表达
//   2. 所有转换集中在此文件，Pure Function，零副作用
//   3. 转换方向对称——domain→lance 和 lance→domain 互为逆操作
//   4. SQLite 是权威数据源，LanceDB 是可重建的派生索引——转换错误不会丢失数据
// =============================================================================

import type { Certainty, FactValue } from '../../types.js';

// ---------------------------------------------------------------------------
// LanceDB 安全数据类型（仅在此文件中使用）
// ---------------------------------------------------------------------------

/**
 * LanceDB 存储格式的 Certainty（integer 枚举）
 *
 * 映射关系：
 *   1 = canonical    — 正史，作者确认
 *   2 = contested    — 争议，被 Retcon 影响
 *   3 = potential    — 潜在，沙盒推演中
 *   4 = orphaned     — 孤儿，依赖断裂
 */
export type LanceCertainty = 1 | 2 | 3 | 4;

/**
 * LanceDB 存储格式的 Fact 条目
 *
 * 与 domains Fact 接口的区别：
 *   - valid_to: number（-1 哨兵代替 null）
 *   - is_current: 0 | 1（integer 代替 boolean）
 *   - certainty: LanceCertainty（integer 枚举代替 string）
 *   - 不含 value（向量检索不需要 value 字段，value 通过 factId 回查 SQLite）
 */
export interface LanceFactEntry {
  id: string;
  vector: number[];         // bge-m3 embedding, 1024 维
  subject: string;
  predicate: string;
  valid_from: number;
  valid_to: number;         // -1 = 当前仍有效（哨兵值）
  is_current: 0 | 1;       // 1 = 当前有效
  certainty: LanceCertainty;
  context: string;
}

// ---------------------------------------------------------------------------
// 哨兵值常量
// ---------------------------------------------------------------------------

/** valid_to 哨兵值：当前仍有效（等价于 domain 层的 null） */
export const VALID_TO_CURRENT_SENTINEL = -1;

/** 失效判定阈值：valid_to >= 0 表示已失效 */
export function isExpiredInLance(validTo: number): boolean {
  return validTo >= 0;
}

// ---------------------------------------------------------------------------
// Certainty 映射表（双向）
// ---------------------------------------------------------------------------

const CERTAINTY_TO_LANCE: Record<Certainty, LanceCertainty> = {
  canonical: 1,
  contested: 2,
  potential: 3,
  orphaned: 4,
};

const LANCE_TO_CERTAINTY: Record<LanceCertainty, Certainty> = {
  1: 'canonical',
  2: 'contested',
  3: 'potential',
  4: 'orphaned',
};

// ---------------------------------------------------------------------------
// 转换函数
// ---------------------------------------------------------------------------

/**
 * 领域层 Certainty → LanceDB integer 枚举
 *
 * @example certaintyToLance('canonical') → 1
 */
export function certaintyToLance(certainty: Certainty): LanceCertainty {
  return CERTAINTY_TO_LANCE[certainty];
}

/**
 * LanceDB integer 枚举 → 领域层 Certainty
 *
 * @example lanceToCertainty(2) → 'contested'
 */
export function lanceToCertainty(code: LanceCertainty): Certainty {
  return LANCE_TO_CERTAINTY[code];
}

/**
 * 领域层 validTo（null | number）→ LanceDB valid_to（number，-1 哨兵）
 *
 * @example validToToLance(null) → -1  (当前有效)
 * @example validToToLance(50)  → 50  (第 50 章失效)
 */
export function validToToLance(validTo: number | null): number {
  return validTo === null ? VALID_TO_CURRENT_SENTINEL : validTo;
}

/**
 * LanceDB valid_to（number，-1 哨兵）→ 领域层 validTo（null | number）
 *
 * @example lanceToValidTo(-1)  → null  (当前有效)
 * @example lanceToValidTo(50)  → 50   (第 50 章失效)
 */
export function lanceToValidTo(validTo: number): number | null {
  return validTo === VALID_TO_CURRENT_SENTINEL ? null : validTo;
}

/**
 * 领域层布尔值 → LanceDB integer 0/1
 *
 * @example boolToLance(true)  → 1
 * @example boolToLance(false) → 0
 */
export function boolToLance(value: boolean): 0 | 1 {
  return value ? 1 : 0;
}

/**
 * LanceDB integer 0/1 → 领域层布尔值
 *
 * @example lanceToBool(1) → true
 * @example lanceToBool(0) → false
 */
export function lanceToBool(value: number): boolean {
  return value !== 0;
}

// ---------------------------------------------------------------------------
// LanceDB .where() 过滤子句构建器
// ---------------------------------------------------------------------------

/**
 * 构建 LanceDB 检索过滤子句
 *
 * 将领域层的查询条件转换为 LanceDB 安全的 .where() 字符串。
 * 所有值都用 LanceDB 安全格式（integer 枚举、integer 0/1、-1 哨兵）。
 *
 * @example buildLanceFilter({ isCurrent: true, certainty: 'canonical', context: 'global' })
 *   → 'is_current = 1 AND certainty = 1 AND context = "global"'
 */
export function buildLanceFilter(params: {
  isCurrent?: boolean;
  certainty?: Certainty;
  context?: string;
  subject?: string;
  predicate?: string;
}): string {
  const parts: string[] = [];

  if (params.isCurrent !== undefined) {
    parts.push(`is_current = ${boolToLance(params.isCurrent)}`);
  }

  if (params.certainty) {
    parts.push(`certainty = ${certaintyToLance(params.certainty)}`);
  }

  if (params.context) {
    // LanceDB .where() 中字符串值使用双引号
    parts.push(`context = "${params.context}"`);
  }

  if (params.subject) {
    parts.push(`subject = "${params.subject}"`);
  }

  if (params.predicate) {
    parts.push(`predicate = "${params.predicate}"`);
  }

  return parts.join(' AND ');
}

// ---------------------------------------------------------------------------
// 往返一致性验证（导出供测试使用）
// ---------------------------------------------------------------------------

/**
 * 验证 certainty 映射表的往返一致性
 *
 * 规则：对任意合法 Certainty 值，lanceToCertainty(certaintyToLance(x)) === x
 */
export function validateCertaintyRoundtrip(): boolean {
  const allValues: Certainty[] = ['canonical', 'contested', 'potential', 'orphaned'];
  return allValues.every(v => lanceToCertainty(certaintyToLance(v)) === v);
}

/**
 * 验证 validTo 映射表的往返一致性
 *
 * 规则：
 *   - lanceToValidTo(validToToLance(null)) === null
 *   - lanceToValidTo(validToToLance(n)) === n（对任意 n >= 0）
 */
export function validateValidToRoundtrip(): boolean {
  // null 往返
  if (lanceToValidTo(validToToLance(null)) !== null) return false;

  // 数值往返
  const testValues = [0, 1, 50, 100, 9999];
  return testValues.every(v => lanceToValidTo(validToToLance(v)) === v);
}

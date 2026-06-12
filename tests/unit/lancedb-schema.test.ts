// =============================================================================
// LanceDB Schema 转换层单元测试
// =============================================================================
// 验证领域类型 ↔ LanceDB 安全格式的转换正确性和往返一致性。
// 不涉及真实 LanceDB 连接（属于纯函数测试）。
// =============================================================================

import { describe, it, expect } from 'vitest';
import {
  certaintyToLance,
  lanceToCertainty,
  validToToLance,
  lanceToValidTo,
  boolToLance,
  lanceToBool,
  buildLanceFilter,
  validateCertaintyRoundtrip,
  validateValidToRoundtrip,
  VALID_TO_CURRENT_SENTINEL,
  isExpiredInLance,
} from '../../src/adapters/lancedb/schema.js';
import type { Certainty } from '../../src/types.js';

// =============================================================================
// Certainty 映射
// =============================================================================

describe('Certainty 映射', () => {
  it('canonical → 1 → canonical', () => {
    expect(certaintyToLance('canonical')).toBe(1);
    expect(lanceToCertainty(1)).toBe('canonical');
  });

  it('contested → 2 → contested', () => {
    expect(certaintyToLance('contested')).toBe(2);
    expect(lanceToCertainty(2)).toBe('contested');
  });

  it('potential → 3 → potential', () => {
    expect(certaintyToLance('potential')).toBe(3);
    expect(lanceToCertainty(3)).toBe('potential');
  });

  it('orphaned → 4 → orphaned', () => {
    expect(certaintyToLance('orphaned')).toBe(4);
    expect(lanceToCertainty(4)).toBe('orphaned');
  });

  it('所有 4 种 Certainty 值应通过往返一致性验证', () => {
    expect(validateCertaintyRoundtrip()).toBe(true);
  });
});

// =============================================================================
// validTo 映射（null ↔ -1 哨兵）
// =============================================================================

describe('validTo 映射', () => {
  it('null → -1 哨兵值', () => {
    expect(validToToLance(null)).toBe(-1);
  });

  it('-1 哨兵值 → null', () => {
    expect(lanceToValidTo(-1)).toBe(null);
  });

  it('正数应原样传递', () => {
    expect(validToToLance(50)).toBe(50);
    expect(lanceToValidTo(50)).toBe(50);
  });

  it('0 应原样传递（第 0 章失效，极少用但合法）', () => {
    expect(validToToLance(0)).toBe(0);
    expect(lanceToValidTo(0)).toBe(0);
  });

  it('大数值应原样传递', () => {
    expect(validToToLance(9999)).toBe(9999);
    expect(lanceToValidTo(9999)).toBe(9999);
  });

  it('所有合法值应通过往返一致性验证', () => {
    expect(validateValidToRoundtrip()).toBe(true);
  });
});

// =============================================================================
// isExpiredInLance 判定
// =============================================================================

describe('isExpiredInLance', () => {
  it('-1 哨兵值 → 未过期', () => {
    expect(isExpiredInLance(-1)).toBe(false);
  });

  it('0 → 已过期（validTo=0 表示第 0 章即失效）', () => {
    expect(isExpiredInLance(0)).toBe(true);
  });

  it('正数 → 已过期', () => {
    expect(isExpiredInLance(50)).toBe(true);
    expect(isExpiredInLance(100)).toBe(true);
  });
});

// =============================================================================
// boolean ↔ integer 0/1
// =============================================================================

describe('boolean ↔ integer', () => {
  it('true → 1', () => {
    expect(boolToLance(true)).toBe(1);
  });

  it('false → 0', () => {
    expect(boolToLance(false)).toBe(0);
  });

  it('1 → true', () => {
    expect(lanceToBool(1)).toBe(true);
  });

  it('0 → false', () => {
    expect(lanceToBool(0)).toBe(false);
  });

  it('非 0 值 → true（防御性编程）', () => {
    expect(lanceToBool(2)).toBe(true);
    expect(lanceToBool(-1)).toBe(true);
  });
});

// =============================================================================
// buildLanceFilter .where() 子句构建
// =============================================================================

describe('buildLanceFilter', () => {
  it('仅过滤 isCurrent=true', () => {
    expect(buildLanceFilter({ isCurrent: true })).toBe('is_current = 1');
  });

  it('仅过滤 certainty=canonical', () => {
    expect(buildLanceFilter({ certainty: 'canonical' })).toBe('certainty = 1');
  });

  it('仅过滤 context="global"', () => {
    expect(buildLanceFilter({ context: 'global' })).toBe('context = "global"');
  });

  it('组合过滤：is_current=1 AND certainty=1 AND context="global"', () => {
    const clause = buildLanceFilter({
      isCurrent: true,
      certainty: 'canonical',
      context: 'global',
    });
    expect(clause).toBe('is_current = 1 AND certainty = 1 AND context = "global"');
  });

  it('组合过滤：is_current=0 AND certainty=4（orphaned）', () => {
    const clause = buildLanceFilter({
      isCurrent: false,
      certainty: 'orphaned',
    });
    expect(clause).toBe('is_current = 0 AND certainty = 4');
  });

  it('组合过滤：含 subject 和 predicate', () => {
    const clause = buildLanceFilter({
      isCurrent: true,
      certainty: 'canonical',
      context: 'global',
      subject: 'ent_zhangsan',
      predicate: 'realm',
    });
    expect(clause).toBe(
      'is_current = 1 AND certainty = 1 AND context = "global" AND subject = "ent_zhangsan" AND predicate = "realm"'
    );
  });

  it('空参数应返回空字符串', () => {
    expect(buildLanceFilter({})).toBe('');
  });
});

// =============================================================================
// 哨兵值常量
// =============================================================================

describe('VALID_TO_CURRENT_SENTINEL 常量', () => {
  it('应等于 -1', () => {
    expect(VALID_TO_CURRENT_SENTINEL).toBe(-1);
  });
});

// =============================================================================
// ContextAnalyzer —— 写作上下文分析器
// =============================================================================
// Phase 4 组件。分析当前章节的写作上下文，输出结构化信号供检索管线使用。
//
// 设计要点：
//   - 规则化快速路径（Phase MVP）：基于实体名匹配、章节邻近度
//   - 后续可升级为 LLM 深度分析（异步预生成缓存）
//   - 输出 ContextSignals 驱动 RelevantFactRetriever 的检索策略
//
// 与架构文档的对应关系：
//   §7.2.2 ContextAnalyzer → ContextSignals 输出
//   §7.3 主动注入时机       → before chapter writing
// =============================================================================

import type { FactStore } from '../types.js';

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 写作上下文结构 */
export interface WritingContext {
  /** 当前章节编号 */
  chapter: number;
  /** 写作文本中出现的实体 ID（LLM 提交或自动提取） */
  entityIds: string[];
  /** 当前场景的文本片段（用于提取更多信号） */
  text?: string;
  /** 当前作用域 */
  context?: string;
}

/** 上下文分析信号 */
export interface ContextSignals {
  /** 主要相关实体 */
  primaryEntities: string[];
  /** 次要相关实体（关联实体，非直接出场） */
  secondaryEntities: string[];
  /** 时间焦点（故事当前推进到的章节） */
  temporalFocus: number;
  /** 活跃作用域 */
  activeScopes: string[];
  /** 题材/风格提示（用于调整检索策略） */
  genreHints: string[];
  /** 邻近实体（同一场景/地点的其他实体） */
  nearbyEntities: string[];
}

// ---------------------------------------------------------------------------
// ContextAnalyzer
// ---------------------------------------------------------------------------

export class ContextAnalyzer {
  private factStore: FactStore;

  constructor(factStore: FactStore) {
    this.factStore = factStore;
  }

  /**
   * 分析写作上下文，输出结构化信号
   *
   * @param ctx 当前写作上下文
   * @returns ContextSignals 供检索管线使用
   */
  analyze(ctx: WritingContext): ContextSignals {
    const primaryEntities = [...new Set(ctx.entityIds)];
    const secondaryEntities: string[] = [];
    const nearbyEntities: string[] = [];

    // 扩展邻近实体：查询同一地点的其他实体
    for (const entityId of primaryEntities) {
      const locFacts = this.factStore.query({
        subject: entityId,
        predicate: 'location',
        atChapter: ctx.chapter,
      });
      if (locFacts.length > 0) {
        const location = locFacts[0]!.value;
        // 查找同一位置的其他实体
        const sameLocFacts = this.factStore.query({
          predicate: 'location',
          atChapter: ctx.chapter,
        });
        for (const lf of sameLocFacts) {
          if (lf.subject !== entityId && !primaryEntities.includes(lf.subject)) {
            nearbyEntities.push(lf.subject);
          }
        }
      }

      // 从关系 Fact 中推断次要实体
      const relations = this.factStore.getRelationsTargeting(entityId, ctx.chapter);
      for (const rel of relations) {
        const otherEntity = rel.subject === entityId ? undefined : rel.subject;
        if (otherEntity && !primaryEntities.includes(otherEntity)) {
          secondaryEntities.push(otherEntity);
        }
      }
    }

    // 从文本中提取可能的新实体 ID（ent_ 前缀模式）
    const genreHints: string[] = [];
    if (ctx.text) {
      const entMatches = ctx.text.match(/ent_[a-z_]+/g) ?? [];
      for (const m of entMatches) {
        if (!primaryEntities.includes(m) && !secondaryEntities.includes(m)) {
          secondaryEntities.push(m);
        }
      }
    }

    return {
      primaryEntities,
      secondaryEntities: [...new Set(secondaryEntities)],
      temporalFocus: ctx.chapter,
      activeScopes: ctx.context ? [ctx.context] : ['global'],
      genreHints,
      nearbyEntities: [...new Set(nearbyEntities)],
    };
  }
}

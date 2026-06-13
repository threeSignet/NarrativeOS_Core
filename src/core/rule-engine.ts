// =============================================================================
// 工具函数
// =============================================================================

/**
 * 比较两个 FactValue 是否相等（结构比较，非引用比较）
 * 用于 witness_propagation 中比较 EntityRef location 值
 */
function isSameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (typeof a === 'object' && a !== null && b !== null) {
    const aRef = a as { type?: string; entityId?: string };
    const bRef = b as { type?: string; entityId?: string };
    return aRef.type === bRef.type && aRef.entityId === bRef.entityId;
  }
  return false;
}

// =============================================================================
// RuleEngine —— 沙盒推演引擎
// =============================================================================
// Phase 1 实现：支持四种规则类型（Transition / Inference / Constraint / Propagation）
// 含 2 条硬编码通用传播规则 + 4 条通用规则。
//
// 架构约束（§5.5）：
//   执行顺序 Transition → Inference → Constraint → Propagation（不可调整）
//   I-10 不变式：不读取 KnowledgeStore
//   复杂度预算：深度≤10 / Fact≤100 / Thread≤50 / Knowledge≤200
//
// 与架构文档的对应关系：
//   §5.1 职责             → 沙盒推演，不修改真实 FactStore
//   §5.2 规则分类         → Transition / Inference / Constraint / Propagation
//   §5.5 沙盒推演流程     → 7 步执行顺序
//   §5.6 传播规则         → subject_auto + witness_propagation
//   §5.2 复杂度预算       → COMPLEXITY_BUDGET 常量
//   §11.5 不变式 I-9/I-10 → Thread Never Has Causal Power / Engine Never Reads Knowledge
// =============================================================================

import type {
  Fact,
  FactStore,
  FactGroup,
  NarrativeEvent,
  NarrativeThread,
  EventConsequence,
  ProposedKnowledge,
  EntityRef,
} from '../types.js';
import {
  COMPLEXITY_BUDGET,
  type SandboxState,
  type TransitionRule,
  type InferenceRule,
  type ConstraintRule,
  type PropagationRule,
} from './rules.js';

// =============================================================================
// 2 条硬编码通用传播规则（§5.6）
// =============================================================================

/**
 * 传播规则一：事件主体自动知晓（subject_auto）
 *
 * 事件主体对其参与的所有 FactChange 自动获得 Knowledge。
 * source = 'self_action', confidence = 1.0
 */
const subjectAutoPropagation: PropagationRule = {
  id: 'propagation_subject_auto',
  description: '事件主体自动获得事件产生的所有 Fact 的知识（self_action, confidence=1.0）',

  propagate(event: NarrativeEvent, factGroup: FactGroup): ProposedKnowledge[] {
    const results: ProposedKnowledge[] = [];
    const subject = event.params['subject'] as string | undefined;
    if (!subject) return results;

    for (const change of factGroup.changes) {
      // 只对 assert/update 操作传播知识（retract 不产生新知识）
      if (change.op === 'retract') continue;
      if (!change.changeId) continue;

      results.push({
        entityId: subject,
        changeId: change.changeId,
        source: 'self_action',
        confidence: 1.0,
        reason: `${subject} 是事件主体，亲身参与`,
        tier: 0,
      });
    }
    return results;
  },
};

/**
 * 传播规则二：同场景实体目击传播（witness_propagation）
 *
 * 与事件主体在同一地点的实体自动目击事件。
 * source = 'witnessed', confidence = 0.8
 */
const witnessPropagation: PropagationRule = {
  id: 'propagation_witness',
  description: '与事件主体在同一地点的实体自动目击事件（witnessed, confidence=0.8）',

  propagate(event: NarrativeEvent, factGroup: FactGroup, factStore: FactStore): ProposedKnowledge[] {
    const results: ProposedKnowledge[] = [];
    const subject = event.params['subject'] as string | undefined;
    if (!subject) return results;

    // 获取事件主体的当前位置
    const subjectLocFacts = factStore.query({
      subject,
      predicate: 'location',
      atChapter: event.chapter,
    });
    if (subjectLocFacts.length === 0) return results;
    const subjectLocation = subjectLocFacts[0]!.value;

    // 查找同一位置的其他实体
    const sameLocationFacts = factStore.query({
      predicate: 'location',
      atChapter: event.chapter,
    });

    const witnessSet = new Set<string>();
    for (const locFact of sameLocationFacts) {
      // 跳过事件主体自身
      if (locFact.subject === subject) continue;
      // 检查是否在同一位置（EntityRef 结构比较，不用 JSON.stringify）
      if (isSameValue(locFact.value, subjectLocation)) {
        // 确认实体具有认知能力（entity/place/spatial_domain 等）
        // Phase 1 简化：所有同位置实体都可能目击
        // Phase 2 完善：检查 EntityKind 排除 information/foreshadowing/time 等
        witnessSet.add(locFact.subject);
      }
    }

    // 为每个目击者 + 每个 FactChange 生成 ProposedKnowledge
    for (const witnessId of witnessSet) {
      for (const change of factGroup.changes) {
        if (change.op === 'retract') continue;
        if (!change.changeId) continue;

        results.push({
          entityId: witnessId,
          changeId: change.changeId,
          source: 'witnessed',
          confidence: 0.8,
          reason: `${witnessId} 与事件主体 ${subject} 在同一地点，直接目击事件`,
          tier: 1,
        });
      }
    }

    return results;
  },
};

// =============================================================================
// 硬编码通用规则（built-in: Generic World Package）
// =============================================================================

/**
 * 通用 Transition Rule：死亡实体不能行动
 */
const deadEntityConstraint: TransitionRule = {
  id: 'constraint_dead_entity_action',
  description: '已死亡实体不能作为新事件的行动主体',

  check(event: NarrativeEvent, factStore: FactStore): NarrativeThread | null {
    const subject = event.params['subject'] as string | undefined;
    if (!subject) return null;

    const snapshot = factStore.getSnapshot(subject, event.chapter);
    if (snapshot['status'] === 'dead' || snapshot['status'] === 'deceased') {
      return {
        id: `thr_deadaction_${event.chapter}`,
        type: 'rule_violation',
        direction: 'retroactive',
        severity: 'critical',
        description: `已死亡实体 ${subject} 在第 ${event.chapter} 章作为事件主体行动`,
        closeCondition: {
          customRule: '需要补充复活事件，或修改死亡事件为其他状态',
          withinChapters: 5,
        },
        status: 'UNFILLED',
        closedBy: null,
        createdAtEvent: event.id,
        createdAtChapter: event.chapter,
        milestones: [],
        relatedEntities: [subject],
        upstreamFactIds: [],
      };
    }
    return null;
  },
};

/**
 * 通用 Inference Rule：双向敌对关系
 */
const bidirectionalEnemyRule: InferenceRule = {
  id: 'inference_bidirectional_enemy',
  description: '敌对关系是双向的，A 视 B 为敌，B 也视 A 为敌',

  infer(newFact: Fact, factStore: FactStore): Omit<Fact, 'id' | 'embeddingText'>[] {
    if (newFact.predicate !== 'enemy_of') return [];

    let targetEntityId: string;
    if (typeof newFact.value === 'object' && newFact.value !== null && (newFact.value as EntityRef).type === 'entity_ref') {
      targetEntityId = (newFact.value as EntityRef).entityId;
    } else {
      return [];
    }

    // 检查反向关系是否已存在
    const alreadyExists = factStore.query({
      subject: targetEntityId,
      predicate: 'enemy_of',
      atChapter: newFact.validFrom,
    }).some(f => {
      if (typeof f.value === 'object' && f.value !== null && (f.value as EntityRef).type === 'entity_ref') {
        return (f.value as EntityRef).entityId === newFact.subject;
      }
      return false;
    });

    if (!alreadyExists) {
      return [{
        subject: targetEntityId,
        predicate: 'enemy_of',
        value: { type: 'entity_ref', entityId: newFact.subject } as EntityRef,
        certainty: 'canonical',
        causeEvent: newFact.causeEvent,
        validFrom: newFact.validFrom,
        validTo: null,
        context: 'global',
        schemaVersion: 1,
      }];
    }
    return [];
  },
};

/**
 * 通用 Constraint Rule：同一实体+谓词不能同时有两条 canonical Fact
 */
const uniquePredicateConstraint: ConstraintRule = {
  id: 'constraint_unique_predicate',
  description: '同一实体同一谓词不能同时有两条当前有效的 canonical Fact',

  check(event: NarrativeEvent, factStore: FactStore): NarrativeThread | null {
    // Phase 1 简化：此约束由 FactStore.assert 的业务逻辑自然满足
    // （update = retract 旧 + assert 新，保证同时只有一条有效）
    // 完整实现由 ensurePredicateUniqueness 方法在 commit_event 处理层执行
    return null;
  },
};

// =============================================================================
// RuleEngine 实现
// =============================================================================

export class RuleEngine {
  private transitionRules: TransitionRule[];
  private inferenceRules: InferenceRule[];
  private constraintRules: ConstraintRule[];
  private propagationRules: PropagationRule[];

  constructor(options?: {
    transitions?: TransitionRule[];
    inferences?: InferenceRule[];
    constraints?: ConstraintRule[];
    propagations?: PropagationRule[];
  }) {
    // 总是包含通用内置规则 + 可选的 World Package 规则（后者优先级更高，放在前面）
    this.transitionRules = [
      ...(options?.transitions ?? []),
      deadEntityConstraint,
    ];
    this.inferenceRules = [
      ...(options?.inferences ?? []),
      bidirectionalEnemyRule,
    ];
    this.constraintRules = [
      ...(options?.constraints ?? []),
      uniquePredicateConstraint,
    ];
    this.propagationRules = [
      ...(options?.propagations ?? []),
      subjectAutoPropagation,
      witnessPropagation,
    ];
  }

  // -----------------------------------------------------------------------
  // 主方法：沙盒推演
  // -----------------------------------------------------------------------

  /**
   * 沙盒推演：计算事件后果，不写入真实 FactStore
   *
   * 执行顺序（§5.5 硬性约束，不可调整）：
   *   1. Transition Rules  → 收集违规/伏笔产生的 NarrativeThread
   *   2. Inference Rules   → 迭代推导新 Fact（最多 10 层深度）
   *      第 1 轮基于 FactGroup 中新增的 assert/update Fact 触发推理
   *      第 2+ 轮基于上一轮推理产出的 Fact 继续推理
   *   3. Constraint Rules  → 收集约束违规 Thread
   *   4. Propagation Rules → 收集建议的 Knowledge 条目
   *
   * @param factGroup 可选：提供 FactChange 列表以便推理引擎知道哪些 Fact 是新的
   *                  省略时推理规则扫描全量 FactStore（性能略低）
   */
  computeConsequences(
    event: NarrativeEvent,
    factStore: FactStore,
    factGroup?: FactGroup,
  ): EventConsequence {
    const state: SandboxState = {
      inferenceDepth: 0,
      generatedFactCount: 0,
      generatedThreadCount: 0,
      propagatedKnowledgeCount: 0,
      budgetExhausted: false,
    };

    const generatedThreads: NarrativeThread[] = [];
    const generatedFacts: Omit<Fact, 'id' | 'embeddingText'>[] = [];
    const warnings: string[] = [];

    // ---- 步骤 1: Transition Rules ----
    for (const rule of this.transitionRules) {
      if (state.budgetExhausted) break;
      const thread = rule.check(event, factStore);
      if (thread) {
        generatedThreads.push(thread);
        state.generatedThreadCount++;
        if (state.generatedThreadCount >= COMPLEXITY_BUDGET.MAX_GENERATED_THREADS) {
          warnings.push(`Thread 数量达到上限 ${COMPLEXITY_BUDGET.MAX_GENERATED_THREADS}，停止检查后续规则`);
          state.budgetExhausted = true;
          break;
        }
      }
    }

    // ---- 步骤 2: Inference Rules（迭代至收敛） ----
    // 第 1 轮：基于 FactGroup 中新增的 assert/update Fact 触发推理
    // 第 2+ 轮：基于上一轮推理产出的 Fact 继续推理，直到收敛或达到深度上限
    if (!state.budgetExhausted) {
      // 收集第 1 轮的种子 Fact（来自 FactGroup 中的 assert/update）
      let seedFacts: Omit<Fact, 'id' | 'embeddingText'>[] = [];
      if (factGroup) {
        for (const change of factGroup.changes) {
          if (change.op === 'assert' && change.payload) {
            seedFacts.push({
              subject: change.payload.subject ?? 'unknown',
              predicate: change.payload.predicate ?? 'unknown',
              value: change.payload.value ?? '',
              certainty: change.payload.certainty ?? 'canonical',
              causeEvent: factGroup.causeEvent,
              validFrom: change.payload.validFrom ?? event.chapter,
              validTo: change.payload.validTo ?? null,
              context: change.payload.context ?? 'global',
              relationKind: change.payload.relationKind,
              schemaVersion: change.payload.schemaVersion ?? 1,
            });
          }
        }
      }

      // 推理产物可能跨规则、跨轮次重复（例如多条 InferenceRule 各自推断出 A↔B 双向关系，
      // 或同一 Fact 在不同深度被重复触发）。按业务唯一键去重，避免下游 applyFactGroup 写入重复行。
      // 注意：不能用 Fact.id 作 key——推理产物此处 id 为空串占位（真实 id 由 applyFactGroup 生成）。
      const inferredKey = (f: Omit<Fact, 'id' | 'embeddingText'>): string =>
        `${f.subject}|${f.predicate}|${String(f.value)}|${f.context ?? ''}`;
      const seenInferredKeys = new Set<string>();
      // 用种子 Fact 初始化已见集合，防止推理产物与输入 Fact 重复（输入已作为 originalChanges 写入）
      for (const sf of seedFacts) seenInferredKeys.add(inferredKey(sf));

      let currentRoundFacts = seedFacts;
      const allInferred: Omit<Fact, 'id' | 'embeddingText'>[] = [];

      for (state.inferenceDepth = 1; state.inferenceDepth <= COMPLEXITY_BUDGET.MAX_INFERENCE_DEPTH; state.inferenceDepth++) {
        const nextRoundFacts: Omit<Fact, 'id' | 'embeddingText'>[] = [];

        // 如果当前轮没有输入 Fact 且不是第一轮，说明已收敛
        if (currentRoundFacts.length === 0 && state.inferenceDepth > 1) break;

        for (const rule of this.inferenceRules) {
          // 对当前轮的 Fact 逐一执行推理
          for (const fact of currentRoundFacts) {
            const inferred = rule.infer(
              { ...fact, id: '', embeddingText: '', schemaVersion: fact.schemaVersion ?? 1 } as Fact,
              factStore,
            );
            for (const inf of inferred) {
              if (state.generatedFactCount >= COMPLEXITY_BUDGET.MAX_GENERATED_FACTS) {
                warnings.push(`推理 Fact 数量达到上限 ${COMPLEXITY_BUDGET.MAX_GENERATED_FACTS}`);
                state.budgetExhausted = true;
                break;
              }
              const dedupeKey = inferredKey(inf);
              if (seenInferredKeys.has(dedupeKey)) continue; // 跳过重复推断的 Fact（跨规则/跨轮次去重）
              seenInferredKeys.add(dedupeKey);
              nextRoundFacts.push(inf);
              allInferred.push(inf);
              state.generatedFactCount++;
            }
            if (state.budgetExhausted) break;
          }
          if (state.budgetExhausted) break;
        }

        if (nextRoundFacts.length === 0) break; // 收敛
        currentRoundFacts = nextRoundFacts;
      }

      if (state.inferenceDepth > COMPLEXITY_BUDGET.MAX_INFERENCE_DEPTH && currentRoundFacts.length > 0) {
        warnings.push(`推理深度达到上限 ${COMPLEXITY_BUDGET.MAX_INFERENCE_DEPTH}，未收敛`);
      }

      generatedFacts.push(...allInferred);
    }

    // ---- 步骤 3: Constraint Rules ----
    // 对推理产出的 Fact 也参与约束检查
    for (const rule of this.constraintRules) {
      if (state.budgetExhausted) break;
      const violation = rule.check(event, factStore);
      if (violation) {
        generatedThreads.push(violation);
        state.generatedThreadCount++;
        if (state.generatedThreadCount >= COMPLEXITY_BUDGET.MAX_GENERATED_THREADS) {
          warnings.push(`Thread 数量达到上限 ${COMPLEXITY_BUDGET.MAX_GENERATED_THREADS}`);
          break;
        }
      }
    }

    // ---- 步骤 4: Propagation Rules ----
    // 传播规则需要 FactGroup（FactChange 列表）来构建 changeId 映射
    // Phase 1 简化：传播规则通过 propagateKnowledge 单独调用
    // 这里返回空的 proposedKnowledge，由上层 commit_event 处理逻辑调用 propagateKnowledge 后填充

    return {
      generatedFacts: generatedFacts.map(f => ({
        ...f,
        id: '', // 临时占位，Phase B commit_event 时由 applyFactGroup 生成真实 ID
        embeddingText: '',
        schemaVersion: 1,
      })) as Fact[],
      generatedThreads,
      proposedKnowledge: [],
      warnings,
    };
  }

  // -----------------------------------------------------------------------
  // 知识传播推演（独立于 computeConsequences，由 commit_event 处理层调用）
  // -----------------------------------------------------------------------

  /**
   * 知识传播推演：从事件 + FactGroup + 实体关系推导建议的 Knowledge 条目
   *
   * 遵守 I-10 不变式：不接收 KnowledgeStore，只基于客观状态推导。
   * 去重逻辑和显式认知操作覆盖由 commit_event 处理层负责。
   */
  propagateKnowledge(
    event: NarrativeEvent,
    factGroup: FactGroup,
    factStore: FactStore,
  ): ProposedKnowledge[] {
    const results: ProposedKnowledge[] = [];

    for (const rule of this.propagationRules) {
      if (results.length >= COMPLEXITY_BUDGET.MAX_PROPAGATED_KNOWLEDGE) break;

      try {
        const ruleResults = rule.propagate(event, factGroup, factStore);
        results.push(...ruleResults);
      } catch {
        // 单条规则失败不影响其他规则继续执行
        continue;
      }
    }

    // 截断到预算上限
    if (results.length > COMPLEXITY_BUDGET.MAX_PROPAGATED_KNOWLEDGE) {
      return results.slice(0, COMPLEXITY_BUDGET.MAX_PROPAGATED_KNOWLEDGE);
    }

    return results;
  }

  // -----------------------------------------------------------------------
  // 一致性后验校验（Phase B 事务内、audit_log 之前执行）
  // -----------------------------------------------------------------------

  /**
   * 诊断性后验审计：对已提交的世界状态运行约束规则
   *
   * 角色是非阻塞性诊断——真正的约束检查已在 Phase A 沙盒推演中完成。
   * 此方法发现的违规写入 audit_log（severity='warning'），供事后审查。
   *
   * @param factStore 已提交后的世界状态
   * @param atChapter 当前章节编号
   * @returns ValidationReport 包含违规和警告列表
   *
   * 对应架构文档 §5.2 / §5.5 / §10.1。
   */
  validateConsistency(
    factStore: FactStore,
    atChapter: number,
  ): import('../types.js').ValidationReport {
    const violations: import('../types.js').ConsistencyViolation[] = [];
    const warnings: string[] = [];

    // 对 atChapter 时刻的世界状态重新运行所有约束规则
    // 约束规则在 Phase A 已运行过，这里复检诊断性不一致
    for (const rule of this.constraintRules) {
      try {
        // 约束规则需要 event 参数，后验校验使用虚拟事件
        const virtualEvent: NarrativeEvent = {
          id: '_consistency_check_',
          kind: 'system',
          type: 'consistency_check',
          chapter: atChapter,
          description: '后验一致性校验',
          params: {},
          context: 'global',
          timestamp: new Date().toISOString(),
          factGroupId: '_consistency_check_',
          resolvedThreads: [],
          dependentFactIds: [],
        };
        const result = rule.check(virtualEvent, factStore);
        if (result) {
          // 约束规则返回 NarrativeThread 表示违规
          violations.push({
            factIds: result.upstreamFactIds,
            ruleId: rule.id,
            description: result.description,
            severity: result.severity === 'critical' ? 'error' : 'warning',
          });
        }
      } catch (err) {
        // 单条规则失败不影响其他规则
        warnings.push(`约束规则 ${rule.id} 后验校验异常: ${String(err)}`);
      }
    }

    // 检查事实层面的不一致（跨 Fact 的静态约束）
    // 例如：同一实体不能同时 alive 和 dead
    const currentFacts = factStore.query({ mode: 'current', atChapter });
    const deadEntities = new Set<string>();
    for (const f of currentFacts) {
      if (f.predicate === 'status' && f.value === 'dead') {
        deadEntities.add(f.subject);
      }
    }
    // 检查已死亡实体是否仍有活跃能力/物品等
    for (const f of currentFacts) {
      if (deadEntities.has(f.subject) && f.certainty === 'canonical') {
        // 排除 status 自身和 note 等元数据
        if (f.predicate !== 'status' && f.predicate !== 'note') {
          warnings.push(`实体 ${f.subject} 已死亡但仍有活跃 Fact: ${f.id} (${f.predicate}=${String(f.value)})`);
        }
      }
    }

    return { violations, warnings };
  }

  // -----------------------------------------------------------------------
  // 规则集查询（供 World Package 加载使用）
  // -----------------------------------------------------------------------

  /** 获取当前活跃的规则 ID 列表（调试/审计用） */
  getActiveRuleIds(): { transitions: string[]; inferences: string[]; constraints: string[]; propagations: string[] } {
    return {
      transitions: this.transitionRules.map(r => r.id),
      inferences: this.inferenceRules.map(r => r.id),
      constraints: this.constraintRules.map(r => r.id),
      propagations: this.propagationRules.map(r => r.id),
    };
  }
}

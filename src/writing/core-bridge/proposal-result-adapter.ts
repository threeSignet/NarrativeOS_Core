// =============================================================================
// ProposalResult → SimulationResult 适配器（W13-b 前置，P1）
// =============================================================================
// 把 Core propose_event 返回的 ProposalResult 投影为写作层 SimulationResult。
//
// 为什么需要它：
//   Agent 的 ReAct 循环已经通过 propose_event 拿到了 ProposalResult（含 proposalId + 推演后果），
//   写作层只需把这个"已推演的结果"投影成可审核的 ProposalView，而非重新调 simulateDraftAsEvent
//   再跑一次 propose_event（那样会产生新 proposalId，让 Agent 的原提案变成孤儿——W13 最深的坑）。
//   但 buildProposalReviewData 需要 SimulationResult，而 Agent 手里是 ProposalResult，二者类型不同。
//
// 真相源单一化：
//   本函数的转换逻辑与原 real-bridge.ts:runProposeEvent 的内联提取逐字对齐——抽出纯函数后，
//   real-bridge 与 narrative-agent.handleToolSuccess 共享同一段转换，杜绝两份副本漂移。
//
// 防御性过滤保留：
//   Core 实际输出可能不完全契合强类型（severity 在运行时未必是合法枚举），故沿用 real-bridge
//   的 typeof 守卫——过滤掉缺 severity 的线索与非字符串警告，避免脏数据污染 ruleWarnings 投影。
// =============================================================================

import type { SimulationResult } from './core-bridge-service.js';

/**
 * ProposalResult 的结构兼容子集——只声明转换所需字段，避免耦合完整 ProposalResult
 * （其含 proposedEvent/newFactIds/dependentFactIds 等与本转换无关的字段）。
 *
 * 可接受：
 *   - 强类型的 ProposalResult（其 consequences.generatedThreads 是 NarrativeThread[]，
 *     结构上兼容本接口的宽松线程形状，可安全传入）
 *   - real-bridge 的 wrapper.data（Record<string,unknown> 经 as 传入）
 */
export interface ProposalResultLike {
  proposalId: string;
  isSafeToCommit: boolean;
  /** FactRenderer 渲染的 Markdown 推演报告 */
  simulationReportMarkdown: string;
  /** Rule Engine 沙盒推演后果（EventConsequence） */
  consequences?: {
    /** 违规/伏笔产生的叙事线索——ruleWarnings 分级的唯一数据源 */
    generatedThreads?: Array<{
      severity?: string;
      type?: string;
      description?: string;
    }>;
    /** 给 LLM 的非阻塞警告原文 */
    warnings?: unknown[];
  };
}

/**
 * 把 ProposalResult 投影为 SimulationResult。
 *
 * 字段映射：
 *   - proposalId / isSafeToCommit：直传
 *   - simulationReportMarkdown → report
 *   - consequences.generatedThreads → consequenceThreads（过滤掉 severity 非字符串的脏线索）
 *   - consequences.warnings → consequenceWarnings（过滤掉非字符串项）
 *
 * 与 buildProposalReviewData 的衔接：返回值直接作为其 `simulation` 入参，
 * 由此生成 factDiff/involvedEntityIds/ruleWarnings/humanSummary 四件套。
 */
export function proposalResultToSimulationResult(pr: ProposalResultLike): SimulationResult {
  const consequences = pr.consequences ?? {};

  const consequenceThreads = (consequences.generatedThreads ?? [])
    .filter((t) => t && typeof t.severity === 'string')
    .map((t) => ({
      severity: t.severity as 'minor' | 'major' | 'critical',
      type: typeof t.type === 'string' ? t.type : '',
      description: typeof t.description === 'string' ? t.description : '',
    }));

  const consequenceWarnings = (consequences.warnings ?? [])
    .filter((w): w is string => typeof w === 'string');

  return {
    proposalId: pr.proposalId,
    isSafeToCommit: pr.isSafeToCommit,
    report: pr.simulationReportMarkdown,
    consequenceThreads,
    consequenceWarnings,
  };
}

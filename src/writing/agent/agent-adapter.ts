// =============================================================================
// Agent 适配层（Phase 7 桥接层 · W2）
// =============================================================================
// 设计依据：Phase7-Refinement.md §8.2.3（renderProposalForUser 六区展示）、
//           §8.4（agent-adapter 职责）、§8.5.5（WritingLayerServices 聚合）。
//
// 本模块是 Agent 与写作层之间的"展示适配层"——把写作层内部对象（ProposalView 等）
// 投影为 Agent 可直接拼进回复文本的人话结构，使 Agent 在 propose_event 后能主动向作者
// 展示结构化推演（而非只回 LLM 自由文本，把结构化展示全压给 CLI 的 /review）。
//
// 范围说明（W2 范围取舍）：
//   spec §8.4 的 agent-adapter 还规划了"意图→Command→service 分发表"。本任务**不建该表**——
//   Agent 当前架构里除 confirm_commit/reject_draft 两个确定性意图外，其余意图全委派 ReAct
//   （LLM 选工具），dispatcher 无消费方=死代码；两个确定性意图的 service 委托已在 W13 的
//   handlePendingDecisions/handleRejectDraft 落地。故本文件只实现 renderProposalForUser
//   （真实消费方）+ WritingLayerServices 聚合接口（供 context-assembly / 未来 dispatcher 复用）。
//   dispatcher 推迟到 ReAct 路径改造时再补，避免造空映射表。
// =============================================================================

import type { ProjectService } from '../services/project-service.js';
import type { IdeaService } from '../services/idea-service.js';
import type { BlueprintService } from '../services/blueprint-service.js';
import type { DraftService } from '../services/draft-service.js';
import type { EntityService } from '../services/entity-service.js';
import type { WorkflowService } from '../services/workflow-service.js';
import type { AuditService } from '../services/audit-service.js';
import type { CoreBridgeService } from '../core-bridge/core-bridge-service.js';
import type { SQLiteWritingStore } from '../repositories/writing-store.js';
import type { WritingProposalView, FactDiffEntry, RuleWarning } from '../models/types.js';

/**
 * 写作层服务聚合容器（§8.5.5）
 *
 * 把 Agent 横向依赖的 9 个写作层对象收拢为一个聚合，供桥接层模块（context-assembly、
 * 未来 dispatcher）作为单一依赖注入，避免每个模块各写一长串服务参数。
 *
 * 必填项（写作层状态注入的最小集合）：
 *   - writingStore：已注册实体的枚举来源（context-assembly 实体段）
 *   - workflowService：待确认决策的枚举来源（context-assembly 决策段）
 *
 * 选填项：projectService / ideaService / blueprintService / draftService / entityService /
 *   auditService / coreBridge——按消费方需要注入；缺省时对应能力降级（如无 blueprintService
 *   则 buildSystemPrompt 不注入蓝图段）。
 *
 * 装配契约（narrative-agent.ts 构造时）：仅当必填项 + writingProjectId 齐备时才组装本容器，
 * 否则 writingLayer=undefined（裸路径 / Phase 6 部分接线），保证写作层状态注入不会在
 * 缺依赖时半启。
 */
export interface WritingLayerServices {
  /** 已注册实体枚举来源（必填） */
  writingStore: SQLiteWritingStore;
  /** 待确认决策枚举来源（必填） */
  workflowService: WorkflowService;
  /** 作品元信息查询（选填，未来 dispatcher 消费） */
  projectService?: ProjectService;
  /** 灵感管理（选填） */
  ideaService?: IdeaService;
  /** 当前活跃蓝图（选填，buildSystemPrompt 注入题材感知蓝图段） */
  blueprintService?: BlueprintService;
  /** 草案管理（选填） */
  draftService?: DraftService;
  /** 实体草图管理（选填） */
  entityService?: EntityService;
  /** 审计（选填） */
  auditService?: AuditService;
  /** Core 桥接（选填，readCurrentWorldSnapshot 等异步能力） */
  coreBridge?: CoreBridgeService;
}

/**
 * FactDiffEntry.op → 展示图标/前缀
 *
 * humanDescription 已是完整人话（含"新增/更新/移除：实体的属性 = 值"），故这里只加一个
 * 视觉前缀区分操作类型，避免重复动词。图标对齐 CLI /review 的渲染约定（chat.ts）。
 */
function diffOpPrefix(op: FactDiffEntry['op']): string {
  if (op === 'new') return '+';
  if (op === 'updated') return '~';
  return '-'; // retracted
}

/**
 * RuleWarning.level → 展示图标
 *
 * blocker（阻断，必须作者裁决）/ warning（需注意）/ info（提示）。
 * 图标让作者一眼区分严重度，对齐 proposal-review.ts 的 severity→level 映射。
 */
function warningIcon(level: RuleWarning['level']): string {
  if (level === 'blocker') return '🚫';
  if (level === 'warning') return '⚠️';
  return 'ℹ️';
}

/**
 * 把 ProposalView 投影为作者可读的结构化推演文本（§8.2.3 六区展示的 Zone 1-5）。
 *
 * Agent 在 propose_event 物化出 open PV 后，把本函数的输出追加到回合回复，使作者无需
 * 主动 /review 即可在对话里看到"系统准备写入什么、有哪些风险"。Zone 6（提交结果）由
 * applyDecisionConfirm 的返回 content 承担，本函数不重复渲染，避免双轨。
 *
 * §9.1 合规：只读 PV 内**已人话化**的字段——
 *   - humanSummary（buildProposalReviewData 生成时已用显示名）
 *   - factDiff[].humanDescription（已解析 ent_→显示名 + predicate→中文标签）
 *   - ruleWarnings[].message（Core 后果描述）
 *   - simulationInputs（事件描述/类型/章节，非技术 id）
 *   涉及实体从 factDiff[].entityName 派生（已是显示名），**绝不裸露 involvedEntityIds 的 ent_ id**。
 *
 * @param pv 待展示的 ProposalView（通常 status==='open'，待作者确认）
 * @returns 多行结构化文本；PV 缺字段时对应区段降级省略，绝不抛错
 */
export function renderProposalForUser(pv: WritingProposalView): string {
  const lines: string[] = [];

  // ---- Zone 1：人话摘要（推演是否安全 + 涉及哪些实体 + 变更项数）----
  // humanSummary 由 buildProposalReviewData 确定性生成（不调 LLM），已是作者可读句子。
  // 缺失时降级为通用提示，保证总有摘要区。
  const summary = pv.humanSummary?.trim() || '系统已完成事件推演，请确认是否写入世界状态。';
  lines.push(`📋 事件推演：${summary}`);

  // ---- Zone 2：设定变更（factDiff 逐条）----
  // 只在有变更时渲染；humanDescription 已含完整人话，前缀仅区分操作类型。
  if (pv.factDiff.length > 0) {
    lines.push('');
    lines.push('【设定变更】');
    for (const diff of pv.factDiff) {
      lines.push(`  ${diffOpPrefix(diff.op)} ${diff.humanDescription}`);
    }
  }

  // ---- Zone 3：一致性检查（ruleWarnings，含风险等级）----
  // blocker 必须作者裁决；无警告时显式告知"通过"，避免作者误以为未检查。
  lines.push('');
  lines.push('【一致性检查】');
  if (pv.ruleWarnings.length === 0) {
    lines.push('  ✅ 推演通过，未发现一致性冲突。');
  } else {
    for (const w of pv.ruleWarnings) {
      lines.push(`  ${warningIcon(w.level)} ${w.message}`);
    }
  }

  // ---- Zone 4：涉及实体（从 factDiff.entityName 派生显示名，去重）----
  // 用 factDiff 的显示名而非 involvedEntityIds（后者是裸 ent_ id，§9.1 禁止 normal 模式泄漏）。
  const involvedNames: string[] = [];
  const seen = new Set<string>();
  for (const diff of pv.factDiff) {
    const name = diff.entityName?.trim();
    if (name && !seen.has(name)) {
      seen.add(name);
      involvedNames.push(name);
    }
  }
  if (involvedNames.length > 0) {
    lines.push('');
    lines.push(`【涉及实体】${involvedNames.join('、')}`);
  }

  // ---- Zone 5：推演输入摘要（供作者核对"系统按什么输入推演的"）----
  // simulationInputs 仅 simulateDraft 产出的 PV 携带；实体注册等来源为 undefined，省略该区。
  const inputs = pv.simulationInputs;
  if (inputs) {
    lines.push('');
    lines.push('【推演输入】');
    if (inputs.eventDescription) {
      lines.push(`  事件：${inputs.eventDescription}`);
    }
    const meta: string[] = [];
    if (inputs.eventType) meta.push(`类型 ${inputs.eventType}`);
    if (typeof inputs.chapter === 'number') meta.push(`第 ${inputs.chapter} 章`);
    if (meta.length > 0) {
      lines.push(`  ${meta.join(' · ')}`);
    }
  }

  // ---- Zone 6：留给 applyDecisionConfirm 的返回 content 承担（提交结果），此处不渲染 ----
  // 仅给作者一个明确的下一步动作指引。
  lines.push('');
  lines.push('回复"确认"提交到世界状态，或告诉我需要修改的地方。');

  return lines.join('\n');
}

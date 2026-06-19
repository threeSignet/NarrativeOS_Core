// =============================================================================
// Proposal Review 数据投影——四件套生成（§12 / §34 / §9.2）
// =============================================================================
// 设计文档：Phase7-Refinement.md §9.2（ProposalReviewViewModel）、§34 ProposalView。
//
// 缺口（W7）：ProposalView 的审核数据四件套此前全空——
//   factDiff / involvedEntityIds / ruleWarnings / humanSummary。
//   draft-service.simulateDraft 只把 eventDescription 塞进 humanSummary，其余留空。
//
// 本模块把「草案的 factChanges（结构化 DSL）+ CoreBridge 推演后果」投影为四件套，
// 写入 ProposalView，供审核页（/review）展示。
//
// 数据来源（W7 调研结论，无架构阻塞、不改 Core）：
//   - factDiff / involvedEntityIds / humanSummary ← factChanges（Agent 传入的结构化 DSL）
//   - ruleWarnings ← SimulationResult.consequenceThreads（severity）+ consequenceWarnings
//
// §9.1 合规（normal 模式不泄漏技术字段）：
//   - entityName 必须是显示名（解析 ent_ → 中文名），不能裸露 ent_ 前缀。
//   - predicateLabel 必须是人话标签，不能裸露 Core predicate（如 'location'）。
//   - value 若为实体引用（ent_）也需解析为显示名。
//   - involvedEntityIds 保留原始 ent_ id（这是 ProposalView 内部存储字段，非 ViewModel 直显；
//     §9.2 ProposalReviewViewModel.involvedEntities 是显示名列表，由审核页渲染时再解析）。
// =============================================================================

import type { FactDiffEntry, RuleWarning } from '../models/types.js';
import type { SimulationResult } from '../core-bridge/core-bridge-service.js';

/** Proposal Review 四件套——写入 WritingProposalView 的结构化审核数据 */
export interface ProposalReviewData {
  factDiff: FactDiffEntry[];
  involvedEntityIds: string[];
  ruleWarnings: RuleWarning[];
  humanSummary: string;
}

/** 实体 ID → 显示名解析器（注入，避免投影层耦合存储；未解析返回 undefined 由调用方兜底） */
export type EntityNameResolver = (entityId: string) => string | undefined;

/** fact_change 的最小结构（FactChangeInput snake_case 子集，投影只读这些字段） */
interface FactChangeLike {
  op?: string;
  subject?: string;
  predicate?: string;
  value?: unknown;
  target_fact_id?: string;
  /** 显式声明的旧值（FactChangeInput 标准不携带；个别流程若提供则展示） */
  old_value?: unknown;
}

/**
 * 常见 Core predicate → 中文标签映射
 *
 * §9.1 禁止 normal 模式裸露 Core predicate（如 'location'/'connected_to'），
 * 故 predicateLabel 必须是人话。predicate 词表来自 WorldPackage（题材相关），
 * 此处只覆盖本仓库常用谓词；未命中降级为通用「属性」——保证不泄漏原始 token，
 * 完整谓词国际化待 WorldPackage predicate registry 接入（后续功能点）。
 */
const PREDICATE_LABELS: Record<string, string> = {
  location: '位置',
  position: '位置',
  status: '状态',
  realm: '境界',
  level: '等级',
  weapon: '武器',
  age: '年龄',
  name: '姓名',
  alias: '别名',
  affiliation: '所属势力',
  faction: '阵营',
  health: '生命状态',
  mood: '心境',
  role: '身份',
  occupation: '职业',
  appearance: '外貌',
  personality: '性格',
  goal: '目标',
  secret: '秘密',
  ability: '能力',
  relationship: '关系',
  origin: '来历',
  title: '头衔',
};

/** 谓词 → 人话标签（命中映射取中文，未命中降级「属性」，绝不裸露原始 predicate） */
function predicateToLabel(predicate: unknown): string {
  if (typeof predicate !== 'string' || predicate.length === 0) return '属性';
  return PREDICATE_LABELS[predicate] ?? '属性';
}

/** 把任意 value 人话化；若为实体引用（ent_ 前缀）解析为显示名，避免泄漏 */
function stringifyValue(value: unknown, resolve: EntityNameResolver | undefined): string {
  if (value === null || value === undefined) return '(空)';
  if (typeof value === 'string') {
    // 实体引用值：ent_ 前缀 → 解析显示名，未解析则占位（不泄漏 ent_）
    if (/^ent_/.test(value)) {
      return resolve?.(value) ?? '(实体)';
    }
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  // 对象/数组：序列化后截断，避免大 JSON 污染摘要
  try {
    const json = JSON.stringify(value);
    return json.length > 60 ? `${json.slice(0, 57)}…` : json;
  } catch {
    return '(复杂值)';
  }
}

/** Core op（assert/retract/update）→ FactDiffEntry.op（new/updated/retracted） */
function mapDiffOp(op: unknown): FactDiffEntry['op'] {
  if (op === 'assert') return 'new';
  if (op === 'update') return 'updated';
  if (op === 'retract') return 'retracted';
  return 'new'; // 未知 op 兜底为新增（不阻断展示）
}

/** 实体 id → 显示名；未解析回退占位（绝不裸露 ent_） */
function resolveDisplay(entityId: string | undefined, resolve: EntityNameResolver | undefined): string {
  if (!entityId) return '(未指定实体)';
  if (!/^ent_/.test(entityId)) return entityId; // 非 Core id（已是显示名）原样返回
  return resolve?.(entityId) ?? '(未命名实体)';
}

/** 组装单条 fact_diff 的人话描述 */
function describeChange(
  op: FactDiffEntry['op'],
  entityName: string,
  predicateLabel: string,
  newValue: string,
  oldValue: string | undefined,
): string {
  const verb = op === 'new' ? '新增' : op === 'updated' ? '更新' : '移除';
  if (op === 'updated' && oldValue !== undefined) {
    return `${verb}：${entityName} 的${predicateLabel}（${oldValue} → ${newValue}）`;
  }
  if (op === 'retracted') {
    return `${verb}：${entityName} 的${predicateLabel}`;
  }
  return `${verb}：${entityName} 的${predicateLabel} = ${newValue}`;
}

/**
 * 从推演后果映射 ruleWarnings（§9.2 warnings 区，含风险等级）
 *
 * severity → level：
 *   critical                                  → blocker（阻断，必须作者裁决）
 *   major + (rule_violation | logic_conflict) → blocker（isSafeToCommit 判否的依据）
 *   major（其他）                              → warning
 *   minor                                     → info
 * consequenceWarnings（Core 给 LLM 的非阻塞提示）→ info
 *
 * 防御：若 isSafeToCommit=false 但未产出 blocker 级条目（理论不应发生），
 * 补一条 blocker 兜底，确保「不安全提交」在审核页有可见的阻断提示。
 */
/**
 * 被判为 blocker 的线索类型集合。
 *
 * severity=critical 的线索总是 blocker（与 type 无关）。本集合用于 major 级线索的二次细化：
 * major + 命中本集合的 type → blocker，否则 → warning。
 * 提为模块级 export 常量，未来 WorldPackage 可注入扩展（题材相关的 blocker 类型，如 timeline_paradox）。
 */
export const BLOCKER_THREAD_TYPES: ReadonlySet<string> = new Set([
  'rule_violation',
  'logic_conflict',
]);

function buildRuleWarnings(simulation: SimulationResult): RuleWarning[] {
  const warnings: RuleWarning[] = [];

  for (const t of simulation.consequenceThreads) {
    let level: RuleWarning['level'];
    if (t.severity === 'critical') {
      level = 'blocker';
    } else if (t.severity === 'major') {
      level = BLOCKER_THREAD_TYPES.has(t.type) ? 'blocker' : 'warning';
    } else {
      level = 'info';
    }
    warnings.push({ level, message: t.description });
  }

  for (const w of simulation.consequenceWarnings) {
    warnings.push({ level: 'info', message: w });
  }

  // 防御性兜底：不安全但无 blocker 可见 → 补一条
  if (!simulation.isSafeToCommit && !warnings.some((w) => w.level === 'blocker')) {
    warnings.push({
      level: 'blocker',
      message: '推演发现阻断级一致性风险，请审阅完整报告后再决定是否提交',
    });
  }

  return warnings;
}

/** 生成人话摘要（确定性模板，不调 LLM） */
function buildHumanSummary(
  eventDescription: string,
  factDiff: FactDiffEntry[],
  isSafeToCommit: boolean,
  involvedNames: string[],
): string {
  const changeCount = factDiff.length;
  const safety = isSafeToCommit ? '推演通过' : '推演发现警告，需作者裁决';
  const entitiesPart = involvedNames.length > 0 ? `，涉及 ${involvedNames.join('、')}` : '';
  return `系统准备写入：${eventDescription}。本次将${changeCount > 0 ? `变更 ${changeCount} 项设定` : '不改变既有设定'}${entitiesPart}，${safety}。`;
}

/**
 * 构建 Proposal Review 四件套
 *
 * @param input.eventDescription 事件描述（草案 summary/title 兜底）
 * @param input.factChanges       Agent 传入的结构化 DSL（snake_case FactChangeInput）
 * @param input.simulation        CoreBridge 推演结果（含 consequenceThreads/Warnings）
 * @param input.resolveEntityName 可选：ent_ → 显示名解析（避免 §9.1 泄漏）
 */
export function buildProposalReviewData(input: {
  eventDescription: string;
  factChanges: unknown[];
  simulation: SimulationResult;
  resolveEntityName?: EntityNameResolver;
}): ProposalReviewData {
  const { eventDescription, factChanges, simulation, resolveEntityName } = input;
  const changes = (factChanges as FactChangeLike[]).filter(
    (c): c is FactChangeLike => c !== null && typeof c === 'object',
  );

  // ---- factDiff ----
  // 注：FactChangeInput（LLM 传入的 snake_case DSL）在 propose 阶段不携带旧值——
  // 旧值只有 Core 在沙盒里查 target_fact_id 后才知道，且仅落在 markdown 报告中。
  // 故 oldValue 仅当输入显式声明 old_value 时才填，否则 undefined（§9.2 ViewModel 示例本就未含 oldValue）。
  const factDiff: FactDiffEntry[] = changes.map((c) => {
    const diffOp = mapDiffOp(c.op);
    const entityName = resolveDisplay(c.subject, resolveEntityName);
    const predicateLabel = predicateToLabel(c.predicate);
    const newValue = stringifyValue(c.value, resolveEntityName);
    const oldValue =
      c.old_value !== undefined ? stringifyValue(c.old_value, resolveEntityName) : undefined;
    return {
      op: diffOp,
      entityName,
      predicateLabel,
      newValue,
      oldValue,
      humanDescription: describeChange(diffOp, entityName, predicateLabel, newValue, oldValue),
    };
  });

  // ---- involvedEntityIds（去重，保留原始 ent_ id——内部存储字段）----
  const seen = new Set<string>();
  const involvedEntityIds: string[] = [];
  for (const c of changes) {
    if (typeof c.subject === 'string' && c.subject && !seen.has(c.subject)) {
      seen.add(c.subject);
      involvedEntityIds.push(c.subject);
    }
  }

  // ---- ruleWarnings ----
  const ruleWarnings = buildRuleWarnings(simulation);

  // ---- humanSummary（用解析后的显示名，避免泄漏）----
  const involvedNames = involvedEntityIds.map((id) => resolveDisplay(id, resolveEntityName));
  const humanSummary = buildHumanSummary(eventDescription, factDiff, simulation.isSafeToCommit, involvedNames);

  return { factDiff, involvedEntityIds, ruleWarnings, humanSummary };
}

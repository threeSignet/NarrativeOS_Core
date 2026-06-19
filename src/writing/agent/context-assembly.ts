// =============================================================================
// Agent 写作层上下文组装（Phase 7 桥接层 · W2）
// =============================================================================
// 设计依据：Phase7-Refinement.md §8.3.3（写作层状态注入 Push 检索流程图：注入 WP + Blueprint
//           摘要 + 写作层状态）、§8.4（context-assembly 职责）。
//
// 本模块把"当前写作层状态"组装成一段 system message，注入 Agent 的 LLM 上下文，
// 让 LLM 在 Reason 时知晓：当前已注册哪些实体（构建 factChanges 时用其 Core entity ID）、
// 这些实体**当前的设定事实**（避免生成与既有设定矛盾的变更）、有哪些待确认决策。
// 抽离自 narrative-agent.ts 此前内联的写作层状态块，使其可单测、可复用、单一真相源。
//
// 同步契约（关键约束）：
//   buildLlmMessages 是同步函数（返回 ChatMessage[]，不返回 Promise），故本函数必须同步。
//   因此**本函数不调用** readCurrentWorldSnapshot（CoreBridge 的异步世界快照接口）——
//   那会强制把 buildLlmMessages 改异步，引发调用链大面积异步化。改由调用方（runReActLoop）
//   在每回合**预取一次** WorldSnapshot（异步），把结果作为 worldSnapshot 入参传入；本函数同步消费。
//   预取而非每轮 ReAct 迭代都取：单回合内世界状态不变（提交只在作者确认后、循环外发生），
//   避免重复的 N 次 get_context_slice Core 调用。
//
// §9.1 合规边界：本段是发给 LLM 的 system message（非作者直显视图），故可含 Core entity ID
// （ent_...）——LLM 需要它来构造 factChanges 的 subject。这与面向作者的 ViewModel 字段过滤
// （不泄漏 ent_）是两个不同通道，不冲突。
// =============================================================================

import type { WritingRequestContext } from '../services/context.js';
import type { WritingLayerServices } from './agent-adapter.js';
import type { WorldSnapshot } from '../core-bridge/core-bridge-service.js';

/**
 * 单实体注入事实数上限。
 *
 * 单个实体可能有大量历史事实（每个时序三元组一条），全量注入会撑爆上下文。只注入前 N 条
 * （get_context_slice 已按章节相关度排序，靠前的更贴合"当前状态"）。阈值 8 是经验值，
 * 平衡"展示实体当前关键设定"与"上下文预算"。
 */
const MAX_FACTS_PER_ENTITY = 8;

/**
 * 已注册实体渲染的截断阈值。
 *
 * 超过此数的实体不逐条注入（避免撑爆 LLM 上下文窗口），改为截断 + 告警提示。
 * 阈值 30 是经验值（平衡"覆盖多数项目主体实体"与"上下文预算"），可在后续按实际 token 占用调整。
 */
const MAX_INJECTED_ENTITIES = 30;

/**
 * 组装写作层状态注入文本（§8.3.3）。
 *
 * 产出两段（均仅在有内容时才生成对应文本，整体为空串时调用方应跳过注入）：
 *   1. 实体段：name (coreEntityId, typeLabel) [+ 当前事实]，来源取决于 worldSnapshot 是否传入：
 *      - 传 worldSnapshot（runReActLoop 每回合预取的 Core 世界快照）：渲染"实体 + 当前设定事实"
 *        的富版本——LLM 既拿到 subject 所需的 entity ID，又拿到该实体当前已成立的事实，避免生成
 *        与既有设定矛盾的 factChanges（§8.3.3 "注入 WP" 的落地）。
 *      - 未传（无 coreBridge / 预取失败降级）：回落到 listEntitySketches 的轻量版（仅 name+id+type），
 *        与原 narrative-agent.ts 内联块逐字一致，保证裸路径 / 部分接线环境行为不变。
 *   2. 待确认决策段：[kind] title 列表 + 提醒作者处理
 *
 * @param services       写作层服务聚合（必填 writingStore + workflowService）
 * @param ctx            写作层请求上下文（取 projectId 枚举本项目的实体/决策）
 * @param worldSnapshot  可选：调用方预取的 Core 世界快照。传入则启用富实体段（含当前事实）。
 * @returns 组装文本；无内容时返回空串（调用方据此决定是否 push 该 system message）
 */
export function assembleWritingContext(
  services: WritingLayerServices,
  ctx: WritingRequestContext,
  worldSnapshot?: WorldSnapshot,
): string {
  const sections: string[] = [];

  // ---- 段 1：实体段（富版优先，降级到轻量版）----
  if (worldSnapshot) {
    const seg = renderWorldEntitySegment(worldSnapshot);
    if (seg) sections.push(seg);
  } else {
    const seg = renderSketchEntitySegment(services, ctx);
    if (seg) sections.push(seg);
  }

  // ---- 段 2：待确认决策 ----
  const decisions = services.workflowService.listPendingDecisions(ctx);
  if (decisions.length > 0) {
    const decisionList = decisions
      .map((d) => `  [${d.kind}] ${d.title}`)
      .join('\n');
    sections.push(
      `当前有待确认事项：\n${decisionList}\n\n请提醒用户确认或修改。`,
    );
  }

  return sections.join('\n\n');
}

/**
 * 富实体段：从预取的 WorldSnapshot 渲染"实体 + 当前设定事实"。
 *
 * 每行一个实体：`displayName (coreEntityId, typeLabel)：fact1=value1；fact2=value2`。
 * 含 coreEntityId（system message，§9.1 允许）+ 当前事实——LLM 据此既知有哪些实体、用什么 ID，
 * 又知这些实体当前已成立的设定（避免生成矛盾变更）。
 *
 * 截断：实体 >MAX_INJECTED_ENTITIES 或单实体事实 >MAX_FACTS_PER_ENTITY 时截断并告警，
 * 避免撑爆上下文。查询失败的实体（带 error）仍列出其 ID（LLM 仍需 ID 构造 subject），事实段标"（设定读取失败）"。
 */
function renderWorldEntitySegment(snapshot: WorldSnapshot): string {
  const all = snapshot.entities;
  if (all.length === 0) return '';

  const total = all.length;
  const shown = all.slice(0, MAX_INJECTED_ENTITIES);
  const truncatedNote = total > MAX_INJECTED_ENTITIES
    ? `\n  （共 ${total} 个已注册实体，已截断仅显示前 ${MAX_INJECTED_ENTITIES} 个）`
    : '';

  // currentChapter 类型恒为 number（CoreBridge 推导：已存在 draft 的最大 chapter，默认 1）
  const chapterHint = `（第 ${snapshot.currentChapter} 章）`;

  const lines = shown.map((e) => {
    const facts = (e.factIndex ?? [])
      .filter((f) => typeof f.predicate === 'string' && f.predicate.length > 0)
      .slice(0, MAX_FACTS_PER_ENTITY)
      .map((f) => `${f.predicate}=${f.value}`);
    const factText = e.error
      ? '（设定读取失败）'
      : facts.length > 0
        ? facts.join('；')
        : '（暂无设定）';
    return `  ${e.displayName} (${e.coreEntityId}, ${e.typeLabel})：${factText}`;
  });

  return `当前已注册实体与世界状态${chapterHint}（构建 factChanges 时使用这些 entity ID，勿与既有设定矛盾）：\n${lines.join('\n')}${truncatedNote}`;
}

/**
 * 轻量实体段：从 WritingStore 的实体草图渲染（无 Core 事实，降级路径）。
 *
 * 逻辑与原 narrative-agent.ts 内联块逐字一致——过滤 status==='registered' 且 coreEntityId 已回填。
 * coreEntityId 是 LLM 构造 factChanges.subject 必须的 Core entity ID——不过滤会导致 LLM 引用未注册草图，
 * commit_event 时撞 entities 表 FK 失败（见 CLAUDE.md 陷阱 5）。
 */
function renderSketchEntitySegment(
  services: WritingLayerServices,
  ctx: WritingRequestContext,
): string {
  const registered = services.writingStore
    .listEntitySketches(ctx.projectId)
    .filter((e) => e.status === 'registered' && e.coreEntityId);

  if (registered.length === 0) return '';

  const total = registered.length;
  const shown = registered.slice(0, MAX_INJECTED_ENTITIES);
  const truncatedNote = total > MAX_INJECTED_ENTITIES
    ? `\n  （共 ${total} 个已注册实体，已截断仅显示前 ${MAX_INJECTED_ENTITIES} 个）`
    : '';
  const entityList = shown
    .map((e) => `  ${e.displayName} (${e.coreEntityId}, ${e.typeLabel})`)
    .join('\n');
  return `当前已注册实体（构建 factChanges 时使用这些 entity ID）：\n${entityList}${truncatedNote}`;
}

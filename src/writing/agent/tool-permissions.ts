// =============================================================================
// Agent 工具权限门控（Phase 7 安全地基 · W1）
// =============================================================================
// 设计依据：Phase7-Refinement §8.0 / §8.2.1 / §8.3
//
// 核心原则（§8.0 "commit 不消失，换调用者"）：
//   Agent 的 ReAct 循环只做"推演 + 展示 + 引导确认"，永远不得直接写正式世界状态。
//   commit_event 这类不可逆写入工具，只能由"经用户确认的通道"调用：
//     - handleConfirmCommit（用户输入确认关键词触发的确认通道）
//     - CoreBridge.commitReviewedProposal（Proposal Review 审核后提交）
//   这两条通道是独立调用路径，不经过本门控——它们是经用户授权的合法写入入口。
//
// 本模块是 Agent 工具权限判定的"单一事实源"。W2 的 AgentCapability / AGENT_PERMISSIONS
// 权限矩阵将在此基础上扩展（届时 register_entity 在实体审核通道打通后并入禁止集合）。
// =============================================================================

import { ToolErrorCode } from '../../types/tool.js';
import type { ToolError, ToolResult } from '../../types/tool.js';

/**
 * Agent ReAct 循环禁止直接调用的工具集合。
 *
 * 收录标准：会"不可逆地写入正式世界状态（Core）"的工具。
 *   - commit_event：事件 / Fact / Knowledge / Thread 的原子提交
 *   - register_entity：注册实体到 Core（不可逆，§25 #7 要求 Agent 不得直接调）
 *
 * register_entity 于 2026-06-18 并入：其实体审核通道（detectEntityHints → EntitySketch →
 * approveCandidate → coreBridge.registerReviewedEntity）已完整就位（W2/W4 + CLI 批次验证），
 * Agent 不再需要直接调 register_entity tool——改走审核通道。narrative-agent.ts:1629 的
 * register_entity 成功后处理器仍保留（防御性，万一旧路径触发），但 ReAct 循环会在
 * 工具执行前被 isToolForbiddenForAgent 短路。
 */
export const AGENT_FORBIDDEN_TOOLS: ReadonlySet<string> = new Set<string>([
  'commit_event',
  'register_entity',
]);

/**
 * 判断某工具是否被 Agent 直接调用所禁止。
 *
 * 仅作用于 Agent 的 ReAct 工具循环（LLM 发起的 tool call）。
 * 确认通道（handleConfirmCommit / CoreBridge.commit*）不经此判定——
 * 它们是用户授权的独立写入入口，绕过工具循环。
 *
 * @param toolName 工具名
 * @returns true 表示 Agent 不得直接执行该工具
 */
export function isToolForbiddenForAgent(toolName: string): boolean {
  return AGENT_FORBIDDEN_TOOLS.has(toolName);
}

/**
 * 构造"Agent 禁止直接调用"的 ToolError。
 *
 * retryable=false 是关键：这是权限策略而非可修复错误，重试同样的调用永远会被拒。
 * diagnoseFailure 据此把 nextAction 设为 ask_user，引导 LLM 转为请求用户确认，
 * 而非反复重试（否则会耗尽 maxRepeatedToolFailure 才终止）。
 *
 * 错误码按工具区分：commit_event → AGENT_COMMIT_FORBIDDEN，
 * register_entity → AGENT_REGISTER_FORBIDDEN（语义不同：提交 vs 注册）。
 *
 * @param toolName 被禁的工具名
 */
export function makeForbiddenToolError(toolName: string): ToolError {
  const isRegister = toolName === 'register_entity';
  return {
    code: isRegister ? ToolErrorCode.AGENT_REGISTER_FORBIDDEN : ToolErrorCode.AGENT_COMMIT_FORBIDDEN,
    message: isRegister
      ? `Agent 不得直接调用 ${toolName}：实体注册须经审核通道（detectEntityHints → 审批）后由系统执行。`
      : `Agent 不得直接调用 ${toolName}：写入正式世界状态须经用户在 Proposal Review 通道确认后由系统执行。`,
    retryable: false,
    correctionHint: isRegister
      ? '不要调用此工具。请改用 detect_entity_hints 工具：从正文/设定中提取实体（display_name + type_label），系统会创建候选实体草图供作者审批，审批确认后由系统注册到 Core。'
      : '不要调用此工具。请用自然语言告知用户"推演已完成，请确认是否提交"，等待用户确认后由系统提交。',
  };
}

/**
 * 直接构造一个表示"禁止"的失败 ToolResult，供工具循环短路使用。
 *
 * 返回 success:false 分支——不携带 data，符合 ToolResult 失败变体契约。
 */
export function forbiddenToolResult(toolName: string): ToolResult<unknown> {
  return { success: false, error: makeForbiddenToolError(toolName) };
}

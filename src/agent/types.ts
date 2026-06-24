// =============================================================================
// NarrativeAgent 类型定义
// =============================================================================
// §5-§16: Agent 运行时状态、草案、计划、反思、Trace、授权等全部类型。
// 本文件位于 src/agent/ 层，不混入 src/core 或 src/types。
// =============================================================================

// ---------------------------------------------------------------------------
// 运行时状态（§5）
// ---------------------------------------------------------------------------

/**
 * NarrativeAgent 运行时状态
 *
 * 维持多轮会话的完整上下文：消息、草案、提案追踪、计划、失败计数、Trace 缓冲。
 */
export interface NarrativeAgentRuntimeState {
  projectId: string;
  sessionId: string;
  currentTurnId: string;
  /** 当前写作章节号（P0-1：Push 检索需要章节号构建 WritingContext） */
  currentChapter: number;
  messages: AgentMessage[];
  memoryState: AgentMemoryState;
  workingDraft?: AgentWorkingDraft;
  pendingProposalIds: string[];
  /**
   * @deprecated 当前未使用，写作层规划时决定是否启用动态计划功能。
   * 保留接口定义以保持向后兼容。
   */
  activePlan?: AgentPlan;
  toolFailureCounts: Record<string, number>;
  traceBuffer: AgentTraceRecord[];
  commitAuthority: CommitAuthority;
  status: AgentTurnStatus;
}

// ---------------------------------------------------------------------------
// 动态计划（§5）
// ---------------------------------------------------------------------------

/**
 * NarrativeAgent 动态计划摘要
 *
 * 只记录可审计的计划摘要，不记录完整隐藏推理链。
 * 计划可以被 LLM 在后续 Reason 阶段修改，Agent 只负责保存摘要、追踪状态和防止伪完成。
 */
export interface AgentPlan {
  goalSummary: string;
  steps: Array<{
    id: string;
    summary: string;
    status: 'pending' | 'running' | 'done' | 'blocked' | 'abandoned';
  }>;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// 记忆状态（§5）
// ---------------------------------------------------------------------------

/**
 * Agent 自身会话连续性记忆
 *
 * 不替代 Core。只服务于 Agent 自身的会话连续性：
 * 哪些消息已经压缩、当前上下文摘要是什么、哪些长期记忆需要注入下一轮 Reason。
 */
export interface AgentMemoryState {
  contextWindowSummary?: string;
  compressedUntilMessageId?: string;
  longTermMemoryRefs: string[];
  tokenBudgetEstimate?: number;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// 工作草案（§7）
// ---------------------------------------------------------------------------

export type AgentWorkingDraftStatus =
  | 'collecting'
  | 'revising'
  | 'proposed'
  | 'ready_to_commit'
  | 'committed'
  | 'abandoned';

/**
 * 多轮协商中的草案
 *
 * 它不是 Core Fact，也不是正式事件。
 * 可以跨多个 turn 保留，直到 committed、abandoned 或被新任务替换。
 */
export interface AgentWorkingDraft {
  id: string;
  status: AgentWorkingDraftStatus;
  summary: string;
  structuredIntent?: unknown;
  proposedFactChanges?: unknown[];
  proposalId?: string;
  revisionCount: number;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// 提交授权（§8）
// ---------------------------------------------------------------------------

/**
 * commit_event 授权等级
 *
 * 默认值：explicit_user_confirmation
 *
 * - explicit_user_confirmation：必须等用户明确确认后才能提交
 * - agent_authorized_for_task：当前任务内 Agent 可自动提交通过 Core 校验的定稿
 * - agent_authorized_for_session：当前会话内 Agent 可自动提交（主要用于 live 验证和自动化测试）
 */
export type CommitAuthority =
  | 'explicit_user_confirmation'
  | 'agent_authorized_for_task'
  | 'agent_authorized_for_session';

// ---------------------------------------------------------------------------
// 回合状态（§16）
// ---------------------------------------------------------------------------

/**
 * Agent 单次回合（turn）的状态
 */
export type AgentTurnStatus =
  | 'running'
  | 'completed'
  | 'needs_user_confirmation'
  | 'needs_user_input'
  | 'failed'
  | 'suspended';

// ---------------------------------------------------------------------------
// Agent 消息（§5 / §14.5）
// ---------------------------------------------------------------------------

/**
 * Agent 内部维护的消息
 *
 * 与 LLMClient 的 ChatMessage 兼容但多了 agent 层专用字段：
 * - id / turnId 用于持久化和追溯
 * - summary 用于快速审计
 * - compressed / visibleToLlm 用于上下文压缩管理
 */
export interface AgentMessage {
  id: string;
  projectId: string;
  sessionId: string;
  turnId?: string;
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  summary: string;
  toolCallId?: string;
  /** DeepSeek 思考模式：推理链内容，后续请求必须原样回传 */
  reasoningContent?: string;
  toolCalls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string; };
  }>;
  compressed: boolean;
  visibleToLlm: boolean;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// 失败反思（§10）
// ---------------------------------------------------------------------------

export type AgentNextAction =
  | 'retry_with_repaired_args'
  | 'call_different_tool'
  | 'refresh_context'
  | 'revise_draft'
  | 'ask_user'
  | 'abort_turn';

/**
 * 工具失败后的反思摘要
 *
 * 反思采用混合机制：确定性诊断 + LLM 语义修复。
 * Agent 先做确定性诊断（错误码、协议闭合、proposal/Fact 存在性、重复失败检测），
 * 再由 LLM 语义修复（修改方案、补充事件、重新组织 fact_changes）。
 */
export interface AgentFailureReflection {
  failedTool: string;
  errorCode?: string;
  summary: string;
  deterministicDiagnosis: string;
  nextAction: AgentNextAction;
  correctionHint?: string;
}

// ---------------------------------------------------------------------------
// 运行时安全护栏（§11）
// ---------------------------------------------------------------------------

/**
 * 运行时限制
 *
 * 这些限制不是业务限制，而是防止死循环和失控调用的安全阀。
 */
export interface NarrativeAgentRuntimeLimits {
  maxToolSteps: number;           // 默认 32
  maxRepeatedToolFailure: number; // 默认 3
  maxWallClockMs: number;         // 默认按运行环境配置
}

// ---------------------------------------------------------------------------
// Trace（§13）
// ---------------------------------------------------------------------------

export type AgentTraceStepType =
  | 'reason_summary'
  | 'action'
  | 'observation'
  | 'reflection_summary'
  | 'response_summary'
  | 'llm_call';  // LLM 调用的 token usage 记录（供 evals + /history）

export type AgentTraceStatus = 'ok' | 'warning' | 'error';

/**
 * ReAct Trace 记录
 *
 * 写入项目数据库，跟随项目移动、备份和复盘。
 * 只记录可审计摘要，不记录完整隐藏思维链。
 */
export interface AgentTraceRecord {
  id: string;
  projectId: string;
  sessionId: string;
  turnId: string;
  stepIndex: number;
  stepType: AgentTraceStepType;
  status: AgentTraceStatus;
  summary: string;
  detail?: unknown;
  toolName?: string;
  toolCallId?: string;
  proposalId?: string;
  eventId?: string;
  errorCode?: string;
  nextAction?: string;
  createdAt: string;
  /**
   * 本轮 LLM 调用的 token 用量（供 evals 成本统计 + /history 汇总）。
   * 仅 stepType='llm_call' 的 trace 记录填充，其他步骤为 undefined。
   */
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    prompt_cache_hit_tokens?: number;
  };
}

// ---------------------------------------------------------------------------
// 长期记忆（§14.7）
// ---------------------------------------------------------------------------

export type AgentMemoryKind =
  | 'user_preference'
  | 'project_decision'
  | 'agent_policy'
  | 'open_thread'
  | 'draft_pattern';

export type AgentMemoryStatus = 'active' | 'archived' | 'superseded';

/**
 * 跨会话长期记忆
 *
 * 只保存 Agent 与项目协作层面的记忆，不是世界状态事实。
 * 关于角色、地点、事件、知识可见性的正式状态仍必须写入 Core。
 */
export interface AgentLongTermMemory {
  id: string;
  projectId: string;
  kind: AgentMemoryKind;
  summary: string;
  detail: unknown;
  sourceSessionId?: string;
  sourceTurnId?: string;
  confidence: number;
  status: AgentMemoryStatus;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// 上下文压缩（§14.6 / §15）
// ---------------------------------------------------------------------------

/**
 * 自动上下文压缩结果
 *
 * 它是 Agent 的工作记忆摘要，不是 Core 世界事实。
 */
export interface AgentContextSummary {
  id: string;
  projectId: string;
  sessionId: string;
  fromMessageId: string;
  toMessageId: string;
  summary: string;
  keyDecisions: string[];
  openQuestions: string[];
  draftRefs: string[];
  tokenEstimate?: number;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// 意图枚举（§6）
// ---------------------------------------------------------------------------

/**
 * 用户意图枚举
 *
 * NarrativeAgent 每轮收到用户输入后，先判断这句话在当前会话中的作用。
 */
export type UserIntent =
  | 'new_content'           // 新增设定/事件
  | 'revise_draft'          // 修改现有草案
  | 'query_state'           // 询问当前状态
  | 'request_simulation'    // 要求推演
  | 'confirm_commit'        // 明确确认提交
  | 'reject_draft'          // 否定/不满意
  | 'ambiguous'             // 信息不足
  | 'needs_user_input'      // Agent 需要向用户提问
  | 'chat';                 // 纯文本闲聊

// ---------------------------------------------------------------------------
// 生命周期钩子（P0-3）
// ---------------------------------------------------------------------------

/**
 * Agent 生命周期回调
 *
 * 写作层通过这些钩子感知 Agent 内部状态变化，驱动 UI 更新。
 * 所有回调均为可选——不传入时 Agent 正常运行，只是不通知外部。
 */
export interface AgentCallbacks {
  /** 草案状态变化（collecting → proposed → ready_to_commit → committed） */
  onDraftChange?: (draft: AgentWorkingDraft) => void;
  /** propose_event 成功，返回 proposalId 和推演报告 Markdown */
  onProposalCreated?: (proposalId: string, report: string) => void;
  /** commit_event 成功，返回 eventId 和写入的 Fact 数量 */
  onCommitComplete?: (eventId: string, factCount: number) => void;
  /** Push 检索注入 LLM 上下文，返回注入的相关 Fact 数量 */
  onRetrievalInjected?: (factCount: number) => void;
  /** Agent 遇到错误（工具失败、致命错误等），返回错误类型、消息和 turnId */
  onError?: (errorType: string, message: string, turnId: string) => void;
}

// ---------------------------------------------------------------------------
// 关键词配置（P1-6）
// ---------------------------------------------------------------------------

/**
 * 用户确认/协商识别关键词
 *
 * 写作层可按需覆盖默认的中文关键词列表（如支持英文界面）。
 */
export interface AgentKeywordConfig {
  /** 明确确认提交的关键词（合并到默认列表） */
  confirm?: string[];
  /** 继续协商的关键词（合并到默认列表） */
  revise?: string[];
}

// ---------------------------------------------------------------------------
// 默认值
// ---------------------------------------------------------------------------

export const DEFAULT_RUNTIME_LIMITS: NarrativeAgentRuntimeLimits = {
  maxToolSteps: 32,
  maxRepeatedToolFailure: 3,
  maxWallClockMs: 30 * 60 * 1000, // 30 分钟
};

export const DEFAULT_COMMIT_AUTHORITY: CommitAuthority = 'explicit_user_confirmation';

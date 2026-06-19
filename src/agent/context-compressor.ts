// =============================================================================
// ContextCompressor — 自动上下文压缩
// =============================================================================
// §15：NarrativeAgent 必须具备自动上下文压缩能力，否则多轮协商会被模型
// 上下文窗口限制。
//
// 压缩不是删除。完整消息原文仍保留在 agent_messages.content，只是默认
// 不再全量进入 LLM 上下文。
//
// v0.1 实现：基于规则的关键信息提取（无需 LLM），后续可升级为 LLM 摘要。
// =============================================================================

import type { SQLiteAgentStoreAdapter } from '../adapters/sqlite/agent-store.js';
import type { AgentMessage, AgentContextSummary, AgentWorkingDraft } from './types.js';
import type { MessageRow } from '../adapters/sqlite/agent-store.js';

export interface CompressionResult {
  summaryId: string;
  compressedMessageCount: number;
  summary: AgentContextSummary;
}

/**
 * 上下文压缩触发条件
 */
export interface CompressionTrigger {
  /** 消息数量超过此阈值触发压缩 */
  messageCountThreshold: number;
  /** token 估算超过此预算触发压缩（简化版按字符估算） */
  tokenBudget: number;
}

const DEFAULT_TRIGGER: CompressionTrigger = {
  messageCountThreshold: 30,
  tokenBudget: 8000,
};

/**
 * 估算消息列表的 token 消耗（中文场景：约 1.5 字符/token）
 *
 * 用于 Agent 在 buildLlmMessages 后更新 memoryState.tokenBudgetEstimate，
 * 以及 ContextCompressor 的压缩触发判断。
 * 接受任何包含 content: string 的消息类型（AgentMessage 或 ChatMessage）。
 */
export function estimateTokens(messages: Array<{ content?: string }>): number {
  const totalChars = messages.reduce((sum, m) => sum + (m.content?.length ?? 0), 0);
  return Math.round(totalChars / 1.5);
}

/**
 * ContextCompressor
 *
 * 负责选择可压缩消息范围、生成摘要、标记压缩状态。
 */
export class ContextCompressor {
  private agentStore: SQLiteAgentStoreAdapter;
  private trigger: CompressionTrigger;

  constructor(agentStore: SQLiteAgentStoreAdapter, trigger?: Partial<CompressionTrigger>) {
    this.agentStore = agentStore;
    this.trigger = { ...DEFAULT_TRIGGER, ...trigger };
  }

  /**
   * 检查是否需要压缩，需要则执行
   *
   * @param sessionId 会话 ID
   * @param messages  当前消息列表（用于字符估算）
   * @param draft     当前工作草案（可选，用于提取决策要点）
   * @returns 压缩结果，或 undefined 如果无需压缩
   */
  maybeCompress(
    sessionId: string,
    messages: AgentMessage[],
    draft?: AgentWorkingDraft,
  ): CompressionResult | undefined {
    // 检查触发条件
    if (!this.shouldCompress(messages)) {
      return undefined;
    }

    return this.executeCompression(sessionId, messages, draft);
  }

  /**
   * 判断是否需要压缩
   */
  private shouldCompress(messages: AgentMessage[]): boolean {
    // 条件 1：消息数量超过阈值
    if (messages.length >= this.trigger.messageCountThreshold) {
      return true;
    }

    // 条件 2：token 估算超过预算（中文约 1.5 字符/token）
    const tokenEstimate = estimateTokens(messages);
    if (tokenEstimate >= this.trigger.tokenBudget) {
      return true;
    }

    return false;
  }

  /**
   * 执行压缩
   *
   * 策略：压缩 earliest 到 latest-5 的消息范围（保留最近 5 条不压缩），
   * 提取关键信息生成摘要。
   */
  private executeCompression(
    sessionId: string,
    messages: AgentMessage[],
    draft?: AgentWorkingDraft,
  ): CompressionResult | undefined {
    // 找到可压缩的范围：跳过已压缩的和最近的 5 条
    const compressible = messages.filter(m => !m.compressed);
    const keepRecent = 5;

    if (compressible.length <= keepRecent) {
      // 不够压缩的
      const firstUncompressed = messages.find(m => !m.compressed);
      if (!firstUncompressed) {
        // 全部已压缩，无需操作
        return undefined;
      }
    }

    const toCompress = compressible.slice(0, Math.max(0, compressible.length - keepRecent));
    if (toCompress.length === 0) {
      return undefined;
    }

    const firstMsg = toCompress[0]!;
    const lastMsg = toCompress[toCompress.length - 1]!;

    // 提取关键信息
    const keyDecisions = this.extractKeyDecisions(toCompress, draft);
    const openQuestions = this.extractOpenQuestions(toCompress);
    const summary = this.generateSummary(toCompress, draft, keyDecisions, openQuestions);

    // 写入上下文摘要记录
    const summaryId = this.agentStore.addContextSummary({
      projectId: firstMsg.projectId,
      sessionId,
      fromMessageId: firstMsg.id,
      toMessageId: lastMsg.id,
      summary,
      keyDecisions,
      openQuestions,
      draftRefs: draft ? [draft.id] : [],
      tokenEstimate: estimateTokens(toCompress),
    });

    // 标记原消息为已压缩（DB + 内存双写，确保 buildLlmMessages 立刻生效）
    const msgIds = toCompress.map(m => m.id);
    this.agentStore.markMessagesCompressed(msgIds);
    // 同时更新内存中的消息状态（Agent 的 buildLlmMessages 直接读取内存数组）
    for (const m of toCompress) {
      m.compressed = true;
      m.visibleToLlm = false;
    }

    return {
      summaryId,
      compressedMessageCount: toCompress.length,
      summary: {
        id: summaryId,
        projectId: firstMsg.projectId,
        sessionId,
        fromMessageId: firstMsg.id,
        toMessageId: lastMsg.id,
        summary,
        keyDecisions,
        openQuestions,
        draftRefs: draft ? [draft.id] : [],
        tokenEstimate: estimateTokens(toCompress),
        createdAt: new Date().toISOString(),
      },
    };
  }

  /**
   * 生成摘要文本
   */
  private generateSummary(
    messages: AgentMessage[],
    draft: AgentWorkingDraft | undefined,
    keyDecisions: string[],
    openQuestions: string[],
  ): string {
    const parts: string[] = [];

    // 对话概述
    const userMsgs = messages.filter(m => m.role === 'user');
    const assistantMsgs = messages.filter(m => m.role === 'assistant');
    const toolMsgs = messages.filter(m => m.role === 'tool');

    parts.push(`用户发言 ${userMsgs.length} 次，Agent 回复 ${assistantMsgs.length} 次，工具调用 ${toolMsgs.length} 次。`);

    // 用户发言摘要（取前 3 条和后 2 条的关键信息）
    if (userMsgs.length > 0) {
      const summaries = userMsgs.map(m => m.summary);
      if (summaries.length <= 5) {
        parts.push(`用户表达了：${summaries.join('；')}`);
      } else {
        parts.push(`用户最初表达了：${summaries.slice(0, 3).join('；')}`);
        parts.push(`后续表达了：${summaries.slice(-2).join('；')}`);
      }
    }

    // 草案状态
    if (draft) {
      parts.push(`工作草案：${draft.summary}（状态：${draft.status}，修订 ${draft.revisionCount} 次）`);
    }

    // 关键决策
    if (keyDecisions.length > 0) {
      parts.push(`关键决策：${keyDecisions.join('；')}`);
    }

    // 未解决问题
    if (openQuestions.length > 0) {
      parts.push(`待确认事项：${openQuestions.join('；')}`);
    }

    return parts.join('\n');
  }

  /**
   * 从消息中提取关键决策
   */
  private extractKeyDecisions(
    messages: AgentMessage[],
    draft: AgentWorkingDraft | undefined,
  ): string[] {
    const decisions: string[] = [];

    // 从 draft 中提取
    if (draft && draft.status !== 'collecting') {
      decisions.push(`草案 "${draft.summary}" 已进入 ${draft.status} 状态`);
    }

    // 从 assistant 回复中提取包含"已确认"/"决定"的摘要
    for (const msg of messages) {
      if (msg.role === 'assistant') {
        const lower = msg.summary.toLowerCase();
        if (lower.includes('确认') || lower.includes('决定') || lower.includes('通过')) {
          decisions.push(msg.summary);
        }
      }
    }

    return decisions.slice(0, 10); // 最多 10 条
  }

  /**
   * 从消息中提取未解决问题
   */
  private extractOpenQuestions(messages: AgentMessage[]): string[] {
    const questions: string[] = [];

    for (const msg of messages) {
      if (msg.role === 'assistant') {
        // 一条摘要可能同时含问号与"确认/等待"——只 push 一次，避免重复占用名额
        const isQuestion = msg.summary.includes('？') || msg.summary.includes('?');
        const isConfirmation = msg.summary.includes('确认') || msg.summary.includes('等待');
        if (isQuestion || isConfirmation) {
          questions.push(msg.summary);
        }
      }
      if (msg.role === 'user' && msg.content.includes('？')) {
        // 用户问句摘要
        questions.push(msg.summary);
      }
    }

    return questions.slice(0, 10); // 最多 10 条
  }
}

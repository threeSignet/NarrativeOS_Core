// =============================================================================
// MemoryManager — 跨会话长期记忆管理
// =============================================================================
// §15：长期记忆只记录协作偏好和项目决策，不替代 Core Fact。
//
// 原则：
//   - 长期记忆不能替代 Core Fact
//   - 关于角色、地点、事件、知识可见性的正式状态仍必须写入 Core
//   - 长期记忆只保存"用户如何希望 Agent 协作"和"项目协作层面的已确认决策"
//   - 写入必须保守：临时想法、未确认草案、模型猜测不得写成长久记忆
//   - 读取时按相关性筛选，不能无脑全量注入
//
// v0.1 实现：基于规则的候选识别（无需 LLM），后续可升级为 LLM 语义提取。
// =============================================================================

import type { SQLiteAgentStoreAdapter } from '../adapters/sqlite/agent-store.js';
import type {
  AgentLongTermMemory,
  AgentMemoryKind,
  AgentMemoryStatus,
  AgentWorkingDraft,
} from './types.js';

export interface MemoryExtractionResult {
  added: AgentLongTermMemory[];
  archived: number;
}

/**
 * MemoryManager
 *
 * 负责跨会话长期记忆的提取、写入、读取和归档。
 */
export class MemoryManager {
  private agentStore: SQLiteAgentStoreAdapter;
  private projectId: string;

  constructor(agentStore: SQLiteAgentStoreAdapter, projectId: string) {
    this.agentStore = agentStore;
    this.projectId = projectId;
  }

  // =========================================================================
  // 读取
  // =========================================================================

  /**
   * 获取指定类型的所有活跃长期记忆
   *
   * @param kind 记忆类型（可选，省略则返回所有类型）
   */
  getActiveMemories(kind?: AgentMemoryKind): AgentLongTermMemory[] {
    const rows = this.agentStore.getActiveMemories(this.projectId, kind);
    return rows.map(row => ({
      id: row.id,
      projectId: row.project_id,
      kind: row.kind as AgentMemoryKind,
      summary: row.summary,
      detail: safeJsonParse(row.detail_json),
      sourceSessionId: row.source_session_id ?? undefined,
      sourceTurnId: row.source_turn_id ?? undefined,
      confidence: row.confidence,
      status: row.status as AgentMemoryStatus,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  /**
   * 获取所有类型记忆的平铺摘要（供 LLM 注入使用）
   */
  getMemorySummaryForLlm(): string {
    const memories = this.getActiveMemories();
    if (memories.length === 0) return '';

    const byKind = new Map<AgentMemoryKind, string[]>();
    for (const m of memories) {
      const list = byKind.get(m.kind) || [];
      list.push(m.summary);
      byKind.set(m.kind, list);
    }

    const parts: string[] = [];
    const kindLabels: Record<AgentMemoryKind, string> = {
      user_preference: '用户偏好',
      project_decision: '项目决策',
      agent_policy: 'Agent 授权',
      open_thread: '未完成事项',
      draft_pattern: '草案习惯',
    };

    for (const [kind, summaries] of byKind) {
      parts.push(`【${kindLabels[kind] || kind}】`);
      parts.push(summaries.map((s, i) => `${i + 1}. ${s}`).join('\n'));
    }

    return parts.join('\n\n');
  }

  /**
   * 判断是否存在特定类型的记忆（防止重复写入）
   */
  hasMemory(kind: AgentMemoryKind, summaryFingerprint: string): boolean {
    const memories = this.agentStore.getActiveMemories(this.projectId, kind);
    return memories.some(m => m.summary.includes(summaryFingerprint));
  }

  // =========================================================================
  // 写入
  // =========================================================================

  /**
   * 写入一条长期记忆
   *
   * @param kind      记忆类型
   * @param summary   摘要（去重依据）
   * @param detail    详细数据（可选）
   * @param options   可选参数（来源会话/回合、确信度）
   * @returns 记忆 ID，或 undefined 如果已存在相同摘要
   */
  addMemory(
    kind: AgentMemoryKind,
    summary: string,
    detail?: unknown,
    options?: {
      sourceSessionId?: string;
      sourceTurnId?: string;
      confidence?: number;
    },
  ): string | undefined {
    // 防止重复：同类型 + 包含相同摘要片段的记忆不重复写入
    if (this.hasMemory(kind, summary.slice(0, 40))) {
      return undefined;
    }

    const id = this.agentStore.addMemory({
      projectId: this.projectId,
      kind,
      summary,
      detail,
      sourceSessionId: options?.sourceSessionId,
      sourceTurnId: options?.sourceTurnId,
      confidence: options?.confidence ?? 1.0,
      status: 'active',
    });

    return id;
  }

  /**
   * 从已完成的工作草案中提取项目决策记忆
   */
  extractFromCompletedDraft(
    draft: AgentWorkingDraft,
    sessionId: string,
    turnId: string,
  ): MemoryExtractionResult {
    const result: MemoryExtractionResult = { added: [], archived: 0 };

    if (draft.status !== 'committed') return result;

    // 只有已提交的草案才值得记住
    const id = this.addMemory(
      'project_decision',
      `已确认的事件：${draft.summary}`,
      { draftId: draft.id, revisionCount: draft.revisionCount },
      { sourceSessionId: sessionId, sourceTurnId: turnId, confidence: 1.0 },
    );

    if (id) {
      result.added.push({
        id,
        projectId: this.projectId,
        kind: 'project_decision',
        summary: `已确认的事件：${draft.summary}`,
        detail: { draftId: draft.id, revisionCount: draft.revisionCount },
        sourceSessionId: sessionId,
        sourceTurnId: turnId,
        confidence: 1.0,
        status: 'active',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }

    return result;
  }

  /**
   * 从用户输入中提取偏好记忆
   *
   * 保守策略：只有包含明确偏好的用户消息才记录
   */
  extractPreference(
    userInput: string,
    sessionId: string,
    turnId: string,
  ): MemoryExtractionResult {
    const result: MemoryExtractionResult = { added: [], archived: 0 };
    const trimmed = userInput.trim();

    // 保守策略：只有包含以下模式才记录偏好
    const preferencePatterns = [
      /我(喜欢|偏好|习惯|想要|希望)(.*)/i,
      /以后(都|就|尽量)(.*)/i,
      /不要(再|总是)(.*)/i,
      /请(务必|一定|不要)(.*)/i,
    ];

    let matched = false;
    let preferenceSummary = '';

    for (const pattern of preferencePatterns) {
      const match = trimmed.match(pattern);
      if (match) {
        preferenceSummary = `用户偏好：${match[0]}`;
        matched = true;
        break;
      }
    }

    if (!matched) return result;

    const id = this.addMemory(
      'user_preference',
      preferenceSummary,
      { rawInput: trimmed },
      { sourceSessionId: sessionId, sourceTurnId: turnId, confidence: 0.7 },
    );

    if (id) {
      result.added.push({
        id,
        projectId: this.projectId,
        kind: 'user_preference',
        summary: preferenceSummary,
        detail: { rawInput: trimmed },
        sourceSessionId: sessionId,
        sourceTurnId: turnId,
        confidence: 0.7,
        status: 'active',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }

    return result;
  }

  // =========================================================================
  // 维护
  // =========================================================================

  /**
   * 归档特定类型的记忆
   *
   * @param kind 要归档的记忆类型
   * @param olderThanDays 超过此天数的记忆被归档
   */
  archiveOldMemories(kind: AgentMemoryKind, olderThanDays: number = 30): number {
    const memories = this.agentStore.getActiveMemories(this.projectId, kind);
    const now = Date.now();
    let archived = 0;

    for (const m of memories) {
      const created = new Date(m.created_at).getTime();
      if (now - created > olderThanDays * 24 * 60 * 60 * 1000) {
        this.agentStore.archiveMemory(m.id);
        archived++;
      }
    }

    return archived;
  }

  /**
   * 废弃被替代的相同类型记忆
   */
  supersedeMemories(kind: AgentMemoryKind, keepCount: number = 5): number {
    const memories = this.agentStore.getActiveMemories(this.projectId, kind);
    if (memories.length <= keepCount) return 0;

    // 按创建时间排序，保留最新的 keepCount 条
    const sorted = memories.sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    );
    let archived = 0;

    for (let i = keepCount; i < sorted.length; i++) {
      this.agentStore.archiveMemory(sorted[i]!.id);
      archived++;
    }

    return archived;
  }
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

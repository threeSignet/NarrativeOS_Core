// =============================================================================
// WritingRequestContext — 写作层服务通用上下文
// =============================================================================
// 所有服务接口的第一个参数。保证项目、作者、来源、触发方式和权限边界可追踪。
//
// 设计要点：
//   - trigger 区分操作来源（author_action / agent_suggestion / ...）
//   - visibilityMode 控制 ViewModel 是否展示技术字段
//   - requestId 用于幂等和追踪（调试视图可见）
//   - 普通作者视图不展示 requestId、sessionId、内部 ID
//
// 对应设计文档：Phase7-Refinement.md §7.1
// =============================================================================

import type { SourceRef } from '../models/source-ref.js';

/**
 * 触发来源——谁发起了这个操作
 *
 * 与 WritingAuditLog.AuditTrigger 对齐，用于审计追踪。
 */
export type WritingTrigger =
  | 'author_action'          // 作者主动操作
  | 'agent_suggestion'       // 智能体建议后作者确认
  | 'editor_cursor_feedback' // 光标反馈触发（后续）
  | 'draft_conversion'       // 草案转候选或提案
  | 'import_analysis'        // 导入分析触发（后续）
  | 'review_decision'        // 审核页决策
  | 'system_recovery';       // 失败恢复或重试

/**
 * 写作层服务通用请求上下文
 *
 * 每个 Command/Query 方法都接收此上下文作为第一个参数。
 * Agent 调用服务时，trigger 为 'agent_suggestion'；
 * CLI 确认通道调用时，trigger 为 'review_decision' 或 'author_action'。
 */
export interface WritingRequestContext {
  /** 当前作品项目 ID */
  projectId: string;
  /** 当前作者标识 */
  authorId: string;
  /** 当前写作会话 ID */
  sessionId: string;
  /** 触发来源 */
  trigger: WritingTrigger;
  /** 来源引用（谁触发了这个操作，追溯证据链） */
  sourceRefs: SourceRef[];
  /** 幂等和追踪 ID */
  requestId: string;
  /** 'normal' | 'debug' — 决定 ViewModel 是否展示技术字段 */
  visibilityMode: 'normal' | 'debug';
}

/**
 * 创建最小请求上下文（便捷工厂）
 *
 * 用于测试和简单调用场景。生产环境应由 Agent 或 CLI 通道显式构建完整上下文。
 */
export function makeRequestContext(partial: {
  projectId: string;
  authorId?: string;
  sessionId?: string;
  trigger?: WritingTrigger;
  sourceRefs?: SourceRef[];
  visibilityMode?: 'normal' | 'debug';
}): WritingRequestContext {
  return {
    projectId: partial.projectId,
    authorId: partial.authorId ?? 'default',
    sessionId: partial.sessionId ?? `session_${Date.now()}`,
    trigger: partial.trigger ?? 'author_action',
    sourceRefs: partial.sourceRefs ?? [],
    requestId: `req_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    visibilityMode: partial.visibilityMode ?? 'normal',
  };
}

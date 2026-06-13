// =============================================================================
// SourceRef — 写作层来源引用模型
// =============================================================================
// 每个写作层对象都必须能追溯来源——这个设定是从哪个灵感、草案、正文
// 或对话中产生的。来源引用是写作层审计和追溯的核心机制。
//
// 设计要点：
//   - 结构简单：kind + id + excerpt，不需要独立表
//   - 存储在对象的 source_refs_json 字段中
//   - SourceRef 不等于 Core Fact/Event——它只是"这个写作层对象从哪来"
//   - 与 Feature Spec §4.3 BlueprintSourceRef 对齐
// =============================================================================

/**
 * 来源引用——每个写作层对象都必须能追溯来源
 *
 * 存储在 writing_* 表的 source_refs_json 字段中（JSON 数组）。
 * SourceRef 不是 Core 状态，只是写作层内部的证据链。
 */
export interface SourceRef {
  /** 来源类型 */
  kind: SourceRefKind;
  /** 来源对象 ID（IdeaCard、WritingDraft、ProposalView 等的 ID） */
  id: string;
  /** 来源原文摘录（可选，用于前端展示"这条设定来自这段文字"） */
  excerpt?: string;
}

/**
 * 来源类型枚举
 *
 * 与 Feature Spec §4.3 BlueprintSourceRef + §33.2 trigger 对齐
 */
export type SourceRefKind =
  | 'idea'               // 来自灵感卡
  | 'draft'              // 来自草案
  | 'prose'              // 来自正文
  | 'proposal'           // 来自提案
  | 'user_decision'      // 来自作者决策
  | 'agent_observation'  // 来自智能体观察
  | 'import'             // 来自导入
  | 'chat';              // 来自对话

/**
 * 带来源引用的对象通用字段
 *
 * 所有写作层领域对象都应实现此接口。
 * 在 WritingStore 中通过 source_refs_json 字段持久化。
 */
export interface SourceTracked {
  sourceRefs: SourceRef[];
}

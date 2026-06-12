// =============================================================================
// Knowledge 知识可见性类型
// =============================================================================
// §7: KnowledgeSource / Knowledge / KnowledgeChangeInput

/**
 * 知识来源：角色获取这条知识的途径
 *
 * 分为四个梯队：
 *   第一梯队（写入时自动推导）：self_action / witnessed / faction_share
 *   第二梯队（需要独立事件触发）：informed / intelligence
 *   第三梯队（间接/不确定）：inferred / rumor / revelation
 *   第四梯队（认知层事件驱动）：memory_seal / memory_decay / memory_restore / implanted
 */
export type KnowledgeSource =
  // 第一梯队：写入时自动推导（Propagation Rules 产出）
  | 'self_action'        // 亲身经历：事件主体自动知晓（confidence 通常为 1.0）
  | 'witnessed'          // 直接目击：与事件主体同场景的实体自动知晓
  | 'faction_share'      // 组织共享：事件属于某阵营公开秘密，向成员广播
  // 第二梯队：需要独立事件触发
  | 'informed'           // 被告知：通过对话、信件、报告等主动传递
  | 'intelligence'       // 情报获取：通过占卜、监控、间谍等手段获取
  // 第三梯队：间接/不确定
  | 'inferred'           // 推断：角色根据已知信息逻辑推理得出
  | 'rumor'              // 传闻：通过非正式渠道获得的二手信息
  | 'revelation'         // 启示：通过超自然手段获得（奇幻/仙侠设定）
  // 第四梯队：认知层事件驱动
  | 'memory_seal'        // 记忆封印：confidence 被压至 0.0
  | 'memory_decay'       // 记忆衰退：confidence 按时间衰减公式降低
  | 'memory_restore'     // 记忆恢复：从封印状态恢复
  | 'implanted';          // 记忆植入：confidence 正常但内容可能为假

/**
 * Knowledge：角色对某条 Fact 的认知记录
 *
 * 与 Fact 的关系：Knowledge 不是 Fact 的修改，而是 Fact 之上的认知层。
 * 一条 Fact 可以被 0 个实体知晓（秘密），也可以被所有实体知晓（公开信息）。
 *
 * 硬边界：Knowledge 回答"实体 X 是否接触过 Fact Y，通过什么渠道，确信度多少？"
 * 不回答"是否真心相信"（Belief）、"认为别人怎么看"（Theory of Mind）。
 */
export interface Knowledge {
  id: string;              // 'kno_{knower}_{factSeq}'
  factId: string;          // 被知晓的 Fact ID
  entityId: string;        // 知晓者实体 ID（如 'ent_claine'）
  knownSince: number;      // 从哪个章节开始知道（支持小数编号）
  source: KnowledgeSource; // 知识来源
  confidence: number;      // 确信度 0.0-1.0
  previousConfidence?: number; // seal 操作前的 confidence 值，用于 restore 恢复
  updatedAtEvent?: string; // 最后更新此知识的事件 ID
}

/**
 * Knowledge 显式操作输入（由 propose_event 中的 knowledge_changes 驱动）
 *
 * LLM 不直接操作 Knowledge 表，而是通过事件间接触发。
 * Core 内部永远不 DELETE knowledge 表中的记录，只 INSERT 新记录。
 */
export interface KnowledgeChangeInput {
  op: 'seal' | 'restore' | 'decay' | 'soul_read' | 'implant';
  target_entity_id: string;          // 被操作的目标实体（如被搜魂者）
  fact_id_scope: 'all' | 'by_predicate' | 'by_time_range' | 'explicit';
  fact_ids?: string[];               // scope = explicit 时指定
  predicates?: string[];             // scope = by_predicate 时指定
  time_range?: { from: number; to: number }; // scope = by_time_range 时指定
  source_entity_id?: string;         // op = soul_read 时：施法者（获得知识的一方）
  implanted_confidence?: number;     // op = implant 时：植入的确信度
}

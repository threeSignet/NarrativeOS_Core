// =============================================================================
// NarrativeEvent 叙事事件类型
// =============================================================================
// §8: EventKindFilter / NarrativeEvent

/**
 * 事件类型过滤
 */
export type EventKindFilter = 'business' | 'system' | 'all';

/**
 * NarrativeEvent：世界状态变更的唯一入口
 *
 * 核心原理：事件发生 → 改变世界状态 → 影响角色认知。
 * 每个 NarrativeEvent 同时改变客观世界状态和角色认知状态（双流写入）。
 */
export interface NarrativeEvent {
  id: string;                // 'evt_{type}_{chapter}[_{seq}]'
  kind: 'business' | 'system'; // business=剧情事件；system=Retcon/Schema 等审计锚点
  type: string;              // 事件类型，如 'tribulation' | 'ancient_encounter'
  chapter: number;           // 叙事章节（支持小数编号，DDL 列类型为 REAL）
  params: Record<string, unknown>;  // 事件参数，subject/target_event_id 等
  context: string;           // 事件发生的作用域，默认 'global'
  description: string;       // 自然语言摘要
  timestamp: string;         // 系统时间 ISO 8601（作者何时写的）
  factGroupId: string;       // 关联的 FactGroup ID（与事件 ID 相同，1:1）
  resolvedThreads: string[];  // 此事件关闭的 NarrativeThread ID 列表
  dependentFactIds: string[]; // 事件级依赖边的冗余快照，查询以 event_dependencies 表为准
}

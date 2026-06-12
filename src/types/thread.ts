// =============================================================================
// NarrativeThread 叙事线索类型
// =============================================================================
// §6: ThreadDirection / ThreadType / ThreadStatus / ThreadMilestone / NarrativeThread

/** 线索方向：回溯型（先写结果后补原因）还是渐进型（先埋种子后开花） */
export type ThreadDirection = 'retroactive' | 'progressive';

/** 线索类型 */
export type ThreadType =
  // 回溯型（原 Cost 类别）
  | 'causal_gap'           // 因果缺口：先写了结果，后需要补原因
  | 'timeline_perturbation' // 时间线扰动
  | 'rule_violation'       // 规则违反
  | 'logic_conflict'       // 逻辑矛盾
  // 渐进型（原 Foreshadowing 类别）
  | 'foreshadowing'        // 伏笔：预先埋下的线索或暗示
  | 'mystery'              // 谜团：尚未揭示的真相
  | 'prophecy'             // 预言：未来必然发生的事件
  | 'promise'              // 承诺：角色间或对读者的叙事期待
  | 'pattern';             // 模式：重复出现的规律等待最终解释

/** 线索状态 */
export type ThreadStatus =
  // 回溯型路径
  | 'UNFILLED'             // 结果已写，原因待补
  | 'FILLED'               // 原因已补完
  // 渐进型路径
  | 'PLANTED'              // 种子已埋下
  | 'HINTED'               // 再次暗示（可多次）
  | 'PARTIALLY_REVEALED'   // 部分揭示
  | 'RESOLVED'             // 完全回收/揭示
  // 共享终态
  | 'ABANDONED'            // 作者显式放弃
  | 'OBSOLETE';            // 上游依赖断裂

/** 叙事线索生命周期里程碑 */
export interface ThreadMilestone {
  id: string;
  status: ThreadStatus;
  chapter: number;
  eventId?: string;
  description: string;
  createdAt: string;       // ISO 8601
}

/**
 * NarrativeThread：统一追踪两类叙事承诺
 *
 * 设计意图：Cost 和 Foreshadowing 本质都是"对读者的叙事承诺，等待被兑现"。
 * 统一为 NarrativeThread 后，同一条线索可以同时是伏笔和规则违反。
 *
 * I-9 不变式（Thread Never Has Causal Power）：
 *   Thread 是 Fact 的观察层，不是世界状态的来源。
 *   - ✅ 允许：Fact/Event → Thread
 *   - ❌ 禁止：Thread → Fact / Thread → Knowledge
 */
export interface NarrativeThread {
  id: string;              // 'thr_{tag}_{chapter}[_{seq}]'
  type: ThreadType;
  direction: ThreadDirection;
  severity: 'minor' | 'major' | 'critical';
  description: string;

  closeCondition: {
    requiredEventType?: string;
    withinChapters?: number;
    customRule?: string;
    minHints?: number;     // 渐进型：至少暗示几次才能揭示
  };

  status: ThreadStatus;
  closedBy: string | null;
  createdAtEvent: string;
  createdAtChapter: number;
  milestones: ThreadMilestone[];
  relatedEntities: string[];   // 关联实体 ID 列表
  upstreamFactIds: string[];   // 上游依赖的 Fact ID 列表，用于 OBSOLETE 检测
  tags?: string[];             // 自由标签（如 ['side_arc', 'humor']）
  arcTag?: string;             // 关联的作用域名称（可选），用于主线写作时排除副本线索
}

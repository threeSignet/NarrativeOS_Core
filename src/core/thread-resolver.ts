// =============================================================================
// ThreadResolver —— 叙事线索生命周期判定引擎
// =============================================================================
// Phase 2B 核心产出：实现四个判定方法 + 状态转换校验。
//
// 设计原则：
//   - I-9 不变式：ThreadResolver 只做判定，不调用 FactStore.applyFactGroup、
//     KnowledgeStore 写入方法或 ThreadStore 写入方法。实际持久化由调用方
//     （ProposalManager.commitEvent / Tool 6 resolve_thread）负责。
//   - 纯逻辑组件：所有方法接收已加载的 NarrativeThread[]，不直接查询数据库。
//   - 双通道关闭：自动通道（closeCondition 匹配）+ 显式通道（作者声明）。
//
// 与架构文档的对应关系：
//   §6.1  ThreadResolver 接口 → resolveThreads / getExpiringThreads / getHintableThreads
//   §6.2  关闭判定逻辑       → isThreadClosable（closeCondition 各字段逐项检查）
//   §6.2.1 双通道关闭机制    → resolveThreads 内的通道一 + 通道二合并
//   §6.3  状态机             → validateTransition（回溯型 + 渐进型合法路径）
// =============================================================================

import type {
  NarrativeThread,
  NarrativeEvent,
  ThreadStatus,
  ThreadDirection,
} from '../types.js';

// =============================================================================
// 回开放状态集合（与 ThreadStore.getOpen() 保持一致）
// =============================================================================

const OPEN_STATUSES: ThreadStatus[] = ['UNFILLED', 'PLANTED', 'HINTED', 'PARTIALLY_REVEALED'];

/** 默认的过期预警窗口（章节数） */
const DEFAULT_WARNING_WINDOW = 5;

// =============================================================================
// 合法状态转换表
// =============================================================================

/**
 * 回溯型线索合法转换
 *
 * UNFILLED → FILLED    （自动/显式关闭）
 * UNFILLED → ABANDONED （作者显式放弃）
 * UNFILLED → OBSOLETE  （上游 Fact 被 Retcon 标记）
 * FILLED   → UNFILLED  （关闭事件被 Retcon 撤回）
 */
const RETROACTIVE_TRANSITIONS: Record<ThreadStatus, ThreadStatus[]> = {
  UNFILLED: ['FILLED', 'ABANDONED', 'OBSOLETE'],
  FILLED: ['UNFILLED'], // Retcon 撤回
  PLANTED: [],           // 回溯型不应进入此状态
  HINTED: [],
  PARTIALLY_REVEALED: [],
  RESOLVED: [],
  ABANDONED: [],
  OBSOLETE: [],
};

/**
 * 渐进型线索合法转换
 *
 * PLANTED  → HINTED    （暗示）
 * PLANTED  → RESOLVED  （直接回收）
 * HINTED   → HINTED    （多次暗示，追加 Milestone）
 * HINTED   → RESOLVED  （回收）
 * PARTIALLY_REVEALED → RESOLVED
 * 任意     → ABANDONED （作者放弃）
 * 任意     → OBSOLETE  （上游依赖断裂）
 */
const PROGRESSIVE_TRANSITIONS: Record<ThreadStatus, ThreadStatus[]> = {
  UNFILLED: [],           // 渐进型不应进入此状态
  FILLED: [],
  PLANTED: ['HINTED', 'RESOLVED', 'ABANDONED', 'OBSOLETE'],
  HINTED: ['HINTED', 'RESOLVED', 'ABANDONED', 'OBSOLETE'],
  PARTIALLY_REVEALED: ['RESOLVED', 'ABANDONED', 'OBSOLETE'],
  RESOLVED: [],
  ABANDONED: [],
  OBSOLETE: [],
};

// =============================================================================
// 关闭动作描述——调用方凭此操作 ThreadStore
// =============================================================================

/**
 * 线索关闭动作：描述 ThreadResolver 判定后需要对 ThreadStore 执行的具体操作。
 *
 * 调用方（ProposalManager.commitEvent）按此结构调用 ThreadStore.updateStatus /
 * addMilestone，ThreadResolver 本身不触碰存储层。
 */
export interface ThreadResolutionAction {
  threadId: string;
  oldStatus: ThreadStatus;
  newStatus: ThreadStatus;
  /** 关闭通道：auto（closeCondition 匹配）或 explicit（作者声明） */
  channel: 'auto' | 'explicit';
  /** 触发关闭的事件 ID（写入 Thread.closedBy） */
  closedByEventId: string;
  /** 是否需要追加里程碑（渐进型线索关闭时需要） */
  needsMilestone: boolean;
  /** 里程碑状态（needsMilestone=true 时使用） */
  milestoneStatus: ThreadStatus;
  /** 里程碑章节 */
  milestoneChapter: number;
  /** 里程碑描述 */
  milestoneDescription: string;
}

/**
 * resolveThreads 的完整返回值
 */
export interface ThreadResolutionResult {
  /** 被本次事件关闭的线索（与架构文档 §6.1 接口对齐） */
  resolved: NarrativeThread[];
  /** 仍未关闭的线索 */
  stillOpen: NarrativeThread[];
  /** 详细的关闭动作列表（供调用方操作 ThreadStore） */
  resolutions: ThreadResolutionAction[];
  /** 错误信息（如尝试关闭已关闭的线索） */
  errors: string[];
}

// =============================================================================
// ThreadResolver 实现
// =============================================================================

export class ThreadResolver {
  // -----------------------------------------------------------------------
  // 核心方法一：单个线索的可关闭判定（§6.2）
  // -----------------------------------------------------------------------

  /**
   * 判断一条线索是否可被给定事件自动关闭
   *
   * 逐项检查 closeCondition 的各字段：
   *   1. 状态资格（回溯型须 UNFILLED，渐进型须 PLANTED/HINTED/PARTIALLY_REVEALED）
   *   2. requiredEventType 匹配
   *   3. withinChapters 时限未过期
   *   4. minHints 渐进型暗示次数达标（PARTIALLY_REVEALED 跳过此检查）
   *   5. customRule → 固定返回 false（只能通过显式通道关闭）
   *
   * @returns true = 可自动关闭，false = 不可
   */
  isThreadClosable(thread: NarrativeThread, event: NarrativeEvent): boolean {
    // ---- 步骤 0: 方向 + 状态资格检查 ----

    if (thread.direction === 'retroactive') {
      // 回溯型：只有 UNFILLED 状态可被自动关闭
      if (thread.status !== 'UNFILLED') return false;
    } else {
      // 渐进型：PLANTED / HINTED / PARTIALLY_REVEALED 可被自动关闭
      if (thread.status !== 'PLANTED'
          && thread.status !== 'HINTED'
          && thread.status !== 'PARTIALLY_REVEALED') {
        return false;
      }
    }

    const { closeCondition } = thread;

    // ---- 步骤 1: 事件类型匹配 ----
    if (closeCondition.requiredEventType
        && event.type !== closeCondition.requiredEventType) {
      return false;
    }

    // ---- 步骤 2: 章节时限 ----
    if (closeCondition.withinChapters !== undefined) {
      const deadline = thread.createdAtChapter + closeCondition.withinChapters;
      if (event.chapter > deadline) {
        return false;
      }
    }

    // ---- 步骤 3: 渐进型最低暗示次数 ----
    // PARTIALLY_REVEALED 已隐含满足暗示要求，跳过此检查
    if (thread.direction === 'progressive'
        && thread.status !== 'PARTIALLY_REVEALED'
        && closeCondition.minHints !== undefined) {
      // hint_count 由 addMilestone 维护，直接读取
      const hintCount = this.countHints(thread);
      if (hintCount < closeCondition.minHints) {
        return false;
      }
    }

    // ---- 步骤 4: customRule → 只能显式关闭 ----
    if (closeCondition.customRule) {
      return false;
    }

    return true;
  }

  // -----------------------------------------------------------------------
  // 核心方法二：双通道关闭判定（§6.2.1）
  // -----------------------------------------------------------------------

  /**
   * 扫描所有未关闭线索，通过双通道判定哪些可被当前事件关闭
   *
   * 通道一（自动关闭）：遍历开放线索，isThreadClosable 匹配即关闭
   * 通道二（显式关闭）：作者在 thread_resolutions 中声明的线索直接关闭，
   *   跳过 closeCondition 检查，但仍需状态资格校验
   *
   * 两条通道互补不互斥——同一线索可能同时满足两个通道（去重后只执行一次）。
   *
   * @param newEvent      触发判定的新事件
   * @param allThreads    当前所有线索（通常来自 ThreadStore.getOpen()）
   * @param explicitResolutionIds  作者显式声明要关闭的线索 ID（来自 propose_event）
   */
  resolveThreads(
    newEvent: NarrativeEvent,
    allThreads: NarrativeThread[],
    explicitResolutionIds?: string[],
  ): ThreadResolutionResult {
    const autoResolved: NarrativeThread[] = [];
    const explicitlyResolved: NarrativeThread[] = [];
    const resolvedSet = new Set<string>();
    const resolutions: ThreadResolutionAction[] = [];
    const errors: string[] = [];

    // ---- 通道一：自动关闭 ----
    for (const thread of allThreads) {
      if (!OPEN_STATUSES.includes(thread.status)) continue;
      if (this.isThreadClosable(thread, newEvent)) {
        autoResolved.push(thread);
        resolvedSet.add(thread.id);
        resolutions.push(this.buildResolutionAction(thread, newEvent, 'auto'));
      }
    }

    // ---- 通道二：显式关闭 ----
    if (explicitResolutionIds && explicitResolutionIds.length > 0) {
      const threadMap = new Map(allThreads.map(t => [t.id, t]));

      for (const threadId of explicitResolutionIds) {
        const thread = threadMap.get(threadId);
        if (!thread) {
          errors.push(`THREAD_NOT_FOUND: ${threadId}`);
          continue;
        }

        // 状态资格校验：只允许开放状态被显式关闭
        if (!OPEN_STATUSES.includes(thread.status)) {
          errors.push(`THREAD_ALREADY_CLOSED: ${threadId} 当前状态为 ${thread.status}，无法关闭`);
          continue;
        }

        // 已被自动通道关闭的线索不重复处理（双通道去重）
        if (resolvedSet.has(thread.id)) continue;

        explicitlyResolved.push(thread);
        resolvedSet.add(thread.id);
        resolutions.push(this.buildResolutionAction(thread, newEvent, 'explicit'));
      }
    }

    // ---- 合并结果 ----
    const resolved = [...autoResolved];
    // 显式通道中未被自动通道覆盖的线索追加到 resolved
    for (const t of explicitlyResolved) {
      if (!resolved.some(r => r.id === t.id)) {
        resolved.push(t);
      }
    }

    // 仍开放的线索 = 输入中不在 resolvedSet 里的开放线索
    const stillOpen = allThreads.filter(
      t => OPEN_STATUSES.includes(t.status) && !resolvedSet.has(t.id),
    );

    return { resolved, stillOpen, resolutions, errors };
  }

  // -----------------------------------------------------------------------
  // 核心方法三：过期预警（§6.1 getExpiringThreads）
  // -----------------------------------------------------------------------

  /**
   * 检查即将超期的回溯型线索
   *
   * "即将超期"定义：当前章节 >= 创建章节 + withinChapters - warningWindow
   * 只扫描回溯型线索（direction='retroactive'），因为渐进型线索没有硬性 deadline。
   *
   * @param allThreads      当前所有线索
   * @param currentChapter  当前章节号
   * @param warningWindow   预警窗口（章节数），默认 5
   */
  getExpiringThreads(
    allThreads: NarrativeThread[],
    currentChapter: number,
    warningWindow: number = DEFAULT_WARNING_WINDOW,
  ): NarrativeThread[] {
    return allThreads.filter(thread => {
      // 只扫描回溯型线索
      if (thread.direction !== 'retroactive') return false;
      // 只扫描开放状态
      if (!OPEN_STATUSES.includes(thread.status)) return false;
      // 必须定义了 withinChapters 才有 deadline 概念
      if (thread.closeCondition.withinChapters === undefined) return false;

      const deadline = thread.createdAtChapter + thread.closeCondition.withinChapters;
      // 当前章节进入预警窗口但尚未过期（过期的不算"即将超期"，算"已超期"）
      return currentChapter >= deadline - warningWindow && currentChapter < deadline;
    });
  }

  // -----------------------------------------------------------------------
  // 核心方法四：可暗示线索（§6.1 getHintableThreads）
  // -----------------------------------------------------------------------

  /**
   * 检查可以被当前事件暗示或揭示的渐进型线索
   *
   * 判定逻辑：
   *   - 线索必须是渐进型且处于 PLANTED 或 HINTED 状态
   *   - 事件的 subject 必须在线索的 relatedEntities 中，
   *     或者事件的 relatedEntities（通过 params）与线索有交集
   *
   * 此方法返回的是"建议暗示"的线索列表——实际暗示仍由作者决定。
   *
   * @param allThreads  当前所有线索
   * @param newEvent    触发判定的新事件
   */
  getHintableThreads(
    allThreads: NarrativeThread[],
    newEvent: NarrativeEvent,
  ): NarrativeThread[] {
    const eventSubject = newEvent.params['subject'] as string | undefined;

    return allThreads.filter(thread => {
      // 只扫描渐进型线索
      if (thread.direction !== 'progressive') return false;
      // 只扫描可暗示状态（PLANTED / HINTED）
      if (thread.status !== 'PLANTED' && thread.status !== 'HINTED') return false;

      // 关联性检查：事件主体或参数中的实体是否与线索关联实体有交集
      const eventEntities = this.extractEventEntities(newEvent);
      if (eventEntities.size === 0) return false;

      return thread.relatedEntities.some(related => eventEntities.has(related));
    });

    // eventSubject 用于过滤（已在 extractEventEntities 中使用）
    void eventSubject;
  }

  // -----------------------------------------------------------------------
  // 状态转换校验（供 addMilestone / updateStatus 调用前使用）
  // -----------------------------------------------------------------------

  /**
   * 校验线索状态转换是否合法
   *
   * 基于架构文档 §6.2.1 的状态机定义。addMilestone 不做此校验（Phase 2A 设计决策），
   * 校验应在 ThreadResolver 层执行。
   *
   * @returns { valid: true } 或 { valid: false, reason: '...' }
   */
  validateTransition(
    thread: NarrativeThread,
    newStatus: ThreadStatus,
  ): { valid: boolean; reason?: string } {
    // 同状态转换的合法性取决于方向
    if (thread.status === newStatus) {
      // 渐进型 HINTED → HINTED 合法（多次暗示）
      if (thread.direction === 'progressive' && thread.status === 'HINTED') {
        return { valid: true };
      }
      // 其他同状态转换不合法
      return { valid: false, reason: `线索 ${thread.id} 已处于 ${newStatus} 状态` };
    }

    const transitions = thread.direction === 'retroactive'
      ? RETROACTIVE_TRANSITIONS
      : PROGRESSIVE_TRANSITIONS;

    const allowed = transitions[thread.status];
    if (!allowed || !allowed.includes(newStatus)) {
      return {
        valid: false,
        reason: `${thread.direction === 'retroactive' ? '回溯型' : '渐进型'}线索 ${thread.id} 不允许从 ${thread.status} 转换到 ${newStatus}`,
      };
    }

    return { valid: true };
  }

  // -----------------------------------------------------------------------
  // 内部辅助方法
  // -----------------------------------------------------------------------

  /**
   * 统计线索的暗示次数
   *
   * 直接使用 milestones 中 HINTED 状态的计数。Phase 2A 的 addMilestone
   * 已维护 hint_count 字段，但 ThreadResolver 是纯逻辑组件不读数据库，
   * 所以从 milestones 数组中统计。
   */
  private countHints(thread: NarrativeThread): number {
    return thread.milestones.filter(m => m.status === 'HINTED').length;
  }

  /**
   * 构建关闭动作描述
   *
   * 根据线索方向决定目标状态和里程碑需求：
   *   - 回溯型关闭 → FILLED，无里程碑
   *   - 渐进型关闭 → RESOLVED，追加里程碑
   */
  private buildResolutionAction(
    thread: NarrativeThread,
    event: NarrativeEvent,
    channel: 'auto' | 'explicit',
  ): ThreadResolutionAction {
    const isRetroactive = thread.direction === 'retroactive';
    const newStatus: ThreadStatus = isRetroactive ? 'FILLED' : 'RESOLVED';

    return {
      threadId: thread.id,
      oldStatus: thread.status,
      newStatus,
      channel,
      closedByEventId: event.id,
      needsMilestone: !isRetroactive,
      milestoneStatus: newStatus,
      milestoneChapter: event.chapter,
      milestoneDescription: channel === 'auto'
        ? `自动关闭：事件 ${event.type} 在第 ${event.chapter} 章匹配 closeCondition`
        : `显式关闭：作者通过 thread_resolutions 声明在第 ${event.chapter} 章关闭`,
    };
  }

  /**
   * 从事件参数中提取涉及的所有实体 ID
   *
   * 提取来源：
   *   - params.subject（事件主体）
   *   - params.target_entity_id（目标实体）
   *   - params.exitFrom（退出作用域——可能关联实体）
   */
  private extractEventEntities(event: NarrativeEvent): Set<string> {
    const entities = new Set<string>();
    const subject = event.params['subject'];
    if (typeof subject === 'string') entities.add(subject);

    const target = event.params['target_entity_id'];
    if (typeof target === 'string') entities.add(target);

    // resolvedThreads 中引用的线索可能涉及其他实体，但那是 Thread ID 不是 Entity ID
    // 不在这里提取

    return entities;
  }
}

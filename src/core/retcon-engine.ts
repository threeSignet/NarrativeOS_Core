// =============================================================================
// RetconEngine —— 世界状态回溯变更引擎
// =============================================================================
// 实现 propose_retcon (BFS 级联遍历 + 影响报告) 和 commit_retcon (Phase B 事务)。
//
// 核心原则：
//   - Event Sourcing 不可变：永远不 DELETE Fact，仅通过 UPDATE certainty 标记争议
//   - BFS 在作用域边界硬停止：不跨 scope 追溯因果（§3.4.1 Retcon 兼容）
//   - 级联报告按 Level 分组：直接影响 / 二级 / 深层 / 认知失调
//   - cognitive_dissonance Thread 上限 50 条，按 confidence 降序
//
// 与架构文档的对应关系：
//   §9.2 Tool 4 propose_retcon  →  BFS 算法 + 级联报告 + 跨作用域扫描
//   §9.2 Tool 5 commit_retcon   →  Phase B 事务分解
//   §3.1.3 certainty 状态机     →  canonical → contested
//   §6.2.1 线索生命周期          →  OBSOLETE 检测 + 恢复
// =============================================================================

import type {
  Fact,
  FactStore,
  Certainty,
  NarrativeEvent,
  NarrativeThread,
  Knowledge,
  EventStore,
  ThreadStore,
  KnowledgeStore,
  FactChangeInput,
} from '../types.js';

// =============================================================================
// 内部类型定义
// =============================================================================

/**
 * BFS 级联遍历结果
 *
 * factsByLevel / eventsByLevel 按级联深度组织。
 * 每个集合只包含唯一元素（Set 去重）。
 */
export interface BfsCascadeResult {
  /** Level → Fact 列表，Level 1 是目标事件本身的 Fact */
  factsByLevel: Map<number, Fact[]>;
  /** Level → Event ID 列表 */
  eventsByLevel: Map<number, string[]>;
  /** 所有受影响的 Thread ID（被关闭的线索） */
  affectedThreadIds: Set<string>;
  /** 所有受影响的 Knowledge 记录 ID */
  affectedKnowledgeIds: Set<string>;
  /** 跨作用域潜在影响 */
  crossScopeImpacts: CrossScopeItem[];
  /** BFS 访问过的所有 Event ID（去重用） */
  visitedEventIds: Set<string>;
  /** BFS 访问过的所有 Fact ID（去重用） */
  visitedFactIds: Set<string>;
}

/** 跨作用域影响条目 */
export interface CrossScopeItem {
  factId: string;
  context: string;
  /** 命中级别：deterministic = 优先路径（event_dependencies），heuristic = 兜底路径（subject+predicate） */
  matchLevel: 'deterministic' | 'heuristic';
  description: string;
}

/**
 * RetconProposal —— propose_retcon 返回后、commit_retcon 消费前的暂存提案
 *
 * 存储在内存 Map 中（与 ProposalStore 类似），进程重启后清空。
 */
export interface RetconProposal {
  proposalId: string;
  targetEventId: string;
  reason: string;
  newDescription: string;
  chapter: number;
  factChanges: FactChangeInput[];
  cascadeResult: BfsCascadeResult;
  cascadeReportMarkdown: string;
  isSafeToCommit: boolean;
  /** BFS 收集的所有受影响 Fact ID（所有 Level 合并） */
  affectedFactIds: string[];
  /** BFS 收集的所有受影响 Event ID（不含目标事件本身） */
  affectedEventIds: string[];
  /** 是否已提交（防止重复提交） */
  committed: boolean;
  /** 提交后生成的系统事件 ID */
  retconEventId?: string;
  /**
   * propose 时捕获的世界状态版本号（乐观锁）。
   * commit_retcon 时用 tryUpdateStateVersion 校验——若 propose→commit 之间有并发提交，
   * 版本不匹配则 STALE_PROPOSAL（此前 commit_retcon 先读后 CAS 等价无条件+1，检测不到并发）。
   */
  expectedStateVersion: number;
}

/**
 * commit_retcon 的返回值
 */
export interface RetconCommitResult {
  status: 'success' | 'failed';
  retconEventId?: string;
  contestedFactCount: number;
  reactivatedThreadCount: number;
  cognitiveDissonanceCount: number;
  contestedFactIds: string[];
  reactivatedThreadIds: string[];
  errorMessage?: string;
}

// =============================================================================
// RetconEngine
// =============================================================================

export class RetconEngine {
  /** 内存提案存储：proposalId → RetconProposal */
  private proposals: Map<string, RetconProposal> = new Map();

  /** 提案 ID 计数器 */
  private proposalCounter = 0;

  // =========================================================================
  // 1. BFS 级联遍历
  // =========================================================================

  /**
   * BFS 因果级联遍历
   *
   * 从目标事件出发，沿因果链广度优先搜索所有受影响的实体。
   * 优先路径走显式依赖声明（event_dependencies 表），
   * 兜底路径走启发式搜索（subject + predicate + context 三重过滤）。
   *
   * BFS 在作用域边界硬停止 —— 不跨 scope 追溯因果。
   *
   * @param targetEventId 被 Retcon 的目标事件 ID
   * @returns BfsCascadeResult 包含按 Level 组织的受影响实体集合
   * @throws EVENT_NOT_FOUND 如果目标事件不存在
   */
  bfsCascade(
    targetEventId: string,
    factStore: FactStore,
    eventStore: EventStore,
    threadStore: ThreadStore,
    knowledgeStore: KnowledgeStore,
  ): BfsCascadeResult {
    // 验证目标事件存在
    const targetEvent = eventStore.getById(targetEventId);
    if (!targetEvent) {
      throw new Error(`EVENT_NOT_FOUND: ${targetEventId}`);
    }

    const result: BfsCascadeResult = {
      factsByLevel: new Map(),
      eventsByLevel: new Map(),
      affectedThreadIds: new Set(),
      affectedKnowledgeIds: new Set(),
      crossScopeImpacts: [],
      visitedEventIds: new Set(),
      visitedFactIds: new Set(),
    };

    // BFS 队列：{ eventId, level }
    const queue: Array<{ eventId: string; level: number }> = [
      { eventId: targetEventId, level: 1 },
    ];

    // BFS 主循环
    while (queue.length > 0) {
      const { eventId, level } = queue.shift()!;

      // 防止重复访问（BFS 可能在多路径到达同一事件）
      if (result.visitedEventIds.has(eventId)) continue;
      result.visitedEventIds.add(eventId);

      // 收集此事件的 Fact
      const eventFacts = factStore.getFactsByEvent(eventId);
      const levelFacts: Fact[] = [];

      for (const fact of eventFacts) {
        if (result.visitedFactIds.has(fact.id)) continue;
        result.visitedFactIds.add(fact.id);
        levelFacts.push(fact);

        // ---- 优先路径：显式依赖声明 ----
        const explicitDeps = eventStore.getByDependentFactIds([fact.id], 'business');
        for (const depEvent of explicitDeps) {
          if (!result.visitedEventIds.has(depEvent.id)) {
            // 作用域边界检查：只在同一作用域内继续 BFS
            if (depEvent.context === fact.context) {
              queue.push({ eventId: depEvent.id, level: level + 1 });
            }
          }
        }

        // ---- 兜底路径：启发式搜索（subject + predicate + context 三重过滤） ----
        // 与架构文档伪代码 §9.2 Tool 4 一致：
        //   evt.params.subject === fact.subject
        //   AND evt.context === fact.context
        //   AND Object.values(evt.params).includes(fact.predicate)
        const heuristicEvents = eventStore.getBySubject(fact.subject, fact.validFrom, 'business');
        for (const heEvent of heuristicEvents) {
          // 已在 SQL 层按 subject 过滤（json_extract params_json），但额外做客户端校验
          if (result.visitedEventIds.has(heEvent.id)) continue;
          if (heEvent.context !== fact.context) continue;
          // 二次校验：事件 params 中的 subject 必须与 fact.subject 一致
          if (heEvent.params.subject !== fact.subject) continue;

          // 检查事件参数是否引用了此 predicate
          const paramsValues = Object.values(heEvent.params);
          if (paramsValues.includes(fact.predicate)) {
            queue.push({ eventId: heEvent.id, level: level + 1 });
          }
        }

        // ---- 收集此 Fact 的 Knowledge 记录 ----
        const knowledgeRecords = knowledgeStore.getByFactId(fact.id);
        for (const k of knowledgeRecords) {
          result.affectedKnowledgeIds.add(k.id);
        }
      }

      // 存储此 Level 的 Fact
      if (levelFacts.length > 0) {
        const existing = result.factsByLevel.get(level) ?? [];
        result.factsByLevel.set(level, [...existing, ...levelFacts]);
      }

      // 存储此 Level 的 Event（目标事件本身进入 Level 1）
      if (!result.eventsByLevel.has(level)) {
        result.eventsByLevel.set(level, []);
      }
      result.eventsByLevel.get(level)!.push(eventId);
    }

    // ---- 收集被受影响事件关闭的 Thread ----
    for (const eventId of result.visitedEventIds) {
      const closedThreads = threadStore.getByFilters({ closedByEvent: eventId });
      for (const t of closedThreads) {
        result.affectedThreadIds.add(t.id);
      }
    }

    // ---- 跨作用域扫描（报告生成阶段，非 BFS 主循环） ----
    this.crossScopeScan(result, targetEvent, factStore, eventStore);

    return result;
  }

  /**
   * 跨作用域潜在影响扫描
   *
   * 在 BFS 主循环完成后执行，检测其他作用域中可能受影响的数据。
   * 优先路径（确定性）：通过 event_dependencies 精确查找。
   * 兜底路径（启发式）：通过 subject + predicate 模糊匹配。
   */
  private crossScopeScan(
    bfsResult: BfsCascadeResult,
    targetEvent: NarrativeEvent,
    factStore: FactStore,
    eventStore: EventStore,
  ): void {
    // 使用目标事件的实际 context，而非硬编码 'global'
    // 当 Retcon 目标在非 global 作用域时（如副本内），跨作用域基线是目标事件自身的 context
    const targetContext = targetEvent.context ?? 'global';

    // 收集所有受影响 Fact ID
    const allAffectedFactIds = this.collectAffectedFactIds(bfsResult.factsByLevel);

    if (allAffectedFactIds.length === 0) return;

    // 优先路径：通过 event_dependencies 查找跨作用域事件
    const crossEvents = eventStore.getByDependentFactIds(allAffectedFactIds, 'business');
    for (const evt of crossEvents) {
      if (evt.context === targetContext) continue; // 排除同作用域（已在 BFS 中处理）
      if (bfsResult.visitedEventIds.has(evt.id)) continue;

      const crossFacts = factStore.getFactsByEvent(evt.id);
      for (const cf of crossFacts) {
        if (cf.certainty !== 'canonical') continue;
        bfsResult.crossScopeImpacts.push({
          factId: cf.id,
          context: evt.context,
          matchLevel: 'deterministic',
          description: `跨作用域因果污染：${cf.subject}.${cf.predicate}=${String(cf.value)}（事件 ${evt.id}，作用域 ${evt.context}）`,
        });
      }
    }

    // 兜底路径：启发式跨作用域扫描
    const affectedSubjects = new Set<string>();
    for (const [, facts] of bfsResult.factsByLevel) {
      for (const f of facts) {
        affectedSubjects.add(f.subject);
      }
    }

    // 查询所有作用域中 canonical Fact，限定为目标章节及之前（retcon 语义：改写过去，不波及未来）
    const maxRetconChapter = targetEvent.chapter;
    const allFacts = factStore.query({ mode: 'current' });
    for (const f of allFacts) {
      if (f.context === targetContext) continue; // 排除同作用域
      if (!affectedSubjects.has(f.subject)) continue;
      if (f.certainty !== 'canonical') continue;
      // 章节时间上限：只看 retcon 目标章节及之前的跨作用域 Fact（之前的死代码声明了变量但未使用）
      if (f.validFrom > maxRetconChapter) continue;

      // 排除已被优先路径命中的（去重）
      if (bfsResult.crossScopeImpacts.some(ci => ci.factId === f.id)) continue;

      bfsResult.crossScopeImpacts.push({
        factId: f.id,
        context: f.context,
        matchLevel: 'heuristic',
        description: `跨作用域潜在关联：${f.subject}.${f.predicate}=${String(f.value)}（作用域 ${f.context}，章节 ${f.validFrom}）`,
      });
    }
  }

  // =========================================================================
  // 2. 级联影响报告生成
  // =========================================================================

  /**
   * 生成 Markdown 格式的级联影响报告
   *
   * 报告分四级展示：
   *   1. 直接影响（Level 1）
   *   2. 二级影响（Level 2）
   *   3. 深层影响（Level 3+）
   *   4. 认知失调（Knowledge Impact）
   *
   * 对齐架构文档 §9.2 Tool 4 的级联影响报告示例。
   */
  generateCascadeReport(result: BfsCascadeResult, targetEventId: string): string {
    const lines: string[] = [];
    lines.push(`## Retcon 级联影响报告 · ${targetEventId}`);
    lines.push('');

    // ---- 直接影响（Level 1） ----
    const level1Facts = result.factsByLevel.get(1) ?? [];
    if (level1Facts.length > 0) {
      lines.push('### 📍 直接影响（Level 1）');
      for (const f of level1Facts) {
        lines.push(`- Fact \`${f.id}\` ${f.subject} ${f.predicate}=${String(f.value)} ← **将标记 contested**`);
      }
      lines.push('');
    }

    // ---- 二级影响（Level 2） ----
    const level2Facts = result.factsByLevel.get(2) ?? [];
    const level2Events = result.eventsByLevel.get(2) ?? [];
    if (level2Facts.length > 0 || level2Events.length > 0) {
      lines.push('### 📍 二级影响（Level 2）');
      for (const eid of level2Events) {
        const facts = level2Facts.filter(f => f.causeEvent === eid);
        lines.push(`- Event \`${eid}\``);
        for (const f of facts) {
          lines.push(`  - Fact \`${f.id}\` ${f.subject} ${f.predicate}=${String(f.value)} ← **将标记 contested**`);
        }
      }
      lines.push('');
    }

    // ---- 深层影响（Level 3+） ----
    for (let level = 3; ; level++) {
      const levelFacts = result.factsByLevel.get(level);
      if (!levelFacts || levelFacts.length === 0) break;

      const levelEvents = result.eventsByLevel.get(level) ?? [];
      lines.push(`### 📍 深层影响（Level ${level}）`);
      for (const eid of levelEvents) {
        const facts = levelFacts.filter(f => f.causeEvent === eid);
        lines.push(`- Event \`${eid}\``);
        for (const f of facts) {
          lines.push(`  - Fact \`${f.id}\` ${f.subject} ${f.predicate}=${String(f.value)} ← **将标记 contested**`);
        }
      }
      lines.push('');
    }

    // ---- Thread 影响 ----
    if (result.affectedThreadIds.size > 0) {
      lines.push('### 📍 Thread 影响');
      for (const tid of result.affectedThreadIds) {
        lines.push(`- Thread \`${tid}\`：已关闭 ← **关闭将撤销，恢复 UNFILLED**`);
      }
      lines.push('');
    }

    // ---- 认知失调（Knowledge Impact） ----
    if (result.affectedKnowledgeIds.size > 0) {
      lines.push('### 🧠 认知失调（Knowledge Impact）');
      lines.push(`- 共 ${result.affectedKnowledgeIds.size} 条 Knowledge 记录受影响`);
      lines.push(`- 将生成最多 50 条 cognitive_dissonance 类型 NarrativeThread`);
      lines.push(`- 需作者后续裁决：记忆修正 / 重新认知 / 保持冲突`);
      lines.push('');
    }

    // ---- 跨作用域潜在影响 ----
    if (result.crossScopeImpacts.length > 0) {
      lines.push('### 🔮 跨作用域潜在影响（非自动级联）');
      const deterministic = result.crossScopeImpacts.filter(c => c.matchLevel === 'deterministic');
      const heuristic = result.crossScopeImpacts.filter(c => c.matchLevel === 'heuristic');

      if (deterministic.length > 0) {
        lines.push('以下作用域中存在确定性因果污染的 Fact（通过 event_dependencies 命中）：');
        for (const ci of deterministic) {
          lines.push(`- 🔴 \`${ci.factId}\`（作用域 ${ci.context}）：${ci.description}`);
        }
      }

      if (heuristic.length > 0) {
        if (deterministic.length > 0) lines.push('');
        lines.push('以下作用域中存在启发式匹配的潜在关联 Fact：');
        for (const ci of heuristic) {
          lines.push(`- 🟡 \`${ci.factId}\`（作用域 ${ci.context}）：${ci.description}`);
        }
      }

      lines.push('');
      lines.push('> ⚠️ BFS 不跨作用域自动级联（设计原则，见 §3.4.1）。以上信息仅供参考，');
      lines.push('> 作者决定是否同步修改其他作用域的设定。');
      lines.push('');
    }

    // ---- 建议 ----
    const totalFacts = Array.from(result.factsByLevel.values()).flat().length;
    lines.push('### ⚠️ 建议');
    lines.push(`此 Retcon 影响 ${result.eventsByLevel.size} 个级别的事件、${totalFacts} 条 Fact、${result.affectedThreadIds.size} 条 Thread。确认后需要逐个裁决 contested Fact。`);

    return lines.join('\n');
  }

  // =========================================================================
  // 3. propose_retcon
  // =========================================================================

  /**
   * propose_retcon：执行 BFS 级联遍历并生成影响报告
   *
   * Phase A（事务外）：BFS + 报告生成。不修改任何持久数据。
   *
   * @returns RetconProposal 包含完整的级联影响分析和报告
   */
  proposeRetcon(
    params: {
      targetEventId: string;
      reason: string;
      newDescription: string;
      chapter: number;
      factChanges: FactChangeInput[];
    },
    factStore: FactStore,
    eventStore: EventStore,
    threadStore: ThreadStore,
    knowledgeStore: KnowledgeStore,
  ): RetconProposal {
    // 1. 执行 BFS
    const cascadeResult = this.bfsCascade(
      params.targetEventId,
      factStore,
      eventStore,
      threadStore,
      knowledgeStore,
    );

    // 2. 生成级联报告
    const report = this.generateCascadeReport(cascadeResult, params.targetEventId);

    // 3. 收集所有受影响 Fact ID 和 Event ID
    const affectedFactIds = this.collectAffectedFactIds(cascadeResult.factsByLevel);

    const affectedEventIds: string[] = [];
    for (const [level, eventIds] of cascadeResult.eventsByLevel) {
      if (level === 1) continue; // 排除目标事件本身
      affectedEventIds.push(...eventIds);
    }

    // 4. 生成 proposal ID
    this.proposalCounter++;
    const targetEvent = eventStore.getById(params.targetEventId)!;
    const proposalId = `rtc_${targetEvent.type}_${targetEvent.chapter}_${String(this.proposalCounter).padStart(2, '0')}`;

    // 5. 构建 proposal
    const proposal: RetconProposal = {
      proposalId,
      targetEventId: params.targetEventId,
      reason: params.reason,
      newDescription: params.newDescription,
      chapter: params.chapter,
      factChanges: params.factChanges,
      cascadeResult,
      cascadeReportMarkdown: report,
      isSafeToCommit: true, // Retcon 总是可以提交（影响范围已在报告中展示）
      affectedFactIds,
      affectedEventIds,
      committed: false,
      // 捕获 propose 时的世界状态版本（乐观锁，commit 时校验并发修改）
      // 用 factStore 绑定的项目 ID，消除 'default' 硬编码（2026-06-18）
      expectedStateVersion: factStore.getStateVersion(),
    };

    // 6. 保存到内存
    this.proposals.set(proposalId, proposal);

    return proposal;
  }

  // =========================================================================
  // 4. commit_retcon
  // =========================================================================

  /**
   * commit_retcon：执行 Phase B 事务
   *
   * Phase B 事务内操作：
   *   1. 递增 project_state.state_version
   *   2. 创建 evt_retcon_* 系统事件
   *   3. 标记受影响 Fact 为 contested
   *   4. 恢复受影响 Thread（FILLED→UNFILLED, RESOLVED→PLANTED），上游匹配的→OBSOLETE
   *   5. 生成 cognitive_dissonance Thread（上限 50 条）
   *   6. 写入 event_dependencies / audit_log / sync_queue
   *
   * @throws ALREADY_COMMITTED 如果 proposal 已提交
   * @throws PROPOSAL_NOT_FOUND 如果 proposal 不存在
   */
  commitRetcon(
    params: {
      retconProposalId: string;
    },
    factStore: FactStore & { getDatabase?: () => any },
    eventStore: EventStore,
    threadStore: ThreadStore,
    knowledgeStore: KnowledgeStore,
  ): RetconCommitResult {
    const proposal = this.proposals.get(params.retconProposalId);
    if (!proposal) {
      throw new Error(`PROPOSAL_NOT_FOUND: ${params.retconProposalId}`);
    }
    if (proposal.committed) {
      throw new Error(`ALREADY_COMMITTED: ${params.retconProposalId}`);
    }

    const db = factStore.getDatabase?.();
    if (!db) {
      throw new Error('RETCON_REQUIRES_DATABASE: commit_retcon 需要 factStore 提供 getDatabase() 方法');
    }

    // 2. 收集所有受影响 Fact ID（事务外准备数据）
    const allAffectedFactIds = this.collectAffectedFactIds(proposal.cascadeResult.factsByLevel);

    // 3-9. 事务内原子写入：乐观锁 → event → contested → thread → dependencies → audit → sync_queue
    // 任一步失败自动 ROLLBACK，保证不产生半截世界状态
    const txnResult = db.transaction(() => {
      // 1. 乐观锁：用 proposal 缓存的 expectedStateVersion 校验（而非先读后 CAS）。
      // 此前代码在事务内 getStateVersion 再 tryUpdate，读到的值必然匹配刚读的 → 等价无条件+1，
      // 检测不到 propose→commit 间的并发提交。改为用 propose 时捕获的版本，与 commit_event 一致。
      if (!factStore.tryUpdateStateVersion(undefined, proposal.expectedStateVersion)) {
        throw new Error('STALE_PROPOSAL: 状态版本冲突（propose→commit 期间世界状态已变更）');
      }

      // allAffectedFactIds 复用事务外（第 557 行）已构建的列表，事务闭包可直接捕获外层 const，
      // 无需在事务内重复构建（原代码在此处重建并同名遮蔽外层变量，是冗余且易混淆）
    const targetEvent = eventStore.getById(proposal.targetEventId);
    // 生成 retcon 事件的 seq
    const seq = (db.prepare("SELECT COUNT(*) as cnt FROM events WHERE type = 'retcon'").get() as { cnt: number }).cnt + 1;
    const retconEventId = `evt_retcon_${targetEvent?.chapter ?? proposal.chapter}_${String(seq).padStart(2, '0')}`;

    // params 需包含 retcon_proposal_id / target_event_id / contested_fact_ids / reactivated_thread_ids
    // 对应架构文档 §9.2 Tool 5 和 §8 系统事件约束
    db.prepare(`
      INSERT INTO events (id, kind, type, chapter, description, params_json, context, fact_group_id, resolved_threads, dependencies_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      retconEventId,
      'system',
      'retcon',
      proposal.chapter,
      proposal.reason,
      JSON.stringify({
        retconProposalId: proposal.proposalId,
        targetEventId: proposal.targetEventId,
        newDescription: proposal.newDescription,
        affectedFactCount: allAffectedFactIds.length,
        contestedFactIds: allAffectedFactIds,
        // reactivated_thread_ids 将在 Thread 处理后通过 UPDATE 补充
      }),
      targetEvent?.context ?? 'global',
      retconEventId, // factGroupId = eventId（Retcon 无 FactGroup）
      JSON.stringify([]),
      JSON.stringify(allAffectedFactIds),
    );

    // 4. 标记 contested
    const contestedCount = factStore.markContested(allAffectedFactIds, retconEventId);

    // 5. Thread 处理
    const reactivatedThreadIds: string[] = [];

    // 5a. 恢复被关闭的 Thread（FILLED→UNFILLED, RESOLVED→PLANTED）
    for (const tid of proposal.cascadeResult.affectedThreadIds) {
      const thread = threadStore.getById(tid);
      if (!thread) continue;

      if (thread.status === 'FILLED' && thread.direction === 'retroactive') {
        threadStore.updateStatus(tid, 'UNFILLED');
        // 清除 closedBy：回溯型线索恢复到未填充状态，关闭事件字段清空
        db.prepare('UPDATE threads SET closed_by = NULL WHERE id = ?').run(tid);
        reactivatedThreadIds.push(tid);
      } else if (thread.status === 'RESOLVED' && thread.direction === 'progressive') {
        threadStore.updateStatus(tid, 'PLANTED');
        // 清除 closedBy：渐进型线索恢复到埋种状态
        db.prepare('UPDATE threads SET closed_by = NULL WHERE id = ?').run(tid);
        reactivatedThreadIds.push(tid);
      }
    }

    // 5b. OBSOLETE 检测：匹配 upstreamFactIds 的未关闭 Thread
    const openThreads = threadStore.getOpen();
    for (const thread of openThreads) {
      for (const upstreamFactId of thread.upstreamFactIds) {
        if (allAffectedFactIds.includes(upstreamFactId)) {
          threadStore.updateStatus(thread.id, 'OBSOLETE');
          break; // 一条上游 Fact 匹配即可废弃此线索
        }
      }
    }

    // 补充更新 retcon 系统事件的 params，写入 reactivated_thread_ids
    // （Thread 处理完成后才能确定完整的 reactivated 列表）
    db.prepare(`
      UPDATE events SET params_json = json_set(params_json, '$.reactivatedThreadIds', ?)
      WHERE id = ?
    `).run(JSON.stringify(reactivatedThreadIds), retconEventId);

    // 6. 生成 cognitive_dissonance Thread（上限 50 条）
    const COGNITIVE_DISSONANCE_LIMIT = 50;
    let cognitiveDissonanceCount = 0;

    // 收集受影响 Knowledge 记录，按 confidence 降序排列
    const allKnowledgeEntries: Array<{ knowledge: Knowledge; confidence: number }> = [];
    for (const [, facts] of proposal.cascadeResult.factsByLevel) {
      for (const f of facts) {
        const records = knowledgeStore.getByFactId(f.id);
        for (const k of records) {
          if (k.confidence > 0) {
            allKnowledgeEntries.push({ knowledge: k, confidence: k.confidence });
          }
        }
      }
    }

    // 按 confidence 降序排列
    allKnowledgeEntries.sort((a, b) => b.confidence - a.confidence);

    // 生成 cognitive_dissonance Thread（上限 50 条）
    for (const entry of allKnowledgeEntries) {
      if (cognitiveDissonanceCount >= COGNITIVE_DISSONANCE_LIMIT) break;

      const k = entry.knowledge;
      const fact = factStore.getById(k.factId);
      const entityName = k.entityId.replace('ent_', '');

      threadStore.create({
        type: 'logic_conflict',
        direction: 'retroactive',
        severity: 'major',
        description: `⚠️ 认知冲突：${entityName} 对 ${fact?.predicate ?? '未知'}=${String(fact?.value ?? '未知')} 的认知与世界线矛盾（原确信度 ${k.confidence}）`,
        closeCondition: {},
        status: 'UNFILLED',
        closedBy: null,
        createdAtEvent: retconEventId,
        createdAtChapter: proposal.chapter,
        milestones: [{
          id: `ms_cd_${k.id}`,
          status: 'UNFILLED',
          chapter: proposal.chapter,
          eventId: retconEventId,
          description: `Retcon 导致认知失调：对 Fact ${k.factId} 的认知（source=${k.source}, confidence=${k.confidence}）不再有效`,
          createdAt: new Date().toISOString(),
        }],
        relatedEntities: [k.entityId],
        upstreamFactIds: [k.factId],
        tags: ['cognitive_dissonance', 'retcon'],
      });

      cognitiveDissonanceCount++;
    }

    // 7. 写入 event_dependencies
    const insertDep = db.prepare(
      'INSERT OR IGNORE INTO event_dependencies (event_id, fact_id, source) VALUES (?, ?, ?)'
    );
    for (const factId of allAffectedFactIds) {
      insertDep.run(retconEventId, factId, 'retcon_cascade');
    }

    // 8. 写入 audit_log
    db.prepare(`
      INSERT INTO audit_log (event_id, tool_name, raw_input_json)
      VALUES (?, ?, ?)
    `).run(retconEventId, 'commit_retcon', JSON.stringify({
      retconProposalId: params.retconProposalId,
      targetEventId: proposal.targetEventId,
      contestedFactIds: allAffectedFactIds,
      reactivatedThreadIds,
      cognitiveDissonanceCount,
    }));

    // 9. 写入 sync_queue（LanceDB certainty 更新队列）
      db.prepare(`
        INSERT INTO sync_queue (event_id, operation, fact_ids, payload_json, next_retry_at)
        VALUES (?, ?, ?, ?, datetime('now', '+2 seconds'))
      `).run(retconEventId, 'update_certainty', JSON.stringify(allAffectedFactIds), JSON.stringify({ certainty: 'contested' }));

      return {
        retconEventId,
        contestedCount,
        reactivatedThreadIds: reactivatedThreadIds as string[],
        cognitiveDissonanceCount,
      };
    })(); // 事务结束

    // 事务成功：更新内存状态
    proposal.committed = true;
    proposal.retconEventId = txnResult.retconEventId;

    return {
      status: 'success',
      retconEventId: txnResult.retconEventId,
      contestedFactCount: txnResult.contestedCount,
      reactivatedThreadCount: txnResult.reactivatedThreadIds.length,
      cognitiveDissonanceCount: txnResult.cognitiveDissonanceCount,
      contestedFactIds: allAffectedFactIds,
      reactivatedThreadIds: txnResult.reactivatedThreadIds,
    };
  } catch (err: unknown) {
    if (String(err).includes('STALE_PROPOSAL')) {
      return { status: 'failed', contestedFactCount: 0, reactivatedThreadCount: 0, cognitiveDissonanceCount: 0, contestedFactIds: [], reactivatedThreadIds: [], errorMessage: 'STALE_PROPOSAL: 状态版本冲突' };
    }
    throw err; // 其他异常向上传播
  }

  /** 从级联结果中提取所有受影响 Fact ID（三处共用） */
  private collectAffectedFactIds(factsByLevel: Map<number, Array<{ id: string }>>): string[] {
    const ids: string[] = [];
    for (const [, facts] of factsByLevel) {
      for (const f of facts) {
        ids.push(f.id);
      }
    }
    return ids;
  }
}

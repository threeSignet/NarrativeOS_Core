// =============================================================================
// ProposalManager —— propose_event / commit_event 编排层
// =============================================================================
// Phase 1 核心产出：连接 LLM Tool Interface 和底层存储的完整写入流。
//
// 数据流（§10.1）：
//   LLM → propose_event（Phase A 沙盒推演）→ ProposalResult
//   LLM → commit_event（Phase B 确定性写入）→ 事实生效
//
// 关键设计：
//   - Phase A 事务外推演：Rule Engine 在沙盒中计算后果，不写入真实状态
//   - Phase B 事务内写入：乐观锁 → Event → FactGroup → Knowledge → audit_log → sync_queue
//   - Phase C 异步后处理：LanceDB 向量同步（当前为 outbox 写入，后台 worker 消费）
//   - 推理 Fact 提升：potential Fact 随主 FactGroup 原子提升为 canonical
//
// 与架构文档的对应关系：
//   §9.2 Tool 2   propose_event     → LLM 提议新事件
//   §9.2 Tool 3   commit_event      → 确认提交
//   §4.4          commit_event 三阶段 → Phase A/B/C 分解
//   §10.1         写入流            → 双流写入（客观事实流 + 认知事件流）
//   §5.5          推理 Fact 提升     → potential → canonical
// =============================================================================

import type {
  Fact,
  FactChange,
  FactChangeInput,
  FactGroup,
  NarrativeEvent,
  Knowledge,
  KnowledgeChangeInput,
  KnowledgeHint,
  KnowledgeBroadcast,
  KnowledgeSource,
  ProposedKnowledge,
  ProposalResult,
  EventConsequence,
  FactStore,
  ProposalStore,
  KnowledgeStore,
  EventStore,
  ThreadStore,
} from '../types.js';
import { FACT_CHANGE_MAPPING } from '../types.js';
import { RuleEngine } from './rule-engine.js';
import { ThreadResolver } from './thread-resolver.js';
import { InMemoryProposalStore } from '../adapters/memory-proposal-store.js';

type ProposeEventParams = {
  eventType: string;
  eventDescription: string;
  chapter: number;
  factChanges: FactChangeInput[];
  context?: string;
  exitFrom?: string;
  subject?: string;
  threadResolutions?: string[];
  knowledgeHints?: KnowledgeHint[];
  knowledgeBroadcast?: KnowledgeBroadcast;
  knowledgeChanges?: KnowledgeChangeInput[];
  dependentFactIds?: string[];
};

const CHANGE_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

// ---------------------------------------------------------------------------
// ProposalManager
// ---------------------------------------------------------------------------

export class ProposalManager {
  private ruleEngine: RuleEngine;
  private proposalStore: ProposalStore;
  // Phase 2C：ThreadStore + ThreadResolver 可选注入
  // 不传时 commitEvent 不执行 Thread 持久化（向后兼容 Phase 1 测试）
  private threadStore?: ThreadStore;
  private threadResolver?: ThreadResolver;
  private eventIdSeq = 0;
  private proposalIdSeq = 0;

  constructor(
    ruleEngine?: RuleEngine,
    proposalStore?: ProposalStore,
    threadStore?: ThreadStore,
    threadResolver?: ThreadResolver,
  ) {
    this.ruleEngine = ruleEngine ?? new RuleEngine();
    this.proposalStore = proposalStore ?? new InMemoryProposalStore();
    this.threadStore = threadStore;
    this.threadResolver = threadResolver;
  }

  // =====================================================================
  // propose_event（Phase A：沙盒推演）
  // =====================================================================

  /**
   * 提议一个叙事事件（沙盒预演，不写入世界状态）
   *
   * 流程：
   *   1. 将 FactChangeInput[] 转换为 FactChange[]
   *   2. 构造 NarrativeEvent + FactGroup
   *   3. 运行 Rule Engine 沙盒推演
   *   4. 生成 ProposalResult 并存入 ProposalStore
   *   5. 返回 ProposalResult（含 simulation_report_markdown）
   */
  proposeEvent(params: ProposeEventParams, factStore: FactStore): ProposalResult {
    this.validateProposeEventParams(params, factStore);

    // ---- 1. 转换 FactChangeInput → FactChange ----
    const changes: FactChange[] = [];
    const conversionErrors: string[] = [];

    for (const input of params.factChanges) {
      try {
        const change = this.convertFactChangeInput(input);
        changes.push(change);
      } catch (err) {
        conversionErrors.push(`change_id=${input.change_id ?? '(none)'}: ${String(err)}`);
      }
    }

    if (conversionErrors.length > 0) {
      throw new Error(`FactChangeInput 转换错误:\n${conversionErrors.join('\n')}`);
    }

    const eventContext = params.context ?? 'global';
    const normalizedChanges = this.applyDefaultFactTimes(changes, params.chapter, eventContext);
    const dependencyResolution = this.mergeDependentFacts(
      params.dependentFactIds ?? [],
      this.resolveExitScopeDependencies(params, normalizedChanges, factStore),
    );
    const dependentFactIds = dependencyResolution.ids;
    const normalizedParams: ProposeEventParams = {
      ...params,
      context: eventContext,
      dependentFactIds,
    };
    this.validateProposeEventParams(normalizedParams, factStore);

    // ---- 2. 构造 NarrativeEvent + FactGroup ----
    const eventId = this.generateEventId(params.eventType, params.chapter);
    const proposalId = this.generateProposalId(params.eventType, params.chapter);

    const event: NarrativeEvent = {
      id: eventId,
      type: params.eventType,
      chapter: params.chapter,
      description: params.eventDescription,
      kind: 'business',
      context: eventContext,
      params: {
        subject: params.subject,
        ...(params.exitFrom ? { exitFrom: params.exitFrom } : {}),
        ...(params.knowledgeBroadcast ? { knowledgeBroadcast: params.knowledgeBroadcast } : {}),
      },
      timestamp: new Date().toISOString(),
      factGroupId: eventId,
      resolvedThreads: params.threadResolutions ?? [],
      dependentFactIds,
    };

    const factGroup: FactGroup = {
      id: eventId,
      causeEvent: eventId,
      changes: normalizedChanges,
    };

    // ---- 3. 沙盒推演 ----
    const consequences = this.ruleEngine.computeConsequences(event, factStore, factGroup);

    // 传播规则推演
    const proposedKnowledge = this.ruleEngine.propagateKnowledge(
      event,
      factGroup,
      factStore,
    );

    // 将 proposedKnowledge 合并到 consequences 中
    const fullConsequences: EventConsequence = {
      ...consequences,
      proposedKnowledge,
    };

    // ---- 4. 生成 simulation_report ----
    const report = this.renderSimulationReport(
      event,
      factGroup,
      fullConsequences,
      dependentFactIds,
    );

    // ---- 5. 构造 ProposalResult 并存入 ProposalStore ----
    // 读取当前 state_version 作为乐观锁期望值
    // 2026-06-18 修复：不再硬编码 'default'，用 factStore 绑定的项目 ID（每项目独立 db 文件后双保险）
    const stateVersion = factStore.getStateVersion();

    const result: ProposalResult = {
      proposalId,
      expectedStateVersion: stateVersion,
      isSafeToCommit: this.isSafeToCommit(fullConsequences),
      consequences: fullConsequences,
      simulationReportMarkdown: report,
      proposedEvent: {
        kind: event.kind,
        type: event.type,
        chapter: event.chapter,
        description: event.description,
        context: event.context,
        params: event.params,
        timestamp: event.timestamp,
        factGroupId: event.factGroupId,
        resolvedThreads: event.resolvedThreads,
        dependentFactIds: event.dependentFactIds,
      },
      dependentFactIds: event.dependentFactIds,
      dependentFactSources: dependencyResolution.sources,
      knowledgeChanges: params.knowledgeChanges ?? [],
      knowledgeHints: params.knowledgeHints,
      knowledgeBroadcast: params.knowledgeBroadcast,
    };

    // 同时保存原始 FactChange 列表（commit_event 时需要重建完整 FactGroup）
    this.proposalStore.save(result, factGroup.changes);

    return result;
  }

  // =====================================================================
  // commit_event（Phase B：确定性写入）
  // =====================================================================

  /**
   * 确认提交一个叙事事件
   *
   * Phase B 流程（SQLite 事务内）：
   *   1. 乐观锁校验（UPDATE project_state WHERE state_version = expected）
   *   2. INSERT event
   *   3. applyFactGroup（Fact 写入）
   *   4. INSERT knowledge（认知事件流写入）
   *   5. INSERT event_dependencies
   *   6. INSERT audit_log
   *   7. INSERT sync_queue（outbox）
   *
   * 推理 Fact 提升：potential → canonical（§5.5）
   *   推理规则产生的 Fact（certainty='potential'）在 commit_event 时
   *   自动提升为 canonical，并入 applyFactGroup 的 changes 数组中。
   */
  commitEvent(
    proposalId: string,
    factStore: FactStore & { getDatabase?: () => any },
    knowledgeStore: KnowledgeStore,
    eventStore: EventStore,
  ): {
    eventId: string;
    committedFactCount: number;
    committedKnowledgeCount: number;
    affectedThreads: string[];
  } {
    // 从 ProposalStore 取出 Proposal
    const proposal = this.proposalStore.get(proposalId);
    if (!proposal) {
      throw new Error(`PROPOSAL_NOT_FOUND: ${proposalId}`);
    }
    if (!proposal.isSafeToCommit) {
      throw new Error(`UNSAFE_PROPOSAL: ${proposalId} 包含 critical 或 major 规则风险，请重新 propose 修正后再提交`);
    }

    // ---- Phase B 事务 ----
    const db = factStore.getDatabase?.();
    if (!db) throw new Error('FactStore 不支持 getDatabase()，无法执行事务');

    const proposedEvent = proposal.proposedEvent;
    const chapter = proposedEvent.chapter;

    const result = db.transaction(() => {
      // Step 1: 乐观锁校验（用 factStore 绑定的项目 ID，消除 'default' 硬编码）
      const stateUpdated = factStore.tryUpdateStateVersion(undefined, proposal.expectedStateVersion);
      if (!stateUpdated) {
        throw new Error('STALE_PROPOSAL: 世界状态已变更，请重新执行 propose_event');
      }

      // Step 2: 写入事件
      const committedEvent = eventStore.create(proposedEvent);

      // Step 3: 构建 FactGroup 并写入
      // 使用 committedEvent.id（EventStore 内部生成）而非 proposal-derived eventId
      const committedEventId = committedEvent.id;
      const originalChanges = this.proposalStore.getOriginalChanges(proposal.proposalId);
      const inferredChanges = this.buildInferredFactChanges(proposal);
      const factChanges = [...originalChanges, ...inferredChanges];

      const factGroup: FactGroup = {
        id: committedEventId,
        causeEvent: committedEventId,
        changes: this.applyDefaultFactTimes(factChanges, chapter, proposedEvent.context),
      };

      const idMap = factStore.applyFactGroup(factGroup);

      // Step 3.5: Thread 持久化（§10.1 Phase B 顺序：FactGroup → Thread → Knowledge）
      // Rule Engine 沙盒推演产出的 generatedThreads 在此写入 ThreadStore。
      // 仅当 ThreadStore 已注入时执行（向后兼容 Phase 1 测试）。
      const createdThreadIds: string[] = [];
      if (this.threadStore) {
        for (const thread of proposal.consequences.generatedThreads) {
          const created = this.threadStore.create({
            type: thread.type,
            direction: thread.direction,
            severity: thread.severity,
            description: thread.description,
            closeCondition: thread.closeCondition,
            status: thread.status,
            closedBy: thread.closedBy,
            createdAtEvent: committedEventId,
            createdAtChapter: thread.createdAtChapter,
            milestones: thread.milestones,
            relatedEntities: thread.relatedEntities,
            upstreamFactIds: thread.upstreamFactIds,
            tags: thread.tags,
            arcTag: thread.arcTag,
          });
          createdThreadIds.push(created.id);
        }
      }

      // Step 3.6: ThreadResolver 双通道关闭（§6.2.1）
      // 扫描所有未关闭线索，判断新事件是否满足关闭条件。
      // 仅当 ThreadStore + ThreadResolver 均已注入时执行。
      const closedThreadIds: string[] = [];
      if (this.threadStore && this.threadResolver) {
        // 构造已提交事件的完整对象供 ThreadResolver 使用
        const committedEventFull: NarrativeEvent = {
          id: committedEventId,
          kind: proposedEvent.kind,
          type: proposedEvent.type,
          chapter: proposedEvent.chapter,
          description: proposedEvent.description,
          params: proposedEvent.params,
          context: proposedEvent.context,
          timestamp: proposedEvent.timestamp,
          factGroupId: proposedEvent.factGroupId,
          resolvedThreads: proposedEvent.resolvedThreads,
          dependentFactIds: proposedEvent.dependentFactIds,
        };

        const openThreads = this.threadStore.getOpen();
        const result = this.threadResolver.resolveThreads(
          committedEventFull,
          openThreads,
          proposal.proposedEvent.resolvedThreads,
        );

        // 按返回的 resolutions 逐条执行 ThreadStore 操作
        for (const action of result.resolutions) {
          // 校验状态转换合法性
          const thread = this.threadStore.getById(action.threadId);
          if (!thread) continue;

          const validation = this.threadResolver.validateTransition(thread, action.newStatus);
          if (!validation.valid) continue;

          // 更新状态
          this.threadStore.updateStatus(action.threadId, action.newStatus, action.closedByEventId);

          // 渐进型线索需要追加里程碑
          if (action.needsMilestone) {
            this.threadStore.addMilestone(action.threadId, {
              status: action.milestoneStatus,
              chapter: action.milestoneChapter,
              eventId: action.closedByEventId,
              description: action.milestoneDescription,
              createdAt: new Date().toISOString(),
            });
          }

          closedThreadIds.push(action.threadId);
        }
      }

      // Step 4: Knowledge 写入（认知事件流，四梯队合并 + 两阶段写入）
      // §3.6 合并优先级：knowledge_hints(3) > knowledge_broadcast(2) > propagation(1) > subject_auto(0)
      // §10.1: 第一阶段写入自动推导的 Knowledge，第二阶段写入显式操作
      // 顺序保证：显式操作 rowid > 自动推导 rowid → 检索时"取最新"自然覆盖
      let committedKnowledgeCount = 0;

      // 4a. 收集所有来源的 ProposedKnowledge（带优先级 tier）
      const collected: ProposedKnowledge[] = [];

      // tier 3（最高）：LLM 细粒度 knowledge_hints
      // 使用原始 changes（LLM 提交的顺序），不是合并推断后的 factChanges
      if (proposal.knowledgeHints) {
        collected.push(...this.buildHintKnowledge(proposal.knowledgeHints, originalChanges));
      }

      // tier 2：LLM 粗粒度 knowledge_broadcast
      if (proposal.knowledgeBroadcast) {
        collected.push(...this.buildBroadcastKnowledge(proposal.knowledgeBroadcast, originalChanges));
      }

      // tier 1：Propagation Rules（subject_auto + witness，已在 consequences.proposedKnowledge 中）
      if (proposal.consequences.proposedKnowledge) {
        collected.push(...proposal.consequences.proposedKnowledge);
      }

      // 4b. 按 (entityId, changeId) 分组，tier 高的覆盖低的
      const merged = this.mergeKnowledgeByPriority(collected);

      // 4c. 转换为 Knowledge 实体并写入
      const autoEntries: Omit<Knowledge, 'id'>[] = [];
      for (const pk of merged) {
        const factId = idMap.get(pk.changeId);
        if (!factId) continue;
        autoEntries.push({
          factId,
          entityId: pk.entityId,
          knownSince: chapter,
          source: pk.source,
          confidence: pk.confidence,
        });
      }

      if (autoEntries.length > 0) {
        knowledgeStore.batchCreate(autoEntries);
        committedKnowledgeCount += autoEntries.length;
      }

      // 第二阶段：显式认知操作（seal / restore / decay / soul_read / implant）
      // 必须晚于自动传播写入，依赖 rowid DESC 覆盖同章节自动推导结果。
      const explicitEntries = this.buildExplicitKnowledgeEntries(
        proposal.knowledgeChanges,
        committedEvent.id,
        chapter,
        factStore,
        knowledgeStore,
      );
      if (explicitEntries.length > 0) {
        knowledgeStore.batchCreate(explicitEntries);
        committedKnowledgeCount += explicitEntries.length;
      }

      // Step 4.5: 后验一致性校验（诊断性审计，非阻塞）
      // 对应架构文档 §10.1 Phase B 数据流：Knowledge → validateConsistency → audit_log
      const consistencyReport = this.ruleEngine.validateConsistency(factStore, chapter);
      // 将违规作为 warnings 附加到审计数据中
      const auditWarnings = [
        ...(consistencyReport.warnings ?? []),
        ...(consistencyReport.violations?.map(v => `[${v.severity}] ${v.ruleId}: ${v.description}`) ?? []),
      ];

      // Step 5: 依赖边写入（如果声明了 dependent_fact_ids）
      if (proposal.dependentFactIds.length > 0) {
        const stmt = db.prepare(`
          INSERT OR IGNORE INTO event_dependencies (event_id, fact_id, source)
          VALUES (?, ?, ?)
        `);
        for (const factId of proposal.dependentFactIds) {
          stmt.run(committedEvent.id, factId, proposal.dependentFactSources[factId] ?? 'llm');
        }
      }

      // Step 6: 写入 audit_log（审计追踪——LLM 提交了什么 + 一致性校验结果）
      db.prepare(`
        INSERT INTO audit_log (event_id, tool_name, raw_input_json)
        VALUES (?, 'propose_event', ?)
      `).run(committedEvent.id, JSON.stringify({
        proposalId: proposal.proposalId,
        factGroupId: factGroup.id,
        factCount: factGroup.changes.length,
        consistencyWarnings: auditWarnings.length > 0 ? auditWarnings : undefined,
      }));

      // Step 7: 写入 sync_queue（LanceDB outbox）
      // §10.1: 包含两类 operation
      //   - insert_vector：新 assert/update 产生的 canonical Fact
      //   - mark_invalid：被 retract/update 导致 validTo 被设置的旧 Fact
      const newFactIds: string[] = [];
      const invalidatedFactIds: string[] = [];

      for (const change of factChanges) {
        if (change.op === 'retract' && change.targetFactId) {
          invalidatedFactIds.push(change.targetFactId);
        } else if (change.op === 'assert' && idMap.has(change.changeId!)) {
          newFactIds.push(idMap.get(change.changeId!)!);
        } else if (change.op === 'update' && change.targetFactId) {
          invalidatedFactIds.push(change.targetFactId);
          if (change.changeId && idMap.has(change.changeId)) {
            newFactIds.push(idMap.get(change.changeId)!);
          }
        }
      }

      if (newFactIds.length > 0) {
        db.prepare(`
          INSERT INTO sync_queue (event_id, operation, fact_ids, next_retry_at)
          VALUES (?, 'insert_vector', ?, datetime('now', '+2 seconds'))
        `).run(committedEvent.id, JSON.stringify(newFactIds));
      }
      if (invalidatedFactIds.length > 0) {
        db.prepare(`
          INSERT INTO sync_queue (event_id, operation, fact_ids, next_retry_at)
          VALUES (?, 'mark_invalid', ?, datetime('now', '+2 seconds'))
        `).run(committedEvent.id, JSON.stringify(invalidatedFactIds));
      }

      const committedFactCount = factGroup.changes.length;

      return {
        eventId: committedEvent.id,
        committedFactCount,
        committedKnowledgeCount,
        // 合并创建和关闭的线索 ID（去重：同一条线索不可能同时被创建和关闭）
        affectedThreads: [...new Set([...createdThreadIds, ...closedThreadIds])],
      };
    })(); // 立即调用 transaction

    // 清理已消费的 Proposal
    this.proposalStore.remove(proposalId);

    return result;
  }

  // =====================================================================
  // 辅助方法
  // =====================================================================

  /**
   * FactChangeInput → FactChange 转换
   *
   * 通过 FACT_CHANGE_MAPPING 声明式映射表实现转换。
   * snake_case 外部字段 → camelCase 内部字段。
   */
  private convertFactChangeInput(input: FactChangeInput): FactChange {
    const opRules = FACT_CHANGE_MAPPING.opRules[input.op];
    if (!opRules) throw new Error(`未知的 op: ${input.op}`);

    // 校验必填字段
    for (const requiredField of opRules.required) {
      if (!(requiredField in input) || (input as any)[requiredField] === undefined) {
        throw new Error(`op=${input.op} 缺少必填字段: ${requiredField}`);
      }
    }

    // 字段映射
    const change: FactChange = {
      op: input.op,
      changeId: input.change_id,
    };

    if (input.op === 'retract') {
      change.targetFactId = input.target_fact_id;
    } else if (input.op === 'update') {
      change.targetFactId = input.target_fact_id;
      change.payload = {
        subject: input.subject,
        predicate: input.predicate,
        value: input.value,
        certainty: input.certainty ?? 'canonical',
      };
    } else {
      // assert
      change.payload = {
        subject: input.subject,
        predicate: input.predicate,
        value: input.value,
        certainty: input.certainty ?? 'canonical',
        relationKind: input.relation_kind,
      };
    }

    return change;
  }

  /**
   * Phase A 入口硬校验。
   * 这里拦截会污染世界状态的错误，而不是等 SQLite 外键或默认值兜底。
   */
  private validateProposeEventParams(params: ProposeEventParams, factStore: FactStore): void {
    const context = params.context ?? 'global';

    if (!params.eventType.trim()) {
      throw new Error('SCHEMA_VALIDATION_FAILED: event_type 不能为空');
    }
    if (!Number.isFinite(params.chapter) || params.chapter <= 0) {
      throw new Error('SCHEMA_VALIDATION_FAILED: chapter 必须是正数');
    }
    if (!params.subject) {
      throw new Error('SCHEMA_VALIDATION_FAILED: 业务事件必须提供 subject');
    }
    if (params.factChanges.length === 0) {
      throw new Error('SCHEMA_VALIDATION_FAILED: propose_event 至少需要一条 fact_change');
    }
    if (params.eventType === 'exit_scope' && !params.exitFrom) {
      throw new Error('SCHEMA_VALIDATION_FAILED: exit_scope 必须提供 exit_from');
    }
    if (params.exitFrom && context !== 'global') {
      throw new Error('SCOPE_FACT_MISMATCH: exit_scope 导出事件必须发生在 global context');
    }

    const seenChangeIds = new Set<string>();
    for (const input of params.factChanges) {
      if (!input.change_id) {
        throw new Error('SCHEMA_VALIDATION_FAILED: fact_changes[].change_id 必填');
      }
      if (!CHANGE_ID_PATTERN.test(input.change_id)) {
        throw new Error(`SCHEMA_VALIDATION_FAILED: change_id 格式非法: ${input.change_id}`);
      }
      if (seenChangeIds.has(input.change_id)) {
        throw new Error(`SCHEMA_VALIDATION_FAILED: change_id 重复: ${input.change_id}`);
      }
      seenChangeIds.add(input.change_id);

      if (input.op === 'update' || input.op === 'retract') {
        const targetId = input.target_fact_id;
        if (!targetId) {
          throw new Error(`SCHEMA_VALIDATION_FAILED: op=${input.op} 缺少 target_fact_id`);
        }
        const targetFact = factStore.getById(targetId);
        if (!targetFact) {
          throw new Error(`FACT_NOT_FOUND: ${targetId}`);
        }
        if (targetFact.validTo !== null) {
          throw new Error(`FACT_NOT_CURRENT: ${targetId}`);
        }
        if (targetFact.context !== context) {
          throw new Error(`SCOPE_FACT_MISMATCH: ${targetId} 属于 ${targetFact.context}，当前事件属于 ${context}`);
        }
      }
    }

    for (const factId of params.dependentFactIds ?? []) {
      const fact = factStore.getById(factId);
      if (!fact) {
        throw new Error(`FACT_NOT_FOUND: dependent_fact_ids 包含不存在的 Fact: ${factId}`);
      }
      const activeAtEvent = fact.validFrom <= params.chapter && (fact.validTo === null || fact.validTo > params.chapter);
      if (!activeAtEvent) {
        throw new Error(`FACT_NOT_CURRENT: dependent_fact_ids 包含在第 ${params.chapter} 章不可见的 Fact: ${factId}`);
      }
    }
  }

  /**
   * 从 Proposal 重建 FactChange 列表
   *
   * Phase 1 简化：ProposalResult 不直接持有原始 FactChange 列表。
   * Phase 2 完善：在 ProposalStore 中同时缓存原始 FactChangeInput[]。
   */
  private buildInferredFactChanges(proposal: ProposalResult): FactChange[] {
    // 从 EventConsequence.generatedFacts 反推 FactChange
    const changes: FactChange[] = [];

    for (const fact of proposal.consequences.generatedFacts) {
      changes.push({
        changeId: `inferred_${fact.id}`,
        op: 'assert',
        payload: {
          subject: fact.subject,
          predicate: fact.predicate,
          value: fact.value,
          certainty: 'canonical', // potential → canonical 提升
          validFrom: fact.validFrom,
          validTo: fact.validTo,
          context: fact.context,
          relationKind: fact.relationKind,
        },
      });
    }

    return changes;
  }

  /**
   * exit_scope 导出全局 Fact 时，自动记录原始作用域 Fact 的因果依赖。
   * 这条依赖不是 LLM 声明，而是 Core 为 Retcon 级联追踪强制补齐。
   */
  private resolveExitScopeDependencies(
    params: ProposeEventParams,
    changes: FactChange[],
    factStore: FactStore,
  ): string[] {
    if (params.eventType !== 'exit_scope' || !params.exitFrom) return [];

    const dependencies: string[] = [];
    for (const change of changes) {
      if (change.op !== 'assert') continue;

      const subject = change.payload?.subject;
      const predicate = change.payload?.predicate;
      if (!subject || !predicate) continue;

      const originFacts = factStore.query({
        subject,
        predicate,
        context: params.exitFrom,
        includeInherited: false,
        atChapter: params.chapter,
        certainties: ['canonical'],
      });
      if (originFacts.length > 0) {
        dependencies.push(originFacts[0]!.id);
      }
    }

    return dependencies;
  }

  /** 合并显式依赖与系统自动依赖，保持顺序并记录来源。 */
  private mergeDependentFacts(
    llmFactIds: string[],
    systemExitScopeFactIds: string[],
  ): { ids: string[]; sources: Record<string, 'llm' | 'system_exit_scope'> } {
    const seen = new Set<string>();
    const ids: string[] = [];
    const sources: Record<string, 'llm' | 'system_exit_scope'> = {};

    for (const factId of llmFactIds) {
      if (!seen.has(factId)) {
        seen.add(factId);
        ids.push(factId);
      }
      sources[factId] = 'llm';
    }

    for (const factId of systemExitScopeFactIds) {
      if (!seen.has(factId)) {
        seen.add(factId);
        ids.push(factId);
      }
      sources[factId] = 'system_exit_scope';
    }

    return { ids, sources };
  }

  /**
   * 将 knowledge_changes 转换为不可变 Knowledge 事件。
   * 这里只处理"接触记录与确信度"，不表达相信/情绪/意图等主观状态。
   */
  private buildExplicitKnowledgeEntries(
    changes: KnowledgeChangeInput[],
    eventId: string,
    chapter: number,
    factStore: FactStore,
    knowledgeStore: KnowledgeStore,
  ): Omit<Knowledge, 'id'>[] {
    const entries: Omit<Knowledge, 'id'>[] = [];

    for (const change of changes) {
      if (change.op === 'soul_read') {
        entries.push(...this.buildSoulReadKnowledgeEntries(change, eventId, chapter, factStore, knowledgeStore));
        continue;
      }

      if (change.op === 'implant') {
        entries.push(...this.buildImplantKnowledgeEntries(change, eventId, chapter, factStore, knowledgeStore));
        continue;
      }

      const targets = this.resolveKnowledgeTargets(change, chapter, factStore, knowledgeStore);
      if (targets.length === 0) {
        throw new Error(`KNOWLEDGE_TARGET_MISSING: ${change.op} 没有匹配到任何 Knowledge`);
      }

      for (const target of targets) {
        const entry = this.transformKnowledgeTarget(change.op, target, eventId, chapter);
        if (entry) entries.push(entry);
      }
    }

    return entries;
  }

  private transformKnowledgeTarget(
    op: 'seal' | 'restore' | 'decay',
    target: Knowledge,
    eventId: string,
    chapter: number,
  ): Omit<Knowledge, 'id'> | undefined {
    if (op === 'seal') {
      if (target.confidence <= 0) return undefined;
      return {
        factId: target.factId,
        entityId: target.entityId,
        knownSince: chapter,
        source: 'memory_seal',
        confidence: 0,
        previousConfidence: target.confidence,
        updatedAtEvent: eventId,
      };
    }

    if (op === 'restore') {
      if (target.source !== 'memory_seal') return undefined;
      return {
        factId: target.factId,
        entityId: target.entityId,
        knownSince: chapter,
        source: 'memory_restore',
        confidence: target.previousConfidence ?? 1,
        previousConfidence: target.confidence,
        updatedAtEvent: eventId,
      };
    }

    if (target.confidence <= 0) return undefined;
    return {
      factId: target.factId,
      entityId: target.entityId,
      knownSince: chapter,
      source: 'memory_decay',
      confidence: Math.max(0, target.confidence * 0.5),
      previousConfidence: target.confidence,
      updatedAtEvent: eventId,
    };
  }

  private buildSoulReadKnowledgeEntries(
    change: KnowledgeChangeInput,
    eventId: string,
    chapter: number,
    factStore: FactStore,
    knowledgeStore: KnowledgeStore,
  ): Omit<Knowledge, 'id'>[] {
    if (!change.source_entity_id) {
      throw new Error('SCHEMA_VALIDATION_FAILED: soul_read 必须提供 source_entity_id');
    }

    const targets = this.resolveKnowledgeTargets(change, chapter, factStore, knowledgeStore)
      .filter(k => k.confidence > 0);
    if (targets.length === 0) {
      throw new Error('KNOWLEDGE_TARGET_MISSING: soul_read 没有匹配到任何活跃 Knowledge');
    }

    return targets.map(target => ({
      factId: target.factId,
      entityId: change.source_entity_id!,
      knownSince: chapter,
      source: 'intelligence' as KnowledgeSource,
      confidence: Math.max(0, target.confidence * 0.9),
      previousConfidence: undefined,
      updatedAtEvent: eventId,
    }));
  }

  private buildImplantKnowledgeEntries(
    change: KnowledgeChangeInput,
    eventId: string,
    chapter: number,
    factStore: FactStore,
    knowledgeStore: KnowledgeStore,
  ): Omit<Knowledge, 'id'>[] {
    const factIds = this.resolveKnowledgeFactIds(change, chapter, factStore, knowledgeStore);
    if (factIds.length === 0) {
      throw new Error('KNOWLEDGE_TARGET_MISSING: implant 没有匹配到任何 Fact');
    }

    const confidence = change.implanted_confidence ?? 0.8;
    if (confidence < 0 || confidence > 1) {
      throw new Error('SCHEMA_VALIDATION_FAILED: implanted_confidence 必须在 0 到 1 之间');
    }

    return factIds.map(factId => ({
      factId,
      entityId: change.target_entity_id,
      knownSince: chapter,
      source: 'implanted' as KnowledgeSource,
      confidence,
      previousConfidence: undefined,
      updatedAtEvent: eventId,
    }));
  }

  private resolveKnowledgeTargets(
    change: KnowledgeChangeInput,
    chapter: number,
    factStore: FactStore,
    knowledgeStore: KnowledgeStore,
  ): Knowledge[] {
    const latestByFact = new Map<string, Knowledge>();
    for (const item of knowledgeStore.query({ entityId: change.target_entity_id, atChapter: chapter })) {
      if (!latestByFact.has(item.factId)) {
        latestByFact.set(item.factId, item);
      }
    }

    const factIds = new Set(this.resolveKnowledgeFactIds(change, chapter, factStore, knowledgeStore));
    return [...latestByFact.values()].filter(k => factIds.has(k.factId));
  }

  private resolveKnowledgeFactIds(
    change: KnowledgeChangeInput,
    chapter: number,
    factStore: FactStore,
    knowledgeStore: KnowledgeStore,
  ): string[] {
    if (change.fact_id_scope === 'explicit') {
      const ids = change.fact_ids ?? [];
      for (const factId of ids) {
        if (!factStore.getById(factId)) {
          throw new Error(`FACT_NOT_FOUND: knowledge_changes 引用了不存在的 Fact: ${factId}`);
        }
      }
      return ids;
    }

    const latest = knowledgeStore.query({ entityId: change.target_entity_id, atChapter: chapter });
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const item of latest) {
      if (seen.has(item.factId)) continue;
      seen.add(item.factId);

      const fact = factStore.getById(item.factId);
      if (!fact) continue;

      if (change.fact_id_scope === 'all') {
        ids.push(item.factId);
      } else if (change.fact_id_scope === 'by_predicate' && change.predicates?.includes(fact.predicate)) {
        ids.push(item.factId);
      } else if (
        change.fact_id_scope === 'by_time_range'
        && change.time_range
        && item.knownSince >= change.time_range.from
        && item.knownSince <= change.time_range.to
      ) {
        ids.push(item.factId);
      }
    }

    return ids;
  }

  /**
   * Tool 输入不暴露 valid_from 时，Fact 默认在事件章节生效。
   * 这条规则让 Phase A/Phase B 共用同一时间语义，避免落回第 1 章。
   */
  private applyDefaultFactTimes(changes: FactChange[], chapter: number, context: string): FactChange[] {
    return changes.map(change => {
      if (change.op === 'assert') {
        return {
          ...change,
          payload: {
            ...change.payload,
            validFrom: change.payload?.validFrom ?? chapter,
            validTo: change.payload?.validTo ?? null,
            context: change.payload?.context ?? context,
          },
        };
      }

      if (change.op === 'retract') {
        return {
          ...change,
          payload: {
            ...change.payload,
            validTo: change.payload?.validTo ?? chapter,
            context: change.payload?.context ?? context,
          },
        };
      }

      return {
        ...change,
        payload: {
          ...change.payload,
          validFrom: change.payload?.validFrom ?? chapter,
          context: change.payload?.context ?? context,
        },
      };
    });
  }

  /**
   * 生成事件 ID
   */
  private generateEventId(eventType: string, chapter: number): string {
    this.eventIdSeq++;
    const seq = this.eventIdSeq > 1 ? `_${String(this.eventIdSeq).padStart(2, '0')}` : '';
    return `evt_${eventType}_${chapter}${seq}`;
  }

  /**
   * 生成提案 ID
   */
  private generateProposalId(eventType: string, chapter: number): string {
    this.proposalIdSeq++;
    const seq = this.proposalIdSeq > 1 ? `_${String(this.proposalIdSeq).padStart(2, '0')}` : '';
    return `prp_${eventType}_${chapter}${seq}`;
  }

  /**
   * 判定提案是否可安全提交
   */
  private isSafeToCommit(consequences: EventConsequence): boolean {
    // 有 critical 级别的 Thread → 不安全
    const hasCritical = consequences.generatedThreads.some(t => t.severity === 'critical');
    if (hasCritical) return false;

    // 有规则违反的 major Thread → 需要作者确认
    const hasMajorViolation = consequences.generatedThreads.some(
      t => t.severity === 'major' && (t.type === 'rule_violation' || t.type === 'logic_conflict'),
    );
    if (hasMajorViolation) return false;

    return true;
  }

  /**
   * 渲染沙盒推演审计报告（Markdown）
   */
  private renderSimulationReport(
    event: NarrativeEvent,
    factGroup: FactGroup,
    consequences: EventConsequence,
    dependentFactIds?: string[],
  ): string {
    const lines: string[] = [];

    lines.push(`## 事件推演报告`);
    lines.push(``);
    lines.push(`**事件 ID**: ${(event as any).id ?? '(proposed)'}`);
    lines.push(`**章节**: ${event.chapter}`);
    lines.push(`**描述**: ${event.description}`);
    lines.push(``);

    // Fact 变更摘要
    lines.push(`### Fact 变更（${factGroup.changes.length} 条）`);
    for (const c of factGroup.changes) {
      const icon = c.op === 'assert' ? '➕' : c.op === 'retract' ? '➖' : '✏️';
      const desc = c.op === 'retract'
        ? `撤回 ${c.targetFactId}`
        : `${c.payload?.subject ?? '?'}.${c.payload?.predicate ?? '?'} = ${String(c.payload?.value ?? '?')}`;
      lines.push(`- ${icon} \`${c.op}\` ${desc}`);
    }
    lines.push(``);

    // 推理产生的 Fact
    if (consequences.generatedFacts.length > 0) {
      lines.push(`### 推理 Fact（${consequences.generatedFacts.length} 条）`);
      for (const f of consequences.generatedFacts) {
        lines.push(`- ${f.subject}.${f.predicate} = ${String(f.value)}`);
      }
      lines.push(``);
    }

    // 产生的 Thread
    if (consequences.generatedThreads.length > 0) {
      lines.push(`### 产生的叙事线索（${consequences.generatedThreads.length} 条）`);
      for (const t of consequences.generatedThreads) {
        const sevIcon = t.severity === 'critical' ? '🔴' : t.severity === 'major' ? '🟡' : '🟢';
        lines.push(`- ${sevIcon} [${t.type}] ${t.description}`);
      }
      lines.push(``);
    }

    // 知识传播
    if (consequences.proposedKnowledge && consequences.proposedKnowledge.length > 0) {
      lines.push(`### 知识传播（${consequences.proposedKnowledge.length} 条）`);
      const byEntity = new Map<string, ProposedKnowledge[]>();
      for (const pk of consequences.proposedKnowledge) {
        const arr = byEntity.get(pk.entityId) ?? [];
        arr.push(pk);
        byEntity.set(pk.entityId, arr);
      }
      for (const [entityId, items] of byEntity) {
        lines.push(`- **${entityId}**: ${items.length} 条 (${items[0]!.source}, confidence=${items[0]!.confidence})`);
      }
      lines.push(``);
    }

    // 依赖声明
    if (dependentFactIds && dependentFactIds.length > 0) {
      lines.push(`### 依赖声明`);
      for (const fid of dependentFactIds) {
        lines.push(`- 依赖 Fact: \`${fid}\``);
      }
      lines.push(``);
    }

    // 警告
    if (consequences.warnings.length > 0) {
      lines.push(`### 警告`);
      for (const w of consequences.warnings) {
        lines.push(`- ⚠️ ${w}`);
      }
      lines.push(``);
    }

    // 结论
    lines.push(`---`);
    lines.push(`**安全提交**: ${this.isSafeToCommit(consequences) ? '✅ 是' : '❌ 否（需要人工审核）'}`);
    lines.push(`**推理 Fact**: ${consequences.generatedFacts.length} 条`);
    lines.push(`**叙事线索**: ${consequences.generatedThreads.length} 条`);
    lines.push(`**知识传播**: ${consequences.proposedKnowledge?.length ?? 0} 条`);

    return lines.join('\n');
  }

  // =====================================================================
  // Phase 2D：知识传播四梯队合并
  // =====================================================================

  /**
   * 将 LLM knowledge_hints 转换为 ProposedKnowledge（tier 3，最高优先级）
   *
   * factIndex 指向 fact_changes 数组下标，省略时应用到全部 assert/update change
   */
  private buildHintKnowledge(
    hints: KnowledgeHint[],
    originalChanges: { changeId?: string; op: string }[],
  ): ProposedKnowledge[] {
    const results: ProposedKnowledge[] = [];
    for (const hint of hints) {
      if (hint.factIndex !== undefined) {
        const targetChange = originalChanges[hint.factIndex];
        if (!targetChange || targetChange.changeId === undefined) continue;
        results.push({
          entityId: hint.entityId,
          changeId: targetChange.changeId,
          source: hint.source,
          confidence: hint.confidence,
          reason: `LLM 细粒度知识提示：${hint.entityId} 以 ${hint.source} 方式知晓`,
          tier: 3,
        });
      } else {
        for (const change of originalChanges) {
          if (!change.changeId) continue;
          if (change.op === 'retract') continue;
          results.push({
            entityId: hint.entityId,
            changeId: change.changeId,
            source: hint.source,
            confidence: hint.confidence,
            reason: `LLM 细粒度知识提示：${hint.entityId} 以 ${hint.source} 方式知晓`,
            tier: 3,
          });
        }
      }
    }
    return results;
  }

  /**
   * 将 LLM knowledge_broadcast 转换为 ProposedKnowledge（tier 2）
   *
   * Phase 1 MVP：只支持 explicit_entities visibility。
   */
  private buildBroadcastKnowledge(
    broadcast: KnowledgeBroadcast,
    originalChanges: { changeId?: string; op: string }[],
  ): ProposedKnowledge[] {
    if (broadcast.visibility !== 'explicit_entities' || !broadcast.target_entity_ids) return [];

    const results: ProposedKnowledge[] = [];
    for (const entityId of broadcast.target_entity_ids) {
      for (const change of originalChanges) {
        if (!change.changeId) continue;
        if (change.op === 'retract') continue;
        results.push({
          entityId,
          changeId: change.changeId,
          source: broadcast.source,
          confidence: broadcast.confidence,
          tier: 2,
          reason: `LLM 知识广播：${entityId} 以 ${broadcast.source} 方式知晓`,
        });
      }
    }
    return results;
  }

  /**
   * 按 (entityId, changeId) 合并多条 ProposedKnowledge，tier 高的覆盖低的
   *
   * tier 定义（对应 §3.6）：
   *   3 — knowledge_hints（LLM 细粒度，最高优先级）
   *   2 — knowledge_broadcast（LLM 粗粒度广播）
   *   1 — propagation（Rule Engine 传播规则产出，如 witness）
   *   0 — subject_auto（事件主体自动知晓，最低优先级）
   *
   * 使用显式 tier 字段比较，不依赖数组追加顺序。
   */
  private mergeKnowledgeByPriority(collected: ProposedKnowledge[]): ProposedKnowledge[] {
    const merged = new Map<string, ProposedKnowledge>();
    for (const pk of collected) {
      const key = `${pk.entityId}:${pk.changeId}`;
      const existing = merged.get(key);
      if (!existing || pk.tier > existing.tier) {
        merged.set(key, pk);
      }
    }
    return [...merged.values()];
  }

  // =====================================================================
  // Tool 6: resolve_thread —— 手动关闭叙事线索
  // =====================================================================

  /**
   * 手动关闭叙事线索
   *
   * 用于 customRule 类型线索或自动关闭未能识别的情况。
   * 返回 resolution 状态和可选的 milestone_id。
   *
   * 对应架构文档 §9.2 Tool 6。
   *
   * @param params.threadId 要关闭的线索 ID
   * @param params.resolutionEventId 关闭此线索的事件 ID
   * @param params.chapter 当前章节（写入里程碑，不再是硬编码 0）
   * @param params.explanation 作者解释
   * @param params.newStatus 目标状态（未传时根据 direction 自动选择）
   */
  resolveThread(params: {
    threadId: string;
    resolutionEventId: string;
    chapter: number;
    explanation: string;
    newStatus?: import('../types.js').ThreadStatus;
  }): { status: 'resolved' | 'rejected'; milestoneId?: string; message: string } {
    if (!this.threadStore) {
      return { status: 'rejected', message: 'THREAD_STORE_NOT_CONFIGURED：当前环境未配置 ThreadStore' };
    }

    const thread = this.threadStore.getById(params.threadId);
    if (!thread) {
      return { status: 'rejected', message: `THREAD_NOT_FOUND：线索 ${params.threadId} 不存在` };
    }

    // 已关闭的线索不可再次关闭
    const OPEN_STATUSES: import('../types.js').ThreadStatus[] = [
      'UNFILLED', 'PLANTED', 'HINTED', 'PARTIALLY_REVEALED',
    ];
    if (!OPEN_STATUSES.includes(thread.status)) {
      return {
        status: 'rejected',
        message: `THREAD_ALREADY_CLOSED：线索 ${params.threadId} 当前状态为 ${thread.status}，不可再次关闭`,
      };
    }

    // 根据 direction 自动选择目标状态
    const targetStatus = params.newStatus ?? (
      thread.direction === 'retroactive' ? 'FILLED' as const : 'RESOLVED' as const
    );

    // 校验状态转换合法性（如果有 ThreadResolver，使用其校验能力）
    if (this.threadResolver) {
      // 准备虚拟事件用于转换校验
      const validation = this.threadResolver.validateTransition(thread, targetStatus);
      if (!validation.valid) {
        return {
          status: 'rejected',
          message: `INVALID_TRANSITION：${validation.reason ?? '不允许从 ${thread.status} 转为 ${targetStatus}'}`,
        };
      }
    }

    // 执行状态更新（try/catch 兜底：若 resolutionEventId 不存在，FK 约束会抛错）
    try {
      this.threadStore.updateStatus(params.threadId, targetStatus, params.resolutionEventId);
      this.threadStore.addMilestone(params.threadId, {
        status: targetStatus,
        chapter: params.chapter,
        eventId: params.resolutionEventId,
        description: params.explanation,
        createdAt: new Date().toISOString(),
      });
    } catch (err) {
      return {
        status: 'rejected',
        message: `RESOLUTION_FAILED：${String(err).includes('FOREIGN KEY') ? `事件 ${params.resolutionEventId} 不存在，请使用已提交的事件 ID` : String(err)}`,
      };
    }

    return {
      status: 'resolved',
      milestoneId: `ms_${params.threadId}_${thread.milestones.length + 2}`,
      message: `线索 ${params.threadId} 已从 ${thread.status} 手动关闭为 ${targetStatus}`,
    };
  }
}

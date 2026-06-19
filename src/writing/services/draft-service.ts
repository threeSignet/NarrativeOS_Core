// =============================================================================
// DraftService — 草案管理与沙盒推演
// =============================================================================
// 草案 CRUD、状态流转、沙盒推演、转审核。主闭环的核心服务。
//
// 设计要点：
//   - simulateDraft 成功后自动创建 ProposalView + PendingDecision（副作用）
//   - updateDraftContent 自动 expire 旧 ProposalView + PendingDecision
//   - 状态机校验在入口处，存储层不管状态合法性
//   - 提交回写（committed）由 RealCoreBridge.commitReviewedProposal 内化完成，
//     不再在本服务暴露 _mark* 方法（避免 Agent 经 service 绕过审核置终态）
//
// 对应设计文档：Phase7-Refinement.md §7.5
// =============================================================================

import { SQLiteWritingStore } from '../repositories/writing-store.js';
import { AuditService } from './audit-service.js';
import { WorkflowService } from './workflow-service.js';
import type { CoreBridgeService, SimulationResult } from '../core-bridge/core-bridge-service.js';
import type { WritingRequestContext } from './context.js';
import type {
  WritingDraft,
  DraftKind,
  DraftStatus,
  WritingProposalView,
  ProposalType,
} from '../models/types.js';
import type { SourceRef } from '../models/source-ref.js';
import { makeRequestContext } from './context.js';
import { validateDraftTransition, validateDraftSimulationReadiness } from '../models/state-machine.js';
import { buildProposalReviewData } from '../view-models/proposal-review.js';
// W11：错误模型——推演就绪失败抛结构化 WritingError（DRAFT_NOT_READY_FOR_SIMULATION），
// CoreBridge 推演失败透传 COREBRIDGE_SIMULATE_FAILED，使上层可据 code 经 ERROR_RECOVERY_MAP 映射人话
import { WritingError, WritingErrorCode } from '../errors/error-codes.js';

export class DraftService {
  private store: SQLiteWritingStore;
  private audit: AuditService;
  private coreBridge: CoreBridgeService;
  private workflow: WorkflowService;

  constructor(
    store: SQLiteWritingStore,
    audit: AuditService,
    coreBridge: CoreBridgeService,
    workflow: WorkflowService,
  ) {
    this.store = store;
    this.audit = audit;
    this.coreBridge = coreBridge;
    this.workflow = workflow;
  }

  // =========================================================================
  // Command
  // =========================================================================

  /**
   * 创建草案
   *
   * Agent 可调用：是（LOW_RISK_WRITE）
   *
   * §7.5 来源处理：sourceIdeaIds（灵感 id 便捷入口）在 service 内自动转换并并入 sourceRefs，
   * 与 ctx.sourceRefs（上下文追溯）+ params.sourceRefs（显式通用）三来源合并写库。
   */
  createDraft(
    ctx: WritingRequestContext,
    params: {
      kind: DraftKind;
      chapter?: number;
      title?: string;
      content?: string;
      /**
       * §7.5 便捷来源入口：灵感卡片 id 数组。
       * 调用方（Agent/CLI）只需传 id，service 内自动 wrap 为 {kind:'idea', id}——
       * 避免在调用处手搓 SourceRef 结构，贴合"草案源自哪些灵感"的直觉语义。
       */
      sourceIdeaIds?: string[];
      /**
       * 通用来源接口：直接传完整 SourceRef（允许 idea 以外的来源，如 draft/prose）。
       * 与 sourceIdeaIds 互补——后者覆盖最常见的"灵感→草案"路径，本参数兜底其他来源形态。
       */
      sourceRefs?: SourceRef[];
    },
  ): WritingDraft {
    // §7.5 主流程1：sourceIdeaIds → SourceRef 转换（便捷入口的语义落地）。
    // kind 须用字面量 'idea'（as const）以匹配 SourceRefKind，否则 .map 回调推断为 string 不兼容 SourceRef。
    const ideaRefs: SourceRef[] = (params.sourceIdeaIds ?? []).map(id => ({ kind: 'idea' as const, id }));

    const draft = this.store.createDraft(ctx.projectId, {
      kind: params.kind,
      chapter: params.chapter,
      title: params.title,
      // §7.5：content 缺省兜底空串（store 亦兜底，此处对齐契约字面，使 service 行为不依赖 store 内部默认）
      content: params.content ?? '',
      // §7.5 主流程2：三来源合并顺序——ctx.sourceRefs（上下文追溯链，最先）→ ideaRefs（灵感转换，居中）
      // → params.sourceRefs（显式通用，最后）。上下文追溯代表"谁触发本次操作"，灵感代表"草案直接源头"，
      // 显式来源兜底其他形态；顺序固定以保证来源链可预测、审计一致。
      sourceRefs: [...ctx.sourceRefs, ...ideaRefs, ...(params.sourceRefs ?? [])],
    });

    this.audit.record(ctx, {
      action: 'create_draft',
      targetType: 'draft',
      targetId: draft.id,
      // §7.5 副作用3：detail 记 hasSourceIdeas——反映调用方是否"显式"绑定灵感来源，
      // 区别于 ctx.sourceRefs 的隐式继承（后者经上下文透传，不代表本次 createDraft 的直接意图）。
      detail: { kind: params.kind, hasSourceIdeas: !!params.sourceIdeaIds?.length },
    });

    return draft;
  }

  /**
   * 更新草案内容
   *
   * Agent 可调用：是（LOW_RISK_WRITE）
   *
   * 如果草案状态为 simulated，修改后自动重置为 drafting（需重新推演）。
   * 自动 expire 旧的 ProposalView 和相关 PendingDecision。
   */
  updateDraftContent(
    ctx: WritingRequestContext,
    draftId: string,
    content: string,
  ): WritingDraft {
    const draft = this.store.getDraft(draftId);
    if (!draft) throw new WritingError(WritingErrorCode.WRITING_OBJECT_NOT_FOUND, `找不到草案: ${draftId}`, { objectType: 'draft', objectId: draftId });

    // 已提交的草案不能直接修改
    if (draft.status === 'committed') {
      throw new WritingError(WritingErrorCode.INVALID_STATUS_TRANSITION, '已提交的草案不能直接修改。如需变更，请使用 Retcon 通道。', { currentStatus: 'committed', attemptedAction: 'updateContent' });
    }
    if (draft.status === 'archived') {
      throw new WritingError(WritingErrorCode.INVALID_STATUS_TRANSITION, '已归档的草案不能修改', { currentStatus: 'archived', attemptedAction: 'updateContent' });
    }

    // 如果草案已推演，修改后回退到 drafting
    const newStatus: DraftStatus =
      draft.status === 'simulated' ? 'drafting' : draft.status;

    // 检查并过期活跃的审核视图
    const activePV = this.store.getActiveProposalViewForDraft(draftId);
    if (activePV) {
      this.store.expireProposalView(activePV.id);

      // 同时过期关联的 PendingDecision
      const decisions = this.store.listPendingDecisions(ctx.projectId);
      for (const d of decisions) {
        if (d.linkedObjectId === activePV.id && d.linkedObjectType === 'proposal_view') {
          try {
            this.store.resolveDecision(d.id, 'expired', '来源草案已修改，审核自动过期');
          } catch {
            // 决策可能已被并发处理，忽略
          }
        }
      }

      this.audit.record(ctx, {
        action: 'expire_proposal_view',
        targetType: 'proposal_view',
        targetId: activePV.id,
        detail: { reason: 'draft_content_changed', draftId },
      });
    }

    this.store.updateDraft(draftId, draft.version, { content, status: newStatus });

    this.audit.record(ctx, {
      action: 'update_draft_content',
      targetType: 'draft',
      targetId: draftId,
    });

    return this.store.getDraft(draftId)!;
  }

  /**
   * 标记草案为可推演
   *
   * Agent 可调用：是（REVIEW_CREATE）
   *
   * 前置条件:
   *   - draft 存在且 status === 'drafting'
   *   - draft.content 非空（至少 10 个字符）
   */
  markReadyForSimulation(
    ctx: WritingRequestContext,
    draftId: string,
  ): WritingDraft {
    const draft = this.store.getDraft(draftId);
    if (!draft) throw new WritingError(WritingErrorCode.WRITING_OBJECT_NOT_FOUND, `找不到草案: ${draftId}`, { objectType: 'draft', objectId: draftId });

    // P1-3 修复：状态机校验收敛到 state-machine（单一真相源，避免与内联检查分叉）
    validateDraftTransition(draft.status, 'ready_to_simulate', draftId);

    // W10-c：推演就绪校验同样收敛到 state-machine（单一真相源——内容阈值 ≥10、非 committed/archived 终态）。
    // 此前是内联 `content.trim().length < 10`，与 validateDraftSimulationReadiness 的阈值重复定义；
    // 现统一调用，避免两处魔数分叉。状态维度已被 validateDraftTransition 覆盖（此处 readiness 主要守内容）。
    const markReadiness = validateDraftSimulationReadiness({
      status: draft.status, content: draft.content,
    });
    if (!markReadiness.valid) {
      // W11：抛结构化 WritingError（DRAFT_NOT_READY_FOR_SIMULATION）而非普通 Error——
      // 上层（CLI / ERROR_RECOVERY_MAP）可据 code 映射"草案尚未准备好推演"人话与恢复动作
      throw new WritingError(
        WritingErrorCode.DRAFT_NOT_READY_FOR_SIMULATION,
        markReadiness.reason ?? '草案未就绪，无法标记为可推演',
      );
    }

    this.store.updateDraft(draftId, draft.version, { status: 'ready_to_simulate' });

    this.audit.record(ctx, {
      action: 'mark_draft_ready_for_simulation',
      targetType: 'draft',
      targetId: draftId,
    });

    return this.store.getDraft(draftId)!;
  }

  /**
   * 沙盒推演草案 ★ 核心方法
   *
   * Agent 可调用：是（REVIEW_CREATE — 推演后自动创建审核，不自动提交）
   *
   * 步骤:
   *   1. 获取草案，状态机校验（status === 'ready_to_simulate'）
   *   2. 提取事件信息（eventDescription, eventType, chapter, factChanges）
   *   3. 调用 CoreBridge.simulateDraftAsEvent
   *   4. 更新草案状态为 'simulated'
   *   5. 自动创建 ProposalView（副作用）
   *   6. 自动创建 PendingDecision（副作用）
   *   7. 审计
   *
   * factChanges 由调用方（Agent）构建。本方法只负责传递。
   */
  async simulateDraft(
    ctx: WritingRequestContext,
    draftId: string,
    factChanges: unknown[],
  ): Promise<{ draft: WritingDraft; proposalView: WritingProposalView }> {
    // 1. 获取和校验草案
    const draft = this.store.getDraft(draftId);
    if (!draft) throw new WritingError(WritingErrorCode.WRITING_OBJECT_NOT_FOUND, `找不到草案: ${draftId}`, { objectType: 'draft', objectId: draftId });

    // P1-3 修复：状态机校验收敛到 state-machine（单一真相源）
    validateDraftTransition(draft.status, 'simulated', draftId);
    // W10-c：推演就绪校验收敛到 state-machine（与 markReadyForSimulation 一致，单一真相源）。
    // 防御性内容校验——即便绕过 markReady 直入 simulateDraft，也阻止空/过短草案推演。
    const simReadiness = validateDraftSimulationReadiness({
      status: draft.status, content: draft.content,
    });
    if (!simReadiness.valid) {
      // W11：抛结构化 WritingError（DRAFT_NOT_READY_FOR_SIMULATION）——与 markReadyForSimulation 同码，
      // 保证"推演就绪失败"统一可被 ERROR_RECOVERY_MAP 映射
      throw new WritingError(
        WritingErrorCode.DRAFT_NOT_READY_FOR_SIMULATION,
        simReadiness.reason ?? '草案未就绪，无法推演',
      );
    }

    // 乐观锁版本号：本方法内对同一草案有两次写入（状态推进 + 失败回滚），
    // 必须用每次写入返回的新版本号更新本地副本，否则回滚会因版本过期而失败。
    let currentVersion = draft.version;

    // 2. 提取事件信息
    const eventDescription = draft.summary ?? draft.title ?? '未命名事件';
    const eventType = draft.kind === 'event' ? 'custom' : draft.kind;
    const chapter = draft.chapter;

    // 3. 调用 CoreBridge 沙盒推演
    let proposalId: string;
    let isSafeToCommit: boolean;
    let report: string;
    let simulation: SimulationResult;

    try {
      const result = await this.coreBridge.simulateDraftAsEvent(ctx.projectId, {
        draftId,
        eventDescription,
        eventType,
        chapter,
        factChanges,
      });
      proposalId = result.proposalId;
      isSafeToCommit = result.isSafeToCommit;
      report = result.report;
      simulation = result;
    } catch (err) {
      // CoreBridge 失败不修改草案状态
      this.audit.record(ctx, {
        action: 'simulate_draft',
        targetType: 'draft',
        targetId: draftId,
        result: 'failure',
        detail: { error: String(err) },
      });
      // W11：保留 CoreBridge 抛出的 WritingError 错误码（COREBRIDGE_SIMULATE_FAILED），
      // 仅附加草案上下文，不降级为普通 Error——否则 ERROR_RECOVERY_MAP 无法据 code 映射人话。
      // 非 WritingError 的意外异常也归一到 COREBRIDGE_SIMULATE_FAILED（语义即"推演失败"）。
      if (err instanceof WritingError) {
        throw new WritingError(err.code, `沙盒推演失败: ${err.message}`, err.detail);
      }
      throw new WritingError(
        WritingErrorCode.COREBRIDGE_SIMULATE_FAILED,
        `沙盒推演失败: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // 4-6. 更新草案状态 + 创建审核视图 + 待确认事项（原子性保障，§7.11.4）
    // 任一步失败则回滚 draft 状态到 ready_to_simulate，避免悬挂在 simulated 但无 ProposalView 的状态
    let pv: WritingProposalView;
    try {
      // 4. 更新草案状态（乐观锁：用 currentVersion 校验并推进，回写后同步本地版本号）
      currentVersion = this.store.updateDraft(draftId, currentVersion, { status: 'simulated' }).newVersion;

      // 5. 自动创建审核视图
      pv = this.store.createProposalView(ctx.projectId, {
        proposalType: 'event' as ProposalType,
        sourceDraftId: draftId,
        // W14：PV 来源追溯——本 PV 由该草案触发（直接来源；上游 idea/blueprint 链由 draft.sourceRefs 自带，不在此冗余）
        sourceRefs: [{ kind: 'draft', id: draftId }],
      });

      // W7：生成 Proposal Review 四件套（factDiff / involvedEntityIds / ruleWarnings / humanSummary）。
      // 实体 id→显示名：用本项目 entity sketches 的 coreEntityId→displayName 映射解析，
      // 保证 §9.1 不泄漏 ent_ 前缀（未注册实体回退占位）。
      const sketchNameMap = new Map<string, string>();
      for (const s of this.store.listEntitySketches(ctx.projectId)) {
        if (s.coreEntityId) sketchNameMap.set(s.coreEntityId, s.displayName);
      }
      const reviewData = buildProposalReviewData({
        eventDescription,
        factChanges,
        simulation,
        resolveEntityName: (id) => sketchNameMap.get(id),
      });

      this.store.updateProposalView(pv.id, {
        coreProposalId: proposalId,
        coreBridgeResult: { proposalId, isSafeToCommit, report },
        humanSummary: reviewData.humanSummary,
        factDiff: reviewData.factDiff,
        involvedEntityIds: reviewData.involvedEntityIds,
        ruleWarnings: reviewData.ruleWarnings,
        // W9：持久化本次推演的原始输入，供 simulateProposal 重新推演时按相同参数重调 propose_event。
        // factDiff/ruleWarnings 是有损投影（丢 ent_ 主体、change_id），无法反推 factChanges，
        // 故此处把原始 DSL 原文存下——这是重新推演的唯一可靠来源。
        simulationInputs: {
          eventDescription,
          eventType,
          chapter,
          factChanges,
        },
        status: 'open', // 始终创建审核视图（有警告也展示给作者决定）
      });

      // 6. 自动创建待确认事项
      await this.workflow.createPendingDecision(
        makeRequestContext({
          projectId: ctx.projectId,
          trigger: 'draft_conversion',
          sourceRefs: [{
            kind: 'draft',
            id: draftId,
            excerpt: eventDescription,
          }],
        }),
        {
          kind: 'confirm_proposal',
          title: `确认提交事件: ${eventDescription}`,
          description: isSafeToCommit
            ? '推演通过，可以提交'
            : '推演发现警告，请查看后决定',
          linkedObjectId: pv.id,
          linkedObjectType: 'proposal_view',
        },
      );
    } catch (postProcessErr) {
      // 回滚 draft 状态到可推演，使其能重新 simulate（§7.11.4 恢复路径）。
      // 回滚写本身也可能失败（如乐观锁版本冲突）——必须忠实把成败记入 audit：
      // 否则 audit 误导为"已回滚到 ready_to_simulate"，而 draft 实际仍停在 simulated，
      // 构成无记录可追溯的隐藏不一致态（"不能有隐藏 bug"）。回滚失败不阻断（已尽力恢复），
      // 但 audit 明确标注 failed + 原因，供运维定位。
      let rollbackResult: 'ready_to_simulate' | 'failed' = 'ready_to_simulate';
      let rollbackError: string | undefined;
      try {
        currentVersion = this.store.updateDraft(draftId, currentVersion, { status: 'ready_to_simulate' }).newVersion;
      } catch (rollbackErr) {
        rollbackResult = 'failed';
        rollbackError = rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
      }
      this.audit.record(ctx, {
        action: 'simulate_draft',
        targetType: 'draft',
        targetId: draftId,
        result: 'partial',
        detail: {
          error: String(postProcessErr),
          rollback: rollbackResult,
          ...(rollbackError !== undefined ? { rollbackError } : {}),
        },
      });
      // W11：保留 store/状态机抛出的 WritingError 错误码（如 VERSION_CONFLICT）——
      // 后处理阶段会调 updateDraft（乐观锁）/ createProposalView，可能抛 WritingError。
      // 仅附加上下文，不降级为普通 Error，使 ERROR_RECOVERY_MAP 仍能据 code 映射。
      const postCtx = '沙盒推演后处理失败，已回滚草案状态';
      if (postProcessErr instanceof WritingError) {
        throw new WritingError(postProcessErr.code, `${postCtx}: ${postProcessErr.message}`, postProcessErr.detail);
      }
      throw new WritingError(
        WritingErrorCode.COREBRIDGE_SIMULATE_FAILED,
        `${postCtx}: ${postProcessErr instanceof Error ? postProcessErr.message : String(postProcessErr)}`,
      );
    }

    // 7. 审计
    this.audit.record(ctx, {
      action: 'simulate_draft',
      targetType: 'draft',
      targetId: draftId,
      result: 'success',
      detail: { proposalId },
    });

    return {
      draft: this.store.getDraft(draftId)!,
      proposalView: this.store.getProposalView(pv.id)!,
    };
  }

  /**
   * 废弃草案
   *
   * Agent 可调用：是（LOW_RISK_WRITE）
   *
   * 已提交的草案不能废弃（需走 Retcon）。
   */
  abandonDraft(ctx: WritingRequestContext, draftId: string): void {
    const draft = this.store.getDraft(draftId);
    if (!draft) throw new WritingError(WritingErrorCode.WRITING_OBJECT_NOT_FOUND, `找不到草案: ${draftId}`, { objectType: 'draft', objectId: draftId });

    if (draft.status === 'committed') {
      throw new WritingError(WritingErrorCode.INVALID_STATUS_TRANSITION, '已提交的草案不能废弃。如需修改，请使用 Retcon 通道。', { currentStatus: 'committed', attemptedAction: 'abandon' });
    }

    // 过期关联的审核视图和待确认事项
    const activePV = this.store.getActiveProposalViewForDraft(draftId);
    if (activePV) {
      this.store.expireProposalView(activePV.id);

      const decisions = this.store.listPendingDecisions(ctx.projectId);
      for (const d of decisions) {
        if (d.linkedObjectId === activePV.id && d.linkedObjectType === 'proposal_view') {
          try {
            this.store.resolveDecision(d.id, 'expired', '草案已废弃');
          } catch { /* 忽略并发冲突 */ }
        }
      }
    }

    this.store.updateDraft(draftId, draft.version, { status: 'archived' });

    this.audit.record(ctx, {
      action: 'abandon_draft',
      targetType: 'draft',
      targetId: draftId,
    });
  }

  // 注：CoreBridge 提交成功/失败后的草案状态回写已内化于 RealCoreBridge
  // （commitReviewedProposal 内直接以乐观锁更新 writing_drafts，并落地审计）。
  // 早期设计 §7.7 规划的 _markCommitted / _markCommitFailed 内部方法已移除——
  // 它们是 private 且无任何调用方（跨类无法调用 private，设计自相矛盾），
  // 属确认的死代码。提交失败时草案保持原状态（可重新推演/提交），失败信号由
  // ProposalView.status='commit_failed' 承载（§7.11.2 路径A）。

  // =========================================================================
  // Query
  // =========================================================================

  /**
   * 列出草案
   */
  listDrafts(
    ctx: WritingRequestContext,
    filter?: { status?: DraftStatus; kind?: DraftKind },
  ): WritingDraft[] {
    return this.store.listDrafts(ctx.projectId, filter);
  }

  /**
   * 获取单个草案
   */
  getDraft(ctx: WritingRequestContext, draftId: string): WritingDraft {
    const draft = this.store.getDraft(draftId);
    if (!draft) throw new WritingError(WritingErrorCode.WRITING_OBJECT_NOT_FOUND, `找不到草案: ${draftId}`, { objectType: 'draft', objectId: draftId });
    return draft;
  }
}

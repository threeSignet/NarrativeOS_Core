// =============================================================================
// DraftService — 草案管理与沙盒推演
// =============================================================================
// 草案 CRUD、状态流转、沙盒推演、转审核。主闭环的核心服务。
//
// 设计要点：
//   - simulateDraft 成功后自动创建 ProposalView + PendingDecision（副作用）
//   - updateDraftContent 自动 expire 旧 ProposalView + PendingDecision
//   - 状态机校验在入口处，存储层不管状态合法性
//   - _markCommitted / _markCommitFailed 内部方法，仅 CoreBridge 调用
//
// 对应设计文档：Phase7-Refinement.md §7.5
// =============================================================================

import { SQLiteWritingStore } from '../repositories/writing-store.js';
import { AuditService } from './audit-service.js';
import { WorkflowService } from './workflow-service.js';
import type { CoreBridgeService } from '../core-bridge/core-bridge-service.js';
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
import { validateDraftTransition } from '../models/state-machine.js';

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
   */
  createDraft(
    ctx: WritingRequestContext,
    params: {
      kind: DraftKind;
      chapter?: number;
      title?: string;
      content?: string;
      sourceRefs?: SourceRef[];
    },
  ): WritingDraft {
    const draft = this.store.createDraft(ctx.projectId, {
      kind: params.kind,
      chapter: params.chapter,
      title: params.title,
      content: params.content,
      sourceRefs: [...ctx.sourceRefs, ...(params.sourceRefs ?? [])],
    });

    this.audit.record(ctx, {
      action: 'create_draft',
      targetType: 'draft',
      targetId: draft.id,
      detail: { kind: params.kind },
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
    if (!draft) throw new Error(`找不到草案: ${draftId}`);

    // 已提交的草案不能直接修改
    if (draft.status === 'committed') {
      throw new Error('已提交的草案不能直接修改。如需变更，请使用 Retcon 通道。');
    }
    if (draft.status === 'archived') {
      throw new Error('已归档的草案不能修改');
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

    this.store.updateDraft(draftId, { content, status: newStatus });

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
    if (!draft) throw new Error(`找不到草案: ${draftId}`);

    // P1-3 修复：状态机校验收敛到 state-machine（单一真相源，避免与内联检查分叉）
    validateDraftTransition(draft.status, 'ready_to_simulate', draftId);

    // 内容校验
    if (!draft.content || draft.content.trim().length < 10) {
      throw new Error('草案内容过短（至少需要 10 个字符才能推演）');
    }

    this.store.updateDraft(draftId, { status: 'ready_to_simulate' });

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
    if (!draft) throw new Error(`找不到草案: ${draftId}`);

    // P1-3 修复：状态机校验收敛到 state-machine（单一真相源）
    validateDraftTransition(draft.status, 'simulated', draftId);
    if (!draft.content || draft.content.trim().length < 10) {
      throw new Error('草案内容过短，无法推演');
    }

    // 2. 提取事件信息
    const eventDescription = draft.summary ?? draft.title ?? '未命名事件';
    const eventType = draft.kind === 'event' ? 'custom' : draft.kind;
    const chapter = draft.chapter;

    // 3. 调用 CoreBridge 沙盒推演
    let proposalId: string;
    let isSafeToCommit: boolean;
    let report: string;

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
    } catch (err) {
      // CoreBridge 失败不修改草案状态
      this.audit.record(ctx, {
        action: 'simulate_draft',
        targetType: 'draft',
        targetId: draftId,
        result: 'failure',
        detail: { error: String(err) },
      });
      throw new Error(
        `沙盒推演失败: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // 4-6. 更新草案状态 + 创建审核视图 + 待确认事项（原子性保障，§7.11.4）
    // 任一步失败则回滚 draft 状态到 ready_to_simulate，避免悬挂在 simulated 但无 ProposalView 的状态
    let pv: WritingProposalView;
    try {
      // 4. 更新草案状态
      this.store.updateDraft(draftId, { status: 'simulated' });

      // 5. 自动创建审核视图
      pv = this.store.createProposalView(ctx.projectId, {
        proposalType: 'event' as ProposalType,
        sourceDraftId: draftId,
      });

      this.store.updateProposalView(pv.id, {
        coreProposalId: proposalId,
        coreBridgeResult: { proposalId, isSafeToCommit, report },
        humanSummary: eventDescription,
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
      // 回滚 draft 状态到可推演，使其能重新 simulate（§7.11.4 恢复路径）
      try { this.store.updateDraft(draftId, { status: 'ready_to_simulate' }); } catch { /* 回滚失败不阻断，已记 audit */ }
      this.audit.record(ctx, {
        action: 'simulate_draft',
        targetType: 'draft',
        targetId: draftId,
        result: 'partial',
        detail: { error: String(postProcessErr), rollback: 'ready_to_simulate' },
      });
      throw new Error(
        `沙盒推演后处理失败，已回滚草案状态: ${postProcessErr instanceof Error ? postProcessErr.message : String(postProcessErr)}`,
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
    if (!draft) throw new Error(`找不到草案: ${draftId}`);

    if (draft.status === 'committed') {
      throw new Error('已提交的草案不能废弃。如需修改，请使用 Retcon 通道。');
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

    this.store.updateDraft(draftId, { status: 'archived' });

    this.audit.record(ctx, {
      action: 'abandon_draft',
      targetType: 'draft',
      targetId: draftId,
    });
  }

  // =========================================================================
  // 内部方法（CoreBridge 专用，Agent 禁止调用）
  // =========================================================================

  /**
   * CoreBridge 提交成功后回写草案状态
   *
   * @internal — 仅 CoreBridge 调用
   */
  private _markCommitted(draftId: string, _coreEventId: string): void {
    this.store.updateDraft(draftId, { status: 'committed' });
  }

  /**
   * CoreBridge 提交失败后回写错误状态
   *
   * @internal — 仅 CoreBridge 调用
   */
  private _markCommitFailed(draftId: string, _error: unknown): void {
    this.store.updateDraft(draftId, { status: 'error' });
  }

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
    if (!draft) throw new Error(`找不到草案: ${draftId}`);
    return draft;
  }
}

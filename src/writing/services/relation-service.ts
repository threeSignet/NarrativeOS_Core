// =============================================================================
// Phase 8 · RelationService——关系候选/创作关联/检测提示的业务逻辑
// =============================================================================
// 职责：
//   - 检测提示的创建/确认/忽略
//   - 关系候选的创建/修改/提交到 Core/合并/废弃
//   - 创作关联的创建/归档
//   - world 层候选经 propose_event → CoreBridge 提交到 Core（成为 Fact）
//
// 核心不变式（Feature-Spec §8）：
//   - 关系提示不自动成为候选
//   - 候选关系不自动成为 Core Fact
//   - 非 world 层关系不能进 Proposal Review
//   - 已提交关系不能直接编辑，只能走 Retcon
//
// 设计文档：Feature-Spec §8.1-§8.8
// =============================================================================

import type { SQLiteWritingStore } from '../repositories/writing-store.js';
import type { AuditService } from './audit-service.js';
import type { WorkflowService } from './workflow-service.js';
import type { CoreBridgeService } from '../core-bridge/core-bridge-service.js';
import type { WritingRequestContext } from './context.js';
import { WritingError, WritingErrorCode } from '../errors/error-codes.js';
import type {
  WritingRelationCandidate, AuthoringAssociation, RelationDetectionHint,
  RelationLayer, RelationDirection, WritingObjectRef, CoreRelationRef,
} from '../models/types.js';
import type { SourceRef } from '../models/source-ref.js';

export class RelationService {
  constructor(
    private store: SQLiteWritingStore,
    private audit: AuditService,
    private workflow: WorkflowService,
    private coreBridge?: CoreBridgeService,
  ) {}

  // ===========================================================================
  // 检测提示
  // ===========================================================================

  /** 创建关系检测提示（Agent/系统检测到潜在关系时调用） */
  createRelationHints(
    ctx: WritingRequestContext,
    hints: Array<{
      sourceEntityId: string;
      targetEntityId: string;
      relationTypeId?: string;
      summary: string;
      confidence?: number;
      possibleLayer?: RelationLayer;
      sourceRefs?: string[];
    }>,
  ): RelationDetectionHint[] {
    const result: RelationDetectionHint[] = [];
    for (const h of hints) {
      const hint = this.store.createRelationHint(ctx.projectId, h);
      result.push(hint);
    }
    this.audit.record(ctx, {
      action: 'detect_relation_hints',
      targetType: 'relation_hint',
      detail: { count: result.length },
    });
    return result;
  }

  /** 确认检测提示 → 转为关系候选 */
  confirmHintToCandidate(
    ctx: WritingRequestContext,
    hintId: string,
    params: {
      relationTypeId: string;
      layer?: RelationLayer;
      direction?: RelationDirection;
      strength?: number;
    },
  ): WritingRelationCandidate {
    const hint = this.store.getRelationHint(hintId);
    if (!hint) throw new WritingError(WritingErrorCode.WRITING_OBJECT_NOT_FOUND, `找不到关系检测提示: ${hintId}`, { objectType: 'relation_hint', objectId: hintId });
    if (hint.status !== 'new') throw new WritingError(WritingErrorCode.INVALID_STATUS_TRANSITION, `提示已处理（状态: ${hint.status}）`, { currentStatus: hint.status });

    // 创建候选
    const candidate = this.store.createRelationCandidate(ctx.projectId, {
      sourceEntityId: hint.sourceEntityId,
      targetEntityId: hint.targetEntityId,
      relationTypeId: params.relationTypeId,
      layer: params.layer ?? hint.possibleLayer,
      direction: params.direction,
      strength: params.strength,
      sourceRefs: [{ kind: 'relation_hint', id: hintId }],
    });

    // 更新提示状态
    this.store.updateRelationHint(hintId, { status: 'converted_to_candidate' });

    this.audit.record(ctx, {
      action: 'confirm_relation_hint',
      targetType: 'relation_candidate',
      targetId: candidate.id,
      detail: { hintId, candidateId: candidate.id },
    });

    return candidate;
  }

  /** 忽略检测提示 */
  ignoreHint(ctx: WritingRequestContext, hintId: string): void {
    const hint = this.store.getRelationHint(hintId);
    if (!hint) throw new WritingError(WritingErrorCode.WRITING_OBJECT_NOT_FOUND, `找不到关系检测提示: ${hintId}`, { objectType: 'relation_hint' });
    this.store.updateRelationHint(hintId, { status: 'ignored' });
    this.audit.record(ctx, { action: 'ignore_relation_hint', targetType: 'relation_hint', targetId: hintId });
  }

  // ===========================================================================
  // 关系候选
  // ===========================================================================

  /** 直接创建关系候选（不经提示） */
  createRelationCandidate(
    ctx: WritingRequestContext,
    params: {
      sourceEntityId: string;
      targetEntityId: string;
      relationTypeId: string;
      layer?: RelationLayer;
      direction?: RelationDirection;
      strength?: number;
    },
  ): WritingRelationCandidate {
    const candidate = this.store.createRelationCandidate(ctx.projectId, params);
    this.audit.record(ctx, {
      action: 'create_relation_candidate',
      targetType: 'relation_candidate', targetId: candidate.id,
      detail: { source: params.sourceEntityId, target: params.targetEntityId, type: params.relationTypeId },
    });
    return candidate;
  }

  /** 列出关系候选 */
  listRelationCandidates(
    ctx: WritingRequestContext,
    filter?: { status?: string; layer?: string },
  ): WritingRelationCandidate[] {
    return this.store.listRelationCandidates(ctx.projectId, filter);
  }

  /** 推进候选状态（drafted → submitted） */
  advanceRelationCandidate(
    ctx: WritingRequestContext,
    id: string,
    targetStatus: 'drafted' | 'submitted',
  ): WritingRelationCandidate {
    const candidate = this.store.getRelationCandidate(id);
    if (!candidate) throw new WritingError(WritingErrorCode.WRITING_OBJECT_NOT_FOUND, `找不到关系候选: ${id}`, { objectType: 'relation_candidate' });
    this.store.updateRelationCandidate(id, candidate.version, { status: targetStatus });
    this.audit.record(ctx, { action: 'advance_relation_candidate', targetType: 'relation_candidate', targetId: id, detail: { to: targetStatus } });
    return this.store.getRelationCandidate(id)!;
  }

  /**
   * 提交 world 层关系候选到 Core（经 propose_event 沙盒推演 → ProposalView → PendingDecision）。
   *
   * 完整流程（Feature-Spec §8.5）：
   *   1. 校验 layer === 'world'（非 world 层不能提交）
   *   2. 校验两端实体已注册 Core（有 coreEntityId）
   *   3. 从关系类型映射出 Core predicate（BlueprintTypeDef.coreMapping.predicate）
   *   4. 构建 fact_changes（source → target 的 entity_ref 断言）
   *   5. 调 coreBridge.simulateDraftAsEvent 沙盒推演
   *   6. 推进状态 candidate → submitted
   *   7. 创建 ProposalView + PendingDecision（等作者确认后才真正 commit_event）
   *
   * 注意：本方法做沙盒推演 + 生成待审核 PV，真正的 commit_event 在作者确认后触发。
   * 确认后调 confirmRelationCommit 完成提交。
   */
  async submitRelationCandidate(
    ctx: WritingRequestContext,
    id: string,
  ): Promise<{ proposalViewId?: string; isSafeToCommit?: boolean }> {
    const candidate = this.store.getRelationCandidate(id);
    if (!candidate) throw new WritingError(WritingErrorCode.WRITING_OBJECT_NOT_FOUND, `找不到关系候选: ${id}`, { objectType: 'relation_candidate' });

    // 不变式：非 world 层不能提交
    if (candidate.layer !== 'world') {
      throw new WritingError(
        WritingErrorCode.INVALID_STATUS_TRANSITION,
        `非 world 层关系（${candidate.layer}）不能提交到 Core`,
        { layer: candidate.layer },
      );
    }
    // 不变式：已提交的不能重复提交
    if (candidate.status === 'committed') {
      throw new WritingError(WritingErrorCode.INVALID_STATUS_TRANSITION, '关系已提交', { currentStatus: 'committed' });
    }

    // 校验两端实体已注册 Core
    const sourceSketch = this.store.getEntitySketch(candidate.sourceEntityId);
    const targetSketch = this.store.getEntitySketch(candidate.targetEntityId);
    if (!sourceSketch?.coreEntityId || !targetSketch?.coreEntityId) {
      throw new WritingError(
        WritingErrorCode.WRITING_STORE_ERROR,
        '关系两端实体必须已注册到 Core（有 coreEntityId）',
        { sourceRegistered: !!sourceSketch?.coreEntityId, targetRegistered: !!targetSketch?.coreEntityId },
      );
    }

    // 从蓝图查关系类型 → Core predicate 映射
    const bp = this.store.getLatestBlueprint(ctx.projectId) as
      | { relationTypes?: Array<{ id: string; label: string; coreMapping?: { predicate?: string; relationKind?: string } }> }
      | undefined;
    const rt = bp?.relationTypes?.find(r => r.id === candidate.relationTypeId);
    // predicate 优先用蓝图映射，没有则用 relationTypeId 本身作 predicate
    const predicate = rt?.coreMapping?.predicate ?? candidate.relationTypeId;

    // 构建 fact_changes（source → target 的 entity_ref 断言）
    const factChanges = [{
      change_id: `rel_${id}`,
      op: 'assert',
      subject: sourceSketch.coreEntityId,
      predicate,
      value: { type: 'entity_ref', entityId: targetSketch.coreEntityId },
    }];

    // 沙盒推演
    if (!this.coreBridge) {
      throw new WritingError(WritingErrorCode.WRITING_STORE_ERROR, 'CoreBridge 未注入，无法提交关系');
    }
    const simResult = await this.coreBridge.simulateDraftAsEvent(ctx.projectId, {
      draftId: `relation_${id}`,
      eventDescription: `关系提交：${sourceSketch.displayName} 与 ${targetSketch.displayName} 的 ${rt?.label ?? candidate.relationTypeId} 关系`,
      eventType: 'relation_assert',
      chapter: candidate.temporalScope?.fromChapter ?? 1,
      factChanges,
    });

    // 推进到 submitted
    this.store.updateRelationCandidate(id, candidate.version, { status: 'submitted' });

    // 创建 ProposalView（让作者审核 factDiff）——用 sourceRefs 关联回关系候选
    const pv = this.store.createProposalView(ctx.projectId, {
      proposalType: 'event',
      sourceRefs: [{ kind: 'relation_hint' as never, id } as never],
    });
    this.store.updateProposalView(pv.id, {
      status: 'open',
      humanSummary: `${sourceSketch.displayName} 与 ${targetSketch.displayName} 建立关系：${rt?.label ?? candidate.relationTypeId}`,
      simulationInputs: {
        eventDescription: `关系提交`,
        eventType: 'relation_assert',
        chapter: candidate.temporalScope?.fromChapter ?? 1,
        factChanges,
      },
      coreBridgeResult: { proposalId: simResult.proposalId, isSafeToCommit: simResult.isSafeToCommit },
    });

    // 创建待确认事项（作者确认后才 commit）
    this.workflow.createPendingDecision(ctx, {
      kind: 'confirm_proposal',
      title: `确认关系：${sourceSketch.displayName} - ${rt?.label ?? candidate.relationTypeId} → ${targetSketch.displayName}`,
      linkedObjectId: pv.id,
      linkedObjectType: 'proposal_view',
    });

    this.audit.record(ctx, {
      action: 'submit_relation_candidate',
      targetType: 'relation_candidate', targetId: id,
      detail: { pvId: pv.id, isSafe: simResult.isSafeToCommit, predicate },
    });

    return { proposalViewId: pv.id, isSafeToCommit: simResult.isSafeToCommit };
  }

  /**
   * 确认关系提交——作者在 Proposal Review 确认后调用，执行真正的 commit_event。
   *
   * 从 ProposalView 取 coreProposalId → commitReviewedProposal → status → committed + 存 coreRefs。
   */
  async confirmRelationCommit(
    ctx: WritingRequestContext,
    relationCandidateId: string,
    proposalViewId: string,
  ): Promise<{ success: boolean; coreEventId?: string }> {
    const candidate = this.store.getRelationCandidate(relationCandidateId);
    if (!candidate) throw new WritingError(WritingErrorCode.WRITING_OBJECT_NOT_FOUND, `找不到关系候选: ${relationCandidateId}`);

    const pv = this.store.getProposalView(proposalViewId);
    if (!pv) throw new WritingError(WritingErrorCode.WRITING_OBJECT_NOT_FOUND, `找不到审核视图: ${proposalViewId}`);

    // 批准 + 提交到 Core
    this.store.updateProposalView(proposalViewId, {
      status: 'author_approved',
      authorDecision: '确认提交',
    });

    if (!this.coreBridge) throw new WritingError(WritingErrorCode.WRITING_STORE_ERROR, 'CoreBridge 未注入');
    const result = await this.coreBridge.commitReviewedProposal(ctx, proposalViewId);

    if (result.success) {
      // 推进候选状态 → committed + 存 coreRefs
      const currentCandidate = this.store.getRelationCandidate(relationCandidateId)!;
      this.store.updateRelationCandidate(relationCandidateId, currentCandidate.version, {
        status: 'committed',
        coreRefs: [{
          factId: result.coreEventId ?? '',
          predicate: pv.coreProposalId ?? '',
          relationKind: '',
        }],
      });

      this.audit.record(ctx, {
        action: 'commit_relation_candidate',
        targetType: 'relation_candidate', targetId: relationCandidateId,
        detail: { coreEventId: result.coreEventId },
      });
    }

    return { success: result.success, coreEventId: result.coreEventId };
  }

  /** 合并两个候选关系（source 合并到 target） */
  mergeRelationCandidates(
    ctx: WritingRequestContext,
    sourceId: string,
    targetId: string,
  ): WritingRelationCandidate {
    const source = this.store.getRelationCandidate(sourceId);
    const target = this.store.getRelationCandidate(targetId);
    if (!source || !target) throw new WritingError(WritingErrorCode.WRITING_OBJECT_NOT_FOUND, '合并关系候选需要两个都存在');
    if (source.status === 'committed' || target.status === 'committed') {
      throw new WritingError(WritingErrorCode.INVALID_STATUS_TRANSITION, '已提交的关系不能合并（需走 Retcon）');
    }

    // source 标记为 archived
    this.store.updateRelationCandidate(sourceId, source.version, { status: 'archived' });
    this.audit.record(ctx, {
      action: 'merge_relation_candidate',
      targetType: 'relation_candidate', targetId,
      detail: { mergedFrom: sourceId },
    });
    return this.store.getRelationCandidate(targetId)!;
  }

  /** 废弃关系候选 */
  deprecateRelationCandidate(ctx: WritingRequestContext, id: string): void {
    const candidate = this.store.getRelationCandidate(id);
    if (!candidate) throw new WritingError(WritingErrorCode.WRITING_OBJECT_NOT_FOUND, `找不到关系候选: ${id}`);
    if (candidate.status === 'committed') {
      throw new WritingError(WritingErrorCode.INVALID_STATUS_TRANSITION, '已提交的关系不能废弃（需走 Retcon）');
    }
    this.store.updateRelationCandidate(id, candidate.version, { status: 'archived' });
    this.audit.record(ctx, { action: 'archive_relation_candidate', targetType: 'relation_candidate', targetId: id });
  }

  // ===========================================================================
  // 创作关联
  // ===========================================================================

  /** 创建创作关联（不进 Core） */
  createAssociation(
    ctx: WritingRequestContext,
    params: {
      sourceRef: WritingObjectRef;
      targetRef: WritingObjectRef;
      label: string;
      kind?: AuthoringAssociation['kind'];
    },
  ): AuthoringAssociation {
    const assoc = this.store.createAssociation(ctx.projectId, params);
    this.audit.record(ctx, {
      action: 'create_association',
      targetType: 'association', targetId: assoc.id,
    });
    return assoc;
  }

  /** 列出创作关联 */
  listAssociations(ctx: WritingRequestContext): AuthoringAssociation[] {
    return this.store.listAssociations(ctx.projectId);
  }

  /** 归档创作关联 */
  archiveAssociation(ctx: WritingRequestContext, id: string): void {
    const assoc = this.store.getAssociation(id);
    if (!assoc) throw new WritingError(WritingErrorCode.WRITING_OBJECT_NOT_FOUND, `找不到创作关联: ${id}`);
    this.store.updateAssociation(id, { status: 'archived' });
    this.audit.record(ctx, { action: 'archive_association', targetType: 'association', targetId: id });
  }
}

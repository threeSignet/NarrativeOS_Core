// =============================================================================
// EntityService — 实体发现与管理
// =============================================================================
// 管理写作层实体草图：从文本发现提示 → 候选确认 → 注册审核 → Core 注册。
//
// 设计要点：
//   - detectEntityHints 接收已提取的实体列表，创建 status='hint' 草图
//   - promoteHintToSketch 将 hint 转为 candidate（需作者确认）
//   - approveCandidate 批准候选，自动创建 PendingDecision（副作用）
//   - deprecateEntitySketch 废弃实体草图（已注册实体需走 Retcon）
//   - mergeSketches 合并候选实体（已注册的不能合并）
//   - 注册回写（registered/error）由 RealCoreBridge.registerReviewedEntity 内化完成，
//     不再在本服务暴露 _mark* 方法（避免 Agent 经 service 绕过审核置终态）
//
// 对应设计文档：Phase7-Refinement.md §7.6
// =============================================================================

import { SQLiteWritingStore } from '../repositories/writing-store.js';
import { AuditService } from './audit-service.js';
import { WorkflowService } from './workflow-service.js';
import type { WritingRequestContext } from './context.js';
import type {
  WritingEntitySketch,
  EntitySketchStatus,
} from '../models/types.js';
import type { SourceRef } from '../models/source-ref.js';
import { makeRequestContext } from './context.js';
import { validateEntitySketchTransition } from '../models/state-machine.js';
import { WritingError, WritingErrorCode } from '../errors/error-codes.js';

export class EntityService {
  private store: SQLiteWritingStore;
  private audit: AuditService;
  private workflow: WorkflowService;

  constructor(
    store: SQLiteWritingStore,
    audit: AuditService,
    workflow: WorkflowService,
  ) {
    this.store = store;
    this.audit = audit;
    this.workflow = workflow;
  }

  // =========================================================================
  // Command
  // =========================================================================

  /**
   * 从文本生成实体发现提示
   *
   * Agent 可调用：是（REVIEW_CREATE — 创建提示供作者确认）
   *
   * 此方法接收 Agent 已经提取好的实体名称和类型，创建 hint 草图。
   * 实际的 NLP 实体提取由 Agent 在 ReAct 循环中完成。
   *
   * §7.6 主流程3：返回值在 WritingEntitySketch 上附加 duplicateSuspected 派生标记——
   * 已存在同名（candidate/approved/registered）实体时为 true，但状态仍保持 'hint'（不阻止创建，由作者决定合并）。
   */
  detectEntityHints(
    ctx: WritingRequestContext,
    hints: Array<{
      displayName: string;
      typeLabel: string;
      excerpt?: string;
    }>,
    // §7.6 返回类型用交叉类型而非给 WritingEntitySketch 加字段：duplicateSuspected 是运行时派生（查重结果），
    // 不属持久化模型——加到行类型会污染 DDL/Row 映射（无对应列、无写入方），交叉类型让标记只在内存对象上流转。
  ): Array<WritingEntitySketch & { duplicateSuspected: boolean }> {
    const results: Array<WritingEntitySketch & { duplicateSuspected: boolean }> = [];
    let duplicateSuspectedCount = 0;

    for (const hint of hints) {
      // §7.6 主流程3 查重检测：已有同名 candidate/approved/registered → 标记 duplicate_suspected
      const duplicates = this.store.findEntitySketchesByName(
        ctx.projectId,
        hint.displayName,
      );
      const hasDuplicates = duplicates.filter(
        d => d.status === 'candidate' || d.status === 'approved' || d.status === 'registered',
      ).length > 0;
      if (hasDuplicates) duplicateSuspectedCount++;

      const sketch = this.store.createEntitySketch(ctx.projectId, {
        displayName: hint.displayName,
        typeLabel: hint.typeLabel,
        status: 'hint',
        sourceRefs: [
          ...ctx.sourceRefs,
          {
            kind: 'chat',
            id: ctx.requestId,
            excerpt: hint.excerpt,
          },
        ],
      });

      // §7.6：状态保持 'hint'，返回值附加 duplicateSuspected 标记（spread sketch + 派生字段）
      results.push({ ...sketch, duplicateSuspected: hasDuplicates });
    }

    // §7.6 副作用4：只记一条汇总审计（契约明示「不逐个记录，太多噪音」）。
    // duplicateSuspectedCount 进汇总以保留可观测性，替代此前逐条 per-hint duplicate 审计。
    if (results.length > 0) {
      this.audit.record(ctx, {
        action: 'detect_entity_hints',
        detail: { count: results.length, duplicateSuspectedCount },
      });
    }

    return results;
  }

  /**
   * 将 hint 转为 candidate
   *
   * Agent 可调用：是（CANDIDATE_WRITE — 需要作者确认）
   */
  promoteHintToSketch(
    ctx: WritingRequestContext,
    hintId: string,
    params: {
      displayName: string;
      typeLabel: string;
    },
  ): WritingEntitySketch {
    const sketch = this.store.getEntitySketch(hintId);
    if (!sketch) throw new WritingError(WritingErrorCode.WRITING_OBJECT_NOT_FOUND, `找不到实体草图: ${hintId}`, { objectType: 'entity_sketch', objectId: hintId });

    // 状态机校验
    if (sketch.status !== 'hint') {
      throw new WritingError(
        WritingErrorCode.INVALID_STATUS_TRANSITION,
        `实体状态 "${sketch.status}" 不能转为候选（需要 "hint"）`,
        { currentStatus: sketch.status, attemptedAction: 'promoteToCandidate' },
      );
    }

    // 重名检测
    const duplicates = this.store.findEntitySketchesByName(
      ctx.projectId,
      params.displayName,
    );
    const hasDuplicates = duplicates.filter(d => d.id !== hintId).length > 0;

    this.store.updateEntitySketch(hintId, {
      displayName: params.displayName,
      typeLabel: params.typeLabel,
      status: 'candidate',
    });

    this.audit.record(ctx, {
      action: 'promote_hint_to_candidate',
      targetType: 'entity_sketch',
      targetId: hintId,
      detail: {
        displayName: params.displayName,
        hasDuplicates,
      },
    });

    return this.store.getEntitySketch(hintId)!;
  }

  /**
   * 批准候选，准备注册
   *
   * Agent 可调用：是（CANDIDATE_WRITE）
   *
   * 自动创建待确认事项——Agent 不需要记得做这件事。
   */
  approveCandidate(
    ctx: WritingRequestContext,
    sketchId: string,
  ): WritingEntitySketch {
    const sketch = this.store.getEntitySketch(sketchId);
    if (!sketch) throw new WritingError(WritingErrorCode.WRITING_OBJECT_NOT_FOUND, `找不到实体草图: ${sketchId}`, { objectType: 'entity_sketch', objectId: sketchId });

    // 状态机校验
    if (sketch.status !== 'candidate') {
      throw new WritingError(
        WritingErrorCode.INVALID_STATUS_TRANSITION,
        `实体状态 "${sketch.status}" 不能批准（需要 "candidate"）`,
        { currentStatus: sketch.status, attemptedAction: 'approve' },
      );
    }

    // P2 修复：重名检测——若已存在同名已注册实体，阻止重复登记（应改走 merge）
    const registeredDup = this.store.findEntitySketchesByName(
      ctx.projectId,
      sketch.displayName,
    ).filter(d => d.id !== sketchId && d.status === 'registered');
    if (registeredDup.length > 0) {
      throw new WritingError(
        WritingErrorCode.DUPLICATE_ENTITY_CANDIDATE,
        `已存在同名已注册实体 "${sketch.displayName}"，请改用合并而非重复登记`,
        { displayName: sketch.displayName },
      );
    }

    this.store.updateEntitySketch(sketchId, { status: 'approved' });

    // 自动创建待确认事项
    this.workflow.createPendingDecision(
      makeRequestContext({
        projectId: ctx.projectId,
        trigger: 'draft_conversion',
        sourceRefs: [{
          kind: 'user_decision',
          id: sketchId,
          excerpt: `登记实体: ${sketch.displayName}`,
        }],
      }),
      {
        kind: 'confirm_entity',
        title: `确认登记实体: ${sketch.displayName}`,
        description: `将 "${sketch.displayName}" 登记为正式设定对象`,
        linkedObjectId: sketchId,
        linkedObjectType: 'entity_sketch',
      },
    );

    this.audit.record(ctx, {
      action: 'approve_entity_candidate',
      targetType: 'entity_sketch',
      targetId: sketchId,
    });

    return this.store.getEntitySketch(sketchId)!;
  }

  /**
   * 废弃实体草图
   *
   * Agent 可调用：是（LOW_RISK_WRITE）
   *
   * 已注册的实体不能通过此方法废弃（需走 Retcon）。
   */
  deprecateEntitySketch(
    ctx: WritingRequestContext,
    sketchId: string,
    reason?: string,
  ): void {
    const sketch = this.store.getEntitySketch(sketchId);
    if (!sketch) throw new WritingError(WritingErrorCode.WRITING_OBJECT_NOT_FOUND, `找不到实体草图: ${sketchId}`, { objectType: 'entity_sketch', objectId: sketchId });

    // 已注册实体需走 Retcon
    if (sketch.status === 'registered') {
      throw new WritingError(WritingErrorCode.INVALID_STATUS_TRANSITION, '已注册实体不能直接废弃。如需修改，请使用 Retcon 通道。', { currentStatus: 'registered', attemptedAction: 'deprecate' });
    }
    if (sketch.status === 'merged') {
      throw new WritingError(WritingErrorCode.INVALID_STATUS_TRANSITION, '已合并的实体是终态，不能废弃', { currentStatus: 'merged', attemptedAction: 'deprecate' });
    }

    this.store.updateEntitySketch(sketchId, { status: 'deprecated' });

    // §7.6 主流程4：废弃实体草图时，expire 此实体关联的活跃审核视图 + PendingDecision。
    // 与 abandonDraft expire 草案类 PV 对称——避免悬挂的审核/决策指向已废弃实体。
    const activePV = this.store.getActiveProposalViewForEntitySketch(sketchId);
    if (activePV) {
      this.store.expireProposalView(activePV.id);
      // 同步 expire 关联的 PendingDecision（按 linkedObjectId === pv.id 匹配，与 abandonDraft 一致）
      const decisions = this.store.listPendingDecisions(ctx.projectId);
      for (const d of decisions) {
        if (d.linkedObjectId === activePV.id && d.linkedObjectType === 'proposal_view') {
          try {
            this.store.resolveDecision(d.id, 'expired', '实体草图已废弃');
          } catch {
            // 决策可能已被并发处理或过期，忽略（与 abandonDraft 一致的并发容忍）
          }
        }
      }
      // 记 expire 审计——废弃实体导致的 PV 过期留下可观测痕迹（便于排查"为何此 PV 过期"）
      this.audit.record(ctx, {
        action: 'expire_proposal_view',
        targetType: 'proposal_view',
        targetId: activePV.id,
        detail: { reason: 'entity_sketch_deprecated', sketchId },
      });
    }

    this.audit.record(ctx, {
      action: 'deprecate_entity',
      targetType: 'entity_sketch',
      targetId: sketchId,
      detail: { reason },
    });
  }

  /**
   * 合并实体草图
   *
   * Agent 可调用：是（CANDIDATE_WRITE）
   *
   * source 必须是 hint 或 candidate（已注册的不能合并）。
   * source 的 displayName 会加入 target 的 aliases。
   */
  mergeSketches(
    ctx: WritingRequestContext,
    sourceId: string,
    targetId: string,
  ): void {
    if (sourceId === targetId) {
      throw new WritingError(WritingErrorCode.INVALID_STATUS_TRANSITION, '不能合并同一个实体', { attemptedAction: 'mergeSelf' });
    }

    const source = this.store.getEntitySketch(sourceId);
    if (!source) throw new WritingError(WritingErrorCode.WRITING_OBJECT_NOT_FOUND, `找不到源实体: ${sourceId}`, { objectType: 'entity_sketch', objectId: sourceId });

    const target = this.store.getEntitySketch(targetId);
    if (!target) throw new WritingError(WritingErrorCode.WRITING_OBJECT_NOT_FOUND, `找不到目标实体: ${targetId}`, { objectType: 'entity_sketch', objectId: targetId });

    // 校验目标实体状态：不能合并到已合并或已废弃的实体
    if (target.status === 'merged') {
      throw new WritingError(WritingErrorCode.INVALID_STATUS_TRANSITION, '目标实体已被合并，不能作为合并目标', { currentStatus: target.status, attemptedAction: 'mergeAsTarget' });
    }
    if (target.status === 'deprecated') {
      throw new WritingError(WritingErrorCode.INVALID_STATUS_TRANSITION, '目标实体已废弃，不能作为合并目标', { currentStatus: target.status, attemptedAction: 'mergeAsTarget' });
    }

    // P1-3 修复：源实体→merged 由状态机单一真相源裁决
    // （ENTITY_SKETCH_TRANSITIONS 仅允许 candidate→merged；hint/approved/registered/merged 均被拒）
    if (source.status === 'registered') {
      // registered 已被 Core 引用，保留 Retcon 友好提示（表 registered:[] 同样会拒，但消息需引导至 Retcon）
      throw new WritingError(WritingErrorCode.INVALID_STATUS_TRANSITION, '已注册实体不能合并。如需合并已注册实体，请使用 Retcon 通道。', { currentStatus: source.status, attemptedAction: 'mergeSource' });
    }
    validateEntitySketchTransition(source.status, 'merged', sourceId);

    // 合并 source 的名称到 target 的别名字段
    const mergedAliases = [
      ...target.aliases,
      source.displayName,
      ...source.aliases.filter(a => a !== source.displayName),
    ];

    // 原子性：两写（target 别名更新 + source 标 merged）必须同生共死——若 mergeEntitySketches
    // 在 updateEntitySketch 之后失败，target 别名已改而 source 未合并，留下"半合并"的部分态
    // （target 凭空多出别名、source 仍可被引用）。包入 runInTransaction（savepoint 嵌套，与
    // acceptBlueprintDraft P0-4 同范式）保证两者全成或全回滚。audit 一并纳入（AuditService.record
    // 内部 try/catch 吞自身异常，不会因审计失败误回滚数据写）。
    this.store.runInTransaction(() => {
      this.store.updateEntitySketch(targetId, { aliases: mergedAliases });
      this.store.mergeEntitySketches(sourceId, targetId);
      this.audit.record(ctx, {
        action: 'merge_entities',
        detail: { sourceId, targetId },
      });
    });
  }

  // 注：CoreBridge 注册成功/失败后的草图状态回写已内化于 RealCoreBridge
  // （registerReviewedEntity 内直接更新 writing_entity_sketches，并落地审计）。
  // 早期设计 §7.7 规划的 _markRegistered / _markRegistrationFailed 内部方法已移除——
  // 它们是 private 且无任何调用方（跨类无法调用 private，设计自相矛盾），属确认的死代码。

  // =========================================================================
  // Query
  // =========================================================================

  /**
   * 列出候选队列
   */
  listCandidateQueue(ctx: WritingRequestContext): WritingEntitySketch[] {
    return this.store.listEntitySketches(ctx.projectId, { status: 'candidate' });
  }

  /**
   * 查找已注册实体（Agent 构建 factChanges 时获取 Core entity ID）
   */
  findRegisteredEntities(
    ctx: WritingRequestContext,
    namePattern?: string,
  ): WritingEntitySketch[] {
    return this.store.listEntitySketches(ctx.projectId, { status: 'registered' })
      .filter(e => !namePattern || e.displayName.includes(namePattern));
  }

  /**
   * 获取单个实体草图
   */
  getEntitySketch(ctx: WritingRequestContext, sketchId: string): WritingEntitySketch {
    const sketch = this.store.getEntitySketch(sketchId);
    if (!sketch) throw new WritingError(WritingErrorCode.WRITING_OBJECT_NOT_FOUND, `找不到实体草图: ${sketchId}`, { objectType: 'entity_sketch', objectId: sketchId });
    return sketch;
  }
}

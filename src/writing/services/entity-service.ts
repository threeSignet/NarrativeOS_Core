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
//   - _markRegistered / _markRegistrationFailed 内部方法，CoreBridge 专用
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
   */
  detectEntityHints(
    ctx: WritingRequestContext,
    hints: Array<{
      displayName: string;
      typeLabel: string;
      excerpt?: string;
    }>,
  ): WritingEntitySketch[] {
    const results: WritingEntitySketch[] = [];

    for (const hint of hints) {
      // 查重检测
      const duplicates = this.store.findEntitySketchesByName(
        ctx.projectId,
        hint.displayName,
      );
      const hasDuplicates = duplicates.filter(
        d => d.status === 'candidate' || d.status === 'approved' || d.status === 'registered',
      ).length > 0;

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

      results.push(sketch);

      if (hasDuplicates) {
        this.audit.record(ctx, {
          action: 'detect_entity_hints',
          targetType: 'entity_sketch',
          targetId: sketch.id,
          detail: { duplicateSuspected: true, displayName: hint.displayName },
        });
      }
    }

    if (results.length > 0) {
      this.audit.record(ctx, {
        action: 'detect_entity_hints',
        detail: { count: results.length },
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
    if (!sketch) throw new Error(`找不到实体草图: ${hintId}`);

    // 状态机校验
    if (sketch.status !== 'hint') {
      throw new Error(
        `实体状态 "${sketch.status}" 不能转为候选（需要 "hint"）`,
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
    if (!sketch) throw new Error(`找不到实体草图: ${sketchId}`);

    // 状态机校验
    if (sketch.status !== 'candidate') {
      throw new Error(
        `实体状态 "${sketch.status}" 不能批准（需要 "candidate"）`,
      );
    }

    // P2 修复：重名检测——若已存在同名已注册实体，阻止重复登记（应改走 merge）
    const registeredDup = this.store.findEntitySketchesByName(
      ctx.projectId,
      sketch.displayName,
    ).filter(d => d.id !== sketchId && d.status === 'registered');
    if (registeredDup.length > 0) {
      throw new Error(
        `已存在同名已注册实体 "${sketch.displayName}"，请改用合并而非重复登记`,
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
    if (!sketch) throw new Error(`找不到实体草图: ${sketchId}`);

    // 已注册实体需走 Retcon
    if (sketch.status === 'registered') {
      throw new Error('已注册实体不能直接废弃。如需修改，请使用 Retcon 通道。');
    }
    if (sketch.status === 'merged') {
      throw new Error('已合并的实体是终态，不能废弃');
    }

    this.store.updateEntitySketch(sketchId, { status: 'deprecated' });

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
      throw new Error('不能合并同一个实体');
    }

    const source = this.store.getEntitySketch(sourceId);
    if (!source) throw new Error(`找不到源实体: ${sourceId}`);

    const target = this.store.getEntitySketch(targetId);
    if (!target) throw new Error(`找不到目标实体: ${targetId}`);

    // 校验目标实体状态：不能合并到已合并或已废弃的实体
    if (target.status === 'merged') {
      throw new Error('目标实体已被合并，不能作为合并目标');
    }
    if (target.status === 'deprecated') {
      throw new Error('目标实体已废弃，不能作为合并目标');
    }

    // P1-3 修复：源实体→merged 由状态机单一真相源裁决
    // （ENTITY_SKETCH_TRANSITIONS 仅允许 candidate→merged；hint/approved/registered/merged 均被拒）
    if (source.status === 'registered') {
      // registered 已被 Core 引用，保留 Retcon 友好提示（表 registered:[] 同样会拒，但消息需引导至 Retcon）
      throw new Error('已注册实体不能合并。如需合并已注册实体，请使用 Retcon 通道。');
    }
    validateEntitySketchTransition(source.status, 'merged', sourceId);

    // 合并 source 的名称到 target 的别名字段
    const mergedAliases = [
      ...target.aliases,
      source.displayName,
      ...source.aliases.filter(a => a !== source.displayName),
    ];

    this.store.updateEntitySketch(targetId, { aliases: mergedAliases });
    this.store.mergeEntitySketches(sourceId, targetId);

    this.audit.record(ctx, {
      action: 'merge_entities',
      detail: { sourceId, targetId },
    });
  }

  // =========================================================================
  // 内部方法（CoreBridge 专用，Agent 禁止调用）
  // =========================================================================

  /**
   * CoreBridge 注册成功后回写
   *
   * @internal — 仅 CoreBridge 调用
   */
  private _markRegistered(sketchId: string, coreEntityId: string, coreKind: string): void {
    this.store.updateEntitySketch(sketchId, {
      status: 'registered',
      coreEntityId,
      coreKind,
    });
  }

  /**
   * CoreBridge 注册失败后回写
   *
   * @internal — 仅 CoreBridge 调用
   */
  private _markRegistrationFailed(sketchId: string, _error: unknown): void {
    this.store.updateEntitySketch(sketchId, { status: 'error' });
  }

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
    if (!sketch) throw new Error(`找不到实体草图: ${sketchId}`);
    return sketch;
  }
}

// =============================================================================
// IdeaService — 灵感收集与管理
// =============================================================================
// 管理创意卡片、设定碎片、参考素材和废案。
// 这是低约束收集区，灵感永远是写作层状态，不能直接进入 Core。
//
// 设计要点：
//   - 灵感捕捉后 maturity='raw'，不写 Core，不入提案
//   - classifyIdea 首次分类时自动 raw → candidate
//   - promoteIdeaToDraft 需要 maturity >= 'structured'
//   - discardIdea 只是 maturity='archived'，原文保留
//   - 灵感转蓝图候选也走此服务
//
// 对应设计文档：Phase7-Refinement.md §7.3
// =============================================================================

import { SQLiteWritingStore } from '../repositories/writing-store.js';
import { AuditService } from './audit-service.js';
import type { WritingRequestContext } from './context.js';
import type {
  IdeaCard,
  IdeaKind,
  IdeaMaturity,
  IdeaSource,
  AnalysisPolicy,
  DraftKind,
  WritingDraft,
  BlueprintChangeSuggestion,
} from '../models/types.js';
import type { SourceRef } from '../models/source-ref.js';
import { validateIdeaTransition } from '../models/state-machine.js';
import { WritingError, WritingErrorCode } from '../errors/error-codes.js';

export class IdeaService {
  private store: SQLiteWritingStore;
  private audit: AuditService;
  /** 可选注入：promoteIdeaToDraft 时调用 DraftService 创建草案 */
  private createDraftFn?: (ctx: WritingRequestContext, params: {
    kind: DraftKind;
    title?: string;
    content?: string;
    sourceRefs?: SourceRef[];
  }) => WritingDraft;

  constructor(
    store: SQLiteWritingStore,
    audit: AuditService,
    createDraftFn?: IdeaService['createDraftFn'],
  ) {
    this.store = store;
    this.audit = audit;
    this.createDraftFn = createDraftFn;
  }

  // =========================================================================
  // Command
  // =========================================================================

  /**
   * 捕捉灵感
   *
   * Agent 可调用：是（LOW_RISK_WRITE）
   *
   * 前置条件:
   *   - content 非空
   *
   * 主流程:
   *   1. WritingStore.createIdeaCard → maturity='raw'
   *   2. AuditService.record
   */
  captureIdea(
    ctx: WritingRequestContext,
    params: {
      content: string;
      kind?: IdeaKind;
      tags?: string[];
      analysisPolicy?: AnalysisPolicy;
    },
  ): IdeaCard {
    if (!params.content || params.content.trim().length === 0) {
      throw new WritingError(WritingErrorCode.WRITING_STORE_ERROR, '灵感内容不能为空', { field: 'content' });
    }

    const idea = this.store.createIdeaCard(ctx.projectId, {
      content: params.content,
      kind: params.kind,
      tags: params.tags,
      source: ctx.trigger === 'agent_suggestion' ? 'agent_suggestion' : 'chat',
      analysisPolicy: params.analysisPolicy,
      sourceRefs: ctx.sourceRefs,
    });

    this.audit.record(ctx, {
      action: 'capture_idea',
      targetType: 'idea_card',
      targetId: idea.id,
    });

    return idea;
  }

  /**
   * 分类灵感
   *
   * Agent 可调用：是（LOW_RISK_WRITE）
   *
   * 首次分类时自动将 maturity 从 raw 推进到 candidate。
   */
  classifyIdea(
    ctx: WritingRequestContext,
    ideaId: string,
    params: {
      kind?: IdeaKind;
      tags?: string[];
      summary?: string;
    },
  ): IdeaCard {
    const idea = this.store.getIdeaCard(ideaId);
    if (!idea) throw new WritingError(WritingErrorCode.WRITING_OBJECT_NOT_FOUND, `找不到灵感: ${ideaId}`, { objectType: 'idea', objectId: ideaId });

    const newMaturity: IdeaMaturity =
      idea.maturity === 'raw' ? 'candidate' : idea.maturity;

    this.store.updateIdeaCard(ideaId, {
      kind: params.kind,
      tags: params.tags,
      summary: params.summary ?? null,
      maturity: newMaturity,
    });

    this.audit.record(ctx, {
      action: 'classify_idea',
      targetType: 'idea_card',
      targetId: ideaId,
      detail: { newMaturity, newKind: params.kind },
    });

    return this.store.getIdeaCard(ideaId)!;
  }

  /**
   * 灵感转草案
   *
   * Agent 可调用：是（CANDIDATE_WRITE — 需要作者确认意图）
   *
   * 前置条件（以 IDEA_TRANSITIONS 为单一真相源）:
   *   - idea 存在
   *   - maturity 为 'candidate' / 'structured' 可转 'ready_for_draft'
   *   - 'raw' / 'archived' 不可直接转草案
   *   - 已是 'ready_for_draft' 时幂等（仅追加关联草案，不重复转换）
   */
  promoteIdeaToDraft(
    ctx: WritingRequestContext,
    ideaId: string,
    params: {
      draftKind: DraftKind;
      title?: string;
    },
  ): { idea: IdeaCard; draft: WritingDraft } {
    const idea = this.store.getIdeaCard(ideaId);
    if (!idea) throw new WritingError(WritingErrorCode.WRITING_OBJECT_NOT_FOUND, `找不到灵感: ${ideaId}`, { objectType: 'idea', objectId: ideaId });

    // 调用 DraftService 创建草案（通过注入的函数）
    if (!this.createDraftFn) {
      throw new Error('IdeaService: createDraftFn 未注入，无法转草案');
    }
    const draft = this.createDraftFn(ctx, {
      kind: params.draftKind,
      title: params.title ?? idea.summary,
      content: idea.content,
      sourceRefs: [{ kind: 'idea', id: ideaId, excerpt: idea.summary }],
    });

    // 更新灵感的关联草案列表
    const linkedDraftIds = [...idea.linkedDraftIds, draft.id];

    // P1-3 修复：状态机校验收敛到 state-machine（单一真相源）
    // 已是 ready_for_draft 时幂等——仅追加关联草案，不重复转换
    // （IDEA_TRANSITIONS['ready_for_draft'] 仅允许 →archived，自转会误抛错，故需特判）
    if (idea.maturity !== 'ready_for_draft') {
      validateIdeaTransition(idea.maturity, 'ready_for_draft', ideaId);
      this.store.updateIdeaCard(ideaId, { linkedDraftIds, maturity: 'ready_for_draft' });
    } else {
      this.store.updateIdeaCard(ideaId, { linkedDraftIds });
    }

    this.audit.record(ctx, {
      action: 'promote_idea_to_draft',
      targetType: 'idea_card',
      targetId: ideaId,
      detail: { draftId: draft.id },
    });

    return { idea: this.store.getIdeaCard(ideaId)!, draft };
  }

  /**
   * 灵感转蓝图候选
   *
   * Agent 可调用：是（CANDIDATE_WRITE）
   */
  promoteIdeaToBlueprintCandidate(
    ctx: WritingRequestContext,
    ideaId: string,
    params: { typeLabel: string; description?: string; kind?: string },
  ): BlueprintChangeSuggestion {
    const idea = this.store.getIdeaCard(ideaId);
    if (!idea) throw new WritingError(WritingErrorCode.WRITING_OBJECT_NOT_FOUND, `找不到灵感: ${ideaId}`, { objectType: 'idea', objectId: ideaId });

    // 获取或创建活跃蓝图
    let blueprint = this.store.getActiveBlueprint(ctx.projectId);
    if (!blueprint) {
      blueprint = this.store.createBlueprint(ctx.projectId, {
        maturity: 'evolving',
        sourceRefs: ctx.sourceRefs,
      });
    }

    // 创建变更建议
    const suggestion: BlueprintChangeSuggestion = {
      id: `blp_change_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,  // 8 位随机后缀，降低短窗口碰撞
      kind: params.kind as BlueprintChangeSuggestion['kind'] ?? 'entity_type',
      naturalLanguageSummary: `${params.typeLabel}: ${idea.summary ?? idea.content.slice(0, 50)}`,
      reason: `来自灵感卡 ${ideaId}`,
      examples: [idea.content],
      confidence: 0.7,
      status: 'suggested',
      sourceRefs: [{ kind: 'idea', id: ideaId }],
    };

    const existingSuggestions = blueprint.changeSuggestions ?? [];
    this.store.updateBlueprint(blueprint.id, blueprint.version, {
      changeSuggestions: [...existingSuggestions, suggestion],
      maturity: blueprint.maturity === 'active' ? 'evolving' : blueprint.maturity,
    });

    this.audit.record(ctx, {
      action: 'promote_idea_to_blueprint_candidate',
      targetType: 'idea_card',
      targetId: ideaId,
      detail: { suggestionId: suggestion.id },
    });

    return suggestion;
  }

  /**
   * 编辑灵感内容（content/summary/tags/kind）。
   * 成熟度变更走 classifyIdea/discardIdea/restoreIdea 状态机入口，不在此处直接改。
   */
  updateIdea(
    ctx: WritingRequestContext,
    ideaId: string,
    updates: { content?: string; summary?: string | null; tags?: string[]; kind?: IdeaKind },
  ): IdeaCard {
    const idea = this.store.getIdeaCard(ideaId);
    if (!idea) throw new WritingError(WritingErrorCode.WRITING_OBJECT_NOT_FOUND, `找不到灵感: ${ideaId}`, { objectType: 'idea', objectId: ideaId });
    this.store.updateIdeaCard(ideaId, updates);
    this.audit.record(ctx, {
      action: 'update_idea',
      targetType: 'idea_card',
      targetId: ideaId,
      detail: { fields: Object.keys(updates) },
    });
    return this.store.getIdeaCard(ideaId)!;
  }

  /**
   * 废弃灵感
   *
   * Agent 可调用：是（LOW_RISK_WRITE — §8.3.2，与 captureIdea/classifyIdea 同级）
   */
  discardIdea(ctx: WritingRequestContext, ideaId: string): void {
    const idea = this.store.getIdeaCard(ideaId);
    if (!idea) throw new WritingError(WritingErrorCode.WRITING_OBJECT_NOT_FOUND, `找不到灵感: ${ideaId}`, { objectType: 'idea', objectId: ideaId });

    this.store.updateIdeaCard(ideaId, { maturity: 'archived' });

    this.audit.record(ctx, {
      action: 'discard_idea',
      targetType: 'idea_card',
      targetId: ideaId,
    });
  }

  /**
   * 恢复废弃灵感
   *
   * Agent 可调用：是（LOW_RISK_WRITE — §8.3.2）
   */
  restoreIdea(ctx: WritingRequestContext, ideaId: string): IdeaCard {
    const idea = this.store.getIdeaCard(ideaId);
    // 注意：getIdeaCard 默认过滤 deleted_at，但 archived 的仍然可见
    // 如果 idea 被软删除（deleted_at 非空），则无法获取
    if (!idea) throw new WritingError(WritingErrorCode.WRITING_OBJECT_NOT_FOUND, `找不到灵感: ${ideaId}`, { objectType: 'idea', objectId: ideaId });
    if (idea.maturity !== 'archived') {
      throw new WritingError(WritingErrorCode.INVALID_STATUS_TRANSITION, '只能恢复已归档的灵感', { currentStatus: idea.maturity, attemptedAction: 'restore' });
    }

    this.store.updateIdeaCard(ideaId, { maturity: 'raw' });

    this.audit.record(ctx, {
      action: 'restore_idea',
      targetType: 'idea_card',
      targetId: ideaId,
    });

    return this.store.getIdeaCard(ideaId)!;
  }

  // =========================================================================
  // Query
  // =========================================================================

  /**
   * 列出灵感卡片
   */
  listIdeaCards(
    ctx: WritingRequestContext,
    filter?: { maturity?: IdeaMaturity; kind?: IdeaKind },
  ): IdeaCard[] {
    return this.store.listIdeaCards(ctx.projectId, filter);
  }

  /**
   * 获取灵感详情
   */
  getIdeaDetail(ctx: WritingRequestContext, ideaId: string): IdeaCard {
    const idea = this.store.getIdeaCard(ideaId);
    if (!idea) throw new WritingError(WritingErrorCode.WRITING_OBJECT_NOT_FOUND, `找不到灵感: ${ideaId}`, { objectType: 'idea', objectId: ideaId });
    return idea;
  }
}

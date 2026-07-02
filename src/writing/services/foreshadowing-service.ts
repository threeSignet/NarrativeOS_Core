// =============================================================================
// Phase 11 · ForeshadowingService——伏笔与悬念业务逻辑
// =============================================================================
// 职责：伏笔计划 CRUD + 暗示节点 + 回收计划 + 揭示计划
// 核心不变式：伏笔计划不自动写 Core Thread
// =============================================================================

import type { SQLiteWritingStore } from '../repositories/writing-store.js';
import type { AuditService } from './audit-service.js';
import type { WritingRequestContext } from './context.js';
import { WritingError, WritingErrorCode } from '../errors/error-codes.js';
import type {
  ForeshadowingPlan, ForeshadowingPlanStatus, ForeshadowingKind,
  HintOccurrence, HintIntensity, HintVisibility,
  PayoffPlan, PayoffKind,
  RevealPlan, RevealPlanStatus, RevealMilestone, RevealMilestoneKind,
} from '../models/types.js';

export class ForeshadowingService {
  constructor(private store: SQLiteWritingStore, private audit: AuditService) {}

  createForeshadowingPlan(ctx: WritingRequestContext, input: {
    label: string; kind: ForeshadowingKind; targetReaderEffect: string; linkedEntityRefs?: string[];
  }): ForeshadowingPlan {
    const plan = this.store.createForeshadowingPlan(ctx.projectId, input);
    this.audit.record(ctx, { action: 'create_foreshadowing_plan', targetType: 'foreshadowing_plan', targetId: plan.id, result: 'success', detail: { label: plan.label, kind: plan.kind } });
    return plan;
  }

  updateForeshadowingPlanStatus(ctx: WritingRequestContext, id: string, targetStatus: ForeshadowingPlanStatus): void {
    const plan = this.store.getForeshadowingPlan(id);
    if (!plan) throw new WritingError(WritingErrorCode.WRITING_OBJECT_NOT_FOUND, `伏笔计划不存在: ${id}`);
    this.store.updateForeshadowingPlan(id, { status: targetStatus });
    this.audit.record(ctx, { action: 'update_foreshadowing_status', targetType: 'foreshadowing_plan', targetId: id, result: 'success', detail: { from: plan.status, to: targetStatus } });
  }

  // --- 查询入口（Phase 12 A1：补齐 list 方法，让 Tool 20 get_foreshadowing_plans 不再恒返回空） ---
  // 此前 store.listForeshadowingPlans 已存在但 service 无对应方法，导致 tool-router 通过
  // (this as any).store 兜底访问一个在 ToolRouter 中并不存在的属性，结果永远短路为空数组。
  listForeshadowingPlans(ctx: WritingRequestContext): ForeshadowingPlan[] {
    return this.store.listForeshadowingPlans(ctx.projectId);
  }

  listRevealPlans(ctx: WritingRequestContext): RevealPlan[] {
    return this.store.listRevealPlans(ctx.projectId);
  }

  createHintOccurrence(ctx: WritingRequestContext, input: {
    foreshadowingPlanId: string; intensity: HintIntensity; visibility: HintVisibility;
    chapterId?: string; sceneId?: string; anchor?: { paragraphIndex: number; sentenceIndex?: number; excerpt?: string };
  }): HintOccurrence {
    const hint = this.store.createHintOccurrence(input);
    this.audit.record(ctx, { action: 'create_hint_occurrence', targetType: 'hint_occurrence', targetId: hint.id, result: 'success', detail: { foreshadowingPlanId: input.foreshadowingPlanId } });
    return hint;
  }

  createPayoffPlan(ctx: WritingRequestContext, input: {
    foreshadowingPlanId: string; kind: PayoffKind; targetChapterId?: string; targetSceneId?: string; notes?: string;
  }): PayoffPlan {
    const plan = this.store.createPayoffPlan(input);
    this.audit.record(ctx, { action: 'create_payoff_plan', targetType: 'payoff_plan', targetId: plan.id, result: 'success', detail: { kind: plan.kind } });
    return plan;
  }

  // --- 揭示计划 ---

  createRevealPlan(ctx: WritingRequestContext, input: {
    label: string; subjectDescription: string; linkedThreadId?: string; targetReaderEffect?: string;
  }): RevealPlan {
    const plan = this.store.createRevealPlan(ctx.projectId, input);
    this.audit.record(ctx, { action: 'create_reveal_plan', targetType: 'reveal_plan', targetId: plan.id, result: 'success', detail: { label: plan.label } });
    return plan;
  }

  updateRevealPlanStatus(ctx: WritingRequestContext, id: string, targetStatus: RevealPlanStatus): void {
    const plan = this.store.getRevealPlan(id);
    if (!plan) throw new WritingError(WritingErrorCode.WRITING_OBJECT_NOT_FOUND, `揭示计划不存在: ${id}`);
    this.store.updateRevealPlan(id, { status: targetStatus });
    this.audit.record(ctx, { action: 'update_reveal_status', targetType: 'reveal_plan', targetId: id, result: 'success', detail: { from: plan.status, to: targetStatus } });
  }

  createRevealMilestone(ctx: WritingRequestContext, input: {
    revealPlanId: string; kind: RevealMilestoneKind; description: string; chapterId?: string; sceneId?: string;
  }): RevealMilestone {
    const milestone = this.store.createRevealMilestone(input);
    this.audit.record(ctx, { action: 'create_reveal_milestone', targetType: 'reveal_milestone', targetId: milestone.id, result: 'success', detail: { kind: input.kind } });
    return milestone;
  }
}

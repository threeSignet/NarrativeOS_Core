// =============================================================================
// BlueprintService — 创作蓝图管理
// =============================================================================
// 管理柔性创作蓝图：草案生成、接受/拒绝变更、蓝图生命周期。
// Blueprint 不是 Core World Package，只是写作层的柔性结构理解。
//
// 设计要点：
//   - generateBlueprintDraft 只创建容器，内容由 Agent 通过 proposeBlueprintChange 填充
//   - acceptBlueprintDraft 将 drafted 蓝图激活，自动 supersede 旧 active 蓝图
//   - 变更建议通过 changeSuggestions 管理，接受/拒绝分别处理
//
// 对应设计文档：Phase7-Refinement.md §7.4
// =============================================================================

import { SQLiteWritingStore } from '../repositories/writing-store.js';
import { AuditService } from './audit-service.js';
import type { WritingRequestContext } from './context.js';
import type {
  ProjectBlueprint,
  BlueprintMaturity,
  BlueprintTypeDef,
  BlueprintChangeSuggestion,
} from '../models/types.js';
import type { SourceRef } from '../models/source-ref.js';
import { validateBlueprintTransition } from '../models/state-machine.js';
import { WritingError, WritingErrorCode } from '../errors/error-codes.js';

export class BlueprintService {
  private store: SQLiteWritingStore;
  private audit: AuditService;

  constructor(store: SQLiteWritingStore, audit: AuditService) {
    this.store = store;
    this.audit = audit;
  }

  // =========================================================================
  // Command
  // =========================================================================

  /**
   * 从自然语言描述生成蓝图草案
   *
   * Agent 可调用：是（REVIEW_CREATE — 生成后需用户确认）
   *
   * 只创建蓝图容器（entityTypes / relationTypes 初始为空）。
   * 内容的实际填充由 Agent 通过 proposeBlueprintChange 完成。
   */
  generateBlueprintDraft(
    ctx: WritingRequestContext,
    params: {
      naturalLanguageDescription: string;
    },
  ): ProjectBlueprint {
    const blueprint = this.store.createBlueprint(ctx.projectId, {
      entityTypes: [],
      relationTypes: [],
      maturity: 'drafted',
      sourceRefs: [
        ...ctx.sourceRefs,
        {
          kind: 'chat',
          id: ctx.requestId,
          excerpt: params.naturalLanguageDescription,
        },
      ],
    });

    this.audit.record(ctx, {
      action: 'generate_blueprint_draft',
      targetType: 'blueprint',
      targetId: blueprint.id,
    });

    return blueprint;
  }

  /**
   * 接受蓝图草案，激活为当前蓝图
   *
   * Agent 可调用：否（需要用户明确确认 — COMMIT_FORBIDDEN）
   *
   * 如果有旧 active 蓝图，自动 supersede。
   */
  acceptBlueprintDraft(
    ctx: WritingRequestContext,
    blueprintId: string,
  ): ProjectBlueprint {
    const blueprint = this.store.getBlueprint(blueprintId);
    if (!blueprint) throw new WritingError(WritingErrorCode.WRITING_OBJECT_NOT_FOUND, `找不到蓝图: ${blueprintId}`, { objectType: 'blueprint', objectId: blueprintId });

    // P1-3 修复：状态机校验收敛到 state-machine（单一真相源）
    // （允许 drafted/reviewed/evolving → active；active/superseded/archived/implicit 被拒）
    validateBlueprintTransition(blueprint.maturity, 'active', blueprintId);

    // supersede 旧 active + 激活新蓝图必须原子：任一步失败整体回滚，避免残留两个
    // maturity='active' 蓝图破坏 §6 activeBlueprintId 派生真相的唯一性。两条 updateBlueprint
    // 各自带乐观锁（version 守卫 + 推进），取代原先裸 UPDATE 的 supersedeBlueprint——后者
    // 无 version 守卫、不推进 version，并发下无法被 getActiveBlueprint 的 version DESC 正确裁决。
    // 当前 better-sqlite3 同步 + Node 单线程下并发实际不发生，事务是为语义完整性兜底。
    return this.store.runInTransaction(() => {
      const active = this.store.getActiveBlueprint(ctx.projectId);
      if (active && active.id !== blueprintId) {
        this.store.updateBlueprint(active.id, active.version, {
          maturity: 'superseded',
          supersededBy: blueprintId,
        });
      }

      this.store.updateBlueprint(blueprintId, blueprint.version, { maturity: 'active' });

      this.audit.record(ctx, {
        action: 'accept_blueprint',
        targetType: 'blueprint',
        targetId: blueprintId,
      });

      return this.store.getBlueprint(blueprintId)!;
    });
  }

  /**
   * 提出蓝图变更建议
   *
   * Agent 可调用：是（CANDIDATE_WRITE）
   */
  proposeBlueprintChange(
    ctx: WritingRequestContext,
    params: {
      kind: BlueprintChangeSuggestion['kind'];
      naturalLanguageSummary: string;
      reason: string;
      examples: string[];
      confidence?: number;
      sourceRefs?: SourceRef[];
    },
  ): BlueprintChangeSuggestion {
    // 获取或创建活跃蓝图
    let blueprint = this.store.getActiveBlueprint(ctx.projectId);
    if (!blueprint) {
      blueprint = this.store.createBlueprint(ctx.projectId, {
        maturity: 'evolving',
        sourceRefs: ctx.sourceRefs,
      });
    }

    const suggestion: BlueprintChangeSuggestion = {
      id: `blp_change_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,  // 8 位随机后缀，降低短窗口碰撞
      kind: params.kind,
      naturalLanguageSummary: params.naturalLanguageSummary,
      reason: params.reason,
      examples: params.examples,
      confidence: params.confidence ?? 0.7,
      status: 'suggested',
      sourceRefs: params.sourceRefs ?? [],
    };

    const existing = blueprint.changeSuggestions ?? [];
    this.store.updateBlueprint(blueprint.id, blueprint.version, {
      changeSuggestions: [...existing, suggestion],
      maturity: blueprint.maturity === 'active' ? 'evolving' : blueprint.maturity,
    });

    this.audit.record(ctx, {
      action: 'propose_blueprint_change',
      targetType: 'blueprint',
      targetId: blueprint.id,
      detail: { suggestionId: suggestion.id },
    });

    return suggestion;
  }

  // ===========================================================================
  // Phase 9：空间类型管理
  // ===========================================================================

  /** 向蓝图添加空间节点类型（Agent/CLI 调用） */
  addSpatialNodeType(
    ctx: WritingRequestContext,
    params: { id: string; label: string; description?: string; aliases?: string[]; examples?: string[] },
  ): BlueprintTypeDef {
    return this.addSpatialType(ctx, params, 'spatialNodeTypes', 'add_spatial_node_type', '空间节点类型');
  }

  /** 向蓝图添加空间边类型（Agent/CLI 调用） */
  addSpatialEdgeType(
    ctx: WritingRequestContext,
    params: { id: string; label: string; description?: string; aliases?: string[]; examples?: string[] },
  ): BlueprintTypeDef {
    return this.addSpatialType(ctx, params, 'spatialEdgeTypes', 'add_spatial_edge_type', '空间边类型');
  }

  /** 空间类型添加的共享逻辑 */
  private addSpatialType(
    ctx: WritingRequestContext,
    params: { id: string; label: string; description?: string; aliases?: string[]; examples?: string[] },
    field: 'spatialNodeTypes' | 'spatialEdgeTypes',
    auditAction: string,
    typeName: string,
  ): BlueprintTypeDef {
    let blueprint = this.store.getActiveBlueprint(ctx.projectId);
    if (!blueprint) {
      blueprint = this.store.createBlueprint(ctx.projectId, {
        maturity: 'evolving',
        sourceRefs: ctx.sourceRefs,
      });
    }

    const existing = blueprint[field] ?? [];
    if (existing.some(t => t.id === params.id)) {
      throw new Error(`${typeName} '${params.id}' 已存在于蓝图 ${blueprint.id}`);
    }

    const typeDef: BlueprintTypeDef = {
      id: params.id,
      label: params.label,
      description: params.description,
      aliases: params.aliases ?? [],
      examples: params.examples ?? [],
      status: 'accepted',
      sourceRefs: ctx.sourceRefs,
    };

    this.store.updateBlueprint(blueprint.id, blueprint.version, {
      [field]: [...existing, typeDef],
      maturity: blueprint.maturity === 'active' ? 'evolving' : blueprint.maturity,
    });

    this.audit.record(ctx, {
      action: auditAction,
      targetType: 'blueprint',
      targetId: blueprint.id,
      detail: { typeId: params.id, label: params.label },
    });

    return typeDef;
  }

  /**
   * 接受蓝图变更建议
   *
   * Agent 可调用：否（COMMIT_FORBIDDEN — 需用户确认）
   */
  acceptBlueprintChange(
    ctx: WritingRequestContext,
    suggestionId: string,
  ): ProjectBlueprint {
    // 找到包含此 suggestion 的蓝图
    const blueprints = this.store.listBlueprints(ctx.projectId);
    let targetBlueprint: ProjectBlueprint | undefined;
    let targetSuggestion: BlueprintChangeSuggestion | undefined;

    for (const bp of blueprints) {
      const found = bp.changeSuggestions?.find(s => s.id === suggestionId);
      if (found) {
        targetBlueprint = bp;
        targetSuggestion = found;
        break;
      }
    }

    if (!targetBlueprint || !targetSuggestion) {
      throw new WritingError(WritingErrorCode.WRITING_OBJECT_NOT_FOUND, `找不到变更建议: ${suggestionId}`, { objectType: 'blueprint_change_suggestion', objectId: suggestionId });
    }

    // 更新 suggestion 状态
    const updatedSuggestions = (targetBlueprint.changeSuggestions ?? []).map(s =>
      s.id === suggestionId ? { ...s, status: 'accepted' as const } : s,
    );

    // 如果是 entity_type 建议，添加到 entityTypes
    let updatedEntityTypes = targetBlueprint.entityTypes;
    if (targetSuggestion.kind === 'entity_type') {
      // 简单去重：按 label 检查是否已存在
      const label = targetSuggestion.naturalLanguageSummary.split(':')[0]?.trim() ?? '未知类型';
      const exists = updatedEntityTypes.some(t => t.label === label);
      if (!exists) {
        const newType: BlueprintTypeDef = {
          id: `type_${Date.now()}`,
          label,
          description: targetSuggestion.reason,
          aliases: [],
          examples: targetSuggestion.examples,
          status: 'accepted',
          sourceRefs: targetSuggestion.sourceRefs,
        };
        updatedEntityTypes = [...updatedEntityTypes, newType];
      }
    }
    // relation_type 同理
    let updatedRelationTypes = targetBlueprint.relationTypes;
    if (targetSuggestion.kind === 'relation_type') {
      const label = targetSuggestion.naturalLanguageSummary.split(':')[0]?.trim() ?? '未知关系';
      const exists = updatedRelationTypes.some(t => t.label === label);
      if (!exists) {
        const newType: BlueprintTypeDef = {
          id: `rel_${Date.now()}`,
          label,
          description: targetSuggestion.reason,
          aliases: [],
          examples: targetSuggestion.examples,
          status: 'accepted',
          sourceRefs: targetSuggestion.sourceRefs,
        };
        updatedRelationTypes = [...updatedRelationTypes, newType];
      }
    }

    this.store.updateBlueprint(targetBlueprint.id, targetBlueprint.version, {
      entityTypes: updatedEntityTypes,
      relationTypes: updatedRelationTypes,
      changeSuggestions: updatedSuggestions,
    });

    this.audit.record(ctx, {
      action: 'accept_blueprint_change',
      targetType: 'blueprint',
      targetId: targetBlueprint.id,
      detail: { suggestionId },
    });

    return this.store.getBlueprint(targetBlueprint.id)!;
  }

  /**
   * 拒绝蓝图变更建议
   *
   * Agent 可调用：是（LOW_RISK_WRITE — 仅标 dismissed，不改蓝图结构，与 discardIdea 同级）。
   * 与 acceptBlueprintChange（COMMIT_FORBIDDEN）不对称：accept 会落地结构变更（加 entityType/relationType），
   * reject 只丢弃建议、原文保留可追溯，故归低风险写入。
   */
  rejectBlueprintChange(
    ctx: WritingRequestContext,
    suggestionId: string,
  ): void {
    const blueprints = this.store.listBlueprints(ctx.projectId);
    let targetBlueprint: ProjectBlueprint | undefined;

    for (const bp of blueprints) {
      if (bp.changeSuggestions?.some(s => s.id === suggestionId)) {
        targetBlueprint = bp;
        break;
      }
    }

    if (!targetBlueprint) {
      throw new WritingError(WritingErrorCode.WRITING_OBJECT_NOT_FOUND, `找不到变更建议: ${suggestionId}`, { objectType: 'blueprint_change_suggestion', objectId: suggestionId });
    }

    const updatedSuggestions = (targetBlueprint.changeSuggestions ?? []).map(s =>
      s.id === suggestionId ? { ...s, status: 'dismissed' as const } : s,
    );

    this.store.updateBlueprint(targetBlueprint.id, targetBlueprint.version, {
      changeSuggestions: updatedSuggestions,
    });

    this.audit.record(ctx, {
      action: 'reject_blueprint_change',
      targetType: 'blueprint',
      targetId: targetBlueprint.id,
      detail: { suggestionId },
    });
  }

  // =========================================================================
  // Query
  // =========================================================================

  /**
   * 获取当前活跃蓝图
   */
  getActiveBlueprint(ctx: WritingRequestContext): ProjectBlueprint | undefined {
    return this.store.getActiveBlueprint(ctx.projectId);
  }

  /**
   * 获取蓝图演化历史
   */
  getBlueprintEvolution(ctx: WritingRequestContext): ProjectBlueprint[] {
    return this.store.listBlueprints(ctx.projectId);
  }
}

/**
 * 硬编码的类型标签到 Core EntityKind 的兜底映射
 *
 * 仅在 Blueprint 没有 coreMapping 或 coreMapping 置信度 < 0.5 时使用。
 */
export const DEFAULT_TYPE_TO_ENTITY_KIND: Record<string, string> = {
  '角色':   'character',
  '人物':   'character',
  '地点':   'place',
  '位置':   'place',
  '组织':   'faction',
  '势力':   'faction',
  '物品':   'item',
  '装备':   'item',
  '异常现象': 'spatial_domain',
  '概念':   'concept',
  '机制':   'rule',
  '事件':   'event',
};

export function mapTypeLabelToEntityKind(typeLabel: string): string {
  return DEFAULT_TYPE_TO_ENTITY_KIND[typeLabel] ?? 'entity';
}

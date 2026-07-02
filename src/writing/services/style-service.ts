// =============================================================================
// Phase 12 · StyleService——风格指南的业务逻辑（§18）
// =============================================================================
// 职责：
//   - 风格指南（StyleGuide）的获取/更新（项目默认指南 1:1）
//   - 风格示例（StyleExample）的添加/查询（正向/反向样本）
//   - 禁用表达（BannedExpression）的添加/查询
//
// 核心不变式（Feature-Spec §18.1）：
//   - 风格指南不进入 Core（Core 交互：无写入）
//   - 用户可随时调整，风格指南变更不自动改正文
//   - 普通作者看不到 prompt、模型参数或技术标签
//   - 不做风格检查/漂移检测（需 embedding，留给后续 phase）
//
// 与 ChapterService 范式一致：构造注入 store + audit，方法首参 ctx，更新记审计。
// =============================================================================

import type { SQLiteWritingStore } from '../repositories/writing-store.js';
import type { AuditService } from './audit-service.js';
import type { WritingRequestContext } from './context.js';
import { WritingError, WritingErrorCode } from '../errors/error-codes.js';
import type {
  StyleGuide, StyleExample, StyleExampleKind, BannedExpression,
  NarrativePerson, NarrativeDistance, PacingPreference, DescriptionPreference, StyleGuideStatus,
} from '../models/types.js';

export class StyleService {
  constructor(
    private store: SQLiteWritingStore,
    private audit: AuditService,
  ) {}

  /** 获取或创建项目默认风格指南（1:1，首次访问自动建 draft 态） */
  getOrCreateDefaultGuide(ctx: WritingRequestContext): StyleGuide {
    return this.store.getOrCreateDefaultStyleGuide(ctx.projectId);
  }

  /** 列出项目所有风格指南（default + variants） */
  listGuides(ctx: WritingRequestContext): StyleGuide[] {
    return this.store.listStyleGuides(ctx.projectId);
  }

  /** 获取指定指南 */
  getGuide(ctx: WritingRequestContext, id: string): StyleGuide {
    const guide = this.store.getStyleGuide(id);
    if (!guide) throw new WritingError(WritingErrorCode.WRITING_OBJECT_NOT_FOUND, `风格指南不存在: ${id}`);
    if (guide.projectId !== ctx.projectId) throw new WritingError(WritingErrorCode.WRITING_OBJECT_NOT_FOUND, `风格指南不属于当前项目: ${id}`);
    return guide;
  }

  /** 更新风格指南字段（人称/距离/节奏/描写偏好/禁用表达/状态等） */
  updateGuide(
    ctx: WritingRequestContext,
    id: string,
    updates: Partial<{
      name: string; narrativePerson: NarrativePerson; narrativeDistance: NarrativeDistance;
      pacingPreference: PacingPreference; descriptionPreference: DescriptionPreference[];
      bannedExpressionIds: string[]; exampleIds: string[]; status: StyleGuideStatus; scopeNote: string;
    }>,
  ): void {
    this.getGuide(ctx, id); // 校验归属
    this.store.updateStyleGuide(id, updates);
    this.audit.record(ctx, {
      action: 'update_style_guide', targetType: 'style_guide',
      targetId: id, result: 'success', detail: { fields: Object.keys(updates) },
    });
  }

  /** 添加风格示例（正向/反向样本，§18.2） */
  addExample(
    ctx: WritingRequestContext,
    input: { kind: StyleExampleKind; text: string; note?: string; sourceBlockId?: string },
  ): StyleExample {
    const example = this.store.createStyleExample(ctx.projectId, input);
    this.audit.record(ctx, {
      action: 'create_style_example', targetType: 'style_guide',
      targetId: example.id, result: 'success',
      detail: { kind: example.kind, sourceBlockId: input.sourceBlockId },
    });
    return example;
  }

  /** 列出风格示例 */
  listExamples(ctx: WritingRequestContext): StyleExample[] {
    return this.store.listStyleExamples(ctx.projectId);
  }

  /** 添加禁用表达（§18.3） */
  addBannedExpression(
    ctx: WritingRequestContext,
    input: { pattern: string; reason?: string; category?: string },
  ): BannedExpression {
    const banned = this.store.createBannedExpression(ctx.projectId, input);
    this.audit.record(ctx, {
      action: 'create_banned_expression', targetType: 'style_guide',
      targetId: banned.id, result: 'success',
      detail: { pattern: banned.pattern, category: input.category },
    });
    return banned;
  }

  /** 列出禁用表达 */
  listBannedExpressions(ctx: WritingRequestContext): BannedExpression[] {
    return this.store.listBannedExpressions(ctx.projectId);
  }
}

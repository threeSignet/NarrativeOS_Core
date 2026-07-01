// =============================================================================
// Phase 11 · ReaderService——读者模型业务逻辑
// =============================================================================
// 职责：读者群体管理 + 读者认知状态管理
// 核心不变式：ReaderModel 不写 Core Knowledge
// =============================================================================

import type { SQLiteWritingStore } from '../repositories/writing-store.js';
import type { AuditService } from './audit-service.js';
import type { WritingRequestContext } from './context.js';
import { WritingError, WritingErrorCode } from '../errors/error-codes.js';
import type { ReaderAudienceProfile, ReaderAudienceKind, ReaderKnowledgeState, ReaderKnowledgeStateValue } from '../models/types.js';

export class ReaderService {
  constructor(private store: SQLiteWritingStore, private audit: AuditService) {}

  createAudience(ctx: WritingRequestContext, input: { label: string; kind: ReaderAudienceKind; notes?: string }): ReaderAudienceProfile {
    const audience = this.store.createReaderAudience(ctx.projectId, input);
    this.audit.record(ctx, { action: 'create_reader_audience', targetType: 'reader_audience', targetId: audience.id, result: 'success', detail: { label: audience.label, kind: audience.kind } });
    return audience;
  }

  getOrCreateDefaultAudience(ctx: WritingRequestContext): ReaderAudienceProfile {
    const audiences = this.store.listReaderAudiences(ctx.projectId);
    const existing = audiences.find(a => a.kind === 'target_reader');
    if (existing) return existing;
    return this.createAudience(ctx, { label: '目标读者', kind: 'target_reader' });
  }

  createKnowledgeState(ctx: WritingRequestContext, input: {
    audienceId: string; subjectRef: string; state: ReaderKnowledgeStateValue;
    confidence?: number; narrativePositionType: string; narrativePositionId: string; sourceRefs?: string[];
  }): ReaderKnowledgeState {
    const ks = this.store.createReaderKnowledgeState(input);
    this.audit.record(ctx, { action: 'create_reader_knowledge_state', targetType: 'reader_knowledge_state', targetId: ks.id, result: 'success', detail: { subjectRef: input.subjectRef, state: input.state } });
    return ks;
  }

  updateKnowledgeState(ctx: WritingRequestContext, id: string, state: ReaderKnowledgeStateValue, confidence?: number): void {
    this.store.updateReaderKnowledgeState(id, { state, confidence });
    this.audit.record(ctx, { action: 'update_reader_knowledge_state', targetType: 'reader_knowledge_state', targetId: id, result: 'success', detail: { state } });
  }
}

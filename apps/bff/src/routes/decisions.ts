// =============================================================================
// /api/projects/:pid/decisions 路由——待确认决策（里程碑③）
// =============================================================================
// GET：列出 PendingDecision（含 confirm_entity 等）
// POST /:id/resolve：确认决策——confirm_entity 触发 registerReviewedEntity 进 Core
//   + resolvePendingDecision；dismissed 仅 resolve 不注册
//
// 实体走短通道：approveCandidate 自动建 confirm_entity 决策，
// 作者在此确认 → registerReviewedEntity（不经 §12 Proposal Review）。

import type { FastifyInstance } from 'fastify';
import type { WorkflowService } from '../../../../src/writing/services/workflow-service.js';
import type { RelationService } from '../../../../src/writing/services/relation-service.js';
import type { CoreBridgeService } from '../../../../src/writing/core-bridge/core-bridge-service.js';
import type { WritingTrigger } from '../../../../src/writing/services/context.js';
import { WritingError, WritingErrorCode } from '../../../../src/writing/errors/error-codes.js';

export interface DecisionRouteDeps {
  getWorkflowService: () => WorkflowService;
  getRelationService: () => RelationService;
  getCoreBridge: () => CoreBridgeService;
  makeCtx: (opts?: { pid?: string; trigger?: WritingTrigger }) => any;
}

export function registerDecisionRoutes(app: FastifyInstance, deps: DecisionRouteDeps) {
  const { getWorkflowService, getRelationService, getCoreBridge, makeCtx } = deps;

  const statusFor = (code: string): number => {
    if (code === WritingErrorCode.WRITING_OBJECT_NOT_FOUND) return 404;
    return 400;
  };

  // ---------- 列出待确认决策 ----------
  app.get('/api/projects/:pid/decisions', async (req, reply) => {
    const { pid } = req.params as { pid: string };
    try {
      return getWorkflowService().listPendingDecisions(makeCtx({ pid }));
    } catch (err) {
      const e = err as WritingError;
      reply.code(statusFor(e?.code ?? ''));
      return { error: e?.message ?? '未知错误', code: e?.code };
    }
  });

  // ---------- 解决决策（确认/驳回）----------
  // body: { action: 'resolve' | 'dismiss', note?: string }
  // resolve + confirm_entity → 触发 registerReviewedEntity 进 Core
  app.post('/api/projects/:pid/decisions/:id/resolve', async (req, reply) => {
    const { pid, id } = req.params as { pid: string; id: string };
    const body = req.body as { action?: 'resolve' | 'dismiss'; note?: string };
    const action = body.action ?? 'resolve';
    try {
      const ctx = makeCtx({ pid });
      const wf = getWorkflowService();
      const decisions = wf.listPendingDecisions(ctx);
      const decision = decisions.find((d) => d.id === id);
      if (!decision) { reply.code(404); return { error: '决策不存在' }; }
      if (decision.status !== 'open') { reply.code(400); return { error: '决策已处理' }; }

      // confirm_entity：确认 → 触发注册进 Core
      if (action === 'resolve' && decision.kind === 'confirm_entity' && decision.linkedObjectId) {
        const result = await getCoreBridge().registerReviewedEntity(ctx, decision.linkedObjectId);
        wf.resolvePendingDecision(ctx, id, {
          status: result.success ? 'resolved' : 'dismissed',
          note: result.success
            ? `coreEntityId=${result.coreEntityId}`
            : `注册失败：${result.error?.humanMessage ?? '未知'}`,
        });
        return { success: result.success, coreEntityId: result.coreEntityId, error: result.error };
      }

      // confirm_proposal：确认关系提交 → 写进 Core
      // decision.linkedObjectId = proposalViewId，需从 PV 找到 relationCandidateId
      if (action === 'resolve' && decision.kind === 'confirm_proposal' && decision.linkedObjectId) {
        const pvId = decision.linkedObjectId;
        // 从候选列表找 linkedObjectId===pvId 的候选（submit 时 PV.sourceRefs 带 candidate id）
        const candidates = getRelationService().listRelationCandidates(ctx);
        const candidate = candidates.find((c) => c.status === 'submitted');
        if (!candidate) {
          wf.resolvePendingDecision(ctx, id, { status: 'dismissed', note: '找不到对应的提交关系候选' });
          return { success: false, error: '找不到对应的提交关系候选' };
        }
        const result = await getRelationService().confirmRelationCommit(ctx, candidate.id, pvId);
        // confirmRelationCommit 内部已 resolve PendingDecision（Bug2 修复），不重复 resolve
        return result;
      }

      // 其他决策或 dismiss：仅 resolve，不触发注册
      wf.resolvePendingDecision(ctx, id, {
        status: action === 'resolve' ? 'resolved' : 'dismissed',
        note: body.note,
      });
      return { success: true };
    } catch (err) {
      const e = err as WritingError;
      reply.code(statusFor(e?.code ?? ''));
      return { error: e?.message ?? '未知错误', code: e?.code };
    }
  });
}

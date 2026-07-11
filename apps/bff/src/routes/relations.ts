// =============================================================================
// /api/projects/:pid 路由——关系图谱 + 关系写入链路（里程碑②③④）
// =============================================================================
// GET graph：关系图谱视图（只读，里程碑②）
// 关系写入（里程碑④a）：一步创建(createCandidate+submit) / confirm(写进Core) / deprecate
// 关系提示（里程碑④a）：list / confirm / ignore
// 创作关联（里程碑④a）：create / archive（不进 Core）

import type { FastifyInstance } from 'fastify';
import type { GraphService } from '../../../../src/writing/services/graph-service.js';
import type { RelationService } from '../../../../src/writing/services/relation-service.js';
import type { WritingTrigger } from '../../../../src/writing/services/context.js';
import type { GraphViewMode, GraphFilterState } from '../../../../src/writing/models/types.js';
import { WritingError } from '../../../../src/writing/errors/error-codes.js';

export interface GraphRouteDeps {
  getGraphService: () => GraphService;
  getRelationService: () => RelationService;
  makeCtx: (opts?: { pid?: string; trigger?: WritingTrigger }) => any;
}

export function registerGraphRoutes(app: FastifyInstance, deps: GraphRouteDeps) {
  const { getGraphService, getRelationService, makeCtx } = deps;

  const handleErr = (err: unknown, reply: any) => {
    const e = err as WritingError;
    const code = e?.code ?? '';
    const status = code === 'WRITING_OBJECT_NOT_FOUND' ? 404 : code === 'VERSION_CONFLICT' ? 409 : 400;
    reply.code(status);
    return { error: e?.message ?? '未知错误', code };
  };

  // ============ 图谱（只读，里程碑②）============

  app.get('/api/projects/:pid/graph', async (req, reply) => {
    const { pid } = req.params as { pid: string };
    const query = req.query as { mode?: string; layers?: string };
    const mode = (query.mode ?? 'world') as GraphViewMode;
    const filters: GraphFilterState | undefined = query.layers
      ? { layers: query.layers.split(',').filter(Boolean) as GraphFilterState['layers'] }
      : undefined;
    try {
      return await getGraphService().buildGraphView(makeCtx({ pid }), mode, filters);
    } catch (err) { return handleErr(err, reply); }
  });

  // ============ 关系提示（Agent 提取的 hint）============

  // ---------- 列出关系提示 ----------
  app.get('/api/projects/:pid/relation-hints', async (req, reply) => {
    const { pid } = req.params as { pid: string };
    try {
      return getRelationService().listRelationHints(makeCtx({ pid }));
    } catch (err) { return handleErr(err, reply); }
  });

  // ---------- hint → candidate ----------
  app.post('/api/projects/:pid/relation-hints/:id/confirm', async (req, reply) => {
    const { pid, id } = req.params as { pid: string; id: string };
    const body = req.body as { relationTypeId?: string; layer?: string; direction?: string; strength?: number };
    try {
      return getRelationService().confirmHintToCandidate(makeCtx({ pid }), id, {
        relationTypeId: body.relationTypeId ?? 'related',
        layer: body.layer as any,
        direction: body.direction as any,
        strength: body.strength,
      });
    } catch (err) { return handleErr(err, reply); }
  });

  // ---------- 忽略提示 ----------
  app.post('/api/projects/:pid/relation-hints/:id/ignore', async (req, reply) => {
    const { pid, id } = req.params as { pid: string; id: string };
    try {
      getRelationService().ignoreHint(makeCtx({ pid }), id);
      return { success: true };
    } catch (err) { return handleErr(err, reply); }
  });

  // ============ 关系候选（核心写入链路）============

  // ---------- 一步创建关系（createCandidate + submit，生成待确认决策）----------
  // 前端"新建关系"按钮调这个：选源+目标+类型 → 自动走沙盒推演+PV+PendingDecision
  app.post('/api/projects/:pid/relations', async (req, reply) => {
    const { pid } = req.params as { pid: string };
    const body = req.body as {
      sourceEntityId?: string; targetEntityId?: string; relationTypeId?: string;
      layer?: string; direction?: string; strength?: number;
    };
    if (!body.sourceEntityId || !body.targetEntityId || !body.relationTypeId) {
      reply.code(400); return { error: 'sourceEntityId, targetEntityId, relationTypeId 不能为空' };
    }
    try {
      const ctx = makeCtx({ pid, trigger: 'author_action' });
      const svc = getRelationService();
      // ① 建候选
      const candidate = svc.createRelationCandidate(ctx, {
        sourceEntityId: body.sourceEntityId,
        targetEntityId: body.targetEntityId,
        relationTypeId: body.relationTypeId,
        layer: (body.layer ?? 'world') as any,
        direction: (body.direction ?? 'directed') as any,
        strength: body.strength,
      });
      // ② 自动提交（沙盒推演 + PV + PendingDecision）
      const submitResult = await svc.submitRelationCandidate(ctx, candidate.id);
      return { success: true, candidateId: candidate.id, proposalViewId: submitResult.proposalViewId, isSafe: submitResult.isSafeToCommit };
    } catch (err) { return handleErr(err, reply); }
  });

  // ---------- 确认关系提交（写进 Core）----------
  // body: { proposalViewId }（从一步创建的返回或 PendingDecision.linkedObjectId 取）
  app.post('/api/projects/:pid/relations/:id/confirm', async (req, reply) => {
    const { pid, id } = req.params as { pid: string; id: string };
    const body = req.body as { proposalViewId?: string };
    if (!body.proposalViewId) { reply.code(400); return { error: 'proposalViewId 不能为空' }; }
    try {
      const ctx = makeCtx({ pid });
      const result = await getRelationService().confirmRelationCommit(ctx, id, body.proposalViewId);
      return result;
    } catch (err) { return handleErr(err, reply); }
  });

  // ---------- 废弃关系候选 ----------
  app.post('/api/projects/:pid/relations/:id/deprecate', async (req, reply) => {
    const { pid, id } = req.params as { pid: string; id: string };
    try {
      getRelationService().deprecateRelationCandidate(makeCtx({ pid }), id);
      return { success: true };
    } catch (err) { return handleErr(err, reply); }
  });

  // ---------- 列出关系候选 ----------
  app.get('/api/projects/:pid/relations', async (req, reply) => {
    const { pid } = req.params as { pid: string };
    const query = req.query as { status?: string; layer?: string };
    try {
      return getRelationService().listRelationCandidates(makeCtx({ pid }), query);
    } catch (err) { return handleErr(err, reply); }
  });

  // ============ 创作关联（不进 Core）============

  // ---------- 创建创作关联 ----------
  app.post('/api/projects/:pid/associations', async (req, reply) => {
    const { pid } = req.params as { pid: string };
    const body = req.body as {
      sourceObjectId?: string; targetObjectId?: string;
      sourceObjectType?: string; targetObjectType?: string;
      label?: string; kind?: string;
    };
    if (!body.sourceObjectId || !body.targetObjectId || !body.label) {
      reply.code(400); return { error: 'sourceObjectId, targetObjectId, label 不能为空' };
    }
    try {
      return getRelationService().createAssociation(makeCtx({ pid }), {
        sourceRef: { objectType: (body.sourceObjectType ?? 'entity') as any, objectId: body.sourceObjectId },
        targetRef: { objectType: (body.targetObjectType ?? 'entity') as any, objectId: body.targetObjectId },
        label: body.label,
        kind: (body.kind ?? 'manual') as any,
      });
    } catch (err) { return handleErr(err, reply); }
  });

  // ---------- 归档创作关联 ----------
  app.delete('/api/projects/:pid/associations/:id', async (req, reply) => {
    const { pid, id } = req.params as { pid: string; id: string };
    try {
      getRelationService().archiveAssociation(makeCtx({ pid }), id);
      return { success: true };
    } catch (err) { return handleErr(err, reply); }
  });
}

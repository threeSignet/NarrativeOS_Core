// =============================================================================
// /api/projects/:pid/readers 路由——读者认知模型（迭代 C3）
// =============================================================================
// §16 读者模型与视角。读者群体 + 认知状态。
//   GET  /readers                    列出读者群体
//   POST /readers                    创建读者群体 { label, kind, notes? }
//   GET  /readers/:id/knowledge      列出某群体的认知状态
//   POST /readers/:id/knowledge      添加认知状态
//   PATCH /readers/knowledge/:kid    更新认知状态值
import type { FastifyInstance } from 'fastify';
import type { ReaderService } from '../../../../src/writing/services/reader-service.js';
import type { WritingTrigger } from '../../../../src/writing/services/context.js';
import type { ReaderAudienceKind, ReaderKnowledgeStateValue } from '../../../../src/writing/models/types.js';
import { WritingError, WritingErrorCode } from '../../../../src/writing/errors/error-codes.js';

export interface ReaderRouteDeps {
  getReaderService: () => ReaderService;
  makeCtx: (opts?: { pid?: string; trigger?: WritingTrigger }) => any;
}

export function registerReaderRoutes(app: FastifyInstance, deps: ReaderRouteDeps) {
  const { getReaderService, makeCtx } = deps;

  const statusFor = (code: string): number => {
    if (code === WritingErrorCode.WRITING_OBJECT_NOT_FOUND) return 404;
    return 400;
  };
  const handleErr = (err: unknown, reply: any) => {
    const e = err as WritingError;
    reply.code(statusFor(e?.code ?? ''));
    return { error: e?.message ?? '未知错误', code: e?.code };
  };

  // ---------- 列出读者群体 ----------
  app.get('/api/projects/:pid/readers', async (req, reply) => {
    const { pid } = req.params as { pid: string };
    try {
      return getReaderService().listAudiences(makeCtx({ pid }));
    } catch (err) { return handleErr(err, reply); }
  });

  // ---------- 创建读者群体 ----------
  app.post('/api/projects/:pid/readers', async (req, reply) => {
    const { pid } = req.params as { pid: string };
    const body = req.body as { label: string; kind: ReaderAudienceKind; notes?: string };
    if (!body?.label?.trim()) {
      reply.code(400); return { error: '群体标签不能为空', code: WritingErrorCode.WRITING_STORE_ERROR };
    }
    try {
      return getReaderService().createAudience(
        makeCtx({ pid, trigger: 'author_action' }),
        { label: body.label.trim(), kind: body.kind ?? 'custom', notes: body.notes },
      );
    } catch (err) { return handleErr(err, reply); }
  });

  // ---------- 列出认知状态 ----------
  app.get('/api/projects/:pid/readers/:id/knowledge', async (req, reply) => {
    const { pid, id } = req.params as { pid: string; id: string };
    try {
      return getReaderService().listKnowledgeStates(id);
    } catch (err) { return handleErr(err, reply); }
  });

  // ---------- 添加认知状态 ----------
  app.post('/api/projects/:pid/readers/:id/knowledge', async (req, reply) => {
    const { pid, id } = req.params as { pid: string; id: string };
    const body = req.body as {
      subjectRef: string; state: ReaderKnowledgeStateValue; confidence?: number;
      narrativePositionType?: string; narrativePositionId?: string;
    };
    if (!body?.subjectRef?.trim()) {
      reply.code(400); return { error: '认知主体不能为空', code: WritingErrorCode.WRITING_STORE_ERROR };
    }
    try {
      return getReaderService().createKnowledgeState(
        makeCtx({ pid, trigger: 'author_action' }),
        {
          audienceId: id,
          subjectRef: body.subjectRef.trim(),
          state: body.state,
          confidence: body.confidence,
          narrativePositionType: body.narrativePositionType ?? 'manual',
          narrativePositionId: body.narrativePositionId ?? 'global',
        },
      );
    } catch (err) { return handleErr(err, reply); }
  });

  // ---------- 更新认知状态 ----------
  app.patch('/api/projects/:pid/readers/knowledge/:kid', async (req, reply) => {
    const { pid, kid } = req.params as { pid: string; kid: string };
    const body = req.body as { state: ReaderKnowledgeStateValue; confidence?: number };
    try {
      getReaderService().updateKnowledgeState(
        makeCtx({ pid }), kid, body.state, body.confidence,
      );
      return { success: true };
    } catch (err) { return handleErr(err, reply); }
  });
}

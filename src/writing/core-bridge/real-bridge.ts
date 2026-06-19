// =============================================================================
// RealCoreBridge — 真实 CoreBridge 实现（包装 ToolRouter）
// =============================================================================
// 写作层所有 Core 交互的唯一出口。
// Agent 只能调用 simulate/read 方法；commit/register 由 CLI 确认通道调用。
//
// 设计要点：
//   - 不 Mock——Core 是我们的代码，测试用 :memory: SQLite + 真实 ToolRouter
//   - ToolRouter.execute() 返回 ToolResult<T> = { success, data } | { success, error }
//     必须解包：先检查 success，再读取 data
//   - propose_event 内部使用 camelCase（ProposalResult），写回时注意字段名
//   - commitReviewedProposal 必须从 ProposalView 查找 coreProposalId
//   - registerReviewedEntity 必须从 EntitySketch 查找 entityName + entityKind
//
// 对应设计文档：Phase7-Refinement.md §7.7, §18
// =============================================================================

import type { ToolRouter } from '../../core/tool-router.js';
import type { SQLiteWritingStore } from '../repositories/writing-store.js';
import type {
  CoreBridgeService,
  SimulationResult,
  CommitResult,
  RegisterEntityResult,
  ReconcileResult,
  CoreErrorExplanation,
  WorldSnapshot,
  WorldSnapshotEntity,
} from './core-bridge-service.js';
import { mapTypeLabelToEntityKind } from '../services/blueprint-service.js';
import type { AuditService } from '../services/audit-service.js';
import { makeRequestContext } from '../services/context.js';
import type { WritingRequestContext } from '../services/context.js';
import type { WritingAuditLog, ProposalViewStatus, WritingDraft } from '../models/types.js';
import type { SourceRef } from '../models/source-ref.js';
import { validateCommitReadiness } from '../models/state-machine.js';
// W11：错误模型统一——WritingError 用于抛出（推演失败），WritingErrorCode 枚举常量替代字符串字面量
// （类型安全 + 单一真相源），getErrorRecovery 让 ERROR_RECOVERY_MAP 进入运行时数据流（不再死代码）
import { WritingError, WritingErrorCode, getErrorRecovery } from '../errors/error-codes.js';
// W13-b P1：ProposalResult→SimulationResult 适配器（与 Agent 路径共享同一段转换，单一真相源）
import { proposalResultToSimulationResult, type ProposalResultLike } from './proposal-result-adapter.js';
// P1-2：重推后重投影 PV 四件套（与 draft-service.simulateDraft 共用同一投影函数）
import { buildProposalReviewData } from '../view-models/proposal-review.js';

/** ToolRouter.execute() 返回的成功包装 */
interface ToolResultOk<T> {
  success: true;
  data: T;
}

/** ToolRouter.execute() 返回的失败包装 */
interface ToolResultErr {
  success: false;
  error: { code: string; message: string; detail?: string; retryable: boolean };
}

type ToolResultWrapper<T> = ToolResultOk<T> | ToolResultErr;

export class RealCoreBridge implements CoreBridgeService {
  private toolRouter: ToolRouter;
  private writingStore?: SQLiteWritingStore;
  private auditService?: AuditService;

  /**
   * @param toolRouter Core 的 ToolRouter 实例
   * @param writingStore 可选——写作层存储，用于 commit/register 时查找 Core ID。
   *                     不传时 commit 和 register 方法将直接返回配置错误。
   * @param auditService 可选——提交/注册审计服务。传入后，commit/register 内部会落地审计
   *                     （§7.7 4d/5b），保证「任何调用方提交都被审计」，而非依赖调用方各自记录。
   */
  constructor(
    toolRouter: ToolRouter,
    writingStore?: SQLiteWritingStore,
    auditService?: AuditService,
  ) {
    this.toolRouter = toolRouter;
    this.writingStore = writingStore;
    this.auditService = auditService;
  }

  // =========================================================================
  // 沙盒/只读（Agent 可调用）
  // =========================================================================

  /**
   * 草案沙盒推演——调用 Core propose_event（只推演，不提交 Core）
   *
   * 转发到私有 runProposeEvent：草案推演与重新推演（simulateProposal）共用同一段
   * propose_event 调用 + 后果抽取逻辑，避免两处复制后语义漂移。draftId 仅用于上层
   * （draft-service）回写 PV 来源关联，propose_event 本身不需要，故此处不透传给 Core。
   */
  async simulateDraftAsEvent(
    _projectId: string,
    params: {
      draftId: string;
      eventDescription: string;
      eventType: string;
      chapter: number;
      factChanges: unknown[];
    },
  ): Promise<SimulationResult> {
    return this.runProposeEvent({
      eventDescription: params.eventDescription,
      eventType: params.eventType,
      chapter: params.chapter,
      factChanges: params.factChanges,
    });
  }

  /**
   * 重新推演审核中的提案（W9，§7.7/§12.1）
   *
   * 用途：提案进入审核后，作者想用「最新 Core 世界状态」重跑一次推演，确认结论（isSafeToCommit /
   * 后果线索）是否仍然成立——例如期间已提交了别的事件改变了世界状态。
   *
   * 实现：从 ProposalView 读回 simulateDraftAsEvent 当时持久化的原始输入（SimulationInputs，
   * 见 types.ts），用完全相同的参数重调 propose_event，得到新鲜的 SimulationResult。factDiff /
   * ruleWarnings 是有损投影（丢失 ent_ 主体、change_id 等内部细节），无法反推原始 factChanges，
   * 故 W9 在 simulateDraft 时把原始输入持久化到 PV（simulation_inputs_json）。
   *
   * **不持久化**：本方法仅返回新鲜结果，不回写 PV——与 simulateDraftAsEvent 对称（推演方法只读 Core、
   * 不写写作层）。重要含义：重推会生成新的 Core proposalId；调用方（如 /review 命令，task #9）若要
   * 让审核视图反映重推结果，需自行把新 proposalId + 重新投影的 factDiff/ruleWarnings/humanSummary
   * 一并回写，否则 commit 会用过期 proposalId（§7.11.6 PROPOSAL_NOT_FOUND）。桥接层不做此策略决策，
   * 以免只回写 proposalId 而留下「新 id + 旧 factDiff」的不一致 PV。
   *
   * @throws 当 writingStore 未注入 / PV 不存在 / PV 无 simulationInputs（实体注册等非草案来源）
   */
  async simulateProposal(
    _projectId: string,
    proposalViewId: string,
  ): Promise<SimulationResult> {
    if (!this.writingStore) {
      throw new Error(
        'simulateProposal 需要 writingStore 才能读取提案的原始推演输入（构造 RealCoreBridge 时未注入）',
      );
    }

    const pv = this.writingStore.getProposalView(proposalViewId);
    if (!pv) {
      throw new Error(`simulateProposal: 找不到审核视图 ${proposalViewId}`);
    }
    if (!pv.simulationInputs) {
      // 非草案来源（如实体注册）的 PV 没有持久化推演输入，无法重推——引导调用方走对应来源的重推路径
      throw new Error(
        `simulateProposal: 审核视图 ${proposalViewId} 无原始推演输入（proposalType=${pv.proposalType}，可能来自实体注册等非草案推演来源），无法重新推演`,
      );
    }

    const simulation = await this.runProposeEvent(pv.simulationInputs);

    // P1-2 修复：重推后回写 PV（coreProposalId + 重投影四件套），避免 commit 用过期 proposalId。
    // 此前设计上故意不回写（避免"新 id + 旧 factDiff"不一致），但无调用方做了回写 → 重推后
    // commit 走 PROPOSAL_NOT_FOUND。现改为：重推产生新 proposalId 后，用同一 factChanges 重投影
    // 四件套一并回写，保持 PV 完全一致。self-loop 豁免保证 status 不变时不触发状态机校验。
    if (this.writingStore && simulation.proposalId) {
      const sketchNameMap = new Map<string, string>();
      for (const s of this.writingStore.listEntitySketches(pv.projectId)) {
        if (s.coreEntityId) sketchNameMap.set(s.coreEntityId, s.displayName);
      }
      const reviewData = buildProposalReviewData({
        eventDescription: pv.simulationInputs.eventDescription,
        factChanges: pv.simulationInputs.factChanges,
        simulation,
        resolveEntityName: (id: string) => sketchNameMap.get(id),
      });
      this.writingStore.updateProposalView(proposalViewId, {
        coreProposalId: simulation.proposalId,
        coreBridgeResult: {
          proposalId: simulation.proposalId,
          isSafeToCommit: simulation.isSafeToCommit,
        },
        humanSummary: reviewData.humanSummary,
        factDiff: reviewData.factDiff,
        involvedEntityIds: reviewData.involvedEntityIds,
        ruleWarnings: reviewData.ruleWarnings,
        // 重推后内容已变（新 proposalId + 新 factDiff），若作者之前 approved 了旧内容，
        // 必须重置为 open 要求重新审核（与 narrative-agent.ts:1728 重推路径一致）。
        // author_approved→open 在状态机表合法；open→open 是 self-loop 豁免。
        status: pv.status === 'author_approved' ? 'open' : pv.status,
      });
    }

    return simulation;
  }

  /**
   * 执行一次 propose_event 沙盒推演并抽取结构化后果
   *
   * W9 抽出，供 simulateDraftAsEvent 与 simulateProposal 共用——单一事实源，避免两份复制逻辑漂移。
   *
   * ProposalResult 字段是 camelCase（Core 内部类型，handleProposeEvent 经 ok() 透传，不做 snake_case
   * 转换）。consequences.generatedThreads / warnings 是 W7 Proposal Review 投影 ruleWarnings 的唯一
   * 数据源（severity→blocker/warning/info）。
   */
  private async runProposeEvent(inputs: {
    eventDescription: string;
    eventType: string;
    chapter: number;
    factChanges: unknown[];
  }): Promise<SimulationResult> {
    const wrapper = await this.toolRouter.execute('propose_event', {
      event_type: inputs.eventType,
      event_description: inputs.eventDescription,
      chapter: inputs.chapter,
      fact_changes: inputs.factChanges,
      subject: inputs.eventDescription, // Core 要求 subject 不能为空
      context: 'global',
    }) as ToolResultWrapper<Record<string, unknown>>;

    if (!wrapper.success) {
      // W11：抛结构化 WritingError（COREBRIDGE_SIMULATE_FAILED）而非普通 Error——
      // 上层（DraftService.simulateDraft 的 catch / ERROR_RECOVERY_MAP）可据 code 映射人话与恢复动作，
      // 而非仅拿到一条技术字符串。Core 的原始 code/message 保留在 message 中供调试。
      throw new WritingError(
        WritingErrorCode.COREBRIDGE_SIMULATE_FAILED,
        `Core 推演失败: [${wrapper.error.code}] ${wrapper.error.message}`,
      );
    }

    // ProposalResult 使用 camelCase 字段名（Core 内部类型）。wrapper.data 经 as 传入适配器。
    const data = wrapper.data;
    // W7/W13-b：ProposalResult→SimulationResult 抽取为共享纯函数
    // （proposal-result-adapter.ts），与 narrative-agent.handleToolSuccess 复用同一段转换逻辑，
    // 单一真相源——避免桥接层与 Agent 路径两份副本漂移。后果线索/警告的过滤（severity 非字符串、
    // warnings 非字符串）由适配器统一处理。handleProposeEvent 返回 this.ok(result) 含完整
    // ProposalResult，故 consequences 在此可得，无需改 Core。
    // data 是 Record<string,unknown>（wrapper.data），经 unknown 中转才能赋给 ProposalResultLike——
    // 运行时 Core 确实产出 ProposalResult 形状，TS 这里无法静态确认，故显式两段断言。
    return proposalResultToSimulationResult(data as unknown as ProposalResultLike);
  }

  /**
   * 读取当前世界状态快照（§7.7，W8 修复）
   *
   * **聚合方案**：枚举本项目已注册实体（status='registered' 且 coreEntityId 已回填），
   * 逐一调 Core `get_context_slice` 聚合。修复了旧实现的两个致命缺陷——
   *   ① 旧实现缺 `entity_id`（get_context_slice 是单实体档案，schema 强制要求 entity_id）；
   *   ② 旧实现 `current_chapter` 硬编码 1（无视项目真实进度）。
   *
   * 章节视角：`options.currentChapter` 显式传入优先，否则 `writingStore.getCurrentChapter` 推导
   * （已存在 draft 的最大 chapter，默认 1）。Core `project_state.current_chapter` 是规范来源，
   * 但无 Core 读工具暴露它，读取需新增 Core 接口，违背"Phase 7 最小侵入 Core"原则。
   *
   * 容错：单个实体的 get_context_slice 失败（Core 报错或异常）不阻断整体聚合——
   * 记录 error 后继续，保证"部分可用优于整体失败"（世界快照的价值在于覆盖面）。
   */
  async readCurrentWorldSnapshot(
    projectId: string,
    options?: { currentChapter?: number },
  ): Promise<WorldSnapshot> {
    if (!this.writingStore) {
      throw new Error(
        'readCurrentWorldSnapshot 需要 writingStore 才能枚举已注册实体（构造 RealCoreBridge 时未注入）',
      );
    }

    // 1. 章节视角：显式传入优先，否则写作层推导
    const currentChapter =
      options?.currentChapter ?? this.writingStore.getCurrentChapter(projectId);

    // 2. 枚举已注册实体（status='registered' 且 coreEntityId 已回填——只取真正进 Core 的）
    const sketches = this.writingStore
      .listEntitySketches(projectId, { status: 'registered' })
      .filter((s) => typeof s.coreEntityId === 'string' && s.coreEntityId.length > 0);

    // 3. coreEntityId → displayName 映射，传给 get_context_slice 改善档案渲染（关系名等）
    const entityNames: Record<string, string> = {};
    for (const s of sketches) {
      entityNames[s.coreEntityId!] = s.displayName;
    }

    // 4. 逐一聚合（单实体失败容错）
    const entities: WorldSnapshotEntity[] = [];
    for (const s of sketches) {
      const coreEntityId = s.coreEntityId!;
      try {
        const wrapper = await this.toolRouter.execute('get_context_slice', {
          entity_id: coreEntityId,
          current_chapter: currentChapter,
          include_relations: true,
          entity_names: entityNames,
        }) as ToolResultWrapper<{
          // ToolRouter.execute 返回的 ContextSliceResult 是 camelCase（ToolService 原样透传，
          // ok() 不做 snake_case 转换）——与 propose_event 返回 proposalId 等一致。
          profileMarkdown?: string;
          factIndex?: unknown;
        }>;

        if (!wrapper.success) {
          // 单实体查询失败：记录错误但继续聚合其余实体
          entities.push({
            displayName: s.displayName, typeLabel: s.typeLabel, coreEntityId,
            profileMarkdown: '', factIndex: [],
            error: `[${wrapper.error.code}] ${wrapper.error.message}`,
          });
          continue;
        }

        const data = wrapper.data ?? {};
        // factIndex 防御性规整：只保留带 factId 的条目，predicate/value 兜底
        const factIndex = Array.isArray(data.factIndex)
          ? (data.factIndex as Array<{ factId?: string; predicate?: string; value?: unknown }>)
              .filter((f) => f && typeof f.factId === 'string')
              .map((f) => ({
                factId: f.factId as string,
                predicate: typeof f.predicate === 'string' ? f.predicate : '',
                value: f.value === undefined ? '' : String(f.value),
              }))
          : [];

        entities.push({
          displayName: s.displayName, typeLabel: s.typeLabel, coreEntityId,
          profileMarkdown: typeof data.profileMarkdown === 'string' ? data.profileMarkdown : '',
          factIndex,
        });
      } catch (err) {
        // 防御：未知异常（如 Core 抛错）也不阻断整体聚合
        entities.push({
          displayName: s.displayName, typeLabel: s.typeLabel, coreEntityId,
          profileMarkdown: '', factIndex: [],
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return { currentChapter, totalEntities: sketches.length, entities };
  }

  /**
   * 将 Core 错误转为人话解释
   */
  explainCoreFailure(error: unknown): CoreErrorExplanation {
    // 处理 ToolResult 错误包装
    if (error && typeof error === 'object' && 'error' in error) {
      const toolErr = (error as ToolResultErr).error;
      if (toolErr) {
        return {
          errorCode: toolErr.code,
          humanMessage: toolErr.message,
          suggestedActions: toolErr.detail ? [toolErr.detail] : ['重试操作', '检查参数'],
          isRecoverable: toolErr.retryable,
          technicalDetail: toolErr.detail,
        };
      }
    }
    // 原生 Error 对象
    const err = error as { code?: string; message?: string };
    return {
      errorCode: err.code ?? 'UNKNOWN',
      humanMessage: err.message ?? '未知 Core 错误',
      suggestedActions: ['重试操作'],
      isRecoverable: false,
    };
  }

  /**
   * 构造结构化失败说明（W11：ERROR_RECOVERY_MAP 的消费入口）
   *
   * 此前各 failWith 调用点硬编码 humanMessage / suggestedActions，且 errorCode 用字符串字面量
   * （与 WritingErrorCode 枚举脱节、易拼写错误）。本工厂统一：
   *   - errorCode：调用方传 WritingErrorCode 枚举常量（类型安全，单一真相源）；Core 原生码
   *     或临时码（如 COREBRIDGE_CONFIG_ERROR）也可传字符串
   *   - humanMessage / suggestedActions：默认取自 getErrorRecovery(code)（即 §10.2 ERROR_RECOVERY_MAP）；
   *     调用方可用 opts.humanMessage / opts.suggestedActions 覆盖（保留如对象 ID 的上下文细节）
   *
   * 由此 ERROR_RECOVERY_MAP 不再是死代码，且人话 / 恢复动作保持单一真相源。
   */
  private explanation(
    code: string,
    opts: {
      humanMessage?: string;
      suggestedActions?: string[];
      isRecoverable: boolean;
      technicalDetail?: string;
    },
  ): CoreErrorExplanation {
    const recovery = getErrorRecovery(code);
    return {
      errorCode: code,
      humanMessage: opts.humanMessage ?? recovery.humanMessage,
      suggestedActions: opts.suggestedActions ?? recovery.suggestedActions,
      isRecoverable: opts.isRecoverable,
      technicalDetail: opts.technicalDetail,
    };
  }

  // =========================================================================
  // 写入（仅 CLI 确认通道调用，Agent 类型层面不可见）
  // =========================================================================

  /**
   * 提交已审核提案——调用 Core commit_event
   *
   * 从 ProposalView 中查找 coreProposalId（Core 的 proposal ID），
   * 而非直接使用 writing-layer 的 proposalViewId。
   *
   * 审计策略（§7.7 4d/5b）：本方法在内部落地审计，覆盖成功 / Core 失败 / 回写部分失败三种结果，
   * 保证「任何调用方提交都被审计」。回写部分失败（Core 已提交但写作层同步未完成）记 result='partial'
   * （§7.7 行1862），由 reconcileCommittedProposals() 在启动时对账恢复（§7.11.5）。
   */
  async commitReviewedProposal(
    ctx: WritingRequestContext,
    proposalViewId: string,
  ): Promise<CommitResult> {
    // 校验失败统一封装：记审计后返回结构化错误，便于调用方解释
    const failWith = (
      error: CoreErrorExplanation,
    ): CommitResult => {
      this.recordAudit(ctx, {
        action: 'commit_proposal',
        targetType: 'proposal_view',
        targetId: proposalViewId,
        result: 'failure',
        errorCode: error.errorCode,
      });
      return { success: false, error };
    };

    if (!this.writingStore) {
      // COREBRIDGE_CONFIG_ERROR 非 WritingErrorCode（配置/编程错误，非领域可恢复错误），
      // 故不进 ERROR_RECOVERY_MAP；走 explanation 工厂时 getErrorRecovery 返回兜底，此处用具体文案覆盖
      return failWith(this.explanation('COREBRIDGE_CONFIG_ERROR', {
        humanMessage: 'CoreBridge 未配置 WritingStore，无法提交',
        suggestedActions: ['请确保 CLI 确认通道正确初始化 CoreBridge'],
        isRecoverable: false,
      }));
    }

    const pv = this.writingStore.getProposalView(proposalViewId);
    if (!pv) {
      // W11：errorCode 用枚举常量；humanMessage 带上下文 ID（覆盖 map 的通用文案），suggestedActions 取自 map
      return failWith(this.explanation(WritingErrorCode.WRITING_OBJECT_NOT_FOUND, {
        humanMessage: `找不到审核视图: ${proposalViewId}`,
        isRecoverable: false,
      }));
    }
    if (!pv.coreProposalId) {
      // W11：errorCode 用枚举常量；humanMessage 带上下文，suggestedActions 取自 map（PROPOSAL_NOT_IN_REVIEW 条目）
      return failWith(this.explanation(WritingErrorCode.PROPOSAL_NOT_IN_REVIEW, {
        humanMessage: '该审核视图没有关联的 Core 提案（可能尚未推演）',
        isRecoverable: false,
      }));
    }

    // P0-3 + W10：复合提交前校验（单一真相源 validateCommitReadiness，§7.0/§7.7 步骤2）。
    // 此前只查 status==='author_approved'，未防「审核期间来源草案被改/被删」的陈旧提案——
    // 那样的提案基于过期内容落 Core，会写入与当前草案不一致的事件。
    // 加载来源草案（event 类 PV 必有 sourceDraftId；getDraft 过滤软删）。
    let sourceDraft: WritingDraft | undefined;
    if (pv.sourceDraftId) {
      sourceDraft = this.writingStore.getDraft(pv.sourceDraftId);
    }
    const readiness = validateCommitReadiness({
      proposalViewStatus: pv.status,
      sourceDraftStatus: sourceDraft?.status,
      sourceDraftDeleted: !!pv.sourceDraftId && !sourceDraft,
    });
    if (!readiness.valid) {
      // 区分两类失败以给正确的错误码/可恢复性（§7.11.2/§7.11.6）：
      //   - status 非 author_approved → PROPOSAL_NOT_IN_REVIEW（流程问题，需先经确认通道批准）
      //   - status 已 author_approved 但来源草案变更/删除 → SOURCE_DRAFT_MODIFIED_AFTER_REVIEW
      //     （内容陈旧，需重新推演刷新提案，isRecoverable=true）
      const isSourceIssue = pv.status === 'author_approved';
      // W11：errorCode 用枚举常量；humanMessage 保留 readiness.reason（含"重新推演/删除"等状态上下文，
      // 测试与作者定位均依赖），suggestedActions 保留针对每种失败的精确指引
      return failWith(this.explanation(
        isSourceIssue
          ? WritingErrorCode.SOURCE_DRAFT_MODIFIED_AFTER_REVIEW
          : WritingErrorCode.PROPOSAL_NOT_IN_REVIEW,
        {
          humanMessage: readiness.reason ?? '提案不满足提交条件',
          suggestedActions: isSourceIssue
            ? ['重新推演草案以刷新提案', '或废弃当前提案后重做']
            : [`请通过 CLI 确认通道批准该提案（当前状态: ${pv.status}）`],
          isRecoverable: isSourceIssue,
        },
      ));
    }

    // W14：commit 审计的来源追溯——指向触发本 PV 的源草案（§4 SourceRef）。pv 已通过 readiness 校验，
    // sourceDraftId 为 event 类 PV 的来源（实体注册类 PV 无草案 → 空数组，审计仍记录但不带来源）。
    // 仅提交后两处审计（成功 520 / 提交后失败 473）使用；failWith 早期路径（pv 未加载/配置错误）无来源。
    const commitSourceRefs: SourceRef[] = pv.sourceDraftId
      ? [{ kind: 'draft', id: pv.sourceDraftId }]
      : [];

    const wrapper = await this.toolRouter.execute('commit_event', {
      proposal_id: pv.coreProposalId,
    }) as ToolResultWrapper<Record<string, unknown>>;

    if (!wrapper.success) {
      // 提交失败时按错误类型分流 ProposalView 终态（§7.11.6）：
      //   - PROPOSAL_NOT_FOUND（Core 端 proposal 不存在，通常因会话重启内存丢失）→ 'expired'
      //     proposal 已不可恢复，引导用户重新推演（isRecoverable=false，非可重试）
      //   - 其余错误（UNSAFE / STALE / TRANSACTION_FAILED 等）→ 'commit_failed'
      //     可恢复态，§7.11.2 路径A：用户可重新审核/重试
      // 标记本身也容忍异常——审计才是可恢复性的依据。
      const failureExplanation = this.explainCoreFailure(wrapper as ToolResultErr);
      const isProposalGone = failureExplanation.errorCode === 'PROPOSAL_NOT_FOUND';
      if (isProposalGone) {
        // §7.11.6：proposal 跨会话丢失，不可恢复，给用户"重新推演"的明确指引（而非误导性的"重试"）
        failureExplanation.humanMessage =
          '该提案已失效（Core 端 proposal 不存在，通常因会话重启导致内存 ProposalStore 丢失），请重新推演后再提交';
        failureExplanation.suggestedActions = ['重新执行草案推演生成新提案', '确认后再次提交'];
        failureExplanation.isRecoverable = false;
      }
      const failureStatus: ProposalViewStatus = isProposalGone ? 'expired' : 'commit_failed';
      try {
        this.writingStore.updateProposalView(proposalViewId, {
          status: failureStatus,
          commitError: failureExplanation,
        });
      } catch {
        // 状态标记失败不阻断审计落地
      }
      this.recordAudit(ctx, {
        action: 'commit_proposal',
        targetType: 'proposal_view',
        targetId: proposalViewId,
        result: 'failure',
        errorCode: failureExplanation.errorCode,
        detail: { coreProposalId: pv.coreProposalId, markedAs: failureStatus },
        sourceRefs: commitSourceRefs,
      });
      return { success: false, error: failureExplanation };
    }

    // commit_event 返回 snake_case 字段（LLM 接口格式）
    const coreEventId = wrapper.data.event_id as string;

    // P0-1 修复：Core 提交成功后完整回写写作层（§7.7 步骤4）
    //   1. ProposalView → committed + 写 coreEventId
    //   2. 创建 WritingCoreRef（写作对象 ↔ Core event 双向索引，供 Retcon 影响分析）
    //   3. 来源草案 → committed
    // 回写整体包裹在 try/catch 中：Core 已提交是不可逆事实，回写失败不能让方法抛错吞掉审计；
    // 此时记 result='partial' 审计，由 reconcileCommittedProposals() 在启动时对账恢复（§7.11.5）。
    let writebackError: string | undefined;
    try {
      this.writingStore.updateProposalView(proposalViewId, {
        status: 'committed',
        coreEventId,
        authorDecision: '确认提交',
      });

      this.writingStore.createCoreRef(pv.projectId, {
        writingObjectType: 'proposal_view',
        writingObjectId: proposalViewId,
        coreObjectType: 'event',
        coreObjectId: coreEventId,
      });

      if (pv.sourceDraftId) {
        // 回写来源草案状态：先读取当前版本，再以乐观锁写入（Core 提交为单线程串行流程，版本通常匹配）
        const draft = this.writingStore.getDraft(pv.sourceDraftId);
        if (draft) {
          this.writingStore.updateDraft(pv.sourceDraftId, draft.version, { status: 'committed' });
        }
      }
    } catch (wbErr) {
      writebackError = wbErr instanceof Error ? wbErr.message : String(wbErr);
    }

    const isPartial = writebackError !== undefined;
    this.recordAudit(ctx, {
      action: 'commit_proposal',
      targetType: 'proposal_view',
      targetId: proposalViewId,
      result: isPartial ? 'partial' : 'success',
      detail: isPartial
        ? { coreEventId, writebackError }
        : { coreEventId },
      sourceRefs: commitSourceRefs,
    });

    return {
      success: true,
      coreEventId,
    };
  }

  /**
   * 注册已审核实体——调用 Core register_entity
   *
   * 从 EntitySketch 中查找 entityName、entityKind 等信息后调用 Core。
   * 审计策略与 commitReviewedProposal 对齐（§7.7 4d/5b）：内部落地审计，
   * 覆盖成功 / Core 失败 / 回写部分失败三种结果。
   */
  async registerReviewedEntity(
    ctx: WritingRequestContext,
    sketchId: string,
  ): Promise<RegisterEntityResult> {
    // 校验失败统一封装：记审计后返回结构化错误
    const failWith = (
      error: CoreErrorExplanation,
    ): RegisterEntityResult => {
      this.recordAudit(ctx, {
        action: 'register_entity',
        targetType: 'entity_sketch',
        targetId: sketchId,
        result: 'failure',
        errorCode: error.errorCode,
      });
      return { success: false, error };
    };

    if (!this.writingStore) {
      // COREBRIDGE_CONFIG_ERROR 非 WritingErrorCode（配置错误），不进 map；用具体文案覆盖兜底
      return failWith(this.explanation('COREBRIDGE_CONFIG_ERROR', {
        humanMessage: 'CoreBridge 未配置 WritingStore，无法注册实体',
        suggestedActions: ['请确保 CLI 确认通道正确初始化 CoreBridge'],
        isRecoverable: false,
      }));
    }

    const sketch = this.writingStore.getEntitySketch(sketchId);
    if (!sketch) {
      // W11：errorCode 用枚举常量；humanMessage 带 sketchId 上下文，suggestedActions 取自 map
      return failWith(this.explanation(WritingErrorCode.WRITING_OBJECT_NOT_FOUND, {
        humanMessage: `找不到实体草图: ${sketchId}`,
        isRecoverable: false,
      }));
    }

    // P0-3 修复：status 前置校验——只有 approved 才能注册（§7.7 registerReviewedEntity 前置条件）
    if (sketch.status !== 'approved') {
      // W11：errorCode 用枚举常量（值仍为 'INVALID_STATUS_TRANSITION'，core-bridge-audit 测试不变）
      return failWith(this.explanation(WritingErrorCode.INVALID_STATUS_TRANSITION, {
        humanMessage: `实体状态为 "${sketch.status}"，必须先批准为 "approved" 才能注册`,
        suggestedActions: ['请先通过 approveCandidate 批准该候选实体'],
        isRecoverable: false,
      }));
    }

    // 按优先级解析 entityKind：sketch 已有 > Blueprint 映射 > 硬编码映射
    let entityKind = sketch.coreKind;
    if (!entityKind) {
      const activeBlueprint = this.writingStore.getActiveBlueprint(ctx.projectId);
      const typeDef = activeBlueprint?.entityTypes?.find(
        t => t.label === sketch.typeLabel,
      );
      if (typeDef?.coreMapping && typeDef.coreMapping.confidence >= 0.5) {
        entityKind = typeDef.coreMapping.entityKind;
      }
    }
    if (!entityKind) {
      entityKind = mapTypeLabelToEntityKind(sketch.typeLabel);
    }

    const wrapper = await this.toolRouter.execute('register_entity', {
      name: sketch.displayName,
      kind: entityKind,
      description: sketch.summary,
      chapter: 1, // Phase 7 默认
    }) as ToolResultWrapper<Record<string, unknown>>;

    if (!wrapper.success) {
      // P0-1 修复：注册失败时把草图标记为 error（可恢复态）。标记失败也容忍异常，审计为准。
      const failureExplanation = this.explainCoreFailure(wrapper as ToolResultErr);
      try {
        this.writingStore.updateEntitySketch(sketchId, { status: 'error' });
      } catch {
        // 标记 error 失败不阻断审计落地
      }
      this.recordAudit(ctx, {
        action: 'register_entity',
        targetType: 'entity_sketch',
        targetId: sketchId,
        result: 'failure',
        errorCode: failureExplanation.errorCode,
        detail: { displayName: sketch.displayName, entityKind },
      });
      return { success: false, error: failureExplanation };
    }

    const coreEntityId = wrapper.data.entity_id as string;

    // P0-1 修复：Core 注册成功后完整回写写作层（§7.6/§7.7）
    //   1. sketch → registered + 写 coreEntityId/coreKind
    //   2. 创建 WritingCoreRef（草图 ↔ Core entity 双向索引）
    // 回写整体包裹在 try/catch 中：Core 已注册是不可逆事实，回写失败记 result='partial'，
    // 由 reconcileRegisteredEntities() 在启动时对账恢复（§7.11.5）。
    let writebackError: string | undefined;
    try {
      this.writingStore.updateEntitySketch(sketchId, {
        status: 'registered',
        coreEntityId,
        coreKind: entityKind,
      });

      this.writingStore.createCoreRef(sketch.projectId, {
        writingObjectType: 'entity_sketch',
        writingObjectId: sketchId,
        coreObjectType: 'entity',
        coreObjectId: coreEntityId,
      });
    } catch (wbErr) {
      writebackError = wbErr instanceof Error ? wbErr.message : String(wbErr);
    }

    const isPartial = writebackError !== undefined;
    this.recordAudit(ctx, {
      action: 'register_entity',
      targetType: 'entity_sketch',
      targetId: sketchId,
      result: isPartial ? 'partial' : 'success',
      detail: isPartial
        ? { coreEntityId, entityKind, writebackError }
        : { coreEntityId, entityKind },
    });

    return {
      success: true,
      coreEntityId,
      coreKind: entityKind,
    };
  }

  // =========================================================================
  // 对账恢复（§7.11.5 两阶段提交恢复机制——初始化时调用）
  // =========================================================================

  /**
   * 对账恢复孤儿提案——修复"Core 已提交但 PV 仍 author_approved"的对象。
   *
   * 触发场景：commitReviewedProposal 中 Core commit_event 成功后，写作层回写（PV→committed、
   * coreRef、草案状态）整体抛错（记 result='partial' 审计），导致 PV 仍停在 author_approved，
   * 但 Core 已持久化对应 event。本方法在 CoreBridge 初始化（CLI 启动）时调用，通过审计日志
   * 定位这些孤儿并回写恢复。
   *
   * 为何用审计日志而非查询 Core proposal：Core 的 ProposalStore 是纯内存 Map（§7.11.6），
   * 进程重启后 proposal 全部丢失，无法用 proposal_id 反查。而审计日志在 Core 提交成功后、
   * 回写之前落地，detail.coreEventId 是"Core 已提交"的持久证据——events 表 append-only
   * （retcon 仅软失效 Fact，不删 event 行），故审计 success/partial ⟺ event 持久存在。
   *
   * 不处理（Phase 7 边界，§7.11.6）："Core 无记录的 proposal"无法在 reconcile 时可靠判定——
   * author_approved 既可能是合法待提交，也可能是 Core 端 proposal 跨会话内存丢失（§7.11.6）的孤儿，
   * 二者在此处无法区分。后者交由 §7.11.6 的懒机制处理：commitReviewedProposal 提交时收到
   * PROPOSAL_NOT_FOUND → 标记 PV expired（状态机已放行 author_approved→expired）；其余 Core 失败
   * （如 STALE_PROPOSAL / UNSAFE）→ commit_failed 可重试（§7.11.2 路径A）。
   */
  reconcileCommittedProposals(): ReconcileResult {
    if (!this.writingStore) return { recovered: [], inspected: 0 };

    const recovered: string[] = [];
    let inspected = 0;
    for (const project of this.writingStore.listProjects()) {
      const orphans = this.writingStore.listProposalViews(project.id, {
        status: 'author_approved',
      });
      for (const pv of orphans) {
        inspected++;
        // 定位"Core 已成功提交"的审计（success/partial 都代表 event 已持久化）
        const audit = this.findCommittedAudit(
          project.id, pv.id, 'commit_proposal',
        );
        const coreEventId =
          (audit?.detail as { coreEventId?: string } | undefined)?.coreEventId;
        if (!coreEventId) {
          // 无"Core 已提交"审计 → 合法待提交，保持 author_approved，不误伤
          continue;
        }

        // 恢复 PV → committed + 补建 coreRef + 来源草案 → committed。
        // 三步写包进单一事务（§25 #10 + 半态恢复）：此前三步各自独立 try/catch，
        // 若 updateProposalView 成功而 createCoreRef 失败，PV 已 committed 但 coreRef 缺，
        // 且 PV 不再是 author_approved → reconcile 不会再碰 → 永久半态无恢复路径。
        // 事务化保证三步要么全成功要么全回滚，失败则留待下次 reconcile 重试。
        // 闭包外提取值（避免 TS 对 runInTransaction 泛型闭包内的窄化丢失）。
        // writingStore 经 :707 的 if(!this.writingStore)return 守卫保证非空，但闭包内 TS 丢失窄化。
        const store = this.writingStore;
        const pvId: string = pv.id;
        const projectId: string = project.id;
        const sourceDraftId: string | undefined = pv.sourceDraftId;
        const resolvedCoreEventId: string = coreEventId;
        try {
          store.runInTransaction(() => {
            store.updateProposalView(pvId, {
              status: 'committed',
              coreEventId: resolvedCoreEventId,
              // §25 #10 修正：不伪造 authorDecision:'确认提交'（对账不得创造作者确认）。
              // 改为明确标记是系统对账恢复——区分"作者确认提交"与"系统恢复提交"。
              authorDecision: '系统对账恢复',
            });

            // 补建 coreRef（幂等：createCoreRef 自带去重）
            store.createCoreRef(projectId, {
              writingObjectType: 'proposal_view',
              writingObjectId: pvId,
              coreObjectType: 'event',
              coreObjectId: resolvedCoreEventId,
            });

            // 来源草案 → committed
            if (sourceDraftId) {
              const draft = store.getDraft(sourceDraftId);
              if (draft && draft.status !== 'committed') {
                store.updateDraft(sourceDraftId, draft.version, {
                  status: 'committed',
                });
              }
            }
          });
        } catch {
          // 事务整体失败 → PV 仍 author_approved，下次 reconcile 会重试
          continue;
        }

        this.recordRecoveryAudit(
          project.id, 'proposal_view', pv.id, coreEventId, 'author_approved',
        );
        recovered.push(pv.id);
      }
    }
    return { recovered, inspected };
  }

  /**
   * 对账恢复孤儿实体——修复"Core 已注册但草图仍 approved"的对象。
   *
   * 与 reconcileCommittedProposals 对称：registerReviewedEntity 在 Core register_entity 成功后
   * 回写整体失败（partial）时，草图停在 approved 而 Core 已持久化 entity。本方法据 register_entity
   * 审计（detail.coreEntityId / entityKind）回写恢复为 registered。
   */
  reconcileRegisteredEntities(): ReconcileResult {
    if (!this.writingStore) return { recovered: [], inspected: 0 };

    const recovered: string[] = [];
    let inspected = 0;
    for (const project of this.writingStore.listProjects()) {
      const orphans = this.writingStore.listEntitySketches(project.id, {
        status: 'approved',
      });
      for (const sketch of orphans) {
        inspected++;
        const audit = this.findCommittedAudit(
          project.id, sketch.id, 'register_entity',
        );
        const detail = audit?.detail as
          | { coreEntityId?: string; entityKind?: string }
          | undefined;
        const coreEntityId = detail?.coreEntityId;
        if (!coreEntityId) continue;

        try {
          this.writingStore.updateEntitySketch(sketch.id, {
            status: 'registered',
            coreEntityId,
            // entityKind 一并补齐（注册回写失败时未写入）
            coreKind: detail?.entityKind ?? undefined,
          });
        } catch {
          continue;
        }

        try {
          this.writingStore.createCoreRef(project.id, {
            writingObjectType: 'entity_sketch',
            writingObjectId: sketch.id,
            coreObjectType: 'entity',
            coreObjectId: coreEntityId,
          });
        } catch {
          // ref 可后续补建
        }

        this.recordRecoveryAudit(
          project.id, 'entity_sketch', sketch.id, coreEntityId, 'approved',
        );
        recovered.push(sketch.id);
      }
    }
    return { recovered, inspected };
  }

  /** 组合入口：依次对账提案与实体。CLI 启动时调用一次。 */
  reconcile(): { proposals: ReconcileResult; entities: ReconcileResult } {
    return {
      proposals: this.reconcileCommittedProposals(),
      entities: this.reconcileRegisteredEntities(),
    };
  }

  /**
   * 查找某写作对象最近一次"Core 已成功写入"的审计（result=success/partial）。
   *
   * queryAuditLogs 默认按 created_at DESC 返回，取首条 success/partial 即最新一次"已写入"。
   * 返回 undefined 表示该对象从未在 Core 成功提交/注册 → 是合法的待处理对象，不应恢复。
   */
  private findCommittedAudit(
    projectId: string,
    targetId: string,
    action: string,
  ): WritingAuditLog | undefined {
    const logs = this.writingStore!.queryAuditLogs(projectId, {
      action,
      targetId,
      limit: 10,
    });
    return logs.find(l => l.result === 'success' || l.result === 'partial');
  }

  /**
   * 记录对账恢复审计（trigger=system_recovery）。
   *
   * 与提交/注册审计区分（action 前缀 reconcile_），便于追溯"哪些对象是启动时恢复的"。
   * auditService 未注入时静默跳过——恢复本身以写作层状态为准，审计为辅。
   */
  private recordRecoveryAudit(
    projectId: string,
    targetType: string,
    targetId: string,
    coreObjectId: string,
    recoveredFrom: string,
  ): void {
    this.auditService?.record(
      makeRequestContext({ projectId, trigger: 'system_recovery' }),
      {
        action: `reconcile_${targetType}`,
        targetType,
        targetId,
        result: 'success',
        detail: { coreObjectId, recoveredFrom },
      },
    );
  }

  /**
   * 记录审计——auditService 可选，未注入时静默跳过（不阻断提交流程）
   *
   * 审计是可恢复性与可追溯性的依据，但不是提交成功的前置条件。
   */
  private recordAudit(
    ctx: WritingRequestContext,
    params: {
      action: string;
      targetType: string;
      targetId: string;
      result: 'success' | 'failure' | 'partial';
      errorCode?: string;
      detail?: unknown;
      // W14：审计来源追溯（§4 SourceRef）——逐层透传到 store.recordAudit 写 source_refs_json
      sourceRefs?: SourceRef[];
    },
  ): void {
    this.auditService?.record(ctx, params);
  }
}

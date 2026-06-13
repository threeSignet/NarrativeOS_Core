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
  CoreErrorExplanation,
} from './core-bridge-service.js';
import { mapTypeLabelToEntityKind } from '../services/blueprint-service.js';

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

  /**
   * @param toolRouter Core 的 ToolRouter 实例
   * @param writingStore 可选——写作层存储，用于 commit/register 时查找 Core ID
   *                     不传时 commit 和 register 方法将抛错（CLI 确认通道必须传入）
   */
  constructor(toolRouter: ToolRouter, writingStore?: SQLiteWritingStore) {
    this.toolRouter = toolRouter;
    this.writingStore = writingStore;
  }

  // =========================================================================
  // 沙盒/只读（Agent 可调用）
  // =========================================================================

  /**
   * 草案沙盒推演——调用 Core propose_event
   *
   * ProposalResult 字段是 camelCase（Core 内部类型）。
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
    const wrapper = await this.toolRouter.execute('propose_event', {
      event_type: params.eventType,
      event_description: params.eventDescription,
      chapter: params.chapter,
      fact_changes: params.factChanges,
      subject: params.eventDescription, // Core 要求 subject 不能为空
      context: 'global',
    }) as ToolResultWrapper<Record<string, unknown>>;

    if (!wrapper.success) {
      throw new Error(
        `Core 推演失败: [${wrapper.error.code}] ${wrapper.error.message}`,
      );
    }

    // ProposalResult 使用 camelCase 字段名
    const data = wrapper.data;
    return {
      proposalId: data.proposalId as string,
      isSafeToCommit: data.isSafeToCommit as boolean,
      report: data.simulationReportMarkdown as string,
    };
  }

  /**
   * 重新推演审核中的提案
   *
   * Phase 7 暂未实现（需要从 ProposalView 提取原始参数后重调）
   */
  async simulateProposal(
    _projectId: string,
    _proposalViewId: string,
  ): Promise<SimulationResult> {
    throw new Error('simulateProposal: Phase 7 暂未实现重新推演逻辑');
  }

  /**
   * 读取当前世界状态快照
   */
  async readCurrentWorldSnapshot(_projectId: string): Promise<unknown> {
    const wrapper = await this.toolRouter.execute('get_context_slice', {
      current_chapter: 1,
      include_relations: true,
    }) as ToolResultWrapper<unknown>;

    if (!wrapper.success) {
      throw new Error(
        `Core 读取快照失败: [${wrapper.error.code}] ${wrapper.error.message}`,
      );
    }
    return wrapper.data;
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

  // =========================================================================
  // 写入（仅 CLI 确认通道调用，Agent 类型层面不可见）
  // =========================================================================

  /**
   * 提交已审核提案——调用 Core commit_event
   *
   * 从 ProposalView 中查找 coreProposalId（Core 的 proposal ID），
   * 而非直接使用 writing-layer 的 proposalViewId。
   */
  async commitReviewedProposal(
    _projectId: string,
    proposalViewId: string,
  ): Promise<CommitResult> {
    // 从 WritingStore 查找 Core proposal ID
    if (!this.writingStore) {
      return {
        success: false,
        error: {
          errorCode: 'COREBRIDGE_CONFIG_ERROR',
          humanMessage: 'CoreBridge 未配置 WritingStore，无法提交',
          suggestedActions: ['请确保 CLI 确认通道正确初始化 CoreBridge'],
          isRecoverable: false,
        },
      };
    }

    const pv = this.writingStore.getProposalView(proposalViewId);
    if (!pv) {
      return {
        success: false,
        error: {
          errorCode: 'WRITING_OBJECT_NOT_FOUND',
          humanMessage: `找不到审核视图: ${proposalViewId}`,
          suggestedActions: ['检查提案是否已过期或被删除'],
          isRecoverable: false,
        },
      };
    }
    if (!pv.coreProposalId) {
      return {
        success: false,
        error: {
          errorCode: 'PROPOSAL_NOT_IN_REVIEW',
          humanMessage: '该审核视图没有关联的 Core 提案（可能尚未推演）',
          suggestedActions: ['请先执行沙盒推演'],
          isRecoverable: false,
        },
      };
    }

    // P0-3 修复：status 前置校验——只有 author_approved 才能提交（§7.7 步骤1）
    if (pv.status !== 'author_approved') {
      return {
        success: false,
        error: {
          errorCode: 'PROPOSAL_NOT_IN_REVIEW',
          humanMessage: `审核视图状态为 "${pv.status}"，必须先经确认通道批准为 "author_approved" 才能提交`,
          suggestedActions: ['请通过 CLI 确认通道批准该提案'],
          isRecoverable: false,
        },
      };
    }

    const wrapper = await this.toolRouter.execute('commit_event', {
      proposal_id: pv.coreProposalId,
    }) as ToolResultWrapper<Record<string, unknown>>;

    if (!wrapper.success) {
      // P0-1 修复：提交失败时把 ProposalView 标记为 commit_failed（而非留在 author_approved），
      // 使 §7.11.2 恢复路径可触发
      const failureExplanation = this.explainCoreFailure(wrapper as ToolResultErr);
      this.writingStore.updateProposalView(proposalViewId, {
        status: 'commit_failed',
        commitError: failureExplanation,
      });
      return {
        success: false,
        error: failureExplanation,
      };
    }

    // commit_event 返回 snake_case 字段（LLM 接口格式）
    const coreEventId = wrapper.data.event_id as string;

    // P0-1 修复：Core 提交成功后完整回写写作层（§7.7 步骤4）
    //   1. ProposalView → committed + 写 coreEventId
    //   2. 创建 WritingCoreRef（写作对象 ↔ Core event 双向索引，供 Retcon 影响分析）
    //   3. 来源草案 → committed
    // 此前这些回写被遗漏，导致 ProposalView 永远停在 author_approved
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
      this.writingStore.updateDraft(pv.sourceDraftId, { status: 'committed' });
    }

    return {
      success: true,
      coreEventId,
    };
  }

  /**
   * 注册已审核实体——调用 Core register_entity
   *
   * 从 EntitySketch 中查找 entityName、entityKind 等信息后调用 Core。
   */
  async registerReviewedEntity(
    _projectId: string,
    sketchId: string,
  ): Promise<RegisterEntityResult> {
    if (!this.writingStore) {
      return {
        success: false,
        error: {
          errorCode: 'COREBRIDGE_CONFIG_ERROR',
          humanMessage: 'CoreBridge 未配置 WritingStore，无法注册实体',
          suggestedActions: ['请确保 CLI 确认通道正确初始化 CoreBridge'],
          isRecoverable: false,
        },
      };
    }

    const sketch = this.writingStore.getEntitySketch(sketchId);
    if (!sketch) {
      return {
        success: false,
        error: {
          errorCode: 'WRITING_OBJECT_NOT_FOUND',
          humanMessage: `找不到实体草图: ${sketchId}`,
          suggestedActions: ['检查实体是否已被删除'],
          isRecoverable: false,
        },
      };
    }

    // P0-3 修复：status 前置校验——只有 approved 才能注册（§7.7 registerReviewedEntity 前置条件）
    if (sketch.status !== 'approved') {
      return {
        success: false,
        error: {
          errorCode: 'INVALID_STATUS_TRANSITION',
          humanMessage: `实体状态为 "${sketch.status}"，必须先批准为 "approved" 才能注册`,
          suggestedActions: ['请先通过 approveCandidate 批准该候选实体'],
          isRecoverable: false,
        },
      };
    }

    // 按优先级解析 entityKind：sketch 已有 > Blueprint 映射 > 硬编码映射
    let entityKind = sketch.coreKind;
    if (!entityKind) {
      const activeBlueprint = this.writingStore.getActiveBlueprint(_projectId);
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
      // P0-1 修复：注册失败时把草图标记为 error（可恢复态，§7.6 _markRegistrationFailed 语义）
      const failureExplanation = this.explainCoreFailure(wrapper as ToolResultErr);
      this.writingStore.updateEntitySketch(sketchId, { status: 'error' });
      return {
        success: false,
        error: failureExplanation,
      };
    }

    const coreEntityId = wrapper.data.entity_id as string;

    // P0-1 修复：Core 注册成功后完整回写写作层（§7.6/§7.7）
    //   1. sketch → registered + 写 coreEntityId/coreKind
    //   2. 创建 WritingCoreRef（草图 ↔ Core entity 双向索引）
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

    return {
      success: true,
      coreEntityId,
      coreKind: entityKind,
    };
  }
}

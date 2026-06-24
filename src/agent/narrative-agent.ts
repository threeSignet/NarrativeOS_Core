// =============================================================================
// NarrativeAgent — Core 之上的智能体会话层
// =============================================================================
// §4 内部 ReAct 循环：NarrativeAgent 是 LLM 认知核心 + 会话运行监管 +
//                       Core 确定性校验。
//
// 设计要点：
//   - 不直接读写 Core 内部表，不绕过 ToolRouter 修改世界状态
//   - ReAct 循环是内部运行模型，用户只看到自然语言回复
//   - 提交主权归用户，默认 explicit_user_confirmation
//   - 工具失败后必须先反思再继续
//   - Trace 写入项目数据库，但只记录可审计摘要
//   - 完整消息原文持久化，压缩摘要用于控制上下文窗口
//
// 切换项目：
//   Agent 构造时绑定 projectId 和 ToolRouter（project-specific）。
//   切换项目 = 销毁当前 Agent + 用新 projectId 重建。
//   构造是同步的，无网络调用，成本极低。
//
// 对应设计文档：
//   §4  ReAct 循环
//   §5  运行时状态
//   §6  意图理解与动态规划
//   §7  草案、提案、提交
//   §8  提交主权
//   §9  用户确认识别
//   §10 失败反思
//   §11 工具循环监管
//   §12 输出与沟通
//   §13 Trace 持久化
//   §15 上下文压缩与长期记忆
//   §16 回合结束判定
// =============================================================================

import type { LLMClient, ChatMessage, ToolDefinition, ChatOptions, ToolCallResult } from '../types/llm.js';
import type { ToolRouter } from '../core/tool-router.js';
import type { ToolResult, ToolError, ToolErrorCode, ProposalResult } from '../types/tool.js';
import type { SQLiteAgentStoreAdapter } from '../adapters/sqlite/agent-store.js';
import type { SQLiteWritingStore } from '../writing/repositories/writing-store.js';
import type { AuditService } from '../writing/services/audit-service.js';
import type { WorkflowService } from '../writing/services/workflow-service.js';
import type { DraftService } from '../writing/services/draft-service.js';
import type { EntityService } from '../writing/services/entity-service.js';
import type { CoreBridgeService } from '../writing/core-bridge/core-bridge-service.js';
import type { ProjectService } from '../writing/services/project-service.js';
import type { IdeaService } from '../writing/services/idea-service.js';
import type { BlueprintService } from '../writing/services/blueprint-service.js';
import type { WritingRequestContext, WritingTrigger } from '../writing/services/context.js';
import { makeRequestContext } from '../writing/services/context.js';
// W13：Agent ReAct 产物（草案/提案）委托写作层——投影为可审核的 WritingDraft + ProposalView
import type { WritingDraft, PendingDecisionItem } from '../writing/models/types.js';
import { validateDraftTransition } from '../writing/models/state-machine.js';
import { buildProposalReviewData } from '../writing/view-models/proposal-review.js';
import { proposalResultToSimulationResult } from '../writing/core-bridge/proposal-result-adapter.js';
import type { SimulationResult } from '../writing/core-bridge/core-bridge-service.js';
// W1：Agent 工具权限门控——ReAct 循环禁止直接写正式世界状态
import { isToolForbiddenForAgent, forbiddenToolResult, AGENT_FORBIDDEN_TOOLS } from '../writing/agent/tool-permissions.js';
// W2：Agent↔写作层桥接——写作层状态注入 + 结构化推演展示
import { renderProposalForUser } from '../writing/agent/agent-adapter.js';
import type { WritingLayerServices } from '../writing/agent/agent-adapter.js';
import { assembleWritingContext } from '../writing/agent/context-assembly.js';
// W2 Fix-3：世界快照类型——runReActLoop 每回合预取一次，穿透 buildLlmMessages → assembleWritingContext
import type { WorldSnapshot } from '../writing/core-bridge/core-bridge-service.js';
// W2：写作层 service 方法权限矩阵——作者确认通道的 commit/register/resolve 调用经 caller 标记豁免
import { assertAgentMayCall, AUTHOR_CONFIRM_CHANNEL } from '../writing/agent/permission-check.js';
// W2 Fix-4：writingLayer 模式禁裸提交——handleConfirmCommit 守卫抛 COMMIT_WITHOUT_REVIEW（激活死错误码）
import { WritingError, WritingErrorCode } from '../writing/errors/error-codes.js';
import type {
  NarrativeAgentRuntimeState,
  AgentWorkingDraft,
  AgentWorkingDraftStatus,
  AgentPlan,
  AgentMemoryState,
  AgentMessage,
  AgentTraceRecord,
  AgentTraceStepType,
  AgentTraceStatus,
  AgentFailureReflection,
  AgentNextAction,
  AgentTurnStatus,
  CommitAuthority,
  NarrativeAgentRuntimeLimits,
  UserIntent,
  AgentLongTermMemory,
  AgentCallbacks,
  AgentKeywordConfig,
} from './types.js';
import {
  DEFAULT_RUNTIME_LIMITS,
  DEFAULT_COMMIT_AUTHORITY,
} from './types.js';
import { MemoryManager } from './memory-manager.js';
import { ContextCompressor, estimateTokens } from './context-compressor.js';
import type { RelevantFactRetriever } from '../core/relevant-fact-retriever.js';
import type { FactRenderer } from '../core/fact-renderer.js';
import type { WorldPackage } from '../types/world.js';

// =============================================================================
// 默认系统提示词
// =============================================================================

/**
 * 构建 system prompt 核心（合并 DEFAULT + WP 版，消除重复）。
 *
 * @param worldContext 可选的世界观上下文（WP 版注入谓词段）。无 WP 时传 undefined。
 */
function buildSystemPromptCore(worldContext?: {
  worldName?: string;
  predicateSection?: string;  // 含谓词列表 + 常用谓词示例的完整段落
}): string {
  const worldLine = worldContext?.worldName
    ? `\n当前世界观：${worldContext.worldName}`
    : '';

  const predicateSection = worldContext?.predicateSection
    ? `\n${worldContext.predicateSection}\n`
    : '\n  基础谓词（realm/status/technique/weapon/location/mentor/secret/announcement 等）已全部就绪，无需扩展。\n';

  return `你是 NarrativeAgent，一个面向长篇叙事写作的世界状态一致性引擎的智能体助手。${worldLine}

## 你的角色
你帮助作者管理和维护小说的世界状态。你可以查询当前状态、提议事件变更、提交变更、管理叙事线索等。

## 核心原则
1. **智能决策**：理解用户的写作意图，自主决定下一步行动。
2. **区分草案与正式状态**：用户的修改先形成"草案"，只有用户明确确认后才提交为正式世界状态。
3. **提交主权归用户**：默认情况下，你必须等待用户明确确认后才能提交事件。除非你被明确授权自动提交。
4. **先查后改**：修改前先查询当前状态，确保你的提案基于最新世界状态。
5. **失败反思**：工具调用失败后，分析原因，调整策略，不要原样重试。

## 工作方式
- 你可以调用工具来查询和修改世界状态。
- 每一步工具调用后，你都会看到执行结果。
- 如果工具失败，你会收到错误信息和修复建议。
- 你可以多轮调用工具来完成复杂任务。
- 最终回复必须是自然语言，说明你做了什么、发现了什么、还需要用户做什么。
- **一次只做一个关键操作**：不要在回复中声称要做多件事（"先查询、再提取、再推演"）却一个工具都没调用。如果任务需要多步，**先调用第一个工具，拿到结果后再决定下一步**。宁可分多轮完成，也不要在一轮里空谈计划而不执行。

## 工具使用指南
- detect_entity_hints：从正文/设定中提取实体线索（角色/地点/物品），创建候选实体草图。这是注册实体的第一步——提取后系统生成 hint 供作者审批。**不要在回复中声称实体"已注册"——必须先调用此工具。**
- propose_event：推演事件提案。推演完成后展示结果，**不要自行调用 commit_event**。
- commit_event：**禁止直接调用**。提交必须通过 Proposal Review 流程由用户确认后执行。
- register_entity：**禁止直接调用**（与 commit_event 同级）。实体注册须经 detect_entity_hints → 审批 → 确认通道。
- get_context_slice：查询实体当前状态（修改前先查询）
- **不要使用** propose_schema_extension / commit_schema_extension，除非用户明确要求添加新的自定义谓词类型。${predicateSection}
## 【重要】工具使用硬约束
- **任何会改变世界状态的操作（注册实体、写入事件、提交变更）都必须通过调用对应工具完成。**
- **绝对不得在回复文本中声称"已完成"某操作而实际未调用工具。** 例如不能说"已注册沈墨"而没调 detect_entity_hints；不能说"事件已提交"而没走确认流程。
- 如果你无法调用某工具（被权限拒绝、工具不存在），请如实告知用户，并建议操作方式（如"请在确认后由系统注册"）。
- 回复中描述操作结果时，必须基于工具返回的真实数据，不得编造实体 ID、Fact ID 或状态。

## 矛盾检测流程（重要）
**推演事件前，必须先查询涉及实体的当前状态。** 这是硬性要求，不是建议。
1. **先查后推**：调用 get_context_slice 查询涉及实体的当前状态（status/realm/location）。未查询不得直接 propose_event。
2. **查到终态要报矛盾**：如果查到实体处于"已陨落/已死亡/已销毁/已碎裂"等终态，而用户的输入让该实体再次出现/使用——这是时序悖论，报矛盾并拒绝推演。
3. **查到属性不同要判断方向**：
   - 用户描述的是"从当前值变成新值"（如筑基→金丹）= 合法变化，调 propose_event 记录。
   - 用户描述的内容否定当前值（如"一直是筑基期"但当前是金丹期）= 设定冲突，报矛盾。
4. **正常推进必须推演**：如果查询后确认无矛盾（合法变化/新剧情），必须调 propose_event 推演，不要无故拒绝。

## 禁止行为
- 不暴露你的内部推理链（注：这不影响 reasoning_content 回传 API，只是不对用户展示思维过程）。
- 不把工具失败包装成成功。
- 用户仍在修改时，不自动提交。
- 不编造不存在的实体 ID 或 Fact ID。
- 不用文本描述代替工具调用（见上方"工具使用硬约束"）。`;
}

const DEFAULT_SYSTEM_PROMPT = buildSystemPromptCore();

// =============================================================================
// 用户确认识别关键词
// =============================================================================

/** 明确确认提交的关键词 */
const CONFIRM_KEYWORDS = [
  '就按这个提交', '写入正史', '确认', '可以提交', '定稿',
  '这一版通过', '就这么办', '提交吧', '通过',
];

/** 继续协商的关键词 */
const REVISE_KEYWORDS = [
  '再改一下', '我觉得不对', '如果换成', '先别提交',
  '等等', '这个地方需要调整', '再想想', '不太好',
  '换个方式', '修改', '重来',
];

// =============================================================================
// NarrativeAgent
// =============================================================================

export class NarrativeAgent {
  private llm: LLMClient;
  private toolRouter: ToolRouter;
  private agentStore: SQLiteAgentStoreAdapter;
  private projectId: string;
  private limits: NarrativeAgentRuntimeLimits;
  private state: NarrativeAgentRuntimeState;
  private memoryManager: MemoryManager;
  private contextCompressor: ContextCompressor;
  private sessionStartTime: number = 0;
  // P0-1: Push 检索管线依赖（可选，不传则跳过 Push 注入）
  private retriever?: RelevantFactRetriever;
  private renderer?: FactRenderer;
  private entityNames: Record<string, string>;
  // P0-2: World Package（可选，用于动态生成系统提示词）
  private worldPackage?: WorldPackage;
  // P0-3: 生命周期回调
  private callbacks?: AgentCallbacks;
  // P1-6: 可配置关键词
  private confirmKeywords: string[];
  private reviseKeywords: string[];
  // P2-13: trace 缓冲区大小限制
  private maxTraceBufferSize: number;
  // Phase 7: 写作层服务（可选，注入后启用 Phase 7 行为）
  private writingProjectId?: string;
  private writingStore?: SQLiteWritingStore;
  private auditService?: AuditService;
  private workflowService?: WorkflowService;
  private draftService?: DraftService;
  private entityService?: EntityService;
  private coreBridge?: CoreBridgeService;
  // W2：§8.5.5 聚合容器缺的 3 个写作层服务（CLI/chat 已实例化，此前未注入 Agent）
  private projectService?: ProjectService;
  private ideaService?: IdeaService;
  private blueprintService?: BlueprintService;
  // W2：写作层状态注入所需的聚合容器（§8.5.5 WritingLayerServices）。仅当必填项
  // （writingStore + workflowService + writingProjectId）齐备时组装，否则 undefined——
  // 裸路径与部分接线的测试环境不触发写作层状态注入，行为与原内联块门控等价。
  private writingLayer?: WritingLayerServices;
  // W13-a/P3：writingLayer 路径下，当前 Agent 协商草案对应的 WritingDraft.id 与乐观锁版本。
  // 仅 writingLayer 注入时使用——裸路径下 state.workingDraft.id 是 agent_working_drafts 的 id。
  // 版本号随每次 writingStore.updateDraft（W3 乐观锁）返回的 newVersion 递增，保证多次推进不冲突。
  private writingDraftId?: string;
  private writingDraftVersion: number = 0;

  /**
   * @param llm        LLMClient 实例
   * @param toolRouter ToolRouter 实例（持有所有 Core 组件引用）
   * @param agentStore Agent 持久化适配器
   * @param projectId  项目 ID
   * @param limits     运行时安全护栏（可选）
   */
  constructor(deps: {
    llm: LLMClient;
    toolRouter: ToolRouter;
    agentStore: SQLiteAgentStoreAdapter;
    projectId: string;
    limits?: Partial<NarrativeAgentRuntimeLimits>;
    /** P0-1: Push 检索管线（可选，不传则跳过 Push 注入） */
    retriever?: RelevantFactRetriever;
    renderer?: FactRenderer;
    entityNames?: Record<string, string>;
    /** P0-2: World Package，用于动态生成系统提示词 */
    worldPackage?: WorldPackage;
    /** P0-3: 生命周期回调 */
    callbacks?: AgentCallbacks;
    /** P1-6: 自定义确认/协商关键词 */
    keywords?: AgentKeywordConfig;
    /** P2-13: trace 缓冲区最大条数 */
    maxTraceBufferSize?: number;
    /** Phase 7: 写作层项目 ID（写作层项目不同于 Core 项目 ID） */
    writingProjectId?: string;
    /** Phase 7: 写作层服务（可选，注入后启用 CLI 确认通道 + 写作层委托） */
    writingStore?: SQLiteWritingStore;
    auditService?: AuditService;
    workflowService?: WorkflowService;
    draftService?: DraftService;
    entityService?: EntityService;
    coreBridge?: CoreBridgeService;
    /** W2：§8.5.5 聚合容器缺的 3 个写作层服务（CLI/chat 已实例化） */
    projectService?: ProjectService;
    ideaService?: IdeaService;
    blueprintService?: BlueprintService;
  }) {
    this.llm = deps.llm;
    this.toolRouter = deps.toolRouter;
    this.agentStore = deps.agentStore;
    this.projectId = deps.projectId;
    this.limits = { ...DEFAULT_RUNTIME_LIMITS, ...deps.limits };
    // Phase 7: 写作层服务注入
    this.writingProjectId = deps.writingProjectId;
    this.writingStore = deps.writingStore;
    this.auditService = deps.auditService;
    this.workflowService = deps.workflowService;
    this.draftService = deps.draftService;
    this.entityService = deps.entityService;
    this.coreBridge = deps.coreBridge;
    this.projectService = deps.projectService;
    this.ideaService = deps.ideaService;
    this.blueprintService = deps.blueprintService;

    // W2：组装写作层状态注入聚合容器（§8.5.5）。仅当必填项（writingStore + workflowService
    // + writingProjectId）齐备时才组装——这与原内联块的门控（writingStore && writingProjectId
    // + workflowService）等价，保证裸路径与部分接线的测试环境不触发写作层状态注入。
    // 选填服务（project/idea/blueprint/draft/entity/audit/coreBridge）按"有则纳入"注入，
    // 消费方（assembleWritingContext / buildSystemPrompt）各自对缺省项降级处理。
    if (this.writingStore && this.workflowService && this.writingProjectId) {
      this.writingLayer = {
        writingStore: this.writingStore,
        workflowService: this.workflowService,
        projectService: this.projectService,
        ideaService: this.ideaService,
        blueprintService: this.blueprintService,
        draftService: this.draftService,
        entityService: this.entityService,
        auditService: this.auditService,
        coreBridge: this.coreBridge,
      };
    }

    // 初始化长期记忆管理器和上下文压缩器
    this.memoryManager = new MemoryManager(this.agentStore, this.projectId);
    this.contextCompressor = new ContextCompressor(this.agentStore);

    // P0-1: Push 检索管线
    this.retriever = deps.retriever;
    this.renderer = deps.renderer;
    this.entityNames = deps.entityNames ?? {};

    // P0-2: World Package
    this.worldPackage = deps.worldPackage;

    // P0-3: 回调
    this.callbacks = deps.callbacks;

    // P1-6: 关键词（合并默认值和用户传入值）
    this.confirmKeywords = [...CONFIRM_KEYWORDS, ...(deps.keywords?.confirm ?? [])];
    this.reviseKeywords = [...REVISE_KEYWORDS, ...(deps.keywords?.revise ?? [])];

    // P2-13: trace 缓冲区限制
    this.maxTraceBufferSize = deps.maxTraceBufferSize ?? 500;

    // P3-16: 初始化校验——检查 agentStore 的关键表是否存在
    this.validateInit();

    // 初始化运行时状态
    this.state = this.createInitialState();
  }

  /** 获取当前运行时状态（只读快照） */
  getState(): Readonly<NarrativeAgentRuntimeState> {
    return this.state;
  }

  // =========================================================================
  // 公开入口
  // =========================================================================

  /**
   * 处理用户输入，返回 Agent 回复
   *
   * 这是一个完整的 ReAct 循环：
   *   接收输入 → 构建上下文 → LLM Reason → Act(工具) → Observe(结果)
   *   → Reflect(失败时) → 继续循环直到 LLM 回复文本 → Respond
   *
   * @param userInput 用户输入文本
   * @param options   可选参数（systemPrompt、temperature 等）
   * @returns Agent 的自然语言回复
   */
  async processUserInput(userInput: string, options?: {
    systemPrompt?: string;
    temperature?: number;
    commitAuthority?: CommitAuthority;
    /** 流式输出回调：LLM 每返回一个文本 token 时实时调用 */
    onToken?: (token: string) => void;
    /** P0-1: 当前写作章节号（传入时更新 state.currentChapter） */
    chapter?: number;
    /** P0-1: 显式指定的相关实体 ID（降级方案：用户输入中无法提取 ent_* ID 时由写作层传入） */
    relevantEntityIds?: string[];
  }): Promise<AgentTurnResult> {
    // ---- 更新章节号 ----
    if (options?.chapter !== undefined) {
      this.state.currentChapter = options.chapter;
    }
    // ---- 回合开始 ----
    const turnId = this.startNewTurn(userInput, options?.commitAuthority);

    try {
      // ---- 添加用户消息 ----
      this.addUserMessage(userInput, turnId);

      // ---- Phase 7: CLI 确认通道优先拦截（在任何 Agent 逻辑之前） ----
      const cliResult = await this.handlePendingDecisions(userInput);
      if (cliResult !== null) {
        this.finalizeTurn(turnId, cliResult.status);
        return cliResult;
      }

      // ---- 判断用户意图 ----
      const intent = this.detectIntent(userInput);

      // ---- 长期记忆：从用户输入中提取偏好 ----
      this.memoryManager.extractPreference(userInput, this.state.sessionId, turnId);

      // ---- 处理确认识别（Phase 7: CLI 通道已拦截，此处仅保留向后兼容） ----
      if (intent === 'confirm_commit' && this.hasPendingProposals()) {
        // 如果有 writingLayer，提示使用 Proposal Review 流程
        if (this.writingStore) {
          return { turnId, status: 'completed', content: '当前没有待确认的提案。你想提交什么？' };
        }
        // 向后兼容：旧行为保留
        return await this.handleConfirmCommit(turnId);
      }

      // ---- 处理拒绝/废弃 ----
      if (intent === 'reject_draft') {
        return this.handleRejectDraft(turnId);
      }

      // ---- ReAct 主循环 ----
      const result = await this.runReActLoop(turnId, intent, userInput, {
        systemPrompt: options?.systemPrompt,
        temperature: options?.temperature,
        onToken: options?.onToken,
        relevantEntityIds: options?.relevantEntityIds,
      });

      // ---- agent_authorized_for_session：自动提交本回合产生的待决提案 ----
      // 该模式专为 live 验证 / 自动化测试而设（见 types.ts CommitAuthority 注释：
      // "当前会话内 Agent 可自动提交"）。W1 提交门控拦截的是 LLM 在 ReAct 循环里
      // 直接调用 commit_event（§8.0）；此处走 handleConfirmCommit——经授权的独立写入入口，
      // 其内部直接调用 toolRouter.execute('commit_event')，绕过 ReAct 工具门控
      // （见 tool-permissions.ts 注释）。从而恢复该模式的文档化语义：单回合内提案即落库，
      // 而非无限堆积在 pendingProposalIds（这正是 e2e 场景 A 断言 facts>0 失败的根因）。
      //
      // 作用域限制——只在两个前提下生效，避免误伤其它路径：
      //   1. commitAuthority === 'agent_authorized_for_session'（会话级授权）
      //   2. 无 writingLayer（裸 Agent / e2e 路径）：CLI/writingLayer 路径仍走 Proposal Review
      //      （CoreBridge.commitReviewedProposal），其"授权自动提交"需要 pendingProposalIds↔
      //      ProposalView 映射（W13 差距），暂不在本路径处理，避免双轨制下绕过审核。
      //   3. 回合未异常终止（completed / needs_user_confirmation）：suspended/failed 不自动提交。
      if (
        this.state.commitAuthority === 'agent_authorized_for_session' &&
        !this.writingStore &&
        this.hasPendingProposals() &&
        (result.status === 'completed' || result.status === 'needs_user_confirmation')
      ) {
        const commitResult = await this.handleConfirmCommit(turnId);
        // 保留 LLM 的自然语言回复，附加提交结果摘要；回合状态以提交结果为准
        // （全部提交成功→completed，部分失败→needs_user_confirmation，交由调用方/测试感知）
        const merged: AgentTurnResult = {
          ...result,
          content: [result.content, commitResult.content].filter(Boolean).join('\n\n'),
          status: commitResult.status,
        };
        this.finalizeTurn(turnId, merged.status);
        return merged;
      }

      // ---- W13：/auto writingLayer 自动确认（与上方裸路径互斥）----
      // writingLayer 下本回合的 propose_event 已由 materializeProposalView 物化为 PV + PendingDecision；
      // agent_authorized_for_session 模式需自动确认这些 PV，恢复"单回合落库"语义。
      // 走 autoApprovePendingDecisions（applyDecisionConfirm，与作者自然语言确认同源），
      // 而非裸路径 handleConfirmCommit——两个 if 通过 !writingStore / writingStore 互斥，不可能同时进入。
      if (
        this.state.commitAuthority === 'agent_authorized_for_session' &&
        this.writingStore &&
        this.workflowService &&
        this.coreBridge &&
        this.hasPendingProposals() &&
        (result.status === 'completed' || result.status === 'needs_user_confirmation')
      ) {
        const commitResult = await this.autoApprovePendingDecisions(turnId);
        const merged: AgentTurnResult = {
          ...result,
          content: [result.content, commitResult.content].filter(Boolean).join('\n\n'),
          // 任一决策失败→needs_user_confirmation，让调用方/测试感知 partial 失败
          status: commitResult.success ? 'completed' : 'needs_user_confirmation',
        };
        this.finalizeTurn(turnId, merged.status);
        return merged;
      }

      // ---- W2 Phase C：非自动提交回合的 open PV → 把结构化推演追加到回复 ----
      // 仅非 /auto 路径走到这里（两条 /auto 分支已 return）。本回合的 propose_event 已由
      // materializeProposalView 物化为 open ProposalView，待作者自然语言确认；把
      // renderProposalForUser 的 Zone1-5 展示追加到 LLM 回复，使作者无需主动 /review 即可在
      // 对话里看到"系统准备写入什么、有哪些一致性风险"。Zone6（提交结果）仍由 applyDecisionConfirm
      // 的返回 content 承担，本处不重复渲染，避免双轨。
      //
      // 守卫：writingLayer + 当前协商草案（writingDraftId）+ 该草案有 open/author_approved PV
      //       + 回合未异常终止（completed/needs_user_confirmation）。任一不满足则不追加——
      //       特别是裸路径（无 writingLayer）与失败回合（failed/suspended）保持原回复不变。
      if (
        this.writingLayer &&
        this.writingStore &&
        this.writingDraftId &&
        (result.status === 'completed' || result.status === 'needs_user_confirmation')
      ) {
        const openPv = this.writingStore.getActiveProposalViewForDraft(this.writingDraftId);
        if (openPv) {
          const rendered = renderProposalForUser(openPv);
          // 原 LLM 自然语言回复在前，结构化推演在后；二者皆可能为空，filter(Boolean) 兜底
          result.content = [result.content, rendered].filter(Boolean).join('\n\n');
        }
      }

      // ---- 回合结束 ----
      this.finalizeTurn(turnId, result.status);
      return result;

    } catch (error) {
      // ---- 致命错误处理 ----
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.addTrace({
        projectId: this.projectId,
        sessionId: this.state.sessionId,
        turnId,
        stepIndex: this.state.traceBuffer.length,
        stepType: 'reflection_summary',
        status: 'error',
        summary: `致命错误：${errorMessage}`,
        detail: { error: errorMessage },
        nextAction: 'abort_turn',
      } as Omit<AgentTraceRecord, 'id' | 'createdAt'>);

      // P0-3: 通知错误
      this.callbacks?.onError?.('fatal', errorMessage, turnId);

      this.state.status = 'failed';
      this.finalizeTurn(turnId, 'failed');
      return {
        content: `抱歉，遇到了一个意外错误：${errorMessage}。请重试或换一种方式描述。`,
        status: 'failed',
        turnId,
        draft: this.state.workingDraft,
      };
    }
  }

  // =========================================================================
  // 会话管理
  // =========================================================================

  /**
   * 开始新的会话
   * @param title 会话标题（可选）
   * @returns sessionId
   */
  startSession(title?: string): string {
    const sessionId = this.agentStore.createSession(this.projectId, title);
    this.state.sessionId = sessionId;
    this.state.messages = [];
    this.state.traceBuffer = [];
    this.state.pendingProposalIds = [];
    // P2-10: 重置会话计时器，避免误触发 wall clock 超时
    this.sessionStartTime = Date.now();
    return sessionId;
  }

  /**
   * 恢复已有会话
   * @param sessionId 会话 ID
   */
  restoreSession(sessionId: string): boolean {
    const session = this.agentStore.getSession(sessionId);
    if (!session || session.status !== 'active') return false;

    this.state.sessionId = sessionId;
    this.state.commitAuthority = session.commit_authority as CommitAuthority;

    // 恢复消息历史
    const storedMessages = this.agentStore.getVisibleMessages(sessionId);
    this.state.messages = storedMessages.map(rowToAgentMessage);

    // 恢复活跃草案
    const activeDraft = this.agentStore.getActiveDraft(sessionId);
    if (activeDraft) {
      this.state.workingDraft = {
        id: activeDraft.id,
        status: activeDraft.status as AgentWorkingDraftStatus,
        summary: activeDraft.summary,
        structuredIntent: safeJsonParse(activeDraft.structured_intent_json),
        proposedFactChanges: safeJsonParse(activeDraft.proposed_changes_json) as unknown[] | undefined,
        proposalId: activeDraft.proposal_id ?? undefined,
        revisionCount: activeDraft.revision_count,
        createdAt: activeDraft.created_at,
        updatedAt: activeDraft.updated_at,
      };
    }

    // 恢复 trace
    this.state.traceBuffer = this.agentStore.getTracesBySession(sessionId);

    // P2-10: 重置会话计时器
    this.sessionStartTime = Date.now();

    // P2-11: 从 trace 重建 toolFailureCounts（只保留最近一轮的连续失败计数）
    this.state.toolFailureCounts = this.rebuildFailureCounts(this.state.traceBuffer);

    // P2-12: 无条件清空 pendingProposalIds（ProposalStore 是纯内存 Map，重启后已销毁）
    this.state.pendingProposalIds = [];
    this.addTrace({
      projectId: this.projectId,
      sessionId,
      turnId: '',
      stepIndex: 0,
      stepType: 'reflection_summary',
      status: 'warning',
      summary: `会话恢复，原待提交提案已失效，请重新 propose`,
    } as Omit<AgentTraceRecord, 'id' | 'createdAt'>);

    return true;
  }

  /**
   * 结束当前会话
   */
  closeSession(): void {
    if (this.state.sessionId) {
      this.agentStore.closeSession(this.state.sessionId);
    }
  }

  // =========================================================================
  // 内部：ReAct 主循环
  // =========================================================================

  private async runReActLoop(
    turnId: string,
    intent: UserIntent,
    userInput: string,
    options?: { systemPrompt?: string; temperature?: number; onToken?: (token: string) => void; relevantEntityIds?: string[] },
  ): Promise<AgentTurnResult> {
    let toolStepCount = 0;
    const maxSteps = this.limits.maxToolSteps;
    let lastAssistantContent: string | undefined;
    const onToken = options?.onToken;

    // 当意图涉及内容变更时，自动创建或初始化 working draft
    if (intent === 'new_content' || intent === 'revise_draft' || intent === 'request_simulation') {
      if (!this.state.workingDraft) {
        this.ensureWorkingDraft('用户输入：' + userInput, this.state.currentTurnId);
      }
    }

    // 记录会话开始时间（用于 maxWallClockMs 检查）
    if (this.sessionStartTime === 0) this.sessionStartTime = Date.now();

    // ---- W2 Fix-3：每回合预取一次 Core 世界快照（异步），穿透 buildLlmMessages ----
    // → assembleWritingContext 渲染"实体 + 当前设定事实"段（§8.3.3）。让 LLM 既拿到 entity ID
    // （构造 factChanges.subject）又知悉各实体当前已成立的设定（避免生成与既有设定矛盾的变更）。
    //
    // 预取而非每轮 ReAct 迭代都取：单回合内世界状态不变（提交只在作者确认后、循环外发生），
    // 一次预取即可供本回合所有迭代复用，避免 N 次重复 get_context_slice Core 调用（重，~30ms/实体）。
    //
    // 仅 writingLayer 且 coreBridge 注入时预取；裸路径（无 writingLayer）或部分接线（无 coreBridge）
    // 时 worldSnapshot 为 undefined——assembleWritingContext 自动回落到 listEntitySketches 轻量实体段
    // （与既有行为逐字一致，裸路径零回归）。预取失败（Core 异常）也降级为 undefined + warning trace，
    // 不阻断回合（读取用于增强 LLM 上下文，非正确性必需）。
    let worldSnapshot: WorldSnapshot | undefined;
    if (this.writingLayer?.coreBridge && this.writingProjectId) {
      try {
        worldSnapshot = await this.writingLayer.coreBridge.readCurrentWorldSnapshot(this.writingProjectId);
      } catch (err) {
        this.addTrace({
          projectId: this.projectId,
          sessionId: this.state.sessionId,
          turnId,
          stepIndex: this.state.traceBuffer.length,
          stepType: 'reflection_summary',
          status: 'warning',
          summary: `世界快照预取失败，降级为轻量实体段：${err instanceof Error ? err.message : String(err)}`,
          nextAction: 'continue',
        } as Omit<AgentTraceRecord, 'id' | 'createdAt'>);
      }
    }

    while (toolStepCount < maxSteps) {
      // ---- 安全护栏：wall clock 超时检查 ----
      const elapsed = Date.now() - this.sessionStartTime;
      if (elapsed > this.limits.maxWallClockMs) {
        this.addTrace({
          projectId: this.projectId,
          sessionId: this.state.sessionId,
          turnId,
          stepIndex: this.state.traceBuffer.length,
          stepType: 'reflection_summary',
          status: 'warning',
          summary: `会话 wall clock 超时（${Math.round(elapsed / 1000)}s > ${Math.round(this.limits.maxWallClockMs / 1000)}s），回合暂停`,
          nextAction: 'ask_user',
        } as Omit<AgentTraceRecord, 'id' | 'createdAt'>);
        this.state.status = 'suspended';
        return {
          content: `会话已运行 ${Math.round(elapsed / 1000)} 秒，超过限制。如需继续，请开启新会话。`,
          status: 'suspended',
          turnId,
          draft: this.state.workingDraft,
        };
      }

      // ---- 上下文压缩：长对话自动压缩早期消息 ----
      this.contextCompressor.maybeCompress(
        this.state.sessionId,
        this.state.messages,
        this.state.workingDraft,
      );

      // ---- Reason：调用 LLM ----
      // P0-1: Push 检索注入——只在每轮用户输入的第一轮 Reason 前执行（toolStepCount === 0）
      // 后续轮跳过，因为上下文已包含在消息历史中，避免重复 embedding 开销（~100ms/次）
      if (toolStepCount === 0 && this.retriever && this.renderer) {
        const pushResult = await this.runPushRetrieval(userInput, options?.relevantEntityIds);
        if (pushResult !== undefined) {
          this.callbacks?.onRetrievalInjected?.(pushResult);
        }
      }

      const messages = this.buildLlmMessages(options?.systemPrompt, worldSnapshot);

      // P0-5: 更新 token 预算估算
      this.state.memoryState.tokenBudgetEstimate = estimateTokens(messages);
      this.state.memoryState.updatedAt = new Date().toISOString();
      // 过滤掉 AGENT_FORBIDDEN_TOOLS（commit_event/register_entity）——LLM 看不到禁用工具，
      // 减少"尝试调禁用工具被拦"的无效往返。W1 的 isToolForbiddenForAgent 仍是运行时兜底。
      const tools = this.toolRouter.getDefinitions({
        excludeForbidden: [...AGENT_FORBIDDEN_TOOLS],
      }) as ToolDefinition[];

      this.addTrace({
        projectId: this.projectId,
        sessionId: this.state.sessionId,
        turnId,
        stepIndex: this.state.traceBuffer.length,
        stepType: 'reason_summary',
        status: 'ok',
        summary: `调用 LLM（第 ${toolStepCount + 1} 轮），消息数 ${messages.length}，工具 ${tools.length} 个`,
      } as Omit<AgentTraceRecord, 'id' | 'createdAt'>);

      // 优先使用流式调用（实时输出 token），降级为非流式
      let llmResult: ToolCallResult;
      if (onToken && this.llm.chatWithToolsStream) {
        llmResult = await this.llm.chatWithToolsStream(messages, tools, onToken, {
          temperature: options?.temperature,
        } as ChatOptions);
      } else {
        llmResult = await this.llm.chatWithTools(messages, tools, {
          temperature: options?.temperature,
        } as ChatOptions);
      }

      // 添加 assistant 消息到历史
      const assistantMsg: AgentMessage = {
        id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        projectId: this.projectId,
        sessionId: this.state.sessionId,
        turnId,
        role: 'assistant',
        content: llmResult.content || '',
        summary: this.truncateSummary(llmResult.content || '(无文本内容)', 200),
        // DeepSeek 思考模式：必须回传 reasoning_content
        reasoningContent: llmResult.reasoningContent,
        compressed: false,
        visibleToLlm: true,
        createdAt: new Date().toISOString(),
      };

      // 记录 LLM 调用的 token usage 到 trace（供 evals 成本统计 + /history 汇总）
      if (llmResult.usage) {
        this.addTrace({
          projectId: this.projectId,
          sessionId: this.state.sessionId,
          turnId,
          stepIndex: this.state.traceBuffer.length,
          stepType: 'llm_call',
          status: 'ok',
          summary: `LLM 调用：${llmResult.usage.prompt_tokens} prompt + ${llmResult.usage.completion_tokens} completion tokens${llmResult.usage.prompt_cache_hit_tokens ? `（缓存命中 ${llmResult.usage.prompt_cache_hit_tokens}）` : ''}`,
          usage: llmResult.usage,
        } as Omit<AgentTraceRecord, 'id' | 'createdAt'>);
      }

      // 如果有 tool_calls，生成 call ID 并记录到消息中
      // 注意：tool 响应消息的 tool_call_id 必须与 assistant 消息中 tool_calls[].id 匹配，
      // 否则 DeepSeek/OpenAI API 返回 400 错误。
      // 使用数组按索引对应（同一次 assistant 消息可能多次调用同名工具，Map 会覆盖）。
      const toolCalls = llmResult.toolCalls;
      const callIds: string[] = []; // 与 toolCalls 同索引对应
      if (toolCalls && toolCalls.length > 0) {
        let callSeq = 0;
        const ts = Date.now();
        const rnd = Math.random().toString(36).slice(2, 6);
        assistantMsg.toolCalls = toolCalls.map((tc: { name: string; arguments: Record<string, unknown> }) => {
          const callId = `call_${ts}_${rnd}_${callSeq++}`;
          callIds.push(callId);
          return {
            id: callId,
            type: 'function' as const,
            function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
          };
        });
      }

      this.state.messages.push(assistantMsg);
      this.agentStore.addMessage(assistantMsg);

      // ---- 检查是否有工具调用 ----
      if (!toolCalls || toolCalls.length === 0) {
        // 纯文本回复
        lastAssistantContent = llmResult.content || '';

        // 实体检测兜底：若本轮输入疑似描述角色/设定，但 Agent 没调 detect_entity_hints，
        // 且当前无任何实体草图——提示作者可手动触发检测（避免幻觉"已注册"被当真）。
        // 触发词守卫避免每次都提示（仅疑似实体描述时）。
        if (this.shouldSuggestEntityDetection(userInput)) {
          lastAssistantContent += '\n\n---\n💡 提示：你的描述中可能包含新实体。如需将它们登记为正式实体，请说"检测实体"或明确列出角色/地点名称，我会调用 detect_entity_hints 工具提取。';
        }

        this.addTrace({
          projectId: this.projectId,
          sessionId: this.state.sessionId,
          turnId,
          stepIndex: this.state.traceBuffer.length,
          stepType: 'response_summary',
          status: 'ok',
          summary: `Agent 回复：${this.truncateSummary(lastAssistantContent || '(空)', 100)}`,
        } as Omit<AgentTraceRecord, 'id' | 'createdAt'>);
        break;
      }

      // ---- Act：执行工具调用 ----
      let hasCriticalFailure = false;
      // 记录致命失败的工具名——break 跳出 for 循环后 tc 不在作用域，需提前捕获。
      // 否则错误消息会误引 toolCalls[最后一个]?.name，而致命失败的工具可能是中间的某个。
      let criticalFailToolName: string | undefined;

      for (let tcIdx = 0; tcIdx < toolCalls.length; tcIdx++) {
        const tc = toolCalls[tcIdx]!;
        toolStepCount++;

        // 使用 assistant 消息中分配的 call_id，保证 tool_call_id 匹配
        const callId = callIds[tcIdx] || `call_${Date.now()}_${tcIdx}_${tc.name}`;

        this.addTrace({
          projectId: this.projectId,
          sessionId: this.state.sessionId,
          turnId,
          stepIndex: this.state.traceBuffer.length,
          stepType: 'action',
          status: 'ok',
          summary: `执行工具：${tc.name}`,
          toolName: tc.name,
          toolCallId: callId,
          detail: { arguments: tc.arguments },
        } as Omit<AgentTraceRecord, 'id' | 'createdAt'>);

        // 执行工具
        // W1 安全门控：Agent 的 ReAct 循环禁止直接写正式世界状态（commit_event 等）。
        // 这些不可逆写入工具只能由经用户确认的通道调用（handleConfirmCommit / CoreBridge.commit*），
        // 在进入 ToolRouter 前短路拦截——即便 LLM 幻觉出该调用也写不进 Core。
        let result: ToolResult<unknown>;
        if (isToolForbiddenForAgent(tc.name)) {
          result = forbiddenToolResult(tc.name);
        } else {
          result = await this.toolRouter.execute(tc.name, tc.arguments as Record<string, unknown>);
        }

        // ---- Observe：处理执行结果 ----
        if (result.success) {
          const resultStr = JSON.stringify(result.data);
          const toolResultMsg: AgentMessage = {
            id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            projectId: this.projectId,
            sessionId: this.state.sessionId,
            turnId,
            role: 'tool',
            content: resultStr,
            summary: `${tc.name} 成功`,
            toolCallId: callId,
            compressed: false,
            visibleToLlm: true,
            createdAt: new Date().toISOString(),
          };
          this.state.messages.push(toolResultMsg);
          this.agentStore.addMessage(toolResultMsg);

          // 处理工具特定的副作用（如 propose_event 创建后更新草案与 pending proposal）
          // W13-b：透传 tc.arguments——其内的 fact_changes 是 materializeProposalView 生成真实 factDiff 的数据源
          this.handleToolSuccess(tc.name, result, tc.arguments as Record<string, unknown> | undefined);

          this.addTrace({
            projectId: this.projectId,
            sessionId: this.state.sessionId,
            turnId,
            stepIndex: this.state.traceBuffer.length,
            stepType: 'observation',
            status: 'ok',
            summary: `${tc.name} 成功`,
            toolName: tc.name,
            detail: { summary: this.truncateSummary(resultStr, 200) },
          } as Omit<AgentTraceRecord, 'id' | 'createdAt'>);

          // 重置该工具的失败计数
          delete this.state.toolFailureCounts[tc.name];

        } else {
          // ---- Reflect：工具失败 ----
          const error = result.error;
          const failCount = (this.state.toolFailureCounts[tc.name] || 0) + 1;
          this.state.toolFailureCounts[tc.name] = failCount;

          const reflection = this.diagnoseFailure(tc.name, error, failCount);

          this.addTrace({
            projectId: this.projectId,
            sessionId: this.state.sessionId,
            turnId,
            stepIndex: this.state.traceBuffer.length,
            stepType: 'reflection_summary',
            status: 'error',
            summary: reflection.summary,
            toolName: tc.name,
            errorCode: error.code,
            nextAction: reflection.nextAction,
            detail: { diagnosis: reflection.deterministicDiagnosis, correctionHint: reflection.correctionHint },
          } as Omit<AgentTraceRecord, 'id' | 'createdAt'>);

          // 将错误结果以 tool 消息形式返回给 LLM
          const errorMsg: AgentMessage = {
            id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            projectId: this.projectId,
            sessionId: this.state.sessionId,
            turnId,
            role: 'tool',
            content: JSON.stringify({
              error: true,
              code: error.code,
              message: error.message,
              correctionHint: reflection.correctionHint || error.correctionHint,
              nextAction: reflection.nextAction,
            }),
            summary: `${tc.name} 失败：${error.code}`,
            toolCallId: callId,
            compressed: false,
            visibleToLlm: true,
            createdAt: new Date().toISOString(),
          };
          this.state.messages.push(errorMsg);
          this.agentStore.addMessage(errorMsg);

          // 检查是否达到致命失败阈值
          if (failCount >= this.limits.maxRepeatedToolFailure) {
            hasCriticalFailure = true;
            criticalFailToolName = tc.name;
            this.addTrace({
              projectId: this.projectId,
              sessionId: this.state.sessionId,
              turnId,
              stepIndex: this.state.traceBuffer.length,
              stepType: 'reflection_summary',
              status: 'error',
              summary: `${tc.name} 连续失败 ${failCount} 次，达到致命阈值，终止本轮工具循环`,
              toolName: tc.name,
              errorCode: error.code,
              nextAction: 'abort_turn',
            } as Omit<AgentTraceRecord, 'id' | 'createdAt'>);

            // P0-3: 通知工具连续失败错误
            this.callbacks?.onError?.('tool_critical_failure', `${tc.name} 连续失败 ${failCount} 次`, turnId);

            break;
          }
        }
      }

      // 致命失败则终止循环
      if (hasCriticalFailure) {
        this.state.status = 'failed';
        return {
          content: `我在执行 "${criticalFailToolName ?? toolCalls[toolCalls.length - 1]?.name}" 时遇到持续错误，无法继续。请检查当前的写作状态后重试，或换一种方式描述你的需求。`,
          status: 'failed',
          turnId,
          draft: this.state.workingDraft,
        };
      }
    }

    // ---- 检查是否因为工具轮次耗尽而退出 ----
    if (toolStepCount >= maxSteps) {
      this.state.status = 'suspended';
      this.addTrace({
        projectId: this.projectId,
        sessionId: this.state.sessionId,
        turnId,
        stepIndex: this.state.traceBuffer.length,
        stepType: 'reflection_summary',
        status: 'warning',
        summary: `工具调用达到上限 ${maxSteps} 次，回合暂停`,
        nextAction: 'ask_user',
      } as Omit<AgentTraceRecord, 'id' | 'createdAt'>);
    }

    // ---- 确定最终状态 ----
    const status = this.determineFinalStatus(intent);

    // ---- 生成回复（如果没有纯文本回复） ----
    let content = lastAssistantContent || this.generateSummaryResponse();

    return {
      content,
      status,
      turnId,
      draft: this.state.workingDraft,
      pendingProposalIds: this.state.pendingProposalIds.length > 0
        ? [...this.state.pendingProposalIds]
        : undefined,
    };
  }

  // =========================================================================
  // Phase 7: CLI 确认通道（在 processUserInput 最开头运行）
  // =========================================================================
  // 当有 open PendingDecision 时，优先处理用户的确认/拒绝意图，
  // 短路 Agent ReAct 循环——不进入 LLM 推理。
  // =========================================================================

  /**
   * CLI 确认通道——检查待确认事项并处理用户的确认/拒绝意图。
   *
   * @returns AgentTurnResult 如果处理了确认/拒绝；null 如果无需处理
   */
  private async handlePendingDecisions(userInput: string): Promise<AgentTurnResult | null> {
    // 仅在写作层可用时启用
    if (!this.writingStore || !this.workflowService || !this.coreBridge) {
      return null;
    }

    const ctx: WritingRequestContext = makeRequestContext({
      projectId: this.writingProjectId ?? this.projectId,
      sessionId: this.state.sessionId,
      trigger: 'review_decision',
    });

    // 查询当前项目的 open 决策
    const decisions = this.workflowService.listPendingDecisions(ctx);
    if (decisions.length === 0) return null; // 无待处理决策

    const decision = decisions[0]!; // 先处理最早的

    // ---- 确认识别（复用现有 confirmKeywords） ----
    const isConfirm = this.confirmKeywords.some(kw => userInput.includes(kw));
    if (isConfirm) {
      // W13：确认执行逻辑抽到 applyDecisionConfirm——与 /auto 自动确认共享同一代码路径，杜绝双轨漂移
      const r = await this.applyDecisionConfirm(ctx, decision);
      // content 非空表示确实匹配了某个确认分支（entity/proposal）；
      // content 空（决策非确认类或无 linkedObjectId）则落空，继续走下方 revise / Agent 循环
      if (r.content) {
        return {
          turnId: this.state.currentTurnId,
          status: r.success ? 'completed' : 'failed',
          content: r.content,
        };
      }
    }

    // ---- 拒绝/修改意图（复用现有 reviseKeywords） ----
    const isRevise = this.reviseKeywords.some(kw => userInput.includes(kw)) ||
      /^(不要|不行|不对|不好|重来|废弃|取消)/i.test(userInput.trim());
    if (isRevise) {
      // 更新关联的 ProposalView 为 author_rejected
      if (decision.linkedObjectId && decision.linkedObjectType === 'proposal_view') {
        this.writingStore.updateProposalView(decision.linkedObjectId, {
          status: 'author_rejected',
          authorDecision: '拒绝提交，要求修改',
        });
      }
      // W2：作者拒绝是经授权的决策关闭——带 caller 标记豁免权限矩阵（resolvePendingDecision=COMMIT_FORBIDDEN）
      assertAgentMayCall('WorkflowService.resolvePendingDecision', { caller: AUTHOR_CONFIRM_CHANNEL });
      this.workflowService.resolvePendingDecision(ctx, decision.id, {
        status: 'dismissed',
        note: '作者拒绝，要求修改',
      });
      // 返回 null —— 让 Agent 继续处理修改意图
      return null;
    }

    // 不是确认也不是拒绝——正常进入 Agent 循环
    return null;
  }

  /**
   * 应用单个待确认决策的「确认」动作（W13 抽取）。
   *
   * 把 confirm_entity / confirm_proposal 两个分支的执行逻辑从 handlePendingDecisions 抽出，
   * 让 /auto（agent_authorized_for_session）自动确认与作者自然语言确认走**完全相同的代码路径**，
   * 杜绝双轨实现漂移（任一处修改另一处漏改的隐藏 bug）。
   *
   * 前置条件：调用方保证 writingStore / workflowService / coreBridge 均已注入
   *           （handlePendingDecisions 顶部守卫、autoApprovePendingDecisions 守卫）。
   *
   * @returns {success, content}
   *   - success：该决策是否提交/注册成功（影响回合状态 completed vs needs_user_confirmation）
   *   - content：给用户/日志的反馈文本；**空串**表示决策非确认类（confirm_draft/retcon/...）
   *     或无 linkedObjectId——调用方据此判断是否「确实执行了某分支」，空则落空继续 Agent 循环
   */
  private async applyDecisionConfirm(
    ctx: WritingRequestContext,
    decision: PendingDecisionItem,
  ): Promise<{ success: boolean; content: string }> {
    // ---- 实体注册确认 ----
    if (decision.kind === 'confirm_entity' && decision.linkedObjectId) {
      const sketch = this.writingStore!.getEntitySketch(decision.linkedObjectId);
      if (!sketch || sketch.status !== 'approved') {
        return { success: false, content: '该实体登记请求已过期或已被处理。' };
      }
      // W2：实体注册经作者确认通道——带 caller 标记豁免（registerReviewedEntity=COMMIT_FORBIDDEN）
      assertAgentMayCall('CoreBridgeService.registerReviewedEntity', { caller: AUTHOR_CONFIRM_CHANNEL });
      const result = await this.coreBridge!.registerReviewedEntity(ctx, decision.linkedObjectId);
      // CoreBridge.registerReviewedEntity 内部已完成 sketch→registered + createCoreRef，并落地审计（§7.7 4d/5b）。此处不重复记审计。
      // W2：注册结果回写决策——带 caller 标记豁免（resolvePendingDecision=COMMIT_FORBIDDEN）
      assertAgentMayCall('WorkflowService.resolvePendingDecision', { caller: AUTHOR_CONFIRM_CHANNEL });
      this.workflowService!.resolvePendingDecision(ctx, decision.id, {
        status: result.success ? 'resolved' : 'dismissed',
        note: result.success ? `作者确认注册，coreEntityId=${result.coreEntityId}` : `注册失败: ${result.error?.humanMessage}（实体已标记 error）`,
      });
      return {
        success: result.success,
        content: result.success
          ? `✅ ${sketch.displayName} 已登记为正式实体。`
          : `❌ 登记失败：${result.error?.humanMessage}`,
      };
    }

    // ---- 提案确认 ----
    if (decision.kind === 'confirm_proposal' && decision.linkedObjectId) {
      const pv = this.writingStore!.getProposalView(decision.linkedObjectId);
      if (!pv || pv.status !== 'open') {
        // 自动跳过已失效的决策（PV 已 expired/committed/...）
        try {
          // W2：失效决策清理——带 caller 标记豁免（resolvePendingDecision=COMMIT_FORBIDDEN）
          assertAgentMayCall('WorkflowService.resolvePendingDecision', { caller: AUTHOR_CONFIRM_CHANNEL });
          this.workflowService!.resolvePendingDecision(ctx, decision.id, { status: 'expired', note: '提案已失效' });
        } catch { /* 忽略：决策可能已被并发处理 */ }
        return { success: false, content: '该提案已过期或已被处理。' };
      }
      // open → author_approved
      this.writingStore!.updateProposalView(decision.linkedObjectId, {
        status: 'author_approved',
        authorDecision: '确认提交',
      });
      // W2：提案提交经作者确认通道——带 caller 标记豁免（commitReviewedProposal=COMMIT_FORBIDDEN）
      assertAgentMayCall('CoreBridgeService.commitReviewedProposal', { caller: AUTHOR_CONFIRM_CHANNEL });
      const result = await this.coreBridge!.commitReviewedProposal(ctx, decision.linkedObjectId);
      // CoreBridge.commitReviewedProposal 内部已完成 PV→committed + createCoreRef + 来源草案→committed，
      // 并落地审计（成功/失败/partial 三态，§7.7 4d/5b/1862）。此处不重复记审计。
      // 失败用 dismissed 关闭决策（非 resolved）避免阻塞后续输入；PV 已被 CoreBridge 标 commit_failed（§7.11.2 路径A）
      // W2：提交结果回写决策——带 caller 标记豁免（resolvePendingDecision=COMMIT_FORBIDDEN）
      assertAgentMayCall('WorkflowService.resolvePendingDecision', { caller: AUTHOR_CONFIRM_CHANNEL });
      this.workflowService!.resolvePendingDecision(ctx, decision.id, {
        status: result.success ? 'resolved' : 'dismissed',
        note: result.success ? `作者确认提交，coreEventId=${result.coreEventId}` : `提交失败: ${result.error?.humanMessage}（提案已标记 commit_failed）`,
      });
      return {
        success: result.success,
        content: result.success
          ? `✅ 已写入世界状态。事件 ID：${result.coreEventId}`
          : `❌ 提交失败：${result.error?.humanMessage}`,
      };
    }

    // 非确认类决策（confirm_draft / confirm_retcon / confirm_blueprint / confirm_rule / general）
    // ——当前无对应执行通道，返回空 content 让调用方落空
    return { success: false, content: '' };
  }

  /**
   * /auto（agent_authorized_for_session）writingLayer 自动确认（W13）。
   *
   * 裸路径（无 writingStore）走 handleConfirmCommit 直接 commit_event；writingLayer 走本方法——
   * materializeProposalView 已把本回合的 propose_event 物化为 PV + PendingDecision，此处遍历所有
   * open 的 confirm_proposal / confirm_entity 决策，逐一调 applyDecisionConfirm（与作者自然语言确认同源）。
   *
   * 失败容错：单个决策失败不阻断其余——逐一尝试，任一失败则整体 success=false（回合状态
   * 需 surfaced 为 needs_user_confirmation）。提交后清空 pendingProposalIds，与裸路径
   * handleConfirmCommit 末尾清理语义对齐（否则提案堆积，违背该模式"单回合落库"语义）。
   *
   * @returns {success, content} success=全部决策成功；content=各决策反馈汇总
   */
  private async autoApprovePendingDecisions(
    turnId: string,
  ): Promise<{ success: boolean; content: string }> {
    const ctx = this.makeWritingCtx('review_decision');
    const decisions = this.workflowService!
      .listPendingDecisions(ctx)
      .filter((d) => d.kind === 'confirm_proposal' || d.kind === 'confirm_entity');

    if (decisions.length === 0) {
      // 无可确认决策（如本回合仅产出非确认类，或 PV 物化失败）——不视为失败
      return { success: true, content: '' };
    }

    const contents: string[] = [];
    let allOk = true;
    for (const decision of decisions) {
      const r = await this.applyDecisionConfirm(ctx, decision);
      if (r.content) contents.push(r.content);
      if (!r.success) allOk = false;
    }

    // 无条件清空本回合 pending proposal——与本方法"单回合落库"语义一致，与裸路径清理方式不同：
    //   - 裸路径 handleConfirmCommit：成功才逐项 filter 移除（保留失败 proposalId 供重试）。
    //   - 本方法（writingLayer /auto）：无论成败批量清空。批量清空在此安全的原因有三：
    //     1) 回合状态由 allOk 直接决定（上方 /auto 分支 merged.status = success?'completed':'needs_user_confirmation'），
    //        不依赖 pendingProposalIds.length（determineFinalStatus 不会被此分支触达）；
    //     2) 失败决策的痕迹留存于 PendingDecisions（writing_pending_decisions，由 workflowService 持久化），
    //        与 pendingProposalIds 是两套独立数据结构——清空后者不丢失前者，下回合 listPendingDecisions 仍可重试；
    //     3) pendingProposalIds 是裸路径 commit 跟踪位，writingLayer 模式的权威 pending 态是 PendingDecisions。
    //     故批量清空不会让失败 proposal 失去追踪（那属于 PendingDecisions 的职责），也不影响状态判定。
    this.state.pendingProposalIds = [];
    this.agentStore.updateTurnPendingProposals(turnId, []);

    return { success: allOk, content: contents.join('\n') };
  }

  // =========================================================================
  // 内部：用户确认识别处理（Phase 6 向后兼容——Phase 7 由 handlePendingDecisions 处理）
  // =========================================================================

  private async handleConfirmCommit(turnId: string): Promise<AgentTurnResult> {
    // ---- W2 Fix-4：writingLayer 模式禁止裸提交（绕过 Proposal Review 审核）----
    // handleConfirmCommit 是裸路径的"直接 commit_event"入口（不经 PV 审核）。
    // writingLayer 模式下，提交必须经 Proposal Review：CoreBridge.commitReviewedProposal
    // （由 applyDecisionConfirm / autoApprovePendingDecisions 调用，带 validateCommitReadiness
    // 前置校验 author_approved + 草案状态）。裸提交会绕过这套审核，违背 writingLayer 的核心不变式。
    //
    // 当前两个调用点均用 !this.writingStore 守卫（confirm_commit 分支 :365、裸 /auto 自动提交 :401），
    // 故本 throw 在现有路径**永不触发**——它是防御性不变式：把"writingLayer 禁裸提交"从隐性代码路径假设
    // 升级为显式可测不变式，并激活此前无 throw 点的 COMMIT_WITHOUT_REVIEW 死错误码。
    // 一旦未来某处误删调用点守卫（回归），此 throw 会立即抛出而非静默裸提交。
    //
    // 以 writingStore 为门控（而非 writingLayer 聚合）：与两个调用点的守卫字段逐字一致，
    // 且 writingStore 存在即表明 Agent 配置了写作层意图（即便 writingLayer 聚合因缺 workflowService/
    // writingProjectId 未组装，writingStore 已注入也不应裸提交）。
    if (this.writingStore) {
      throw new WritingError(
        WritingErrorCode.COMMIT_WITHOUT_REVIEW,
        'writingLayer 模式下禁止裸提交（handleConfirmCommit 直提 commit_event 绕过 Proposal Review）；'
        + '提交必须经 PV 审核通道（CoreBridge.commitReviewedProposal）',
      );
    }

    // 尝试提交所有 pending proposal
    const results: string[] = [];
    let allSucceeded = true;

    for (const proposalId of [...this.state.pendingProposalIds]) {
      const result = await this.toolRouter.execute('commit_event', { proposal_id: proposalId });

      if (result.success) {
        const data = result.data as { event_id: string; committed_fact_count: number };
        results.push(`事件 ${data.event_id} 已提交（${data.committed_fact_count} 条 Fact）`);

        // 从 pending 集合移除
        this.state.pendingProposalIds = this.state.pendingProposalIds.filter(id => id !== proposalId);
        this.agentStore.updateTurnPendingProposals(turnId, this.state.pendingProposalIds);

        // 更新 draft 状态
        if (this.state.workingDraft && this.state.workingDraft.proposalId === proposalId) {
          this.state.workingDraft.status = 'committed';
          this.agentStore.updateDraft(this.state.workingDraft.id, { status: 'committed' });

          // P0-3: 通知草案状态变化
          this.callbacks?.onDraftChange?.(this.state.workingDraft);

          // 长期记忆：从已提交的草案中提取项目决策
          this.memoryManager.extractFromCompletedDraft(
            this.state.workingDraft,
            this.state.sessionId,
            turnId,
          );
        }

        // P0-3: 通知提交完成
        this.callbacks?.onCommitComplete?.(data.event_id, data.committed_fact_count);

        this.addTrace({
          projectId: this.projectId,
          sessionId: this.state.sessionId,
          turnId,
          stepIndex: this.state.traceBuffer.length,
          stepType: 'action',
          status: 'ok',
          summary: `commit_event 成功：${data.event_id}`,
          toolName: 'commit_event',
          eventId: data.event_id,
          proposalId,
        } as Omit<AgentTraceRecord, 'id' | 'createdAt'>);

      } else {
        allSucceeded = false;
        results.push(`提交失败（proposal ${proposalId}）：${result.error.message}`);
      }
    }

    const status: AgentTurnStatus = allSucceeded ? 'completed' : 'needs_user_confirmation';
    this.state.status = status;

    return {
      content: results.join('\n'),
      status,
      turnId,
      draft: this.state.workingDraft,
    };
  }

  private handleRejectDraft(turnId: string): AgentTurnResult {
    // 废弃当前草案
    if (this.state.workingDraft) {
      const oldDraftId = this.state.workingDraft.id;
      this.state.workingDraft.status = 'abandoned';

      // ---- W13：writingLayer 路径废弃 WritingDraft + expire 关联 PV ----
      // 关键：writingLayer 下 oldDraftId 是 writing_drafts 主键（非 agent_working_drafts）。
      // 若仍走 agentStore.updateDraft 会 0 命中，遗留 active WritingDraft + 孤儿 PV + PendingDecision（隐藏 bug）。
      if (this.writingStore && this.writingDraftId) {
        const draft = this.writingStore.getDraft(this.writingDraftId);
        // committed（终态不可逆）/ archived（已是）跳过；其余态归 archived
        if (draft && draft.status !== 'committed' && draft.status !== 'archived') {
          validateDraftTransition(draft.status, 'archived', this.writingDraftId);
          this.writingDraftVersion = this.writingStore.updateDraft(
            this.writingDraftId,
            this.writingDraftVersion,
            { status: 'archived' },
          ).newVersion;
          // 来源草案被废弃 → 关联活跃审核视图过期（不再可提交）。
          // 关联的 PendingDecision 不在此 resolve（resolvePendingDecision 是 CLI 确认通道专属）：
          // 遗留的 open 决策指向 expired PV，handlePendingDecisions 确认时对失效 PV 容错（标 expired），已文档化。
          const pv = this.writingStore.getActiveProposalViewForDraft(this.writingDraftId);
          if (pv) {
            this.writingStore.expireProposalView(pv.id);
          }
        }
      } else {
        // ---- 裸路径：100% 保持原行为（agent_working_drafts）----
        this.agentStore.updateDraft(oldDraftId, { status: 'abandoned' });
      }

      // P0-3: 通知草案被废弃
      this.callbacks?.onDraftChange?.(this.state.workingDraft);
      this.state.workingDraft = undefined;
      // W13：清空 WritingDraft 追踪状态——下回合 ensureWorkingDraft 会建新 WritingDraft
      this.writingDraftId = undefined;
      this.writingDraftVersion = 0;
    }

    // 清理 pending proposal
    this.state.pendingProposalIds = [];
    this.agentStore.updateTurnPendingProposals(turnId, []);

    this.state.status = 'completed';
    return {
      content: '好的，已废弃当前草案。请告诉我新的想法。',
      status: 'completed',
      turnId,
      draft: undefined,
    };
  }

  // =========================================================================
  // 内部：意图检测
  // =========================================================================

  private detectIntent(input: string): UserIntent {
    const trimmed = input.trim().toLowerCase();

    // 纯闲聊/问候
    if (/^(你好|hi|hello|在吗|谢谢|好的|嗯|ok|明白)/i.test(trimmed)) {
      return 'chat';
    }

    // 明确确认（使用合并后的可配置关键词列表）
    if (this.confirmKeywords.some(kw => input.includes(kw))) {
      return 'confirm_commit';
    }

    // 继续协商（使用合并后的可配置关键词列表）
    if (this.reviseKeywords.some(kw => input.includes(kw)) ||
        /^(再|还要|另外|补充|改成|换掉|删除|去掉)/i.test(trimmed)) {
      return 'revise_draft';
    }

    // 拒绝
    if (/^(不要|不行|不对|不好|重来|废弃|取消)/i.test(trimmed)) {
      return 'reject_draft';
    }

    // 状态查询
    if (/(当前状态|查一下|查询|什么情况|现在.*怎么样|有哪些|列出|显示)/i.test(input)) {
      return 'query_state';
    }

    // 推演请求
    if (/(推演|如果.*会怎样|假设|模拟|试试看)/i.test(input)) {
      return 'request_simulation';
    }

    // 新增内容（默认）
    return 'new_content';
  }

  // =========================================================================
  // 内部：消息管理
  // =========================================================================

  /**
   * 组装发送给 LLM 的消息序列。
   *
   * @param systemPrompt 可选：显式 system 提示词（escape hatch）；省略则用 WP 动态生成
   * @param worldSnapshot 可选：调用方（runReActLoop）每回合预取一次的 Core 世界快照。
   *        传入则让 assembleWritingContext 渲染"实体 + 当前设定事实"的富实体段（§8.3.3）；
   *        省略（裸路径 / 无 coreBridge / 预取失败降级）则 assembleWritingContext 回落轻量实体段。
   *        同步消费——本函数不发起任何异步 Core 读，预取已由调用方在循环外完成。
   */
  private buildLlmMessages(systemPrompt?: string, worldSnapshot?: WorldSnapshot): ChatMessage[] {
    const msgs: ChatMessage[] = [];

    // 系统提示词：优先使用传入的 systemPrompt（escape hatch），
    // 否则使用 WP 动态生成的默认提示词，最后 fallback 到硬编码默认值
    msgs.push({
      role: 'system',
      content: systemPrompt || this.buildSystemPrompt(),
    });

    // P0-1: 注入 Push 检索结果（如有）
    const pushContext = (this.state as any).__pushRetrievalContext as string | undefined;
    if (pushContext) {
      msgs.push({
        role: 'system',
        content: pushContext,
      });
      // 消费后清除，避免下一轮重复注入
      delete (this.state as any).__pushRetrievalContext;
    }

    // 注入长期记忆
    const memories = this.agentStore.getActiveMemories(this.projectId);
    if (memories.length > 0) {
      const memoryText = memories.map(m =>
        `[长期记忆 - ${m.kind}] ${m.summary}`
      ).join('\n');
      msgs.push({
        role: 'system',
        content: `以下是之前会话中记录的长期记忆：\n${memoryText}\n\n请根据这些记忆调整你的行为。`,
      });
    }

    // 注入上下文压缩摘要
    const summaries = this.agentStore.getContextSummariesBySession(this.state.sessionId);
    if (summaries.length > 0) {
      const latest = summaries[summaries.length - 1];
      if (latest) {
        msgs.push({
          role: 'system',
          content: `以下是被压缩的早期对话摘要：\n${latest.summary}\n\n关键决策：${latest.key_decisions_json}\n未解决问题：${latest.open_questions_json}`,
        });
      }
    }

    // 注入当前工作草案
    if (this.state.workingDraft) {
      msgs.push({
        role: 'system',
        content: `当前工作草案：${this.state.workingDraft.summary}\n状态：${this.state.workingDraft.status}\n修订次数：${this.state.workingDraft.revisionCount}`,
      });
    }

    // W2：注入写作层状态摘要（已注册实体 + 待确认决策）——抽离自原内联块，
    // 单一真相源在 assembleWritingContext（context-assembly.ts）。门控等价于原内联块：
    // 仅 writingLayer（writingStore + workflowService + writingProjectId 齐备）时注入。
    // 返回空串（既无已注册实体又无待确认决策）时跳过，避免注入空 system message。
    if (this.writingLayer) {
      const ctx = makeRequestContext({
        projectId: this.writingProjectId!,
        sessionId: this.state.sessionId,
        trigger: 'agent_suggestion',
      });
      const writingContext = assembleWritingContext(this.writingLayer, ctx, worldSnapshot);
      if (writingContext) {
        msgs.push({ role: 'system', content: writingContext });
      }
    }

    // 注入 pending proposal
    if (this.state.pendingProposalIds.length > 0) {
      msgs.push({
        role: 'system',
        content: `有待提交的提案：${this.state.pendingProposalIds.join(', ')}。需要用户确认后提交。`,
      });
    }

    // 注入提交授权说明（W1 后：Agent 永不直接调用 commit_event，与 writingStore 是否注入无关——
    // tool-permissions 门控是无条件的。这里只告知 LLM 当前授权模式，引导其走"推演→引导确认"路径）
    if (this.state.commitAuthority === 'agent_authorized_for_session' || this.state.commitAuthority === 'agent_authorized_for_task') {
      msgs.push({
        role: 'system',
        content: '当前处于自动确认模式。propose_event 推演成功后系统会自动创建审核视图；提交仍须经 Proposal Review 通道由用户确认后执行。你不要直接调用 commit_event。',
      });
    } else {
      msgs.push({
        role: 'system',
        content: '当前处于手动确认模式。propose_event 推演后请暂停并告诉用户"推演完成，请确认是否提交"。不要直接调用 commit_event——提交由系统的 Proposal Review 流程在用户确认后执行。',
      });
    }

    // 会话消息
    for (const msg of this.state.messages) {
      if (!msg.visibleToLlm) continue;

      const chatMsg: ChatMessage = {
        role: msg.role,
        content: msg.content,
      };

      // DeepSeek 思考模式：必须回传 reasoning_content
      if (msg.reasoningContent) {
        chatMsg.reasoning_content = msg.reasoningContent;
      }

      if (msg.toolCalls && msg.toolCalls.length > 0) {
        chatMsg.tool_calls = msg.toolCalls;
      }
      if (msg.toolCallId) {
        chatMsg.tool_call_id = msg.toolCallId;
      }

      msgs.push(chatMsg);
    }

    return msgs;
  }

  private addUserMessage(content: string, turnId: string): void {
    const msg: AgentMessage = {
      id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      projectId: this.projectId,
      sessionId: this.state.sessionId,
      turnId,
      role: 'user',
      content,
      summary: this.truncateSummary(content, 200),
      compressed: false,
      visibleToLlm: true,
      createdAt: new Date().toISOString(),
    };
    this.state.messages.push(msg);
    this.agentStore.addMessage(msg);
  }

  /**
   * W13：构造写作层请求上下文（与 handlePendingDecisions 内 ctx 构造同模式）。
   *
   * projectId 取 writingProjectId（写作层项目，区别于 Core 的 projectId）；sessionId 取当前会话。
   * trigger 由调用方指定——草案创建/提案物化是 author_action，自动确认走 review_decision。
   */
  private makeWritingCtx(trigger: WritingTrigger): WritingRequestContext {
    return makeRequestContext({
      projectId: this.writingProjectId ?? this.projectId,
      sessionId: this.state.sessionId,
      trigger,
    });
  }

  private ensureWorkingDraft(summary: string, turnId: string): void {
    if (this.state.workingDraft) return;

    // ---- W13-a：writingLayer 存在时委托 DraftService.createDraft 建正式 WritingDraft ----
    // 把 Agent 协商草案从 agent_working_drafts 双轨统一到 writing_drafts，使其可进入 Proposal Review 审核流。
    // 保持同步签名（DraftService.createDraft / writingStore 全是 better-sqlite3 同步），调用点零改动。
    if (this.writingStore && this.draftService) {
      const ctx = this.makeWritingCtx('author_action');
      // chapter=0 会被 Core 拒绝，兜底为 1（state.currentChapter 初始 0，尚未由写作层设定章节号）
      const wd: WritingDraft = this.draftService.createDraft(ctx, {
        kind: 'event',
        chapter: this.state.currentChapter || 1,
        title: this.truncateSummary(summary, 200),
        content: '', // Agent 路径不写 prose content——意图承载在 title/summary；不触发 content≥10 门控
      });
      this.writingDraftId = wd.id;
      this.writingDraftVersion = wd.version;

      // state.workingDraft 仍是 AgentWorkingDraft 形状（WritingDraft 的内存投影）——字段形状不变，
      // 保护 chat.ts / live-agent-session.ts 等消费者（读 summary/status/revisionCount/proposalId）。
      this.state.workingDraft = {
        id: wd.id,
        status: 'collecting',
        summary: wd.title ?? this.truncateSummary(summary, 500),
        revisionCount: 0,
        createdAt: wd.createdAt,
        updatedAt: wd.updatedAt,
      };
      // P0-3: 通知新草案创建
      this.callbacks?.onDraftChange?.(this.state.workingDraft);
      return;
    }

    // ---- 裸路径（无 writingLayer）：100% 保持原行为 ----
    const draftId = this.agentStore.createDraft(
      this.state.sessionId,
      this.projectId,
      this.truncateSummary(summary, 500),
    );
    this.state.workingDraft = {
      id: draftId,
      status: 'collecting',
      summary: this.truncateSummary(summary, 500),
      revisionCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    // P0-3: 通知新草案创建
    this.callbacks?.onDraftChange?.(this.state.workingDraft);
  }

  // =========================================================================
  // 内部：工具成功处理
  // =========================================================================

  private handleToolSuccess(
    toolName: string,
    result: ToolResult<unknown>,
    // W13-b：透传 LLM 调用工具时的原始参数——propose_event 的 fact_changes（FactChangeInput[]）
    // 就在此，供 materializeProposalView 生成真实 factDiff（而非兜底空数组）
    toolArguments?: Record<string, unknown>,
  ): void {
    if (!result.success) return;

    switch (toolName) {
      case 'propose_event': {
        const data = result.data as ProposalResult;
        if (data.proposalId) {
          // pendingProposalIds 与 workingDraft 状态在分叉之前更新——两条路径共用，
          // 保护消费者（chat.ts / live-agent-session.ts 读 pendingProposalIds、workingDraft.status/proposalId）。
          this.state.pendingProposalIds.push(data.proposalId);
          this.agentStore.updateTurnPendingProposals(
            this.state.currentTurnId,
            this.state.pendingProposalIds,
          );
          if (this.state.workingDraft) {
            this.state.workingDraft.status = data.isSafeToCommit ? 'ready_to_commit' : 'proposed';
            this.state.workingDraft.proposalId = data.proposalId;
          }

          // ---- W13-b：writingLayer 路径把已推演的 Core 提案物化为可审核 ProposalView + PendingDecision ----
          // 守卫四依赖齐全 + 有活跃 WritingDraft（ensureWorkingDraft 委托 DraftService 后 writingDraftId 已设）。
          // 失败不阻断主循环：Core proposal 已在 ProposalStore，裸 pendingProposalIds 仍记录它，调用方可重试。
          if (
            this.writingStore &&
            this.draftService &&
            this.workflowService &&
            this.writingDraftId
          ) {
            try {
              this.materializeProposalView(data, toolArguments);
            } catch (err) {
              // 物化失败记 trace 而非抛出——Agent 主循环照常返回 LLM 文本回复；
              // 失败的 PV 不影响 Core 提案本身（pendingProposalIds 仍持有 proposalId，可经确认通道重试）。
              this.addTrace({
                projectId: this.projectId,
                sessionId: this.state.sessionId,
                turnId: this.state.currentTurnId,
                stepIndex: this.state.traceBuffer.length,
                stepType: 'observation',
                status: 'error',
                toolName: 'propose_event',
                summary: `ProposalView 物化失败（proposalId=${data.proposalId}）：${err instanceof Error ? err.message : String(err)}`,
                nextAction: 'retry_with_repaired_args',
              } as Omit<AgentTraceRecord, 'id' | 'createdAt'>);
            }
          } else if (this.state.workingDraft) {
            // ---- 裸路径：100% 保持原行为（agentStore.updateDraft）----
            this.agentStore.updateDraft(this.state.workingDraft.id, {
              status: this.state.workingDraft.status,
              proposalId: data.proposalId,
            });
          }

          // P0-3: 通知草案状态变化 + 提案创建（两条路径共用）
          if (this.state.workingDraft) {
            this.callbacks?.onDraftChange?.(this.state.workingDraft);
          }
          this.callbacks?.onProposalCreated?.(data.proposalId, data.simulationReportMarkdown ?? '');
        }
        break;
      }

      // commit_event 成功分支已移除（W1 安全门控）：
      // Agent 的 ReAct 循环不再可能成功调用 commit_event——tool-permissions 在 ToolRouter
      // 之前短路，返回 AGENT_COMMIT_FORBIDDEN（success:false），此分支不可达。
      // 提交的副作用统一由确认通道（handleConfirmCommit / CoreBridge.commitReviewedProposal）负责。

      case 'register_entity': {
        const data = result.data as { entity_id: string };
        // 注册实体后如果需要可以自动更新草案
        break;
      }

      case 'detect_entity_hints': {
        // 实体检测成功：工具已建 hint 草图。记 trace 提示作者用 /entities 查看 + approve。
        // 不自动 approve（保守：作者显式审批，§25 #4 确认才提交）。
        const data = result.data as { detected?: number; message?: string };
        const count = data?.detected ?? 0;
        this.addTrace({
          projectId: this.projectId,
          sessionId: this.state.sessionId,
          turnId: this.state.currentTurnId,
          stepIndex: this.state.traceBuffer.length,
          stepType: 'observation',
          status: 'ok',
          toolName: 'detect_entity_hints',
          summary: `检测到 ${count} 个实体线索（hint 状态）。用 /entities 查看，/entity approve <id> 批准后注册到 Core。`,
        } as Omit<AgentTraceRecord, 'id' | 'createdAt'>);
        break;
      }
    }
  }

  /**
   * 实体检测兜底判定：本轮输入是否疑似包含新实体描述，值得提示作者检测。
   *
   * 触发条件（全部满足）：
   *   1. 写作层已就绪（entityService 可用）
   *   2. 当前无任何实体草图（首次需要检测时才提示，已有实体不打扰）
   *   3. 输入含实体描述特征词（主角/角色/叫/名字/登场/地点/世界 等）
   *
   * 这是"被动兜底"——当 Agent 没主动调 detect_entity_hints 但输入明显涉及新实体时，
   * 提示作者可手动触发，避免幻觉"已注册"被当真。
   */
  private shouldSuggestEntityDetection(userInput: string): boolean {
    // 写作层未就绪 → 不提示
    if (!this.entityService || !this.writingStore || !this.writingProjectId) return false;
    // 已有实体草图 → 不打扰（作者可能在做别的事）
    try {
      const sketches = this.writingStore.listEntitySketches(this.writingProjectId);
      if (sketches.length > 0) return false;
    } catch {
      return false;
    }
    // 特征词检测
    const entityKeywords = ['主角', '角色', '叫', '名字', '登场', '人物', '妹妹', '哥哥', '师傅', '反派', '地点', '世界', '设定'];
    return entityKeywords.some(kw => userInput.includes(kw));
  }

  // =========================================================================
  // 内部：W13-b 把已推演的 ProposalResult 物化为可审核 ProposalView + PendingDecision
  // =========================================================================

  /**
   * 物化提案视图（W13-b）
   *
   * 把 Agent 的 ReAct 循环刚通过 propose_event 拿到的 ProposalResult 投影为写作层的
   * ProposalView（四件套 factDiff/involvedEntityIds/ruleWarnings/humanSummary）+ 一个
   * confirm_proposal 待确认事项，使作者可经 /review 审核而非盲确认裸 proposalId。
   *
   * 关键不变式（为何这样做）：
   *   - **绝不重跑推演**：ProposalResult 已含 proposalId + 后果，直接投影即可。若改调
   *     coreBridge.simulateDraftAsEvent 会再触发一次 propose_event，产生新 proposalId，
   *     让 Agent 的原 ReAct 提案变成孤儿（Core ProposalStore 堆积无主提案）——本任务最深坑。
   *   - **状态机 validate-then-update**：writingStore.updateDraft 只做乐观锁（W3），不校验状态机；
   *     drafting→simulated 非法直跳，必须经 ready_to_simulate 中转。
   *   - **PV 查重**：同草案二次 propose 复用现有 open/author_approved 的 PV，避免孤儿 +
   *     避免重复 PendingDecision（仅在该 PV 无关联 open 决策时才新建）。
   *   - **resolveEntityName 注入**：coreEntityId→displayName 映射喂给 buildProposalReviewData，
   *     normal 模式下 factDiff/humanSummary 显示实体名而非裸 ent_ id（§9.1 不泄漏）。
   *
   * 失败语义：任何步骤抛错由调用方（handleToolSuccess）的 try/catch 捕获并记 trace，不阻断
   * ReAct 主循环；Core proposal 本身已落 ProposalStore（pendingProposalIds 持有），可经确认通道重试。
   *
   * @param pr             propose_event 返回的 ProposalResult
   * @param toolArguments  LLM 调 propose_event 的原始参数（含 fact_changes）——真实 factDiff 数据源
   */
  private materializeProposalView(
    pr: ProposalResult,
    toolArguments?: Record<string, unknown>,
  ): void {
    // 四依赖在 handleToolSuccess 调用前已守卫——此处非空断言简化后续代码（writingDraftId 同理）
    const writingStore = this.writingStore!;
    const workflowService = this.workflowService!;
    const draftId = this.writingDraftId!;
    const projectId = this.writingProjectId ?? this.projectId;

    // 1) ProposalResult → SimulationResult（P1 适配器，与 real-bridge 共享单一真相源）
    const simulation: SimulationResult = proposalResultToSimulationResult(pr);

    // 2) 提取 simulationInputs 三要素。
    //    注意：NarrativeEvent 字段是 camelCase（type/description/chapter），与 propose_event
    //    【输入】参数的 snake_case（event_type/event_description）不同——勿混淆，否则重推参数错位。
    const proposedEvent = pr.proposedEvent;
    const eventDescription =
      (typeof proposedEvent?.description === 'string' && proposedEvent.description) ||
      this.state.workingDraft?.summary ||
      '';
    const eventType =
      (typeof proposedEvent?.type === 'string' && proposedEvent.type) || 'custom';
    const chapter =
      (typeof proposedEvent?.chapter === 'number' && proposedEvent.chapter) ||
      this.state.currentChapter ||
      1;
    // fact_changes 是 FactChangeInput[]（LLM 原始 DSL）——兜底空数组仅在 LLM 未提供时
    const rawFactChanges = toolArguments?.fact_changes;
    const factChanges: unknown[] = Array.isArray(rawFactChanges) ? rawFactChanges : [];

    // 3) 实体名解析映射：coreEntityId → displayName。
    //    仅命中映射的实体才解析为显示名；未命中的 ent_ id 由 §9.1 visibilityMode 字段过滤层处理。
    const sketchNameMap = new Map<string, string>();
    for (const sketch of writingStore.listEntitySketches(projectId)) {
      if (sketch.coreEntityId && sketch.displayName) {
        sketchNameMap.set(sketch.coreEntityId, sketch.displayName);
      }
    }
    const resolveEntityName = (entityId: string): string | undefined =>
      sketchNameMap.get(entityId);

    // 4) 四件套（factDiff / involvedEntityIds / ruleWarnings / humanSummary）
    const review = buildProposalReviewData({
      eventDescription,
      factChanges,
      simulation,
      resolveEntityName,
    });

    // 5) PV 查重：复用该草案的活跃 PV（open/author_approved），无则新建——避免孤儿 PV + 重复决策。
    const existingPv = writingStore.getActiveProposalViewForDraft(draftId);
    const pv =
      existingPv ??
      writingStore.createProposalView(projectId, {
        proposalType: 'event',
        sourceDraftId: draftId,
        // W14：PV 来源追溯——本 PV 由该草案触发（与 draft-service 同源，§4 SourceRef）
        sourceRefs: [{ kind: 'draft', id: draftId }],
      });

    // 6) 填充 PV 四件套 + Core 桥接结果 + 关联 proposalId，置 'open'。
    //    重置 author_approved→open：提案内容已变（新 proposalId），需重新审核。
    writingStore.updateProposalView(pv.id, {
      coreProposalId: pr.proposalId,
      coreBridgeResult: {
        proposalId: pr.proposalId,
        isSafeToCommit: pr.isSafeToCommit,
        report: simulation.report,
      },
      humanSummary: review.humanSummary,
      factDiff: review.factDiff,
      involvedEntityIds: review.involvedEntityIds,
      ruleWarnings: review.ruleWarnings,
      simulationInputs: {
        eventDescription,
        eventType,
        chapter,
        factChanges,
      },
      status: 'open',
    });

    // 7) 草案状态机推进 drafting→ready_to_simulate→simulated（每步 validate-then-update）。
    //    Agent 路径天然绕过 DraftService 的 content≥10 门控——summary 是短意图，非 prose 正文。
    //    已 simulated/committed 时不重复推进（重推场景）；linkedProposalViewId 建立 draft↔PV 双向链。
    const draft = writingStore.getDraft(draftId);
    if (draft) {
      const cur = draft.status;
      if (cur === 'drafting' || cur === 'ready_to_simulate') {
        if (cur === 'drafting') {
          validateDraftTransition('drafting', 'ready_to_simulate', draftId);
          this.writingDraftVersion = writingStore.updateDraft(
            draftId,
            this.writingDraftVersion,
            { status: 'ready_to_simulate' },
          ).newVersion;
        }
        validateDraftTransition('ready_to_simulate', 'simulated', draftId);
        this.writingDraftVersion = writingStore.updateDraft(
          draftId,
          this.writingDraftVersion,
          { status: 'simulated', linkedProposalViewId: pv.id },
        ).newVersion;
      }
    }

    // 8) PendingDecision：仅在该 PV 无关联 open 决策时新建（listPendingDecisions 已过滤 status='open'），
    //    避免重推同草案产生重复决策污染 /state 列表。
    const decisionCtx = this.makeWritingCtx('author_action');
    const hasOpenDecision = workflowService
      .listPendingDecisions(decisionCtx)
      .some((d) => d.linkedObjectId === pv.id);
    if (!hasOpenDecision) {
      workflowService.createPendingDecision(decisionCtx, {
        kind: 'confirm_proposal',
        title: `确认提交事件: ${this.truncateSummary(eventDescription, 60)}`,
        description: pr.isSafeToCommit
          ? '推演通过，无阻塞警告。'
          : '推演发现警告，请查阅 ruleWarnings 后决定。',
        linkedObjectId: pv.id,
        linkedObjectType: 'proposal_view',
      });
    }
  }

  // =========================================================================
  // 内部：失败诊断
  // =========================================================================

  private diagnoseFailure(
    toolName: string,
    error: ToolError,
    failCount: number,
  ): AgentFailureReflection {
    const diagnosis: AgentFailureReflection = {
      failedTool: toolName,
      errorCode: error.code,
      summary: '',
      deterministicDiagnosis: '',
      nextAction: 'retry_with_repaired_args',
      correctionHint: error.correctionHint,
    };

    switch (error.code) {
      case 'SCHEMA_VALIDATION_FAILED':
      case 'INVALID_ENUM_VALUE':
      case 'TYPE_MISMATCH':
        diagnosis.deterministicDiagnosis = `工具 ${toolName} 的参数校验失败：${error.message}`;
        diagnosis.nextAction = 'retry_with_repaired_args';
        diagnosis.correctionHint = error.correctionHint || '请检查参数名称和类型，确保与工具定义一致';
        break;

      case 'ENTITY_NOT_FOUND':
        diagnosis.deterministicDiagnosis = `实体不存在：${error.detail || error.message}`;
        diagnosis.nextAction = 'refresh_context';
        diagnosis.correctionHint = '请先通过 get_context_slice 查询当前实体列表，确认实体 ID 是否正确';
        break;

      case 'FACT_NOT_FOUND':
      case 'FACT_NOT_CURRENT':
        diagnosis.deterministicDiagnosis = `Fact 不存在或已过期：${error.message}`;
        diagnosis.nextAction = 'refresh_context';
        diagnosis.correctionHint = '请先查询最新状态，基于当前有效 Fact 重新生成提案';
        break;

      case 'PROPOSAL_NOT_FOUND':
        diagnosis.deterministicDiagnosis = `proposal_id 不存在：${error.message}`;
        diagnosis.nextAction = 'call_different_tool';
        diagnosis.correctionHint = '请停止复用旧 proposal ID，先调用 propose_event 创建新提案';
        break;

      case 'STATE_VERSION_CONFLICT':
      case 'STALE_PROPOSAL':
        diagnosis.deterministicDiagnosis = `状态版本冲突：${error.message}`;
        diagnosis.nextAction = 'refresh_context';
        diagnosis.correctionHint = '世界状态已变更，请刷新上下文后重新 propose';
        break;

      case 'RULE_VIOLATION':
      case 'LOGIC_CONFLICT':
        diagnosis.deterministicDiagnosis = `规则冲突：${error.message}`;
        diagnosis.nextAction = 'revise_draft';
        diagnosis.correctionHint = 'Core 拒绝了该变更，请调整叙事方案后再试';
        break;

      case 'UNKNOWN_TOOL':
        diagnosis.deterministicDiagnosis = `未知工具：${toolName}`;
        diagnosis.nextAction = 'call_different_tool';
        break;

      case 'AGENT_COMMIT_FORBIDDEN':
        // 权限策略性拒绝——重试同样的调用永远会被拒，故引导 LLM 转为请求用户确认，
        // 而非反复重试（否则会耗尽 maxRepeatedToolFailure 才终止，浪费轮次）。
        diagnosis.deterministicDiagnosis = `Agent 不允许直接调用 ${toolName}：提交须由用户在 Proposal Review 通道确认后由系统执行`;
        diagnosis.nextAction = 'ask_user';
        diagnosis.correctionHint = '不要再次调用此工具。请用自然语言告知用户"推演已完成，请确认是否提交"，等待用户确认后系统会自动提交。';
        break;

      case 'LLM_API_ERROR':
        diagnosis.deterministicDiagnosis = `LLM API 错误：${error.message}`;
        diagnosis.nextAction = 'retry_with_repaired_args';
        diagnosis.correctionHint = 'LLM 服务暂时不可用，请重试';
        break;

      default:
        diagnosis.deterministicDiagnosis = `${toolName} 执行失败：${error.message}（${error.code || '未知错误'}）`;
        diagnosis.nextAction = 'retry_with_repaired_args';
    }

    // 重复失败的处理
    if (failCount >= 2) {
      diagnosis.summary = `第 ${failCount} 次失败：${diagnosis.deterministicDiagnosis}`;
      if (failCount >= this.limits.maxRepeatedToolFailure) {
        diagnosis.nextAction = 'abort_turn';
        diagnosis.correctionHint = '连续失败次数已达上限，停止尝试';
      } else {
        diagnosis.nextAction = 'ask_user';
        diagnosis.correctionHint = (diagnosis.correctionHint || '') + '。如果再次失败请联系用户确认。';
      }
    } else {
      diagnosis.summary = diagnosis.deterministicDiagnosis + (diagnosis.correctionHint ? ` 修复建议：${diagnosis.correctionHint}` : '');
    }

    return diagnosis;
  }

  // =========================================================================
  // 内部：回合管理
  // =========================================================================

  private startNewTurn(userInput: string, commitAuthority?: CommitAuthority): string {
    // 更新会话
    if (!this.state.sessionId) {
      this.startSession();
    }

    // 修改授权（如果本轮提供了）
    if (commitAuthority) {
      this.state.commitAuthority = commitAuthority;
    }

    const turnId = this.agentStore.createTurn(
      this.state.sessionId,
      this.projectId,
      this.truncateSummary(userInput, 200),
    );
    this.state.currentTurnId = turnId;
    this.state.status = 'running';
    // P0-2 修复：每个新 turn 重置 wall-clock 计时基准，使 maxWallClockMs 衡量"单回合"耗时
    // 而非整个会话累计——否则交互式 CLI 跑满阈值后所有后续输入都会被 suspended 且无命令可恢复。
    // startSession/restoreSession 已重置，这里覆盖"同一会话多 turn"的场景。
    this.sessionStartTime = Date.now();

    return turnId;
  }

  private finalizeTurn(turnId: string, status: AgentTurnStatus): void {
    this.state.status = status;
    this.agentStore.updateTurnStatus(turnId, status);

    // 持久化 pending proposal 状态
    this.agentStore.updateTurnPendingProposals(turnId, this.state.pendingProposalIds);
  }

  private determineFinalStatus(intent: UserIntent): AgentTurnStatus {
    // 如果有 pending proposal 且用户没有明确确认，需要确认
    if (this.state.pendingProposalIds.length > 0) {
      if (intent === 'confirm_commit') {
        return 'completed';
      }
      return 'needs_user_confirmation';
    }

    // 如果有活跃 draft 且不是纯聊天，可能需要确认
    if (this.state.workingDraft && intent !== 'chat' && intent !== 'query_state') {
      return 'needs_user_confirmation';
    }

    return 'completed';
  }

  private hasPendingProposals(): boolean {
    return this.state.pendingProposalIds.length > 0;
  }

  // =========================================================================
  // 内部：摘要生成
  // =========================================================================

  private generateSummaryResponse(): string {
    const parts: string[] = [];

    if (this.state.workingDraft) {
      parts.push(`当前草案：${this.state.workingDraft.summary}`);
      parts.push(`状态：${this.state.workingDraft.status}`);
      if (this.state.workingDraft.proposalId) {
        parts.push(`已生成提案：${this.state.workingDraft.proposalId}`);
      }
    }

    if (this.state.pendingProposalIds.length > 0) {
      parts.push(`有待提交的提案 ${this.state.pendingProposalIds.length} 个，请确认是否提交。`);
    }

    if (parts.length === 0) {
      return '已处理完成。你可以继续告诉我下一步的写作内容。';
    }

    return parts.join('\n');
  }

  // =========================================================================
  // 内部：初始化校验（P3-16）
  // =========================================================================

  /**
   * 校验 agentStore 的关键表是否存在
   *
   * 构造时调用，提前暴露 DB 初始化问题，避免第一轮调用时才报错。
   */
  private validateInit(): void {
    const db = (this.agentStore as any).getDatabase?.();
    if (!db) return; // 无法校验时跳过（非 SQLite 实现）

    const requiredTables = [
      'agent_sessions', 'agent_messages', 'agent_turns',
      'agent_working_drafts', 'agent_traces', 'agent_memories',
    ];

    const existing = new Set(
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map((r: any) => r.name),
    );

    const missing = requiredTables.filter(t => !existing.has(t));
    if (missing.length > 0) {
      throw new Error(
        `NarrativeAgent 初始化失败：agentStore 缺少必要的表: ${missing.join(', ')}。` +
        `请确保数据库已正确初始化。`
      );
    }
  }

  // =========================================================================
  // 内部：状态初始化
  // =========================================================================

  private createInitialState(): NarrativeAgentRuntimeState {
    return {
      projectId: this.projectId,
      sessionId: '',
      currentTurnId: '',
      currentChapter: 0,
      messages: [],
      memoryState: {
        compressedUntilMessageId: undefined,
        longTermMemoryRefs: [],
        updatedAt: new Date().toISOString(),
      },
      pendingProposalIds: [],
      toolFailureCounts: {},
      traceBuffer: [],
      commitAuthority: DEFAULT_COMMIT_AUTHORITY,
      status: 'running',
    };
  }

  // =========================================================================
  // 内部：系统提示词生成（P0-2）
  // =========================================================================

  /**
   * 根据 World Package 动态生成系统提示词
   *
   * 无 WP 时 fallback 到硬编码默认值。WP 提供谓词列表、规则描述，
   * 填充到提示词模板中，使 Agent 具备题材感知能力。
   */
  /**
   * 系统提示词入口（W2）：在基础提示词（worldPackage 谓词词表 / 默认值）之上，
   * 追加当前项目的活跃蓝图摘要（题材感知的实体/关系类型骨架），让 LLM 的提案对齐项目既定设定。
   * 无 blueprintService / 无 writingProjectId / 无活跃蓝图时原样返回基础提示词（裸路径不变）。
   */
  private buildSystemPrompt(): string {
    return this.withBlueprintSection(this.buildBaseSystemPrompt());
  }

  /**
   * 给系统提示词追加活跃蓝图（Blueprint）摘要段（W2，§8.3.3 题材感知注入）。
   *
   * 蓝图是项目级的"题材骨架"（实体类型 / 关系类型定义）。注入它让 LLM 在构建 factChanges 时
   * 对齐项目既定的类型体系，而非仅凭 worldPackage 谓词词表自由发挥。
   *
   * 数据源：blueprintService.getActiveBlueprint（按 maturity 派生活跃蓝图）——**不读**
   * WritingProject.activeBlueprintId 列（它是手动标注、非真相源，见 activeBlueprintId 语义不变式）。
   *
   * @param base 基础系统提示词
   * @returns 追加蓝图段后的提示词；无蓝图时返回 base 原样
   */
  private withBlueprintSection(base: string): string {
    // writingLayer 隐含 writingProjectId 已注入；blueprintService 为选填——缺任一则不追加（裸路径不变）
    if (!this.writingLayer || !this.blueprintService || !this.writingProjectId) {
      return base;
    }
    const ctx = this.makeWritingCtx('agent_suggestion');
    const blueprint = this.blueprintService.getActiveBlueprint(ctx);
    if (!blueprint) {
      return base;
    }
    // 渲染题材骨架：成熟度 + 实体类型标签 + 关系类型标签（label 已是人话，非技术 id）
    const entityTypeLabels = blueprint.entityTypes.map((t) => t.label).filter(Boolean);
    const relationTypeLabels = blueprint.relationTypes.map((t) => t.label).filter(Boolean);
    const sections: string[] = [`\n\n## 项目题材骨架（活跃蓝图 · ${blueprint.maturity}）`];
    if (entityTypeLabels.length > 0) {
      sections.push(`实体类型：${entityTypeLabels.join('、')}`);
    }
    if (relationTypeLabels.length > 0) {
      sections.push(`关系类型：${relationTypeLabels.join('、')}`);
    }
    sections.push('构建 factChanges 时尽量对齐上述类型体系；不确定时用自然语言与作者确认。');
    return base + sections.join('\n');
  }

  private buildBaseSystemPrompt(): string {
    if (!this.worldPackage) {
      return DEFAULT_SYSTEM_PROMPT;
    }

    const wp = this.worldPackage;
    const predicateList = wp.predicates
      .filter(p => !p.deprecated)
      .map(p => `- ${p.name}（${p.displayName}）：${p.description}`)
      .join('\n');

    const predicateExamples = wp.predicates
      .filter(p => !p.deprecated)
      .slice(0, 8)
      .map(p => p.name)
      .join('/');

    // 用合并后的 buildSystemPromptCore（注入 WP 谓词段 + 世界观名）
    const predicateSection = `## 可用谓词（${wp.name}）\n${predicateList}\n\n常用谓词：${predicateExamples}`;
    return buildSystemPromptCore({
      worldName: `${wp.name}（${wp.id}）`,
      predicateSection,
    });
  }

  // =========================================================================
  // 内部：Push 检索注入（P0-1）
  // =========================================================================

  /**
   * 执行 Push 检索并将结果注入 LLM 上下文
   *
   * 在 ReAct 循环每轮用户输入的第一轮 Reason 前调用（toolStepCount === 0）。
   * 从用户输入 + 当前草案状态构建 WritingContext，执行六段检索管线，
   * 将结果渲染为 Markdown 注入为 system message。
   *
   * @returns 注入的相关 Fact 数量，或 undefined 如果未执行检索
   */
  private async runPushRetrieval(
    userInput: string,
    relevantEntityIds?: string[],
  ): Promise<number | undefined> {
    if (!this.retriever || !this.renderer) return undefined;

    try {
      // 构建 WritingContext
      const entityIds = relevantEntityIds ?? this.extractEntityIdsFromHistory();
      const chapter = this.state.currentChapter || 1;

      const { ContextAnalyzer } = await import('../core/context-analyzer.js');
      const analyzer = new ContextAnalyzer((this.retriever as any).factStore);
      const signals = analyzer.analyze({
        chapter,
        entityIds,
        text: userInput,
      });

      // 执行六段检索管线
      const factSet = await this.retriever.retrieve(signals, {
        topK: 20,
        atChapter: chapter,
      });

      // 渲染为 Markdown 并注入
      const rendered = this.renderer.renderRelevantFacts(factSet, this.entityNames);
      if (rendered) {
        // 将检索结果作为 system message 注入到消息历史最前面（系统提示之后）
        // 注意：这里不直接修改 messages 数组，而是在 buildLlmMessages 中处理
        // 通过 state 暂存检索结果
        (this.state as any).__pushRetrievalContext = rendered;

        // 计算注入的 Fact 数量
        const factCount =
          Object.keys(factSet.entitySnapshots).length +
          factSet.entityRelations.length +
          factSet.semanticFacts.length;

        this.addTrace({
          projectId: this.projectId,
          sessionId: this.state.sessionId,
          turnId: this.state.currentTurnId,
          stepIndex: this.state.traceBuffer.length,
          stepType: 'reason_summary',
          status: 'ok',
          summary: `Push 检索注入：${factCount} 条相关 Fact`,
        } as Omit<AgentTraceRecord, 'id' | 'createdAt'>);

        return factCount;
      }
    } catch (err) {
      // Push 检索失败不阻塞 ReAct 循环，降级为无注入
      this.addTrace({
        projectId: this.projectId,
        sessionId: this.state.sessionId,
        turnId: this.state.currentTurnId,
        stepIndex: this.state.traceBuffer.length,
        stepType: 'reason_summary',
        status: 'warning',
        summary: `Push 检索失败（降级跳过）：${err instanceof Error ? err.message : String(err)}`,
      } as Omit<AgentTraceRecord, 'id' | 'createdAt'>);
    }

    return undefined;
  }

  /**
   * 从消息历史中提取实体 ID（从 tool call 结果中提取 ent_* 格式）
   */
  private extractEntityIdsFromHistory(): string[] {
    const entityIds: string[] = [];
    const entPattern = /ent_[a-z0-9_]+/g; // 含数字，匹配 ent_shenmo_02 这类带 seq 后缀的实体 ID
    // 用独立的 tool 消息计数器控制回溯深度，而非依赖游标 i 与 length 的关系。
    // 原写法 `entityIds.length > 0 && i < length - 10` 在 i 从末尾递减的循环里几乎不触发：
    // 最近一条 tool 消息命中时 i≈length-1，而 `length-1 < length-10`（length>9）为 false，
    // break 不生效，于是实际会一直扫到 i=0——与“最多回溯 10 条”的注释不符，每轮 Push
    // 检索都回溯全量历史。计数器让语义与注释严格一致。
    let toolMsgSeen = 0;

    for (let i = this.state.messages.length - 1; i >= 0; i--) {
      const msg = this.state.messages[i]!;
      if (msg.role === 'tool') {
        toolMsgSeen++;
        const matches = msg.content.match(entPattern);
        if (matches) {
          entityIds.push(...matches);
        }
        // 最多回溯 10 条 tool 消息
        if (toolMsgSeen >= 10) break;
      }
    }

    return [...new Set(entityIds)];
  }

  // =========================================================================
  // 内部：从 trace 重建 toolFailureCounts（P2-11）
  // =========================================================================

  /**
   * 从 traceBuffer 重建每个工具的连续失败计数
   *
   * 只保留最近一轮的连续失败（遇到成功就重置）。
   */
  private rebuildFailureCounts(traces: AgentTraceRecord[]): Record<string, number> {
    const counts: Record<string, number> = {};

    // 从最新 trace 往回扫描，统计每个 tool 的连续失败次数
    for (let i = traces.length - 1; i >= 0; i--) {
      const trace = traces[i]!;
      if (trace.toolName && trace.stepType === 'observation') {
        if (trace.status === 'error') {
          counts[trace.toolName] = (counts[trace.toolName] || 0) + 1;
        } else if (trace.status === 'ok') {
          // 遇到成功，该工具的连续失败中断
          delete counts[trace.toolName];
        }
      }
    }

    return counts;
  }

  // =========================================================================
  // 内部：Trace 记录（P2-13: 增加缓冲区大小限制）
  // =========================================================================

  private addTrace(trace: Omit<AgentTraceRecord, 'id' | 'createdAt'>): void {
    const record: AgentTraceRecord = {
      ...trace,
      id: `trace_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      createdAt: new Date().toISOString(),
    } as AgentTraceRecord;

    this.state.traceBuffer.push(record);
    this.agentStore.addTrace(record);

    // P2-13: 裁剪超出限制的最旧 trace（只保留 summary 级别）
    if (this.state.traceBuffer.length > this.maxTraceBufferSize) {
      const excess = this.state.traceBuffer.length - this.maxTraceBufferSize;
      this.state.traceBuffer.splice(0, excess);
    }
  }

  // =========================================================================
  // 公开：切换活跃草案（P3-14）
  // =========================================================================

  /**
   * 切换当前活跃的工作草案
   *
   * 写作层可以管理多个草案的创建/切换，Agent 只负责当前活跃的那一个。
   *
   * @param draftId 要切换到的草案 ID
   * @returns 切换是否成功
   */
  switchDraft(draftId: string): boolean {
    const draft = this.agentStore.getDraftById?.(draftId);
    if (!draft) return false;

    this.state.workingDraft = {
      id: draft.id,
      status: draft.status as AgentWorkingDraftStatus,
      summary: draft.summary,
      structuredIntent: safeJsonParse(draft.structured_intent_json),
      proposedFactChanges: safeJsonParse(draft.proposed_changes_json) as unknown[] | undefined,
      proposalId: draft.proposal_id ?? undefined,
      revisionCount: draft.revision_count,
      createdAt: draft.created_at,
      updatedAt: draft.updated_at,
    };

    this.callbacks?.onDraftChange?.(this.state.workingDraft);
    return true;
  }

  // =========================================================================
  // 公开：销毁 Agent（P3-17）
  // =========================================================================

  /**
   * 销毁 Agent，释放资源
   *
   * 切换项目时调用：关闭当前 session，清理内存状态。
   * 切换项目 = 销毁当前 Agent + 用新 projectId 重建（构造是同步的，无网络调用）。
   */
  dispose(): void {
    this.closeSession();
    this.state = this.createInitialState();
    this.sessionStartTime = 0;
  }

  // =========================================================================
  // 辅助方法
  // =========================================================================

  private truncateSummary(text: string, maxLen: number): string {
    if (text.length <= maxLen) return text;
    return text.slice(0, maxLen) + '…';
  }
}

// =============================================================================
// 回合结果类型
// =============================================================================

export interface AgentTurnResult {
  content: string;
  status: AgentTurnStatus;
  turnId: string;
  draft?: AgentWorkingDraft;
  pendingProposalIds?: string[];
}

// =============================================================================
// 辅助：MessageRow → AgentMessage
// =============================================================================

import type { MessageRow } from '../adapters/sqlite/agent-store.js';

function rowToAgentMessage(row: MessageRow): AgentMessage {
  return {
    id: row.id,
    projectId: row.project_id,
    sessionId: row.session_id,
    turnId: row.turn_id ?? undefined,
    role: row.role as 'system' | 'user' | 'assistant' | 'tool',
    content: row.content,
    summary: row.content_summary,
    toolCallId: row.tool_call_id ?? undefined,
    compressed: row.compressed === 1,
    visibleToLlm: row.visible_to_llm === 1,
    createdAt: row.created_at,
  };
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

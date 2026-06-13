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
import type { ToolResult, ToolError, ToolErrorCode } from '../types/tool.js';
import type { SQLiteAgentStoreAdapter } from '../adapters/sqlite/agent-store.js';
import type { SQLiteWritingStore } from '../writing/repositories/writing-store.js';
import type { AuditService } from '../writing/services/audit-service.js';
import type { WorkflowService } from '../writing/services/workflow-service.js';
import type { DraftService } from '../writing/services/draft-service.js';
import type { EntityService } from '../writing/services/entity-service.js';
import type { CoreBridgeService } from '../writing/core-bridge/core-bridge-service.js';
import type { WritingRequestContext } from '../writing/services/context.js';
import { makeRequestContext } from '../writing/services/context.js';
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

const DEFAULT_SYSTEM_PROMPT = `你是 NarrativeAgent，一个面向长篇叙事写作的世界状态一致性引擎的智能体助手。

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

## 工具使用指南
- register_entity：注册新角色/地点/物品（每次注册一个实体）
- propose_event：推演事件提案。推演完成后展示结果，**不要自行调用 commit_event**。
- commit_event：**禁止直接调用**。提交必须通过 Proposal Review 流程由用户确认后执行。
- get_context_slice：查询实体当前状态（修改前先查询）
- **不要使用** propose_schema_extension / commit_schema_extension，除非用户明确要求添加新的自定义谓词类型。
  基础谓词（realm/status/technique/weapon/location/mentor/secret/announcement 等）已全部就绪，无需扩展。

## 禁止行为
- 不暴露你的内部推理链。
- 不把工具失败包装成成功。
- 用户仍在修改时，不自动提交。
- 不编造不存在的实体 ID 或 Fact ID。`;

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

      const messages = this.buildLlmMessages(options?.systemPrompt);

      // P0-5: 更新 token 预算估算
      this.state.memoryState.tokenBudgetEstimate = estimateTokens(messages);
      this.state.memoryState.updatedAt = new Date().toISOString();
      const tools = this.toolRouter.getDefinitions() as ToolDefinition[];

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
        // 纯文本回复，结束循环
        lastAssistantContent = llmResult.content || '';
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
        const result = await this.toolRouter.execute(tc.name, tc.arguments as Record<string, unknown>);

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

          // 处理工具特定的副作用（传入参数以便 commit_event 清理 pending proposal）
          this.handleToolSuccess(tc.name, result, tc.arguments as Record<string, unknown>);

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
          content: `我在执行 "${toolCalls[toolCalls.length - 1]?.name}" 时遇到持续错误，无法继续。请检查当前的写作状态后重试，或换一种方式描述你的需求。`,
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
      // 实体注册确认
      if (decision.kind === 'confirm_entity' && decision.linkedObjectId) {
        const sketch = this.writingStore.getEntitySketch(decision.linkedObjectId);
        if (!sketch || sketch.status !== 'approved') {
          return { turnId: this.state.currentTurnId, status: 'failed', content: '该实体登记请求已过期或已被处理。' };
        }
        const result = await this.coreBridge.registerReviewedEntity(ctx.projectId, decision.linkedObjectId);
        // P0-1 修复：CoreBridge 内部已完成 sketch→registered + createCoreRef，不再调用 _markRegistered
        this.workflowService.resolvePendingDecision(ctx, decision.id, {
          status: result.success ? 'resolved' : 'dismissed',
          note: result.success ? `作者确认注册，coreEntityId=${result.coreEntityId}` : `注册失败: ${result.error?.humanMessage}（实体已标记 error）`,
        });
        if (this.auditService) {
          this.auditService.record(ctx, {
            action: 'confirm_entity_registration',
            targetType: 'entity_sketch',
            targetId: decision.linkedObjectId,
            result: result.success ? 'success' : 'failure',
          });
        }
        return {
          turnId: this.state.currentTurnId,
          status: result.success ? 'completed' : 'failed',
          content: result.success
            ? `✅ ${sketch.displayName} 已登记为正式实体。`
            : `❌ 登记失败：${result.error?.humanMessage}`,
        };
      }

      // 提案确认
      if (decision.kind === 'confirm_proposal' && decision.linkedObjectId) {
        const pv = this.writingStore.getProposalView(decision.linkedObjectId);
        if (!pv || pv.status !== 'open') {
          // 自动跳过已失效的决策
          try { this.workflowService.resolvePendingDecision(ctx, decision.id, { status: 'expired', note: '提案已失效' }); } catch { /* 忽略 */ }
          return { turnId: this.state.currentTurnId, status: 'failed', content: '该提案已过期或已被处理。' };
        }

        // 从 open 转为 author_approved
        this.writingStore.updateProposalView(decision.linkedObjectId, {
          status: 'author_approved',
          authorDecision: '确认提交',
        });

        const result = await this.coreBridge.commitReviewedProposal(ctx.projectId, decision.linkedObjectId);
        // P0-1 修复：CoreBridge 内部已完成 ProposalView→committed + createCoreRef + 来源草案→committed，
        // 不再在此处调用 draftService._markCommitted（消除绕过审核直接置终态的访问控制面）

        // P0-1 修复：失败时用 dismissed 关闭决策（而非 resolved），避免阻塞后续输入；
        // ProposalView 已被 CoreBridge 标为 commit_failed，用户可修改草案后重新推演（§7.11.2 路径A）
        this.workflowService.resolvePendingDecision(ctx, decision.id, {
          status: result.success ? 'resolved' : 'dismissed',
          note: result.success ? `作者确认提交，coreEventId=${result.coreEventId}` : `提交失败: ${result.error?.humanMessage}（提案已标记 commit_failed）`,
        });
        if (this.auditService) {
          this.auditService.record(ctx, {
            action: 'commit_proposal',
            targetType: 'proposal_view',
            targetId: decision.linkedObjectId,
            result: result.success ? 'success' : 'failure',
          });
        }
        return {
          turnId: this.state.currentTurnId,
          status: result.success ? 'completed' : 'failed',
          content: result.success
            ? `✅ 已写入世界状态。事件 ID：${result.coreEventId}`
            : `❌ 提交失败：${result.error?.humanMessage}`,
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

  // =========================================================================
  // 内部：用户确认识别处理（Phase 6 向后兼容——Phase 7 由 handlePendingDecisions 处理）
  // =========================================================================

  private async handleConfirmCommit(turnId: string): Promise<AgentTurnResult> {
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
      this.agentStore.updateDraft(oldDraftId, { status: 'abandoned' });
      // P0-3: 通知草案被废弃
      this.callbacks?.onDraftChange?.(this.state.workingDraft);
      this.state.workingDraft = undefined;
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

  private buildLlmMessages(systemPrompt?: string): ChatMessage[] {
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

    // Phase 7: 注入写作层状态摘要（帮助 LLM 了解当前项目状态）
    if (this.writingStore && this.writingProjectId) {
      const registeredEntities = this.writingStore.listEntitySketches(this.writingProjectId)
        .filter(e => e.status === 'registered' && e.coreEntityId);
      if (registeredEntities.length > 0) {
        const entityList = registeredEntities
          .map(e => `  ${e.displayName} (${e.coreEntityId}, ${e.typeLabel})`)
          .join('\n');
        msgs.push({
          role: 'system',
          content: `当前已注册实体（构建 factChanges 时使用这些 entity ID）：\n${entityList}`,
        });
      }

      if (this.workflowService) {
        const ctx = makeRequestContext({
          projectId: this.writingProjectId,
          sessionId: this.state.sessionId,
          trigger: 'agent_suggestion',
        });
        const decisions = this.workflowService.listPendingDecisions(ctx);
        if (decisions.length > 0) {
          msgs.push({
            role: 'system',
            content: `当前有待确认事项：\n${decisions.map(d => `  [${d.kind}] ${d.title}`).join('\n')}\n\n请提醒用户确认或修改。`,
          });
        }
      }
    }

    // 注入 pending proposal
    if (this.state.pendingProposalIds.length > 0) {
      msgs.push({
        role: 'system',
        content: `有待提交的提案：${this.state.pendingProposalIds.join(', ')}。需要用户确认后提交。`,
      });
    }

    // 注入提交授权模式（告知 LLM 当前是否可以自行提交）
    if (this.writingStore) {
      // Phase 7: 写作层已注入，提交必须通过 CLI 确认通道
      if (this.state.commitAuthority === 'agent_authorized_for_session' || this.state.commitAuthority === 'agent_authorized_for_task') {
        msgs.push({
          role: 'system',
          content: '【重要】当前处于自动确认模式。propose_event 推演成功后，系统会自动创建审核。需要用户手动确认提交。',
        });
      } else {
        msgs.push({
          role: 'system',
          content: '当前处于手动确认模式。propose_event 推演后请暂停并告诉用户"推演完成，请确认是否提交"。不要在用户确认前自行调用 commit_event。提交由系统的 Proposal Review 流程处理。',
        });
      }
    } else {
      // Phase 6 向后兼容：无写作层时保持旧行为
      if (this.state.commitAuthority === 'agent_authorized_for_session' || this.state.commitAuthority === 'agent_authorized_for_task') {
        msgs.push({
          role: 'system',
          content: '【重要】当前处于自动提交模式。每次 propose_event 成功后，必须紧接着调用 commit_event 提交。不需要等待用户确认。',
        });
      } else {
        msgs.push({
          role: 'system',
          content: '当前处于手动确认模式。你仍然需要调用 propose_event 创建提案，但调用后请暂停并告诉用户"请确认是否提交"，等待用户回复"提交"/"确认"后再调用 commit_event。不要在用户确认前自行调用 commit_event。',
        });
      }
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

  private ensureWorkingDraft(summary: string, turnId: string): void {
    if (this.state.workingDraft) return;

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

  private handleToolSuccess(toolName: string, result: ToolResult<unknown>, args?: Record<string, unknown>): void {
    if (!result.success) return;

    switch (toolName) {
      case 'propose_event': {
        const data = result.data as { proposalId: string; isSafeToCommit: boolean };
        if (data.proposalId) {
          this.state.pendingProposalIds.push(data.proposalId);
          this.agentStore.updateTurnPendingProposals(
            this.state.currentTurnId,
            this.state.pendingProposalIds,
          );

          // 关联到当前草案
          if (this.state.workingDraft) {
            this.state.workingDraft.status = data.isSafeToCommit ? 'ready_to_commit' : 'proposed';
            this.state.workingDraft.proposalId = data.proposalId;
            this.agentStore.updateDraft(this.state.workingDraft.id, {
              status: this.state.workingDraft.status,
              proposalId: data.proposalId,
            });
            // P0-3: 通知草案状态变化
            this.callbacks?.onDraftChange?.(this.state.workingDraft);
          }

          // P0-3: 通知提案创建（推演报告从 result.data 中提取）
          const report = (result.data as any).simulationReportMarkdown ?? '';
          this.callbacks?.onProposalCreated?.(data.proposalId, report);
        }
        break;
      }

      case 'commit_event': {
        // 从 pending 集合中移除已提交的 proposal
        const proposalId = args?.['proposal_id'] as string | undefined;
        if (proposalId) {
          this.state.pendingProposalIds = this.state.pendingProposalIds.filter(id => id !== proposalId);
          this.agentStore.updateTurnPendingProposals(
            this.state.currentTurnId,
            this.state.pendingProposalIds,
          );

          // 更新草案状态为已提交
          if (this.state.workingDraft?.proposalId === proposalId) {
            this.state.workingDraft.status = 'committed';
            this.agentStore.updateDraft(this.state.workingDraft.id, { status: 'committed' });

            // P0-3: 通知草案状态变化
            this.callbacks?.onDraftChange?.(this.state.workingDraft);

            // 长期记忆：从已提交的草案中提取项目决策
            this.memoryManager.extractFromCompletedDraft(
              this.state.workingDraft,
              this.state.sessionId,
              this.state.currentTurnId,
            );
          }

          // P0-3: 通知提交完成
          const commitData = result.data as { event_id?: string; committed_fact_count?: number };
          this.callbacks?.onCommitComplete?.(
            commitData.event_id ?? '',
            commitData.committed_fact_count ?? 0,
          );
        }
        break;
      }

      case 'register_entity': {
        const data = result.data as { entity_id: string };
        // 注册实体后如果需要可以自动更新草案
        break;
      }
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
  private buildSystemPrompt(): string {
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

    return `你是 NarrativeAgent，一个面向长篇叙事写作的世界状态一致性引擎的智能体助手。
当前世界观：${wp.name}（${wp.id}）

## 你的角色
你帮助作者管理和维护小说的世界状态。你可以查询当前状态、提议事件变更、提交变更、管理叙事线索等。

## 核心原则
1. **智能决策**：理解用户的写作意图，自主决定下一步行动。
2. **区分草案与正式状态**：用户的修改先形成"草案"，只有用户明确确认后才提交为正式世界状态。
3. **提交主权归用户**：默认情况下，你必须等待用户明确确认后才能提交事件。除非你被明确授权自动提交。
4. **先查后改**：修改前先查询当前状态，确保你的提案基于最新世界状态。
5. **失败反思**：工具调用失败后，分析原因，调整策略，不要原样重试。

## 可用谓词（${wp.name}）
${predicateList}

## 工作方式
- 你可以调用工具来查询和修改世界状态。
- 每一步工具调用后，你都会看到执行结果。
- 如果工具失败，你会收到错误信息和修复建议。
- 你可以多轮调用工具来完成复杂任务。
- 最终回复必须是自然语言，说明你做了什么、发现了什么、还需要用户做什么。

## 工具使用指南
- register_entity：注册新角色/地点/物品（每次注册一个实体）
- propose_event + commit_event：这是你的核心工作流。propose 创建提案，commit 确认写入。
- get_context_slice：查询实体当前状态（修改前先查询）
- 常用谓词：${predicateExamples}
- **不要使用** propose_schema_extension / commit_schema_extension，除非用户明确要求添加新的自定义谓词类型。

## 禁止行为
- 不暴露你的内部推理链。
- 不把工具失败包装成成功。
- 用户仍在修改时，不自动提交。
- 不编造不存在的实体 ID 或 Fact ID。`;
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

    // 从最近的 tool 消息中提取实体 ID
    for (let i = this.state.messages.length - 1; i >= 0; i--) {
      const msg = this.state.messages[i]!;
      if (msg.role === 'tool') {
        const matches = msg.content.match(entPattern);
        if (matches) {
          entityIds.push(...matches);
        }
      }
      // 最多回溯 10 条 tool 消息
      if (entityIds.length > 0 && i < this.state.messages.length - 10) break;
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

// =============================================================================
// W11 测试：错误模型——错误码抛出 + ERROR_RECOVERY_MAP 接入
// =============================================================================
// 验证 W11 两子项：
//   W11-a 错误码抛出补全：DRAFT_NOT_READY_FOR_SIMULATION / COREBRIDGE_SIMULATE_FAILED 等
//          此前"仅定义不抛"的码，现于真实代码路径以 WritingError 抛出（携带 code）。
//   W11-b ERROR_RECOVERY_MAP 接入：映射表此前定义后无人读取（死代码）。现经 getErrorRecovery
//          （RealCoreBridge.explanation 工厂消费）+ renderErrorForAuthor（CLI 异常通道消费）进入运行时。
//
// 覆盖点：
//   1. getErrorRecovery：已知码返回 map 条目；未知码返回保守兜底（永不为 undefined）
//   2. renderErrorForAuthor：WritingError / StateMachineError（鸭子类型 code）→ 人话 + 技术括注；
//      普通错误回退 message
//   3. 映射完备性不变式：所有"生产代码会抛出"的 WritingErrorCode 都在 ERROR_RECOVERY_MAP 中登记
//   4. RealCoreBridge.explanation 消费 map：提交/注册失败路径的 suggestedActions 取自 map（非硬编码）
//   5. draft-service：推演就绪失败 → WritingError(DRAFT_NOT_READY_FOR_SIMULATION)
//   6. 端到端错误码透传：propose_event 失败 → runProposeEvent 抛 COREBRIDGE_SIMULATE_FAILED →
//      draft-service.simulateDraft catch 保留 code（不降级为普通 Error）
//
// 使用真实 Core（:memory: SQLite + 真实 ToolRouter），无 LLM / Embedding。
// =============================================================================

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SQLiteFactStoreAdapter } from '../../src/adapters/sqlite/fact-store.js';
import { SQLiteThreadStoreAdapter } from '../../src/adapters/sqlite/thread-store.js';
import { SQLiteKnowledgeStoreAdapter } from '../../src/adapters/sqlite/knowledge-store.js';
import { SQLiteEventStoreAdapter } from '../../src/adapters/sqlite/event-store.js';
import { ProposalManager } from '../../src/core/proposal-manager.js';
import { RuleEngine } from '../../src/core/rule-engine.js';
import { ThreadResolver } from '../../src/core/thread-resolver.js';
import { RetconEngine } from '../../src/core/retcon-engine.js';
import { ToolService } from '../../src/core/tool-service.js';
import { SchemaExtensionManager } from '../../src/core/schema-extension-manager.js';
import { ToolRouter } from '../../src/core/tool-router.js';
import { SQLiteWritingStore } from '../../src/writing/repositories/writing-store.js';
import { AuditService } from '../../src/writing/services/audit-service.js';
import { WorkflowService } from '../../src/writing/services/workflow-service.js';
import { DraftService } from '../../src/writing/services/draft-service.js';
import { RealCoreBridge } from '../../src/writing/core-bridge/real-bridge.js';
import { makeRequestContext } from '../../src/writing/services/context.js';
import type { WritingRequestContext } from '../../src/writing/services/context.js';
import {
  WritingError,
  WritingErrorCode,
  ERROR_RECOVERY_MAP,
  getErrorRecovery,
  renderErrorForAuthor,
} from '../../src/writing/errors/error-codes.js';
import { StateMachineError } from '../../src/writing/models/state-machine.js';

// =============================================================================
// 1. getErrorRecovery（ERROR_RECOVERY_MAP 的结构化通道读取入口）
// =============================================================================

describe('W11-b getErrorRecovery 读取 ERROR_RECOVERY_MAP', () => {
  it('已知 WritingErrorCode 返回 map 中的人话 + 恢复动作', () => {
    const r = getErrorRecovery(WritingErrorCode.VERSION_CONFLICT);
    expect(r.humanMessage).toBe(ERROR_RECOVERY_MAP[WritingErrorCode.VERSION_CONFLICT]!.humanMessage);
    expect(r.suggestedActions).toBe(ERROR_RECOVERY_MAP[WritingErrorCode.VERSION_CONFLICT]!.suggestedActions);
  });

  it('未登记的码（如 Core 原生码 / 临时码）返回保守兜底，永不为 undefined', () => {
    const r = getErrorRecovery('SOME_UNREGISTERED_CODE');
    expect(r.humanMessage).toBeTruthy();
    expect(Array.isArray(r.suggestedActions)).toBe(true);
    expect(r.suggestedActions.length).toBeGreaterThan(0);
  });
});

// =============================================================================
// 2. renderErrorForAuthor（异常通道读取入口）
// =============================================================================

describe('W11-b renderErrorForAuthor 渲染异常', () => {
  it('WritingError（已登记码）→ 人话 + 技术细节括注', () => {
    const err = new WritingError(WritingErrorCode.INVALID_STATUS_TRANSITION, '某对象状态跳转禁止');
    const rendered = renderErrorForAuthor(err);
    expect(rendered).toContain('当前状态不允许此操作');
    expect(rendered).toContain('某对象状态跳转禁止'); // 技术细节保留
  });

  it('StateMachineError（不继承 WritingError 但鸭子类型同构 code）→ 经 map 映射', () => {
    // StateMachineError extends Error，非 WritingError；但其 code 字段同构，renderErrorForAuthor 据此映射
    const err = new StateMachineError(
      WritingErrorCode.INVALID_STATUS_TRANSITION, 'planning', 'archived', 'WritingProject', 'proj_x',
    );
    const rendered = renderErrorForAuthor(err);
    expect(rendered).toContain('当前状态不允许此操作');
  });

  it('WritingError（未登记码，如 COREBRIDGE_CONFIG_ERROR）→ 回退技术 message', () => {
    // COREBRIDGE_CONFIG_ERROR 不在 ERROR_RECOVERY_MAP（配置错误非领域可恢复错误）
    const err = new WritingError('COREBRIDGE_CONFIG_ERROR' as WritingErrorCode, '配置缺失');
    expect(renderErrorForAuthor(err)).toBe('配置缺失');
  });

  it('普通 Error（无 code）→ 原样返回 message', () => {
    expect(renderErrorForAuthor(new Error('boom'))).toBe('boom');
  });

  it('非 Error 值（字符串 / undefined）→ String() 兜底', () => {
    expect(renderErrorForAuthor('plain string')).toBe('plain string');
    expect(renderErrorForAuthor(undefined)).toBe('undefined');
  });
});

// =============================================================================
// 3. 映射完备性不变式——所有"生产代码会抛出"的码都在 ERROR_RECOVERY_MAP 登记
//    （否则该码抛出后 renderErrorForAuthor 会回退到裸技术消息，人话通道失效）
// =============================================================================

describe('W11 映射完备性：生产抛出的错误码均登记人话', () => {
  // 经 W11-a 后，以下码在真实代码路径中以 WritingError 抛出或 CoreErrorExplanation 返回
  const thrownCodes = [
    WritingErrorCode.INVALID_STATUS_TRANSITION,        // state-machine.ts
    WritingErrorCode.WRITING_OBJECT_NOT_FOUND,          // writing-store.ts + bridge
    WritingErrorCode.VERSION_CONFLICT,                  // writing-store.ts
    WritingErrorCode.DRAFT_NOT_READY_FOR_SIMULATION,    // draft-service.ts（W11-a 新抛）
    WritingErrorCode.COREBRIDGE_SIMULATE_FAILED,        // real-bridge.ts runProposeEvent（W11-a 新抛）
    WritingErrorCode.PROPOSAL_NOT_IN_REVIEW,            // real-bridge.ts commitReviewedProposal
    WritingErrorCode.SOURCE_DRAFT_MODIFIED_AFTER_REVIEW,// real-bridge.ts commitReviewedProposal
  ] as const;

  it.each(thrownCodes)('%s 在 ERROR_RECOVERY_MAP 中有人话条目', (code) => {
    expect(ERROR_RECOVERY_MAP[code]).toBeDefined();
    expect(ERROR_RECOVERY_MAP[code]!.humanMessage.length).toBeGreaterThan(0);
  });
});

// =============================================================================
// 4-6. 真实 Core 栈：bridge explanation 消费 map + draft-service 错误码抛出/透传
// =============================================================================

describe('W11 真实栈：错误码抛出 + ERROR_RECOVERY_MAP 消费', () => {
  let router: ToolRouter;
  let store: SQLiteWritingStore;
  let auditService: AuditService;
  let coreBridge: RealCoreBridge;
  let draftService: DraftService;
  let projectId: string;
  let ctx: WritingRequestContext;

  beforeEach(() => {
    const factStore = new SQLiteFactStoreAdapter(':memory:', 'default');
    const db = factStore.getDatabase();
    const threadStore = new SQLiteThreadStoreAdapter(db);
    const knowledgeStore = new SQLiteKnowledgeStoreAdapter(db);
    const eventStore = new SQLiteEventStoreAdapter(db);
    const threadResolver = new ThreadResolver();
    const proposalManager = new ProposalManager(new RuleEngine(), undefined, threadStore, threadResolver);
    const retconEngine = new RetconEngine();
    const toolService = new ToolService(factStore, knowledgeStore, eventStore, threadStore, threadResolver);
    const schemaExtensionManager = new SchemaExtensionManager(db);
    router = new ToolRouter({
      proposalManager, retconEngine, toolService,
      schemaExtensionManager, factStore, knowledgeStore, eventStore, threadStore,
    });

    db.exec(`INSERT INTO entities (id, name, kind, first_appearance) VALUES ('ent_hero', '主角', 'entity', 1)`);

    store = new SQLiteWritingStore(db);
    store.createTables();
    auditService = new AuditService(store);
    const workflow = new WorkflowService(store, auditService);
    coreBridge = new RealCoreBridge(router, store, auditService);
    draftService = new DraftService(store, auditService, coreBridge, workflow);

    projectId = store.createProject('W11 错误模型测试').id;
    ctx = makeRequestContext({ projectId, trigger: 'review_decision' });
  });

  // --- 4. bridge explanation() 消费 ERROR_RECOVERY_MAP（提交路径）---

  it('commitReviewedProposal 找不到 PV → WRITING_OBJECT_NOT_FOUND + suggestedActions 取自 map', async () => {
    const result = await coreBridge.commitReviewedProposal(ctx, 'pv_does_not_exist');
    expect(result.success).toBe(false);
    expect(result.error!.errorCode).toBe(WritingErrorCode.WRITING_OBJECT_NOT_FOUND);
    // suggestedActions 来自 explanation()→getErrorRecovery()→ERROR_RECOVERY_MAP（证明 map 被消费，非硬编码）
    expect(result.error!.suggestedActions).toEqual(
      ERROR_RECOVERY_MAP[WritingErrorCode.WRITING_OBJECT_NOT_FOUND]!.suggestedActions,
    );
  });

  it('registerReviewedEntity 草图状态非 approved → INVALID_STATUS_TRANSITION + 精确覆盖的 suggestedActions', async () => {
    // 创建一个 candidate 态草图（未 approved），注册前置校验应拦截
    const sketch = store.createEntitySketch(projectId, {
      displayName: '未批准角色', typeLabel: '角色', status: 'candidate',
    });
    const result = await coreBridge.registerReviewedEntity(ctx, sketch.id);
    expect(result.success).toBe(false);
    expect(result.error!.errorCode).toBe(WritingErrorCode.INVALID_STATUS_TRANSITION);
    // 此处 explanation() 的 suggestedActions 为"上下文精确覆盖"——"草图未批准"需指引作者先批准，
    // 比 map 的通用「刷新后重试」更可操作（覆盖路径与默认取 map 路径互补，后者由上一个 commit 用例验证）
    expect(result.error!.suggestedActions).toEqual(['请先通过 approveCandidate 批准该候选实体']);
    // humanMessage 同样被覆盖为带当前状态的精确文案
    expect(result.error!.humanMessage).toContain('approved');
  });

  // --- 5. draft-service 抛 DRAFT_NOT_READY_FOR_SIMULATION ---

  it('markReadyForSimulation 草案内容过短 → 抛 WritingError(DRAFT_NOT_READY_FOR_SIMULATION)', () => {
    // content < 10 字（validateDraftSimulationReadiness 阈值）
    const draft = store.createDraft(projectId, { kind: 'event', content: '太短了' });
    // 起始 status='drafting'，先合法推进到可校验就绪（markReady 内部先 validateDraftTransition 再校验就绪）；
    // 内容过短会在 validateDraftSimulationReadiness 处失败
    expect(() => draftService.markReadyForSimulation(ctx, draft.id)).toThrow(WritingError);
    try {
      draftService.markReadyForSimulation(ctx, draft.id);
    } catch (err) {
      expect((err as WritingError).code).toBe(WritingErrorCode.DRAFT_NOT_READY_FOR_SIMULATION);
    }
  });

  // --- 6. 端到端错误码透传：propose_event 失败 → COREBRIDGE_SIMULATE_FAILED 保留至顶层 ---

  it('simulateDraft 推演失败 → WritingError(COREBRIDGE_SIMULATE_FAILED) 透传（不降级普通 Error）', async () => {
    const draft = store.createDraft(projectId, {
      kind: 'event', content: '主角穿过荒原抵达废弃站台查看异象描述',
    });
    store.updateDraft(draft.id, draft.version, { status: 'ready_to_simulate' });

    // 让 propose_event 失败：spy toolRouter.execute 返回结构化失败
    vi.spyOn(router, 'execute').mockResolvedValue({
      success: false,
      error: { code: 'SIM_INJECTED_FAIL', message: '注入的推演失败', retryable: false },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    try {
      await draftService.simulateDraft(ctx, draft.id, [
        { change_id: 'ch1', op: 'assert', subject: 'ent_hero', predicate: 'location', value: '废弃站台' },
      ]);
      throw new Error('应抛错但未抛');
    } catch (err) {
      // runProposeEvent 抛 COREBRIDGE_SIMULATE_FAILED，draft-service catch 仅附加上下文、保留 code
      expect(err).toBeInstanceOf(WritingError);
      expect((err as WritingError).code).toBe(WritingErrorCode.COREBRIDGE_SIMULATE_FAILED);
      // draft-service 附加的上下文前缀保留（调试可定位）
      expect((err as Error).message).toContain('沙盒推演失败');
    }

    vi.mocked(router.execute).mockRestore();
  });
});

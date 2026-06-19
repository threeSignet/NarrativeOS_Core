// =============================================================================
// WritingErrorCode — 写作层错误码枚举
// =============================================================================
// 写作层独有的错误码，与 Core 的 ToolErrorCode（§9.3）互补。
// 每个错误码都有对应的作者可读消息和恢复动作。
//
// 设计要点：
//   - 状态机违规由服务层校验函数抛出，不解码到 Core 层
//   - 权限违规由 Agent 适配层检测，不解码到 Core 层
//   - CoreBridge 失败保留 Core 原生错误码，写作层只加包装
// =============================================================================

export const WritingErrorCode = {
  // ---------------------------------------------------------------------------
  // 状态机违规（§5 状态机细化）
  // ---------------------------------------------------------------------------

  /** 对象当前状态不允许此操作 */
  INVALID_STATUS_TRANSITION: 'INVALID_STATUS_TRANSITION',
  /** 草案未满足推演前置条件（无内容/已提交/已归档） */
  DRAFT_NOT_READY_FOR_SIMULATION: 'DRAFT_NOT_READY_FOR_SIMULATION',
  /** 提案未在审核中状态，不能提交 */
  PROPOSAL_NOT_IN_REVIEW: 'PROPOSAL_NOT_IN_REVIEW',

  // ---------------------------------------------------------------------------
  // 权限违规（§8.3 Agent 工具权限）
  // ---------------------------------------------------------------------------

  /** Agent 尝试直接调用 CoreBridge 提交方法 */
  AGENT_COMMIT_FORBIDDEN: 'AGENT_COMMIT_FORBIDDEN',
  /** Agent 尝试直接调用 CoreBridge 注册方法 */
  AGENT_REGISTER_FORBIDDEN: 'AGENT_REGISTER_FORBIDDEN',
  /** 未经 Proposal Review 审核的提交请求 */
  COMMIT_WITHOUT_REVIEW: 'COMMIT_WITHOUT_REVIEW',

  // ---------------------------------------------------------------------------
  // 来源问题（§4 SourceRef 模型）
  // ---------------------------------------------------------------------------

  /** 审核期间来源草案被修改，导致审核过期 */
  SOURCE_DRAFT_MODIFIED_AFTER_REVIEW: 'SOURCE_DRAFT_MODIFIED_AFTER_REVIEW',
  /** 来源引用指向的对象已被删除或不存在 */
  SOURCE_REF_BROKEN: 'SOURCE_REF_BROKEN',
  /** Core 引用失效（Core 侧对象已被 Retcon 或删除） */
  CORE_REF_STALE: 'CORE_REF_STALE',

  // ---------------------------------------------------------------------------
  // CoreBridge 失败（§18 Mock 规格 + 真实实现）
  // ---------------------------------------------------------------------------

  /** CoreBridge 沙盒推演失败 */
  COREBRIDGE_SIMULATE_FAILED: 'COREBRIDGE_SIMULATE_FAILED',
  /** CoreBridge 提交失败（Core 拒绝写入） */
  COREBRIDGE_COMMIT_FAILED: 'COREBRIDGE_COMMIT_FAILED',
  /** Core 提交成功但写作层回写失败（需要恢复） */
  COREBRIDGE_WRITEBACK_FAILED: 'COREBRIDGE_WRITEBACK_FAILED',

  // ---------------------------------------------------------------------------
  // 映射问题（§4.7 蓝图到 Core 的映射）
  // ---------------------------------------------------------------------------

  /** 蓝图类型到 Core 的映射置信度过低 */
  BLUEPRINT_MAPPING_LOW_CONFIDENCE: 'BLUEPRINT_MAPPING_LOW_CONFIDENCE',
  /** 实体类型未映射到任何 Core EntityKind */
  ENTITY_TYPE_NOT_MAPPED: 'ENTITY_TYPE_NOT_MAPPED',
  /** 关系类型未找到对应的 Core predicate */
  PREDICATE_NOT_FOUND: 'PREDICATE_NOT_FOUND',

  // ---------------------------------------------------------------------------
  // 重复/冲突
  // ---------------------------------------------------------------------------

  /** 疑似重复的实体候选 */
  DUPLICATE_ENTITY_CANDIDATE: 'DUPLICATE_ENTITY_CANDIDATE',
  /** 同一草案已有活跃的审核视图 */
  DUPLICATE_PROPOSAL: 'DUPLICATE_PROPOSAL',

  // ---------------------------------------------------------------------------
  // 存储
  // ---------------------------------------------------------------------------

  /** WritingStore 读写失败 */
  WRITING_STORE_ERROR: 'WRITING_STORE_ERROR',
  /** 找不到写作层对象 */
  WRITING_OBJECT_NOT_FOUND: 'WRITING_OBJECT_NOT_FOUND',
  /** 乐观锁冲突——对象已被并发修改，调用方持有的 version 过期（需重读后重试） */
  VERSION_CONFLICT: 'VERSION_CONFLICT',
} as const;

export type WritingErrorCodeType = (typeof WritingErrorCode)[keyof typeof WritingErrorCode];

// =============================================================================
// WritingError — 写作层结构化错误
// =============================================================================
// 携带错误码 + 可选明细，供上层（CLI / WebUI）通过 ERROR_RECOVERY_MAP 映射为人话消息。
// 与 Core 的 ToolError 区分：写作层错误统一用 WritingErrorCode。
// 状态机违规另有 StateMachineError（额外携带状态上下文）；其余写作层错误用本类。
// =============================================================================

/**
 * 写作层结构化错误
 *
 * @param code   WritingErrorCode 之一
 * @param message 面向调试的技术消息（含关键 ID / 版本号）
 * @param detail  可选明细：版本冲突时携带 { expected, actual }，供上层展示与重试
 */
export class WritingError extends Error {
  constructor(
    public readonly code: WritingErrorCodeType,
    message: string,
    public readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'WritingError';
  }
}

// =============================================================================
// 错误恢复动作映射（面向普通作者的人话消息）
// =============================================================================

/**
 * 将写作层错误码转换为作者可读消息和恢复建议
 *
 * 普通作者视图不展示错误码本身——只展示 humanMessage。
 * 调试视图可额外展示 code 和 technicalDetail。
 */
export const ERROR_RECOVERY_MAP: Record<string, { humanMessage: string; suggestedActions: string[] }> = {
  [WritingErrorCode.INVALID_STATUS_TRANSITION]:
    { humanMessage: '当前状态不允许此操作', suggestedActions: ['刷新后重试'] },

  [WritingErrorCode.DRAFT_NOT_READY_FOR_SIMULATION]:
    { humanMessage: '草案尚未准备好推演', suggestedActions: ['确认草案内容已填写完整', '检查草案状态是否为"可推演"'] },

  [WritingErrorCode.PROPOSAL_NOT_IN_REVIEW]:
    { humanMessage: '提案尚未进入可提交的审核状态', suggestedActions: ['先完成沙盒推演生成提案', '通过确认通道批准后再提交'] },

  [WritingErrorCode.AGENT_COMMIT_FORBIDDEN]:
    { humanMessage: '提交需要在审核页确认', suggestedActions: ['打开 Proposal Review 审核页确认提交'] },

  // W2：激活原本无 throw 点的死错误码。permission-check.ts 的 assertAgentMayCall 现按方法类别抛出：
  //   - 实体注册类（registerReviewedEntity）→ AGENT_REGISTER_FORBIDDEN
  //   - 其余 COMMIT_FORBIDDEN → AGENT_COMMIT_FORBIDDEN（上方条目）
  [WritingErrorCode.AGENT_REGISTER_FORBIDDEN]:
    { humanMessage: '实体注册需要在审核通道确认', suggestedActions: ['在实体审核通道确认后由系统注册'] },

  // W2 Fix-4：throw 点已落地（narrative-agent.ts handleConfirmCommit 顶部守卫）。该码语义为
  // "提交绕过 Proposal Review 审核"——handleConfirmCommit 是裸路径的直提 commit_event 入口，
  // writingLayer 模式（this.writingStore 已注入）下调用它即"绕过 PV 审核"，故抛本码。
  // 现有两个调用点（confirm_commit 分支、裸 /auto 自动提交）均用 !this.writingStore 守卫，
  // 故该 throw 在现有路径永不触发——是防御性不变式（前向防回归 + 激活死错误码），与
  // permission-check.ts 的 AGENT_COMMIT_FORBIDDEN/AGENT_REGISTER_FORBIDDEN 同范式。
  // 裸路径（无 writingStore）仍合法直提（裸 Agent /auto 模式有意授权无 PV 提交），不受影响。
  [WritingErrorCode.COMMIT_WITHOUT_REVIEW]:
    { humanMessage: '本次提交未经 Proposal Review 审核', suggestedActions: ['先走 Proposal Review 审核流程再提交'] },

  [WritingErrorCode.SOURCE_DRAFT_MODIFIED_AFTER_REVIEW]:
    { humanMessage: '草案在审核期间被修改，需要重新推演', suggestedActions: ['重新执行沙盒推演'] },

  [WritingErrorCode.COREBRIDGE_SIMULATE_FAILED]:
    { humanMessage: '沙盒推演失败，无法生成提交提案', suggestedActions: ['检查草案的事件描述与设定变更', '稍后重试推演'] },

  [WritingErrorCode.COREBRIDGE_COMMIT_FAILED]:
    { humanMessage: '提交失败，Core 拒绝写入', suggestedActions: ['查看 Core 返回的错误原因', '修复后重新提交'] },

  [WritingErrorCode.COREBRIDGE_WRITEBACK_FAILED]:
    { humanMessage: '提交成功但写作层状态更新失败，请联系系统管理员', suggestedActions: ['手动触发状态恢复', '检查审计日志'] },

  [WritingErrorCode.BLUEPRINT_MAPPING_LOW_CONFIDENCE]:
    { humanMessage: '系统不确定如何将此类型映射到正式世界状态', suggestedActions: ['在蓝图设置中确认映射关系'] },

  [WritingErrorCode.WRITING_OBJECT_NOT_FOUND]:
    { humanMessage: '找不到请求的写作层对象', suggestedActions: ['检查对象是否已被删除或归档'] },

  [WritingErrorCode.VERSION_CONFLICT]:
    { humanMessage: '该对象已被修改，你的副本已过期', suggestedActions: ['重新读取最新内容', '基于最新版本重新提交修改'] },

  // 补全前瞻/存储/映射/重复类错误码的恢复映射——此前仅 13/20 码登记，其余 7 个走 getErrorRecovery
  // 的保守兜底"操作未能完成"。一旦这些码被实际抛出（SOURCE_REF_BROKEN 在来源校验、
  // WRITING_STORE_ERROR 在存储异常、ENTITY_TYPE_NOT_MAPPED/PREDICATE_NOT_FOUND 在蓝图映射、
  // DUPLICATE_* 在重复检测、CORE_REF_STALE 在 Core 引用失效），作者应看到针对性恢复指引，
  // 而非泛化兜底——与 §10.2"每个码→作者可见消息"的意图一致。
  [WritingErrorCode.CORE_REF_STALE]:
    { humanMessage: '相关的世界状态引用已失效', suggestedActions: ['刷新世界状态后重试', '检查对象是否被 Retcon 修改'] },

  [WritingErrorCode.SOURCE_REF_BROKEN]:
    { humanMessage: '引用的来源对象已不存在', suggestedActions: ['检查来源对象是否已被删除', '重新建立引用关系'] },

  [WritingErrorCode.ENTITY_TYPE_NOT_MAPPED]:
    { humanMessage: '此实体类型尚未映射到正式世界状态', suggestedActions: ['在蓝图设置中补充实体类型映射'] },

  [WritingErrorCode.PREDICATE_NOT_FOUND]:
    { humanMessage: '找不到对应的关系类型', suggestedActions: ['在蓝图设置中补充关系类型映射'] },

  [WritingErrorCode.DUPLICATE_ENTITY_CANDIDATE]:
    { humanMessage: '检测到疑似重复的实体', suggestedActions: ['确认是否为同一实体', '合并或重命名以区分'] },

  [WritingErrorCode.DUPLICATE_PROPOSAL]:
    { humanMessage: '该草案已有进行中的审核提案', suggestedActions: ['先处理现有提案', '确认是否需要重新推演'] },

  [WritingErrorCode.WRITING_STORE_ERROR]:
    { humanMessage: '数据读写异常', suggestedActions: ['重试操作', '检查数据完整性'] },
};

// =============================================================================
// ERROR_RECOVERY_MAP 的读取入口（W11：消除"定义后无人消费"的死代码状态）
// =============================================================================
// 此前 ERROR_RECOVERY_MAP 定义后无任何读取方——所有调用点各写一份人话/恢复动作，
// 映射表本身从未被查询。下面两个函数是其唯一读取点：
//   - getErrorRecovery(code)：按码取默认人话 + 恢复动作（结构化错误通道，RealCoreBridge.explanation 工厂消费）
//   - renderErrorForAuthor(err)：把抛出的异常渲染为作者可读文案（异常通道，CLI/上层 catch 消费）
// 两者共同保证"恢复文案单一真相源"，且让映射表真正进入运行时数据流。
// =============================================================================

/**
 * 按 WritingErrorCode（或 Core 原生错误码）查询作者可读的恢复指引（§10.2 ERROR_RECOVERY_MAP）
 *
 * @param code WritingErrorCode 枚举常量的字符串值，或 Core 原生错误码（如 PROPOSAL_NOT_FOUND / UNSAFE）
 * @returns `{ humanMessage, suggestedActions }`——**永不为 undefined**：未登记的码返回保守兜底，
 *          使调用方无需逐码判空
 */
export function getErrorRecovery(code: string): {
  humanMessage: string;
  suggestedActions: string[];
} {
  return (
    ERROR_RECOVERY_MAP[code] ?? {
      humanMessage: '操作未能完成',
      suggestedActions: ['重试操作', '检查输入参数'],
    }
  );
}

/**
 * 将任意错误渲染为作者可读文案（异常通道的恢复映射入口）
 *
 * 写作层结构化错误（WritingError / StateMachineError——StateMachineError 虽不继承 WritingError，
 * 但鸭子类型同构，均携带 `code` 字段）经 ERROR_RECOVERY_MAP 映射为人话；同时在括注中保留原始
 * 技术消息（调试友好，便于定位）。非结构化错误（普通 Error / 字符串）原样返回 message。
 *
 * 设计取舍："人话优先 + 技术细节括注"兼顾"普通作者看得懂"与"开发者能定位"；纯人话视图
 * （隐藏技术细节）可由未来 WebUI 层基于 technicalDetail 单独控制。
 *
 * @param err 任意被抛出的错误（WritingError / StateMachineError / Error / unknown）
 * @returns 作者可读文案字符串
 */
export function renderErrorForAuthor(err: unknown): string {
  // 结构化写作层错误：携带字符串 code 且在映射表中登记 → 取人话 + 技术细节括注
  if (err && typeof err === 'object' && 'code' in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string' && ERROR_RECOVERY_MAP[code]) {
      const recovery = ERROR_RECOVERY_MAP[code];
      const tech = err instanceof Error ? err.message : '';
      // 人话优先；技术细节作括注补充（如含对象 ID / 状态上下文），避免单纯人话丢失定位信息
      return tech ? `${recovery.humanMessage}（${tech}）` : recovery.humanMessage;
    }
  }
  // 非结构化错误：原样返回 message，保持既有调试信息不丢
  return err instanceof Error ? err.message : String(err);
}

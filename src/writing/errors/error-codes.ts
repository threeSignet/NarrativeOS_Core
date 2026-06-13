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
} as const;

export type WritingErrorCodeType = (typeof WritingErrorCode)[keyof typeof WritingErrorCode];

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

  [WritingErrorCode.AGENT_COMMIT_FORBIDDEN]:
    { humanMessage: '提交需要在审核页确认', suggestedActions: ['打开 Proposal Review 审核页确认提交'] },

  [WritingErrorCode.SOURCE_DRAFT_MODIFIED_AFTER_REVIEW]:
    { humanMessage: '草案在审核期间被修改，需要重新推演', suggestedActions: ['重新执行沙盒推演'] },

  [WritingErrorCode.COREBRIDGE_COMMIT_FAILED]:
    { humanMessage: '提交失败，Core 拒绝写入', suggestedActions: ['查看 Core 返回的错误原因', '修复后重新提交'] },

  [WritingErrorCode.COREBRIDGE_WRITEBACK_FAILED]:
    { humanMessage: '提交成功但写作层状态更新失败，请联系系统管理员', suggestedActions: ['手动触发状态恢复', '检查审计日志'] },

  [WritingErrorCode.BLUEPRINT_MAPPING_LOW_CONFIDENCE]:
    { humanMessage: '系统不确定如何将此类型映射到正式世界状态', suggestedActions: ['在蓝图设置中确认映射关系'] },

  [WritingErrorCode.WRITING_OBJECT_NOT_FOUND]:
    { humanMessage: '找不到请求的写作层对象', suggestedActions: ['检查对象是否已被删除或归档'] },
};

// =============================================================================
// ViewModel 字段过滤器（§9.1 禁止字段——normal 模式的可见性边界）
// =============================================================================
// 设计文档：Phase7-Refinement.md §9.1。
//
// §9.1 规定 normal（面向作者）模式下，ViewModel 绝不能暴露下列技术字段：
//   - Core EntityKind / RelationKind（内部枚举字符串，如 'character'）
//   - Core predicate（谓词键名，如 'location'）
//   - Core 实体/事实/事件 ID（ent_hanli / fct_encounter_50_02 / evt_encounter_250）
//   - 规则 JSON DSL（fact_changes / condition）
//   - 内部 request ID（req_xxx）
//   - 表名裸值（writing_drafts）
//
// 本过滤器是 ViewModel 投影的**最后一道防线**：
//   - findForbiddenField    —— 深度扫描，定位首个违规字段（返回路径字符串，无违规返回 null）
//   - stripForbiddenFields  —— 递归剥离禁止键 + 掩码 Core ID 值（normal）；debug 原样返回
//   - assertNoForbiddenFields —— 防御性断言：normal 模式发现泄漏即抛错（编程缺陷信号）
//
// 设计取舍：
//   1. 「禁止键」按 KEY 名精确匹配（大小写不敏感），避免误伤如 candidateEntityCount
//      这类含 "Entity" 但合法的字段——它不是 coreEntityId。
//   2. 「禁止值」按 VALUE 模式匹配 Core ID 前缀（ent_/fct_/evt_/req_/thd_/kno_）与表名
//      writing_*——无论藏在哪个键下都能兜住。
//   3. assertNoForbiddenFields 抛普通 Error 而非 WritingError：这是**编程不变式断言**
//      （投影层产出了泄漏 = 投影逻辑有 bug），不是用户可恢复的领域错误，不应进入
//      ERROR_RECOVERY_MAP 的"作者可读消息"通道（§10.2）。W11 重构错误模型时可再议。
// =============================================================================

/** 视图可见性模式——与 WritingRequestContext.visibilityMode 对齐 */
export type VisibilityMode = 'normal' | 'debug';

// Core 内部对象 ID 前缀——这些值出现在 normal ViewModel 即为泄漏（§9.1）
const FORBIDDEN_VALUE_PATTERNS: RegExp[] = [
  /^ent_/, // Core 实体 ID
  /^fct_/, // Core 事实 ID
  /^evt_/, // Core 事件 ID
  /^thd_/, // Core 叙事线索 ID
  /^kno_/, // Core 知识条目 ID
  /^req_/, // 内部请求 ID
  // 表名裸值改用下方 WRITING_TABLE_NAMES 白名单精确匹配——原宽正则 /^writing_[a-z_]+$/
  // 会误掩码恰好全小写的合法文本（如标签 "writing_notes"），构成潜在数据正确性隐患。
];

// 写作层表名裸值——精确白名单，仅真实存在的 writing_* 表名判定为泄漏。
// 与 writing-store.ts createTables 的 DDL 保持同步（§3.2）；新增表时须同步本集合。
// P1 修复（A2）：补全 Phase 8 三张表（writing_relations/associations/relation_hints），
// 此前遗漏导致 normal 模式下这些表名裸值不被掩码，构成 §9.1 可见性边界缺口。
const WRITING_TABLE_NAMES: ReadonlySet<string> = new Set([
  'writing_projects', 'writing_author_goals', 'writing_idea_cards', 'writing_blueprints',
  'writing_drafts', 'writing_entity_sketches', 'writing_pending_decisions',
  'writing_proposal_views', 'writing_audit_logs', 'writing_core_refs', 'writing_jobs',
  'writing_workspace_layouts', 'writing_project_preferences',
  // Phase 8（W.14/W.15/W.16）
  'writing_relations', 'writing_associations', 'writing_relation_hints',
  // Phase 9（W.17/W.18/W.19）
  'writing_spatial_nodes', 'writing_spatial_edges', 'writing_spatial_views',
  // Phase 10（W.20/W.21）
  'writing_chapter_plans', 'writing_scene_plans',
  // Phase 11（W.22-W.28）
  'writing_reader_audiences', 'writing_reader_knowledge_states',
  'writing_foreshadowing_plans', 'writing_hint_occurrences', 'writing_payoff_plans',
  'writing_reveal_plans', 'writing_reveal_milestones',
  // Phase 12（W.29-W.36）
  'writing_prose_documents', 'writing_prose_blocks',
  'writing_style_guides', 'writing_style_examples', 'writing_banned_expressions',
  'writing_revision_records', 'writing_retcon_reports', 'writing_import_batches',
]);

/** 表名匹配时复用的标记正则（供违规 reason 文案引用） */
const TABLE_NAME_PATTERN = /^writing_/;

// 技术元数据键名——出现在 normal ViewModel 即为泄漏（§9.1）
// 全部小写后精确匹配，避免 substring 误伤（candidateEntityCount 不等于 coreentityid）。
const FORBIDDEN_KEY_NAMES: ReadonlySet<string> = new Set([
  'entitykind', // Core EntityKind 枚举
  'relationkind', // Core RelationKind 枚举
  'corekind', // 实体草图回带的 Core kind
  'predicate', // Core 谓词键名
  'coreentityid', // Core 实体引用
  'coreeventid', // Core 事件引用
  'corefactid', // Core 事实引用
  'corethreadid', // Core 线索引用
  'coreproposalid', // Core proposal 引用
  'tablename', // 表名
  'requestid', // 内部请求 ID
  'reqid', // 内部请求 ID（短名）
  'sessionid', // 内部会话 ID
  'factchanges', // 规则 JSON DSL（camelCase）
  'fact_changes', // 规则 JSON DSL（snake_case）
  'condition', // 规则 JSON DSL（wp_rules condition）
  'corebridgeresult', // CoreBridge 原始返回（含技术结构）
  'expectedstateversion', // Core 乐观锁版本号
  'rawinput', // 原始输入回带
  // P2 补全：写作层内部技术字段（2026-06-18 审查发现）
  // 注：linkedProposalViewId / sourceDraftId / draftId 等写作层 id（drft_/wpvw_ 前缀）
  // 不在此列——它们是作者导航用的 id（如 /review <pvId>、/drafts 显示草案），非 Core 技术 id。
  'versiongroupid', // 实体合并的版本组 ID（纯内部）
  'authordecision', // 作者决策记录（内部审计字段，非人话展示）
  'simulationinputs', // PV 的原始推演输入 DSL（内部）
  'commiterror', // PV 提交失败的技术错误（内部）
]);

/** Core ID 值的掩码——剥离时替换，确保原始前缀不泄漏 */
const MASKED = '***';

/** 单个违规记录：定位到字段路径 + 违规原因 */
interface ForbiddenFinding {
  path: string;
  reason: string;
}

/** 判定一个键名是否为 §9.1 禁止的技术元数据键 */
function isForbiddenKey(key: string): boolean {
  return FORBIDDEN_KEY_NAMES.has(key.toLowerCase());
}

/** 判定一个字符串值是否匹配 Core ID / 表名等禁止模式 */
function matchForbiddenValue(value: string): RegExp | null {
  for (const pattern of FORBIDDEN_VALUE_PATTERNS) {
    if (pattern.test(value)) return pattern;
  }
  // 表名裸值精确匹配（白名单），避免宽正则误伤合法文本
  if (WRITING_TABLE_NAMES.has(value)) return TABLE_NAME_PATTERN;
  return null;
}

/**
 * 深度扫描对象，定位首个 §9.1 禁止字段
 *
 * @param obj   待扫描对象
 * @param mode  'normal' 扫描；'debug' 直接放行（debug 模式允许技术字段）
 * @returns     首个违规的路径描述（始终 truthy）；无违规返回 null
 */
export function findForbiddenField(obj: unknown, mode: VisibilityMode): string | null {
  if (mode === 'debug') return null;
  const found = scan(obj, '');
  return found ? `${found.path}（${found.reason}）` : null;
}

/** 递归扫描核心实现——返回首个违规或 null */
function scan(value: unknown, path: string, seen: WeakSet<object> = new WeakSet()): ForbiddenFinding | null {
  if (value === null || typeof value !== 'object') {
    // 字符串标量：检查值模式
    if (typeof value === 'string') {
      const m = matchForbiddenValue(value);
      if (m) return { path: path || '(root)', reason: `值匹配禁止模式 ${m}` };
    }
    return null;
  }

  // 防御循环引用导致栈溢出（VM 理论上无环，但防御性处理）
  if (seen.has(value as object)) return null;
  seen.add(value as object);

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = scan(value[i], `${path}[${i}]`, seen);
      if (hit) return hit;
    }
    return null;
  }

  // 普通对象：先查键名，再递归值
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    const childPath = path ? `${path}.${key}` : key;
    if (isForbiddenKey(key)) {
      return { path: childPath, reason: '禁止的技术键名' };
    }
    const hit = scan(record[key], childPath, seen);
    if (hit) return hit;
  }
  return null;
}

/**
 * 递归剥离禁止字段（normal 模式）；debug 模式原样返回同一引用
 *
 * normal 模式处理：
 *   - 禁止键名 → 整条移除（连同其值）
 *   - Core ID / 表名值 → 掩码为 '***'（保留结构，不泄漏原始前缀）
 *   - 其余字段原样保留
 *
 * @returns normal 返回**新对象**（不修改入参）；debug 返回入参同一引用
 */
export function stripForbiddenFields<T>(obj: T, mode: VisibilityMode): T {
  if (mode === 'debug') return obj;
  return strip(obj, new WeakSet()) as T;
}

/** 递归剥离实现——始终返回新副本，入参不可变 */
function strip(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'string') {
      const m = matchForbiddenValue(value);
      if (m) return MASKED;
    }
    return value;
  }
  if (seen.has(value as object)) return value;
  seen.add(value as object);

  if (Array.isArray(value)) {
    return value.map((item) => strip(item, seen));
  }

  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>)) {
    // 禁止键名直接丢弃——其值（可能是 Core ID）一并移除
    if (isForbiddenKey(key)) continue;
    out[key] = strip((value as Record<string, unknown>)[key], seen);
  }
  return out;
}

/**
 * 防御性断言：normal 模式下若发现 §9.1 禁止字段泄漏则抛错
 *
 * 用途：ViewModel 投影函数末尾自检——投影层本不该产出技术字段，
 *      若断言触发说明投影逻辑有 bug（如误把原始领域对象透传出去）。
 *      debug 模式为 no-op（允许技术字段）。
 *
 * @throws Error（含违规字段路径）——编程不变式信号，非用户可恢复错误
 */
export function assertNoForbiddenFields(obj: unknown, mode: VisibilityMode): void {
  const found = findForbiddenField(obj, mode);
  if (found) {
    throw new Error(`ViewModel 泄漏了 §9.1 禁止字段：${found}`);
  }
}

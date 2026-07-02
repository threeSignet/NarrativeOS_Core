// =============================================================================
// CLI 命令处理器（Phase 7 CLI 命令层）
// =============================================================================
// 10 个写作层命令的纯函数实现。设计要点：
//   - 每个 handler 接收 CliDeps（注入的 services）+ ParsedCommand，返回 string[]（输出行）
//   - 不直接 console.log——由 chat.ts 负责显示，便于单元测试（断言返回值）
//   - 错误经 renderErrorForAuthor 转人话，红色单行（CLI-Layer-Design §2.4）
//   - 列表命令只读人话字段（§5 过滤），--raw 才显示 coreEntityId/coreKind 等技术字段
//
// 命令分组（CLI-Layer-Design §2.2）：
//   审核：/pending
//   浏览：/world /entity /drafts /entities /ideas /blueprint
//   管理：/project /goals /audit
//
// 设计文档：CLI-Layer-Design.md §4；§5 字段过滤；§6 G1/G2/G5。
// =============================================================================

import type { ParsedCommand } from './parse-args.js';
import { flagString, flagNumber, flagBool } from './parse-args.js';
import type { WritingRequestContext } from '../writing/services/context.js';
import { renderErrorForAuthor } from '../writing/errors/error-codes.js';
import { buildProjectHomeView } from '../writing/view-models/project-home.js';
import { buildWorldSnapshotView } from '../writing/view-models/world-snapshot.js';
import type { WorldSnapshot } from '../writing/core-bridge/core-bridge-service.js';
import {
  projectStatusLabel, workspaceModeLabel, draftStatusLabel, decisionKindLabel,
} from '../writing/view-models/labels.js';
import type {
  AuditResult, EntitySketchStatus, DraftStatus, IdeaMaturity, ProjectStatus,
} from '../writing/models/types.js';

// ---------------------------------------------------------------------------
// ANSI 颜色常量（对齐 chat.ts 现有风格）
// ---------------------------------------------------------------------------
const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  boldYellow: '\x1b[1;33m',
  boldCyan: '\x1b[1;36m',
  boldGreen: '\x1b[1;32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  gray: '\x1b[90m',
  cyan: '\x1b[36m',
};

/**
 * 掩码文本行内嵌的 Core 对象 ID 前缀（§5 防御）。
 *
 * 与 filter.ts 的区别：filter.ts 的值匹配是前缀锚定（/^ent_/），适合对象属性值；
 * 但 Core 的 get_context_slice 渲染 profileMarkdown 时会把 ent_xxx 嵌进句子
 * （如 "## 沈墨（ent_沈墨）档案"），这种嵌套泄漏 filter.ts 检测不到。
 * 本函数做全文全局替换（不限位置），专供 CLI 渲染 Core 产出的人话文本时兜底。
 * normal 模式启用，debug 模式原样返回（让作者排障时看到真实 id）。
 *
 * 正则说明：字符类 `[A-Za-z0-9_\u4e00-\u9fff]+` 含中文（\u4e00-\u9fff CJK 基本块），
 * 因为 Core 实体 id 可能含中文后缀（如 ent_沈墨）——JS 的 \w 不含中文，旧正则会
 * 只掩前缀留下后缀。
 */
function maskCoreIdsInText(text: string, visibilityMode: 'normal' | 'debug'): string {
  if (visibilityMode === 'debug') return text;
  // 全局替换行内任意位置的 ent_/fct_/evt_/thd_/kno_/req_ 标识（含中文后缀）
  return text.replace(/\b(?:ent_|fct_|evt_|thd_|kno_|req_)[A-Za-z0-9_\u4e00-\u9fff]+/g, '***');
}

/**
 * 把 SQLite 存储的 UTC 时间字符串（'2026-06-19 05:48:56'）转为本地时间显示。
 *
 * SQLite 的 datetime('now') 存 UTC，直接显示对作者不友好（差 8 小时）。
 * 解析为 Date 后用本地时区格式化（YYYY-MM-DD HH:MM）。解析失败原样返回。
 */
function formatLocalTime(utcString: string): string {
  try {
    // SQLite 格式 'YYYY-MM-DD HH:MM:SS'（无时区后缀，按 UTC 解析）
    const iso = utcString.includes('T') ? utcString : utcString.replace(' ', 'T') + 'Z';
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return utcString;
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    const h = String(date.getHours()).padStart(2, '0');
    const min = String(date.getMinutes()).padStart(2, '0');
    return `${y}-${m}-${d} ${h}:${min}`;
  } catch {
    return utcString;
  }
}

/**
 * CLI 处理器依赖注入容器。
 *
 * chat.ts 构造真实 services 注入；测试构造 mock 或 :memory: 真实栈注入。
 * 这让 handlers 可测（不依赖模块级单例闭包）。
 */
export interface CliDeps {
  projectId: string;
  /** 上下文工厂——CLI 走 author_action trigger，visibilityMode 由 --raw/--debug 切换 */
  ctx: (visibilityMode?: 'normal' | 'debug') => WritingRequestContext;
  // services
  projectService: {
    getProject(ctx: WritingRequestContext): { title: string; premise?: string; status: string; workspaceMode: string; id: string } | undefined;
    getProjectHomeView(ctx: WritingRequestContext): unknown;
    updateProjectMeta(ctx: WritingRequestContext, patch: { title?: string; premise?: string }): unknown;
    setWorkspaceMode(ctx: WritingRequestContext, mode: string): void;
    transitionProjectStatus(ctx: WritingRequestContext, target: ProjectStatus): unknown;
    listAuthorGoals(ctx: WritingRequestContext, status?: string): unknown[];
    updateAuthorGoal(ctx: WritingRequestContext, params: { goalId?: string; text: string; kind: string; priority?: string }): unknown;
  };
  draftService: {
    listDrafts(ctx: WritingRequestContext, filter?: { status?: DraftStatus; kind?: string }): unknown[];
    createDraft(ctx: WritingRequestContext, params: { kind: string; chapter: number; title: string; content: string }): unknown;
    abandonDraft(ctx: WritingRequestContext, draftId: string): unknown;
  };
  entityService: {
    listCandidateQueue(ctx: WritingRequestContext): unknown[];
    findRegisteredEntities(ctx: WritingRequestContext, namePattern?: string): Array<{ displayName: string; coreEntityId?: string }>;
    promoteHintToSketch(ctx: WritingRequestContext, hintId: string, params: { displayName: string; typeLabel: string }): unknown;
    approveCandidate(ctx: WritingRequestContext, sketchId: string): unknown;
    deprecateEntitySketch(ctx: WritingRequestContext, sketchId: string, reason?: string): unknown;
  };
  ideaService: {
    listIdeaCards(ctx: WritingRequestContext, filter?: { maturity?: IdeaMaturity; kind?: string }): unknown[];
    captureIdea(ctx: WritingRequestContext, params: { content: string; kind: string; tags?: string[] }): unknown;
    discardIdea(ctx: WritingRequestContext, ideaId: string): unknown;
  };
  blueprintService: {
    getActiveBlueprint(ctx: WritingRequestContext): unknown;
    generateBlueprintDraft(ctx: WritingRequestContext, params: { naturalLanguageDescription: string }): unknown;
    acceptBlueprintDraft(ctx: WritingRequestContext, blueprintId: string): unknown;
    acceptBlueprintChange(ctx: WritingRequestContext, suggestionId: string): unknown;
    rejectBlueprintChange(ctx: WritingRequestContext, suggestionId: string, reason?: string): unknown;
    addSpatialNodeType(ctx: WritingRequestContext, params: { id: string; label: string; description?: string }): unknown;
    addSpatialEdgeType(ctx: WritingRequestContext, params: { id: string; label: string; description?: string }): unknown;
  };
  workflowService: {
    listPendingDecisions(ctx: WritingRequestContext): unknown[];
  };
  auditService: {
    list(ctx: WritingRequestContext, filter?: {
      limit?: number; result?: AuditResult; action?: string; targetType?: string; targetId?: string;
    }): unknown[];
  };
  coreBridge: {
    readCurrentWorldSnapshot(projectId: string, options?: { currentChapter?: number }): Promise<WorldSnapshot>;
  };
  writingStore: {
    listEntitySketches(projectId: string, filter?: { status?: EntitySketchStatus; typeLabel?: string }): unknown[];
    listGoals(projectId: string, status?: string): unknown[];
    listAuditLogs(projectId: string, filter?: {
      limit?: number; result?: AuditResult; action?: string; targetType?: string; targetId?: string;
    }): unknown[];
    getLatestBlueprint(projectId: string): unknown;
  };
}

/** 处理器返回类型：输出行数组 */
export type HandlerResult = string[];

// ---------------------------------------------------------------------------
// /world —— 世界概览（异步，Core 投影）
// ---------------------------------------------------------------------------

export async function handleWorld(deps: CliDeps, cmd: ParsedCommand): Promise<HandlerResult> {
  const isRaw = flagBool(cmd.flags, 'raw') || flagBool(cmd.flags, 'debug');
  const visibilityMode = isRaw ? 'debug' : 'normal';
  const ctx = deps.ctx(visibilityMode);
  const lines: string[] = [];

  try {
    const snapshot = await deps.coreBridge.readCurrentWorldSnapshot(deps.projectId);
    const vm = buildWorldSnapshotView(snapshot, visibilityMode);

    lines.push(`${C.boldYellow}🌐 世界概览（第 ${vm.currentChapter} 章）${C.reset}`);
    lines.push(`  已注册实体：${vm.entityCount} 个`);
    if (vm.entities.length === 0) {
      lines.push(`  ${C.gray}暂无已注册实体。用自然语言描述角色，或 /entities 查看候选。${C.reset}`);
    } else {
      for (const e of vm.entities) {
        const attrCount = e.attributeCount ?? 0;
        lines.push(`    ${C.bold}${e.name}${C.reset} [${e.typeLabel}] — ${attrCount} 个属性`);
        if (e.error) lines.push(`      ${C.gray}${e.error}${C.reset}`);
      }
    }

    // 最近提交事件（从审计日志取 result=success 的 commit_proposal）
    const recentCommits = deps.writingStore.listAuditLogs(deps.projectId, {
      action: 'commit_proposal', result: 'success', limit: 5,
    }) as Array<{ createdAt: string; detail?: { coreEventId?: string }; targetId?: string }>;
    if (recentCommits.length > 0) {
      lines.push(`\n  ${C.boldCyan}📜 最近提交事件${C.reset}`);
      for (const c of recentCommits) {
        // 事件 ID（evt_xxx）不掩码——作者需要引用它追溯事件（与内部 ent_/fct_ 不同）。
        // 时间转本地显示（SQLite 存 UTC）。
        const eventId = c.detail?.coreEventId ?? c.targetId ?? '—';
        lines.push(`    ${C.gray}${formatLocalTime(c.createdAt)}${C.reset}  ${eventId}`);
      }
    }

    if (isRaw && vm._debug) {
      lines.push(`\n  ${C.yellow}⚠️ 调试模式（技术字段）${C.reset}`);
      for (const p of vm._debug.profilesByEntity ?? []) {
        lines.push(`    ${C.gray}${p.coreEntityId}: ${p.profileMarkdown?.slice(0, 80) ?? ''}...${C.reset}`);
      }
    }
  } catch (err) {
    lines.push(`${C.red}❌ ${renderErrorForAuthor(err)}${C.reset}`);
  }
  return lines;
}

// ---------------------------------------------------------------------------
// /entity <name> —— 单实体档案（异步）
// ---------------------------------------------------------------------------

export async function handleEntity(deps: CliDeps, cmd: ParsedCommand): Promise<HandlerResult> {
  const isRaw = flagBool(cmd.flags, 'raw') || flagBool(cmd.flags, 'debug');
  const visibilityMode = isRaw ? 'debug' : 'normal';
  const ctx = deps.ctx(visibilityMode);
  const name = cmd.positional[0];
  const lines: string[] = [];

  if (!name) {
    lines.push(`${C.yellow}用法：/entity <名称>  （例：/entity 沈墨）${C.reset}`);
    lines.push(`  ${C.gray}子命令：/entity promote <id> | /entity approve <id>${C.reset}`);
    return lines;
  }

  // ---- 子命令：promote / approve / deprecate（实体审核通道手动操作）----
  if (name === 'promote' || name === 'approve') {
    return handleEntitySubcommand(deps, name, cmd.positional.slice(1));
  }
  if (name === 'deprecate') {
    // 去掉子命令名，让 handleEntityDeprecate 的 positional[0] 是实体 id
    return handleEntityDeprecate(deps, { ...cmd, positional: cmd.positional.slice(1) });
  }

  try {
    // 找已注册实体（按名称匹配）
    const matches = deps.entityService.findRegisteredEntities(ctx, name);
    if (matches.length === 0) {
      lines.push(`${C.red}❌ 未找到实体『${name}』。用 /entities 查看已注册实体列表。${C.reset}`);
      return lines;
    }
    const sketch = matches[0]!;

    // 从世界快照取该实体的档案（readCurrentWorldSnapshot 聚合了 profileMarkdown）
    const snapshot = await deps.coreBridge.readCurrentWorldSnapshot(deps.projectId);
    const entitySnap = snapshot.entities.find(
      (e) => e.coreEntityId === sketch.coreEntityId,
    );

    lines.push(`${C.boldYellow}👤 ${sketch.displayName}${C.reset}`);
    if (entitySnap) {
      if (entitySnap.profileMarkdown && entitySnap.profileMarkdown.length > 0) {
        // 逐行渲染 profileMarkdown（保留缩进）——经 maskCoreIdsInText 掩码行内 Core id（§5）
        // Core 的 get_context_slice 会把 ent_xxx 嵌进标题（如"## 沈墨（ent_沈墨）档案"），
        // normal 模式必须掩码，debug 模式（--raw）原样显示。
        // 掩码后清理残留的（***）/（*** · ...）括号——显示纯标题不残留技术占位。
        for (const ln of entitySnap.profileMarkdown.split('\n')) {
          const masked = maskCoreIdsInText(ln, visibilityMode);
          const cleaned = masked.replace(/\s*[（(]\*\*\*[^)）]*[)）]/g, ''); // 去掉（***...）
          lines.push(`  ${cleaned}`);
        }
      } else {
        lines.push(`  ${C.gray}（暂无属性档案——该实体尚未写入任何 Fact）${C.reset}`);
      }
      if (entitySnap.error) {
        lines.push(`  ${C.gray}读取异常：${entitySnap.error}${C.reset}`);
      }
    } else {
      // entitySnap 为 undefined：注册成功但 readCurrentWorldSnapshot 未返回该实体
      // （可能 Core 端刚注册、快照聚合遗漏，或 coreEntityId 回写不一致）
      lines.push(`  ${C.gray}（该实体已注册，但当前世界快照未包含其档案——可稍后重试 /entity）${C.reset}`);
    }

    if (isRaw && entitySnap) {
      lines.push(`\n  ${C.yellow}⚠️ 调试模式${C.reset}`);
      lines.push(`    ${C.gray}coreEntityId: ${sketch.coreEntityId}${C.reset}`);
      const facts = entitySnap.factIndex ?? [];
      lines.push(`    ${C.gray}factIds: ${facts.map((f) => f.factId).join(', ') || '(无)'}${C.reset}`);
    }
  } catch (err) {
    lines.push(`${C.red}❌ ${renderErrorForAuthor(err)}${C.reset}`);
  }
  return lines;
}

/** /entity promote|approve <id> 子命令——实体审核通道手动操作 */
function handleEntitySubcommand(deps: CliDeps, sub: string, args: string[]): HandlerResult {
  const ctx = deps.ctx();
  const id = args[0];
  const lines: string[] = [];

  if (!id) {
    lines.push(`${C.yellow}用法：/entity ${sub} <id>${C.reset}`);
    lines.push(`  ${C.gray}id 从 /entities 列表获取（hint/candidate 状态的实体）${C.reset}`);
    return lines;
  }

  try {
    // 查实体草图拿 displayName/typeLabel（promote 需要）
    const sketches = deps.writingStore.listEntitySketches(deps.projectId) as Array<{
      id: string; displayName: string; typeLabel: string; status: string;
    }>;
    const sketch = sketches.find(s => s.id === id);
    if (!sketch) {
      lines.push(`${C.red}❌ 找不到实体：${id}${C.reset}`);
      lines.push(`  ${C.gray}用 /entities 查看所有实体及其 id${C.reset}`);
      return lines;
    }

    if (sub === 'promote') {
      if (sketch.status !== 'hint') {
        lines.push(`${C.yellow}该实体状态为 ${sketch.status}，无需 promote（仅 hint 状态可提升）${C.reset}`);
        return lines;
      }
      deps.entityService.promoteHintToSketch(ctx, id, {
        displayName: sketch.displayName, typeLabel: sketch.typeLabel,
      });
      lines.push(`${C.green}✅ ${sketch.displayName} 已提升为候选（candidate）${C.reset}`);
      lines.push(`  ${C.gray}用 /entity approve ${id} 批准后注册到 Core${C.reset}`);
    } else if (sub === 'approve') {
      if (sketch.status === 'hint') {
        // 自动先 promote 再 approve（便捷：一步到位）
        deps.entityService.promoteHintToSketch(ctx, id, {
          displayName: sketch.displayName, typeLabel: sketch.typeLabel,
        });
      } else if (sketch.status !== 'candidate') {
        lines.push(`${C.yellow}该实体状态为 ${sketch.status}，仅 candidate 可 approve${C.reset}`);
        return lines;
      }
      deps.entityService.approveCandidate(ctx, id);
      lines.push(`${C.green}✅ ${sketch.displayName} 已批准，等待确认注册${C.reset}`);
      lines.push(`  ${C.gray}说"确认"或 /pending 查看待确认事项${C.reset}`);
    }
  } catch (err) {
    lines.push(`${C.red}❌ ${renderErrorForAuthor(err)}${C.reset}`);
  }
  return lines;
}

// ---------------------------------------------------------------------------
// /drafts —— 草案列表
// ---------------------------------------------------------------------------

export function handleDrafts(deps: CliDeps, cmd: ParsedCommand): HandlerResult {
  const isRaw = flagBool(cmd.flags, 'raw');
  const ctx = deps.ctx(isRaw ? 'debug' : 'normal');
  const status = flagString(cmd.flags, 'status') as DraftStatus | undefined;
  const kind = flagString(cmd.flags, 'kind');
  const limit = flagNumber(cmd.flags, 'limit') ?? 20;
  const skip = flagNumber(cmd.flags, 'skip') ?? 0;
  const lines: string[] = [];

  const drafts = (deps.draftService.listDrafts(ctx, { status, kind }) as Array<{
    id: string; title?: string; summary?: string; kind: string; chapter: number;
    status: string; updatedAt: string; linkedProposalViewId?: string;
  }>).slice(skip, skip + limit);

  lines.push(`${C.boldYellow}📝 草案（${drafts.length} 条${status ? ` · ${status}` : ''}）${C.reset}`);
  if (drafts.length === 0) {
    lines.push(`  ${C.gray}暂无草案。可用自然语言描述一个事件，Agent 会帮你起草。${C.reset}`);
    return lines;
  }
  for (const d of drafts) {
    const title = d.title ?? d.summary ?? '(无标题)';
    const proposalHint = d.linkedProposalViewId
      ? ` ${C.cyan}→ 有待审提案，/review ${d.linkedProposalViewId}${C.reset}`
      : '';
    lines.push(`  [${draftStatusLabel(d.status)}] ${C.bold}${title}${C.reset}（第${d.chapter}章 · ${d.kind}）${proposalHint}`);
    lines.push(`    ${C.gray}id: ${d.id}${C.reset}`);
  }
  return lines;
}

// ---------------------------------------------------------------------------
// /entities —— 实体草图列表
// ---------------------------------------------------------------------------

export function handleEntities(deps: CliDeps, cmd: ParsedCommand): HandlerResult {
  const isRaw = flagBool(cmd.flags, 'raw');
  const ctx = deps.ctx(isRaw ? 'debug' : 'normal');
  const status = flagString(cmd.flags, 'status') as EntitySketchStatus | undefined;
  const limit = flagNumber(cmd.flags, 'limit') ?? 20;
  const lines: string[] = [];

  const sketches = (deps.writingStore.listEntitySketches(deps.projectId, status ? { status } : undefined) as Array<{
    id: string; displayName: string; typeLabel: string; summary?: string;
    status: string; aliases: string[]; tags: string[]; coreEntityId?: string; coreKind?: string;
  }>).slice(0, limit);

  // 分组计数
  const byStatus = new Map<string, number>();
  for (const s of sketches) byStatus.set(s.status, (byStatus.get(s.status) ?? 0) + 1);
  const counts = [...byStatus.entries()].map(([k, v]) => `${k} ${v}`).join(' / ');

  lines.push(`${C.boldYellow}👥 实体库（${sketches.length} 个 · ${counts}）${C.reset}`);
  if (sketches.length === 0) {
    lines.push(`  ${C.gray}暂无实体。用自然语言介绍角色/地点，或写入正文后会自动检测实体线索。${C.reset}`);
    return lines;
  }
  // 按 typeLabel 分组
  const byType = new Map<string, typeof sketches>();
  for (const s of sketches) {
    const arr = byType.get(s.typeLabel) ?? [];
    arr.push(s);
    byType.set(s.typeLabel, arr);
  }
  const typeIcon = (t: string): string =>
    t.includes('角色') ? '👤' : t.includes('地点') ? '🗺️' : t.includes('物品') ? '💎' : '📌';
  for (const [typeLabel, group] of byType) {
    lines.push(`  ${typeIcon(typeLabel)} ${typeLabel}`);
    for (const s of group) {
      const summary = s.summary ? ` — ${s.summary.slice(0, 40)}` : '';
      const aliases = s.aliases.length > 0 ? ` ${C.gray}(别名: ${s.aliases.join(', ')})${C.reset}` : '';
      lines.push(`    [${s.status}] ${C.bold}${s.displayName}${C.reset}${summary}${aliases}`);
      // hint/candidate 显示 id + 操作提示（供 /entity promote|approve 用）
      if (s.status === 'hint' || s.status === 'candidate') {
        const action = s.status === 'hint' ? 'promote' : 'approve';
        lines.push(`      ${C.gray}id: ${s.id}${C.reset} ${C.cyan}→ /entity ${action} ${s.id}${C.reset}`);
      } else if (s.status === 'registered') {
        // registered 也显示 id（作者需要它来 /entity deprecate）
        lines.push(`      ${C.gray}id: ${s.id}${C.reset}`);
      } else if (isRaw) {
        lines.push(`      ${C.gray}id: ${s.id} | coreEntityId: ${s.coreEntityId ?? '(未注册)'} | coreKind: ${s.coreKind ?? '—'}${C.reset}`);
      }
    }
  }
  return lines;
}

// ---------------------------------------------------------------------------
// /ideas —— 灵感卡列表
// ---------------------------------------------------------------------------

export function handleIdeas(deps: CliDeps, cmd: ParsedCommand): HandlerResult {
  const isRaw = flagBool(cmd.flags, 'raw');
  const ctx = deps.ctx(isRaw ? 'debug' : 'normal');
  const kind = flagString(cmd.flags, 'kind');
  const maturity = flagString(cmd.flags, 'status') as IdeaMaturity | undefined;
  const limit = flagNumber(cmd.flags, 'limit') ?? 20;
  const lines: string[] = [];

  // 默认隐藏 archived（归档灵感），--all 才显示全部
  const showAll = flagBool(cmd.flags, 'all');
  const ideas = (deps.ideaService.listIdeaCards(ctx, { kind, maturity }) as Array<{
    id: string; content: string; summary?: string; kind: string; maturity: string;
    tags: string[]; linkedDraftIds: string[];
  }>).filter(i => showAll || i.maturity !== 'archived').slice(0, limit);

  lines.push(`${C.boldYellow}💡 灵感卡（${ideas.length} 条${kind ? ` · ${kind}` : ''}）${C.reset}`);
  if (ideas.length === 0) {
    lines.push(`  ${C.gray}暂无灵感。直接说出你的想法，比如"我想让主角有个隐藏能力"。${C.reset}`);
    return lines;
  }
  for (const i of ideas) {
    const text = (i.summary ?? i.content).slice(0, 60);
    const tags = i.tags.length > 0 ? ` ${C.gray}[${i.tags.join(',')}]${C.reset}` : '';
    const drafts = i.linkedDraftIds.length > 0 ? ` ${C.cyan}→ ${i.linkedDraftIds.length} 草案${C.reset}` : '';
    lines.push(`  [${i.maturity}] ${C.bold}${text}${C.reset}（${i.kind}）${tags}${drafts}`);
    lines.push(`    ${C.gray}id: ${i.id}${C.reset}`);
  }
  return lines;
}

// ---------------------------------------------------------------------------
// /blueprint —— 当前蓝图查看
// ---------------------------------------------------------------------------

export function handleBlueprint(deps: CliDeps, cmd: ParsedCommand): HandlerResult {
  const isRaw = flagBool(cmd.flags, 'raw');
  const ctx = deps.ctx(isRaw ? 'debug' : 'normal');
  const lines: string[] = [];

  // 用 getLatestBlueprint（含 implicit 种子）而非 getActiveBlueprint（只 active/evolving）。
  // 这样新项目的 implicit 蓝图也可见——作者知道项目已有潜在结构种子。
  const bp = deps.writingStore.getLatestBlueprint(deps.projectId) as {
    maturity: string; entityTypes: Array<{ label: string; description?: string; aliases: string[]; status?: string }>;
    changeSuggestions: Array<{ id: string; naturalLanguageSummary: string; confidence: number; status: string; kind?: string }>;
    relationTypes?: Array<{ label: string }>;
  } | undefined;

  if (!bp) {
    lines.push(`  ${C.gray}暂无蓝图。用 /blueprint generate <世界观描述> 生成蓝图草案。${C.reset}`);
    return lines;
  }

  lines.push(`${C.boldYellow}🗺️ 当前蓝图 [${bp.maturity}]${C.reset}`);
  lines.push(`  实体类型：${bp.entityTypes.length} 个 | 关系类型：${bp.relationTypes?.length ?? 0} 个`);
  if (bp.entityTypes.length > 0) {
    lines.push(`\n  ${C.boldCyan}实体类型${C.reset}`);
    for (const t of bp.entityTypes) {
      const aliases = t.aliases.length > 0 ? ` ${C.gray}(别名: ${t.aliases.join(', ')})${C.reset}` : '';
      lines.push(`    ${C.bold}${t.label}${C.reset}${aliases}${t.status ? ` [${t.status}]` : ''}`);
      if (t.description) lines.push(`      ${C.gray}${t.description.slice(0, 60)}${C.reset}`);
    }
  }
  const pending = bp.changeSuggestions.filter((s) => s.status === 'suggested');
  if (pending.length > 0) {
    lines.push(`\n  ${C.boldCyan}待确认建议（${pending.length}）${C.reset}`);
    for (const s of pending) {
      const conf = ` ${C.gray}${Math.round(s.confidence * 100)}%${C.reset}`;
      lines.push(`    ${C.bold}${s.naturalLanguageSummary}${C.reset}${conf}`);
    }
  }
  return lines;
}

// ---------------------------------------------------------------------------
// /project —— 查看与 set
// ---------------------------------------------------------------------------

export function handleProject(deps: CliDeps, cmd: ParsedCommand): HandlerResult {
  const isRaw = flagBool(cmd.flags, 'raw');
  const ctx = deps.ctx(isRaw ? 'debug' : 'normal');
  const sub = cmd.positional[0]; // 'set' 或 undefined
  const lines: string[] = [];

  if (sub === 'set') {
    return handleProjectSet(deps, ctx, cmd.positional.slice(1));
  }

  // 查看
  const project = deps.projectService.getProject(ctx) as
    | { title: string; premise?: string; status: string; workspaceMode: string; id: string }
    | undefined;
  if (!project) {
    lines.push(`  ${C.red}❌ 找不到项目${C.reset}`);
    return lines;
  }
  lines.push(`${C.boldYellow}📂 项目${C.reset}`);
  lines.push(`  标题：   ${C.bold}${project.title}${C.reset}`);
  lines.push(`  前提：   ${project.premise ?? '(未设定)'}`);
  lines.push(`  状态：   ${projectStatusLabel(project.status)}`);
  lines.push(`  模式：   ${workspaceModeLabel(project.workspaceMode)}`);
  lines.push(`\n  ${C.gray}可用 set：title | premise | status | workspace-mode${C.reset}`);
  lines.push(`  ${C.gray}例：/project set title 新标题${C.reset}`);
  return lines;
}

function handleProjectSet(
  deps: CliDeps, ctx: WritingRequestContext, args: string[],
): HandlerResult {
  const field = args[0];
  const value = args.slice(1).join(' ');
  const lines: string[] = [];

  if (!field || !value) {
    lines.push(`${C.yellow}用法：/project set <field> <value>${C.reset}`);
    lines.push(`  ${C.gray}field: title | premise | status | workspace-mode${C.reset}`);
    lines.push(`  ${C.gray}（activeBlueprintId / currentDraftId 由蓝图激活与写作流程自动维护，不可手动 set）${C.reset}`);
    return lines;
  }

  try {
    if (field === 'title' || field === 'premise') {
      deps.projectService.updateProjectMeta(ctx, { [field]: value });
      lines.push(`${C.green}✅ 已更新 ${field}：${value}${C.reset}`);
    } else if (field === 'status') {
      deps.projectService.transitionProjectStatus(ctx, value as ProjectStatus);
      lines.push(`${C.green}✅ 项目状态 → ${projectStatusLabel(value)}${C.reset}`);
    } else if (field === 'workspace-mode') {
      deps.projectService.setWorkspaceMode(ctx, value);
      lines.push(`${C.green}✅ 工作模式 → ${workspaceModeLabel(value)}${C.reset}`);
    } else {
      lines.push(`${C.red}❌ 未知字段：${field}。可用：title | premise | status | workspace-mode${C.reset}`);
    }
  } catch (err) {
    lines.push(`${C.red}❌ ${renderErrorForAuthor(err)}${C.reset}`);
  }
  return lines;
}

// ---------------------------------------------------------------------------
// /goals —— 作者目标
// ---------------------------------------------------------------------------

export function handleGoals(deps: CliDeps, cmd: ParsedCommand): HandlerResult {
  const isRaw = flagBool(cmd.flags, 'raw');
  const ctx = deps.ctx(isRaw ? 'debug' : 'normal');
  const status = flagString(cmd.flags, 'status');
  const limit = flagNumber(cmd.flags, 'limit') ?? 20;
  const lines: string[] = [];

  const goals = ((status
    ? deps.projectService.listAuthorGoals(ctx, status)
    : deps.projectService.listAuthorGoals(ctx)) as Array<{
    id: string; text: string; kind: string; priority: string; scope: string; status: string;
  }>).slice(0, limit);

  lines.push(`${C.boldYellow}🎯 作者目标（${goals.length} 条${status ? ` · ${status}` : ''}）${C.reset}`);
  if (goals.length === 0) {
    lines.push(`  ${C.gray}暂无目标。告诉 Agent 你的写作意图，比如"我想写一个关于救赎的故事"。${C.reset}`);
    return lines;
  }
  // priority DESC
  const priorityOrder: Record<string, number> = { high: 0, normal: 1, low: 2 };
  goals.sort((a, b) => (priorityOrder[a.priority] ?? 9) - (priorityOrder[b.priority] ?? 9));
  for (const g of goals) {
    const icon = g.kind === 'avoid' ? '🚫' : g.kind === 'style' ? '🎨' : '🎯';
    lines.push(`  ${icon} [${g.priority}/${g.kind}] ${C.bold}${g.text}${C.reset}`);
    lines.push(`    ${C.gray}id: ${g.id}${C.reset}`);
  }
  return lines;
}

// ---------------------------------------------------------------------------
// /pending —— 待确认事项
// ---------------------------------------------------------------------------

export function handlePending(deps: CliDeps, cmd: ParsedCommand): HandlerResult {
  const ctx = deps.ctx();
  const lines: string[] = [];

  const decisions = deps.workflowService.listPendingDecisions(ctx) as Array<{
    id: string; kind: string; title: string; description?: string;
    linkedObjectId?: string; createdAt: string;
  }>;

  lines.push(`${C.boldYellow}⏳ 待确认事项（${decisions.length} 项）${C.reset}`);
  if (decisions.length === 0) {
    lines.push(`  ${C.gray}暂无待确认事项。用自然语言推进剧情，Agent 会产出待审提案。${C.reset}`);
    return lines;
  }
  for (const d of decisions) {
    lines.push(`  ${C.bold}${decisionKindLabel(d.kind)}${C.reset} ${d.title}`);
    if (d.description) lines.push(`    ${C.gray}${d.description}${C.reset}`);
    if (d.linkedObjectId) {
      lines.push(`    ${C.cyan}→ /review ${d.linkedObjectId}${C.reset}`);
    }
  }
  return lines;
}

// ---------------------------------------------------------------------------
// /audit —— 审计日志
// ---------------------------------------------------------------------------

export function handleAudit(deps: CliDeps, cmd: ParsedCommand): HandlerResult {
  const ctx = deps.ctx();
  const limit = flagNumber(cmd.flags, 'limit') ?? 30;
  const result = flagString(cmd.flags, 'result') as AuditResult | undefined;
  const action = flagString(cmd.flags, 'action');
  const target = flagString(cmd.flags, 'target');
  const lines: string[] = [];

  const logs = deps.auditService.list(ctx, {
    limit, result, action, targetId: target,
  }) as Array<{
    createdAt: string; action: string; triggerSource?: string; result: string;
    targetType?: string; targetId?: string; errorCode?: string;
  }>;

  lines.push(`${C.boldYellow}📜 审计日志（${logs.length} 条${result ? ` · ${result}` : ''}）${C.reset}`);
  if (logs.length === 0) {
    lines.push(`  ${C.gray}暂无审计记录。${C.reset}`);
    return lines;
  }
  for (const l of logs) {
    const resultColor = l.result === 'success' ? C.green : l.result === 'failure' ? C.red : C.yellow;
    const resultIcon = l.result === 'success' ? '✅' : l.result === 'failure' ? '❌' : '⚠️';
    const targetStr = l.targetType ? ` → ${l.targetType}/${l.targetId ?? ''}` : '';
    lines.push(`  ${C.gray}${formatLocalTime(l.createdAt)}${C.reset} ${resultIcon} ${C.bold}${l.action}${C.reset}${targetStr} ${resultColor}[${l.result}]${C.reset}`);
    if (l.errorCode) lines.push(`      ${C.red}errorCode: ${l.errorCode}${C.reset}`);
  }
  return lines;
}

// =============================================================================
// 子命令：创建/操作入口（/idea add, /goal add, /draft add, /draft abandon,
//   /entity deprecate, /blueprint generate, /blueprint accept/reject）
// =============================================================================
// 这些 handler 补齐了"有 service 无 CLI 入口"的缺口，让作者能直接驱动写作层对象。
// =============================================================================

/** /idea add <内容> [--kind K] [--tag T] — 捕获灵感 */
export function handleIdeaAdd(deps: CliDeps, cmd: ParsedCommand): HandlerResult {
  const ctx = deps.ctx();
  const content = cmd.positional.join(' ');
  const kind = flagString(cmd.flags, 'kind') ?? 'premise';
  const tag = flagString(cmd.flags, 'tag');
  const lines: string[] = [];

  if (!content || content.trim().length === 0) {
    lines.push(`${C.yellow}用法：/idea add <灵感内容> [--kind premise|character|location|...] [--tag 标签]${C.reset}`);
    return lines;
  }

  try {
    const idea = deps.ideaService.captureIdea(ctx, {
      content: content.trim(),
      kind,
      tags: tag ? [tag] : [],
    }) as { id: string; maturity: string };
    lines.push(`${C.green}✅ 灵感已捕获：${content.slice(0, 40)}...${C.reset}`);
    lines.push(`  ${C.gray}id: ${idea.id} | 成熟度: ${idea.maturity} | 用 /ideas 查看${C.reset}`);
  } catch (err) {
    lines.push(`${C.red}❌ ${renderErrorForAuthor(err)}${C.reset}`);
  }
  return lines;
}

/** /idea discard <id> — 归档灵感 */
export function handleIdeaDiscard(deps: CliDeps, cmd: ParsedCommand): HandlerResult {
  const ctx = deps.ctx();
  const id = cmd.positional[0];
  const lines: string[] = [];
  if (!id) {
    lines.push(`${C.yellow}用法：/idea discard <id>${C.reset}`);
    return lines;
  }
  try {
    deps.ideaService.discardIdea(ctx, id);
    lines.push(`${C.green}✅ 灵感 ${id} 已归档${C.reset}`);
  } catch (err) {
    lines.push(`${C.red}❌ ${renderErrorForAuthor(err)}${C.reset}`);
  }
  return lines;
}

/** /goal add <内容> [--kind goal|avoid|style] [--priority high|normal|low] — 添加写作目标 */
export function handleGoalAdd(deps: CliDeps, cmd: ParsedCommand): HandlerResult {
  const ctx = deps.ctx();
  const text = cmd.positional.join(' ');
  const kind = flagString(cmd.flags, 'kind') ?? 'goal';
  const priority = flagString(cmd.flags, 'priority') ?? 'normal';
  const lines: string[] = [];

  if (!text || text.trim().length === 0) {
    lines.push(`${C.yellow}用法：/goal add <目标内容> [--kind goal|avoid|style|reader_experience] [--priority high|normal|low]${C.reset}`);
    return lines;
  }

  try {
    deps.projectService.updateAuthorGoal(ctx, {
      text: text.trim(),
      kind,
      priority,
    });
    lines.push(`${C.green}✅ 目标已添加：${text.slice(0, 40)}...${C.reset}`);
  } catch (err) {
    lines.push(`${C.red}❌ ${renderErrorForAuthor(err)}${C.reset}`);
  }
  return lines;
}

/** /draft add <标题> [--kind event|scene] [--chapter N] — 创建草案（content 从 stdin 或后续输入） */
export function handleDraftAdd(deps: CliDeps, cmd: ParsedCommand): HandlerResult {
  const ctx = deps.ctx();
  const title = cmd.positional[0];
  const kind = flagString(cmd.flags, 'kind') ?? 'event';
  const chapter = flagNumber(cmd.flags, 'chapter') ?? 1;
  const lines: string[] = [];

  if (!title) {
    lines.push(`${C.yellow}用法：/draft add <标题> [--kind event|scene|chapter] [--chapter N]${C.reset}`);
    lines.push(`  ${C.gray}创建后用自然语言或 Agent 填充内容${C.reset}`);
    return lines;
  }

  try {
    const draft = deps.draftService.createDraft(ctx, {
      kind, chapter, title, content: '',
    }) as { id: string; status: string };
    lines.push(`${C.green}✅ 草案已创建：${title}${C.reset}`);
    lines.push(`  ${C.gray}id: ${draft.id} | 状态: ${draft.status}${C.reset}`);
    lines.push(`  ${C.gray}用自然语言描述内容让 Agent 填充，或 /drafts 查看${C.reset}`);
  } catch (err) {
    lines.push(`${C.red}❌ ${renderErrorForAuthor(err)}${C.reset}`);
  }
  return lines;
}

/** /draft abandon <id> — 废弃草案 */
export function handleDraftAbandon(deps: CliDeps, cmd: ParsedCommand): HandlerResult {
  const ctx = deps.ctx();
  const id = cmd.positional[0];
  const lines: string[] = [];
  if (!id) {
    lines.push(`${C.yellow}用法：/draft abandon <id>${C.reset}`);
    return lines;
  }
  try {
    deps.draftService.abandonDraft(ctx, id);
    lines.push(`${C.green}✅ 草案 ${id} 已废弃${C.reset}`);
  } catch (err) {
    lines.push(`${C.red}❌ ${renderErrorForAuthor(err)}${C.reset}`);
  }
  return lines;
}

/** /entity deprecate <id> [--reason R] — 废弃实体 */
export function handleEntityDeprecate(deps: CliDeps, cmd: ParsedCommand): HandlerResult {
  const ctx = deps.ctx();
  const id = cmd.positional[0];
  const reason = flagString(cmd.flags, 'reason');
  const lines: string[] = [];
  if (!id) {
    lines.push(`${C.yellow}用法：/entity deprecate <id> [--reason 废弃原因]${C.reset}`);
    return lines;
  }
  try {
    deps.entityService.deprecateEntitySketch(ctx, id, reason);
    lines.push(`${C.green}✅ 实体 ${id} 已废弃${C.reset}`);
  } catch (err) {
    lines.push(`${C.red}❌ ${renderErrorForAuthor(err)}${C.reset}`);
  }
  return lines;
}

/** /blueprint generate <描述> — 根据世界观描述生成蓝图草案 */
export function handleBlueprintGenerate(deps: CliDeps, cmd: ParsedCommand): HandlerResult {
  const ctx = deps.ctx();
  const description = cmd.positional.join(' ');
  const lines: string[] = [];
  if (!description || description.trim().length === 0) {
    lines.push(`${C.yellow}用法：/blueprint generate <世界观描述>${C.reset}`);
    return lines;
  }
  try {
    const bp = deps.blueprintService.generateBlueprintDraft(ctx, {
      naturalLanguageDescription: description.trim(),
    }) as { id: string; maturity: string };
    lines.push(`${C.green}✅ 蓝图草案已生成${C.reset}`);
    lines.push(`  ${C.gray}id: ${bp.id} | 成熟度: ${bp.maturity}${C.reset}`);
    lines.push(`  ${C.gray}用 /blueprint accept <id> 激活，或 /blueprint 查看${C.reset}`);
  } catch (err) {
    lines.push(`${C.red}❌ ${renderErrorForAuthor(err)}${C.reset}`);
  }
  return lines;
}

/** /blueprint accept <id> — 激活蓝图草案 */
export function handleBlueprintAccept(deps: CliDeps, cmd: ParsedCommand): HandlerResult {
  const ctx = deps.ctx();
  const id = cmd.positional[0];
  const lines: string[] = [];
  if (!id) {
    lines.push(`${C.yellow}用法：/blueprint accept <蓝图id>  （激活蓝图草案）${C.reset}`);
    lines.push(`  ${C.gray}或：/blueprint accept-suggestion <建议id>  （接受蓝图变更建议）${C.reset}`);
    return lines;
  }
  try {
    deps.blueprintService.acceptBlueprintDraft(ctx, id);
    lines.push(`${C.green}✅ 蓝图 ${id} 已激活${C.reset}`);
  } catch (err) {
    lines.push(`${C.red}❌ ${renderErrorForAuthor(err)}${C.reset}`);
  }
  return lines;
}

/** /blueprint accept-suggestion <id> — 接受蓝图变更建议 */
export function handleBlueprintAcceptSuggestion(deps: CliDeps, cmd: ParsedCommand): HandlerResult {
  const ctx = deps.ctx();
  const id = cmd.positional[0];
  const lines: string[] = [];
  if (!id) {
    lines.push(`${C.yellow}用法：/blueprint accept-suggestion <建议id>${C.reset}`);
    return lines;
  }
  try {
    deps.blueprintService.acceptBlueprintChange(ctx, id);
    lines.push(`${C.green}✅ 变更建议 ${id} 已接受${C.reset}`);
  } catch (err) {
    lines.push(`${C.red}❌ ${renderErrorForAuthor(err)}${C.reset}`);
  }
  return lines;
}

/** /blueprint reject-suggestion <id> [--reason R] — 拒绝蓝图变更建议 */
export function handleBlueprintRejectSuggestion(deps: CliDeps, cmd: ParsedCommand): HandlerResult {
  const ctx = deps.ctx();
  const id = cmd.positional[0];
  const reason = flagString(cmd.flags, 'reason');
  const lines: string[] = [];
  if (!id) {
    lines.push(`${C.yellow}用法：/blueprint reject-suggestion <建议id> [--reason 拒绝原因]${C.reset}`);
    return lines;
  }
  try {
    deps.blueprintService.rejectBlueprintChange(ctx, id, reason);
    lines.push(`${C.green}✅ 变更建议 ${id} 已拒绝${C.reset}`);
  } catch (err) {
    lines.push(`${C.red}❌ ${renderErrorForAuthor(err)}${C.reset}`);
  }
  return lines;
}

// =============================================================================
// Phase 8：/graph /relation /association 命令
// =============================================================================

/** /graph — 图谱概览或导出 */
export async function handleGraph(deps: CliDeps, cmd: ParsedCommand): Promise<HandlerResult> {
  const ctx = deps.ctx();
  const lines: string[] = [];
  const sub = cmd.positional[0];
  const graphService = (deps as unknown as { graphService?: { buildGraphView: (ctx: unknown, mode: string) => Promise<{ nodes: unknown[]; edges: unknown[] }>; exportGraph: (ctx: unknown, format: string) => Promise<string> } }).graphService;

  if (sub === 'export') {
    const format = (cmd.positional[1] as string) ?? 'json';
    if (!graphService) { lines.push(`${C.red}❌ GraphService 未注入${C.reset}`); return lines; }
    try {
      const data = await graphService.exportGraph(ctx, format);
      lines.push(`${C.green}✅ 图谱已导出（${format}，${data.length} 字符）${C.reset}`);
    } catch (err) { lines.push(`${C.red}❌ ${renderErrorForAuthor(err)}${C.reset}`); }
    return lines;
  }

  if (!graphService) { lines.push(`${C.red}❌ GraphService 未注入${C.reset}`); return lines; }
  try {
    const graph = await graphService.buildGraphView(ctx, 'world');
    lines.push(`${C.boldYellow}🌐 图谱概览${C.reset}`);
    lines.push(`  节点：${graph.nodes.length} 个 | 边：${graph.edges.length} 条`);
    const nl = new Map<string, number>(); const el = new Map<string, number>();
    for (const n of graph.nodes as Array<{ sourceLayer: string }>) nl.set(n.sourceLayer, (nl.get(n.sourceLayer) ?? 0) + 1);
    for (const e of graph.edges as Array<{ sourceLayer: string }>) el.set(e.sourceLayer, (el.get(e.sourceLayer) ?? 0) + 1);
    if (nl.size > 0) lines.push(`  节点来源：${[...nl].map(([k, v]) => `${k}=${v}`).join(' / ')}`);
    if (el.size > 0) lines.push(`  边来源：${[...el].map(([k, v]) => `${k}=${v}`).join(' / ')}`);
    lines.push(`\n  ${C.gray}子命令：/graph export json | /relation add/list/submit | /association add${C.reset}`);
  } catch (err) { lines.push(`${C.red}❌ ${renderErrorForAuthor(err)}${C.reset}`); }
  return lines;
}

/** /relation add|list|submit */
export async function handleRelation(deps: CliDeps, cmd: ParsedCommand): Promise<HandlerResult> {
  const ctx = deps.ctx();
  const sub = cmd.positional[0];
  const lines: string[] = [];
  const rs = (deps as unknown as { relationService?: { createRelationCandidate: (ctx: unknown, p: unknown) => { id: string; status: string }; listRelationCandidates: (ctx: unknown) => Array<{ id: string; status: string; layer: string; relationTypeId: string; sourceEntityId: string; targetEntityId: string }>; submitRelationCandidate: (ctx: unknown, id: string) => Promise<unknown> } }).relationService;
  if (!rs) { lines.push(`${C.red}❌ RelationService 未注入${C.reset}`); return lines; }

  if (sub === 'add') {
    const [sourceId, targetId, typeId] = cmd.positional.slice(1);
    if (!sourceId || !targetId || !typeId) { lines.push(`${C.yellow}用法：/relation add <源实体id> <目标实体id> <关系类型id>${C.reset}`); return lines; }
    try {
      const c = rs.createRelationCandidate(ctx, { sourceEntityId: sourceId, targetEntityId: targetId, relationTypeId: typeId });
      lines.push(`${C.green}✅ 关系候选已创建${C.reset}`);
      lines.push(`  ${C.gray}id: ${c.id} | 状态: ${c.status}${C.reset}`);
    } catch (err) { lines.push(`${C.red}❌ ${renderErrorForAuthor(err)}${C.reset}`); }
    return lines;
  }

  if (sub === 'submit') {
    const id = cmd.positional[1];
    if (!id) { lines.push(`${C.yellow}用法：/relation submit <id>${C.reset}`); return lines; }
    try { await rs.submitRelationCandidate(ctx, id); lines.push(`${C.green}✅ ${id} 已提交${C.reset}`); }
    catch (err) { lines.push(`${C.red}❌ ${renderErrorForAuthor(err)}${C.reset}`); }
    return lines;
  }

  // 默认 list
  try {
    const candidates = rs.listRelationCandidates(ctx);
    lines.push(`${C.boldYellow}🔗 关系候选（${candidates.length} 条）${C.reset}`);
    if (candidates.length === 0) { lines.push(`  ${C.gray}暂无。用 /relation add 创建。${C.reset}`); return lines; }
    for (const c of candidates) {
      const icon = c.status === 'committed' ? '✅' : c.status === 'submitted' ? '📤' : '📝';
      lines.push(`  ${icon} [${c.status}/${c.layer}] ${c.relationTypeId}: ${c.sourceEntityId} → ${c.targetEntityId}`);
      lines.push(`    ${C.gray}id: ${c.id}${C.reset}`);
    }
  } catch (err) { lines.push(`${C.red}❌ ${renderErrorForAuthor(err)}${C.reset}`); }
  return lines;
}

/** /association add <sourceId> <targetId> <label> */
export function handleAssociation(deps: CliDeps, cmd: ParsedCommand): HandlerResult {
  const ctx = deps.ctx();
  const sub = cmd.positional[0];
  const lines: string[] = [];
  const rs = (deps as unknown as { relationService?: { createAssociation: (ctx: unknown, p: unknown) => { id: string }; listAssociations: (ctx: unknown) => Array<{ id: string; label: string; status: string }> } }).relationService;
  if (!rs) { lines.push(`${C.red}❌ RelationService 未注入${C.reset}`); return lines; }

  if (sub === 'add') {
    const [sourceId, targetId, ...labelParts] = cmd.positional.slice(1);
    const label = labelParts.join(' ');
    if (!sourceId || !targetId || !label) { lines.push(`${C.yellow}用法：/association add <源id> <目标id> <关联标签>${C.reset}`); return lines; }
    try {
      const a = rs.createAssociation(ctx, { sourceRef: { objectType: 'entity', objectId: sourceId }, targetRef: { objectType: 'entity', objectId: targetId }, label });
      lines.push(`${C.green}✅ 创作关联：${label}${C.reset}`);
      lines.push(`  ${C.gray}id: ${a.id}${C.reset}`);
    } catch (err) { lines.push(`${C.red}❌ ${renderErrorForAuthor(err)}${C.reset}`); }
    return lines;
  }

  // 默认 list
  try {
    const assocs = rs.listAssociations(ctx);
    lines.push(`${C.boldYellow}📎 创作关联（${assocs.length} 条）${C.reset}`);
    for (const a of assocs) { lines.push(`  [${a.status}] ${a.label} ${C.gray}(${a.id})${C.reset}`); }
  } catch (err) { lines.push(`${C.red}❌ ${renderErrorForAuthor(err)}${C.reset}`); }
  return lines;
}

// ===========================================================================
// Phase 9：/spatial + /map 命令
// ===========================================================================

/** /spatial add-node|add-edge|list|node */
export async function handleSpatial(deps: CliDeps, cmd: ParsedCommand): Promise<HandlerResult> {
  const ctx = deps.ctx();
  const sub = cmd.positional[0];
  const lines: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ss = (deps as any).spatialService as {
    createSpatialNode: (ctx: unknown, p: { label: string; typeId: string; description?: string }) => { id: string; label: string; maturity: string };
    createSpatialEdge: (ctx: unknown, p: { sourceNodeId: string; targetNodeId: string; typeId: string }) => { id: string; status: string };
    advanceSpatialNodeMaturity: (ctx: unknown, id: string, m: string) => unknown;
    confirmSpatialEdge: (ctx: unknown, id: string) => unknown;
    archiveSpatialEdge: (ctx: unknown, id: string) => void;
  } | undefined;

  if (!ss) { lines.push(`${C.red}❌ SpatialService 未注入${C.reset}`); return lines; }

  if (sub === 'add-node') {
    const [label, typeId] = cmd.positional.slice(1);
    if (!label || !typeId) { lines.push(`${C.yellow}用法：/spatial add-node <名称> <类型id> [描述]${C.reset}`); return lines; }
    const desc = cmd.positional[2];
    try {
      const node = ss.createSpatialNode(ctx, { label, typeId, description: desc });
      lines.push(`${C.green}✅ 空间节点已创建${C.reset}`);
      lines.push(`  ${C.gray}id: ${node.id} | label: ${node.label} | maturity: ${node.maturity}${C.reset}`);
    } catch (err) { lines.push(`${C.red}❌ ${renderErrorForAuthor(err)}${C.reset}`); }
    return lines;
  }

  if (sub === 'add-edge') {
    const [sourceId, targetId, typeId] = cmd.positional.slice(1);
    if (!sourceId || !targetId || !typeId) { lines.push(`${C.yellow}用法：/spatial add-edge <源节点id> <目标节点id> <类型id>${C.reset}`); return lines; }
    try {
      const edge = ss.createSpatialEdge(ctx, { sourceNodeId: sourceId, targetNodeId: targetId, typeId });
      lines.push(`${C.green}✅ 空间边已创建${C.reset}`);
      lines.push(`  ${C.gray}id: ${edge.id} | status: ${edge.status}${C.reset}`);
    } catch (err) { lines.push(`${C.red}❌ ${renderErrorForAuthor(err)}${C.reset}`); }
    return lines;
  }

  if (sub === 'confirm-edge') {
    const edgeId = cmd.positional[1];
    if (!edgeId) { lines.push(`${C.yellow}用法：/spatial confirm-edge <边id>${C.reset}`); return lines; }
    try { ss.confirmSpatialEdge(ctx, edgeId); lines.push(`${C.green}✅ 空间边已确认${C.reset}`); }
    catch (err) { lines.push(`${C.red}❌ ${renderErrorForAuthor(err)}${C.reset}`); }
    return lines;
  }

  // 默认 list
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const store = (deps as any).writingStore as { listSpatialNodes: (pid: string) => Array<{ id: string; label: string; typeId: string; maturity: string }>; listSpatialEdges: (pid: string) => Array<{ id: string; sourceNodeId: string; targetNodeId: string; typeId: string; status: string }> };
  if (!store) { lines.push(`${C.red}❌ WritingStore 未注入${C.reset}`); return lines; }
  const nodes = store.listSpatialNodes(deps.projectId);
  const edges = store.listSpatialEdges(deps.projectId);
  lines.push(`${C.boldYellow}🗺️ 空间视图（${nodes.length} 节点，${edges.length} 边）${C.reset}`);
  for (const n of nodes) {
    const m = n.maturity === 'registered' ? '✓' : n.maturity === 'confirmed' ? '●' : '○';
    lines.push(`  ${m} ${n.label} [${n.typeId}] ${C.gray}(${n.id})${C.reset}`);
  }
  if (edges.length > 0) {
    lines.push(`\n  ${C.gray}空间边：${edges.length} 条${C.reset}`);
    for (const e of edges) {
      const src = nodes.find(n => n.id === e.sourceNodeId)?.label ?? e.sourceNodeId;
      const tgt = nodes.find(n => n.id === e.targetNodeId)?.label ?? e.targetNodeId;
      lines.push(`  ${src} →[${e.typeId}]→ ${tgt} ${C.gray}(${e.status})${C.reset}`);
    }
  }
  lines.push(`\n  ${C.gray}子命令：/spatial add-node <名> <类型> | /spatial add-edge <源> <目标> <类型> | /spatial confirm-edge <id>${C.reset}`);
  return lines;
}

/** /map — 地图概览（调用 GraphService spatial 模式） */
export async function handleMap(deps: CliDeps, _cmd: ParsedCommand): Promise<HandlerResult> {
  const ctx = deps.ctx();
  const lines: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const graphService = (deps as any).graphService as {
    buildGraphView: (ctx: unknown, mode: string) => Promise<{ nodes: unknown[]; edges: unknown[] }>;
  } | undefined;

  if (!graphService) { lines.push(`${C.red}❌ GraphService 未注入${C.reset}`); return lines; }

  try {
    const graph = await graphService.buildGraphView(ctx, 'spatial');
    lines.push(`${C.boldYellow}🗺️ 地图视图${C.reset}`);
    lines.push(`  节点：${graph.nodes.length} 个 | 边：${graph.edges.length} 条`);

    if (graph.nodes.length === 0) {
      lines.push(`\n  ${C.gray}暂无空间节点。用 /spatial add-node 或 Agent 对话创建。${C.reset}`);
    } else {
      const byType = new Map<string, number>();
      for (const n of graph.nodes as Array<{ projectTypeLabel: string }>) {
        byType.set(n.projectTypeLabel, (byType.get(n.projectTypeLabel) ?? 0) + 1);
      }
      lines.push(`  类型：${[...byType].map(([k, v]) => `${k}=${v}`).join(' / ')}`);
    }

    lines.push(`\n  ${C.gray}提示：/spatial list 查看完整列表，/graph 切换到关系图${C.reset}`);
  } catch (err) { lines.push(`${C.red}❌ ${renderErrorForAuthor(err)}${C.reset}`); }
  return lines;
}

/** /blueprint add-spatial-type node|edge <id> <label> [描述] */
export function handleBlueprintAddSpatialType(deps: CliDeps, cmd: ParsedCommand): HandlerResult {
  const ctx = deps.ctx();
  const lines: string[] = [];
  const [kind, id, label] = cmd.positional;

  if (!kind || !id || !label) {
    lines.push(`${C.yellow}用法：/blueprint add-spatial-type node|edge <类型id> <人话标签> [描述]${C.reset}`);
    lines.push(`  ${C.gray}示例：/blueprint add-spatial-type node realm 修仙界域${C.reset}`);
    lines.push(`  ${C.gray}示例：/blueprint add-spatial-type edge contains 包含${C.reset}`);
    return lines;
  }

  const desc = cmd.positional[3];

  try {
    if (kind === 'node') {
      deps.blueprintService.addSpatialNodeType(ctx, { id, label, description: desc });
      lines.push(`${C.green}✅ 空间节点类型已添加到蓝图${C.reset}`);
      lines.push(`  ${C.gray}id: ${id} | label: ${label}${C.reset}`);
    } else if (kind === 'edge') {
      deps.blueprintService.addSpatialEdgeType(ctx, { id, label, description: desc });
      lines.push(`${C.green}✅ 空间边类型已添加到蓝图${C.reset}`);
      lines.push(`  ${C.gray}id: ${id} | label: ${label}${C.reset}`);
    } else {
      lines.push(`${C.yellow}kind 必须是 node 或 edge${C.reset}`);
    }
  } catch (err) { lines.push(`${C.red}❌ ${renderErrorForAuthor(err)}${C.reset}`); }
  return lines;
}

// ===========================================================================
// Phase 10：/chapter /scene /timeline 命令
// ===========================================================================

/** /chapter list|add */
export async function handleChapter(deps: CliDeps, cmd: ParsedCommand): Promise<HandlerResult> {
  const ctx = deps.ctx();
  const sub = cmd.positional[0];
  const lines: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cs = (deps as any).chapterService as {
    createChapter: (ctx: unknown, p: { order: number; title: string; goals?: string[] }) => { id: string; title: string; order: number; status: string };
  } | undefined;

  if (sub === 'add') {
    const title = cmd.positional[1];
    if (!title) { lines.push(`${C.yellow}用法：/chapter add <标题> [--order N]${C.reset}`); return lines; }
    if (!cs) { lines.push(`${C.red}❌ ChapterService 未注入${C.reset}`); return lines; }
    const order = Number(cmd.flags['order']) || 999;
    if (!cs) { lines.push(`${C.red}❌ ChapterService 未注入${C.reset}`); return lines; }
    try {
      const ch = cs.createChapter(ctx, { title, order });
      lines.push(`${C.green}✅ 章节规划已创建${C.reset}`);
      lines.push(`  ${C.gray}id: ${ch.id} | title: ${ch.title} | order: ${ch.order}${C.reset}`);
    } catch (err) { lines.push(`${C.red}❌ ${renderErrorForAuthor(err)}${C.reset}`); }
    return lines;
  }

  // 默认 list
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const store = (deps as any).writingStore as { listChapterPlans: (pid: string) => Array<{ id: string; title: string; order: number; status: string; linkedSceneIds: string[] }> };
  if (!store) { lines.push(`${C.red}❌ WritingStore 未注入${C.reset}`); return lines; }
  const chapters = store.listChapterPlans(deps.projectId);
  lines.push(`${C.boldYellow}📖 章节规划（${chapters.length} 章）${C.reset}`);
  for (const ch of chapters) {
    lines.push(`  [${ch.status}] Ch.${ch.order} ${ch.title} ${C.gray}(${ch.linkedSceneIds.length} 场景)${C.reset}`);
  }
  lines.push(`\n  ${C.gray}子命令：/chapter add <标题> [--order N]${C.reset}`);
  return lines;
}

/** /scene list|add */
export async function handleScene(deps: CliDeps, cmd: ParsedCommand): Promise<HandlerResult> {
  const ctx = deps.ctx();
  const sub = cmd.positional[0];
  const lines: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ss = (deps as any).sceneService as {
    createScene: (ctx: unknown, p: { chapterId: string; title: string; order: number }) => { id: string; title: string; chapterId: string; order: number; status: string };
  } | undefined;

  if (sub === 'add') {
    const [chapterId, title] = cmd.positional.slice(1);
    if (!chapterId || !title) { lines.push(`${C.yellow}用法：/scene add <章节id> <标题> [--order N]${C.reset}`); return lines; }
    if (!ss) { lines.push(`${C.red}❌ SceneService 未注入${C.reset}`); return lines; }
    const order = Number(cmd.flags['order']) || 999;
    try {
      const sc = ss.createScene(ctx, { chapterId, title, order });
      lines.push(`${C.green}✅ 场景规划已创建${C.reset}`);
      lines.push(`  ${C.gray}id: ${sc.id} | title: ${sc.title} | chapter: ${sc.chapterId} | order: ${sc.order}${C.reset}`);
    } catch (err) { lines.push(`${C.red}❌ ${renderErrorForAuthor(err)}${C.reset}`); }
    return lines;
  }

  // 默认 list
  const chapterFilter = cmd.flags['chapter'] as string | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const store = (deps as any).writingStore as { listScenePlans: (pid: string, opts?: { chapterId?: string }) => Array<{ id: string; title: string; chapterId: string; order: number; status: string; purpose: string[] }> };
  if (!store) { lines.push(`${C.red}❌ WritingStore 未注入${C.reset}`); return lines; }
  const scenes = store.listScenePlans(deps.projectId, chapterFilter ? { chapterId: chapterFilter } : undefined);
  lines.push(`${C.boldYellow}🎬 场景规划（${scenes.length} 场景）${C.reset}`);
  for (const sc of scenes) {
    const purpose = sc.purpose.length > 0 ? ` [${sc.purpose.join(',')}]` : '';
    lines.push(`  [${sc.status}] ${sc.title}${purpose} ${C.gray}(${sc.id})${C.reset}`);
  }
  lines.push(`\n  ${C.gray}子命令：/scene add <章节id> <标题> [--order N] | /scene list --chapter <id>${C.reset}`);
  return lines;
}

/** /timeline — 时间线视图 */
export async function handleTimeline(deps: CliDeps, _cmd: ParsedCommand): Promise<HandlerResult> {
  const ctx = deps.ctx();
  const lines: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ts = (deps as any).timelineService as {
    buildTimelineView: (ctx: unknown, mode: string) => { items: Array<{ id: string; label: string; sourceLayer: string; worldTime?: { chapter: number }; statusLabel: string }> };
  } | undefined;

  if (!ts) { lines.push(`${C.red}❌ TimelineService 未注入${C.reset}`); return lines; }

  try {
    const timeline = ts.buildTimelineView(ctx, 'world');
    lines.push(`${C.boldYellow}⏳ 时间线${C.reset}`);
    lines.push(`  条目：${timeline.items.length} 个`);

    if (timeline.items.length === 0) {
      lines.push(`\n  ${C.gray}暂无时间线条目。用 /chapter add 和 /scene add 创建规划。${C.reset}`);
    } else {
      const byLayer = new Map<string, typeof timeline.items>();
      for (const item of timeline.items) {
        const list = byLayer.get(item.sourceLayer) ?? [];
        list.push(item);
        byLayer.set(item.sourceLayer, list);
      }
      for (const [layer, items] of byLayer) {
        const label = layer === 'committed' ? '已提交' : layer === 'planned' ? '计划' : layer;
        lines.push(`\n  ${C.boldCyan}${label}（${items.length}）${C.reset}`);
        for (const item of items) {
          const ch = item.worldTime?.chapter ? ` Ch.${item.worldTime.chapter}` : '';
          lines.push(`    ${item.label}${ch} ${C.gray}(${item.statusLabel})${C.reset}`);
        }
      }
    }
  } catch (err) { lines.push(`${C.red}❌ ${renderErrorForAuthor(err)}${C.reset}`); }
  return lines;
}

// =============================================================================
// Phase 11 CLI 命令（/reader /foreshadow /reveal）
// 此前 Phase 11 三模块仅 Agent 可调，作者无 CLI 入口。补齐只读浏览 + 状态推进。
// =============================================================================

/** /reader [list|<受众id>] —— 读者群体与认知状态 */
export async function handleReader(deps: CliDeps, cmd: ParsedCommand): Promise<HandlerResult> {
  const ctx = deps.ctx();
  const lines: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rs = (deps as any).readerService as {
    listAudiences: (ctx: unknown) => Array<{ id: string; label: string; kind: string; enabled: boolean; notes?: string }>;
    listKnowledgeStates: (audienceId: string) => Array<{ id: string; subjectRef: string; state: string; confidence: number; narrativePositionRef: { type: string; id: string } }>;
  } | undefined;

  if (!rs) { lines.push(`${C.red}❌ ReaderService 未注入${C.reset}`); return lines; }

  const target = cmd.positional[0];
  if (target && target !== 'list') {
    // 查看指定受众的认知状态
    try {
      const states = rs.listKnowledgeStates(target);
      lines.push(`${C.boldYellow}👥 读者认知（受众 ${target}，${states.length} 条）${C.reset}`);
      if (states.length === 0) {
        lines.push(`\n  ${C.gray}该受众暂无认知记录。${C.reset}`);
      }
      for (const s of states) {
        const pos = `${s.narrativePositionRef.type}:${s.narrativePositionRef.id}`;
        lines.push(`  [${s.state}] ${s.subjectRef} ${C.gray}@ ${pos} conf=${s.confidence.toFixed(2)}${C.reset}`);
      }
    } catch (err) { lines.push(`${C.red}❌ ${renderErrorForAuthor(err)}${C.reset}`); }
    return lines;
  }

  // 默认 list：受众清单
  try {
    const audiences = rs.listAudiences(ctx);
    lines.push(`${C.boldYellow}👥 读者群体（${audiences.length} 个）${C.reset}`);
    if (audiences.length === 0) {
      lines.push(`\n  ${C.gray}暂无读者群体。Agent 创建认知状态时会自动建立默认目标读者。${C.reset}`);
    }
    for (const a of audiences) {
      const note = a.notes ? ` ${C.gray}${a.notes}${C.reset}` : '';
      lines.push(`  [${a.kind}] ${a.label} ${C.gray}(${a.id})${C.reset}${note}`);
    }
    lines.push(`\n  ${C.gray}查看某受众详情：/reader <受众id>${C.reset}`);
  } catch (err) { lines.push(`${C.red}❌ ${renderErrorForAuthor(err)}${C.reset}`); }
  return lines;
}

/** /foreshadow [list|<计划id>] [advance <id>] —— 伏笔计划 */
export async function handleForeshadow(deps: CliDeps, cmd: ParsedCommand): Promise<HandlerResult> {
  const ctx = deps.ctx();
  const lines: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fs = (deps as any).foreshadowingService as {
    listForeshadowingPlans: (ctx: unknown) => Array<{ id: string; label: string; kind: string; status: string; targetReaderEffect: string; linkedEntityRefs: string[] }>;
  } | undefined;

  if (!fs) { lines.push(`${C.red}❌ ForeshadowingService 未注入${C.reset}`); return lines; }

  try {
    const plans = fs.listForeshadowingPlans(ctx);
    lines.push(`${C.boldYellow}🎭 伏笔计划（${plans.length} 个）${C.reset}`);
    if (plans.length === 0) {
      lines.push(`\n  ${C.gray}暂无伏笔计划。可通过对话让 Agent 创建，或用 /reveal 建立揭示计划。${C.reset}`);
    }
    for (const p of plans) {
      const ents = p.linkedEntityRefs.length > 0 ? ` ${C.gray}关联 ${p.linkedEntityRefs.length} 实体${C.reset}` : '';
      lines.push(`  [${p.status}] ${p.label} ${C.gray}(${p.kind})${C.reset}${ents}`);
      lines.push(`    ${C.gray}目标效果：${p.targetReaderEffect}${C.reset}`);
    }
  } catch (err) { lines.push(`${C.red}❌ ${renderErrorForAuthor(err)}${C.reset}`); }
  return lines;
}

/** /reveal [list|<计划id>] —— 揭示计划 */
export async function handleReveal(deps: CliDeps, _cmd: ParsedCommand): Promise<HandlerResult> {
  const ctx = deps.ctx();
  const lines: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fs = (deps as any).foreshadowingService as {
    listRevealPlans: (ctx: unknown) => Array<{ id: string; label: string; subjectDescription: string; status: string; targetReaderEffect?: string; linkedThreadId?: string }>;
  } | undefined;

  if (!fs) { lines.push(`${C.red}❌ ForeshadowingService 未注入${C.reset}`); return lines; }

  try {
    const reveals = fs.listRevealPlans(ctx);
    lines.push(`${C.boldYellow}💡 揭示计划（${reveals.length} 个）${C.reset}`);
    if (reveals.length === 0) {
      lines.push(`\n  ${C.gray}暂无揭示计划。可通过对话让 Agent 建立揭示计划，规划信息释放节奏。${C.reset}`);
    }
    for (const r of reveals) {
      const thread = r.linkedThreadId ? ` ${C.gray}→ thread ${r.linkedThreadId}${C.reset}` : '';
      lines.push(`  [${r.status}] ${r.label}${thread}`);
      lines.push(`    ${C.gray}揭示内容：${r.subjectDescription}${C.reset}`);
      if (r.targetReaderEffect) {
        lines.push(`    ${C.gray}目标反应：${r.targetReaderEffect}${C.reset}`);
      }
    }
  } catch (err) { lines.push(`${C.red}❌ ${renderErrorForAuthor(err)}${C.reset}`); }
  return lines;
}

// =============================================================================
// Phase 12 CLI 命令（/prose /style /revision /retcon /import /export）
// 正文草稿、风格系统、修订、Retcon视图、导入导出的只读浏览 + 基础写入入口。
// =============================================================================

/** /prose [list|new <标题>|<文档id>] [add <文档id> <文本>] —— 正文文档 */
export async function handleProse(deps: CliDeps, cmd: ParsedCommand): Promise<HandlerResult> {
  const ctx = deps.ctx();
  const lines: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ps = (deps as any).proseService as {
    listDocuments: (ctx: unknown) => Array<{ id: string; title: string; version: number; updatedAt: string }>;
    createDocument: (ctx: unknown, input: { title: string }) => { id: string; title: string };
    getDocumentWithBlocks: (ctx: unknown, id: string) => { document: { id: string; title: string; version: number }; blocks: Array<{ id: string; kind: string; orderIndex: number; text: string }> };
    addBlock: (ctx: unknown, input: { documentId: string; kind: string; text: string }) => { id: string };
  } | undefined;

  if (!ps) { lines.push(`${C.red}❌ ProseService 未注入${C.reset}`); return lines; }
  const sub = cmd.positional[0];

  try {
    if (sub === 'new') {
      const title = cmd.positional[1];
      if (!title) { lines.push(`${C.yellow}用法：/prose new <标题>${C.reset}`); return lines; }
      const doc = ps.createDocument(ctx, { title });
      lines.push(`${C.green}✅ 正文文档已创建${C.reset}`);
      lines.push(`  ${C.gray}id: ${doc.id} | title: ${doc.title}${C.reset}`);
      return lines;
    }
    if (sub === 'add') {
      const docId = cmd.positional[1];
      const text = cmd.positional.slice(2).join(' ');
      if (!docId || !text) { lines.push(`${C.yellow}用法：/prose add <文档id> <段落文本>${C.reset}`); return lines; }
      const block = ps.addBlock(ctx, { documentId: docId, kind: 'paragraph', text });
      lines.push(`${C.green}✅ 已追加段落${C.reset} ${C.gray}(${block.id})${C.reset}`);
      return lines;
    }
    if (sub && sub !== 'list') {
      // 查看指定文档的块
      const { document, blocks } = ps.getDocumentWithBlocks(ctx, sub);
      lines.push(`${C.boldYellow}📝 ${document.title}${C.reset} ${C.gray}(v${document.version}, ${blocks.length} 块)${C.reset}`);
      for (const b of blocks) {
        const kindTag = b.kind === 'chapter_title' ? '## ' : b.kind === 'scene_heading' ? '### ' : b.kind === 'separator' ? '---' : '';
        lines.push(`  ${C.gray}[${b.orderIndex}]${C.reset} ${kindTag}${b.text}`);
      }
      return lines;
    }
    // 默认 list
    const docs = ps.listDocuments(ctx);
    lines.push(`${C.boldYellow}📝 正文文档（${docs.length} 篇）${C.reset}`);
    if (docs.length === 0) {
      lines.push(`\n  ${C.gray}暂无正文文档。/prose new <标题> 创建，或 /import 导入已有正文。${C.reset}`);
    }
    for (const d of docs) {
      lines.push(`  ${d.title} ${C.gray}(v${d.version}, ${d.id})${C.reset}`);
    }
    lines.push(`\n  ${C.gray}子命令：/prose new <标题> | /prose add <id> <文本> | /prose <id> 查看${C.reset}`);
  } catch (err) { lines.push(`${C.red}❌ ${renderErrorForAuthor(err)}${C.reset}`); }
  return lines;
}

/** /style [list|update <字段> <值>|add-example <k> <文本>|add-banned <模式>] —— 风格指南 */
export async function handleStyle(deps: CliDeps, cmd: ParsedCommand): Promise<HandlerResult> {
  const ctx = deps.ctx();
  const lines: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ss = (deps as any).styleService as {
    getOrCreateDefaultGuide: (ctx: unknown) => { id: string; name: string; narrativePerson: string; narrativeDistance: string; pacingPreference: string; descriptionPreference: string[]; status: string };
    listExamples: (ctx: unknown) => Array<{ id: string; kind: string; text: string; note?: string }>;
    listBannedExpressions: (ctx: unknown) => Array<{ id: string; pattern: string; category?: string; reason?: string }>;
  } | undefined;

  if (!ss) { lines.push(`${C.red}❌ StyleService 未注入${C.reset}`); return lines; }

  try {
    const guide = ss.getOrCreateDefaultGuide(ctx);
    lines.push(`${C.boldYellow}🎨 风格指南：${guide.name}${C.reset} ${C.gray}[${guide.status}]${C.reset}`);
    lines.push(`  人称：${guide.narrativePerson} | 距离：${guide.narrativeDistance} | 节奏：${guide.pacingPreference}`);
    lines.push(`  描写偏好：${guide.descriptionPreference.length > 0 ? guide.descriptionPreference.join(', ') : '未设'}`);

    const examples = ss.listExamples(ctx);
    lines.push(`\n  ${C.boldCyan}示例（${examples.length}）${C.reset}`);
    for (const ex of examples) {
      const tag = ex.kind === 'positive' ? '✓' : '✗';
      lines.push(`  ${tag} ${ex.text.slice(0, 40)}${ex.text.length > 40 ? '…' : ''} ${ex.note ? C.gray + ex.note + C.reset : ''}`);
    }

    const banned = ss.listBannedExpressions(ctx);
    lines.push(`\n  ${C.boldCyan}禁用表达（${banned.length}）${C.reset}`);
    for (const b of banned) {
      lines.push(`  ✗ ${b.pattern} ${C.gray}${b.category ?? ''}${C.reset}`);
    }
    lines.push(`\n  ${C.gray}通过对话让 Agent 配置风格详情，或 /style add-example <positive|negative> <文本>${C.reset}`);
  } catch (err) { lines.push(`${C.red}❌ ${renderErrorForAuthor(err)}${C.reset}`); }
  return lines;
}

/** /revision <targetType> <targetId> —— 查看对象修订历史 */
export async function handleRevision(deps: CliDeps, cmd: ParsedCommand): Promise<HandlerResult> {
  const ctx = deps.ctx();
  const lines: string[] = [];
  const [targetType, targetId] = cmd.positional;
  if (!targetType || !targetId) {
    lines.push(`${C.yellow}用法：/revision <目标类型> <目标id>${C.reset}`);
    lines.push(`  ${C.gray}类型：draft | prose_document | entity_sketch | chapter_plan | scene_plan | foreshadowing_plan${C.reset}`);
    return lines;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rs = (deps as any).revisionService as {
    listRevisionsByTarget: (ctx: unknown, tt: string, tid: string) => Array<{ id: string; action: string; summary: string; operator: string; createdAt: string }>;
  } | undefined;

  if (!rs) { lines.push(`${C.red}❌ RevisionService 未注入${C.reset}`); return lines; }

  try {
    const records = rs.listRevisionsByTarget(ctx, targetType, targetId);
    lines.push(`${C.boldYellow}📜 修订历史（${targetType}:${targetId}，${records.length} 条）${C.reset}`);
    if (records.length === 0) {
      lines.push(`\n  ${C.gray}暂无修订记录。修改写作层对象时会自动留痕。${C.reset}`);
    }
    for (const r of records) {
      lines.push(`  [${r.action}] ${r.summary} ${C.gray}(${r.operator}, ${r.createdAt.slice(0, 19)})${C.reset}`);
    }
  } catch (err) { lines.push(`${C.red}❌ ${renderErrorForAuthor(err)}${C.reset}`); }
  return lines;
}

/** /retcon [list|<报告id>] —— Retcon 影响报告 */
export async function handleRetcon(deps: CliDeps, cmd: ParsedCommand): Promise<HandlerResult> {
  const ctx = deps.ctx();
  const lines: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rv = (deps as any).retconViewService as {
    listReports: (ctx: unknown) => Array<{ id: string; retconProposalId: string; status: string; summary: string; affectedNodes: unknown[]; recheckList: unknown[]; createdAt: string }>;
    getReport: (ctx: unknown, id: string) => { id: string; retconProposalId: string; status: string; summary: string; affectedNodes: Array<{ kind: string; id: string; effect: string; reason?: string }>; recheckList: Array<{ label: string; reason: string }>; createdAt: string };
  } | undefined;

  if (!rv) { lines.push(`${C.red}❌ RetconViewService 未注入${C.reset}`); return lines; }
  const target = cmd.positional[0];

  try {
    if (target && target !== 'list') {
      const report = rv.getReport(ctx, target);
      lines.push(`${C.boldYellow}🔍 Retcon 影响报告${C.reset} ${C.gray}[${report.status}]${C.reset}`);
      lines.push(`  ${C.gray}proposal: ${report.retconProposalId}${C.reset}`);
      lines.push(`\n  ${report.summary}`);
      lines.push(`\n  ${C.boldCyan}受影响节点（${report.affectedNodes.length}）${C.reset}`);
      for (const n of report.affectedNodes) {
        lines.push(`  [${n.effect}] ${n.kind}:${n.id} ${n.reason ? C.gray + n.reason + C.reset : ''}`);
      }
      lines.push(`\n  ${C.boldCyan}写作层重检项（${report.recheckList.length}）${C.reset}`);
      for (const r of report.recheckList) {
        lines.push(`  ⚠ ${r.label} ${C.gray}${r.reason}${C.reset}`);
      }
      return lines;
    }
    // 默认 list
    const reports = rv.listReports(ctx);
    lines.push(`${C.boldYellow}🔍 Retcon 影响报告（${reports.length} 个）${C.reset}`);
    if (reports.length === 0) {
      lines.push(`\n  ${C.gray}暂无报告。Agent 调 propose_retcon 后会自动生成影响报告。${C.reset}`);
    }
    for (const r of reports) {
      lines.push(`  [${r.status}] ${r.retconProposalId} ${C.gray}(${r.affectedNodes.length} 节点, ${r.recheckList.length} 重检)${C.reset}`);
    }
    lines.push(`\n  ${C.gray}查看详情：/retcon <报告id>${C.reset}`);
  } catch (err) { lines.push(`${C.red}❌ ${renderErrorForAuthor(err)}${C.reset}`); }
  return lines;
}

/** /import <文件路径> [type] —— 导入正文（从文件读取） */
export async function handleImport(deps: CliDeps, cmd: ParsedCommand): Promise<HandlerResult> {
  const ctx = deps.ctx();
  const lines: string[] = [];
  const filepath = cmd.positional[0];
  if (!filepath) {
    lines.push(`${C.yellow}用法：/import <文件路径> [prose|draft|setting_collection|mixed]${C.reset}`);
    lines.push(`  ${C.gray}导入已有正文/设定，转换为写作层文档。不写 Core。${C.reset}`);
    return lines;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ies = (deps as any).importExportService as {
    importText: (ctx: unknown, input: { sourceFilename?: string; importType: string; content: string }) => { batch: { id: string; status: string }; documentId: string; blockCount: number };
    listImportBatches: (ctx: unknown) => Array<{ id: string; sourceFilename?: string; importType: string; status: string; createdAt: string }>;
  } | undefined;

  if (!ies) { lines.push(`${C.red}❌ ImportExportService 未注入${C.reset}`); return lines; }

  // 子命令 list
  if (filepath === 'list') {
    const batches = ies.listImportBatches(ctx);
    lines.push(`${C.boldYellow}📥 导入批次（${batches.length} 个）${C.reset}`);
    for (const b of batches) {
      lines.push(`  [${b.status}] ${b.sourceFilename ?? '(粘贴)'} ${C.gray}(${b.importType}, ${b.createdAt.slice(0, 19)})${C.reset}`);
    }
    return lines;
  }

  try {
    // 从文件读取（Node fs）
    const fs = await import('node:fs');
    const content = fs.readFileSync(filepath, 'utf-8');
    const importType = cmd.positional[1] ?? 'mixed';
    const result = ies.importText(ctx, { sourceFilename: filepath, importType, content });
    lines.push(`${C.green}✅ 导入成功${C.reset}`);
    lines.push(`  ${C.gray}批次: ${result.batch.id} | 文档: ${result.documentId} | ${result.blockCount} 块${C.reset}`);
  } catch (err) { lines.push(`${C.red}❌ ${renderErrorForAuthor(err)}${C.reset}`); }
  return lines;
}

/** /export [scope] [文件路径] —— 导出项目数据为 JSON */
export async function handleExport(deps: CliDeps, cmd: ParsedCommand): Promise<HandlerResult> {
  const ctx = deps.ctx();
  const lines: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ies = (deps as any).importExportService as {
    exportProject: (ctx: unknown, scope: string) => { projectId: string; exportedAt: string; scope: string; data: Record<string, unknown> };
  } | undefined;

  if (!ies) { lines.push(`${C.red}❌ ImportExportService 未注入${C.reset}`); return lines; }

  try {
    const scope = cmd.positional[0] ?? 'all';
    const outPath = cmd.positional[1];
    const result = ies.exportProject(ctx, scope);
    const json = JSON.stringify(result, null, 2);
    const scopes = Object.keys(result.data);
    const sizeKb = (Buffer.byteLength(json, 'utf-8') / 1024).toFixed(1);

    if (outPath) {
      const fs = await import('node:fs');
      fs.writeFileSync(outPath, json, 'utf-8');
      lines.push(`${C.green}✅ 已导出到 ${outPath}${C.reset} ${C.gray}(${sizeKb} KB)${C.reset}`);
    } else {
      lines.push(`${C.green}✅ 导出完成${C.reset} ${C.gray}(${sizeKb} KB, scope=${scope})${C.reset}`);
      lines.push(`  ${C.gray}范围：${scopes.join(', ')}${C.reset}`);
      lines.push(`\n  ${C.gray}保存到文件：/export ${scope} <文件路径>${C.reset}`);
      lines.push(`  ${C.gray}可用范围：all | blueprint | entities | relations | spatial | chapters | scenes | reader | foreshadowing | prose | style${C.reset}`);
    }
  } catch (err) { lines.push(`${C.red}❌ ${renderErrorForAuthor(err)}${C.reset}`); }
  return lines;
}

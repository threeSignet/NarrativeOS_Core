// =============================================================================
// ProjectHomeViewModel——作品首页投影（§9.2）
// =============================================================================
// 设计文档：Phase7-Refinement.md §9.2。
//
// 首页 ViewModel 是作者打开作品后看到的第一屏：项目标题/状态/工作区模式 +
// 近期草案 + 待审决策 + 候选实体数。按 §9.1/§9.2，normal 模式只含人话字段，
// 绝不暴露 id / 枚举原始值 / Core 引用；debug 模式额外附带 _debug 技术诊断块。
//
// buildProjectHomeView 是 ViewModel 投影的范本——后续 ProposalReview /
// EntityProfile / DraftEditor 视图遵循同样的「标签化 + 可见性分流 + 防御性断言」三段式。
// =============================================================================

import type { WritingRequestContext } from '../services/context.js';
import type { WritingProject, WritingDraft, PendingDecisionItem } from '../models/types.js';
import {
  projectStatusLabel,
  workspaceModeLabel,
  draftStatusLabel,
  decisionKindLabel,
} from './labels.js';
import { assertNoForbiddenFields } from './filter.js';

// 标签映射对外再导出一次——ViewModel 模块的统一入口（供 CLI/WebUI 直接取用）
export { projectStatusLabel, workspaceModeLabel, draftStatusLabel, decisionKindLabel };

/** 近期草案项——人话字段（无 id） */
export interface ProjectHomeDraftItem {
  title: string;
  statusLabel: string;
  updatedAt: string;
}

/** 待审决策项——人话字段（无 id） */
export interface ProjectHomeDecisionItem {
  title: string;
  kindLabel: string;
}

/** debug 模式诊断块——技术字段仅在此出现（§9.2 可见性分流） */
export interface ProjectHomeDebugBlock {
  projectId: string;
  projectStatus: string;
  workspaceMode: string;
  draftIds: string[];
  pendingDecisionIds: string[];
}

/** 作品首页 ViewModel（§9.2） */
export interface ProjectHomeViewModel {
  projectTitle: string;
  projectStatusLabel: string;
  workspaceModeLabel: string;
  recentDrafts: ProjectHomeDraftItem[];
  pendingDecisions: ProjectHomeDecisionItem[];
  candidateEntityCount: number;
  /** 仅 debug 模式存在——含 id 与原始枚举，供排查 */
  _debug?: ProjectHomeDebugBlock;
}

/** 投影输入——来自 ProjectService 的原始领域对象 */
export interface ProjectHomeInput {
  project: WritingProject;
  recentDrafts: WritingDraft[];
  pendingDecisions: PendingDecisionItem[];
  candidateEntityCount: number;
}

/**
 * 构建作品首页 ViewModel（§9.2）
 *
 * @param ctx   请求上下文——visibilityMode 决定是否附带 _debug 块
 * @param input 原始领域对象（含技术字段，投影后过滤）
 * @returns     人话化的首页 ViewModel；debug 模式额外带 _debug
 */
export function buildProjectHomeView(
  ctx: WritingRequestContext,
  input: ProjectHomeInput,
): ProjectHomeViewModel {
  const { project, recentDrafts, pendingDecisions, candidateEntityCount } = input;

  // 主体：人话字段（标签化）——绝不直接透传原始枚举或 id
  const vm: ProjectHomeViewModel = {
    projectTitle: project.title,
    projectStatusLabel: projectStatusLabel(project.status),
    workspaceModeLabel: workspaceModeLabel(project.workspaceMode),
    recentDrafts: recentDrafts.map((d) => ({
      // 草案标题优先取 title，其次 summary，都没有则占位
      title: d.title ?? d.summary ?? '(无标题)',
      statusLabel: draftStatusLabel(d.status),
      updatedAt: d.updatedAt,
    })),
    pendingDecisions: pendingDecisions.map((dec) => ({
      title: dec.title,
      kindLabel: decisionKindLabel(dec.kind),
    })),
    candidateEntityCount,
  };

  // 可见性分流：debug 模式附带技术诊断块；normal 模式不带（保持 _debug undefined）
  if (ctx.visibilityMode === 'debug') {
    vm._debug = {
      projectId: project.id,
      projectStatus: project.status,
      workspaceMode: project.workspaceMode,
      draftIds: recentDrafts.map((d) => d.id),
      pendingDecisionIds: pendingDecisions.map((d) => d.id),
    };
  }

  // 防御性自检：normal 模式下若投影意外泄漏技术字段（编程 bug），立即抛错而非静默输出
  // debug 模式下 _debug 合法携带 id/枚举，断言为 no-op。
  assertNoForbiddenFields(vm, ctx.visibilityMode);

  return vm;
}

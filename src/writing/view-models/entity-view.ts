// =============================================================================
// EntityCardView ViewModel 投影（§7 实体系统 / §9.1 可见性）
// =============================================================================
// 把数据层 WritingEntitySketch（含技术字段 id/projectId/coreEntityId/version…）
// 投影为面向作者的"实体卡"视图。normal 模式不裸露 sketch id 的技术性，但保留
// 前端实体卡必需的展示字段。
//
// 与 world-snapshot.ts 的关系：world-snapshot 是"概览"（name/typeLabel/计数），
// 本视图是"卡片详情"（带 summary/tags/aliases/状态标签），供实体列表/详情页用。
// 两者都遵循 §9.1——不暴露 Core ent_ id 给作者（coreEntityId 仅 debug 模式带）。

import type { WritingEntitySketch, EntitySketchStatus } from '../models/types.js';
import { assertNoForbiddenFields, type VisibilityMode } from './filter.js';

/** 实体状态 → 人话标签（前端展示用，不显示枚举原文） */
const STATUS_LABELS: Record<EntitySketchStatus, string> = {
  hint: '待识别',
  candidate: '候选',
  approved: '待注册',
  registered: '正式',
  deprecated: '已废弃',
  merged: '已合并',
  error: '异常',
};

/** normal 模式下展示给作者的实体卡视图（无 Core 原始 id / 谓词） */
export interface EntityCardView {
  /** sketch id（前端导航/操作必需，但它是写作层 id 非 Core ent_，§9.1 允许） */
  id: string;
  /** 显示名 */
  name: string;
  /** 类型标签（角色/势力/地点…） */
  typeLabel: string;
  /** 状态人话标签（待识别/候选/正式…） */
  statusLabel: string;
  /** 原始状态枚举（前端按状态着色/筛选，但展示用 statusLabel） */
  status: EntitySketchStatus;
  /** 摘要（实体一句话描述） */
  summary?: string;
  /** 别名 */
  aliases: string[];
  /** 标签 */
  tags: string[];
}

/** debug 模式额外附带的诊断字段（Core 原始 id，仅排障） */
export interface EntityCardDebug {
  /** Core 实体 id（ent_xxx），已注册实体才有 */
  coreEntityId?: string;
  /** Core EntityKind */
  coreKind?: string;
  /** sketch 版本（乐观锁） */
  version: number;
}

/** 带可选 debug 块的实体卡（debug 模式才附 _debug） */
export type EntityCardViewModel = EntityCardView & { _debug?: EntityCardDebug };

/**
 * 把单个 WritingEntitySketch 投影为实体卡 ViewModel
 * @param sketch   数据层实体草图
 * @param mode     可见性模式：normal 仅人话字段，debug 附 Core 原始 id
 */
export function buildEntityCardView(
  sketch: WritingEntitySketch,
  mode: VisibilityMode,
): EntityCardViewModel {
  const vm: EntityCardViewModel = {
    id: sketch.id,
    name: sketch.displayName,
    typeLabel: sketch.typeLabel,
    statusLabel: STATUS_LABELS[sketch.status] ?? sketch.status,
    status: sketch.status,
    ...(sketch.summary ? { summary: sketch.summary } : {}),
    aliases: sketch.aliases ?? [],
    tags: sketch.tags ?? [],
  };

  if (mode === 'debug') {
    vm._debug = {
      ...(sketch.coreEntityId ? { coreEntityId: sketch.coreEntityId } : {}),
      ...(sketch.coreKind ? { coreKind: sketch.coreKind } : {}),
      version: sketch.version,
    };
  }

  assertNoForbiddenFields(vm, mode);
  return vm;
}

/** 批量投影（实体列表用） */
export function buildEntityCardViews(
  sketches: WritingEntitySketch[],
  mode: VisibilityMode,
): EntityCardViewModel[] {
  return sketches.map((s) => buildEntityCardView(s, mode));
}

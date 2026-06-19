// =============================================================================
// WorldSnapshot ViewModel 投影（§7.7 / §9.1 / §9.2）
// =============================================================================
// 设计文档：Phase7-Refinement.md §7.7（readCurrentWorldSnapshot 步骤 2/3：
//   组装 WorldSnapshotViewModel + 应用 visibilityMode 过滤）。
//
// 数据层 RealCoreBridge.readCurrentWorldSnapshot 返回结构化 WorldSnapshot（含 ent_/fct_
// 原始 id + Core 渲染的 profileMarkdown，供 Agent 后续操作与排障）。
//
// **§9.1 关键约束**：Core 的 renderEntityProfile 输出 **始终**含原始 id
// （`## 主角（ent_hero）档案`）与 Core 谓词（`* location：废弃站台`），不满足 normal 模式
// 可见性。故 normal ViewModel 只保留 §9.1-clean 的概览字段（显示名/类型/设定计数），
// profileMarkdown 与 factIndex 仅在 debug 模式的 _debug 块出现。
// 逐实体的"人话属性档案"（谓词标签化）属 EntityProfileViewModel（§9.2 未给示例），是独立视图，
// 不在 W8 范围。
//
// 与 W6/W7 一致的数据层/投影层分离：CoreBridge 产数据，view-models 产人话视图。
// =============================================================================

import type { WorldSnapshot } from '../core-bridge/core-bridge-service.js';
import { assertNoForbiddenFields, type VisibilityMode } from './filter.js';

/** normal 模式下展示给作者的单实体视图（概览，无任何 Core 原始 id / 谓词） */
export interface WorldSnapshotEntityView {
  /** 实体显示名（来自 entity sketch，非 Core ent_ id） */
  name: string;
  /** 类型标签（角色/势力/地点…） */
  typeLabel: string;
  /** 当前有效设定条数（factIndex 去除 id 后的计数） */
  attributeCount: number;
  /** 该实体读取失败时的人话提示（成功时省略） */
  error?: string;
}

/** debug 模式额外附带的诊断块（含 Core 原始 id / 谓词 / 档案，仅供排障） */
export interface WorldSnapshotDebugBlock {
  /** 各实体原始 Core id（顺序与 entities 对齐） */
  coreEntityIds: string[];
  /** 各实体的原始档案 + factId + 谓词（含技术字段，仅 debug） */
  profilesByEntity: Array<{
    name: string;
    coreEntityId: string;
    profileMarkdown: string;
    factIds: string[];
    predicates: string[];
  }>;
}

/** 世界快照 ViewModel——/world 或 Agent READ_QUERY 面向作者的展示 */
export interface WorldSnapshotViewModel {
  /** 快照章节视角 */
  currentChapter: number;
  /** 实体总数（含读取失败的） */
  entityCount: number;
  /** 各实体概览（§9.1 clean） */
  entities: WorldSnapshotEntityView[];
  /** debug 模式才有的诊断块（normal 模式无此键） */
  _debug?: WorldSnapshotDebugBlock;
}

/**
 * 把数据层 WorldSnapshot 投影为面向作者的 ViewModel
 *
 * @param snapshot  RealCoreBridge.readCurrentWorldSnapshot 的返回（含原始 id / profileMarkdown）
 * @param mode      可见性模式：normal 仅概览（§9.1 clean），debug 附诊断块
 */
export function buildWorldSnapshotView(
  snapshot: WorldSnapshot,
  mode: VisibilityMode,
): WorldSnapshotViewModel {
  const entities: WorldSnapshotEntityView[] = snapshot.entities.map((e) => ({
    name: e.displayName,
    typeLabel: e.typeLabel,
    attributeCount: e.factIndex.length,
    ...(e.error ? { error: e.error } : {}),
  }));

  const vm: WorldSnapshotViewModel = {
    currentChapter: snapshot.currentChapter,
    entityCount: snapshot.totalEntities,
    entities,
  };

  // debug 模式：附原始 id / 谓词 / 档案诊断块（normal 模式不带，避免 §9.1 泄漏）
  if (mode === 'debug') {
    vm._debug = {
      coreEntityIds: snapshot.entities.map((e) => e.coreEntityId),
      profilesByEntity: snapshot.entities.map((e) => ({
        name: e.displayName,
        coreEntityId: e.coreEntityId,
        profileMarkdown: e.profileMarkdown,
        factIds: e.factIndex.map((f) => f.factId),
        predicates: e.factIndex.map((f) => f.predicate),
      })),
    };
  }

  // 防御性自检：normal 模式下 ViewModel 不得泄漏任何 Core 原始 id/枚举/谓词（§9.1）
  // 若断言失败 = 投影逻辑有 bug（把数据层技术字段带进了人话视图），属编程缺陷，抛普通 Error。
  assertNoForbiddenFields(vm, mode);

  return vm;
}

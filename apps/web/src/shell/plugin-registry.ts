// =============================================================================
// 插件注册中心——导入所有内置插件 manifest，对外提供查询能力
// =============================================================================
// 这是可插拔架构的枢纽：未来加插件只需
//   1. 在 src/plugins/ 下建目录 + manifest
//   2. 在此 import 并加入 PLUGINS 数组
// 空壳（AppShell/ActivityBar/SideBar/EditorArea）只经此查询，不直接 import 插件。

import type { PluginManifest, ActivityContribution, EditorTypeContribution } from './types';
import type { Component } from 'vue';
// 内置插件
import { documentExplorerManifest } from '../plugins/document-explorer/manifest';
import { documentEditorManifest } from '../plugins/document-editor/manifest';
import { entityGraphManifest } from '../plugins/entity-graph/manifest';
import { chapterPlannerManifest } from '../plugins/chapter-planner/manifest';
import { ideaBoardManifest } from '../plugins/idea-board/manifest';
import { foreshadowingManifest } from '../plugins/foreshadowing-board/manifest';
import { timelineManifest } from '../plugins/timeline-view/manifest';
import { readerModelManifest } from '../plugins/reader-model/manifest';
import { spatialMapManifest } from '../plugins/spatial-map/manifest';
import { sceneBoardManifest } from '../plugins/scene-board/manifest';
import { revisionHistoryManifest } from '../plugins/revision-history/manifest';
import { agentPanelManifest } from '../plugins/agent-panel/manifest';

/** 全部内置插件（顺序即活动栏默认顺序；panelView 类插件不进活动栏，放末尾） */
const PLUGINS: PluginManifest[] = [
  documentExplorerManifest,
  documentEditorManifest,
  entityGraphManifest,
  chapterPlannerManifest,
  ideaBoardManifest,
  foreshadowingManifest,
  timelineManifest,
  readerModelManifest,
  spatialMapManifest,
  sceneBoardManifest,
  revisionHistoryManifest,
  agentPanelManifest,
];

/** 活动栏条目（按 order 排序） */
export function getActivityItems(): ActivityContribution[] {
  return PLUGINS
    .filter(p => p.activity)
    .map(p => p.activity!)
    .sort((a, b) => a.order - b.order);
}

/** 按 activity id 查插件 */
export function getPluginByActivity(activityId: string): PluginManifest | undefined {
  return PLUGINS.find(p => p.activity?.id === activityId);
}

/** 按 activity id 取其侧栏视图 */
export function getSideView(activityId: string): Component | undefined {
  return getPluginByActivity(activityId)?.sideView;
}

/** 按 activity id 取其模块主区视图（模块独占模式） */
export function getMainView(activityId: string): Component | undefined {
  return getPluginByActivity(activityId)?.mainView;
}

/** 取右侧面板视图——返回第一个声明 panelView 的插件（当前仅 agent-panel）。
 *  与 sideView 对称，但 panelView 不绑定 activity，是全局唯一 dock。
 *  App.vue 经此查询渲染右侧面板，不硬编码 import 任何插件组件。 */
export function getPanelView(): Component | undefined {
  return PLUGINS.find(p => p.panelView)?.panelView;
}

/** 按编辑器类型 id 取渲染组件 */
export function getEditorComponent(editorTypeId: string): Component | undefined {
  for (const p of PLUGINS) {
    const found = p.editorTypes?.find(e => e.id === editorTypeId);
    if (found) return found.component;
  }
  return undefined;
}

/** 启动时激活所有插件的 activate 钩子 */
export async function activateAllPlugins(): Promise<void> {
  for (const p of PLUGINS) {
    if (p.activate) await p.activate();
  }
}

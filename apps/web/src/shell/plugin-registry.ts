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

/** 全部内置插件（顺序即活动栏默认顺序） */
const PLUGINS: PluginManifest[] = [
  documentExplorerManifest,
  documentEditorManifest,
  entityGraphManifest,
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

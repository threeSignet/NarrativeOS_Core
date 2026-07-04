// =============================================================================
// 插件系统类型——VS Code 式可插拔架构核心
// =============================================================================
// 每个内置插件导出一个 PluginManifest，声明它贡献了什么：
//   - activity: 活动栏一个图标入口
//   - sideView: 该激活时侧栏显示的视图组件
//   - editorTypes: 该插件能渲染的编辑器类型（点不同文档开不同编辑器）
//   - commands: 贡献的命令（未来命令面板用）
// 空壳（shell）只认这些声明，不 import 任何业务逻辑——加插件不动 shell。

import type { Component } from 'vue';

/** 活动栏入口声明 */
export interface ActivityContribution {
  /** 插件 id，唯一 */
  id: string;
  /** tooltip 文字 */
  title: string;
  /** SVG 图标组件 */
  icon: Component;
  /** 活动栏排序（小的在上） */
  order: number;
}

/** 编辑器类型声明——决定某类文档用什么编辑器打开 */
export interface EditorTypeContribution {
  /** 编辑器类型 id，与文档的 editorType 字段对应 */
  id: string;
  /** 渲染组件 */
  component: Component;
}

/** 插件 manifest */
export interface PluginManifest {
  /** 插件 id */
  id: string;
  /** 活动栏入口（可选——纯编辑器插件可不要活动栏图标） */
  activity?: ActivityContribution;
  /** 激活时侧栏显示的视图（可选） */
  sideView?: Component;
  /** 模块主区视图（可选——活动栏切到此插件时，主区直接渲染此组件，不经标签路由）。
   *  用于"模块独占左右"模式：文档模块走 editorTypes 标签路由，实体关系模块贡献 mainView 独占主区。 */
  mainView?: Component;
  /** 贡献的编辑器类型（可选） */
  editorTypes?: EditorTypeContribution[];
  /** 插件初始化钩子（可选，App 挂载后调用） */
  activate?: () => void | Promise<void>;
}

/** 文档节点前端模型（与 BFF WritingDocument 对齐，去技术字段） */
export interface DocumentNode {
  id: string;
  projectId: string;
  parentId: string | null;
  kind: 'folder' | 'document' | 'chapter_ref';
  template: string;
  title: string;
  icon?: string;
  content?: string;
  contentFormat?: string;
  sortOrder: number;
  wordCount?: number;
  tags?: string[];
  status: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

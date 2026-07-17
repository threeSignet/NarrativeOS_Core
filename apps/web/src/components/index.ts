// =============================================================================
// 共享组件库（Ui 前缀）——跨插件复用的展示型 + 轻交互组件
// =============================================================================
// 设计原则：
//   1. 组件不带业务逻辑，纯 props/emit；业务逻辑留在插件 + store
//   2. 写操作走 store.action(projectId, ...)，绝不直接调 api/*
//   3. 提示走 useToast()、确认走 useConfirm()、偏好走 usePreferences()
//   4. 样式只引用 tokens.css 的 CSS 变量，禁止硬编码色值
//
// 目录结构（随节点 1 组件落地逐步建立）：
//   base/      原子组件：UiButton / UiIcon / UiEmpty / UiStatusDot
//   layout/    布局组件：UiSideHead / UiSearchBar / UiSideBody / UiPanelFooter
//   form/      表单组件：UiInput / UiSelect / UiTextArea / UiInlineForm
//   feedback/  反馈组件：UiBadge / UiChip / UiContextMenu
//
// 节点 1 起在此文件统一桶导出所有组件：
//   export { default as UiButton } from './base/UiButton.vue';
//   ...
//
// 当前（节点 0）：仅占位，组件未实现。

export {};

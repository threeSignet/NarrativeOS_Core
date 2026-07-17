// =============================================================================
// 共享组件库（Ui 前缀）——跨插件复用的展示型 + 轻交互组件
// =============================================================================
// 设计原则：
//   1. 组件不带业务逻辑，纯 props/emit；业务逻辑留在插件 + store
//   2. 写操作走 store.action(projectId, ...)，绝不直接调 api/*
//   3. 提示走 useToast()、确认走 useConfirm()、偏好走 usePreferences()
//   4. 样式只引用 tokens.css 的 CSS 变量，禁止硬编码色值
//
// 目录结构：
//   base/      原子组件：UiButton / UiIcon / UiEmpty / UiStatusDot
//   layout/    布局组件：UiSideHead / UiSearchBar / UiSideBody / UiPanelFooter
//   form/      表单组件：UiInput / UiSelect / UiTextArea / UiInlineForm
//   feedback/  反馈组件：UiBadge / UiChip / UiContextMenu

// base/
export { default as UiButton } from './base/UiButton.vue';
export { default as UiIcon } from './base/UiIcon.vue';
export { default as UiEmpty } from './base/UiEmpty.vue';
export { default as UiStatusDot } from './base/UiStatusDot.vue';

// layout/
export { default as UiSideHead } from './layout/UiSideHead.vue';
export { default as UiSearchBar } from './layout/UiSearchBar.vue';
export { default as UiSideBody } from './layout/UiSideBody.vue';
export { default as UiPanelFooter } from './layout/UiPanelFooter.vue';

// form/
export { default as UiInput } from './form/UiInput.vue';
export { default as UiSelect } from './form/UiSelect.vue';
export { default as UiTextArea } from './form/UiTextArea.vue';
export { default as UiInlineForm } from './form/UiInlineForm.vue';

// feedback/
export { default as UiBadge } from './feedback/UiBadge.vue';
export { default as UiChip } from './feedback/UiChip.vue';
export { default as UiContextMenu } from './feedback/UiContextMenu.vue';
export type { ContextMenuItem } from './feedback/UiContextMenu.vue';

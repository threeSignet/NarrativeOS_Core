<script setup lang="ts">
// =============================================================================
// 通用图标组件——收敛全应用散落的 inline SVG（51+ 处）
// =============================================================================
// 设计：
//   - name 语义化英文键（folder / search / plus ...），避免中文键在代码里难输
//   - 所有图标 path 集中在 ICON_PATHS 字典，单一真相源，新增图标只改一处
//   - 统一 viewBox 0 0 24 24 + stroke 风格（line-cap/join round），与现有图标视觉一致
//   - size 默认 18px（对齐全局 .ico 尺寸），可按场景调（侧栏 16 / 图标按钮 16 / 大图标 32）
//   - 未命中 name 渲染一个占位方块，并在 dev 控制台 warn（便于发现拼写错误）
import { computed } from 'vue';

const props = withDefaults(defineProps<{
  /** 图标名（见 ICON_PATHS 字典） */
  name: string;
  /** 尺寸 px，默认 18（对齐全局 .ico） */
  size?: number;
  /** 描边宽度，默认 1.8（对齐全局 .ico）；树节点等精致场景可用 1.6 */
  strokeWidth?: number;
}>(), {
  size: 18,
  strokeWidth: 1.8,
});

/** 图标 path 字典：name → SVG inner HTML（path/circle/line 等子元素）。
 *  所有图标沿用 24×24 viewBox，stroke 风格由组件外层 svg 统一控制。 */
const ICON_PATHS: Record<string, string> = {
  // ---- 导航/操作 ----
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
  'folder-open': '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z M3 11h18"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  'folder-plus': '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><path d="M12 11v4M10 13h4"/>',
  'file-plus': '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6M12 12v4M10 14h4"/>',
  import: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
  export: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  trash: '<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>',
  close: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  'chevron-down': '<path d="m6 9 6 6 6-6"/>',
  'chevron-right': '<path d="m9 6 6 6-6 6"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-3-6.7"/><polyline points="21 3 21 9 15 9"/>',
  // ---- 主题/设置 ----
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>',
  moon: '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>',
  // ---- 实体关系 ----
  relationship: '<circle cx="6" cy="12" r="2"/><circle cx="18" cy="12" r="2"/><path d="M8 12h8"/>',
  // ---- AI 助手 ----
  chat: '<path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2z"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/>',
  // ---- 编辑器格式（EditorToolbar 用）----
  bold: '<path d="M6 4h7a4 4 0 0 1 0 8H6z"/><path d="M6 12h8a4 4 0 0 1 0 8H6z"/>',
  italic: '<line x1="19" y1="5" x2="5" y2="19"/><line x1="15" y1="5" x2="5" y2="5"/><line x1="19" y1="19" x2="9" y2="19"/>',
  strike: '<path d="M16 4H9a3 3 0 0 0-2.83 4"/><path d="M14 12a3 3 0 0 1 0 6H8a3 3 0 0 1-2.83-4"/><line x1="4" y1="12" x2="20" y2="12"/>',
  code: '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>',
  'list-bullet': '<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><circle cx="3.5" cy="6" r="1.3" fill="currentColor" stroke="none"/><circle cx="3.5" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="3.5" cy="18" r="1.3" fill="currentColor" stroke="none"/>',
  'list-ordered': '<line x1="10" y1="6" x2="21" y2="6"/><line x1="10" y1="12" x2="21" y2="12"/><line x1="10" y1="18" x2="21" y2="18"/><path d="M4 6h1v4"/><path d="M4 10h2"/><path d="M6 17H4v-1h2v-1H4"/>',
  quote: '<path d="M3 21c3 0 5-2 5-5V7a3 3 0 0 0-3-3H4a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h1"/><path d="M14 21c3 0 5-2 5-5V7a3 3 0 0 0-3-3h-1a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h1"/>',
  hr: '<line x1="4" y1="12" x2="20" y2="12"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>',
  redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H9a5 5 0 0 0 0 10h3"/>',
  'clear-format': '<path d="M4 7V5h16v2"/><path d="M9 19h6"/><path d="M12 5v14"/><line x1="4" y1="4" x2="20" y2="20"/>',
  // ---- 图谱空状态 ----
  'graph-empty': '<circle cx="6" cy="6" r="2"/><circle cx="18" cy="6" r="2"/><circle cx="12" cy="18" r="2"/><path d="M8 7h8M8 7l3 9M16 7l-3 9"/>',
};

const inner = computed(() => ICON_PATHS[props.name] ?? '');
const hit = computed(() => Boolean(ICON_PATHS[props.name]));

// dev 环境 name 拼写错误告警（生产环境静默）
if (import.meta.env.DEV) {
  // 在 computed 之外做一次性检查（setup 阶段执行一次）
  if (!ICON_PATHS[props.name]) {
    // eslint-disable-next-line no-console
    console.warn(`[UiIcon] 未命中的图标名: "${props.name}"。可用:`, Object.keys(ICON_PATHS).join(', '));
  }
}
</script>

<template>
  <svg
    class="ui-icon"
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    :stroke-width="strokeWidth"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <!-- name 命中：渲染对应 path；未命中：渲染占位方块（开发期可见，便于发现拼写错误） -->
    <!-- 注意：SVG 内不能用 <template v-html>（SVG 命名空间下 <template> 不创建 DOM 节点） -->
    <g v-if="hit" v-html="inner" />
    <rect v-else x="3" y="3" width="18" height="18" rx="2" stroke-dasharray="3 3" />
  </svg>
</template>

<style scoped>
.ui-icon { display: inline-block; flex-shrink: 0; vertical-align: middle; }
</style>

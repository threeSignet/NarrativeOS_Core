// 风格指南插件 manifest——贡献活动栏入口 + 偏好侧栏 + 示例主区（迭代 D3）
// §18 风格指南/示例/禁用表达。
import type { PluginManifest } from '../../shell/types';
import StyleGuideIcon from './StyleGuideIcon.vue';
import StyleSideView from './StyleSideView.vue';
import StyleDetailView from './StyleDetailView.vue';

export const styleGuideManifest: PluginManifest = {
  id: 'style-guide',
  activity: {
    id: 'style-guide',
    title: '风格',
    icon: StyleGuideIcon,
    order: 11,
  },
  sideView: StyleSideView,
  mainView: StyleDetailView,
};

// Retcon 影响报告插件 manifest——贡献活动栏入口 + 报告列表侧栏 + 影响详情主区（迭代 D4）
// §10.5/§19.4 Retcon 影响报告只读查看器。
import type { PluginManifest } from '../../shell/types';
import RetconViewIcon from './RetconViewIcon.vue';
import RetconSideView from './RetconSideView.vue';
import RetconDetailView from './RetconDetailView.vue';

export const retconViewManifest: PluginManifest = {
  id: 'retcon-view',
  activity: {
    id: 'retcon-view',
    title: '追溯',
    icon: RetconViewIcon,
    order: 12,
  },
  sideView: RetconSideView,
  mainView: RetconDetailView,
};

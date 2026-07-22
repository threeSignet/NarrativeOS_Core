// 修订历史插件 manifest——贡献活动栏入口 + 类型过滤侧栏 + 时间线主区（迭代 D2）
// §19.1 通用修订记录只读查看器。
import type { PluginManifest } from '../../shell/types';
import RevisionHistoryIcon from './RevisionHistoryIcon.vue';
import RevisionSideView from './RevisionSideView.vue';
import RevisionListView from './RevisionListView.vue';

export const revisionHistoryManifest: PluginManifest = {
  id: 'revision-history',
  activity: {
    id: 'revision-history',
    title: '修订',
    icon: RevisionHistoryIcon,
    order: 10,
  },
  sideView: RevisionSideView,
  mainView: RevisionListView,
};

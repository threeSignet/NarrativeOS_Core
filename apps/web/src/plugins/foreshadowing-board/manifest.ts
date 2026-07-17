// 伏笔看板插件 manifest——贡献活动栏入口 + 伏笔看板侧栏（迭代 C1）
// §17 伏笔/暗示/回收/揭示计划，不写 Core。
import type { PluginManifest } from '../../shell/types';
import ForeshadowingIcon from './ForeshadowingIcon.vue';
import ForeshadowingListView from './ForeshadowingListView.vue';

export const foreshadowingManifest: PluginManifest = {
  id: 'foreshadowing-board',
  activity: {
    id: 'foreshadowing-board',
    title: '伏笔',
    icon: ForeshadowingIcon,
    order: 5,
  },
  sideView: ForeshadowingListView,
};

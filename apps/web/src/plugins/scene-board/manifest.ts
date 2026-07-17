// 场景卡插件 manifest——贡献活动栏入口 + 场景列表侧栏 + 详情主区（迭代 D1）
// §14.3 场景规划，不写 Core。
import type { PluginManifest } from '../../shell/types';
import SceneBoardIcon from './SceneBoardIcon.vue';
import SceneListView from './SceneListView.vue';
import SceneDetailView from './SceneDetailView.vue';

export const sceneBoardManifest: PluginManifest = {
  id: 'scene-board',
  activity: {
    id: 'scene-board',
    title: '场景',
    icon: SceneBoardIcon,
    order: 9,
  },
  sideView: SceneListView,
  mainView: SceneDetailView,
};

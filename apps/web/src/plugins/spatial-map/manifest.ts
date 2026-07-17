// 空间地图插件 manifest——贡献活动栏入口 + 统计侧栏 + 树视图主区（迭代 C4）
// §9 地理/空间只读视图，不写 Core。
import type { PluginManifest } from '../../shell/types';
import SpatialMapIcon from './SpatialMapIcon.vue';
import SpatialSideView from './SpatialSideView.vue';
import SpatialTreeView from './SpatialTreeView.vue';

export const spatialMapManifest: PluginManifest = {
  id: 'spatial-map',
  activity: {
    id: 'spatial-map',
    title: '空间',
    icon: SpatialMapIcon,
    order: 8,
  },
  sideView: SpatialSideView,
  mainView: SpatialTreeView,
};

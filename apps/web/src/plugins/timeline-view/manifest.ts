// 时间线插件 manifest——贡献活动栏入口 + 侧栏过滤 + 时间轴主区（迭代 C2）
// §15 双轨时间线只读视图，不写 Core。
import type { PluginManifest } from '../../shell/types';
import TimelineIcon from './TimelineIcon.vue';
import TimelineSideView from './TimelineSideView.vue';
import TimelineCanvas from './TimelineCanvas.vue';

export const timelineManifest: PluginManifest = {
  id: 'timeline-view',
  activity: {
    id: 'timeline-view',
    title: '时间线',
    icon: TimelineIcon,
    order: 6,
  },
  sideView: TimelineSideView,
  mainView: TimelineCanvas,
};

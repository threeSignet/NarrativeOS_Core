// 灵感板插件 manifest——贡献活动栏入口 + 灵感列表侧栏 + 详情编辑主区（迭代 B1）
// §5.1 灵感捕捉，低约束收集区，不写 Core。
import type { PluginManifest } from '../../shell/types';
import IdeaBoardIcon from './IdeaBoardIcon.vue';
import IdeaListView from './IdeaListView.vue';
import IdeaDetailView from './IdeaDetailView.vue';

export const ideaBoardManifest: PluginManifest = {
  id: 'idea-board',
  activity: {
    id: 'idea-board',
    title: '灵感',
    icon: IdeaBoardIcon,
    order: 4,
  },
  sideView: IdeaListView,
  mainView: IdeaDetailView,
};

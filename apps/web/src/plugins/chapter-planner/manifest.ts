// 章节规划插件 manifest——贡献活动栏入口 + 章节列表侧栏（迭代 A1）
// §14.2：章节规划是写作层叙事组织，不写 Core。
import type { PluginManifest } from '../../shell/types';
import ChapterPlannerIcon from './ChapterPlannerIcon.vue';
import ChapterListView from './ChapterListView.vue';

export const chapterPlannerManifest: PluginManifest = {
  id: 'chapter-planner',
  activity: {
    id: 'chapter-planner',
    title: '章节',
    icon: ChapterPlannerIcon,
    order: 3,
  },
  sideView: ChapterListView,
};

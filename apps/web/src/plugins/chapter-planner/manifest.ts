// 章节规划插件 manifest——贡献活动栏入口 + 章节列表侧栏 + 正文编辑器主区（迭代 A1+A2）
// §14.2 章节规划 + §13.8 块级正文。写作层叙事组织，不写 Core。
import type { PluginManifest } from '../../shell/types';
import ChapterPlannerIcon from './ChapterPlannerIcon.vue';
import ChapterListView from './ChapterListView.vue';
import ChapterProseEditor from './ChapterProseEditor.vue';

export const chapterPlannerManifest: PluginManifest = {
  id: 'chapter-planner',
  activity: {
    id: 'chapter-planner',
    title: '章节',
    icon: ChapterPlannerIcon,
    order: 3,
  },
  sideView: ChapterListView,
  // 模块独占主区：切到章节活动栏，主区直接渲染正文编辑器（不经标签路由）
  mainView: ChapterProseEditor,
};

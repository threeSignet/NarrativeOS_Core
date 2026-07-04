// 实体关系图谱插件 manifest——贡献活动栏入口 + 侧栏视图 + 图谱编辑器类型
import type { PluginManifest } from '../../shell/types';
import EntityGraphIcon from './EntityGraphIcon.vue';
import EntityGraphSideView from './EntityGraphSideView.vue';
import GraphCanvas from './GraphCanvas.vue';

export const entityGraphManifest: PluginManifest = {
  id: 'entity-graph',
  activity: {
    id: 'entity-graph',
    title: '实体关系',
    icon: EntityGraphIcon,
    order: 2,
  },
  sideView: EntityGraphSideView,
  // 模块独占主区：切到实体关系活动栏，主区直接渲染图谱（不经标签路由）
  mainView: GraphCanvas,
  editorTypes: [
    { id: 'entity-graph-view', component: GraphCanvas },
  ],
};

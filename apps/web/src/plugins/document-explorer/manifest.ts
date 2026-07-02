// 文档管理插件 manifest——贡献活动栏入口 + 文档树侧栏视图
import type { PluginManifest } from '../../shell/types';
import ExplorerIcon from './ExplorerIcon.vue';
import DocumentTreeView from './DocumentTreeView.vue';

export const documentExplorerManifest: PluginManifest = {
  id: 'document-explorer',
  activity: {
    id: 'document-explorer',
    title: '文档',
    icon: ExplorerIcon,
    order: 1,
  },
  sideView: DocumentTreeView,
};

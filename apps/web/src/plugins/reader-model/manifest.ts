// 读者模型插件 manifest——贡献活动栏入口 + 群体侧栏 + 认知主区（迭代 C3）
// §16 读者模型与视角，不写 Core。
import type { PluginManifest } from '../../shell/types';
import ReaderModelIcon from './ReaderModelIcon.vue';
import ReaderSideView from './ReaderSideView.vue';
import ReaderKnowledgeView from './ReaderKnowledgeView.vue';

export const readerModelManifest: PluginManifest = {
  id: 'reader-model',
  activity: {
    id: 'reader-model',
    title: '读者',
    icon: ReaderModelIcon,
    order: 7,
  },
  sideView: ReaderSideView,
  mainView: ReaderKnowledgeView,
};

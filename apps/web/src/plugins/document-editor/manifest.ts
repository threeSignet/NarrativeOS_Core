// 富文本编辑器插件 manifest——贡献 writing-document 编辑器类型
import type { PluginManifest } from '../../shell/types';
import DocumentEditor from './DocumentEditor.vue';

export const documentEditorManifest: PluginManifest = {
  id: 'document-editor',
  // 纯编辑器插件：无活动栏入口，只贡献 editorType
  editorTypes: [
    { id: 'writing-document', component: DocumentEditor },
  ],
};

// 切换项目的完整编排——调 API 激活 + 更新 ui store + 清空文档状态 + 重载树
// 供 App.vue、菜单栏、设置页等所有"切项目"的入口复用。
import { useUiStore } from '../stores/ui';
import { useDocumentStore } from '../stores/document';
import { useLocalDraftsStore } from '../stores/localDrafts';
import { activateProject } from '../api/projects';
import { listDocuments } from '../api/documents';

export function useProjectSwitch() {
  const ui = useUiStore();
  const docs = useDocumentStore();
  const local = useLocalDraftsStore();

  async function switchTo(projectId: string, projectTitle: string) {
    // 1. 调 BFF 切换激活项目
    await activateProject(projectId);
    // 2. 更新 ui store（同时清空 tabs/activeTabId）
    ui.switchProjectUI({ id: projectId, title: projectTitle } as any);
    // 3. 切换本地草稿的项目作用域（key 前缀跟随项目）
    local.setProject(projectId);
    // 4. 清空文档 store 的项目相关状态（选中/展开/待创建占位）
    docs.selectedId = null;
    docs.expanded.clear();
    docs.cancelCreate();
    // 5. 重载新项目的文档树
    docs.documents = await listDocuments(projectId);
  }

  return { switchTo };
}

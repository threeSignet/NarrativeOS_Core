// UI store——全局界面状态：项目列表/当前项目、活动栏、标签、布局
import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import type { ProjectView } from '../api/projects';

export interface EditorTab {
  /** 文档 id（设置类标签用保留 id） */
  docId: string;
  /** 文档标题（用于标签显示） */
  title: string;
  /** 编辑器类型 id（决定用哪个编辑器组件渲染；'app-settings'/'project-settings' 为设置页） */
  editorType: string;
}

/** 保留的特殊标签 docId（与真实文档 id 区隔，避免碰撞） */
export const SETTINGS_TAB = {
  app: '__settings_app__',
  project: '__settings_project__',
} as const;

export const useUiStore = defineStore('ui', () => {
  // ---------- 项目 ----------
  // 全部项目列表（多项目）
  const projects = ref<ProjectView[]>([]);
  // 当前激活项目
  const projectId = ref<string>('');
  const projectTitle = ref<string>('');

  // ---------- 界面 ----------
  const activeActivity = ref<string>('document-explorer');
  const sidebarHidden = ref(false);
  const panelHidden = ref(true);
  /** Agent 聊天面板（右侧 panel）是否展开。
   * 与 panelHidden 联动：panelHidden = !agentPanelOpen。
   * 单一真相源是 agentPanelOpen，panelHidden 保留是为兼容现有 shell.css 的 .hide-panel 类。 */
  const agentPanelOpen = ref(false);
  /** Agent 面板宽度（px），可拖拽调整，localStorage 持久化 */
  const PANEL_W_KEY = 'narrativeos_panel_width';
  const PANEL_W_MIN = 280;
  const PANEL_W_MAX = 720;
  const agentPanelWidth = ref(Number(localStorage.getItem(PANEL_W_KEY)) || 360);
  function setAgentPanelWidth(w: number) {
    agentPanelWidth.value = Math.max(PANEL_W_MIN, Math.min(PANEL_W_MAX, w));
    localStorage.setItem(PANEL_W_KEY, String(agentPanelWidth.value));
  }
  const tabs = ref<EditorTab[]>([]);
  const activeTabId = ref<string | null>(null);
  const syncState = ref<'saved' | 'syncing' | 'offline' | 'error'>('saved');
  /**
   * 设置页作为「特殊标签」存在（VS Code 式），而非带返回按钮的覆盖页。
   * settingsOpen / appSettingsOpen 由对应标签是否存在派生，标签即真相源：
   * 点活动栏齿轮 / 菜单 → 创建（或激活已存在的）设置标签；
   * 点标签 × → 关闭。切换项目时一并关闭项目设置标签。
   */
  const settingsOpen = computed(() => tabs.value.some(t => t.docId === SETTINGS_TAB.project));
  const appSettingsOpen = computed(() => tabs.value.some(t => t.docId === SETTINGS_TAB.app));
  /** 是否打开命令面板（Cmd/Ctrl+K） */
  const commandPaletteOpen = ref(false);
  /** 导入请求标记：命令面板触发后由侧栏 DocumentTreeView 监听并打开文件选择器 */
  const importRequested = ref(0);

  function openSettings() {
    openTab({ docId: SETTINGS_TAB.project, title: '项目设置', editorType: 'project-settings' });
  }
  function closeSettings() { closeTab(SETTINGS_TAB.project); }
  function openAppSettings() {
    openTab({ docId: SETTINGS_TAB.app, title: '设置', editorType: 'app-settings' });
  }
  function closeAppSettings() { closeTab(SETTINGS_TAB.app); }
  function openCommandPalette() { commandPaletteOpen.value = true; }
  function closeCommandPalette() { commandPaletteOpen.value = false; }
  /** 触发一次导入请求（自增以支持连续触发） */
  function requestImport() { importRequested.value += 1; }

  function setActiveActivity(id: string) { activeActivity.value = id; }
  function toggleSidebar() { sidebarHidden.value = !sidebarHidden.value; }
  /** 切换 Agent 面板开合；同时同步 panelHidden（驱动 shell.css 的 .hide-panel） */
  function toggleAgentPanel() {
    agentPanelOpen.value = !agentPanelOpen.value;
    panelHidden.value = !agentPanelOpen.value;
  }
  function openAgentPanel() {
    agentPanelOpen.value = true;
    panelHidden.value = false;
  }

  function openTab(tab: EditorTab) {
    const existing = tabs.value.find(t => t.docId === tab.docId);
    if (!existing) tabs.value.push(tab);
    activeTabId.value = tab.docId;
  }

  function closeTab(docId: string) {
    const idx = tabs.value.findIndex(t => t.docId === docId);
    if (idx === -1) return;
    tabs.value.splice(idx, 1);
    if (activeTabId.value === docId) {
      activeTabId.value = tabs.value[idx]?.docId ?? tabs.value[idx - 1]?.docId ?? null;
    }
  }

  function renameTab(docId: string, newTitle: string) {
    const tab = tabs.value.find(t => t.docId === docId);
    if (tab) tab.title = newTitle;
  }

  /**
   * 切换激活项目（UI 层）：更新当前项目 + 清空所有 UI 状态（标签/选中）。
   * 文档树清空 + 重载由调用方（App.vue / composable）在调用此方法前后处理。
   */
  function switchProjectUI(project: ProjectView) {
    projectId.value = project.id;
    projectTitle.value = project.title;
    // 清空所有项目相关的 UI 状态（避免 A 项目的标签指向 B 项目）
    tabs.value = [];
    activeTabId.value = null;
  }

  return {
    projects, projectId, projectTitle,
    activeActivity, sidebarHidden, panelHidden, agentPanelOpen,
    agentPanelWidth, setAgentPanelWidth,
    tabs, activeTabId, syncState, settingsOpen, appSettingsOpen,
    commandPaletteOpen, importRequested,
    setActiveActivity, toggleSidebar, toggleAgentPanel, openAgentPanel,
    openSettings, closeSettings, openAppSettings, closeAppSettings,
    openCommandPalette, closeCommandPalette, requestImport,
    openTab, closeTab, renameTab,
    switchProjectUI,
  };
});

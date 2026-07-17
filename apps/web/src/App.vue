<script setup lang="ts">
// App 根：装配 VS Code 式空壳，多项目启动，全局 Toast/Confirm/命令面板 挂载
import { onMounted, onBeforeUnmount, ref, computed } from 'vue';
import TitleBar from './shell/TitleBar.vue';
import ActivityBar from './shell/ActivityBar.vue';
import SideBar from './shell/SideBar.vue';
import EditorArea from './shell/EditorArea.vue';
import StatusBar from './shell/StatusBar.vue';
import ToastContainer from './shell/ToastContainer.vue';
import ConfirmDialog from './shell/ConfirmDialog.vue';
import CommandPalette from './shell/CommandPalette.vue';
import { useUiStore } from './stores/ui';
import { useDocumentStore } from './stores/document';
import { useLocalDraftsStore } from './stores/localDrafts';
import { activateAllPlugins, getPanelView } from './shell/plugin-registry';
import { syncEngine } from './services/sync-engine';
import { listProjects } from './api/projects';
import { listDocuments } from './api/documents';
import { useToast } from './composables/useToast';

const ui = useUiStore();
const docs = useDocumentStore();
const local = useLocalDraftsStore();
const toast = useToast();

// 右侧面板组件：经 registry 查询（不再硬编码 import AgentPanel）。
// 面板开关由 ui.agentPanelOpen 控制，宽度由 ui.agentPanelWidth 驱动。
const panelView = computed(() => getPanelView());

// 全局快捷键：Cmd/Ctrl+K 打开命令面板（IME 组合输入中屏蔽，避免误触发）
function onGlobalKeydown(e: KeyboardEvent) {
  if (e.isComposing) return; // 中文输入法 composing 中不响应
  if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
    e.preventDefault();
    if (ui.commandPaletteOpen) ui.closeCommandPalette();
    else ui.openCommandPalette();
  }
}

// ===== Agent 面板拖拽改宽度 =====
const isResizing = ref(false);
function startResize(e: MouseEvent) {
  e.preventDefault();
  isResizing.value = true;
  // 拖拽中禁用文本选择 + 改全局光标
  document.body.style.userSelect = 'none';
  document.body.style.cursor = 'col-resize';
  const startX = e.clientX;
  const startW = ui.agentPanelWidth;
  const onMove = (ev: MouseEvent) => {
    // panel 在右侧：鼠标左移（deltaX 负）→ 宽度增大
    ui.setAgentPanelWidth(startW - (ev.clientX - startX));
  };
  const onUp = () => {
    isResizing.value = false;
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
  };
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
}

onMounted(async () => {
  // 初始化离线同步引擎（注册 online/offline/探活监听）
  syncEngine.init();
  // 全局快捷键
  window.addEventListener('keydown', onGlobalKeydown);

  await activateAllPlugins();
  // 多项目启动：先拉全部项目 + 当前激活 id。
  // 加 try/catch：若 BFF 未启动 / 网络错 / 接口异常，listProjects 会抛错，
  // 此前无捕获导致 ui.projects 永远为空——菜单「切换项目」只剩标题无项目可切。
  try {
    const { projects, activeId } = await listProjects();
    ui.projects = projects;
    if (activeId && activeId !== 'bootstrap') {
      const active = projects.find(p => p.id === activeId);
      if (active) {
        ui.projectId = active.id;
        ui.projectTitle = active.title;
        local.setProject(active.id);
        docs.documents = await listDocuments(active.id);
      }
    } else if (projects.length > 0) {
      const first = projects[0]!;
      ui.projectId = first.id;
      ui.projectTitle = first.title;
      local.setProject(first.id);
      docs.documents = await listDocuments(first.id);
    }
  } catch (err: any) {
    // 加载失败要可见——此前静默吞错让用户以为「切换项目功能不存在」
    toast.error('项目列表加载失败：' + (err?.message || '请检查 BFF 服务是否启动'));
  }
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onGlobalKeydown);
});
</script>

<template>
  <div
    class="app"
    :class="{ 'hide-sidebar': ui.sidebarHidden, 'hide-panel': ui.panelHidden, 'is-resizing': isResizing }"
    :style="{ '--col-panel': ui.agentPanelOpen ? ui.agentPanelWidth + 'px' : '0px' }"
  >
    <TitleBar />
    <ActivityBar />
    <SideBar />
    <EditorArea />
    <!-- 拖拽分隔条：仅 Agent 面板打开时显示，左右拖拽改面板宽度 -->
    <div
      v-if="ui.agentPanelOpen"
      class="panel-resizer"
      :class="{ 'is-dragging': isResizing }"
      @mousedown="startResize"
    ></div>
    <aside class="panel" aria-hidden="true">
      <component :is="panelView" v-if="ui.agentPanelOpen && panelView" />
    </aside>
    <StatusBar />
  </div>
  <!-- 全局 Toast（右上角轻提示） -->
  <ToastContainer />
  <!-- 全局确认对话框（替代 window.confirm） -->
  <ConfirmDialog />
  <!-- 命令面板（Cmd/Ctrl+K） -->
  <CommandPalette />
</template>

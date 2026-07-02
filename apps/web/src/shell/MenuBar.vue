<script setup lang="ts">
// VS Code 式文字菜单栏：项目 / 视图 / 帮助
// 「项目」菜单：项目列表（带辅助信息，点切换）/ 新建项目（模态）/ 项目设置 / 删除项目（二次确认模态）
import { ref, nextTick, onUnmounted } from 'vue';
import { useUiStore } from '../stores/ui';
import { useProjectSwitch } from '../composables/useProjectSwitch';
import { useToast } from '../composables/useToast';
import * as projectApi from '../api/projects';
import NewProjectModal from './NewProjectModal.vue';
import DeleteProjectModal from './DeleteProjectModal.vue';
import HelpModal from './HelpModal.vue';

const ui = useUiStore();
const toast = useToast();
const { switchTo } = useProjectSwitch();

const openMenu = ref<string | null>(null);
const newProjectOpen = ref(false);
const deleteProjectOpen = ref(false);
// 帮助模态：null 关闭，'about' 关于，'shortcuts' 快捷键
const helpOpen = ref<null | 'about' | 'shortcuts'>(null);

// 点击外部关闭菜单（outside-click）。
// 根因：原方案用 @click.capture 在 .menu-bar 上监听，只能捕获冒泡经过菜单栏本身的事件；
// 点击编辑区/侧栏等外部区域时事件不经过 .menu-bar，菜单无法关闭。
// 改为在 document 上注册监听：菜单打开后，任何外部点击都关闭。
// nextTick 延迟注册避开「打开菜单的那次 click」本身（否则刚打开就被 document 捕获关闭）。
function closeMenu() { openMenu.value = null; }
function onDocClick(e: MouseEvent) {
  // 点击在菜单栏内部（菜单项/下拉）的不关闭——由各自 handler 或切换逻辑处理
  const target = e.target as HTMLElement | null;
  if (target?.closest('.menu-bar')) return;
  closeMenu();
}
function toggleMenu(name: string) {
  if (openMenu.value === name) { closeMenu(); return; }
  // 先移除旧监听器（菜单切换时避免累积）
  document.removeEventListener('click', onDocClick);
  openMenu.value = name;
  // 下一个事件循环注册，避开「打开菜单的那次 click」本身（否则刚打开就被 document 捕获关闭）
  nextTick(() => document.addEventListener('click', onDocClick));
}
// 组件卸载时清理（菜单打开中被卸载的边界情况，如切换路由）
onUnmounted(() => document.removeEventListener('click', onDocClick));

// ---------- 项目操作 ----------
async function onSwitchProject(pid: string, title: string) {
  if (pid === ui.projectId) { closeMenu(); return; }
  try {
    await switchTo(pid, title);
    closeMenu();
    toast.success(`已切换到「${title}」`);
  } catch (err: any) {
    toast.error('切换失败：' + (err?.response?.data?.error || err?.message || '未知错误'));
  }
}

function onNewProject() { closeMenu(); newProjectOpen.value = true; }

async function onCreateProject(payload: { title: string; premise: string }) {
  try {
    const created = await projectApi.createProject(payload.title, payload.premise || undefined);
    ui.projects = (await projectApi.listProjects()).projects;
    await switchTo(created.id, created.title);
    newProjectOpen.value = false;
    toast.success(`已创建项目「${created.title}」`);
  } catch (err: any) {
    toast.error('新建失败：' + (err?.response?.data?.error || '未知错误'));
  }
}

function onDeleteProject() {
  closeMenu();
  if (ui.projects.length <= 1) {
    toast.warning('至少保留一个项目，无法删除');
    return;
  }
  deleteProjectOpen.value = true;
}

async function onConfirmDelete() {
  try {
    const newActiveId = await projectApi.deleteProject(ui.projectId);
    ui.projects = (await projectApi.listProjects()).projects;
    deleteProjectOpen.value = false;
    if (newActiveId) {
      const next = ui.projects.find(p => p.id === newActiveId);
      if (next) await switchTo(next.id, next.title);
    }
    toast.success('项目已删除');
  } catch (err: any) {
    toast.error('删除失败：' + (err?.response?.data?.error || '未知错误'));
  }
}

// 项目设置：切换主区为设置页（不再用抽屉/emit）
function onOpenSettings() { closeMenu(); ui.openSettings(); }

function onToggleSidebar() { closeMenu(); ui.toggleSidebar(); }

function onShowAbout() { closeMenu(); helpOpen.value = 'about'; }
function onShowShortcuts() { closeMenu(); helpOpen.value = 'shortcuts'; }
</script>

<template>
  <div class="menu-bar">
    <!-- 项目菜单 -->
    <div class="menu-item" @click.stop="toggleMenu('project')">
      项目
      <div v-if="openMenu === 'project'" class="menu-dropdown" @click.stop>
        <div class="dd-group">
          <div class="dd-section-label">切换项目</div>
          <button
            v-for="p in ui.projects"
            :key="p.id"
            class="dd-item dd-project"
            :class="{ 'is-active': p.id === ui.projectId }"
            @click="onSwitchProject(p.id, p.title)"
          >
            <span class="dd-dot" :class="{ on: p.id === ui.projectId }"></span>
            <span class="dd-project-title truncate">{{ p.title }}</span>
          </button>
          <div v-if="ui.projects.length <= 1" class="dd-empty">暂无其他项目可切换</div>
        </div>
        <div class="dd-group">
          <div class="dd-section-label">管理</div>
          <button class="dd-item" @click="onNewProject">新建项目…</button>
          <button class="dd-item" @click="onOpenSettings">项目设置</button>
        </div>
        <div class="dd-group dd-group-danger">
          <button class="dd-item dd-danger" @click="onDeleteProject">删除当前项目</button>
        </div>
      </div>
    </div>

    <!-- 视图菜单 -->
    <div class="menu-item" @click.stop="toggleMenu('view')">
      视图
      <div v-if="openMenu === 'view'" class="menu-dropdown" @click.stop>
        <button class="dd-item" @click="onToggleSidebar">
          <span class="dd-check">{{ ui.sidebarHidden ? '' : '✓' }}</span>
          显示侧栏
        </button>
      </div>
    </div>

    <!-- 帮助菜单 -->
    <div class="menu-item" @click.stop="toggleMenu('help')">
      帮助
      <div v-if="openMenu === 'help'" class="menu-dropdown" @click.stop>
        <button class="dd-item" @click="onShowAbout">关于 NarrativeOS</button>
        <button class="dd-item" @click="onShowShortcuts">快捷键…</button>
      </div>
    </div>
  </div>

  <!-- 新建项目模态 -->
  <NewProjectModal
    :open="newProjectOpen"
    @close="newProjectOpen = false"
    @create="onCreateProject"
  />
  <!-- 删除项目二次确认模态 -->
  <DeleteProjectModal
    :open="deleteProjectOpen"
    :project-title="ui.projectTitle"
    @close="deleteProjectOpen = false"
    @confirm="onConfirmDelete"
  />
  <!-- 帮助模态（关于 / 快捷键） -->
  <HelpModal
    :open="helpOpen !== null"
    :kind="helpOpen ?? 'about'"
    @close="helpOpen = null"
  />
</template>

<style scoped>
.menu-bar {
  display: flex; align-items: center;
  height: 100%;
  -webkit-app-region: no-drag;
}
.menu-item {
  position: relative;
  padding: 0 10px;
  height: 100%;
  display: flex; align-items: center;
  font-size: var(--fs-sm); color: var(--text-2);
  cursor: pointer;
  border-radius: var(--r-xs);
  transition: background var(--t-fast);
}
.menu-item:hover { background: var(--bg-3); color: var(--text); }

.menu-dropdown {
  position: absolute;
  top: 100%; left: 0;
  min-width: 280px;
  background: var(--bg-elev);
  border: 1px solid var(--border-2);
  border-radius: var(--r-md);
  box-shadow: var(--shadow-pop);
  padding: 4px;
  z-index: 100;
  margin-top: 2px;
}
.dd-section-label {
  font-size: var(--fs-xs); font-weight: 600;
  letter-spacing: .05em; text-transform: uppercase;
  color: var(--text-3);
  padding: 6px 10px 3px;
}
/* 分组：每组之间用垂直间距区隔（替代生硬的 .dd-sep 细线），节奏统一 */
.dd-group { padding: 2px 0; }
.dd-group + .dd-group { margin-top: 4px; border-top: 1px solid var(--border); padding-top: 6px; }
.dd-group-danger + .dd-group-danger { border-top: none; margin-top: 0; }
.dd-item {
  display: flex; align-items: center; gap: 8px;
  width: 100%; text-align: left;
  padding: 6px 10px;
  font-size: var(--fs-sm); color: var(--text);
  border-radius: var(--r-xs);
}
.dd-item:hover:not(:disabled) { background: var(--bg-3); }
.dd-item:disabled { color: var(--text-3); cursor: not-allowed; }
.dd-item.is-active { background: var(--accent-bg); color: var(--accent); }
.dd-danger { color: var(--danger); }
.dd-danger:hover { background: var(--danger-bg); }

/* 项目列表项：单行（与操作项一致），前置状态点指示当前激活项目 */
.dd-project { padding: 6px 10px; }
.dd-project.is-active .dd-project-title { color: var(--accent); }

.dd-dot {
  width: 7px; height: 7px; border-radius: 50%;
  border: 1.5px solid var(--text-3); flex-shrink: 0;
}
.dd-dot.on { background: var(--accent); border-color: var(--accent); }
.dd-empty { padding: 6px 10px; font-size: var(--fs-xs); color: var(--text-3); }
.dd-check { width: 14px; text-align: center; color: var(--accent); flex-shrink: 0; }
</style>

<script setup lang="ts">
// 顶部标题栏：左=应用图标 + 文字菜单栏，中=命令面板触发器（VS Code 式），右=预留
// 中间的命令中心是只读触发器：显示当前项目名 + 搜索图标，
// 点击或按 Cmd/Ctrl+K 打开命令面板（文档跳转 / 命令执行）。
// 项目改名不在这一行——已移到项目设置页。
import { useUiStore } from '../stores/ui';
import MenuBar from './MenuBar.vue';

const ui = useUiStore();

function openPalette() {
  ui.openCommandPalette();
}
</script>

<template>
  <header class="titlebar">
    <!-- 左：应用图标——层叠作用域（外层世界 / 中层副本 / 内核状态点），体现 ContextScope 核心抽象 -->
    <div class="titlebar-app-icon" title="NarrativeOS">
      <svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round">
        <!-- 外层作用域：主世界 -->
        <rect x="3" y="3" width="18" height="18" rx="2.5" />
        <!-- 中层作用域：副本/梦境/异世界（嵌套） -->
        <rect x="7" y="7" width="10" height="10" rx="1.5" />
        <!-- 内核：世界状态点（确定性真相） -->
        <circle cx="12" cy="12" r="1.8" fill="currentColor" stroke="none" />
      </svg>
    </div>

    <!-- 文字菜单栏（项目/视图/帮助） -->
    <MenuBar />

    <!-- 中：命令面板触发器（只读项目名 + 搜索图标，点击打开面板） -->
    <div class="titlebar-center">
      <button class="titlebar-cmd" @click="openPalette" title="打开命令面板（Ctrl+K）">
        <svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>
        <span class="cmd-project">{{ ui.projectTitle || '未命名作品' }}</span>
        <span class="cmd-shortcut">
          <kbd>Ctrl</kbd><kbd>K</kbd>
        </span>
      </button>
    </div>

    <!-- 右：预留 -->
    <div class="titlebar-right"></div>
  </header>
</template>

<style scoped>
.titlebar-cmd {
  display: flex; align-items: center; gap: var(--sp-2);
  height: 25px;
  padding: 0 var(--sp-3);
  min-width: 280px; max-width: 480px;
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  background: var(--bg-2);
  color: var(--text-2);
  font-size: var(--fs-sm);
  cursor: pointer;
  transition: border-color var(--t-fast), background var(--t-fast);
}
.titlebar-cmd:hover { border-color: var(--border-2); background: var(--bg-3); }
.titlebar-cmd .ico { width: 14px; height: 14px; color: var(--text-3); flex-shrink: 0; }
/* 项目名只读：浅色，提示这是可搜索的入口而非编辑框 */
.cmd-project {
  color: var(--text-2); font-weight: 400;
  flex: 1; min-width: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  text-align: left;
}
/* 快捷键提示（靠右，灰） */
.cmd-shortcut {
  display: inline-flex; gap: 2px; flex-shrink: 0;
  font-family: var(--font-mono); font-size: 10px;
}
.cmd-shortcut kbd {
  padding: 1px 4px; border-radius: var(--r-xs);
  border: 1px solid var(--border-2); background: var(--bg-3);
  color: var(--text-3);
}
</style>

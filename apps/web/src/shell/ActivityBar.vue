<script setup lang="ts">
// 活动栏：渲染已注册插件的活动入口 + 左下角设置齿轮（VS Code 式）
import { computed } from 'vue';
import { useUiStore } from '../stores/ui';
import { usePreferences, type Theme } from '../composables/usePreferences';
import { getActivityItems } from './plugin-registry';
import type { ActivityContribution } from './types';

const ui = useUiStore();
const items = computed<ActivityContribution[]>(() => getActivityItems());

function onClick(item: ActivityContribution) {
  ui.setActiveActivity(item.id);
}

// 左下角齿轮 → 打开应用设置页
function openAppSettings() {
  ui.openAppSettings();
}

// 主题快捷切换（齿轮上方的太阳/月亮按钮）
const { prefs, set } = usePreferences();
function toggleTheme() {
  set('theme', (prefs.value.theme === 'dark' ? 'light' : 'dark') as Theme);
}
</script>

<template>
  <nav class="activity-bar" aria-label="工作模式">
    <div class="activity-items">
      <button
        v-for="item in items"
        :key="item.id"
        class="activity-btn"
        :class="{ 'is-active': ui.activeActivity === item.id }"
        :data-tip="item.title"
        :title="item.title"
        @click="onClick(item)"
      >
        <component :is="item.icon" />
      </button>
    </div>
    <div class="activity-bottom">
      <!-- 主题快捷切换 -->
      <button
        class="activity-btn"
        data-tip="切换主题"
        title="切换主题"
        @click="toggleTheme"
      >
        <svg v-if="prefs.theme === 'dark'" class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>
        <svg v-else class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
      </button>
      <!-- 设置齿轮（VS Code 式左下角） -->
      <button
        class="activity-btn"
        :class="{ 'is-active': ui.appSettingsOpen }"
        data-tip="设置"
        title="设置"
        @click="openAppSettings"
      >
        <svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/></svg>
      </button>
    </div>
  </nav>
</template>

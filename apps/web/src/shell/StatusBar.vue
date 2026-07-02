<script setup lang="ts">
// 状态栏：字数、当前文档、同步状态（含离线/错误/重试）
import { computed } from 'vue';
import { useUiStore } from '../stores/ui';
import { useDocumentStore } from '../stores/document';
import { syncEngine } from '../services/sync-engine';

const ui = useUiStore();
const docs = useDocumentStore();

const activeDoc = computed(() => ui.activeTabId ? docs.findById(ui.activeTabId) : undefined);
const wordCount = computed(() => activeDoc.value?.wordCount ?? 0);

// 同步状态文案 + 圆点颜色 + 是否可点击重试
const sync = computed(() => {
  switch (ui.syncState) {
    case 'syncing': return { text: '保存中…', dot: 'busy', retry: false };
    case 'offline': return { text: '离线·已暂存', dot: 'offline', retry: true };
    case 'error':   return { text: '保存失败，点击重试', dot: 'error', retry: true };
    default:        return { text: '已保存', dot: 'saved', retry: false };
  }
});

function onRetryClick() {
  if (sync.value.retry) syncEngine.retryNow();
}
</script>

<template>
  <footer class="status-bar">
    <span class="sb-spacer"></span>
    <span class="sb-item" v-if="activeDoc">
      <span>{{ wordCount }} 字</span>
    </span>
    <span class="sb-item" v-if="activeDoc">
      <span>{{ activeDoc.title }}</span>
    </span>
    <span
      class="sb-item"
      :class="{ clickable: sync.retry }"
      @click="onRetryClick"
    >
      <span class="sb-pulse" :class="`is-${sync.dot}`"></span>
      <span>{{ sync.text }}</span>
    </span>
  </footer>
</template>

<style scoped>
.status-bar { padding: 0 var(--sp-3); }
.sb-item.clickable { cursor: pointer; }
.sb-item.clickable:hover { color: var(--text); }
.sb-pulse {
  width: 7px; height: 7px; border-radius: 50%;
  flex-shrink: 0;
}
.sb-pulse.is-saved { background: var(--success); animation: sb-pulse 2.4s ease-in-out infinite; }
.sb-pulse.is-busy { background: var(--warning); animation: sb-spin 1s linear infinite; }
.sb-pulse.is-offline { background: var(--text-3); }
.sb-pulse.is-error { background: var(--danger); animation: sb-blink 1s ease-in-out infinite; }
@keyframes sb-pulse { 0%, 100% { opacity: .5; } 50% { opacity: 1; } }
@keyframes sb-spin { 0% { box-shadow: 0 0 0 0 var(--warning); } 100% { box-shadow: 0 0 0 4px transparent; } }
@keyframes sb-blink { 0%, 100% { opacity: 1; } 50% { opacity: .3; } }
</style>

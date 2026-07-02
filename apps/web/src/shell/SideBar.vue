<script setup lang="ts">
// 侧栏：渲染当前激活插件贡献的 sideView
import { computed } from 'vue';
import { useUiStore } from '../stores/ui';
import { getSideView } from './plugin-registry';

const ui = useUiStore();
const sideView = computed(() => getSideView(ui.activeActivity));
</script>

<template>
  <aside class="sidebar">
    <component :is="sideView" v-if="sideView" />
    <div v-else class="empty-state">
      <div class="es-title">无侧栏视图</div>
      <div class="es-desc">当前活动项未贡献侧栏视图</div>
    </div>
  </aside>
</template>

<script setup lang="ts">
// =============================================================================
// 侧栏主体容器——收敛散落的 <div class="side-body">
// =============================================================================
// 纯样式容器：flex:1 + overflow-y:auto。
// 侧栏 = 头部（固定）+ 搜索（固定）+ 主体（滚动）+ 底部面板（固定，可选）。
// 本组件承担"主体滚动区"角色。
</script>

<template>
  <div class="ui-side-body">
    <slot />
  </div>
</template>

<style scoped>
.ui-side-body { flex: 1; overflow-y: auto; }
</style>

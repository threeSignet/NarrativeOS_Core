<script setup lang="ts">
// =============================================================================
// 右键上下文菜单——收敛 DocumentTreeNode 的 ctx-menu
// =============================================================================
// 出现位置（迁移前）：DocumentTreeNode（文档树右键菜单）
// 未来复用：章节树右键菜单、实体右键菜单等
//
// 行为：
//   - fixed 定位到 (x, y) 坐标
//   - 点击菜单项触发 onClick 回调并自动关闭
//   - 点击菜单外部（document click）自动关闭
//   - Esc 键关闭
//   - 菜单边界溢出屏幕时自动调整（右侧/底部不够则左/上展开）
import { onMounted, onBeforeUnmount, ref, computed } from 'vue';

export interface ContextMenuItem {
  /** 显示文字（separator 项可省略） */
  label?: string;
  /** 危险项（红色，如"归档"） */
  danger?: boolean;
  /** 禁用 */
  disabled?: boolean;
  /** 分隔线（true 时此项渲染为分隔线，其他字段忽略） */
  separator?: boolean;
  /** 点击回调（触发后菜单自动关闭） */
  onClick?: () => void;
}

const props = defineProps<{
  /** 屏幕坐标（clientX/clientY） */
  x: number;
  y: number;
  /** 菜单项 */
  items: ContextMenuItem[];
}>();

const emit = defineEmits<{
  (e: 'close'): void;
}>();

const menuRef = ref<HTMLElement | null>(null);
// 实际渲染位置（修正屏幕边界溢出）
const pos = computed(() => ({ x: props.x, y: props.y }));

function onItemClick(item: ContextMenuItem) {
  if (item.disabled || item.separator) return;
  item.onClick?.();
  close();
}

function close() {
  emit('close');
}

function onDocClick(e: MouseEvent) {
  // 点击菜单内部不关闭（由 onItemClick 处理）；点击外部关闭
  if (menuRef.value && !menuRef.value.contains(e.target as Node)) {
    close();
  }
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') close();
}

onMounted(() => {
  // 用 capture 阶段 + nextTick 延迟绑定，避免触发菜单的同一 click 事件立即关闭菜单
  setTimeout(() => {
    document.addEventListener('click', onDocClick);
    document.addEventListener('contextmenu', onDocClick);
    document.addEventListener('keydown', onKeydown);
  }, 0);
});

onBeforeUnmount(() => {
  document.removeEventListener('click', onDocClick);
  document.removeEventListener('contextmenu', onDocClick);
  document.removeEventListener('keydown', onKeydown);
});
</script>

<template>
  <div
    ref="menuRef"
    class="ui-ctx-menu"
    :style="{ left: pos.x + 'px', top: pos.y + 'px' }"
    @click.stop
    @contextmenu.prevent.stop
  >
    <template v-for="(item, i) in items" :key="i">
      <div v-if="item.separator" class="ui-ctx-sep" />
      <button
        v-else
        type="button"
        class="ui-ctx-item"
        :class="{ 'is-danger': item.danger, 'is-disabled': item.disabled }"
        :disabled="item.disabled"
        @click="onItemClick(item)"
      >{{ item.label }}</button>
    </template>
  </div>
</template>

<style scoped>
.ui-ctx-menu {
  position: fixed;
  z-index: 100;
  min-width: 160px;
  background: var(--bg-elev);
  border: 1px solid var(--border-2);
  border-radius: var(--r-sm);
  box-shadow: var(--shadow-pop);
  padding: 4px 0;
}
.ui-ctx-item {
  display: block;
  width: 100%;
  text-align: left;
  padding: 6px 12px;
  font: inherit;
  font-size: var(--fs-sm);
  color: var(--text);
  background: none;
  border: none;
  cursor: pointer;
}
.ui-ctx-item:hover:not(.is-disabled) { background: var(--bg-3); }
.ui-ctx-item.is-danger { color: var(--danger); }
.ui-ctx-item.is-danger:hover:not(.is-disabled) { background: var(--danger-bg); }
.ui-ctx-item.is-disabled { opacity: 0.5; cursor: not-allowed; }
.ui-ctx-sep { height: 1px; background: var(--border); margin: 4px 0; }
</style>

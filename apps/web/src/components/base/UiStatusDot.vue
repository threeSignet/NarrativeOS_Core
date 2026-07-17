<script setup lang="ts">
// =============================================================================
// 通用状态色点——消除 status-dot 双轨冲突
// =============================================================================
// 双轨现状（迁移前）：
//   轨1（全局 shell.css）：.status-dot--committed/candidate/draft/hint 用 --st-* 主题变量
//   轨2（EntityGraphSideView scoped）：.sd--registered/approved/candidate/hint/... 硬编码色值
//   两套色值还不一致（轨1 candidate=#d8a13b，轨2 candidate=#fbbf24）
//
// 统一方案：
//   - 实体状态枚举（registered/approved/candidate/hint/deprecated/merged/error）→ 单一映射表
//   - 全部用 --st-* 主题变量（深/浅色主题自动切换），不再硬编码
//   - 来源层色（committed/candidate/draft/hint/association/view）由 color prop 直接传入
//     （来源层色来自 GRAPH_LAYER_META，不是状态枚举，保持调用方传色）
import { computed } from 'vue';

const props = withDefaults(defineProps<{
  /** 实体状态枚举（走映射表）。传此参数时无需 color。 */
  status?: 'registered' | 'approved' | 'candidate' | 'hint' | 'deprecated' | 'merged' | 'error';
  /** 自定义颜色（来源层等非枚举场景）。优先级高于 status。 */
  color?: string;
  /** 尺寸 px，默认 8 */
  size?: number;
}>(), {
  size: 8,
});

/** 实体状态 → 主题色变量（单源，主题感知）。
 *  registered 映射到 --st-committed（语义：已提交进 Core = committed）。
 *  approved 用 --st-draft（草拟态蓝色，区别于 registered 的绿）。 */
const STATUS_COLOR: Record<string, string> = {
  registered: 'var(--st-committed)',
  approved: 'var(--st-draft)',
  candidate: 'var(--st-candidate)',
  hint: 'var(--st-hint)',
  deprecated: 'var(--st-deprecated)',
  merged: 'var(--st-deprecated)',
  error: 'var(--danger)',
};

const fillStyle = computed(() => {
  if (props.color) return { background: props.color };
  if (props.status) return { background: STATUS_COLOR[props.status] ?? 'var(--text-3)' };
  return { background: 'var(--text-3)' };
});
const dim = computed(() => props.status === 'deprecated' || props.status === 'merged');
</script>

<template>
  <span
    class="ui-status-dot"
    :class="{ 'is-dim': dim }"
    :style="{ width: size + 'px', height: size + 'px', ...fillStyle }"
    aria-hidden="true"
  />
</template>

<style scoped>
.ui-status-dot {
  display: inline-block;
  border-radius: 50%;
  flex-shrink: 0;
}
/* deprecated/merged 半透明（与原 .sd--deprecated 一致） */
.ui-status-dot.is-dim { opacity: 0.5; }
</style>

<script setup lang="ts">
// 修订历史侧栏——类型过滤（迭代 D2）
import { watch } from 'vue';
import { useUiStore } from '../../stores/ui';
import { useRevisionStore } from '../../stores/revision';
import { UiSideHead, UiBadge, UiChip } from '../../components';
import { TARGET_TYPE_LABELS, type RevisionTargetType } from '../../api/revisions';

const ui = useUiStore();
const rev = useRevisionStore();

watch(() => [ui.activeActivity, ui.projectId] as const, async ([active, pid]) => {
  if (active === 'revision-history' && pid) await rev.loadRevisions(pid);
}, { immediate: true });

const TARGET_KEYS = Object.keys(TARGET_TYPE_LABELS) as RevisionTargetType[];
</script>

<template>
  <UiSideHead title="修订">
    <template #actions>
      <UiBadge v-if="rev.records.length" :text="rev.records.length" />
    </template>
  </UiSideHead>

  <div class="rev-filter">
    <div class="filter-title">对象类型</div>
    <div class="filter-chips">
      <UiChip :active="rev.targetTypeFilter === null" @click="rev.targetTypeFilter = null">全部</UiChip>
      <UiChip
        v-for="t in TARGET_KEYS" :key="t"
        :active="rev.targetTypeFilter === t"
        @click="rev.targetTypeFilter = rev.targetTypeFilter === t ? null : t"
      >{{ TARGET_TYPE_LABELS[t] }}</UiChip>
    </div>
  </div>

  <div class="rev-side-body">
    <div v-if="rev.loading" class="state-msg">加载中…</div>
    <div v-else-if="rev.error" class="state-msg is-error">{{ rev.error }}</div>
    <div v-else class="rev-summary">
      共 {{ rev.filteredRecords.length }} 条修订
      <span v-if="rev.records.length > 0" class="rev-hint">主区显示完整时间线</span>
    </div>
  </div>
</template>

<style scoped>
.rev-filter { padding: 0 var(--sp-2) var(--sp-1); }
.filter-title { font-size: var(--fs-xs); font-weight: 600; color: var(--text-3); margin-bottom: 4px; }
.filter-chips { display: flex; flex-wrap: wrap; gap: 4px; }
.rev-side-body { flex: 1; overflow-y: auto; padding: var(--sp-2) var(--sp-3); }
.state-msg { padding: var(--sp-3); font-size: var(--fs-sm); color: var(--text-3); }
.state-msg.is-error { color: var(--warning); }
.rev-summary { font-size: var(--fs-xs); color: var(--text-2); display: flex; flex-direction: column; gap: 4px; }
.rev-hint { color: var(--text-3); }
</style>

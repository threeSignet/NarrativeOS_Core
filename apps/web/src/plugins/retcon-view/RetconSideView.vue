<script setup lang="ts">
// Retcon 影响报告侧栏——报告列表 + 状态过滤（迭代 D4）
import { watch } from 'vue';
import { useUiStore } from '../../stores/ui';
import { useRetconStore } from '../../stores/retcon';
import { UiSideHead, UiBadge, UiChip, UiStatusDot, UiEmpty } from '../../components';
import { STATUS_LABELS, STATUS_COLORS, type RetconReportStatus } from '../../api/retcons';

const ui = useUiStore();
const retcon = useRetconStore();

watch(() => [ui.activeActivity, ui.projectId] as const, async ([active, pid]) => {
  if (active === 'retcon-view' && pid) await retcon.loadReports(pid);
}, { immediate: true });

const STATUS_KEYS = Object.keys(STATUS_LABELS) as RetconReportStatus[];

function formatTime(t: string): string {
  try { return new Date(t).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }); }
  catch { return t; }
}
</script>
<template>
  <UiSideHead title="追溯修改">
    <template #actions>
      <UiBadge v-if="retcon.reports.length" :text="retcon.reports.length" />
    </template>
  </UiSideHead>

  <div class="retcon-filter">
    <div class="filter-title">报告状态</div>
    <div class="filter-chips">
      <UiChip :active="retcon.statusFilter === null" @click="retcon.statusFilter = null">全部</UiChip>
      <UiChip v-for="s in STATUS_KEYS" :key="s" :active="retcon.statusFilter === s"
        @click="retcon.statusFilter = retcon.statusFilter === s ? null : s">
        {{ STATUS_LABELS[s] }}
      </UiChip>
    </div>
  </div>

  <div class="retcon-side-body">
    <div v-if="retcon.loading" class="state-msg">加载中…</div>
    <div v-else-if="retcon.error" class="state-msg is-error">{{ retcon.error }}</div>
    <UiEmpty v-else-if="retcon.reports.length === 0" title="暂无追溯报告" description="Retcon 操作会产生影响报告" />
    <template v-else>
      <div
        v-for="r in retcon.filteredReports" :key="r.id"
        class="report-row"
        :class="{ 'is-selected': retcon.selectedId === r.id }"
        @click="retcon.select(r.id)"
      >
        <UiStatusDot :color="STATUS_COLORS[r.status]" />
        <div class="report-info">
          <div class="report-proposal">{{ r.retconProposalId }}</div>
          <div class="report-meta">
            <span class="node-count">{{ r.affectedNodes.length }} 节点</span>
            <span class="report-time">{{ formatTime(r.createdAt) }}</span>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.retcon-filter { padding: 0 var(--sp-2) var(--sp-1); }
.filter-title { font-size: var(--fs-xs); font-weight: 600; color: var(--text-3); margin-bottom: 4px; }
.filter-chips { display: flex; flex-wrap: wrap; gap: 4px; }
.retcon-side-body { flex: 1; overflow-y: auto; }
.state-msg { padding: var(--sp-3); font-size: var(--fs-sm); color: var(--text-3); }
.state-msg.is-error { color: var(--warning); }
.report-row {
  display: flex; align-items: center; gap: var(--sp-2);
  padding: 6px var(--sp-3); cursor: pointer;
  border-left: 2px solid transparent;
}
.report-row:hover { background: var(--bg-3); }
.report-row.is-selected { background: var(--accent-bg); border-left-color: var(--accent); }
.report-info { flex: 1; min-width: 0; }
.report-proposal { font-size: var(--fs-sm); color: var(--text); font-family: var(--font-mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.report-meta { display: flex; gap: var(--sp-2); margin-top: 2px; }
.node-count { font-size: 10px; padding: 0 6px; border-radius: var(--r-pill); background: var(--bg-3); color: var(--text-2); }
.report-time { font-size: var(--fs-xs); color: var(--text-3); font-family: var(--font-mono); }
</style>

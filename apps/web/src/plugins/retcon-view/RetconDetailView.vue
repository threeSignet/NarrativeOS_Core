<script setup lang="ts">
// Retcon 影响报告主区——受影响节点/边/重检项 + 状态推进（迭代 D4）
import { computed } from 'vue';
import { useUiStore } from '../../stores/ui';
import { useRetconStore } from '../../stores/retcon';
import { useToast } from '../../composables/useToast';
import { UiButton, UiEmpty, UiStatusDot, UiChip } from '../../components';
import {
  STATUS_LABELS, STATUS_COLORS, KIND_LABELS, EFFECT_LABELS, EFFECT_COLORS,
  type RetconReportStatus,
} from '../../api/retcons';

const ui = useUiStore();
const retcon = useRetconStore();
const toast = useToast();

const selected = computed(() => retcon.selected);
const nextStatuses = computed<RetconReportStatus[]>(() => {
  if (!selected.value) return [];
  if (selected.value.status === 'pending') return ['confirmed', 'rejected'];
  if (selected.value.status === 'confirmed') return ['superseded'];
  return [];
});

async function onAdvance(status: RetconReportStatus) {
  if (!ui.projectId || !selected.value) return;
  try {
    await retcon.advanceStatus(ui.projectId, selected.value.id, status);
    toast.success(`报告已${STATUS_LABELS[status]}`);
  } catch (e: any) { toast.error('推进失败：' + e?.message); }
}
</script>

<template>
  <div class="retcon-detail-wrap">
    <UiEmpty v-if="!selected" block icon="graph-empty" title="未选择报告" description="从左侧选择一条追溯报告查看详情" />

    <div v-else class="rd-content">
      <!-- 头部 -->
      <div class="rd-head">
        <UiStatusDot :color="STATUS_COLORS[selected.status]" />
        <span class="status-label">{{ STATUS_LABELS[selected.status] }}</span>
        <span class="proposal-id">{{ selected.retconProposalId }}</span>
        <div class="head-actions">
          <UiButton v-for="ns in nextStatuses" :key="ns" variant="ghost" size="sm"
            :disabled="retcon.loading" @click="onAdvance(ns)">
            {{ STATUS_LABELS[ns] }}
          </UiButton>
        </div>
      </div>

      <!-- 摘要 -->
      <div class="rd-section">
        <div class="summary-text">{{ selected.summary }}</div>
      </div>

      <!-- 受影响节点 -->
      <div class="rd-section">
        <div class="section-title">受影响节点（{{ selected.affectedNodes.length }}）</div>
        <div v-for="n in selected.affectedNodes" :key="n.id" class="node-card">
          <div class="node-head">
            <span class="node-kind">{{ KIND_LABELS[n.kind] }}</span>
            <UiStatusDot :color="EFFECT_COLORS[n.effect]" :size="8" />
            <span class="node-effect" :style="{ color: EFFECT_COLORS[n.effect] }">{{ EFFECT_LABELS[n.effect] }}</span>
          </div>
          <div class="node-label">{{ n.label }}</div>
          <div v-if="n.reason" class="node-reason">{{ n.reason }}</div>
        </div>
        <UiEmpty v-if="!selected.affectedNodes.length" title="无受影响节点" />
      </div>

      <!-- 受影响边 -->
      <div v-if="selected.affectedEdges.length" class="rd-section">
        <div class="section-title">受影响关联（{{ selected.affectedEdges.length }}）</div>
        <div v-for="(e, i) in selected.affectedEdges" :key="i" class="edge-row">
          <span class="edge-label">{{ e.label ?? e.kind }}</span>
          <span class="edge-arrow">{{ e.sourceNodeId }} → {{ e.targetNodeId }}</span>
        </div>
      </div>

      <!-- 重检项 -->
      <div v-if="selected.recheckList.length" class="rd-section">
        <div class="section-title">写作层重检项（{{ selected.recheckList.length }}）</div>
        <div v-for="item in selected.recheckList" :key="item.targetId" class="recheck-card">
          <div class="recheck-head">
            <span class="recheck-type">{{ item.targetType }}</span>
            <span class="recheck-label">{{ item.label }}</span>
          </div>
          <div class="recheck-reason">{{ item.reason }}</div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.retcon-detail-wrap { height: 100%; overflow-y: auto; background: var(--bg); }
.rd-content { max-width: 720px; margin: 0 auto; padding: var(--sp-6) var(--sp-4); display: flex; flex-direction: column; gap: var(--sp-4); }
.rd-head { display: flex; align-items: center; gap: var(--sp-2); padding-bottom: var(--sp-2); border-bottom: 1px solid var(--border); }
.status-label { font-size: var(--fs-sm); font-weight: 500; color: var(--text); }
.proposal-id { font-size: var(--fs-xs); color: var(--text-3); font-family: var(--font-mono); }
.head-actions { margin-left: auto; display: flex; gap: var(--sp-1); }
.rd-section { display: flex; flex-direction: column; gap: var(--sp-2); }
.section-title { font-size: var(--fs-xs); font-weight: 600; color: var(--text-3); letter-spacing: 0.04em; }
.summary-text { font-size: var(--fs-sm); color: var(--text-2); line-height: 1.5; padding: var(--sp-3); background: var(--bg-2); border-radius: var(--r-sm); }
.node-card { padding: var(--sp-2) var(--sp-3); background: var(--bg-2); border-radius: var(--r-sm); border-left: 3px solid var(--border); }
.node-head { display: flex; align-items: center; gap: var(--sp-1); }
.node-kind { font-size: var(--fs-xs); font-weight: 600; color: var(--text-3); }
.node-effect { font-size: var(--fs-xs); font-weight: 500; }
.node-label { font-size: var(--fs-sm); color: var(--text); margin-top: 2px; font-family: var(--font-mono); }
.node-reason { font-size: var(--fs-xs); color: var(--text-3); margin-top: 2px; }
.edge-row { display: flex; gap: var(--sp-2); font-size: var(--fs-sm); padding: 2px 0; }
.edge-label { color: var(--accent); font-weight: 500; }
.edge-arrow { color: var(--text-3); font-family: var(--font-mono); }
.recheck-card { padding: var(--sp-2) var(--sp-3); background: var(--bg-2); border-radius: var(--r-sm); border-left: 3px solid var(--warning); }
.recheck-head { display: flex; gap: var(--sp-2); align-items: center; }
.recheck-type { font-size: 10px; padding: 0 6px; border-radius: var(--r-pill); background: var(--bg-3); color: var(--text-2); }
.recheck-label { font-size: var(--fs-sm); color: var(--text); }
.recheck-reason { font-size: var(--fs-xs); color: var(--text-3); margin-top: 2px; }
</style>

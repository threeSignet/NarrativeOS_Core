<script setup lang="ts">
// 实体关系侧栏——搜索框 + 来源层过滤 + 实体列表（按类型分组）
import { watch, computed } from 'vue';
import { useUiStore } from '../../stores/ui';
import { useEntityStore } from '../../stores/entity';
import type { EntityCard } from '../../api/entities';
import { GRAPH_LAYER_META } from '../../utils/entityKinds';

const ui = useUiStore();
const entity = useEntityStore();

watch(() => [ui.activeActivity, ui.projectId] as const, ([active, pid]) => {
  if (active === 'entity-graph' && pid) entity.loadEntities(pid);
}, { immediate: true });

function onSelect(id: string) {
  if (ui.projectId) entity.selectEntity(ui.projectId, id);
}

// 按 typeLabel 分组（侧栏分类展示）
const groupedEntities = computed(() => {
  const groups = new Map<string, EntityCard[]>();
  for (const e of entity.filteredEntities) {
    const key = e.typeLabel || '未分类';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(e);
  }
  return Array.from(groups.entries()).map(([label, items]) => ({ label, items }));
});
</script>

<template>
  <div class="side-head">
    <span class="side-title">实体关系</span>
    <span v-if="entity.entities.length" class="entity-count">{{ entity.entities.length }}</span>
  </div>

  <!-- 搜索框（与图谱共享 query，输入时图谱高亮联动） -->
  <div class="side-search">
    <svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>
    <input v-model="entity.query" placeholder="搜索实体 / 类型 / 标签…" />
  </div>

  <!-- 来源层过滤（§10.2 GraphFilterState.layers，点 chip 切换显隐） -->
  <div class="layer-filters">
    <button
      v-for="l in GRAPH_LAYER_META" :key="l.key"
      class="layer-chip"
      :class="{ 'is-off': entity.hiddenLayers.has(l.key) }"
      :style="{ '--lc': l.color }"
      :title="l.label + (entity.hiddenLayers.has(l.key) ? '（已隐藏）' : '')"
      @click="entity.toggleLayer(l.key)"
    >{{ l.label }}</button>
  </div>

  <div class="side-body">
    <div v-if="entity.loading" class="es-desc" style="padding: var(--sp-3);">加载中…</div>
    <div v-else-if="entity.error" class="es-desc" style="padding: var(--sp-3); color: var(--warning);">{{ entity.error }}</div>
    <div v-else-if="entity.entities.length === 0" class="empty-state" style="height:auto;padding:var(--sp-6) var(--sp-3);">
      <div class="es-title" style="font-size:var(--fs-sm);">暂无实体</div>
      <div class="es-desc">让 AI 助手帮你提取，或等待手动创建功能（里程碑③）</div>
    </div>
    <div v-else-if="groupedEntities.length === 0" class="es-desc" style="padding: var(--sp-3); color: var(--text-3);">无匹配实体</div>

    <template v-for="g in groupedEntities" :key="g.label">
      <div class="side-group">{{ g.label }} · {{ g.items.length }}</div>
      <div
        v-for="e in g.items"
        :key="e.id"
        class="entity-row"
        :class="{ 'is-selected': entity.selectedId === e.id }"
        @click="onSelect(e.id)"
      >
        <span class="status-dot" :class="'sd--' + e.status"></span>
        <div class="entity-info">
          <div class="entity-name">{{ e.name }}</div>
          <div class="entity-status">{{ e.statusLabel }}</div>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.entity-count {
  font-size: var(--fs-xs); color: var(--text-3);
  background: var(--bg-3); padding: 1px 6px; border-radius: var(--r-pill);
}
/* 来源层过滤 chips（§10.2 GraphFilterState） */
.layer-filters {
  display: flex; flex-wrap: wrap; gap: 4px;
  padding: 0 var(--sp-2) var(--sp-1);
}
.layer-chip {
  font-size: var(--fs-xs); padding: 2px 8px;
  border-radius: var(--r-pill);
  border: 1px solid color-mix(in srgb, var(--lc) 50%, transparent);
  color: var(--lc);
  background: color-mix(in srgb, var(--lc) 12%, transparent);
  cursor: pointer;
  transition: opacity var(--t-fast);
}
.layer-chip.is-off {
  opacity: 0.3;
  text-decoration: line-through;
}
.side-group {
  font-size: var(--fs-xs); font-weight: 600;
  letter-spacing: 0.05em; text-transform: uppercase;
  color: var(--text-3);
  padding: var(--sp-3) var(--sp-3) var(--sp-1);
}
.entity-row {
  display: flex; align-items: center; gap: var(--sp-2);
  padding: 6px var(--sp-3); cursor: pointer;
  border-left: 2px solid transparent;
  transition: background var(--t-fast);
}
.entity-row:hover { background: var(--bg-3); }
.entity-row.is-selected { background: var(--accent-bg); border-left-color: var(--accent); }
.entity-info { flex: 1; min-width: 0; }
.entity-name { font-size: var(--fs-sm); color: var(--text); }
.entity-status { font-size: var(--fs-xs); color: var(--text-3); }
.status-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.sd--registered { background: #4ade80; }
.sd--approved { background: #60a5fa; }
.sd--candidate { background: #fbbf24; }
.sd--hint { background: #94a3b8; }
.sd--deprecated, .sd--merged { background: #64748b; opacity: 0.5; }
.sd--error { background: #f87171; }
</style>

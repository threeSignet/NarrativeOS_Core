<script setup lang="ts">
// 实体关系侧栏——搜索 + 来源层过滤 + 实体列表（含审核操作）+ 待确认决策
import { ref, watch, computed } from 'vue';
import { useUiStore } from '../../stores/ui';
import { useEntityStore } from '../../stores/entity';
import { useToast } from '../../composables/useToast';
import type { EntityCard } from '../../api/entities';
import { GRAPH_LAYER_META, ENTITY_KIND_LABELS } from '../../utils/entityKinds';
import { RELATION_TYPE_OPTIONS } from '../../utils/relationTypes';

const ui = useUiStore();
const entity = useEntityStore();
const toast = useToast();

watch(() => [ui.activeActivity, ui.projectId] as const, async ([active, pid]) => {
  if (active === 'entity-graph' && pid) {
    await entity.loadEntities(pid);
    await entity.loadDecisions(pid);
  }
}, { immediate: true });

function onSelect(id: string) {
  if (ui.projectId) entity.selectEntity(ui.projectId, id);
}

// 按类型分组
const groupedEntities = computed(() => {
  const groups = new Map<string, EntityCard[]>();
  for (const e of entity.filteredEntities) {
    const key = e.typeLabel || '未分类';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(e);
  }
  return Array.from(groups.entries()).map(([label, items]) => ({ label, items }));
});

// ===== 新建实体表单 =====
const showCreate = ref(false);
const form = ref({ displayName: '', typeLabel: '角色', summary: '' });
const ENTITY_TYPES = Object.values(ENTITY_KIND_LABELS);

async function onCreate() {
  if (!ui.projectId || !form.value.displayName.trim()) return;
  try {
    await entity.create(ui.projectId, {
      displayName: form.value.displayName.trim(),
      typeLabel: form.value.typeLabel,
      summary: form.value.summary.trim() || undefined,
    });
    toast.success(`已创建实体：${form.value.displayName}`);
    form.value = { displayName: '', typeLabel: '角色', summary: '' };
    showCreate.value = false;
  } catch (e: any) {
    toast.error('创建失败：' + (e?.response?.data?.error || e?.message));
  }
}

// ===== 新建关系表单 =====
const showCreateRel = ref(false);
const relForm = ref({ sourceId: '', targetId: '', relationTypeId: 'siblings' });
// 已注册实体列表（关系两端必须已注册 Core 的实体）
const registeredEntities = computed(() => entity.entities.filter((e) => e.status === 'registered'));

async function onCreateRelation() {
  if (!ui.projectId || !relForm.value.sourceId || !relForm.value.targetId) return;
  if (relForm.value.sourceId === relForm.value.targetId) {
    toast.error('源实体和目标实体不能相同'); return;
  }
  try {
    await entity.createRelationAction(ui.projectId, {
      sourceEntityId: relForm.value.sourceId,
      targetEntityId: relForm.value.targetId,
      relationTypeId: relForm.value.relationTypeId,
      layer: 'world',
      direction: 'bidirectional',
    });
    toast.success('关系已创建，请在待确认面板确认');
    relForm.value = { sourceId: '', targetId: '', relationTypeId: 'siblings' };
    showCreateRel.value = false;
  } catch (e: any) {
    toast.error('创建关系失败：' + (e?.response?.data?.error || e?.message));
  }
}

// ===== 审核操作 =====
async function onApprove(e: EntityCard) {
  if (!ui.projectId) return;
  try { await entity.approve(ui.projectId, e.id); toast.success(`已批准：${e.name}`); }
  catch (e2: any) { toast.error('批准失败：' + (e2?.response?.data?.error || e2?.message)); }
}
async function onRegister(e: EntityCard) {
  if (!ui.projectId) return;
  try { await entity.register(ui.projectId, e.id); toast.success(`已注册进世界：${e.name}`); }
  catch (e2: any) { toast.error('注册失败：' + (e2?.response?.data?.error || e2?.message)); }
}
async function onDeprecate(e: EntityCard) {
  if (!ui.projectId) return;
  try { await entity.deprecate(ui.projectId, e.id); toast.success(`已废弃：${e.name}`); }
  catch (e2: any) { toast.error('废弃失败：' + (e2?.response?.data?.error || e2?.message)); }
}

// ===== 待确认决策 =====
async function onResolveDecision(id: string) {
  if (!ui.projectId) return;
  try { await entity.resolvePendingDecision(ui.projectId, id, 'resolve'); toast.success('已确认注册'); }
  catch (e: any) { toast.error('确认失败：' + (e?.response?.data?.error || e?.message)); }
}
</script>

<template>
  <div class="side-head">
    <span class="side-title">实体关系</span>
    <div class="side-actions">
      <button class="icon-btn" title="新建实体" @click="showCreate = !showCreate">
        <svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>
      </button>
      <button class="icon-btn" title="新建关系" :disabled="registeredEntities.length < 2" @click="showCreateRel = !showCreateRel">
        <svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="6" cy="12" r="2"/><circle cx="18" cy="12" r="2"/><path d="M8 12h8"/></svg>
      </button>
      <span v-if="entity.entities.length" class="entity-count">{{ entity.entities.length }}</span>
    </div>
  </div>

  <!-- 新建关系表单 -->
  <div v-if="showCreateRel" class="create-form">
    <select v-model="relForm.sourceId" class="form-input">
      <option value="" disabled>选择源实体…</option>
      <option v-for="e in registeredEntities" :key="e.id" :value="e.id">{{ e.name }}（{{ e.typeLabel }}）</option>
    </select>
    <select v-model="relForm.targetId" class="form-input">
      <option value="" disabled>选择目标实体…</option>
      <option v-for="e in registeredEntities" :key="e.id" :value="e.id">{{ e.name }}（{{ e.typeLabel }}）</option>
    </select>
    <select v-model="relForm.relationTypeId" class="form-input">
      <option v-for="r in RELATION_TYPE_OPTIONS" :key="r.value" :value="r.value">{{ r.label }}</option>
    </select>
    <div class="form-actions">
      <button class="btn btn--sm" @click="showCreateRel = false">取消</button>
      <button class="btn btn--sm btn--primary" :disabled="!relForm.sourceId || !relForm.targetId || relForm.sourceId === relForm.targetId || entity.acting" @click="onCreateRelation">创建关系</button>
    </div>
  </div>

  <!-- 新建实体表单 -->
  <div v-if="showCreate" class="create-form">
    <input v-model="form.displayName" class="form-input" placeholder="实体名称（如：苏暮雪）" @keydown.enter="onCreate" />
    <select v-model="form.typeLabel" class="form-input">
      <option v-for="t in ENTITY_TYPES" :key="t" :value="t">{{ t }}</option>
    </select>
    <textarea v-model="form.summary" class="form-input" placeholder="一句话描述（可选）" rows="2"></textarea>
    <div class="form-actions">
      <button class="btn btn--sm" @click="showCreate = false">取消</button>
      <button class="btn btn--sm btn--primary" :disabled="!form.displayName.trim() || entity.acting" @click="onCreate">创建</button>
    </div>
  </div>

  <!-- 搜索框 -->
  <div class="side-search">
    <svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>
    <input v-model="entity.query" placeholder="搜索实体 / 类型 / 标签…" />
  </div>

  <!-- 来源层过滤 -->
  <div class="layer-filters">
    <button
      v-for="l in GRAPH_LAYER_META" :key="l.key"
      class="layer-chip"
      :class="{ 'is-off': entity.hiddenLayers.has(l.key) }"
      :style="{ '--lc': l.color }"
      @click="entity.toggleLayer(l.key)"
    >{{ l.label }}</button>
  </div>

  <!-- 实体列表 -->
  <div class="side-body">
    <div v-if="entity.loading" class="es-desc" style="padding: var(--sp-3);">加载中…</div>
    <div v-else-if="entity.error" class="es-desc" style="padding: var(--sp-3); color: var(--warning);">{{ entity.error }}</div>
    <div v-else-if="entity.entities.length === 0" class="empty-state" style="height:auto;padding:var(--sp-6) var(--sp-3);">
      <div class="es-title" style="font-size:var(--fs-sm);">暂无实体</div>
      <div class="es-desc">点上方 + 新建实体，或让 AI 助手帮你提取</div>
    </div>
    <div v-else-if="groupedEntities.length === 0" class="es-desc" style="padding: var(--sp-3); color: var(--text-3);">无匹配实体</div>

    <template v-for="g in groupedEntities" :key="g.label">
      <div class="side-group">{{ g.label }} · {{ g.items.length }}</div>
      <div
        v-for="e in g.items" :key="e.id"
        class="entity-row"
        :class="{ 'is-selected': entity.selectedId === e.id }"
        @click="onSelect(e.id)"
      >
        <span class="status-dot" :class="'sd--' + e.status"></span>
        <div class="entity-info">
          <div class="entity-name">{{ e.name }}</div>
          <div class="entity-status">{{ e.statusLabel }}</div>
        </div>
        <!-- 按状态显示操作按钮 -->
        <div class="entity-ops" @click.stop>
          <button v-if="e.status === 'candidate'" class="op-btn" title="批准" :disabled="entity.acting" @click="onApprove(e)">批准</button>
          <button v-if="e.status === 'approved'" class="op-btn op--primary" title="确认注册进世界" :disabled="entity.acting" @click="onRegister(e)">注册</button>
          <button v-if="e.status !== 'registered' && e.status !== 'merged'" class="op-btn op--ghost" title="废弃" :disabled="entity.acting" @click="onDeprecate(e)">废弃</button>
        </div>
      </div>
    </template>
  </div>

  <!-- 待确认决策（底部） -->
  <div v-if="entity.pendingDecisions.length" class="decisions-panel">
    <div class="decisions-head">待确认 · {{ entity.pendingDecisions.length }}</div>
    <div v-for="d in entity.pendingDecisions" :key="d.id" class="decision-row">
      <div class="decision-title">{{ d.title }}</div>
      <button class="btn btn--sm btn--primary" :disabled="entity.acting" @click="onResolveDecision(d.id)">确认</button>
    </div>
  </div>
</template>

<style scoped>
.entity-count {
  font-size: var(--fs-xs); color: var(--text-3);
  background: var(--bg-3); padding: 1px 6px; border-radius: var(--r-pill);
}
/* 新建表单 */
.create-form {
  padding: var(--sp-2);
  border-bottom: 1px solid var(--border);
  display: flex; flex-direction: column; gap: 6px;
}
.form-input {
  width: 100%; background: var(--bg-input);
  border: 1px solid var(--border); border-radius: var(--r-sm);
  padding: 6px 8px; font-size: var(--fs-sm); color: var(--text);
  font-family: inherit;
}
.form-input:focus { outline: none; border-color: var(--border-focus); }
textarea.form-input { resize: vertical; }
.form-actions { display: flex; justify-content: flex-end; gap: 6px; }
/* 来源层过滤 */
.layer-filters { display: flex; flex-wrap: wrap; gap: 4px; padding: 0 var(--sp-2) var(--sp-1); }
.layer-chip {
  font-size: var(--fs-xs); padding: 2px 8px;
  border-radius: var(--r-pill);
  border: 1px solid color-mix(in srgb, var(--lc) 50%, transparent);
  color: var(--lc);
  background: color-mix(in srgb, var(--lc) 12%, transparent);
  cursor: pointer;
}
.layer-chip.is-off { opacity: 0.3; text-decoration: line-through; }
/* 实体分组+行 */
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
/* 操作按钮 */
.entity-ops { display: flex; gap: 2px; flex-shrink: 0; }
.op-btn {
  font-size: 10px; padding: 2px 6px;
  border: 1px solid var(--border-2); border-radius: var(--r-xs);
  background: var(--bg-elev); color: var(--text-2);
  cursor: pointer; white-space: nowrap;
}
.op-btn:hover:not(:disabled) { background: var(--bg-3); color: var(--text); }
.op-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.op--primary { background: var(--accent); color: var(--accent-fg); border-color: var(--accent); }
.op--ghost { background: transparent; color: var(--text-3); border-color: transparent; }
.op--ghost:hover:not(:disabled) { color: var(--warning); }
/* 待确认决策面板 */
.decisions-panel {
  border-top: 1px solid var(--border-2);
  background: var(--accent-bg);
  max-height: 200px; overflow-y: auto;
  flex-shrink: 0;
}
.decisions-head {
  font-size: var(--fs-xs); font-weight: 600;
  color: var(--accent); padding: 6px var(--sp-3);
  letter-spacing: 0.04em;
}
.decision-row {
  display: flex; align-items: center; gap: var(--sp-2);
  padding: 4px var(--sp-3);
}
.decision-title { flex: 1; font-size: var(--fs-xs); color: var(--text-2); }
</style>

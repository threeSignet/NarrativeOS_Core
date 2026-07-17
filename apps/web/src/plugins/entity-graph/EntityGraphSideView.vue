<script setup lang="ts">
// 实体关系侧栏——搜索 + 来源层过滤 + 实体列表（含审核操作）+ 待确认决策
import { ref, watch, computed } from 'vue';
import { useUiStore } from '../../stores/ui';
import { useEntityStore } from '../../stores/entity';
import { useToast } from '../../composables/useToast';
import type { EntityCard } from '../../api/entities';
import { GRAPH_LAYER_META, ENTITY_KIND_LABELS } from '../../utils/entityKinds';
import { RELATION_TYPE_OPTIONS } from '../../utils/relationTypes';
import {
  UiSideHead, UiButton, UiIcon, UiBadge, UiSearchBar, UiSideBody, UiPanelFooter,
  UiInlineForm, UiInput, UiSelect, UiTextArea, UiChip, UiStatusDot, UiEmpty,
} from '../../components';

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
  <UiSideHead title="实体关系">
    <template #actions>
      <UiButton icon variant="ghost" size="sm" title="新建实体" @click="showCreate = !showCreate">
        <UiIcon name="plus" :size="15" />
      </UiButton>
      <UiButton icon variant="ghost" size="sm" title="新建关系" :disabled="registeredEntities.length < 2" @click="showCreateRel = !showCreateRel">
        <UiIcon name="relationship" :size="15" />
      </UiButton>
      <UiBadge v-if="entity.entities.length" :text="entity.entities.length" />
    </template>
  </UiSideHead>

  <!-- 新建关系表单 -->
  <UiInlineForm v-model:open="showCreateRel">
    <UiSelect v-model="relForm.sourceId" :disabled="entity.acting">
      <option value="" disabled>选择源实体…</option>
      <option v-for="e in registeredEntities" :key="e.id" :value="e.id">{{ e.name }}（{{ e.typeLabel }}）</option>
    </UiSelect>
    <UiSelect v-model="relForm.targetId" :disabled="entity.acting">
      <option value="" disabled>选择目标实体…</option>
      <option v-for="e in registeredEntities" :key="e.id" :value="e.id">{{ e.name }}（{{ e.typeLabel }}）</option>
    </UiSelect>
    <UiSelect v-model="relForm.relationTypeId" :disabled="entity.acting">
      <option v-for="r in RELATION_TYPE_OPTIONS" :key="r.value" :value="r.value">{{ r.label }}</option>
    </UiSelect>
    <template #actions>
      <UiButton size="sm" :disabled="entity.acting" @click="showCreateRel = false">取消</UiButton>
      <UiButton variant="primary" size="sm" :disabled="!relForm.sourceId || !relForm.targetId || relForm.sourceId === relForm.targetId || entity.acting" @click="onCreateRelation">创建关系</UiButton>
    </template>
  </UiInlineForm>

  <!-- 新建实体表单 -->
  <UiInlineForm v-model:open="showCreate">
    <UiInput v-model="form.displayName" placeholder="实体名称（如：苏暮雪）" @enter="onCreate" />
    <UiSelect v-model="form.typeLabel">
      <option v-for="t in ENTITY_TYPES" :key="t" :value="t">{{ t }}</option>
    </UiSelect>
    <UiTextArea v-model="form.summary" placeholder="一句话描述（可选）" :rows="2" />
    <template #actions>
      <UiButton size="sm" :disabled="entity.acting" @click="showCreate = false">取消</UiButton>
      <UiButton variant="primary" size="sm" :disabled="!form.displayName.trim() || entity.acting" @click="onCreate">创建</UiButton>
    </template>
  </UiInlineForm>

  <!-- 搜索框 -->
  <UiSearchBar v-model="entity.query" placeholder="搜索实体 / 类型 / 标签…" />

  <!-- 来源层过滤 -->
  <div class="layer-filters">
    <UiChip
      v-for="l in GRAPH_LAYER_META" :key="l.key"
      :active="!entity.hiddenLayers.has(l.key)"
      :color="l.color"
      @click="entity.toggleLayer(l.key)"
    >{{ l.label }}</UiChip>
  </div>

  <!-- 实体列表 -->
  <UiSideBody>
    <div v-if="entity.loading" class="state-msg">加载中…</div>
    <div v-else-if="entity.error" class="state-msg is-error">{{ entity.error }}</div>
    <UiEmpty
      v-else-if="entity.entities.length === 0"
      title="暂无实体"
      description="点上方 + 新建实体，或让 AI 助手帮你提取"
    />
    <div v-else-if="groupedEntities.length === 0" class="state-msg">无匹配实体</div>

    <template v-for="g in groupedEntities" :key="g.label">
      <div class="side-group">{{ g.label }} · {{ g.items.length }}</div>
      <div
        v-for="e in g.items" :key="e.id"
        class="entity-row"
        :class="{ 'is-selected': entity.selectedId === e.id }"
        @click="onSelect(e.id)"
      >
        <UiStatusDot :status="e.status" />
        <div class="entity-info">
          <div class="entity-name">{{ e.name }}</div>
          <div class="entity-status">{{ e.statusLabel }}</div>
        </div>
        <!-- 按状态显示操作按钮 -->
        <div class="entity-ops" @click.stop>
          <UiButton v-if="e.status === 'candidate'" size="sm" title="批准" :disabled="entity.acting" @click="onApprove(e)">批准</UiButton>
          <UiButton v-if="e.status === 'approved'" variant="primary" size="sm" title="确认注册进世界" :disabled="entity.acting" @click="onRegister(e)">注册</UiButton>
          <UiButton v-if="e.status !== 'registered' && e.status !== 'merged'" variant="ghost" size="sm" title="废弃" :disabled="entity.acting" @click="onDeprecate(e)">废弃</UiButton>
        </div>
      </div>
    </template>
  </UiSideBody>

  <!-- 待确认决策（底部） -->
  <UiPanelFooter v-if="entity.pendingDecisions.length" :title="`待确认 · ${entity.pendingDecisions.length}`">
    <div v-for="d in entity.pendingDecisions" :key="d.id" class="decision-row">
      <div class="decision-title">{{ d.title }}</div>
      <UiButton variant="primary" size="sm" :disabled="entity.acting" @click="onResolveDecision(d.id)">确认</UiButton>
    </div>
  </UiPanelFooter>
</template>

<style scoped>
/* 来源层过滤容器 */
.layer-filters { display: flex; flex-wrap: wrap; gap: 4px; padding: 0 var(--sp-2) var(--sp-1); }

/* 状态消息（加载中/错误/无匹配） */
.state-msg { padding: var(--sp-3); font-size: var(--fs-sm); color: var(--text-3); }
.state-msg.is-error { color: var(--warning); }

/* 实体分组标题（与全局 .side-group 一致，scoped 保留确保上下文隔离） */
.side-group {
  font-size: var(--fs-xs); font-weight: 600;
  letter-spacing: 0.05em; text-transform: uppercase;
  color: var(--text-3);
  padding: var(--sp-3) var(--sp-3) var(--sp-1);
}
/* 实体行 */
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
.entity-ops { display: flex; gap: 2px; flex-shrink: 0; }

/* 决策行 */
.decision-row {
  display: flex; align-items: center; gap: var(--sp-2);
  padding: 4px var(--sp-3);
}
.decision-title { flex: 1; font-size: var(--fs-xs); color: var(--text-2); }
</style>

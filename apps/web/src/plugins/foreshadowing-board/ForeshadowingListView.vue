<script setup lang="ts">
// 伏笔看板侧栏——按状态分列 + 创建 + 状态推进（迭代 C1）
import { ref, watch } from 'vue';
import { useUiStore } from '../../stores/ui';
import { useForeshadowingStore } from '../../stores/foreshadowing';
import { useToast } from '../../composables/useToast';
import {
  UiSideHead, UiButton, UiIcon, UiBadge, UiEmpty, UiInlineForm, UiInput, UiTextArea, UiSelect, UiStatusDot,
} from '../../components';
import {
  FORESHADOWING_KIND_LABELS, FORESHADOWING_STATUS_LABELS, FORESHADOWING_STATUS_COLORS, STATUS_FLOW,
  type ForeshadowingKind, type ForeshadowingPlan, type ForeshadowingPlanStatus,
} from '../../api/foreshadowings';

const ui = useUiStore();
const fs = useForeshadowingStore();
const toast = useToast();

watch(() => [ui.activeActivity, ui.projectId] as const, async ([active, pid]) => {
  if (active === 'foreshadowing-board' && pid) await fs.loadPlans(pid);
}, { immediate: true });

// 创建表单
const showCreate = ref(false);
const newLabel = ref('');
const newKind = ref<ForeshadowingKind>('clue');
const newEffect = ref('');

const KIND_OPTIONS = Object.entries(FORESHADOWING_KIND_LABELS) as [ForeshadowingKind, string][];

async function onCreate() {
  if (!ui.projectId || !newLabel.value.trim()) return;
  try {
    await fs.create(ui.projectId, {
      label: newLabel.value.trim(),
      kind: newKind.value,
      targetReaderEffect: newEffect.value.trim(),
    });
    toast.success('已创建伏笔');
    newLabel.value = ''; newEffect.value = '';
    showCreate.value = false;
  } catch (e: any) {
    toast.error('创建失败：' + (e?.response?.data?.error || e?.message));
  }
}

// 推进状态：取下一个状态
function nextStatus(s: ForeshadowingPlanStatus): ForeshadowingPlanStatus | null {
  const idx = STATUS_FLOW.indexOf(s);
  if (idx < 0 || idx >= STATUS_FLOW.length - 1) return null;
  return STATUS_FLOW[idx + 1]!;
}

async function onAdvance(p: ForeshadowingPlan) {
  if (!ui.projectId) return;
  const next = nextStatus(p.status);
  if (!next) return;
  try {
    await fs.transition(ui.projectId, p.id, next);
    toast.success(`${p.label} → ${FORESHADOWING_STATUS_LABELS[next]}`);
  } catch (e: any) {
    toast.error('推进失败：' + (e?.message));
  }
}

async function onAbandon(p: ForeshadowingPlan) {
  if (!ui.projectId) return;
  try {
    await fs.transition(ui.projectId, p.id, 'abandoned');
    toast.success(`${p.label} 已放弃`);
  } catch (e: any) {
    toast.error('放弃失败：' + (e?.message));
  }
}

// 展示哪些状态列（主流程4列 + abandoned）
const DISPLAY_COLUMNS: ForeshadowingPlanStatus[] = [...STATUS_FLOW, 'abandoned'];
</script>

<template>
  <UiSideHead title="伏笔">
    <template #actions>
      <UiButton icon variant="ghost" size="sm" title="新建伏笔" @click="showCreate = !showCreate">
        <UiIcon name="plus" :size="15" />
      </UiButton>
      <UiBadge v-if="fs.plans.length" :text="fs.plans.length" />
    </template>
  </UiSideHead>

  <UiInlineForm v-model:open="showCreate">
    <UiInput v-model="newLabel" placeholder="伏笔标签（如：主角的神秘身世）" />
    <UiSelect v-model="newKind">
      <option v-for="[k, label] in KIND_OPTIONS" :key="k" :value="k">{{ label }}</option>
    </UiSelect>
    <UiTextArea v-model="newEffect" placeholder="目标读者效果（如：让读者怀疑主角身份）" :rows="2" />
    <template #actions>
      <UiButton size="sm" :disabled="fs.acting" @click="showCreate = false">取消</UiButton>
      <UiButton variant="primary" size="sm" :disabled="!newLabel.trim() || fs.acting" @click="onCreate">创建</UiButton>
    </template>
  </UiInlineForm>

  <div class="fs-side-body">
    <div v-if="fs.loading" class="state-msg">加载中…</div>
    <div v-else-if="fs.error" class="state-msg is-error">{{ fs.error }}</div>
    <UiEmpty
      v-else-if="fs.plans.length === 0"
      title="暂无伏笔"
      description="点上方 + 埋下第一个伏笔"
    />

    <!-- 按状态分列展示 -->
    <template v-for="status in DISPLAY_COLUMNS" :key="status">
      <div v-if="(fs.groupedByStatus.get(status) || []).length > 0">
        <div class="fs-group">
          <UiStatusDot :color="FORESHADOWING_STATUS_COLORS[status]" />
          <span>{{ FORESHADOWING_STATUS_LABELS[status] }}</span>
          <span class="fs-count">{{ (fs.groupedByStatus.get(status) || []).length }}</span>
        </div>
        <div v-for="p in fs.groupedByStatus.get(status)" :key="p.id" class="fs-card">
          <div class="fs-card-label">{{ p.label }}</div>
          <div class="fs-card-meta">
            <span class="fs-kind">{{ FORESHADOWING_KIND_LABELS[p.kind] }}</span>
          </div>
          <div v-if="p.targetReaderEffect" class="fs-card-effect">{{ p.targetReaderEffect }}</div>
          <div class="fs-card-ops">
            <UiButton
              v-if="nextStatus(p.status)"
              variant="ghost" size="sm"
              :disabled="fs.acting"
              @click="onAdvance(p)"
            >→ {{ FORESHADOWING_STATUS_LABELS[nextStatus(p.status)!] }}</UiButton>
            <UiButton
              v-if="!['paid_off', 'abandoned', 'archived'].includes(p.status)"
              variant="ghost" size="sm"
              :disabled="fs.acting"
              title="放弃此伏笔"
              @click="onAbandon(p)"
            >放弃</UiButton>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.fs-side-body { flex: 1; overflow-y: auto; }
.state-msg { padding: var(--sp-3); font-size: var(--fs-sm); color: var(--text-3); }
.state-msg.is-error { color: var(--warning); }

.fs-group {
  display: flex; align-items: center; gap: 6px;
  font-size: var(--fs-xs); font-weight: 600; color: var(--text-3);
  padding: var(--sp-3) var(--sp-3) var(--sp-1);
  letter-spacing: 0.04em;
}
.fs-count {
  margin-left: auto; font-size: 10px; color: var(--text-3);
  background: var(--bg-3); padding: 0 6px; border-radius: var(--r-pill);
}
.fs-card {
  margin: 0 var(--sp-2) var(--sp-1);
  padding: var(--sp-2) var(--sp-3);
  background: var(--bg-elev, var(--bg-2));
  border: 1px solid var(--border); border-radius: var(--r-sm);
  display: flex; flex-direction: column; gap: 4px;
}
.fs-card-label { font-size: var(--fs-sm); color: var(--text); font-weight: 500; }
.fs-card-meta { font-size: var(--fs-xs); }
.fs-kind { color: var(--accent); }
.fs-card-effect { font-size: var(--fs-xs); color: var(--text-2); line-height: 1.4; }
.fs-card-ops { display: flex; gap: 4px; margin-top: 4px; }
</style>

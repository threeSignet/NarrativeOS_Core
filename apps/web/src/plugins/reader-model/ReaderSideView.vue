<script setup lang="ts">
// 读者模型侧栏——群体列表 + 新建（迭代 C3）
import { ref, watch } from 'vue';
import { useUiStore } from '../../stores/ui';
import { useReaderStore } from '../../stores/reader';
import { useToast } from '../../composables/useToast';
import { UiSideHead, UiButton, UiIcon, UiBadge, UiEmpty, UiInlineForm, UiInput, UiSelect, UiStatusDot } from '../../components';
import { AUDIENCE_KIND_LABELS, type ReaderAudienceKind } from '../../api/readers';

const ui = useUiStore();
const reader = useReaderStore();
const toast = useToast();

watch(() => [ui.activeActivity, ui.projectId] as const, async ([active, pid]) => {
  if (active === 'reader-model' && pid) await reader.loadAudiences(pid);
}, { immediate: true });

const showCreate = ref(false);
const newLabel = ref('');
const newKind = ref<ReaderAudienceKind>('target_reader');
const KIND_OPTIONS = Object.entries(AUDIENCE_KIND_LABELS) as [ReaderAudienceKind, string][];

async function onCreate() {
  if (!ui.projectId || !newLabel.value.trim()) return;
  try {
    await reader.create(ui.projectId, { label: newLabel.value.trim(), kind: newKind.value });
    toast.success('已创建读者群体');
    newLabel.value = '';
    showCreate.value = false;
  } catch (e: any) { toast.error('创建失败：' + (e?.message)); }
}
</script>

<template>
  <UiSideHead title="读者">
    <template #actions>
      <UiButton icon variant="ghost" size="sm" title="新建读者群体" @click="showCreate = !showCreate">
        <UiIcon name="plus" :size="15" />
      </UiButton>
      <UiBadge v-if="reader.audiences.length" :text="reader.audiences.length" />
    </template>
  </UiSideHead>

  <UiInlineForm v-model:open="showCreate">
    <UiInput v-model="newLabel" placeholder="群体名称（如：核心读者）" />
    <UiSelect v-model="newKind">
      <option v-for="[k, label] in KIND_OPTIONS" :key="k" :value="k">{{ label }}</option>
    </UiSelect>
    <template #actions>
      <UiButton size="sm" :disabled="reader.acting" @click="showCreate = false">取消</UiButton>
      <UiButton variant="primary" size="sm" :disabled="!newLabel.trim() || reader.acting" @click="onCreate">创建</UiButton>
    </template>
  </UiInlineForm>

  <div class="reader-side-body">
    <div v-if="reader.loading" class="state-msg">加载中…</div>
    <div v-else-if="reader.error" class="state-msg is-error">{{ reader.error }}</div>
    <UiEmpty v-else-if="reader.audiences.length === 0" title="暂无读者群体" description="点上方 + 创建第一个群体" />
    <div
      v-for="a in reader.audiences" :key="a.id"
      class="audience-row"
      :class="{ 'is-selected': reader.selectedId === a.id }"
      @click="ui.projectId && reader.select(ui.projectId, a.id)"
    >
      <UiStatusDot color="var(--accent)" />
      <div class="audience-info">
        <div class="audience-label">{{ a.label }}</div>
        <div class="audience-kind">{{ AUDIENCE_KIND_LABELS[a.kind] }}</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.reader-side-body { flex: 1; overflow-y: auto; }
.state-msg { padding: var(--sp-3); font-size: var(--fs-sm); color: var(--text-3); }
.state-msg.is-error { color: var(--warning); }
.audience-row {
  display: flex; align-items: center; gap: var(--sp-2);
  padding: 6px var(--sp-3); cursor: pointer;
  border-left: 2px solid transparent;
}
.audience-row:hover { background: var(--bg-3); }
.audience-row.is-selected { background: var(--accent-bg); border-left-color: var(--accent); }
.audience-info { flex: 1; min-width: 0; }
.audience-label { font-size: var(--fs-sm); color: var(--text); }
.audience-kind { font-size: var(--fs-xs); color: var(--text-3); }
</style>

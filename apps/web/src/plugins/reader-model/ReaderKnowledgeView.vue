<script setup lang="ts">
// 读者认知主区——选中群体的认知状态列表 + 添加/编辑（迭代 C3）
import { ref, computed, watch } from 'vue';
import { useUiStore } from '../../stores/ui';
import { useReaderStore } from '../../stores/reader';
import { useToast } from '../../composables/useToast';
import { UiButton, UiEmpty, UiInput, UiSelect, UiStatusDot } from '../../components';
import { KNOWLEDGE_STATE_LABELS, KNOWLEDGE_STATE_COLORS, type ReaderKnowledgeStateValue } from '../../api/readers';

const ui = useUiStore();
const reader = useReaderStore();
const toast = useToast();

const selected = computed(() => reader.selected());

// 添加认知表单
const newSubject = ref('');
const newState = ref<ReaderKnowledgeStateValue>('suspected');
const STATE_OPTIONS = Object.entries(KNOWLEDGE_STATE_LABELS) as [ReaderKnowledgeStateValue, string][];

async function onAdd() {
  if (!ui.projectId || !newSubject.value.trim()) return;
  try {
    await reader.addKnowledge(ui.projectId, { subjectRef: newSubject.value.trim(), state: newState.value });
    toast.success('已添加认知');
    newSubject.value = '';
  } catch (e: any) { toast.error('添加失败：' + (e?.message)); }
}

async function onStateChange(kid: string, e: Event) {
  if (!ui.projectId) return;
  const val = (e.target as HTMLSelectElement).value as ReaderKnowledgeStateValue;
  try {
    await reader.editKnowledge(ui.projectId, kid, val);
  } catch (err: any) { toast.error('更新失败：' + err.message); }
}

// 选中群体变化时确保认知加载
watch(() => reader.selectedId, async (id) => {
  if (id && ui.projectId) await reader.loadKnowledge(ui.projectId, id);
});
</script>

<template>
  <div class="reader-knowledge-wrap">
    <UiEmpty
      v-if="!selected"
      block icon="chat"
      title="未选择读者群体"
      description="从左侧选择一个读者群体查看其认知状态"
    />

    <div v-else class="rk-content">
      <div class="rk-head">
        <h2 class="rk-title">{{ selected.label }}</h2>
        <span class="rk-meta">{{ reader.knowledgeStates.length }} 条认知</span>
      </div>

      <!-- 添加认知 -->
      <div class="rk-add">
        <UiInput v-model="newSubject" placeholder="认知主体（如：主角的真实身份）" @enter="onAdd" />
        <select class="state-select" v-model="newState">
          <option v-for="[s, label] in STATE_OPTIONS" :key="s" :value="s">{{ label }}</option>
        </select>
        <UiButton variant="primary" size="sm" :disabled="!newSubject.trim() || reader.acting" @click="onAdd">添加</UiButton>
      </div>

      <!-- 认知列表 -->
      <div v-if="reader.knowledgeStates.length === 0" class="rk-empty">该群体暂无认知记录</div>
      <div v-else class="rk-list">
        <div v-for="k in reader.knowledgeStates" :key="k.id" class="rk-item">
          <UiStatusDot :color="KNOWLEDGE_STATE_COLORS[k.state]" />
          <div class="rk-item-subject">{{ k.subjectRef }}</div>
          <select class="state-select sm" :value="k.state" @change="onStateChange(k.id, $event)">
            <option v-for="[s, label] in STATE_OPTIONS" :key="s" :value="s">{{ label }}</option>
          </select>
          <span class="rk-confidence">{{ Math.round(k.confidence * 100) }}%</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.reader-knowledge-wrap { height: 100%; overflow-y: auto; background: var(--bg); }
.rk-content { max-width: 760px; margin: 0 auto; padding: var(--sp-6) var(--sp-4); }
.rk-head { display: flex; align-items: baseline; gap: var(--sp-3); margin-bottom: var(--sp-4); padding-bottom: var(--sp-2); border-bottom: 1px solid var(--border); }
.rk-title { font-size: var(--fs-xl); font-weight: 600; color: var(--text); margin: 0; }
.rk-meta { font-size: var(--fs-sm); color: var(--text-3); }

.rk-add { display: flex; gap: var(--sp-2); margin-bottom: var(--sp-4); }
.rk-add .ui-input, .rk-add > div { flex: 1; }
.state-select {
  background: var(--bg-input); border: 1px solid var(--border); border-radius: var(--r-sm);
  padding: 5px 8px; font-size: var(--fs-sm); color: var(--text); font-family: inherit; min-width: 100px;
}
.state-select.sm { padding: 2px 6px; font-size: var(--fs-xs); min-width: 80px; }

.rk-empty { padding: var(--sp-6); text-align: center; color: var(--text-3); font-size: var(--fs-sm); }
.rk-list { display: flex; flex-direction: column; gap: 2px; }
.rk-item {
  display: flex; align-items: center; gap: var(--sp-2);
  padding: var(--sp-2) var(--sp-3);
  border-bottom: 1px solid var(--border);
}
.rk-item-subject { flex: 1; font-size: var(--fs-sm); color: var(--text); min-width: 0; }
.rk-confidence { font-size: var(--fs-xs); color: var(--text-3); font-family: var(--font-mono); min-width: 36px; text-align: right; }
</style>

<script setup lang="ts">
// 灵感详情编辑——主区视图，选中灵感后编辑 content/summary/tags/kind（迭代 B1）
import { ref, watch, computed } from 'vue';
import { useUiStore } from '../../stores/ui';
import { useIdeaStore } from '../../stores/idea';
import { useToast } from '../../composables/useToast';
import { UiButton, UiIcon, UiEmpty, UiInput, UiTextArea, UiSelect, UiStatusDot } from '../../components';
import { IDEA_KIND_LABELS, IDEA_MATURITY_LABELS, IDEA_MATURITY_COLORS, type IdeaKind } from '../../api/ideas';

const ui = useUiStore();
const idea = useIdeaStore();
const toast = useToast();

const selected = computed(() => idea.selected());

// 本地编辑态（选中变化时同步）
const content = ref('');
const summary = ref('');
const tagsText = ref('');
const kind = ref<IdeaKind>('premise');

watch(selected, (s) => {
  if (s) {
    content.value = s.content;
    summary.value = s.summary ?? '';
    tagsText.value = s.tags.join(', ');
    kind.value = s.kind;
  }
}, { immediate: true });

const KIND_OPTIONS = Object.entries(IDEA_KIND_LABELS) as [IdeaKind, string][];

async function onSave() {
  if (!ui.projectId || !selected.value) return;
  try {
    const tags = tagsText.value.split(/[,，]/).map((t) => t.trim()).filter(Boolean);
    await idea.edit(ui.projectId, selected.value.id, {
      content: content.value,
      summary: summary.value || null,
      tags,
      kind: kind.value,
    });
    toast.success('已保存');
  } catch (e: any) {
    toast.error('保存失败：' + (e?.response?.data?.error || e?.message));
  }
}

async function onRestore() {
  if (!ui.projectId || !selected.value) return;
  try {
    await idea.restore(ui.projectId, selected.value.id);
    toast.success('已恢复');
  } catch (e: any) {
    toast.error('恢复失败：' + (e?.message));
  }
}
</script>

<template>
  <div class="idea-detail-wrap">
    <UiEmpty
      v-if="!selected"
      block
      icon="chat"
      title="未选中灵感"
      description="从左侧选择一条灵感查看和编辑"
    />

    <div v-else class="idea-detail">
      <div class="detail-head">
        <UiStatusDot :color="IDEA_MATURITY_COLORS[selected.maturity]" />
        <span class="maturity-label">{{ IDEA_MATURITY_LABELS[selected.maturity] }}</span>
        <span class="dot-sep">·</span>
        <span class="kind-label">{{ IDEA_KIND_LABELS[selected.kind] }}</span>
        <div class="head-actions">
          <UiButton v-if="selected.maturity === 'archived'" variant="ghost" size="sm" @click="onRestore">恢复</UiButton>
          <UiButton variant="primary" size="sm" :disabled="idea.acting" @click="onSave">保存</UiButton>
        </div>
      </div>

      <div class="detail-section">
        <label class="field-label">内容</label>
        <UiTextArea v-model="content" :rows="6" placeholder="灵感内容…" />
      </div>

      <div class="detail-section">
        <label class="field-label">摘要（可选）</label>
        <UiInput v-model="summary" placeholder="一句话概括" />
      </div>

      <div class="detail-row">
        <div class="detail-section flex-1">
          <label class="field-label">类型</label>
          <UiSelect v-model="kind">
            <option v-for="[k, label] in KIND_OPTIONS" :key="k" :value="k">{{ label }}</option>
          </UiSelect>
        </div>
        <div class="detail-section flex-1">
          <label class="field-label">标签（逗号分隔）</label>
          <UiInput v-model="tagsText" placeholder="标签1, 标签2" />
        </div>
      </div>

      <div class="detail-meta">
        <div>创建：{{ new Date(selected.createdAt).toLocaleString('zh-CN') }}</div>
        <div>更新：{{ new Date(selected.updatedAt).toLocaleString('zh-CN') }}</div>
        <div v-if="selected.linkedDraftIds.length">已关联草案：{{ selected.linkedDraftIds.length }} 个</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.idea-detail-wrap { height: 100%; overflow-y: auto; background: var(--bg); }
.idea-detail { max-width: 720px; margin: 0 auto; padding: var(--sp-6) var(--sp-4); display: flex; flex-direction: column; gap: var(--sp-4); }

.detail-head {
  display: flex; align-items: center; gap: var(--sp-2);
  padding-bottom: var(--sp-3); border-bottom: 1px solid var(--border);
}
.maturity-label { font-size: var(--fs-sm); color: var(--text); font-weight: 500; }
.dot-sep { color: var(--text-3); }
.kind-label { font-size: var(--fs-sm); color: var(--accent); }
.head-actions { margin-left: auto; display: flex; gap: var(--sp-2); }

.detail-section { display: flex; flex-direction: column; gap: 6px; }
.detail-section.flex-1 { flex: 1; }
.detail-row { display: flex; gap: var(--sp-4); }
.field-label { font-size: var(--fs-xs); font-weight: 600; color: var(--text-3); letter-spacing: 0.04em; }

.detail-meta {
  font-size: var(--fs-xs); color: var(--text-3);
  padding-top: var(--sp-3); border-top: 1px solid var(--border);
  display: flex; flex-direction: column; gap: 2px;
}
</style>

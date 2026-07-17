<script setup lang="ts">
// 灵感板侧栏——灵感列表 + 捕捉/过滤/搜索（迭代 B1）
import { ref, watch, computed } from 'vue';
import { useUiStore } from '../../stores/ui';
import { useIdeaStore } from '../../stores/idea';
import { useToast } from '../../composables/useToast';
import {
  UiSideHead, UiButton, UiIcon, UiBadge, UiEmpty, UiInlineForm, UiInput, UiTextArea, UiSelect, UiSearchBar, UiStatusDot, UiChip,
} from '../../components';
import { IDEA_KIND_LABELS, IDEA_MATURITY_LABELS, IDEA_MATURITY_COLORS, type IdeaKind } from '../../api/ideas';

const ui = useUiStore();
const idea = useIdeaStore();
const toast = useToast();

watch(() => [ui.activeActivity, ui.projectId] as const, async ([active, pid]) => {
  if (active === 'idea-board' && pid) await idea.loadIdeas(pid);
}, { immediate: true });

// ===== 捕捉灵感表单 =====
const showCreate = ref(false);
const newContent = ref('');
const newKind = ref<IdeaKind>('premise');

async function onCapture() {
  if (!ui.projectId || !newContent.value.trim()) return;
  try {
    await idea.capture(ui.projectId, { content: newContent.value.trim(), kind: newKind.value });
    toast.success('已捕捉灵感');
    newContent.value = '';
    showCreate.value = false;
  } catch (e: any) {
    toast.error('捕捉失败：' + (e?.response?.data?.error || e?.message));
  }
}

// 类型过滤选项
const KIND_OPTIONS = Object.entries(IDEA_KIND_LABELS) as [IdeaKind, string][];

function toggleKindFilter(k: IdeaKind) {
  idea.kindFilter = idea.kindFilter === k ? null : k;
}

function onSelect(id: string) {
  idea.select(id);
}

async function onDiscard(id: string) {
  if (!ui.projectId) return;
  try {
    await idea.discard(ui.projectId, id);
    toast.success('已归档');
  } catch (e: any) {
    toast.error('归档失败：' + (e?.message));
  }
}
</script>

<template>
  <UiSideHead title="灵感">
    <template #actions>
      <UiButton icon variant="ghost" size="sm" title="捕捉灵感" @click="showCreate = !showCreate">
        <UiIcon name="plus" :size="15" />
      </UiButton>
      <UiBadge v-if="idea.ideas.length" :text="idea.ideas.length" />
    </template>
  </UiSideHead>

  <!-- 捕捉灵感表单 -->
  <UiInlineForm v-model:open="showCreate">
    <UiTextArea v-model="newContent" placeholder="记下闪现的灵感…" :rows="3" />
    <UiSelect v-model="newKind">
      <option v-for="[k, label] in KIND_OPTIONS" :key="k" :value="k">{{ label }}</option>
    </UiSelect>
    <template #actions>
      <UiButton size="sm" :disabled="idea.acting" @click="showCreate = false">取消</UiButton>
      <UiButton variant="primary" size="sm" :disabled="!newContent.trim() || idea.acting" @click="onCapture">捕捉</UiButton>
    </template>
  </UiInlineForm>

  <UiSearchBar v-model="idea.query" placeholder="搜索灵感内容/标签…" />

  <!-- 类型过滤 -->
  <div class="kind-filters">
    <UiChip
      :active="idea.kindFilter === null"
      @click="idea.kindFilter = null"
    >全部</UiChip>
    <UiChip
      v-for="[k, label] in KIND_OPTIONS" :key="k"
      :active="idea.kindFilter === k"
      @click="toggleKindFilter(k)"
    >{{ label }}</UiChip>
  </div>

  <!-- 灵感列表 -->
  <div class="idea-side-body">
    <div v-if="idea.loading" class="state-msg">加载中…</div>
    <div v-else-if="idea.error" class="state-msg is-error">{{ idea.error }}</div>
    <UiEmpty
      v-else-if="idea.ideas.length === 0"
      title="暂无灵感"
      description="点上方 + 捕捉第一个灵感"
    />
    <div v-else-if="idea.filteredIdeas.length === 0" class="state-msg">无匹配灵感</div>

    <div
      v-for="it in idea.filteredIdeas" :key="it.id"
      class="idea-row"
      :class="{ 'is-selected': idea.selectedId === it.id, 'is-archived': it.maturity === 'archived' }"
      @click="onSelect(it.id)"
    >
      <UiStatusDot :color="IDEA_MATURITY_COLORS[it.maturity]" />
      <div class="idea-info">
        <div class="idea-content">{{ it.content }}</div>
        <div class="idea-meta">
          <span class="kind-tag">{{ IDEA_KIND_LABELS[it.kind] }}</span>
          <span v-if="it.tags.length" class="tags">· {{ it.tags.join(' / ') }}</span>
        </div>
      </div>
      <div class="idea-ops" @click.stop>
        <UiButton v-if="it.maturity !== 'archived'" variant="ghost" size="sm" title="归档" :disabled="idea.acting" @click="onDiscard(it.id)">归档</UiButton>
      </div>
    </div>
  </div>

  <!-- 底部：显示归档开关 -->
  <div class="archive-toggle" @click="idea.showArchived = !idea.showArchived">
    <UiIcon :name="idea.showArchived ? 'chevron-down' : 'chevron-right'" :size="12" />
    <span>{{ idea.showArchived ? '隐藏' : '显示' }}归档({{ idea.ideas.filter(i => i.maturity === 'archived').length }})</span>
  </div>
</template>

<style scoped>
.kind-filters { display: flex; flex-wrap: wrap; gap: 4px; padding: 0 var(--sp-2) var(--sp-1); }
.idea-side-body { flex: 1; overflow-y: auto; }
.state-msg { padding: var(--sp-3); font-size: var(--fs-sm); color: var(--text-3); }
.state-msg.is-error { color: var(--warning); }

.idea-row {
  display: flex; align-items: flex-start; gap: var(--sp-2);
  padding: 8px var(--sp-3); cursor: pointer;
  border-left: 2px solid transparent;
  transition: background var(--t-fast);
}
.idea-row:hover { background: var(--bg-3); }
.idea-row.is-selected { background: var(--accent-bg); border-left-color: var(--accent); }
.idea-row.is-archived { opacity: 0.5; }
.idea-info { flex: 1; min-width: 0; }
.idea-content {
  font-size: var(--fs-sm); color: var(--text); line-height: 1.4;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
  overflow: hidden;
}
.idea-meta { font-size: var(--fs-xs); color: var(--text-3); margin-top: 2px; }
.kind-tag { color: var(--accent); }
.idea-ops { flex-shrink: 0; }

.archive-toggle {
  display: flex; align-items: center; gap: 4px;
  padding: 6px var(--sp-3); font-size: var(--fs-xs); color: var(--text-3);
  cursor: pointer; border-top: 1px solid var(--border);
}
.archive-toggle:hover { color: var(--text); background: var(--bg-3); }
</style>

<script setup lang="ts">
// 占位创建行——VS Code 式就地输入
// 挂载即聚焦并全选默认名；Enter 提交、Esc/失焦取消
import { ref, onMounted, nextTick } from 'vue';
import { useUiStore } from '../../stores/ui';
import { useDocumentStore } from '../../stores/document';

const props = defineProps<{
  /** 缩进深度 */
  depth: number;
  /** 文件夹 or 文档 */
  kind: 'folder' | 'document';
}>();

const ui = useUiStore();
const docs = useDocumentStore();

const value = ref(props.kind === 'folder' ? '新建文件夹' : '新建文档');
const inputEl = ref<HTMLInputElement | null>(null);

onMounted(async () => {
  await nextTick();
  inputEl.value?.focus();
  inputEl.value?.select();
});

async function commit() {
  const doc = await docs.commitCreate(ui.projectId, value.value);
  // 文档类型创建后直接打开编辑
  if (doc && props.kind === 'document') {
    ui.openTab({ docId: doc.id, title: doc.title, editorType: 'writing-document' });
  }
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter') { e.preventDefault(); commit(); }
  else if (e.key === 'Escape') { e.preventDefault(); docs.cancelCreate(); }
}

// 失焦取消（VS Code 行为：点别处 = 放弃）；但若值非空且非默认名，VS Code 会提交。
// 这里采取：失焦即取消（更简单可预测）。
function onBlur() {
  // 用 microtask 延迟，避免与 Enter 提交冲突
  setTimeout(() => {
    if (docs.pendingCreate) docs.cancelCreate();
  }, 0);
}
</script>

<template>
  <div class="create-row" :style="{ paddingLeft: depth * 14 + 'px' }">
    <span class="twisty placeholder"></span>
    <svg v-if="kind === 'folder'" class="node-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
    </svg>
    <svg v-else class="node-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" /><path d="M14 2v6h6" />
    </svg>
    <input
      ref="inputEl"
      v-model="value"
      class="create-input"
      :placeholder="kind === 'folder' ? '文件夹名称' : '文档名称'"
      @keydown="onKeydown"
      @blur="onBlur"
    />
  </div>
</template>

<style scoped>
.create-row {
  display: flex; align-items: center; gap: 4px;
  padding: 3px var(--sp-3) 3px 6px;
  background: var(--accent-bg);
  border-left: 2px solid var(--accent);
}
.twisty { width: 16px; height: 16px; flex-shrink: 0; }
.twisty.placeholder { width: 16px; }
.node-ico { width: 16px; height: 16px; color: var(--text-2); flex-shrink: 0; }
.create-input {
  flex: 1; min-width: 0;
  background: var(--bg-input);
  border: 1px solid var(--accent-border);
  border-radius: var(--r-xs);
  padding: 2px 6px;
  font-size: var(--fs-13); color: var(--text);
  font-family: var(--font-ui);
}
.create-input:focus { outline: none; border-color: var(--accent); }
</style>

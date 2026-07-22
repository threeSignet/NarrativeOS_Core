<script setup lang="ts">
// Agent 聊天面板——E3 协作可见性强化
// 作者随时知道 AI 在做什么、需要确认什么
import { ref, nextTick, watch, computed } from 'vue';
import { useAgentStore, type ToolCallRecord } from '../../stores/agent';
import { useUiStore } from '../../stores/ui';
import { renderMd } from '../../utils/miniMd';
import { listDecisions, resolveDecision, type PendingDecision } from '../../api/decisions';
import { UiSideHead, UiButton, UiIcon, UiEmpty, UiTextArea, UiStatusDot, UiBadge, UiChip } from '../../components';

const agent = useAgentStore();
const ui = useUiStore();

const input = ref('');
const bodyRef = ref<HTMLElement | null>(null);
const pendingDecisions = ref<PendingDecision[]>([]);
const resolvingId = ref<string | null>(null);

// ---- 工具标签 ----
const TOOL_LABELS: Record<string, string> = {
  propose_event: '推演事件', register_entity: '注册实体',
  detect_entity_hints: '检测实体', detect_relation_hints: '检测关系',
  get_graph_view: '查看图谱', get_entity_profile: '查看实体',
  get_context_slice: '查询上下文', query_world_state: '查询世界状态',
  commit_event: '提交事件', get_open_threads: '查看线索',
  resolve_thread: '解决线索', get_foreshadowing_plans: '查看伏笔',
  create_foreshadowing_plan: '创建伏笔', create_chapter_plan: '创建章节',
  create_scene_plan: '创建场景', get_timeline_view: '查看时间线',
  create_reader_knowledge_state: '创建读者认知', create_reveal_plan: '创建揭示计划',
  detect_spatial_nodes: '检测空间节点', get_spatial_view: '查看空间',
  get_prose_document: '查看正文', list_prose_documents: '列出文档',
  write_prose_block: '写入正文', get_style_guide: '查看风格',
  get_retcon_report: '查看追溯', export_project: '导出项目',
};
function toolLabel(name: string): string { return TOOL_LABELS[name] ?? name; }
function toolStatusColor(tc: ToolCallRecord): string {
  if (tc.success === null) return 'var(--st-candidate)';
  return tc.success ? 'var(--success)' : 'var(--danger)';
}

// ---- 决策相关 ----
const DECISION_KIND_LABELS: Record<string, string> = {
  confirm_entity: '确认实体注册', confirm_draft: '确认草案提交',
  confirm_proposal: '确认提案提交', confirm_retcon: '确认追溯修改',
  confirm_blueprint: '确认蓝图变更', confirm_rule: '确认规则变更',
  general: '待确认',
};

const lastAssistantMsg = computed(() => {
  for (let i = agent.messages.length - 1; i >= 0; i--) {
    if (agent.messages[i].role === 'assistant') return agent.messages[i];
  }
  return null;
});

const showDecisions = computed(() =>
  lastAssistantMsg.value?.status === 'needs_user_confirmation' && pendingDecisions.value.length > 0
);

const turnToolSummary = computed(() => {
  if (!lastAssistantMsg.value?.toolCalls?.length) return null;
  const calls = lastAssistantMsg.value.toolCalls;
  const ok = calls.filter(t => t.success === true).length;
  const fail = calls.filter(t => t.success === false).length;
  const pending = calls.filter(t => t.success === null).length;
  return { total: calls.length, ok, fail, pending };
});

// ---- 加载决策 ----
async function loadPendingDecisions() {
  if (!ui.projectId) return;
  try {
    const all = await listDecisions(ui.projectId);
    pendingDecisions.value = all.filter(d => d.status === 'open');
  } catch { pendingDecisions.value = []; }
}

// 当消息状态变为 needs_user_confirmation 时自动加载决策
watch(
  () => lastAssistantMsg.value?.status,
  async (status) => {
    if (status === 'needs_user_confirmation') await loadPendingDecisions();
    else pendingDecisions.value = [];
  },
);

async function onResolveDecision(id: string, action: 'resolve' | 'dismiss') {
  if (!ui.projectId) return;
  resolvingId.value = id;
  try {
    await resolveDecision(ui.projectId, id, action);
    pendingDecisions.value = pendingDecisions.value.filter(d => d.id !== id);
  } catch { /* toast handled by entity store */ }
  finally { resolvingId.value = null; }
}

// ---- 自动滚底 ----
async function scrollToBottom() {
  await nextTick();
  const el = bodyRef.value;
  if (el) el.scrollTop = el.scrollHeight;
}
watch(() => agent.messages.length, scrollToBottom);
watch(() => agent.messages.at(-1)?.content, scrollToBottom);
watch(() => pendingDecisions.value.length, scrollToBottom);

// ---- 输入 ----
async function onSend() {
  const text = input.value.trim();
  if (!text || agent.streaming) return;
  if (!ui.projectId) return;
  input.value = '';
  await agent.send(ui.projectId, text);
}
function onKeydown(e: KeyboardEvent) {
  if (e.isComposing) return;
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSend(); }
}
function onStop() { agent.stop(); }
function onClear() { agent.clear(); pendingDecisions.value = []; }
</script>

<template>
  <div class="agent-panel">
    <UiSideHead title="AI 助手">
      <template #actions>
        <UiBadge v-if="pendingDecisions.length" :text="pendingDecisions.length" />
        <UiButton icon variant="ghost" size="sm" title="清空对话" :disabled="agent.streaming" @click="onClear">
          <UiIcon name="trash" :size="15" />
        </UiButton>
      </template>
    </UiSideHead>

    <div ref="bodyRef" class="agent-body">
      <UiEmpty
        v-if="agent.messages.length === 0"
        icon="chat"
        title="和 AI 助手对话"
        description="问我关于设定、角色关系，或让我帮你梳理故事。"
      />

      <div
        v-for="msg in agent.messages"
        :key="msg.id"
        class="msg"
        :class="`msg--${msg.role}`"
      >
        <div class="msg-role">{{ msg.role === 'user' ? '我' : 'AI' }}</div>

        <!-- E3: 工具调用列表 -->
        <div v-if="msg.toolCalls && msg.toolCalls.length > 0" class="tool-calls">
          <div v-for="tc in msg.toolCalls" :key="tc.id" class="tool-call-row">
            <UiStatusDot :color="toolStatusColor(tc)" :size="8" />
            <span class="tool-name">{{ toolLabel(tc.toolName) }}</span>
            <span v-if="tc.success !== null" class="tool-status" :class="tc.success ? 'is-ok' : 'is-fail'">
              {{ tc.success ? '完成' : '失败' }}
            </span>
            <span v-else class="tool-status is-running">执行中…</span>
          </div>
        </div>

        <div class="msg-content">
          <span v-if="msg.role === 'user'" class="msg-text">{{ msg.content }}</span>
          <span v-else class="msg-md" v-html="renderMd(msg.content)"></span>
          <span v-if="msg.streaming" class="msg-cursor">▋</span>
        </div>
      </div>

      <!-- E3: 待确认决策面板 -->
      <div v-if="showDecisions" class="decisions-panel">
        <div class="decisions-head">
          <UiIcon name="alert" :size="14" />
          <span>需要你确认（{{ pendingDecisions.length }} 项）</span>
        </div>
        <div v-for="d in pendingDecisions" :key="d.id" class="decision-card">
          <div class="decision-kind">{{ DECISION_KIND_LABELS[d.kind] ?? d.kind }}</div>
          <div class="decision-title">{{ d.title }}</div>
          <div v-if="d.description" class="decision-desc">{{ d.description }}</div>
          <div class="decision-actions">
            <UiButton size="sm" variant="ghost" :disabled="resolvingId === d.id" @click="onResolveDecision(d.id, 'dismiss')">
              拒绝
            </UiButton>
            <UiButton size="sm" variant="primary" :disabled="resolvingId === d.id" @click="onResolveDecision(d.id, 'resolve')">
              确认
            </UiButton>
          </div>
        </div>
      </div>

      <!-- E3: 回合工具摘要 -->
      <div v-if="turnToolSummary && !agent.streaming && !showDecisions" class="turn-summary">
        <span class="summary-text">
          本轮调用了 {{ turnToolSummary.total }} 个工具
          <span v-if="turnToolSummary.ok">，{{ turnToolSummary.ok }} 个成功</span>
          <span v-if="turnToolSummary.fail" class="fail-count">，{{ turnToolSummary.fail }} 个失败</span>
        </span>
      </div>
    </div>

    <div class="agent-input">
      <UiTextArea
        v-model="input"
        class="agent-textarea"
        placeholder="输入消息…（Enter 发送，Shift+Enter 换行）"
        :rows="3"
        :no-resize="true"
        :disabled="agent.streaming"
        @keydown="onKeydown"
      />
      <div class="agent-input-actions">
        <span v-if="agent.streaming" class="agent-status">生成中…</span>
        <UiButton v-if="agent.streaming" size="sm" @click="onStop">停止</UiButton>
        <UiButton v-else variant="primary" size="sm" :disabled="!input.trim() || !ui.projectId" @click="onSend">发送</UiButton>
      </div>
    </div>
  </div>
</template>

<style scoped>
.agent-panel { display: flex; flex-direction: column; height: 100%; background: var(--bg-2); }
.agent-body { flex: 1; overflow-y: auto; padding: var(--sp-2); display: flex; flex-direction: column; gap: var(--sp-2); }

/* 消息 */
.msg { display: flex; flex-direction: column; gap: 4px; max-width: 92%; }
.msg--user { align-self: flex-end; align-items: flex-end; }
.msg--assistant { align-self: flex-start; align-items: flex-start; }
.msg-role { font-size: var(--fs-xs); color: var(--text-3); padding: 0 2px; }
.msg-content {
  padding: 8px 12px; border-radius: var(--r-md);
  font-size: var(--fs-sm); line-height: 1.55; white-space: pre-wrap; word-break: break-word;
}
.msg--user .msg-content { background: var(--accent); color: var(--accent-fg); border-bottom-right-radius: 4px; }
.msg--assistant .msg-content { background: var(--bg-3); color: var(--text); border-bottom-left-radius: 4px; }
.msg-text { display: inline; }
.msg-md { display: inline; }
.msg-md :deep(h1) { font-size: var(--fs-md); font-weight: 600; margin: 0.5em 0 0.3em; }
.msg-md :deep(h2) { font-size: var(--fs-sm); font-weight: 600; margin: 0.5em 0 0.3em; }
.msg-md :deep(h3) { font-size: var(--fs-sm); font-weight: 600; margin: 0.4em 0 0.2em; color: var(--text-2); }
.msg-md :deep(strong) { font-weight: 600; }
.msg-md :deep(code) { font-family: var(--font-mono); font-size: 0.9em; background: var(--bg-3); padding: 1px 4px; border-radius: 3px; }
.msg-md :deep(pre) { background: var(--bg-3); padding: 8px 10px; border-radius: var(--r-sm); margin: 6px 0; overflow-x: auto; }
.msg-md :deep(pre code) { background: none; padding: 0; }
.msg-md :deep(ul) { margin: 4px 0; padding-left: 1.4em; }
.msg-md :deep(li) { margin: 2px 0; }
.msg-md :deep(hr) { border: none; border-top: 1px solid var(--border); margin: 8px 0; }
.msg-md :deep(p) { margin: 0; }
.msg-cursor { display: inline-block; margin-left: 1px; color: var(--text-3); animation: cursor-blink 1s step-end infinite; }
@keyframes cursor-blink { 50% { opacity: 0; } }

/* 工具调用 */
.tool-calls { display: flex; flex-direction: column; gap: 2px; padding: 4px 8px; background: var(--bg); border-radius: var(--r-sm); border: 1px solid var(--border); max-width: 100%; }
.tool-call-row { display: flex; align-items: center; gap: var(--sp-1); font-size: var(--fs-xs); }
.tool-name { color: var(--text-2); font-family: var(--font-mono); }
.tool-status { margin-left: auto; }
.tool-status.is-ok { color: var(--success); }
.tool-status.is-fail { color: var(--danger); }
.tool-status.is-running { color: var(--st-candidate); animation: pulse 1.5s ease-in-out infinite; }
@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.5; } }

/* E3: 待确认决策面板 */
.decisions-panel {
  background: var(--bg); border: 1px solid var(--warning); border-radius: var(--r-sm);
  padding: var(--sp-2); display: flex; flex-direction: column; gap: var(--sp-2);
}
.decisions-head { display: flex; align-items: center; gap: var(--sp-1); font-size: var(--fs-xs); font-weight: 600; color: var(--warning); }
.decision-card { padding: var(--sp-2); background: var(--bg-2); border-radius: var(--r-sm); border-left: 3px solid var(--warning); }
.decision-kind { font-size: 10px; padding: 0 6px; border-radius: var(--r-pill); background: var(--bg-3); color: var(--text-2); display: inline-block; margin-bottom: 4px; }
.decision-title { font-size: var(--fs-sm); color: var(--text); font-weight: 500; }
.decision-desc { font-size: var(--fs-xs); color: var(--text-3); margin-top: 2px; }
.decision-actions { display: flex; gap: var(--sp-1); margin-top: var(--sp-1); justify-content: flex-end; }

/* E3: 回合摘要 */
.turn-summary { padding: 4px var(--sp-2); text-align: center; }
.summary-text { font-size: var(--fs-xs); color: var(--text-3); }
.fail-count { color: var(--danger); }

/* 输入区 */
.agent-input { flex-shrink: 0; padding: var(--sp-2); border-top: 1px solid var(--border); display: flex; flex-direction: column; gap: var(--sp-2); }
.agent-textarea { padding: 8px 10px !important; line-height: 1.5; }
.agent-input-actions { display: flex; align-items: center; justify-content: flex-end; gap: var(--sp-2); }
.agent-status { font-size: var(--fs-xs); color: var(--text-3); margin-right: auto; }
</style>

<script setup lang="ts">
// Agent 聊天面板（右侧 dock）——VS Code 式右侧面板
// E1：工具调用过程对用户可见（检测实体/建议关系/生成决策）
import { ref, nextTick, watch } from 'vue';
import { useAgentStore, type ToolCallRecord } from '../../stores/agent';
import { useUiStore } from '../../stores/ui';
import { renderMd } from '../../utils/miniMd';
import { UiSideHead, UiButton, UiIcon, UiEmpty, UiTextArea, UiStatusDot } from '../../components';

const agent = useAgentStore();
const ui = useUiStore();

const input = ref('');
const bodyRef = ref<HTMLElement | null>(null);

/** 工具名中文映射 */
const TOOL_LABELS: Record<string, string> = {
  propose_event: '推演事件',
  register_entity: '注册实体',
  detect_entity_hints: '检测实体',
  detect_relation_hints: '检测关系',
  get_graph_view: '查看图谱',
  get_entity_profile: '查看实体',
  get_context_slice: '查询上下文',
  query_world_state: '查询世界状态',
  commit_event: '提交事件',
  get_open_threads: '查看线索',
  resolve_thread: '解决线索',
  get_foreshadowing_plans: '查看伏笔',
  create_foreshadowing_plan: '创建伏笔',
  create_chapter_plan: '创建章节',
  create_scene_plan: '创建场景',
  get_timeline_view: '查看时间线',
  create_reader_knowledge_state: '创建读者认知',
  create_reveal_plan: '创建揭示计划',
  detect_spatial_nodes: '检测空间节点',
  get_spatial_view: '查看空间',
  get_prose_document: '查看正文',
  list_prose_documents: '列出文档',
  write_prose_block: '写入正文',
  get_style_guide: '查看风格',
  get_retcon_report: '查看追溯',
  export_project: '导出项目',
};

function toolLabel(name: string): string {
  return TOOL_LABELS[name] ?? name;
}

function toolStatusColor(tc: ToolCallRecord): string {
  if (tc.success === null) return 'var(--st-candidate)'; // 进行中
  return tc.success ? 'var(--success)' : 'var(--danger)';
}

/** 自动滚到底（新消息 / 流式 token 增长时） */
async function scrollToBottom() {
  await nextTick();
  const el = bodyRef.value;
  if (el) el.scrollTop = el.scrollHeight;
}
watch(() => agent.messages.length, scrollToBottom);
// 监听最后一条消息内容变化（流式 token 累积时持续滚动）
watch(
  () => agent.messages.at(-1)?.content,
  scrollToBottom,
);

async function onSend() {
  const text = input.value.trim();
  if (!text || agent.streaming) return;
  if (!ui.projectId) return;
  input.value = '';
  await agent.send(ui.projectId, text);
}

function onKeydown(e: KeyboardEvent) {
  if (e.isComposing) return;
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    onSend();
  }
}

function onStop() { agent.stop(); }
function onClear() { agent.clear(); }
</script>

<template>
  <div class="agent-panel">
    <UiSideHead title="AI 助手">
      <template #actions>
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

        <!-- E1: 工具调用列表（assistant 消息内嵌） -->
        <div v-if="msg.toolCalls && msg.toolCalls.length > 0" class="tool-calls">
          <div
            v-for="tc in msg.toolCalls" :key="tc.id"
            class="tool-call-row"
          >
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
        <div v-if="msg.status === 'needs_user_confirmation'" class="msg-pending">
          ⏳ Agent 产出了待确认的提案，审核功能即将上线
        </div>
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
.agent-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg-2);
}

.agent-body {
  flex: 1;
  overflow-y: auto;
  padding: var(--sp-2);
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}

/* 消息气泡 */
.msg {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-width: 92%;
}
.msg--user { align-self: flex-end; align-items: flex-end; }
.msg--assistant { align-self: flex-start; align-items: flex-start; }

.msg-role {
  font-size: var(--fs-xs);
  color: var(--text-3);
  padding: 0 2px;
}
.msg-content {
  padding: 8px 12px;
  border-radius: var(--r-md);
  font-size: var(--fs-sm);
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
}
.msg--user .msg-content {
  background: var(--accent);
  color: var(--accent-fg);
  border-bottom-right-radius: 4px;
}
.msg--assistant .msg-content {
  background: var(--bg-3);
  color: var(--text);
  border-bottom-left-radius: 4px;
}
.msg-text { display: inline; }
.msg-md { display: inline; }
.msg-md :deep(h1) { font-size: var(--fs-md); font-weight: 600; margin: 0.5em 0 0.3em; }
.msg-md :deep(h2) { font-size: var(--fs-sm); font-weight: 600; margin: 0.5em 0 0.3em; }
.msg-md :deep(h3) { font-size: var(--fs-sm); font-weight: 600; margin: 0.4em 0 0.2em; color: var(--text-2); }
.msg-md :deep(strong) { font-weight: 600; }
.msg-md :deep(em) { font-style: italic; }
.msg-md :deep(code) {
  font-family: var(--font-mono); font-size: 0.9em;
  background: var(--bg-3); padding: 1px 4px; border-radius: 3px;
}
.msg-md :deep(pre) {
  background: var(--bg-3); padding: 8px 10px; border-radius: var(--r-sm);
  margin: 6px 0; overflow-x: auto;
}
.msg-md :deep(pre code) { background: none; padding: 0; }
.msg-md :deep(ul) { margin: 4px 0; padding-left: 1.4em; }
.msg-md :deep(li) { margin: 2px 0; }
.msg-md :deep(hr) { border: none; border-top: 1px solid var(--border); margin: 8px 0; }
.msg-md :deep(p) { margin: 0; }

/* E1: 工具调用列表 */
.tool-calls {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 4px 8px;
  background: var(--bg);
  border-radius: var(--r-sm);
  border: 1px solid var(--border);
  max-width: 100%;
}
.tool-call-row {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  font-size: var(--fs-xs);
}
.tool-name {
  color: var(--text-2);
  font-family: var(--font-mono);
}
.tool-status { margin-left: auto; }
.tool-status.is-ok { color: var(--success); }
.tool-status.is-fail { color: var(--danger); }
.tool-status.is-running { color: var(--st-candidate); animation: pulse 1.5s ease-in-out infinite; }
@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.5; } }

/* 流式光标 */
.msg-cursor {
  display: inline-block;
  margin-left: 1px;
  color: var(--text-3);
  animation: cursor-blink 1s step-end infinite;
}
@keyframes cursor-blink { 50% { opacity: 0; } }

/* 待确认提示 */
.msg-pending {
  font-size: var(--fs-xs);
  color: var(--warning);
  padding: 4px 2px;
}

/* 输入区 */
.agent-input {
  flex-shrink: 0;
  padding: var(--sp-2);
  border-top: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
.agent-textarea {
  padding: 8px 10px !important;
  line-height: 1.5;
}
.agent-input-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--sp-2);
}
.agent-status {
  font-size: var(--fs-xs);
  color: var(--text-3);
  margin-right: auto;
}
</style>

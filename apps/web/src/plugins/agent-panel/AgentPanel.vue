<script setup lang="ts">
// Agent 聊天面板（右侧 dock）——VS Code 式右侧面板
// 里程碑①：最小可用聊天 UI。消息列表（用户/助手）+ 输入框 + 流式渲染 + 停止按钮。
// 里程碑③起：status=needs_user_confirmation 时在此弹出 Proposal Review 入口。
import { ref, nextTick, watch } from 'vue';
import { useAgentStore } from '../../stores/agent';
import { useUiStore } from '../../stores/ui';
import { renderMd } from '../../utils/miniMd';
import { UiSideHead, UiButton, UiIcon, UiEmpty, UiTextArea } from '../../components';

const agent = useAgentStore();
const ui = useUiStore();

const input = ref('');
const bodyRef = ref<HTMLElement | null>(null);

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
  if (!ui.projectId) return; // 无激活项目，不发
  input.value = '';
  await agent.send(ui.projectId, text);
}

/** Enter 发送，Shift+Enter 换行（中文输入法 composing 中不触发） */
function onKeydown(e: KeyboardEvent) {
  if (e.isComposing) return;
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    onSend();
  }
}

function onStop() {
  agent.stop();
}

function onClear() {
  agent.clear();
}
</script>

<template>
  <div class="agent-panel">
    <!-- 顶部标题栏（复用 UiSideHead） -->
    <UiSideHead title="AI 助手">
      <template #actions>
        <UiButton icon variant="ghost" size="sm" title="清空对话" :disabled="agent.streaming" @click="onClear">
          <UiIcon name="trash" :size="15" />
        </UiButton>
      </template>
    </UiSideHead>

    <!-- 消息列表 -->
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
        <div class="msg-content">
          <!-- user 消息纯文本；assistant 消息渲染 Markdown（流式 token 实时渲染） -->
          <span v-if="msg.role === 'user'" class="msg-text">{{ msg.content }}</span>
          <span v-else class="msg-md" v-html="renderMd(msg.content)"></span>
          <span v-if="msg.streaming" class="msg-cursor">▋</span>
        </div>
        <!-- 待确认提示（里程碑③接审核 UI；里程碑①仅提示） -->
        <div v-if="msg.status === 'needs_user_confirmation'" class="msg-pending">
          ⏳ Agent 产出了待确认的提案，审核功能即将上线
        </div>
      </div>
    </div>

    <!-- 输入区 -->
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
/* Markdown 渲染样式（assistant 消息） */
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

/* 流式光标（闪烁） */
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
/* 输入框微调：比 UiTextArea 默认略大 padding + 行距，聊天场景更舒适 */
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

<script setup lang="ts">
// 风格指南主区——示例 + 禁用表达（迭代 D3）
import { ref, computed } from 'vue';
import { useUiStore } from '../../stores/ui';
import { useStyleStore } from '../../stores/style';
import { useToast } from '../../composables/useToast';
import { UiButton, UiEmpty, UiInput, UiTextArea, UiChip } from '../../components';
import { EXAMPLE_KIND_LABELS, EXAMPLE_KIND_COLORS, type StyleExampleKind } from '../../api/styles';

const ui = useUiStore();
const style = useStyleStore();
const toast = useToast();

// ---- 示例 ----
const showExampleForm = ref(false);
const exampleKind = ref<StyleExampleKind>('positive');
const exampleText = ref('');
const exampleNote = ref('');

async function onCreateExample() {
  if (!ui.projectId || !exampleText.value.trim()) return;
  try {
    await style.createExample(ui.projectId, exampleKind.value, exampleText.value.trim(), exampleNote.value.trim() || undefined);
    toast.success('已添加示例');
    exampleText.value = ''; exampleNote.value = ''; showExampleForm.value = false;
  } catch (e: any) { toast.error('添加失败：' + e?.message); }
}

// ---- 禁用表达 ----
const showBannedForm = ref(false);
const bannedPattern = ref('');
const bannedReason = ref('');
const bannedCategory = ref('');

async function onCreateBanned() {
  if (!ui.projectId || !bannedPattern.value.trim()) return;
  try {
    await style.createBanned(ui.projectId, bannedPattern.value.trim(), bannedReason.value.trim() || undefined, bannedCategory.value.trim() || undefined);
    toast.success('已添加禁用表达');
    bannedPattern.value = ''; bannedReason.value = ''; bannedCategory.value = ''; showBannedForm.value = false;
  } catch (e: any) { toast.error('添加失败：' + e?.message); }
}

// 按 kind 分组示例
const positiveExamples = computed(() => style.examples.filter(e => e.kind === 'positive'));
const negativeExamples = computed(() => style.examples.filter(e => e.kind === 'negative'));
</script>

<template>
  <div class="style-detail-wrap">
    <UiEmpty v-if="!style.loading && !style.guide" block icon="chat" title="未加载风格指南" description="从左侧选择或等待自动创建" />

    <div v-else class="sd-content">
      <!-- 风格示例区 -->
      <div class="sd-section">
        <div class="section-head">
          <span class="section-title">风格示例（{{ style.examples.length }}）</span>
          <UiButton variant="ghost" size="sm" @click="showExampleForm = !showExampleForm">+ 添加</UiButton>
        </div>

        <div v-if="showExampleForm" class="inline-form">
          <div class="form-row">
            <UiChip :active="exampleKind === 'positive'" @click="exampleKind = 'positive'">
              <span :style="{ color: EXAMPLE_KIND_COLORS.positive }">正向</span>
            </UiChip>
            <UiChip :active="exampleKind === 'negative'" @click="exampleKind = 'negative'">
              <span :style="{ color: EXAMPLE_KIND_COLORS.negative }">反向</span>
            </UiChip>
          </div>
          <UiTextArea v-model="exampleText" :rows="3" placeholder="粘贴一段风格示例文本…" />
          <UiInput v-model="exampleNote" placeholder="备注（可选）" />
          <div class="form-actions">
            <UiButton size="sm" @click="showExampleForm = false">取消</UiButton>
            <UiButton variant="primary" size="sm" :disabled="!exampleText.trim()" @click="onCreateExample">添加</UiButton>
          </div>
        </div>

        <div v-if="positiveExamples.length" class="example-group">
          <div class="group-label" :style="{ color: EXAMPLE_KIND_COLORS.positive }">正向示例（像这样写）</div>
          <div v-for="ex in positiveExamples" :key="ex.id" class="example-card">
            <div class="example-text">{{ ex.text }}</div>
            <div v-if="ex.note" class="example-note">{{ ex.note }}</div>
          </div>
        </div>

        <div v-if="negativeExamples.length" class="example-group">
          <div class="group-label" :style="{ color: EXAMPLE_KIND_COLORS.negative }">反向示例（不要这样写）</div>
          <div v-for="ex in negativeExamples" :key="ex.id" class="example-card is-negative">
            <div class="example-text">{{ ex.text }}</div>
            <div v-if="ex.note" class="example-note">{{ ex.note }}</div>
          </div>
        </div>

        <UiEmpty v-if="!style.examples.length && !showExampleForm" title="暂无示例" description="添加正向/反向示例帮助 AI 理解你的风格" />
      </div>

      <!-- 禁用表达区 -->
      <div class="sd-section">
        <div class="section-head">
          <span class="section-title">禁用表达（{{ style.banned.length }}）</span>
          <UiButton variant="ghost" size="sm" @click="showBannedForm = !showBannedForm">+ 添加</UiButton>
        </div>

        <div v-if="showBannedForm" class="inline-form">
          <UiInput v-model="bannedPattern" placeholder="禁用的表达模式（如：不由得、心中暗道）" />
          <UiInput v-model="bannedReason" placeholder="原因（可选）" />
          <UiInput v-model="bannedCategory" placeholder="分类（如：套路句、网络腔）" />
          <div class="form-actions">
            <UiButton size="sm" @click="showBannedForm = false">取消</UiButton>
            <UiButton variant="primary" size="sm" :disabled="!bannedPattern.trim()" @click="onCreateBanned">添加</UiButton>
          </div>
        </div>

        <div v-for="b in style.banned" :key="b.id" class="banned-card">
          <div class="banned-pattern">{{ b.pattern }}</div>
          <div class="banned-meta">
            <span v-if="b.category" class="banned-cat">{{ b.category }}</span>
            <span v-if="b.reason" class="banned-reason">{{ b.reason }}</span>
          </div>
        </div>

        <UiEmpty v-if="!style.banned.length && !showBannedForm" title="暂无禁用表达" description="添加套路句、网络腔等禁用表达模式" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.style-detail-wrap { height: 100%; overflow-y: auto; background: var(--bg); }
.sd-content { max-width: 720px; margin: 0 auto; padding: var(--sp-6) var(--sp-4); display: flex; flex-direction: column; gap: var(--sp-6); }
.sd-section { display: flex; flex-direction: column; gap: var(--sp-3); }
.section-head { display: flex; align-items: center; justify-content: space-between; }
.section-title { font-size: var(--fs-sm); font-weight: 600; color: var(--text); }
.inline-form { display: flex; flex-direction: column; gap: var(--sp-2); padding: var(--sp-3); background: var(--bg-2); border-radius: var(--r-sm); }
.form-row { display: flex; gap: 4px; }
.form-actions { display: flex; gap: var(--sp-2); justify-content: flex-end; }
.example-group { display: flex; flex-direction: column; gap: var(--sp-2); }
.group-label { font-size: var(--fs-xs); font-weight: 600; letter-spacing: 0.04em; }
.example-card {
  padding: var(--sp-3); border-radius: var(--r-sm);
  border-left: 3px solid var(--success); background: var(--bg-2);
}
.example-card.is-negative { border-left-color: var(--danger); }
.example-text { font-size: var(--fs-sm); color: var(--text); line-height: 1.6; white-space: pre-wrap; }
.example-note { font-size: var(--fs-xs); color: var(--text-3); margin-top: 4px; }
.banned-card {
  padding: var(--sp-2) var(--sp-3); border-radius: var(--r-sm);
  background: var(--bg-2); border-left: 3px solid var(--danger);
}
.banned-pattern { font-size: var(--fs-sm); color: var(--text); font-family: var(--font-mono); }
.banned-meta { display: flex; gap: var(--sp-2); margin-top: 2px; }
.banned-cat { font-size: 10px; padding: 0 6px; border-radius: var(--r-pill); background: var(--bg-3); color: var(--text-2); }
.banned-reason { font-size: var(--fs-xs); color: var(--text-3); }
</style>

<script setup lang="ts">
// 帮助模态——承载「关于 NarrativeOS」和「快捷键」两项。
// kind='about' 显示关于；kind='shortcuts' 显示快捷键列表。
// 复用 NewProjectModal 的模态样式约定（mask/box/title/actions）。
import { ref, watch, nextTick } from 'vue';

const props = defineProps<{ open: boolean; kind: 'about' | 'shortcuts' }>();
const emit = defineEmits<{ (e: 'close'): void }>();

const boxEl = ref<HTMLDivElement | null>(null);

watch(() => props.open, async (v) => {
  if (v) { await nextTick(); boxEl.value?.focus(); }
});

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') emit('close');
}

// 快捷键清单：只列实际存在的。编辑器/对话框内的 Enter/Esc 是真实的；
// 全局快捷键（Ctrl+S/B 等）尚未实现，标注「计划中」避免误导。
const shortcuts = [
  { keys: 'Enter', desc: '对话框中确认 / 编辑器中换行', scope: '通用' },
  { keys: 'Esc', desc: '关闭对话框 / 取消编辑', scope: '通用' },
  { keys: 'Ctrl/Cmd + S', desc: '保存当前文档（计划中）', scope: '编辑器', planned: true },
  { keys: 'Ctrl/Cmd + B', desc: '切换侧栏显隐（计划中）', scope: '视图', planned: true },
];
</script>

<template>
  <transition name="modal">
    <div v-if="open" class="modal-mask" @click.self="emit('close')">
      <div ref="boxEl" class="modal-box help-box" tabindex="0" @keydown="onKeydown">
        <!-- 关于 -->
        <template v-if="kind === 'about'">
          <div class="about-logo">
            <svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="var(--accent)" stroke-width="1.8" stroke-linejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2.5" />
              <rect x="7" y="7" width="10" height="10" rx="1.5" />
              <circle cx="12" cy="12" r="1.8" fill="var(--accent)" stroke="none" />
            </svg>
          </div>
          <h2 class="modal-title about-title">NarrativeOS</h2>
          <p class="about-version">起草工作台 · v0.1</p>
          <p class="about-desc">
            面向长篇叙事写作的世界状态一致性引擎。追踪设定、角色状态、伏笔与知识可见性，确保长篇写作中不出现设定矛盾。
          </p>
          <p class="about-tech">Core 引擎 + 写作层 + 起草工作台前端</p>
        </template>

        <!-- 快捷键 -->
        <template v-else>
          <h2 class="modal-title">快捷键</h2>
          <div class="shortcut-list">
            <div v-for="(s, i) in shortcuts" :key="i" class="shortcut-row">
              <div class="shortcut-keys">
                <kbd v-for="(k, ki) in s.keys.split(' + ')" :key="ki">
                  {{ k }}
                  <span v-if="ki < s.keys.split(' + ').length - 1" class="plus"> + </span>
                </kbd>
                <span v-if="s.planned" class="planned-tag">计划中</span>
              </div>
              <div class="shortcut-desc">
                <span class="desc-text">{{ s.desc }}</span>
                <span class="desc-scope">{{ s.scope }}</span>
              </div>
            </div>
          </div>
        </template>

        <div class="modal-actions">
          <button class="btn btn--primary" @click="emit('close')">关闭</button>
        </div>
      </div>
    </div>
  </transition>
</template>

<style scoped>
.modal-mask {
  position: fixed; inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex; align-items: center; justify-content: center;
  z-index: 300;
}
.modal-box {
  width: 480px; max-width: 92vw;
  background: var(--bg-elev);
  border: 1px solid var(--border-2);
  border-radius: var(--r-md);
  box-shadow: var(--shadow-pop);
  padding: var(--sp-5);
}
.modal-title { font-size: var(--fs-lg); font-weight: 600; margin-bottom: var(--sp-2); }

/* 关于 */
.about-logo { display: flex; justify-content: center; margin-bottom: var(--sp-3); }
.about-title { text-align: center; margin-bottom: var(--sp-1); }
.about-version { text-align: center; color: var(--text-3); font-size: var(--fs-sm); font-family: var(--font-mono); margin-bottom: var(--sp-4); }
.about-desc { color: var(--text-2); font-size: var(--fs-sm); line-height: 1.7; margin-bottom: var(--sp-3); }
.about-tech { color: var(--text-3); font-size: var(--fs-xs); text-align: center; }

/* 快捷键 */
.shortcut-list { display: flex; flex-direction: column; gap: var(--sp-2); margin: var(--sp-3) 0; }
.shortcut-row {
  display: flex; align-items: center; justify-content: space-between;
  padding: var(--sp-2) var(--sp-3);
  background: var(--bg-2); border-radius: var(--r-sm);
  border: 1px solid var(--border);
}
.shortcut-keys { display: flex; align-items: center; gap: 4px; flex-shrink: 0; }
kbd {
  display: inline-flex; align-items: center;
  padding: 2px 8px; min-width: 28px;
  background: var(--bg-elev); border: 1px solid var(--border-2);
  border-bottom-width: 2px; border-radius: var(--r-xs);
  font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--text);
}
.plus { color: var(--text-3); margin: 0 2px; }
.planned-tag {
  margin-left: 6px; padding: 1px 6px;
  font-size: 10px; color: var(--warning, #e0a800);
  border: 1px solid currentColor; border-radius: var(--r-xs);
  opacity: .8;
}
.shortcut-desc { display: flex; flex-direction: column; align-items: flex-end; gap: 2px; text-align: right; }
.desc-text { font-size: var(--fs-sm); color: var(--text); }
.desc-scope { font-size: var(--fs-xs); color: var(--text-3); }

.modal-actions {
  display: flex; justify-content: flex-end; gap: var(--sp-2);
  margin-top: var(--sp-5);
}

.modal-enter-active, .modal-leave-active { transition: opacity var(--t); }
.modal-enter-from, .modal-leave-to { opacity: 0; }
.modal-enter-active .modal-box, .modal-leave-active .modal-box { transition: transform var(--t); }
.modal-enter-from .modal-box, .modal-leave-to .modal-box { transform: scale(0.96); }
</style>

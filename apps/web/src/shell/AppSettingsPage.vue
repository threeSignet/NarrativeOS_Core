<script setup lang="ts">
// =============================================================================
// 应用设置页——VS Code 式全局设置（左导航 + 右表单）
// =============================================================================
// 与项目设置页（ProjectSettingsPage）的区别：
//   - 本页放「与软件相关、跨项目」的设置：编辑器外观、主题、自动保存、AI 配置
//   - 项目设置页只留项目专属（标题/前提/导出）
// 用户决策（要求②）：左下角齿轮 → 打开本页；后续 AI 配置也归这里。
//
// 分区：编辑器 / 外观 / 数据 / AI 配置
// 所有偏好经 usePreferences 读写，即时应用到 DOM（CSS 变量 + data-theme）。
// =============================================================================
import { ref } from 'vue';
import {
  usePreferences,
  type Theme, type EditorFontFamily,
} from '../composables/usePreferences';
import { useLocalDraftsStore } from '../stores/localDrafts';
import { useToast } from '../composables/useToast';

const { prefs, set } = usePreferences();
const local = useLocalDraftsStore();
const toast = useToast();

const activeSection = ref<'editor' | 'appearance' | 'data' | 'ai'>('editor');

// ---------- 编辑器外观 ----------
const fontSizes = [14, 15, 16, 17, 18, 19, 20];
const fontFamilies: Array<{ value: EditorFontFamily; label: string; sample: string }> = [
  { value: 'serif', label: '衬线（Newsreader）', sample: '沈墨站在青云峰顶' },
  { value: 'sans', label: '无衬线（IBM Plex Sans）', sample: '沈墨站在青云峰顶' },
  { value: 'mono', label: '等宽（IBM Plex Mono）', sample: '沈墨站在青云峰顶' },
];

// ---------- 数据：清理本地草稿缓存 ----------
function clearLocalCache() {
  const n = local.clearAll();
  toast.success(n > 0 ? `已清理 ${n} 份本地草稿缓存` : '本地没有未同步的草稿');
}
</script>

<template>
  <div class="settings-page">
    <!-- 标题已在 tab 上显示，无需重复头部栏 -->

    <div class="sp-body">
      <!-- 左侧分栏导航 -->
      <nav class="sp-nav">
        <button class="sp-nav-item" :class="{ on: activeSection === 'editor' }" @click="activeSection = 'editor'">编辑器</button>
        <button class="sp-nav-item" :class="{ on: activeSection === 'appearance' }" @click="activeSection = 'appearance'">外观</button>
        <button class="sp-nav-item" :class="{ on: activeSection === 'data' }" @click="activeSection = 'data'">数据</button>
        <button class="sp-nav-item" :class="{ on: activeSection === 'ai' }" @click="activeSection = 'ai'">
          AI 配置 <span class="sp-nav-tag">即将</span>
        </button>
      </nav>

      <!-- 右侧内容 -->
      <div class="sp-content">
        <!-- 编辑器 -->
        <section v-if="activeSection === 'editor'" class="sp-section">
          <h2>编辑器</h2>

          <!-- 字号 -->
          <div class="sp-field">
            <label>正文字号</label>
            <div class="seg">
              <button
                v-for="s in fontSizes"
                :key="s"
                :class="{ on: prefs.editorFontSize === s }"
                @click="set('editorFontSize', s)"
              >{{ s }}</button>
            </div>
            <span class="sp-hint-inline">当前 {{ prefs.editorFontSize }}px</span>
          </div>

          <!-- 行距 -->
          <div class="sp-field">
            <label>行距 <span class="sp-val">{{ prefs.editorLineHeight.toFixed(1) }}</span></label>
            <input
              type="range" min="1.4" max="2.4" step="0.1"
              :value="prefs.editorLineHeight"
              @input="set('editorLineHeight', Number(($event.target as HTMLInputElement).value))"
              class="sp-range"
            />
          </div>

          <!-- 段间距 -->
          <div class="sp-field">
            <label>段间距 <span class="sp-val">{{ prefs.editorParaGap }}px</span></label>
            <input
              type="range" min="0" max="28" step="2"
              :value="prefs.editorParaGap"
              @input="set('editorParaGap', Number(($event.target as HTMLInputElement).value))"
              class="sp-range"
            />
          </div>

          <!-- 编辑器宽度 -->
          <div class="sp-field">
            <label>编辑器宽度</label>
            <div class="seg">
              <button :class="{ on: prefs.editorWidth === 640 }" @click="set('editorWidth', 640)">窄</button>
              <button :class="{ on: prefs.editorWidth === 720 }" @click="set('editorWidth', 720)">标准</button>
              <button :class="{ on: prefs.editorWidth === 820 }" @click="set('editorWidth', 820)">宽</button>
            </div>
          </div>

          <!-- 字体族 -->
          <div class="sp-field">
            <label>字体</label>
            <div class="font-list">
              <button
                v-for="f in fontFamilies"
                :key="f.value"
                class="font-card"
                :class="{ on: prefs.editorFontFamily === f.value, ['font-' + f.value]: true }"
                @click="set('editorFontFamily', f.value)"
              >
                <span class="font-label">{{ f.label }}</span>
                <span class="font-sample">{{ f.sample }}</span>
              </button>
            </div>
          </div>

          <!-- 自动保存 -->
          <div class="sp-field">
            <label>自动保存</label>
            <div class="sp-toggle-row">
              <button
                class="sp-switch"
                :class="{ on: prefs.autosaveEnabled }"
                @click="set('autosaveEnabled', !prefs.autosaveEnabled)"
                :aria-pressed="prefs.autosaveEnabled"
              ><span class="sp-switch-knob"></span></button>
              <span class="sp-hint-inline">开启后，编辑会自动暂存本地并同步到数据库</span>
            </div>
          </div>

          <div class="sp-field" v-if="prefs.autosaveEnabled">
            <label>自动保存间隔 <span class="sp-val">{{ prefs.autosaveIntervalMs }}ms</span></label>
            <input
              type="range" min="500" max="5000" step="500"
              :value="prefs.autosaveIntervalMs"
              @input="set('autosaveIntervalMs', Number(($event.target as HTMLInputElement).value))"
              class="sp-range"
            />
            <span class="sp-hint-inline">防抖时长：停止输入后多久触发保存</span>
          </div>
        </section>

        <!-- 外观 -->
        <section v-else-if="activeSection === 'appearance'" class="sp-section">
          <h2>外观</h2>
          <div class="sp-field">
            <label>主题</label>
            <div class="seg">
              <button :class="{ on: prefs.theme === 'dark' }" @click="set('theme', 'dark' as Theme)">深色</button>
              <button :class="{ on: prefs.theme === 'light' }" @click="set('theme', 'light' as Theme)">浅色</button>
            </div>
          </div>
        </section>

        <!-- 数据 -->
        <section v-else-if="activeSection === 'data'" class="sp-section">
          <h2>数据</h2>
          <p class="sp-hint">
            编辑器在离线或保存失败时，会把正文暂存到浏览器本地（localStorage）。<br>
            网络恢复后会自动同步回数据库。可在此手动清理这些本地缓存。
          </p>
          <button class="btn btn--ghost btn--sm" @click="clearLocalCache">清理本地草稿缓存</button>
        </section>

        <!-- AI 配置（占位） -->
        <section v-else-if="activeSection === 'ai'" class="sp-section">
          <h2>AI 配置 <span class="sp-tag">即将推出</span></h2>
          <p class="sp-hint">接入 Agent 后，可在此配置模型、API Key、Agent 行为开关等。</p>
        </section>
      </div>
    </div>
  </div>
</template>

<style scoped>
.settings-page { height: 100%; display: flex; flex-direction: column; background: var(--bg); }
.sp-head {
  display: flex; align-items: center; gap: var(--sp-2);
  height: var(--h-main-header); padding: 0 var(--sp-3);
  border-bottom: 1px solid var(--border);
  background: var(--bg-2);
}
.sp-head-title { font-size: var(--fs-sm); color: var(--text-2); }

.sp-body { flex: 1; display: flex; overflow: hidden; }
.sp-nav {
  width: 200px; flex-shrink: 0;
  padding: var(--sp-3) var(--sp-2);
  border-right: 1px solid var(--border);
  overflow-y: auto;
}
.sp-nav-item {
  display: flex; align-items: center; gap: 6px;
  width: 100%; text-align: left;
  padding: 7px 10px;
  font-size: var(--fs-sm); color: var(--text-2);
  border-radius: var(--r-sm);
  transition: background var(--t-fast), color var(--t-fast);
}
.sp-nav-item:hover { background: var(--bg-3); color: var(--text); }
.sp-nav-item.on { background: var(--accent-bg); color: var(--accent); }
.sp-nav-tag { font-size: 10px; color: var(--text-3); border: 1px solid var(--border-2); padding: 0 5px; border-radius: var(--r-pill); }

.sp-content { flex: 1; overflow-y: auto; padding: var(--sp-6); }
.sp-section { max-width: 560px; }
.sp-section h2 { font-size: var(--fs-lg); font-weight: 600; margin-bottom: var(--sp-5); }
.sp-field { margin-bottom: var(--sp-4); }
.sp-field label {
  display: flex; align-items: center; justify-content: space-between;
  font-size: var(--fs-xs); color: var(--text-3);
  margin-bottom: var(--sp-2);
  text-transform: uppercase; letter-spacing: .04em;
}
.sp-val { font-family: var(--font-mono); color: var(--accent); text-transform: none; letter-spacing: 0; }
.sp-hint { font-size: var(--fs-sm); color: var(--text-3); line-height: 1.7; margin-bottom: var(--sp-3); }
.sp-hint code { font-family: var(--font-mono); background: var(--bg-3); padding: 1px 5px; border-radius: var(--r-xs); }
.sp-hint-inline { font-size: var(--fs-xs); color: var(--text-3); margin-left: var(--sp-2); }
.sp-tag { font-size: 10px; color: var(--text-3); border: 1px solid var(--border-2); padding: 1px 6px; border-radius: var(--r-pill); font-weight: 400; margin-left: 6px; vertical-align: middle; }

.seg { display: inline-flex; border: 1px solid var(--border); border-radius: var(--r-sm); overflow: hidden; }
.seg button { padding: 5px 14px; font-size: var(--fs-xs); color: var(--text-2); }
.seg button.on { background: var(--accent); color: var(--accent-fg); }

/* 滑块 */
.sp-range {
  width: 100%; max-width: 360px;
  accent-color: var(--accent);
  cursor: pointer;
}

/* 开关 */
.sp-toggle-row { display: flex; align-items: center; gap: var(--sp-2); }
.sp-switch {
  width: 38px; height: 22px; border-radius: var(--r-pill);
  background: var(--border-2); position: relative;
  transition: background var(--t-fast); flex-shrink: 0;
}
.sp-switch.on { background: var(--accent); }
.sp-switch-knob {
  position: absolute; top: 2px; left: 2px;
  width: 18px; height: 18px; border-radius: 50%;
  background: #fff; transition: transform var(--t-fast);
  box-shadow: 0 1px 3px rgba(0,0,0,.3);
}
.sp-switch.on .sp-switch-knob { transform: translateX(16px); }

/* 字体卡片 */
.font-list { display: flex; flex-direction: column; gap: var(--sp-2); max-width: 460px; }
.font-card {
  display: flex; align-items: center; justify-content: space-between;
  padding: var(--sp-2) var(--sp-3);
  border: 1px solid var(--border); border-radius: var(--r-md);
  background: var(--bg-input); text-align: left;
  transition: border-color var(--t-fast), background var(--t-fast);
}
.font-card:hover { border-color: var(--border-2); }
.font-card.on { border-color: var(--accent); background: var(--accent-bg); }
.font-label { font-size: var(--fs-sm); color: var(--text); }
.font-sample { font-size: var(--fs-md); color: var(--text-2); }
/* 各字体卡片的示例文字用对应字体渲染 */
.font-serif .font-sample { font-family: 'Newsreader', Georgia, serif; }
.font-sans .font-sample { font-family: 'IBM Plex Sans', sans-serif; }
.font-mono .font-sample { font-family: 'IBM Plex Mono', monospace; }
</style>

// =============================================================================
// usePreferences——用户偏好统一读写（主题 / 编辑器外观 / 自动保存）
// =============================================================================
// 职责：
//   - 收敛原本散落在 ProjectSettingsPage 的 localStorage 读写
//   - 提供启动期一次性应用（applyPreferencesAtBoot）：修复主题闪烁 bug
//   - 提供 get/set 工具：setPreference 即写 localStorage 又即时应用到 DOM
//
// 偏好项与默认值（与 AppSettingsPage 一一对应）：
//   theme                 'dark' | 'light'   默认 'dark'
//   editorFontSize        number(px)          默认 17
//   editorLineHeight      number              默认 1.8
//   editorParaGap         number(px)          默认 8
//   editorWidth           number(px)          默认 720
//   editorFontFamily      'serif'|'sans'|'mono' 默认 'serif'
//   autosaveEnabled       boolean             默认 true
//   autosaveIntervalMs    number              默认 1000
// =============================================================================

import { ref } from 'vue';

export type Theme = 'dark' | 'light';
export type EditorFontFamily = 'serif' | 'sans' | 'mono';

export interface PreferenceKeys {
  theme: Theme;
  editorFontSize: number;
  editorLineHeight: number;
  editorParaGap: number;
  editorWidth: number;
  editorFontFamily: EditorFontFamily;
  autosaveEnabled: boolean;
  autosaveIntervalMs: number;
}

/** 默认值表 */
export const PREFERENCE_DEFAULTS: PreferenceKeys = {
  theme: 'dark',
  editorFontSize: 17,
  editorLineHeight: 1.8,
  editorParaGap: 8,
  editorWidth: 720,
  editorFontFamily: 'serif',
  autosaveEnabled: true,
  autosaveIntervalMs: 1000,
};

// 响应式镜像（AppSettingsPage 绑定 v-model）
const prefs = ref<PreferenceKeys>({ ...PREFERENCE_DEFAULTS });
let hydrated = false;

/** 把 localStorage 值读进 prefs（带类型与默认值兜底） */
function hydrate(): void {
  if (hydrated) return;
  hydrated = true;
  try {
    const t = localStorage.getItem('theme');
    if (t === 'dark' || t === 'light') prefs.value.theme = t;
    prefs.value.editorFontSize = num('editorFontSize', PREFERENCE_DEFAULTS.editorFontSize, 12, 26);
    prefs.value.editorLineHeight = num('editorLineHeight', PREFERENCE_DEFAULTS.editorLineHeight, 1.3, 2.6);
    prefs.value.editorParaGap = num('editorParaGap', PREFERENCE_DEFAULTS.editorParaGap, 0, 32);
    prefs.value.editorWidth = num('editorWidth', PREFERENCE_DEFAULTS.editorWidth, 560, 1000);
    const fam = localStorage.getItem('editorFontFamily');
    if (fam === 'serif' || fam === 'sans' || fam === 'mono') prefs.value.editorFontFamily = fam;
    prefs.value.autosaveEnabled = localStorage.getItem('autosaveEnabled') !== 'false';
    prefs.value.autosaveIntervalMs = num('autosaveIntervalMs', PREFERENCE_DEFAULTS.autosaveIntervalMs, 500, 10000);
  } catch { /* 隐私模式等：用默认值 */ }
}

function num(key: string, fallback: number, min: number, max: number): number {
  const v = Number(localStorage.getItem(key));
  if (!Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, v));
}

// ---------------------------------------------------------------------------
// 应用到 DOM
// ---------------------------------------------------------------------------

/** 把当前 prefs 应用到 documentElement（主题 + CSS 变量） */
function applyToDom(): void {
  const root = document.documentElement;
  root.setAttribute('data-theme', prefs.value.theme);
  const style = root.style;
  style.setProperty('--fs-editor', `${prefs.value.editorFontSize}px`);
  style.setProperty('--editor-line-height', String(prefs.value.editorLineHeight));
  style.setProperty('--editor-para-gap', `${prefs.value.editorParaGap}px`);
  style.setProperty('--editor-width', `${prefs.value.editorWidth}px`);
  style.setProperty('--editor-font-family', fontFamilyValue(prefs.value.editorFontFamily));
}

function fontFamilyValue(fam: EditorFontFamily): string {
  switch (fam) {
    case 'sans': return "'IBM Plex Sans', -apple-system, 'Segoe UI', sans-serif";
    case 'mono': return "'IBM Plex Mono', 'JetBrains Mono', Consolas, monospace";
    case 'serif':
    default: return "'Newsreader', Georgia, 'Times New Roman', serif";
  }
}

// ---------------------------------------------------------------------------
// 启动期：在 Vue mount 前调用，消除主题闪烁
// ---------------------------------------------------------------------------

/** 应用启动时调用一次：读 localStorage → 应用到 DOM（先于首屏渲染） */
export function applyPreferencesAtBoot(): void {
  hydrate();
  applyToDom();
}

// ---------------------------------------------------------------------------
// 公共 API
// ---------------------------------------------------------------------------

/** 读单项偏好（带默认值兜底，供非组件代码如 sync-engine 用） */
export function getPreference<K extends keyof PreferenceKeys>(key: K, defaultValue: PreferenceKeys[K]): PreferenceKeys[K] {
  if (!hydrated) hydrate();
  const v = prefs.value[key];
  // 未设置或为空时回退默认值（注释承诺的"默认值兜底"，签名补齐 defaultValue 参数）
  return (v === undefined || v === null || v === '') ? defaultValue : v;
}

/** 写单项偏好：存 localStorage + 即时应用 DOM + 更新响应式镜像 */
export function setPreference<K extends keyof PreferenceKeys>(key: K, value: PreferenceKeys[K]): void {
  if (!hydrated) hydrate();
  prefs.value[key] = value;
  try {
    localStorage.setItem(key, String(value));
  } catch { /* ignore */ }
  applyToDom();
}

/** 组合式入口：返回响应式 prefs，组件用 v-model 绑定 */
export function usePreferences() {
  if (!hydrated) hydrate();
  return {
    prefs,
    set: setPreference,
    apply: applyToDom,
  };
}

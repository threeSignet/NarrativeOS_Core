<script setup lang="ts">
// 项目设置页——主区页面形态（VS Code Settings 式）
// 仅保留项目专属：项目信息（标题/前提）+ 数据备份（导出）。
// 界面偏好 / 编辑器外观 / AI 配置 已迁至 AppSettingsPage（左下角齿轮）。
import { ref, watch } from 'vue';
import { useUiStore } from '../stores/ui';
import { updateProject, exportProject } from '../api/projects';
import { useToast } from '../composables/useToast';

const ui = useUiStore();
const toast = useToast();

// 当前激活的设置分区
const activeSection = ref<'info' | 'data'>('info');

// ---------- 项目信息表单 ----------
const formTitle = ref('');
const formPremise = ref('');
const saving = ref(false);

// 同步当前项目信息
watch(() => ui.projectId, () => {
  const p = ui.projects.find(x => x.id === ui.projectId);
  formTitle.value = ui.projectTitle;
  formPremise.value = p?.premise ?? '';
}, { immediate: true });

async function saveProjectInfo() {
  if (!formTitle.value.trim()) { toast.error('项目名不能为空'); return; }
  saving.value = true;
  try {
    const updated = await updateProject(ui.projectId, {
      title: formTitle.value.trim(),
      premise: formPremise.value,
    });
    ui.projectTitle = updated.title;
    const idx = ui.projects.findIndex(p => p.id === updated.id);
    if (idx !== -1) ui.projects[idx] = updated;
    toast.success('项目信息已保存');
  } catch (err: any) {
    toast.error('保存失败：' + (err?.response?.data?.error || '未知错误'));
  } finally {
    saving.value = false;
  }
}

// ---------- 数据备份 ----------
const exporting = ref(false);
async function exportData() {
  exporting.value = true;
  try {
    await exportProject(ui.projectId, ui.projectTitle || '未命名作品');
    toast.success('设定集已导出');
  } catch (err: any) {
    toast.error('导出失败：' + (err?.response?.data?.error || '未知错误'));
  } finally {
    exporting.value = false;
  }
}
</script>

<template>
  <div class="settings-page">
    <!-- 标题已在 tab 上显示，无需重复头部栏 -->

    <div class="sp-body">
      <!-- 左侧分栏导航 -->
      <nav class="sp-nav">
        <button class="sp-nav-item" :class="{ on: activeSection === 'info' }" @click="activeSection = 'info'">项目信息</button>
        <button class="sp-nav-item" :class="{ on: activeSection === 'data' }" @click="activeSection = 'data'">数据与备份</button>
      </nav>

      <!-- 右侧内容 -->
      <div class="sp-content">
        <!-- 项目信息 -->
        <section v-if="activeSection === 'info'" class="sp-section">
          <h2>项目信息</h2>
          <div class="sp-field">
            <label>作品名称</label>
            <input v-model="formTitle" class="sp-input" placeholder="作品名称" />
          </div>
          <div class="sp-field">
            <label>一句话前提</label>
            <textarea v-model="formPremise" class="sp-input" rows="3" placeholder="这个故事讲的是…（用于后续 Agent 初始化世界观）"></textarea>
          </div>
          <button class="btn btn--primary btn--sm" :disabled="saving" @click="saveProjectInfo">
            {{ saving ? '保存中…' : '保存' }}
          </button>
        </section>

        <!-- 数据与备份 -->
        <section v-else-if="activeSection === 'data'" class="sp-section">
          <h2>数据与备份</h2>
          <p class="sp-hint">
            所有数据存储在本地 SQLite 数据库（BFF 的 <code>data/drafting.db</code>）。<br>
            可导出当前项目的全部设定文档为 Markdown 文件。
          </p>
          <button class="btn btn--primary btn--sm" :disabled="exporting" @click="exportData">
            {{ exporting ? '导出中…' : '导出设定集（Markdown）' }}
          </button>
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
  display: block; font-size: var(--fs-xs); color: var(--text-3);
  margin-bottom: var(--sp-1);
  text-transform: uppercase; letter-spacing: .04em;
}
.sp-input {
  width: 100%; padding: 8px 10px;
  background: var(--bg-input); border: 1px solid var(--border);
  border-radius: var(--r-sm); color: var(--text); font-size: var(--fs-sm);
  font-family: var(--font-ui); resize: vertical;
}
.sp-input:focus { outline: none; border-color: var(--accent); }
.sp-hint { font-size: var(--fs-sm); color: var(--text-3); line-height: 1.7; margin-bottom: var(--sp-3); }
.sp-hint code { font-family: var(--font-mono); background: var(--bg-3); padding: 1px 5px; border-radius: var(--r-xs); }
.sp-tag { font-size: 10px; color: var(--text-3); border: 1px solid var(--border-2); padding: 1px 6px; border-radius: var(--r-pill); font-weight: 400; margin-left: 6px; vertical-align: middle; }

.seg { display: inline-flex; border: 1px solid var(--border); border-radius: var(--r-sm); overflow: hidden; }
.seg button { padding: 5px 14px; font-size: var(--fs-xs); color: var(--text-2); }
.seg button.on { background: var(--accent); color: var(--accent-fg); }
</style>

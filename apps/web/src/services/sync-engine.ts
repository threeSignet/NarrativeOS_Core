// =============================================================================
// SyncEngine——编辑器保存中枢（要求③：自动保存 + 离线双写 + 网络恢复回放）
// =============================================================================
// 三层写入模型（设计文档 §21.1 / §33.3）：
//   1. 防抖（默认 1s，可由偏好 autosaveIntervalMs 配置）聚合频繁编辑
//   2. 写 localDrafts（轻、同步、永远成功）——离线时的真相源
//   3. 写 BFF（重、含乐观锁 version）——成功后清本地草稿
//
// 容错行为：
//   - BFF 不可达 / 网络断开 → syncState='offline'，本地草稿保留，
//     toast 提示一次「已暂存本地」，绝不弹阻塞式 alert
//   - 网络恢复（online 事件 + 30s 探活）→ 按时间顺序回放未同步草稿
//   - 409 版本冲突 → useConfirm 非阻塞确认（加载服务端 / 丢弃本地）
//   - 5s 定时器兜底刷一次本地草稿（崩溃前的最后保险）
//
// 全局单例：整个应用一个 SyncEngine，跨文档复用。
// =============================================================================

import { useDocumentStore } from '../stores/document';
import { useLocalDraftsStore, type DraftSnapshot } from '../stores/localDrafts';
import { useUiStore } from '../stores/ui';
import { useConfirm } from '../composables/useConfirm';
import { useToast } from '../composables/useToast';
import { getPreference } from '../composables/usePreferences';

type SyncState = 'saved' | 'syncing' | 'offline' | 'error';

/** 单个文档的待提交保存任务 */
interface PendingSave {
  docId: string;
  /** 期望的服务端版本（乐观锁基线；每次成功后递增） */
  expectedVersion: number;
  content: string;
  title?: string;
  /** 最后一次编辑时间（用于排序） */
  touchedAt: number;
}

class SyncEngine {
  // Store 改为懒初始化——此前在类字段初始化器里直接调用 useDocumentStore() 等，
  // 但模块顶层 export const syncEngine = new SyncEngine() 会在 import 时立即求值，
  // 此时 main.ts 的 app.use(pinia) 尚未执行，Pinia 未就绪导致 "no active Pinia" 崩溃。
  // 改为下划线私有字段 + getter 懒加载：方法内 this.docs 等走 getter，首次访问时（Pinia 已就绪）才取。
  private _docs?: ReturnType<typeof useDocumentStore>;
  private _local?: ReturnType<typeof useLocalDraftsStore>;
  private _ui?: ReturnType<typeof useUiStore>;
  private _confirm?: ReturnType<typeof useConfirm>;
  private _toast?: ReturnType<typeof useToast>;

  /** docId → 防抖定时器 */
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** docId → 待提交任务（防抖窗口内最新的那份） */
  private pending = new Map<string, PendingSave>();
  /** 5s 兜底刷本地草稿定时器 */
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  /** 离线探活定时器 */
  private probeTimer: ReturnType<typeof setInterval> | null = null;
  /** 当前是否判定为离线（避免重复 toast） */
  private offlineNotified = false;
  /** 回放进行中标记（防止重入） */
  private replaying = false;
  /** 已初始化 */
  private inited = false;

  /** 懒初始化 Pinia store（首次调用时取，此后复用） */
  private ensureStores(): void {
    if (!this._docs) {
      this._docs = useDocumentStore();
      this._local = useLocalDraftsStore();
      this._ui = useUiStore();
      this._confirm = useConfirm();
      this._toast = useToast();
    }
  }

  /** store getter：首次访问时懒初始化 */
  private get docs() { this.ensureStores(); return this._docs!; }
  private get local() { this.ensureStores(); return this._local!; }
  private get ui() { this.ensureStores(); return this._ui!; }
  private get confirm() { this.ensureStores(); return this._confirm!; }
  private get toast() { this.ensureStores(); return this._toast!; }

  /** 初始化全局监听（应用启动时调用一次） */
  init(): void {
    if (this.inited) return;
    this.ensureStores();
    this.inited = true;

    // 网络恢复事件 → 立即回放
    window.addEventListener('online', () => this.onConnectivityChange(true));
    window.addEventListener('offline', () => this.onConnectivityChange(false));

    // 5s 兜底：把所有 pending 强制刷一次本地草稿（不等防抖）
    this.flushTimer = setInterval(() => this.flushAllToLocal(), 5000);

    // 30s 探活：离线时定期试探 BFF 是否恢复
    this.probeTimer = setInterval(() => {
      if (this.ui.syncState === 'offline') void this.probeHealth();
    }, 30000);

    // 启动即探一次，判定初始在线状态
    void this.probeHealth();
  }

  // -------------------------------------------------------------------------
  // 编辑器侧入口：标记某文档变脏，触发防抖保存
  // -------------------------------------------------------------------------
  schedule(docId: string, expectedVersion: number, content: string, title?: string): void {
    // 更新待提交任务
    this.pending.set(docId, {
      docId, expectedVersion, content, title, touchedAt: Date.now(),
    });
    this.ui.syncState = 'syncing';

    // 立即写本地草稿（轻层不等防抖，崩溃前已落盘）
    this.local.save(docId, {
      content, version: expectedVersion, savedAt: Date.now(), title,
    });

    // 防抖提交到 BFF
    this.resetTimer(docId);
  }

  /** 立即提交某文档（失焦 / 离开组件 / Ctrl+S 时调用） */
  async flush(docId: string): Promise<void> {
    this.resetTimer(docId, 0);
    await this.commit(docId);
  }

  // -------------------------------------------------------------------------
  // 内部：防抖 + 提交
  // -------------------------------------------------------------------------
  private resetTimer(docId: string, delayOverride?: number): void {
    const prev = this.timers.get(docId);
    if (prev) clearTimeout(prev);
    const delay = delayOverride ?? this.autosaveInterval();
    const t = setTimeout(() => { void this.commit(docId); }, delay);
    this.timers.set(docId, t);
  }

  private autosaveInterval(): number {
    const enabled = getPreference('autosaveEnabled', true);
    if (!enabled) return 60_000; // 关闭自动保存时拉长到 1 分钟（仍可手动 Ctrl+S）
    return getPreference('autosaveIntervalMs', 1000);
  }

  /** 把单个文档的 pending 提交到 BFF */
  private async commit(docId: string): Promise<void> {
    const task = this.pending.get(docId);
    if (!task) return;

    // 离线判定：不发起注定失败的请求，直接保留本地草稿
    if (this.ui.syncState === 'offline') return;

    try {
      // 标题与内容分两次 PATCH（BFF 按字段分流）
      if (task.title !== undefined) {
        const renamed = await this.docs.rename(docId, task.expectedVersion, task.title);
        this.ui.renameTab(docId, renamed.title);
        // rename 成功后版本递增，content 用新版本
        task.expectedVersion = renamed.version;
      }
      const updated = await this.docs.updateContent(docId, task.expectedVersion, task.content);

      // 成功：清本地草稿 + 清 pending
      this.local.clear(docId);
      this.pending.delete(docId);
      this.ui.syncState = 'saved';

      // 若这是离线恢复后的首次成功，给个正向反馈
      if (this.offlineNotified) {
        this.offlineNotified = false;
        this.toast.success('网络已恢复，本地内容已同步');
      }
    } catch (err: any) {
      this.handleCommitError(docId, task, err);
    }
  }

  /** 处理提交失败：区分 409 冲突 / 网络错误 / 其他 */
  private handleCommitError(docId: string, task: PendingSave, err: any): void {
    const status = err?.response?.status;

    if (status === 409) {
      // 版本冲突：非阻塞确认
      void this.onVersionConflict(docId);
      return;
    }

    // 网络类错误（无 response 或 5xx / 0）→ 离线模式
    const isNetwork = !err?.response || status === 0 || (status >= 500 && status < 600);
    if (isNetwork) {
      this.enterOffline(task);
      return;
    }

    // 其他业务错误（如 400/403/404）→ error 态，保留 pending 供手动重试
    this.ui.syncState = 'error';
    this.toast.error('保存失败：' + (err?.response?.data?.error || '未知错误'), 6000);
    console.error('[sync] commit failed', err);
  }

  /** 进入离线模式：保留本地草稿，toast 一次提示 */
  private enterOffline(task: PendingSave): void {
    this.ui.syncState = 'offline';
    // 本地草稿已在上层 schedule 写入；这里确保 task 仍挂在 pending 供回放
    this.local.save(task.docId, {
      content: task.content, version: task.expectedVersion,
      savedAt: Date.now(), title: task.title,
    });
    if (!this.offlineNotified) {
      this.offlineNotified = true;
      this.toast.warning('网络不可用，内容已暂存本地，将在恢复后自动同步', 5000);
    }
  }

  // -------------------------------------------------------------------------
  // 版本冲突（409）
  // -------------------------------------------------------------------------
  private async onVersionConflict(docId: string): Promise<void> {
    this.ui.syncState = 'error';
    const ok = await this.confirm({
      title: '文档已被其他方式修改',
      message: '服务端的版本比你本地的新。点击「加载服务端」会丢弃本地未同步的改动；点击「取消」可手动复制保留本地内容。',
      confirmText: '加载服务端版本',
      cancelText: '取消',
      danger: true,
    });
    if (ok) {
      this.pending.delete(docId);
      this.local.clear(docId);
      await this.docs.loadTree(this.ui.projectId);
      this.toast.info('已加载服务端最新版本');
    }
  }

  // -------------------------------------------------------------------------
  // 网络恢复 → 回放未同步草稿
  // -------------------------------------------------------------------------
  private async onConnectivityChange(online: boolean): Promise<void> {
    if (online) {
      // 浏览器 online 事件有时会误报，探活确认后再回放
      const healthy = await this.probeHealth();
      if (healthy) void this.replayUnsynced();
    } else {
      this.ui.syncState = 'offline';
    }
  }

  /** 探活 BFF；返回是否可达 */
  private async probeHealth(): Promise<boolean> {
    try {
      const res = await fetch('/api/health', { cache: 'no-store' });
      if (res.ok) {
        if (this.ui.syncState === 'offline') {
          // 恢复了 → 触发回放
          void this.replayUnsynced();
        }
        return true;
      }
      return false;
    } catch {
      if (this.ui.syncState !== 'offline') this.ui.syncState = 'offline';
      return false;
    }
  }

  /** 把所有未同步草稿按时间顺序回放到 BFF */
  private async replayUnsynced(): Promise<void> {
    if (this.replaying) return;
    this.replaying = true;
    try {
      const unsynced = this.local.listUnsynced();
      if (unsynced.length === 0) {
        this.replaying = false;
        return;
      }
      this.ui.syncState = 'syncing';
      let allOk = true;
      for (const { docId, snapshot } of unsynced) {
        try {
          if (snapshot.title) {
            const r = await this.docs.rename(docId, snapshot.version, snapshot.title);
            await this.docs.updateContent(docId, r.version, snapshot.content);
          } else {
            await this.docs.updateContent(docId, snapshot.version, snapshot.content);
          }
          this.local.clear(docId);
        } catch (err: any) {
          // 409 在回放中也按冲突处理（跳过该份，避免阻塞后续）
          if (err?.response?.status === 409) {
            this.local.clear(docId);
            this.toast.warning(`文档「${docId}」服务端版本更新，已加载最新`, 4000);
          } else {
            allOk = false; // 网络又断了，停止回放
            this.ui.syncState = 'offline';
            break;
          }
        }
      }
      if (allOk) {
        this.ui.syncState = 'saved';
        if (this.offlineNotified) {
          this.offlineNotified = false;
          this.toast.success('网络已恢复，本地内容已全部同步');
        }
      }
    } finally {
      this.replaying = false;
    }
  }

  // -------------------------------------------------------------------------
  // 5s 兜底：把所有 pending 强制刷一次本地草稿
  // -------------------------------------------------------------------------
  private flushAllToLocal(): void {
    for (const [docId, task] of this.pending) {
      this.local.save(docId, {
        content: task.content, version: task.expectedVersion,
        savedAt: Date.now(), title: task.title,
      });
    }
  }

  /** 手动重试（状态栏点击 error 态触发） */
  retryNow(): void {
    void this.replayUnsynced();
    // 也把当前 pending 推一把
    for (const docId of this.pending.keys()) void this.commit(docId);
  }

  /** 销毁（HMR / 测试用，正常不调用） */
  dispose(): void {
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.probeTimer) clearInterval(this.probeTimer);
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.inited = false;
  }
}

/** 全局单例 */
export const syncEngine = new SyncEngine();

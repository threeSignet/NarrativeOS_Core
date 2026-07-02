// =============================================================================
// 本地草稿存储——纯 localStorage，编辑器离线双写的「轻层」
// =============================================================================
// 职责（设计文档 §21.1 / §33.3）：
//   - 编辑器每 ~5s 把正文快照写入此处（轻、同步、永远成功）
//   - BFF 不可达时，此处即为真相源；网络恢复后由 sync-engine 回放
//   - 启动时若发现「本地比服务端 version 更新」→ 弹恢复对话框
//
// key 命名：nos_draft:<projectId>:<docId>
// 用前缀扫描支持「列出全部未同步草稿」（回放与诊断用）。
// =============================================================================

import { defineStore } from 'pinia';
import { ref } from 'vue';

/** 单份草稿快照 */
export interface DraftSnapshot {
  /** TipTap JSON 串（与 BFF content 字段同格式） */
  content: string;
  /** 写入快照时的文档乐观锁版本（基线） */
  version: number;
  /** 写入时间戳（ms） */
  savedAt: number;
  /** 标题（标题改名也走本地暂存） */
  title?: string;
}

const PREFIX = 'nos_draft:';

function key(projectId: string, docId: string): string {
  return `${PREFIX}${projectId}:${docId}`;
}

/** 安全读取 localStorage（SSR / 隐私模式可能抛错） */
function readJson<T>(k: string): T | null {
  try {
    const raw = localStorage.getItem(k);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}
function writeJson(k: string, v: unknown): boolean {
  try {
    localStorage.setItem(k, JSON.stringify(v));
    return true;
  } catch {
    // 配额超限等：吞掉，调用方降级（仅依赖 BFF）
    return false;
  }
}
function remove(k: string): void {
  try { localStorage.removeItem(k); } catch { /* ignore */ }
}

export const useLocalDraftsStore = defineStore('localDrafts', () => {
  /** 当前激活项目 id（由 App.vue 启动时设置，用于 key 拼装） */
  const projectId = ref<string>('');

  function setProject(pid: string) { projectId.value = pid; }

  /** 写入一份草稿快照（轻层，永远成功或静默失败） */
  function save(docId: string, snapshot: DraftSnapshot): void {
    if (!projectId.value || !docId) return;
    writeJson(key(projectId.value, docId), snapshot);
  }

  /** 读取草稿快照（无则 null） */
  function load(docId: string): DraftSnapshot | null {
    if (!projectId.value || !docId) return null;
    return readJson<DraftSnapshot>(key(projectId.value, docId));
  }

  /** 清除某文档的本地草稿（BFF 成功后调用） */
  function clear(docId: string): void {
    if (!projectId.value || !docId) return;
    remove(key(projectId.value, docId));
  }

  /** 列出当前项目全部未同步草稿（docId → snapshot），供回放与诊断 */
  function listUnsynced(): Array<{ docId: string; snapshot: DraftSnapshot }> {
    if (!projectId.value) return [];
    const prefix = key(projectId.value, '');
    const out: Array<{ docId: string; snapshot: DraftSnapshot }> = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k || !k.startsWith(prefix)) continue;
        const docId = k.slice(prefix.length);
        const snap = readJson<DraftSnapshot>(k);
        if (snap) out.push({ docId, snapshot: snap });
      }
    } catch { /* ignore */ }
    // 按 savedAt 升序回放（先存先同步）
    out.sort((a, b) => a.snapshot.savedAt - b.snapshot.savedAt);
    return out;
  }

  /** 清空当前项目全部本地草稿（设置页「清理本地缓存」用） */
  function clearAll(): number {
    const items = listUnsynced();
    for (const { docId } of items) clear(docId);
    return items.length;
  }

  return { projectId, setProject, save, load, clear, listUnsynced, clearAll };
});

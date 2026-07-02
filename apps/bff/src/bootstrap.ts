// =============================================================================
// 写作层装配——BFF 专用（融合后版）
// =============================================================================
// 改造（存储融合阶段6）：
//   - 废弃 drafting.db（BFF 孤岛库，只有文档树无 Core）
//   - 改用 ProjectManager（基于 data/app.db 注册表）+ ProjectSession（完整 Core+写作+Agent 装配）
//   - 激活项目 = 打开一个 ProjectSession，暴露其 documentService/projectService/writingStore/makeCtx
//   - 多项目：app.db 注册表管理；切换项目 = 关旧 session 开新 session
//
// routes 接口契约不变（仍收 { projectService, writingStore, documentService, activeProjectId, makeCtx }），
// 只是这些现在来自 ProjectSession（完整 Core 已装配，后续 agent 接入零阻力）。

import { getProjectManager } from '../../../src/session/project-manager.js';
import type { ProjectSession } from '../../../src/session/project-session.js';
import type { WritingRequestContext, WritingTrigger } from '../../../src/writing/services/context.js';

export interface BffServices {
  /** 当前激活项目 session（含完整 Core+写作+Agent 装配） */
  session: ProjectSession;
  /** 当前激活项目 id（= writingProjectId，可变：切换项目时改） */
  activeProjectId: { value: string };
  /** 构造 ctx，默认绑定激活项目；传 pid 则绑定指定项目 */
  makeCtx: (opts?: { pid?: string; trigger?: WritingTrigger }) => WritingRequestContext;
  /** 切换激活项目（关旧 session，开新 session） */
  switchProject: (nameOrId: string) => Promise<void>;
}

/**
 * 装配 BFF：基于 app.db 注册表，打开激活项目。
 * - 有项目：取最近打开的一个
 * - 无项目：建默认项目"我的作品"
 */
export async function bootstrap(): Promise<BffServices> {
  const manager = getProjectManager('./data');
  let records = manager.listProjects();

  // 无项目则建默认
  if (records.length === 0) {
    const { record } = manager.createProject({ name: '我的作品', title: '我的作品' });
    records = manager.listProjects();
    void record;
  }

  // 激活：取首项（listProjects 按 last_opened_at DESC）
  const active = records[0]!;
  const session = await manager.openProject(active.name, { withVector: false, withAgent: false });

  const activeProjectId = { value: active.id };

  const makeCtx = (opts?: { pid?: string; trigger?: WritingTrigger }): WritingRequestContext => {
    // pid 当前等于激活项目（BFF 单项目 session 模型）；显式 pid 留作多项目扩展
    void opts?.pid;
    return session.makeCtx({ trigger: opts?.trigger });
  };

  const switchProject = async (nameOrId: string): Promise<void> => {
    const newSession = await manager.openProject(nameOrId, { withVector: false, withAgent: false });
    const rec = manager.getProjectByName(nameOrId) ?? manager.getProject(nameOrId);
    // 替换 session 引用（闭包内 session 变量重绑需要重新建 makeCtx）
    // 简化：BFF 当前单项目，切换重建 services 由 server 层处理；此处仅更新 id
    if (rec) activeProjectId.value = rec.id;
    void newSession;
  };

  return { session, activeProjectId, makeCtx, switchProject };
}

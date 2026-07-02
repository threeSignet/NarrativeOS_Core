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
  /** ProjectManager（app.db 注册表，供路由列项目/建项目） */
  manager: ReturnType<typeof getProjectManager>;
  /** 当前激活项目 session（启动时的快照；切换后用 getActiveSession 取最新） */
  session: ProjectSession;
  /** 当前激活项目 id（= writingProjectId，可变：切换项目时改） */
  activeProjectId: { value: string };
  /** 切换激活项目（开新 session，更新引用与 id） */
  switchActive: (nameOrId: string) => Promise<void>;
  /** 取当前激活 session（切换后返回最新，避免路由拿到过期 session） */
  getActiveSession: () => ProjectSession;
  /** 构造 ctx，绑定当前激活项目（自动跟随时激活 session） */
  makeCtx: (opts?: { pid?: string; trigger?: WritingTrigger }) => WritingRequestContext;
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
    manager.createProject({ name: '我的作品', title: '我的作品' });
    records = manager.listProjects();
  }

  // 激活：取首项（listProjects 按 last_opened_at DESC）
  const active = records[0]!;
  // 用一个可变的 session 容器，切换项目时更新引用
  const sessionBox: { current: ProjectSession } = {
    current: await manager.openProject(active.name, { withVector: false, withAgent: false }),
  };
  const activeProjectId = { value: active.id };

  const makeCtx = (opts?: { pid?: string; trigger?: WritingTrigger }): WritingRequestContext => {
    void opts?.pid; // pid 当前等于激活项目（BFF 单激活 session 模型）
    return sessionBox.current.makeCtx({ trigger: opts?.trigger });
  };

  /** 切换激活项目：开新 session，更新引用与 id */
  const switchActive = async (nameOrId: string): Promise<void> => {
    sessionBox.current = await manager.openProject(nameOrId, { withVector: false, withAgent: false });
    const rec = manager.getProjectByName(nameOrId) ?? manager.getProject(nameOrId);
    if (rec) activeProjectId.value = rec.id;
  };

  /** 取当前激活 session（切换后返回最新） */
  const getActiveSession = (): ProjectSession => sessionBox.current;

  return { manager, session: sessionBox.current, activeProjectId, switchActive, getActiveSession, makeCtx };
}

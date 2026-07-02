// =============================================================================
// ProjectManager —— 项目生命周期协调层（存储融合阶段4）
// =============================================================================
// 职责：
//   - 协调 AppRegistry（全局注册表）+ 文件系统 + ProjectSession（项目装配）
//   - createProject：建目录 → ProjectSession 装配空库 → projectService.createProject
//     拿 writingProjectId → 生成 coreProjectId（与目录名解耦）→ 写 app.db 注册表
//   - listProjects：查 app.db（不逐个开库，快）
//   - openProject：查 app.db → ProjectSession 打开已存在库
//   - 项目名校验（移植 project-selector.ts）
//
// 设计：
//   - coreProjectId = `core_<writingProjectId>`，与目录名解耦（重命名目录不丢 Core 状态）
//   - 新建项目：先装配 ProjectSession（writingProjectId 暂空），createProject 后 setWritingProjectId
//   - 单例：一个进程一个 ProjectManager（持一个 AppRegistry）
// =============================================================================

import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getAppRegistry, type AppProjectRecord } from './app-registry.js';
import { ProjectSession, type ProjectSessionOptions } from './project-session.js';

/** 项目名合法校验（移植 project-selector.ts:75） */
export function isValidProjectName(name: string): boolean {
  if (!name || name.trim().length === 0 || name.length > 100) return false;
  if (name.startsWith('.')) return false;
  if (/[\\/]/.test(name)) return false; // 路径分隔符
  if (name.includes('..')) return false; // 穿越符
  if (/[<>:"|?*]/.test(name)) return false; // Windows 非法字符
  return true;
}

/** 由 writingProjectId 派生 coreProjectId（与目录名解耦，确定性可复现） */
function deriveCoreProjectId(writingProjectId: string): string {
  return `core_${writingProjectId}`;
}

export interface CreateProjectInput {
  /** 项目名（= 目录名） */
  name: string;
  /** 项目标题（写作层 writing_projects.title） */
  title?: string;
  /** 一句话前提 */
  premise?: string;
}

export interface OpenProjectOptions {
  /** 是否装配向量检索（默认 false；CLI 按需传 true） */
  withVector?: boolean;
  /** 向量库路径（withVector=true 时必传，默认用注册表的 vectorsPath） */
  vectorsPath?: string;
  /** 是否装配 agent（默认 false；CLI 按需传 true） */
  withAgent?: boolean;
}

export class ProjectManager {
  readonly dataDir: string;
  private registry: ReturnType<typeof getAppRegistry>;
  /** 已打开的 session 缓存（name → session），避免重复打开 */
  private sessions = new Map<string, ProjectSession>();

  constructor(dataDir?: string) {
    this.dataDir = resolve(dataDir ?? './data');
    // app.db 固定在 dataDir 根下（与项目目录 dataDir/projects/ 同级）。
    // 关键：用 dataDir 派生 app.db 路径，使 CLI/BFF/迁移脚本指向同一个 app.db，
    // 不受各自 CWD 影响（此前 BFF 从 apps/bff/ 启动解析到错误的 app.db）。
    this.registry = getAppRegistry(join(this.dataDir, 'app.db'));
  }

  /** 项目目录：dataDir/projects/<name>/ */
  private projectDir(name: string): string {
    return join(this.dataDir, 'projects', name);
  }
  /** project.db 路径 */
  private dbPath(name: string): string {
    return join(this.projectDir(name), 'project.db');
  }
  /** 向量库目录路径 */
  private vectorsPath(name: string): string {
    return join(this.projectDir(name), 'vectors');
  }

  /**
   * 列出全部项目（查 app.db，不逐个开库）。
   * 返回的 record 含 dbPath/coreProjectId 等，调用方可据需 openProject。
   */
  listProjects(): AppProjectRecord[] {
    return this.registry.listProjects();
  }

  /** 按 id 查项目注册记录 */
  getProject(id: string): AppProjectRecord | undefined {
    return this.registry.getProject(id);
  }

  /** 按项目名（目录名）查项目注册记录 */
  getProjectByName(name: string): AppProjectRecord | undefined {
    return this.registry.getProjectByName(name);
  }

  /**
   * 创建新项目。
   * 流程：校验名 → 建目录 → ProjectSession 装配空库（coreProjectId 暂用占位）
   *      → projectService.createProject 拿 writingProjectId → setWritingProjectId
   *      → 写 app.db 注册表（coreProjectId 派生自 writingProjectId）
   */
  createProject(input: CreateProjectInput): { session: ProjectSession; record: AppProjectRecord } {
    const name = input.name.trim();
    if (!isValidProjectName(name)) {
      throw new Error(`非法项目名：${name}（不可为空、含路径分隔符/Windows 非法字符、超过100字符）`);
    }
    if (this.registry.getProjectByName(name)) {
      throw new Error(`项目名已存在：${name}`);
    }

    // 1. 建项目目录
    mkdirSync(this.projectDir(name), { recursive: true });

    // 2. 装配空库（writingProjectId 暂未定，coreProjectId 先用临时占位，createProject 后校正）
    //    注意：ProjectSession 装配时会建表 + 启动对账，空库 no-op
    const tempCoreId = `core_pending_${Date.now()}`;
    const session = new ProjectSession({
      dbPath: this.dbPath(name),
      coreProjectId: tempCoreId,
      withAgent: false,
    });

    // 3. 创建写作层项目（组合初始化：蓝图+灵感+布局+偏好容器）
    const created = session.projectService.createProject(
      // createProject 内部会用新 id 覆盖 ctx.projectId 建审计
      session.makeCtxPending(),
      { title: input.title ?? name, premise: input.premise ?? '' },
    );
    const writingProjectId = created.id;

    // 4. setWritingProjectId（回注 ToolRouter）
    session.setWritingProjectId(writingProjectId);

    // 5. 写 app.db 注册表（coreProjectId 派生自 writingProjectId，与目录名解耦）
    const record = this.registry.registerProject({
      id: writingProjectId,
      name,
      dbPath: this.dbPath(name),
      coreProjectId: deriveCoreProjectId(writingProjectId),
      vectorsPath: this.vectorsPath(name),
    });

    // 6. 缓存 session
    this.sessions.set(name, session);
    return { session, record };
  }

  /**
   * 打开已存在的项目（查 app.db → ProjectSession）。
   * 已打开则复用缓存。
   */
  async openProject(nameOrId: string, opts?: OpenProjectOptions): Promise<ProjectSession> {
    // 先查缓存（按 name）
    const cached = this.sessions.get(nameOrId);
    if (cached) return cached;

    // 查注册表（先按 name，再按 id）
    let record = this.registry.getProjectByName(nameOrId);
    if (!record) record = this.registry.getProject(nameOrId);
    if (!record) throw new Error(`项目不存在：${nameOrId}`);

    // 检查缓存（按 record.name）
    const cached2 = this.sessions.get(record.name);
    if (cached2) return cached2;

    // 装配 ProjectSession（用注册表的 coreProjectId / writingProjectId）
    // dbPath/vectorsPath 兼容相对路径：相对 dataDir 解析为绝对路径，
    // 避免不同 CWD（CLI 项目根 vs BFF apps/bff/）解析到不同文件。
    const absDbPath = resolve(this.dataDir, record.dbPath);
    const absVectorsPath = resolve(this.dataDir, record.vectorsPath);
    const session = new ProjectSession({
      dbPath: absDbPath,
      coreProjectId: record.coreProjectId,
      writingProjectId: record.id,
      withAgent: false,
    });

    // 按需异步装配向量 / agent
    if (opts?.withVector) {
      await session.initVector(opts.vectorsPath ?? absVectorsPath);
    }
    if (opts?.withAgent) {
      await session.initAgent();
    }

    // 更新最近打开
    this.registry.touchLastOpened(record.id);
    this.sessions.set(record.name, session);
    return session;
  }

  /** 注销项目（仅清注册表 + 关 session，不删文件） */
  unregisterProject(nameOrId: string): void {
    let record = this.registry.getProjectByName(nameOrId);
    if (!record) record = this.registry.getProject(nameOrId);
    if (!record) return;
    const session = this.sessions.get(record.name);
    if (session) {
      session.close();
      this.sessions.delete(record.name);
    }
    this.registry.unregisterProject(record.id);
  }

  /** 关闭全部 session */
  closeAll(): void {
    for (const [, session] of this.sessions) session.close();
    this.sessions.clear();
  }
}

/** 全局单例 */
let _manager: ProjectManager | undefined;
export function getProjectManager(dataDir?: string): ProjectManager {
  if (!_manager) _manager = new ProjectManager(dataDir);
  return _manager;
}

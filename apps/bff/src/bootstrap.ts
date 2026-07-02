// =============================================================================
// 写作层装配——BFF 专用（多项目版）
// =============================================================================
// 与 src/cli/chat.ts 的完整装配不同：本装配只实例化写作层 DocumentService
// 及其依赖（SQLiteWritingStore / AuditService），不装 Core 引擎 / Agent / 向量检索。
//
// 多项目支持：维护一个【可变】的当前激活项目指针 activeProject.id，
// 切换项目时改这个指针即可，makeCtx 默认用激活值，也接受显式 pid 覆盖。

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { SQLiteWritingStore } from '../../../src/writing/repositories/writing-store.js';
import { AuditService } from '../../../src/writing/services/audit-service.js';
import { DocumentService } from '../../../src/writing/services/document-service.js';
import { ProjectService } from '../../../src/writing/services/project-service.js';
import { makeRequestContext } from '../../../src/writing/services/context.js';
import type { WritingRequestContext } from '../../../src/writing/services/context.js';

export interface BffServices {
  db: Database.Database;
  writingStore: SQLiteWritingStore;
  documentService: DocumentService;
  projectService: ProjectService;
  /** 当前激活项目 id（可变：切换项目时改这个值） */
  activeProjectId: { value: string };
  /** 构造 ctx，默认绑定激活项目；传 pid 则绑定指定项目 */
  makeCtx: (opts?: { pid?: string; trigger?: WritingRequestContext['trigger'] }) => WritingRequestContext;
}

/**
 * 装配写作层服务（多项目）。
 * - 打开 / 创建 db 文件（WAL 模式）
 * - 建全部 writing_* 表
 * - 取激活项目：有项目取第一个，无则建默认项目
 */
export function bootstrap(dbPath?: string): BffServices {
  const path = resolve(dbPath ?? process.env.DRAFTING_DB ?? './data/drafting.db');
  mkdirSync(dirname(path), { recursive: true });

  const db = new Database(path);
  db.pragma('journal_mode = WAL');

  const writingStore = new SQLiteWritingStore(db);
  writingStore.createTables();
  const auditService = new AuditService(writingStore);
  const documentService = new DocumentService(writingStore, auditService);
  const projectService = new ProjectService(writingStore, auditService);

  // 激活项目：有则取首项，无则建默认
  const projects = writingStore.listProjects();
  let initialId: string;
  if (projects.length > 0) {
    initialId = projects[0]!.id;
  } else {
    const bootstrapCtx = makeRequestContext({ projectId: 'bootstrap', trigger: 'author_action' });
    const project = projectService.createProject(bootstrapCtx, { title: '我的作品' });
    initialId = project.id;
  }

  // 可变激活指针（用对象包装，使闭包内可变）
  const activeProjectId = { value: initialId };

  // makeCtx：默认绑定激活项目；显式传 pid 则校验存在性后绑定该项目
  const makeCtx = (opts?: { pid?: string; trigger?: WritingRequestContext['trigger'] }): WritingRequestContext => {
    const pid = opts?.pid ?? activeProjectId.value;
    return makeRequestContext({
      projectId: pid,
      trigger: opts?.trigger ?? 'author_action',
    });
  };

  return { db, writingStore, documentService, projectService, activeProjectId, makeCtx };
}

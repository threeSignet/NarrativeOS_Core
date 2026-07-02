// =============================================================================
// CLI 项目选择器（融合后版，存储融合阶段5）
// =============================================================================
// 改造：基于 data/app.db 注册表（经 ProjectManager）列出项目，
// 替代原"扫目录判 cli.db"。保留交互式 readline 菜单 + 记住上次选择。
//
// 职责：只负责"让用户选一个项目名"（或输入新项目名），返回 SelectedProject。
// 不负责打开库/装配——那归 chat.ts 调用 ProjectManager（openProject/createProject）。
//
// 数据目录结构（融合后）：
//   ./data/
//   ├── app.db                  # 全局项目注册表（app_projects + app_users）
//   ├── .current-project        # 记住上次选的项目名
//   └── projects/
//       └── <项目名>/
//           ├── project.db      # 该项目的 Core+写作+Agent 单库
//           └── vectors/        # 该项目向量库
// =============================================================================

import * as readline from 'readline';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { getProjectManager, isValidProjectName } from '../session/project-manager.js';

/** 项目选择结果 */
export interface SelectedProject {
  /** 项目名（= 目录名，也是 app.db 注册表的 name） */
  name: string;
  /** 项目目录路径（data/projects/<名>/） */
  dir: string;
  /** 是否本次新建 */
  isNew: boolean;
}

/**
 * 读取上次选择的项目名（跨进程持久化）。
 * 文件 ./data/.current-project 存一行项目名。不存在或为空返回 undefined。
 */
export function readLastProject(dataDir: string): string | undefined {
  const file = join(dataDir, '.current-project');
  if (!existsSync(file)) return undefined;
  const name = readFileSync(file, 'utf-8').trim();
  return name.length > 0 ? name : undefined;
}

/** 记住本次选择的项目名 */
export function writeLastProject(dataDir: string, name: string): void {
  writeFileSync(join(dataDir, '.current-project'), name, 'utf-8');
}

/**
 * 交互式选项目。基于 app.db 注册表（ProjectManager.listProjects）。
 *
 * 流程：
 *   1. 从 app.db 列出已注册项目 + 读上次选择
 *   2. 菜单：列出项目 + 新建选项
 *   3. 选定 → 记住 → 返回 SelectedProject
 *
 * @param dataDir 数据根目录（默认 ./data）
 */
export async function selectProject(dataDir: string = './data'): Promise<SelectedProject> {
  mkdirSync(dataDir, { recursive: true });
  const manager = getProjectManager(dataDir);
  const records = manager.listProjects();
  const lastProject = readLastProject(dataDir);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string): Promise<string> =>
    new Promise((resolve) => rl.question(q, (ans) => resolve(ans)));

  try {
    // 无项目：直接引导新建
    if (records.length === 0) {
      console.log('\n  📂 还没有项目，先创建一个');
      return await promptNewProject(dataDir, ask, rl);
    }

    // 有项目：列菜单
    console.log('\n  选择项目：');
    const items: Array<{ name: string }> = records.map(r => ({ name: r.name }));
    items.forEach((p, i) => {
      const lastMark = lastProject && p.name === lastProject ? ' (上次)' : '';
      console.log(`    [${i + 1}] ${p.name}${lastMark}`);
    });
    console.log(`    [${items.length + 1}] 新建项目`);

    const ans = (await ask(`  输入序号（1-${items.length + 1}）：`)).trim();
    const idx = parseInt(ans, 10);

    // 新建
    if (!Number.isNaN(idx) && idx === items.length + 1) {
      return await promptNewProject(dataDir, ask, rl);
    }

    // 选已有
    if (!Number.isNaN(idx) && idx >= 1 && idx <= items.length) {
      const name = items[idx - 1]!.name;
      writeLastProject(dataDir, name);
      return { name, dir: join(dataDir, 'projects', name), isNew: false };
    }

    // 输入非法：回退到第一项
    const fallback = items[0]!;
    console.log(`  输入无效，默认选 "${fallback.name}"`);
    writeLastProject(dataDir, fallback.name);
    return { name: fallback.name, dir: join(dataDir, 'projects', fallback.name), isNew: false };
  } finally {
    rl.close();
  }
}

/** 引导用户新建项目（输入名称），返回 SelectedProject（isNew=true）。不在此建库（归 chat.ts） */
async function promptNewProject(
  dataDir: string,
  ask: (q: string) => Promise<string>,
  rl: readline.Interface,
): Promise<SelectedProject> {
  while (true) {
    const name = (await ask('  输入新项目名：')).trim();
    if (!isValidProjectName(name)) {
      console.log('  ✗ 项目名非法（不可为空、含路径分隔符/Windows 非法字符、超过100字符）');
      continue;
    }
    // 重复名检查（app.db）
    if (getProjectManager(dataDir).getProjectByName(name)) {
      console.log(`  ✗ 项目名已存在：${name}`);
      continue;
    }
    writeLastProject(dataDir, name);
    return { name, dir: join(dataDir, 'projects', name), isNew: true };
  }
  // 不会走到（while true + return），TS 需要
}

// =============================================================================
// 项目选择器（每项目独立 db 文件）
// =============================================================================
// CLI 启动时让用户选项目：扫描 ./data/projects/ 列出已有项目，记住上次选择，
// 支持新建 + 旧库迁移。选定后返回项目目录路径，chat.ts 据此派生 DB_PATH / lancedbDir。
//
// 数据目录结构（改造后）：
//   ./data/
//   ├── .current-project          # 记住上次选的项目名
//   ├── projects/
//   │   └── <项目名>/
//   │       ├── cli.db            # 该项目的 Core + 写作层所有表
//   │       └── lancedb/          # 该项目的向量库
//   └── cli-project.db            # 旧库（迁移后保留）
//
// 设计为可测：核心逻辑（扫描/校验/迁移）是纯函数，readline 交互薄壳。
// =============================================================================

import * as readline from 'readline';
import {
  existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, copyFileSync,
} from 'fs';
import { join } from 'path';

/** 项目选择结果 */
export interface SelectedProject {
  /** 项目名（= 目录名） */
  name: string;
  /** 项目目录绝对/相对路径 */
  dir: string;
  /** 是否本次新建 */
  isNew: boolean;
}

/**
 * 扫描 dataDir/projects/ 下的所有项目目录名。
 *
 * 项目目录判定标准：是目录且包含 cli.db 文件（避免误把空目录/lancedb 当项目）。
 * 返回排序后的项目名列表。
 */
export function listProjects(dataDir: string): string[] {
  const projectsDir = join(dataDir, 'projects');
  if (!existsSync(projectsDir)) return [];
  const entries = readdirSync(projectsDir, { withFileTypes: true });
  const names: string[] = [];
  for (const e of entries) {
    if (e.isDirectory() && existsSync(join(projectsDir, e.name, 'cli.db'))) {
      names.push(e.name);
    }
  }
  return names.sort();
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
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, '.current-project'), name, 'utf-8');
}

/**
 * 校验项目名是否合法。
 * 拒绝：空、含路径分隔符（/ \）、含 .. （防穿越）、以 . 开头（防隐藏文件）、含控制字符。
 */
export function isValidProjectName(name: string): boolean {
  const trimmed = name.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.length > 100) return false;
  if (/[\/\\]/.test(trimmed)) return false; // 路径分隔符
  if (trimmed === '.' || trimmed === '..' || trimmed.includes('..')) return false; // 穿越
  if (trimmed.startsWith('.')) return false; // 隐藏文件
  // 拒绝 Windows 非法字符
  if (/[<>:"|?*]/.test(trimmed)) return false;
  return true;
}

/**
 * 只读打开旧库，读出 writing_projects 表的项目列表。
 *
 * 用于迁移前展示"旧库里有什么"，让用户据此命名迁移后的项目。
 * 用 better-sqlite3 readonly 打开（不锁、不写）。若表不存在或读取失败返回空数组。
 */
export function readLegacyProjects(legacyDbPath: string): Array<{ id: string; title: string; status: string }> {
  try {
    // 动态 require 避免顶层强制依赖 better-sqlite3（项目选择器本应轻量）
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require('better-sqlite3');
    // 不用 readonly：WAL 模式下 readonly 打开可能看不到未 checkpoint 的数据（数据在 -wal 文件）。
    // 普通打开会自动应用 WAL，读到最新数据。打开后立即关闭，不写。
    const db = new Database(legacyDbPath);
    try {
      // 先检查表是否存在（旧库可能是空 db 或损坏）
      const tableExists = db.prepare(
        "SELECT COUNT(*) as c FROM sqlite_master WHERE type='table' AND name='writing_projects'",
      ).get() as { c: number };
      if (tableExists.c === 0) return [];
      const rows = db.prepare(
        "SELECT id, title, status FROM writing_projects WHERE deleted_at IS NULL ORDER BY updated_at DESC",
      ).all() as Array<{ id: string; title: string; status: string }>;
      return rows;
    } finally {
      db.close();
    }
  } catch {
    // 表不存在 / 文件损坏 / 不是 sqlite → 返回空
    return [];
  }
}

/**
 * 旧库迁移：把 ./data/cli-project.db 复制为 ./data/projects/<name>/cli.db。
 *
 * 触发条件：用户选"新建"但检测到旧库存在（首次从单文件架构升级）。
 * 迁移用复制非移动——旧库保留，迁移失败可重试。同时创建 lancedb 目录。
 */
export function migrateLegacyDb(dataDir: string, targetProjectName: string): void {
  const legacyDb = join(dataDir, 'cli-project.db');
  if (!existsSync(legacyDb)) {
    throw new Error(`旧库不存在: ${legacyDb}`);
  }
  const targetDir = join(dataDir, 'projects', targetProjectName);
  mkdirSync(targetDir, { recursive: true });
  mkdirSync(join(targetDir, 'lancedb'), { recursive: true });
  // 复制 db 文件（+ wal/shm 若存在）
  copyFileSync(legacyDb, join(targetDir, 'cli.db'));
  for (const ext of ['-wal', '-shm']) {
    const src = legacyDb + ext;
    if (existsSync(src)) copyFileSync(src, join(targetDir, `cli.db${ext}`));
  }
}

/**
 * 确保项目目录存在（新建项目时调用）。
 * 创建 projects/<name>/ 和 projects/<name>/lancedb/。
 */
export function ensureProjectDir(dataDir: string, name: string): string {
  if (!isValidProjectName(name)) {
    throw new Error(`非法项目名: ${name}`);
  }
  const projectDir = join(dataDir, 'projects', name);
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(join(projectDir, 'lancedb'), { recursive: true });
  return projectDir;
}

/**
 * 交互式项目选择（CLI 启动入口）。
 *
 * 流程：
 *   1. 扫描已有项目 + 读上次选择
 *   2. 若无项目且检测到旧库 → 提示迁移
 *   3. 菜单：列出项目 + 新建选项
 *   4. 选定 → 记住 → 返回
 *
 * @param dataDir 数据根目录（默认 ./data）
 */
export async function selectProject(dataDir: string = './data'): Promise<SelectedProject> {
  mkdirSync(dataDir, { recursive: true });
  const projects = listProjects(dataDir);
  const lastProject = readLastProject(dataDir);
  const legacyDb = join(dataDir, 'cli-project.db');
  const hasLegacy = existsSync(legacyDb);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string): Promise<string> =>
    new Promise((resolve) => rl.question(q, (ans) => resolve(ans)));

  try {
    // ---- 场景 A：无项目 + 有旧库 → 读旧库项目名，让用户确认/选择 ----
    if (projects.length === 0 && hasLegacy) {
      console.log('\n  \x1b[1;33m📦 检测到旧版数据库（单文件架构）\x1b[0m');
      console.log(`  位置：${legacyDb}`);
      // 打开旧库（只读）读出里面的项目，让用户据此命名迁移后的项目
      const legacyProjects = readLegacyProjects(legacyDb);
      let defaultName = '默认项目';
      if (legacyProjects.length > 0) {
        console.log('  旧库包含以下项目：');
        legacyProjects.forEach((p, i) => {
          console.log(`    [${i + 1}] ${p.title} (${p.status})`);
        });
        defaultName = legacyProjects[0]!.title; // 用第一个（最新）的项目名作默认
        console.log(`\n  迁移后该项目将独立存为 ./data/projects/<项目名>/cli.db`);
        const ans = (await ask(`  输入迁移后的项目名（回车用"${defaultName}"）：`)).trim();
        const name = ans.length > 0 ? ans : defaultName;
        if (!isValidProjectName(name)) {
          console.log('  \x1b[31m项目名非法，已取消迁移。\x1b[0m');
          rl.close();
          return await fallbackNewProject(dataDir, rl, ask);
        }
        migrateLegacyDb(dataDir, name);
        writeLastProject(dataDir, name);
        console.log(`  \x1b[32m✅ 已迁移为项目「${name}」\x1b[0m\n`);
        rl.close();
        return { name, dir: join(dataDir, 'projects', name), isNew: true };
      } else {
        // 旧库无项目（空库或损坏）→ 直接新建
        console.log('  \x1b[90m（旧库无项目数据，将新建空项目）\x1b[0m');
        rl.close();
        return await promptNewProject(dataDir);
      }
    }

    // ---- 场景 B：菜单选择 ----
    console.log('\n  \x1b[1;33m📚 选择项目\x1b[0m');
    const options = [...projects];
    if (lastProject && !options.includes(lastProject)) {
      // 上次的项目不在列表（目录被删？），忽略
    }
    options.forEach((p, i) => {
      const marker = p === lastProject ? ' \x1b[90m(上次)\x1b[0m' : '';
      console.log(`  [${i + 1}] ${p}${marker}`);
    });
    const newIdx = options.length + 1;
    console.log(`  [${newIdx}] 🆕 新建项目`);

    const defaultChoice = lastProject && options.includes(lastProject)
      ? String(options.indexOf(lastProject) + 1)
      : String(newIdx);
    const choice = (await ask(`  选择 (回车=${defaultChoice}): `)).trim() || defaultChoice;
    const choiceNum = parseInt(choice, 10);

    if (choiceNum === newIdx) {
      // 明确选"新建"
      rl.close();
      return await promptNewProject(dataDir);
    }
    if (choiceNum >= 1 && choiceNum <= options.length) {
      const name = options[choiceNum - 1]!;
      writeLastProject(dataDir, name);
      console.log('');
      rl.close();
      return { name, dir: join(dataDir, 'projects', name), isNew: false };
    }
    // 非法输入（如 /world、字母等）→ 提示并重新选择（不直接走新建，避免误触）
    console.log('  \x1b[33m无效选择，请输入数字。重新来。\x1b[0m');
    // 递归重选（rl 仍开着，不 close）
    return await selectProjectMenu(dataDir, rl, ask);
  } finally {
    // rl 由调用方管理（selectProjectMenu 或各分支自行 close）
  }
}

/**
 * 菜单重选（rl 复用，避免 close 后 stdin 断开）
 */
async function selectProjectMenu(
  dataDir: string,
  rl: readline.Interface,
  ask: (q: string) => Promise<string>,
): Promise<SelectedProject> {
  const projects = listProjects(dataDir);
  const lastProject = readLastProject(dataDir);

  console.log('\n  \x1b[1;33m📚 选择项目\x1b[0m');
  const options = [...projects];
  options.forEach((p, i) => {
    const marker = p === lastProject ? ' \x1b[90m(上次)\x1b[0m' : '';
    console.log(`  [${i + 1}] ${p}${marker}`);
  });
  const newIdx = options.length + 1;
  console.log(`  [${newIdx}] 🆕 新建项目`);

  const defaultChoice = lastProject && options.includes(lastProject)
    ? String(options.indexOf(lastProject) + 1)
    : String(newIdx);
  const choice = (await ask(`  选择 (回车=${defaultChoice}): `)).trim() || defaultChoice;
  const choiceNum = parseInt(choice, 10);

  if (choiceNum === newIdx) {
    rl.close();
    return await promptNewProject(dataDir);
  }
  if (choiceNum >= 1 && choiceNum <= options.length) {
    const name = options[choiceNum - 1]!;
    writeLastProject(dataDir, name);
    console.log('');
    rl.close();
    return { name, dir: join(dataDir, 'projects', name), isNew: false };
  }
  // 非法输入 → 提示并重选
  console.log('  \x1b[33m无效选择，请输入数字。重新来。\x1b[0m');
  return await selectProjectMenu(dataDir, rl, ask);
}

/** 新建项目交互（输入名称 → 校验 → 建目录） */
async function promptNewProject(dataDir: string): Promise<SelectedProject> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string): Promise<string> =>
    new Promise((resolve) => rl.question(q, (ans) => resolve(ans)));
  try {
    while (true) {
      const name = (await ask('  输入新项目名: ')).trim();
      if (!isValidProjectName(name)) {
        console.log('  \x1b[31m项目名非法（不能为空、含路径分隔符、以点开头）。重试。\x1b[0m');
        continue;
      }
      const existing = listProjects(dataDir);
      if (existing.includes(name)) {
        console.log('  \x1b[31m项目已存在，请用其他名字或选择已有项目。\x1b[0m');
        continue;
      }
      const dir = ensureProjectDir(dataDir, name);
      writeLastProject(dataDir, name);
      console.log(`  \x1b[32m✅ 已创建项目「${name}」\x1b[0m\n`);
      return { name, dir, isNew: true };
    }
  } finally {
    rl.close();
  }
}

/** 降级：迁移取消时新建空项目 */
async function fallbackNewProject(dataDir: string, _rl: readline.Interface, _ask: (q: string) => Promise<string>): Promise<SelectedProject> {
  // selectProject 内的 rl 已 close，promptNewProject 会自建
  return await promptNewProject(dataDir);
}

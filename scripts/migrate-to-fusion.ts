// =============================================================================
// 存储融合数据迁移脚本（存储融合阶段7，一次性，幂等）
// =============================================================================
// 迁移三类旧数据到融合架构（data/app.db + data/projects/<名>/{project.db, vectors/}）：
//   A. 现有 CLI 项目（data/projects/<名>/cli.db + lancedb/）→ 重命名 project.db + vectors/，写 app.db
//   B. BFF drafting.db 文档树 → 导出到「灰域行者」项目（用户的真实设定文档）
//   C. 旧库 data/cli-project.db → 同 A（迁移为新项目）
//
// 幂等：重复跑不重复迁移（已注册的项目跳过；drafting.db 导出按文档 id 去重）
// 安全：旧库保留（copy 非 move），迁移失败可重试
//
// 用法：npx tsx scripts/migrate-to-fusion.ts
// =============================================================================

import Database from 'better-sqlite3';
import { existsSync, mkdirSync, copyFileSync, renameSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { getAppRegistry, type AppRegistry } from '../src/session/app-registry.js';
import type { AppProjectRecord } from '../src/session/app-registry.js';
// 用 writing store 的 DDL 幂等补建缺失表（旧库可能缺 Phase 12 的 writing_documents 等）
import { SQLiteWritingStore } from '../src/writing/repositories/writing-store.js';

const DATA_DIR = './data';
const PROJECTS_DIR = join(DATA_DIR, 'projects');

/** coreProjectId 派生（与 project-manager.ts 一致） */
function deriveCoreProjectId(writingProjectId: string): string {
  return `core_${writingProjectId}`;
}

/** 从 project.db 读 writingProjectId（取第一条 writing_projects） */
function readWritingProjectId(dbPath: string): string | undefined {
  if (!existsSync(dbPath)) return undefined;
  const db = new Database(dbPath, { readonly: true });
  try {
    // 旧库可能连 writing_projects 表都没有（极早期 schema），try/catch 优雅跳过
    const row = db.prepare('SELECT id FROM writing_projects WHERE deleted_at IS NULL LIMIT 1').get() as { id: string } | undefined;
    return row?.id;
  } catch {
    return undefined;
  } finally {
    db.close();
  }
}

/**
 * 迁移 A/C：把一个旧 CLI 项目目录（cli.db + lancedb/）规范化为融合布局。
 * - cli.db → project.db（copy，保留旧文件）
 * - lancedb/ → vectors/（rename，向量数据大不复制）
 * - 写 app.db 注册表
 * 幂等：已注册则跳过。
 */
function migrateLegacyCliProject(registry: AppRegistry, projectDir: string, name: string): void {
  const oldDb = join(projectDir, 'cli.db');
  const newDb = join(projectDir, 'project.db');
  const oldLance = join(projectDir, 'lancedb');
  const newVectors = join(projectDir, 'vectors');

  // 幂等：app.db 已注册该项目名则跳过
  if (registry.getProjectByName(name)) {
    console.log(`  [跳过] ${name} 已注册`);
    return;
  }

  const writingProjectId = readWritingProjectId(oldDb);
  if (!writingProjectId) {
    console.log(`  [警告] ${name} 的 cli.db 无 writing_projects 行，跳过`);
    return;
  }

  // cli.db → project.db（copy 保留旧文件）
  if (existsSync(oldDb) && !existsSync(newDb)) {
    copyFileSync(oldDb, newDb);
    console.log(`  [复制] ${name}: cli.db → project.db`);
  }
  // lancedb/ → vectors/（rename）
  if (existsSync(oldLance) && !existsSync(newVectors)) {
    renameSync(oldLance, newVectors);
    console.log(`  [重命名] ${name}: lancedb/ → vectors/`);
  }

  // 写 app.db 注册表
  registry.registerProject({
    id: writingProjectId,
    name,
    dbPath: newDb,
    coreProjectId: deriveCoreProjectId(writingProjectId),
    vectorsPath: newVectors,
  });
  console.log(`  [注册] ${name} → app.db (id=${writingProjectId})`);
}

/**
 * 迁移 B：把 BFF drafting.db 的文档树导出到目标项目 project.db。
 * - 源：apps/bff/data/drafting.db（writing_documents 表）
 * - 目标：目标 project.db 的 writing_documents（覆盖式合并：按文档 id 去重，已存在则跳过）
 * 幂等：目标已存在的文档 id 跳过。
 */
function migrateBffDocuments(targetProjectDir: string): void {
  const sourceDbPath = 'apps/bff/data/drafting.db';
  const targetDbPath = join(targetProjectDir, 'project.db');
  if (!existsSync(sourceDbPath)) {
    console.log('  [跳过] B: drafting.db 不存在');
    return;
  }
  if (!existsSync(targetDbPath)) {
    console.log(`  [警告] B: 目标 project.db 不存在 (${targetDbPath})，跳过`);
    return;
  }

  const src = new Database(sourceDbPath, { readonly: true });
  const dst = new Database(targetDbPath);
  try {
    // 旧目标库可能缺 Phase 12 的 writing_documents 表（旧 store 建的库表不全）。
    // 用 SQLiteWritingStore.createTables 幂等补齐全部 writing_* 表（已存在的表 IF NOT EXISTS 跳过）。
    const writingStore = new SQLiteWritingStore(dst);
    writingStore.createTables();

    const docs = src.prepare('SELECT * FROM writing_documents WHERE deleted_at IS NULL').all() as any[];
    if (docs.length === 0) {
      console.log('  [跳过] B: drafting.db 无文档');
      return;
    }
    // 读目标项目的 writingProjectId（文档的 project_id 要改成目标项目）
    const targetProj = dst.prepare('SELECT id FROM writing_projects WHERE deleted_at IS NULL LIMIT 1').get() as { id: string };
    let inserted = 0;
    let skipped = 0;
    const insert = dst.prepare(`
      INSERT OR IGNORE INTO writing_documents
      (id, project_id, parent_id, kind, template, title, icon, content, content_format,
       chapter_plan_id, draft_id, sort_order, template_fields_json, word_count, tags_json,
       status, version, created_at, updated_at)
      VALUES (@id, @project_id, @parent_id, @kind, @template, @title, @icon, @content, @content_format,
              @chapter_plan_id, @draft_id, @sort_order, @template_fields_json, @word_count, @tags_json,
              @status, @version, @created_at, @updated_at)
    `);
    for (const d of docs) {
      // 去重：目标已存在该 id 则跳过
      const exists = dst.prepare('SELECT 1 FROM writing_documents WHERE id = ?').get(d.id);
      if (exists) { skipped++; continue; }
      insert.run({
        ...d,
        project_id: targetProj.id, // 改归属到目标项目
      });
      inserted++;
    }
    console.log(`  [导出] B: drafting.db → ${targetProjectDir} (新增 ${inserted}，跳过已存在 ${skipped})`);
  } finally {
    src.close();
    dst.close();
  }
}

async function main() {
  console.log('═'.repeat(56));
  console.log('  📦 存储融合数据迁移');
  console.log('═'.repeat(56));

  mkdirSync(PROJECTS_DIR, { recursive: true });
  const registry = getAppRegistry(join(DATA_DIR, 'app.db'));

  // ---- A: 现有 CLI 项目（data/projects/*/cli.db）----
  console.log('\n📁 A: 迁移现有 CLI 项目');
  if (existsSync(PROJECTS_DIR)) {
    for (const e of readdirSync(PROJECTS_DIR, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const dir = join(PROJECTS_DIR, e.name);
      if (existsSync(join(dir, 'cli.db')) || existsSync(join(dir, 'project.db'))) {
        migrateLegacyCliProject(registry, dir, e.name);
      }
    }
  }

  // ---- B: BFF drafting.db 文档树 → 导出到「灰域行者」（用户真实设定文档）----
  console.log('\n📄 B: 迁移 BFF drafting.db 文档树');
  // 目标项目优先「灰域行者」，否则取第一个已注册项目
  const target = registry.getProjectByName('灰域行者') ?? registry.listProjects()[0];
  if (target) {
    migrateBffDocuments(dirname(target.dbPath));
  } else {
    console.log('  [警告] B: 无已注册项目可作导出目标，跳过（先跑 A）');
  }

  // ---- C: 旧库 data/cli-project.db ----（作为独立新项目迁移）
  console.log('\n🗃️  C: 迁移旧库 cli-project.db');
  const legacyDb = join(DATA_DIR, 'cli-project.db');
  if (existsSync(legacyDb)) {
    // 读旧库项目名
    let legacyName = '迁移项目';
    try {
      const db = new Database(legacyDb, { readonly: true });
      const row = db.prepare('SELECT title FROM writing_projects WHERE deleted_at IS NULL LIMIT 1').get() as { title: string } | undefined;
      db.close();
      if (row?.title) legacyName = row.title;
    } catch { /* 用默认名 */ }
    // 建项目目录 + 复制旧库过去，再走 A 的规范化
    const legacyDir = join(PROJECTS_DIR, legacyName);
    mkdirSync(legacyDir, { recursive: true });
    if (!existsSync(join(legacyDir, 'cli.db'))) {
      copyFileSync(legacyDb, join(legacyDir, 'cli.db'));
    }
    migrateLegacyCliProject(registry, legacyDir, legacyName);
  } else {
    console.log('  [跳过] C: 旧库 cli-project.db 不存在');
  }

  // ---- 汇总 ----
  console.log('\n' + '═'.repeat(56));
  const all = registry.listProjects();
  console.log(`  ✅ 迁移完成。app.db 共 ${all.length} 个项目：`);
  for (const p of all) {
    console.log(`     • ${p.name} (id=${p.id}, core=${p.coreProjectId})`);
  }
  console.log('  注：旧 cli.db 保留（未删除）；drafting.db 保留（未删除，可手动清理）');
  console.log('═'.repeat(56));
}

main().catch(err => {
  console.error('迁移失败：', err);
  process.exit(1);
});

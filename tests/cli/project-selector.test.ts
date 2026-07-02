// =============================================================================
// 项目选择器测试（project-selector.ts 的纯函数）
// =============================================================================
// 存储融合后：project-selector 只保留 readLastProject/writeLastProject
// （记住上次选择）+ selectProject（readline 交互，不在此测）。
// 项目扫描/校验/迁移逻辑已移至 src/session/（ProjectManager），见
// tests/session/project-manager.test.ts。
// =============================================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { readLastProject, writeLastProject } from '../../src/cli/project-selector.js';

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'proj-sel-'));
});

afterEach(() => {
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
});

describe('readLastProject / writeLastProject（记住上次）', () => {
  it('无记录返回 undefined', () => {
    expect(readLastProject(dataDir)).toBeUndefined();
  });

  it('写入后能读回', () => {
    writeLastProject(dataDir, '灰域科幻');
    expect(readLastProject(dataDir)).toBe('灰域科幻');
  });

  it('空内容记录返回 undefined', () => {
    writeFileSync(join(dataDir, '.current-project'), '   \n');
    expect(readLastProject(dataDir)).toBeUndefined();
  });

  it('覆盖写入（多次记录只保留最后一次）', () => {
    writeLastProject(dataDir, '项目A');
    writeLastProject(dataDir, '项目B');
    expect(readLastProject(dataDir)).toBe('项目B');
  });
});

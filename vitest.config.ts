import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 测试环境：Node.js
    environment: 'node',

    // 加载 .env 配置（通过 setupFiles 中的 dotenv 加载）
    setupFiles: ['./vitest.setup.ts'],

    // 测试文件匹配规则
    include: ['tests/**/*.test.ts'],

    // 全局设置（如超时）
    testTimeout: 10000,

    // 覆盖率配置（后续启用）
    // coverage: {
    //   provider: 'v8',
    //   include: ['src/**/*.ts'],
    // },
  },

  // ---------------------------------------------------------------------------
  // 并发上限（2026-06-14，W2 收尾时定位的测试稳定性修复）
  // ---------------------------------------------------------------------------
  // vitest 4：pool / maxWorkers 是【顶层】配置（非 test 内——test.poolOptions 在 v4 已移除，
  // 误放会被忽略并打印 DEPRECATED 警告；正确位置是 defineConfig 根，见 vitest pool-rework 迁移）。
  //
  // 背景：本仓库测试栈大量使用 better-sqlite3（同步原生 Node addon），每个测试文件在自己的
  // fork 进程里 new SQLiteFactStoreAdapter(':memory:')。vitest 默认按 CPU 数开 fork（本机 20 核
  // 会开约 10 个并行 worker），高并发下 Windows 出现 "Worker exited unexpectedly" —— better-sqlite3
  // 原生模块在大量 fork 并发初始化/销毁时的句柄竞争导致 worker 偶发崩溃（非逻辑失败：单文件 /
  // 单 fork 模式 100% 绿）。属原生 addon + 平台的已知交互问题，非测试代码缺陷。
  //
  // 修复：把并发 worker 上限压到 4（≈ 默认的 40%），把原生模块并发压力降到崩溃阈值之下。
  //
  // 为何不直接 singleFork：本测试套件是【同步绑定】的（better-sqlite3 同步 I/O + 模块加载占大头），
  // 默认并行实测也只获得约 1.7x 加速；maxWorkers:4 保留这点并行收益，同时消除偶发崩溃。
  //
  // 维护：若新增重原生模块（如 LanceDB embedding）导致 4 仍偶发崩溃，可下调至 2，或改用
  // fileParallelism: false（最稳但完全串行）。单文件开发迭代不受此限制影响（始终秒级）。
  // ---------------------------------------------------------------------------
  pool: 'forks',
  maxWorkers: 4,
});

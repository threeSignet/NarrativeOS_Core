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
});

// =============================================================================
// Narrative-OS-Core 主入口
// =============================================================================
// 向外暴露所有核心类型和适配器接口。
// 具体实现（SQLiteFactStoreAdapter 等）由各 adapters/ 子目录导出。

// 核心类型定义 —— 单一真相源
export * from './types.js';

// Phase 1.5A 只读查询层
export * from './core/query-engine.js';

// 适配器实现按需导入：
//   import { SQLiteFactStoreAdapter } from 'narrative-os-core/adapters/sqlite/fact-store.js';
//   import { SQLiteThreadStoreAdapter } from 'narrative-os-core/adapters/sqlite/thread-store.js';

// =============================================================================
// Narrative-OS-Core 主入口
// =============================================================================
// 向外暴露所有核心类型和适配器接口。
// 具体实现（SQLiteFactStoreAdapter 等）由各 adapters/ 子目录导出。

// 核心类型定义 —— 单一真相源
export * from './types.js';

// Phase 1.5A 只读查询层
export * from './core/query-engine.js';

// Phase 4 检索管线
export { ContextAnalyzer } from './core/context-analyzer.js';
export type { WritingContext, ContextSignals } from './core/context-analyzer.js';
export { RelevantFactRetriever } from './core/relevant-fact-retriever.js';
export type { RetrievalOptions } from './core/relevant-fact-retriever.js';
export { FactRenderer } from './core/fact-renderer.js';

// Agent 层（NarrativeAgent v0.1）
export { NarrativeAgent } from './agent/narrative-agent.js';
export type { AgentTurnResult } from './agent/narrative-agent.js';
export { MemoryManager } from './agent/memory-manager.js';
export { ContextCompressor } from './agent/context-compressor.js';
export type { CompressionResult, CompressionTrigger } from './agent/context-compressor.js';
export * from './agent/types.js';

// 适配器实现按需导入：
//   import { SQLiteFactStoreAdapter } from 'narrative-os-core/adapters/sqlite/fact-store.js';
//   import { SQLiteThreadStoreAdapter } from 'narrative-os-core/adapters/sqlite/thread-store.js';
//   import { SQLiteAgentStoreAdapter } from 'narrative-os-core/adapters/sqlite/agent-store.js';

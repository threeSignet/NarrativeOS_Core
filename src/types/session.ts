// =============================================================================
// ProjectSession 核心上下文
// =============================================================================
// §16: ProjectSession — 所有引擎组件的统一定义入口

import type { FactStore } from './stores.js';
import type { ThreadStore } from './stores.js';
import type { KnowledgeStore } from './stores.js';
import type { EventStore } from './stores.js';
import type { ProposalStore } from './stores.js';
import type { VectorStore } from './stores.js';
import type { EmbeddingService, LLMClient } from './llm.js';
import type { WorldPackage } from './world.js';

/**
 * ProjectSession：核心上下文对象
 *
 * 所有引擎组件共享同一个项目上下文，统一持有所有 Store 和服务实例，
 * 避免调用签名膨胀和实例版本不一致风险。
 */
export interface ProjectSession {
  projectId: string;
  factStore: FactStore;
  threadStore: ThreadStore;
  knowledgeStore: KnowledgeStore;
  eventStore: EventStore;
  proposalStore: ProposalStore;
  vectorStore: VectorStore;
  embedder: EmbeddingService;
  llm: LLMClient;
  worldPackage: WorldPackage;
}

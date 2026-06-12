// =============================================================================
// Narrative-OS-Core 核心类型定义 — 统一桶导出
// =============================================================================
// 本文档是 Narrative-OS-Core 的单一类型真相源的桶导出入口。
// 所有类型定义已按领域拆分到子文件中：
//
//   base.ts      — FactValue / EntityRef / FactScalarType / Certainty
//   entity.ts    — EntityKind / RelationKind / EntityRecord
//   fact.ts      — Fact / FactChange / FactChangeInput / FactGroup / FactIndexEntry
//                   + 序列化工具 (serializeFactValue / deserializeFactValue)
//   thread.ts    — ThreadDirection / ThreadType / ThreadStatus / ThreadMilestone / NarrativeThread
//   knowledge.ts — KnowledgeSource / Knowledge / KnowledgeChangeInput
//   event.ts     — EventKindFilter / NarrativeEvent
//   rule.ts      — RuleType / DeclarativeRule / RuleCondition / RuleConsequence
//                   / PropagationConfig / EventConsequence / ProposedKnowledge
//   world.ts     — ContextScopeConfig / WorldPackage / PredicateDefinition / RuleSet
//                   / EntityTemplate / ContextScopePreset / ValidationReport / ConsistencyViolation
//   stores.ts    — FactStore / ThreadStore / KnowledgeStore / EventStore / ProposalStore
//                   / VectorStore / NarrativeQueryEngine / 所有 Filter 类型
//   tool.ts      — 10 个 Tool I/O 类型 + ToolErrorCode / ToolError / ToolResult
//   llm.ts       — EmbeddingService / LLMClient / ChatMessage / ChatOptions
//                   / ToolDefinition / ToolCallResult
//   vector.ts    — VectorEntry / VectorQuery / ScoredFact / RelevantFactSet
//                   / SyncQueueOperation / SyncQueueEntry
//   snapshot.ts  — WorldSnapshot / SnapshotData / SnapshotTriggerType
//   session.ts   — ProjectSession
//
// 设计原则：
//   - 所有接口定义在此目录中，实现在各 adapters/ 和 core/ 目录
//   - 对外部消费者只暴露此 index.ts，内部子文件可互相引用
//   - 领域类型使用 camelCase，LLM 外部接口使用 snake_case（由 Tool Interface 层转换）

// ---- 基础类型 (§1-2) ----
export type { FactValue, EntityRef, FactScalarType, Certainty } from './base.js';

// ---- 实体类型 (§3) ----
export type { EntityKind, RelationKind, EntityRecord } from './entity.js';

// ---- Fact 类型 (§4, §18-19) ----
export type {
  Fact,
  FactChange,
  FactChangeInput,
  FactGroup,
  FactIndexEntry,
} from './fact.js';
export { FACT_CHANGE_MAPPING, serializeFactValue, deserializeFactValue } from './fact.js';

// ---- ContextScope (§5) ----
export type { ContextScopeConfig } from './world.js';

// ---- NarrativeThread (§6) ----
export type {
  ThreadDirection,
  ThreadType,
  ThreadStatus,
  ThreadMilestone,
  NarrativeThread,
} from './thread.js';

// ---- Knowledge (§7) ----
export type { KnowledgeSource, Knowledge, KnowledgeChangeInput } from './knowledge.js';

// ---- NarrativeEvent (§8) ----
export type { EventKindFilter, NarrativeEvent } from './event.js';

// ---- Rule Engine (§9) ----
export type {
  RuleType,
  DeclarativeRule,
  RuleCondition,
  RuleConsequence,
  PropagationConfig,
  EventConsequence,
  ProposedKnowledge,
} from './rule.js';

// ---- World Package (§5, §10) ----
export type {
  WorldPackage,
  PredicateDefinition,
  RuleSet,
  ValidationReport,
  ConsistencyViolation,
  EntityTemplate,
  ContextScopePreset,
} from './world.js';

// ---- Tool Interface (§11) ----
export type {
  ContextSliceResult,
  RetrievalTelemetry,
  KnowledgeHint,
  KnowledgeBroadcast,
  ProposeEventInput,
  ProposalResult,
  CommitEventInput,
  CommitEventResult,
  ProposeRetconInput,
  ProposeRetconResult,
  CommitRetconInput,
  RegisterEntityInput,
  RegisterEntityResult,
  OpenThreadsResult,
  ResolveThreadInput,
  ProposeSchemaExtensionInput,
  CommitSchemaExtensionInput,
} from './tool.js';

// ---- 适配器接口 (§12) ----
export type {
  FactStore,
  FactQuery,
  FactFilter,
  ThreadStore,
  ThreadFilter,
  KnowledgeStore,
  KnowledgeFilter,
  NarrativeKnowledgeFilter,
  EventStore,
  EntityFilter,
  EventFilter,
  NarrativeQueryEngine,
  ProposalStore,
  VectorStore,
} from './stores.js';

// ---- LLM 与嵌入 (§13) ----
export type {
  EmbeddingService,
  LLMClient,
  ChatMessage,
  ChatOptions,
  ToolDefinition,
  ToolCallResult,
} from './llm.js';

// ---- 向量与同步 (§12 Vector, §15) ----
export type {
  VectorEntry,
  VectorQuery,
  ScoredFact,
  RelevantFactSet,
  SyncQueueOperation,
  SyncQueueEntry,
} from './vector.js';

// ---- 快照 (§14) ----
export type { WorldSnapshot, SnapshotData, SnapshotTriggerType } from './snapshot.js';

// ---- ProjectSession (§16) ----
export type { ProjectSession } from './session.js';

// ---- 错误编码 (§17) ----
export { ToolErrorCode } from './tool.js';
export type { ChapterLevelWarning, ToolError, ToolResult } from './tool.js';

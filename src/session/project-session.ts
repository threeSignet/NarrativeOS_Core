// =============================================================================
// ProjectSession —— 项目级统一装配入口（存储融合阶段3）
// =============================================================================
// 职责：
//   - 打开一个项目的 project.db（自己 new Database + pragma WAL/foreign_keys）
//   - 按序装配三层：Core adapter/业务 → 写作层 service → Agent → 向量检索
//   - 持有全部 store/service 句柄，暴露给 CLI/BFF 复用
//   - 消除"FactStore 既是 adapter 又是 db 工厂"的双重身份（用 forExistingDb）
//
// 设计要点：
//   - 项目创建不在本类（归 ProjectManager）。本类只打开已存在的库并装配。
//     新建项目时，ProjectManager 先用一个空库装配出 ProjectSession，
//     再调 projectService.createProject 拿 writingProjectId。
//   - 可选装配 { withAgent, withVector }：BFF 无 LLM/embedding 时跳过，避免硬依赖。
//   - 双 id（coreProjectId / writingProjectId）由调用方提供，本类不派生。
//     writingProjectId 可延迟设置（新建项目时先装配、后 set）。
// =============================================================================

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// Core adapters
import { SQLiteFactStoreAdapter } from '../adapters/sqlite/fact-store.js';
import { SQLiteKnowledgeStoreAdapter } from '../adapters/sqlite/knowledge-store.js';
import { SQLiteEventStoreAdapter } from '../adapters/sqlite/event-store.js';
import { SQLiteThreadStoreAdapter } from '../adapters/sqlite/thread-store.js';
// Core 业务
import { ThreadResolver } from '../core/thread-resolver.js';
import { RuleEngine } from '../core/rule-engine.js';
import { ProposalManager } from '../core/proposal-manager.js';
import { RetconEngine } from '../core/retcon-engine.js';
import { ToolService } from '../core/tool-service.js';
import { SchemaExtensionManager } from '../core/schema-extension-manager.js';
import { ToolRouter } from '../core/tool-router.js';
import { RelevantFactRetriever } from '../core/relevant-fact-retriever.js';
import { FactRenderer } from '../core/fact-renderer.js';
import { SyncQueueConsumer } from '../core/sync-queue-consumer.js';
// 写作层
import { SQLiteWritingStore } from '../writing/repositories/writing-store.js';
import { AuditService } from '../writing/services/audit-service.js';
import { WorkflowService } from '../writing/services/workflow-service.js';
import { ProjectService } from '../writing/services/project-service.js';
import { DraftService } from '../writing/services/draft-service.js';
import { EntityService } from '../writing/services/entity-service.js';
import { BlueprintService } from '../writing/services/blueprint-service.js';
import { IdeaService } from '../writing/services/idea-service.js';
import { RelationService } from '../writing/services/relation-service.js';
import { GraphService } from '../writing/services/graph-service.js';
import { SpatialService } from '../writing/services/spatial-service.js';
import { SpatialViewService } from '../writing/services/spatial-view-service.js';
import { ChapterService } from '../writing/services/chapter-service.js';
import { SceneService } from '../writing/services/scene-service.js';
import { TimelineService } from '../writing/services/timeline-service.js';
import { ReaderService } from '../writing/services/reader-service.js';
import { ForeshadowingService } from '../writing/services/foreshadowing-service.js';
import { ProseService } from '../writing/services/prose-service.js';
import { StyleService } from '../writing/services/style-service.js';
import { RevisionService } from '../writing/services/revision-service.js';
import { RetconViewService } from '../writing/services/retcon-view-service.js';
import { ImportExportService } from '../writing/services/import-export-service.js';
import { DocumentService } from '../writing/services/document-service.js';
import { RealCoreBridge } from '../writing/core-bridge/real-bridge.js';
import { makeRequestContext } from '../writing/services/context.js';
import type { WritingRequestContext, WritingTrigger } from '../writing/services/context.js';

/** ProjectSession 构造参数 */
export interface ProjectSessionOptions {
  /** project.db 文件路径 */
  dbPath: string;
  /** Core 层项目 id（Core 表用） */
  coreProjectId: string;
  /** 写作层项目 id（writing_* 表 FK 目标，wprj_xxx）。新建项目时可先不传，后用 setWritingProjectId */
  writingProjectId?: string;
  /** 向量库目录路径；不传则不装配向量层 */
  vectorsPath?: string;
  /** 是否装配 Agent（默认 true）。BFF 无 LLM/embedding 时传 false */
  withAgent?: boolean;
  /** 是否装配向量检索（默认 true，需 vectorsPath）。无 embedder 配置时传 false */
  withVector?: boolean;
}

/**
 * 一个项目的完整装配会话。打开 project.db，装配三层 store/service。
 */
export class ProjectSession {
  readonly db: Database.Database;
  readonly coreProjectId: string;

  // Core adapters
  readonly factStore: SQLiteFactStoreAdapter;
  readonly knowledgeStore: SQLiteKnowledgeStoreAdapter;
  readonly eventStore: SQLiteEventStoreAdapter;
  readonly threadStore: SQLiteThreadStoreAdapter;
  readonly schemaExtensionManager: SchemaExtensionManager;
  // Core 业务
  readonly threadResolver: ThreadResolver;
  readonly ruleEngine: RuleEngine;
  readonly proposalManager: ProposalManager;
  readonly retconEngine: RetconEngine;
  readonly toolService: ToolService;
  readonly toolRouter: ToolRouter;
  readonly coreBridge: RealCoreBridge;
  // 写作层
  readonly writingStore: SQLiteWritingStore;
  readonly auditService: AuditService;
  readonly workflowService: WorkflowService;
  readonly projectService: ProjectService;
  readonly draftService: DraftService;
  readonly entityService: EntityService;
  readonly blueprintService: BlueprintService;
  readonly ideaService: IdeaService;
  readonly relationService: RelationService;
  readonly graphService: GraphService;
  readonly spatialService: SpatialService;
  readonly spatialViewService: SpatialViewService;
  readonly chapterService: ChapterService;
  readonly sceneService: SceneService;
  readonly timelineService: TimelineService;
  readonly readerService: ReaderService;
  readonly foreshadowingService: ForeshadowingService;
  readonly proseService: ProseService;
  readonly styleService: StyleService;
  readonly revisionService: RevisionService;
  readonly retconViewService: RetconViewService;
  readonly importExportService: ImportExportService;
  readonly documentService: DocumentService;
  // Agent / 向量（可选，由 initAgent / initVector 异步装配）
  agent?: any;
  agentStore?: any;
  llm?: any;
  vectorStore?: any;
  retriever?: any;
  renderer?: any;
  consumer?: any;
  embedder?: any;

  /** 写作层项目 id（可后设，新建项目场景） */
  private _writingProjectId: string | undefined;

  constructor(opts: ProjectSessionOptions) {
    this.coreProjectId = opts.coreProjectId;
    this._writingProjectId = opts.writingProjectId;

    // ---------- 1. 打开 project.db ----------
    mkdirSync(dirname(opts.dbPath), { recursive: true });
    this.db = new Database(opts.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');

    // ---------- 2. Core adapters（FactStore 用 forExistingDb，不再自己 open）----------
    this.factStore = SQLiteFactStoreAdapter.forExistingDb(this.db, this.coreProjectId);
    this.knowledgeStore = new SQLiteKnowledgeStoreAdapter(this.db);
    this.eventStore = new SQLiteEventStoreAdapter(this.db);
    this.threadStore = new SQLiteThreadStoreAdapter(this.db);

    // ---------- 3. Core 业务 ----------
    this.threadResolver = new ThreadResolver();
    this.ruleEngine = new RuleEngine();
    this.proposalManager = new ProposalManager(this.ruleEngine, undefined, this.threadStore, this.threadResolver);
    this.retconEngine = new RetconEngine();
    this.toolService = new ToolService(this.factStore, this.knowledgeStore, this.eventStore, this.threadStore, this.threadResolver);
    this.schemaExtensionManager = new SchemaExtensionManager(this.db, this.coreProjectId);
    this.toolRouter = new ToolRouter({
      proposalManager: this.proposalManager, retconEngine: this.retconEngine,
      toolService: this.toolService, schemaExtensionManager: this.schemaExtensionManager,
      factStore: this.factStore, knowledgeStore: this.knowledgeStore,
      eventStore: this.eventStore, threadStore: this.threadStore,
    });

    // ---------- 4. 写作层 ----------
    this.writingStore = new SQLiteWritingStore(this.db);
    this.writingStore.createTables();
    this.auditService = new AuditService(this.writingStore);
    this.workflowService = new WorkflowService(this.writingStore, this.auditService);
    // RealCoreBridge 注入 auditService：commit/register 内部落地审计
    this.coreBridge = new RealCoreBridge(this.toolRouter, this.writingStore, this.auditService);
    // 启动对账（§7.11.5 两阶段提交恢复）
    this.coreBridge.reconcile();

    this.projectService = new ProjectService(this.writingStore, this.auditService);
    this.draftService = new DraftService(this.writingStore, this.auditService, this.coreBridge, this.workflowService);
    this.entityService = new EntityService(this.writingStore, this.auditService, this.workflowService);
    this.blueprintService = new BlueprintService(this.writingStore, this.auditService);
    // IdeaService 与 DraftService 存在循环依赖，用 bind 破环
    this.ideaService = new IdeaService(this.writingStore, this.auditService, this.draftService.createDraft.bind(this.draftService));

    this.relationService = new RelationService(this.writingStore, this.auditService, this.workflowService, this.coreBridge);
    this.graphService = new GraphService(this.writingStore, this.coreBridge);
    this.spatialService = new SpatialService(this.writingStore, this.auditService, this.workflowService, this.coreBridge);
    this.spatialViewService = new SpatialViewService(this.writingStore);

    this.chapterService = new ChapterService(this.writingStore, this.auditService);
    this.sceneService = new SceneService(this.writingStore, this.auditService);
    this.timelineService = new TimelineService(this.writingStore);

    this.readerService = new ReaderService(this.writingStore, this.auditService);
    this.foreshadowingService = new ForeshadowingService(this.writingStore, this.auditService);

    this.proseService = new ProseService(this.writingStore, this.auditService);
    this.styleService = new StyleService(this.writingStore, this.auditService);
    this.revisionService = new RevisionService(this.writingStore, this.auditService);
    this.retconViewService = new RetconViewService(this.writingStore, this.auditService);
    this.importExportService = new ImportExportService(this.writingStore, this.auditService, this.proseService);

    this.documentService = new DocumentService(this.writingStore, this.auditService);

    // ---------- 5. 回注写作服务到 ToolRouter ----------
    // writingProjectId 可能此时未定（新建项目场景）；用 getter 保证回注时拿到最新值
    const wpid = () => this.writingProjectId;
    this.toolRouter.setEntityService(this.entityService, wpid() as string);
    this.toolRouter.setGraphServices(this.relationService, this.graphService, wpid() as string);
    this.toolRouter.setSpatialServices(this.spatialService, this.spatialViewService, wpid() as string);
    this.toolRouter.setChapterSceneServices(this.chapterService, this.sceneService, this.timelineService, wpid() as string);
    this.toolRouter.setReaderForeshadowingServices(this.readerService, this.foreshadowingService, wpid() as string);
    this.toolRouter.setPhase12Services(this.proseService, this.styleService, this.retconViewService, this.importExportService, wpid() as string);

    // ---------- 6 & 7. Agent / 向量检索（可选，异步装配） ----------
    // 不在构造里同步装配：涉及 LanceDB 原生绑定（可能加载失败）+ LLM 网络配置，
    // 且 BFF 可能不需要 agent。由调用方按需 await initAgent() / initVector()。
  }

  /**
   * 异步装配向量检索管线（Phase 7 闭环基础设施）。
   * - 向量库目录不存在则创建
   * - init 失败（原生绑定/磁盘）时降级为 undefined，确定性查询照常
   * 由 CLI 调用；BFF 通常不需要。
   */
  async initVector(vectorsPath: string): Promise<void> {
    const { existsSync, mkdirSync } = await import('node:fs');
    if (!existsSync(vectorsPath)) mkdirSync(vectorsPath, { recursive: true });
    try {
      const { LanceDBTableAdapter } = await import('../adapters/lancedb/table-adapter.js');
      const { SiliconFlowEmbeddingService } = await import('../adapters/embedding/siliconflow-embedder.js');
      const { RelevantFactRetriever } = await import('../core/relevant-fact-retriever.js');
      const { FactRenderer } = await import('../core/fact-renderer.js');
      const { SyncQueueConsumer } = await import('../core/sync-queue-consumer.js');
      this.vectorStore = new LanceDBTableAdapter(vectorsPath, 'facts');
      await this.vectorStore.init();
      this.embedder = new SiliconFlowEmbeddingService();
      this.retriever = new RelevantFactRetriever(this.factStore, this.knowledgeStore, this.threadStore, this.vectorStore, this.embedder);
      this.renderer = new FactRenderer();
      this.consumer = new SyncQueueConsumer(this.db, this.vectorStore, this.embedder);
    } catch (err) {
      console.warn(`  ⚠️ 向量检索初始化失败，语义召回不可用（确定性查询照常）：${err instanceof Error ? err.message : err}`);
    }
  }

  /**
   * 异步装配 Agent（NarrativeAgent + LLM + AgentStore）。
   * 需先 setWritingProjectId（agent 依赖 writingProjectId）。
   * 由 CLI 调用；BFF 通常不需要（withAgent=false）。
   */
  async initAgent(opts?: { maxToolSteps?: number }): Promise<void> {
    if (!this._writingProjectId) {
      throw new Error('initAgent 前需先 setWritingProjectId');
    }
    const { NarrativeAgent } = await import('../agent/narrative-agent.js');
    const { DeepSeekLLMClientAdapter } = await import('../adapters/llm/deepseek-client.js');
    const { SQLiteAgentStoreAdapter } = await import('../adapters/sqlite/agent-store.js');
    this.llm = new DeepSeekLLMClientAdapter();
    this.agentStore = new SQLiteAgentStoreAdapter(this.db);
    this.agentStore.createTables();
    this.agent = new NarrativeAgent({
      llm: this.llm, toolRouter: this.toolRouter, agentStore: this.agentStore,
      projectId: this.coreProjectId,
      limits: {
        maxToolSteps: opts?.maxToolSteps ?? 32,
        maxRepeatedToolFailure: 3,
        maxWallClockMs: 30 * 60 * 1000,
      },
      writingProjectId: this._writingProjectId,
      writingStore: this.writingStore, auditService: this.auditService, workflowService: this.workflowService,
      draftService: this.draftService, entityService: this.entityService,
      coreBridge: this.coreBridge,
      projectService: this.projectService, blueprintService: this.blueprintService, ideaService: this.ideaService,
      retriever: this.retriever, renderer: this.renderer,
    });
  }

  /** 写作层项目 id（新建项目时由 ProjectManager 在 createProject 后 set） */
  get writingProjectId(): string | undefined {
    return this._writingProjectId;
  }
  /** 设置写作层项目 id（仅新建项目场景，装配后补设） */
  setWritingProjectId(id: string): void {
    this._writingProjectId = id;
    // writingProjectId 就绪后重新回注 ToolRouter（之前回注时可能是 undefined）
    this.toolRouter.setEntityService(this.entityService, id);
    this.toolRouter.setGraphServices(this.relationService, this.graphService, id);
    this.toolRouter.setSpatialServices(this.spatialService, this.spatialViewService, id);
    this.toolRouter.setChapterSceneServices(this.chapterService, this.sceneService, this.timelineService, id);
    this.toolRouter.setReaderForeshadowingServices(this.readerService, this.foreshadowingService, id);
    this.toolRouter.setPhase12Services(this.proseService, this.styleService, this.retconViewService, this.importExportService, id);
  }

  /** 构造写作层 ctx（writingProjectId 必须已设置） */
  makeCtx(opts?: { trigger?: WritingTrigger }): WritingRequestContext {
    if (!this._writingProjectId) {
      throw new Error('writingProjectId 未设置（新建项目需先 createProject 再调 makeCtx）');
    }
    return makeRequestContext({
      projectId: this._writingProjectId,
      trigger: opts?.trigger ?? 'author_action',
    });
  }

  /**
   * 构造引导期 ctx（projectId='pending'，仅用于 projectService.createProject）。
   * createProject 内部会用新项目 id 覆盖 ctx.projectId 建审计，故此处占位安全。
   * 仅新建项目场景使用。
   */
  makeCtxPending(): WritingRequestContext {
    return makeRequestContext({
      projectId: 'pending',
      sessionId: `bootstrap-${Date.now()}`,
      trigger: 'author_action',
    });
  }

  /** 关闭连接 */
  close(): void {
    this.db.close();
  }
}

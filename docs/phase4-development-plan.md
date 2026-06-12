# Phase 4 开发计划 ✅ 全部完成

> 语义检索层：将 Fact 向量化，实现语义相似度检索，主动向 LLM 注入相关上下文。
>
> **完成日期**：2026-06-12。4A-4E 全部完成，端到端集成测试通过。

---

## 全局验收标准

每个 Step 完成前必须满足：
- [x] `npm run typecheck` 零错误
- [x] `npm test` 全量通过（无回归）
- [x] 新增/修改的测试覆盖新逻辑
- [x] 交叉核对架构文档 §7 对应章节

---

## Phase 4A：FactEmbedder（向量化服务）

> 架构文档：§7.2.1

### Step 4A-1：EmbeddingService 接口 + 硅基流动实现

**状态**：✅ 已完成

- SiliconFlowEmbeddingService 调用 bge-m3 API（`src/adapters/embedding/siliconflow-embedder.ts`）
- 输入：Fact（自动拼接 subject + predicate + value → embeddingText）
- 输出：1024 维 number[]
- 错误处理：API 不可用时降级为零向量 + 告警
- 从 .env 读取 EMBEDDING_API_KEY / EMBEDDING_BASE_URL / EMBEDDING_MODEL

**测试**：
- [x] 单条 Fact 向量化
- [x] 批量向量化
- [x] API 错误降级

---

## Phase 4B：LanceDBTableAdapter（向量存储）

> 架构文档：§7.4 + 附录 E.5 sync_queue

### Step 4B-1：LanceDB 表初始化 + 基本 CRUD

**状态**：✅ 已完成

- init()：创建/连接 LanceDB 表（`src/adapters/lancedb/table-adapter.ts`，schema 定义 `src/adapters/lancedb/schema.ts`）
- add(vectors)：批量写入向量
- search(query)：ANN 检索，支持 metadata filter（`buildLanceFilter` 支持 is_current/certainty/context/temporal 多维过滤）
- markInvalid(factId)：标记向量失效（is_current=false）
- updateCertainty(factId, certainty)：更新确定性标记
- count() / getAllIds()

**测试**：
- [x] 表初始化和写入
- [x] ANN 检索（含 metadata filter）
- [x] markInvalid 后检索不可见

### Step 4B-2：sync_queue 消费者 + LanceDB 同步

**状态**：✅ 已完成

- SyncQueueConsumer 从 sync_queue 表读取未处理的 outbox 条目（`src/core/sync-queue-consumer.ts`）
- 处理 insert_vector / mark_invalid / update_certainty 三种操作
- 失败重试机制（retry_count/max_retries/next_retry_at）
- commit_event Phase C 调用 scheduleLanceDBSync

**测试**：
- [x] insert_vector 消费
- [x] mark_invalid 消费
- [x] 重试耗尽后标记 failed

---

## Phase 4C：ContextAnalyzer（上下文分析）

> 架构文档：§7.2.2

### Step 4C-1：ContextSignals 提取

**状态**：✅ 已完成

- 输入：currentChapter + entityIds + writingContext（`src/core/context-analyzer.ts`）
- 输出：ContextSignals { primaryEntities, temporalFocus, activeScopes, genreHints }
- 阶段一先用规则化快速路径（实体名匹配、章节邻近度）
- 后续可接 LLM 深度分析

**测试**：
- [x] 实体名提取
- [x] 时间焦点计算
- [x] 作用域信号

---

## Phase 4D：RelevantFactRetriever（六段检索管线）

> 架构文档：§7.2.2 + §10.2

### Step 4D-1：六段管线实现

**状态**：✅ 已完成

1. Step 0：短期工作记忆强制注入（最近 N 章事件涉及的 Fact）
2. Step 1：精确查询（场景实体快照 + 关系）
3. Step 2：语义检索（LanceDB ANN + metadata filter）
4. Step 3：叙事线索注入（活跃 Thread 关联的 Fact）
5. Step 4：排序与去重
6. Step 5：知识感知过滤（仅返回 requestingEntity 知晓的 Fact）

**实现位置**：`src/core/relevant-fact-retriever.ts`（RelevantFactRetriever 类）

**测试**：
- [x] 端到端检索管线（`tests/integration/retrieval-pipeline.test.ts`）
- [x] 空上下文降级
- [x] 去重逻辑

---

## Phase 4E：端到端集成测试

### Step 4E-1：完整 Push 流程验证

**状态**：✅ 已完成

- 写入 → 向量化 → LanceDB 存储 → 检索 → FactRenderer 渲染 → LLM 上下文注入
- 真实修仙叙事场景
- 实现位置：`tests/integration/end-to-end.test.ts`（完整组件栈测试）

**测试**：
- [x] 完整 Pipeline 测试

---

## Phase 4 完成标准 ✅ 全部达成

- [x] Embedding Service 可用，支持单条/批量向量化 + 错误降级
- [x] LanceDB 向量存储完整 CRUD + metadata filter + ANN 检索
- [x] sync_queue outbox 消费机制（retry + failed 标记）
- [x] ContextAnalyzer 规则化快速路径可用
- [x] RelevantFactRetriever 六段管线完整实现
- [x] 端到端 Push 流程测试通过（写入→向量化→检索→渲染→注入）
- [x] 18 个测试文件、312 个测试全量通过
- [x] `npm run typecheck` 零错误

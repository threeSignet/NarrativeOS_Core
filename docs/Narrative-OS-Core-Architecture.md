# Narrative-OS-Core 架构设计文档

**项目代号**：Narrative-OS-Core
**最后更新**：2026-06-08

---

## 修订摘要

以下记录架构设计过程中的关键决策和修订历史。

| 决策 | 原方案 | 最终方案 | 变更原因 |
|------|-----------|-----------|----------|
| 写入路径 | LLM → Wiki DSL 文本 → WikiParser → FactChange[] | LLM → Tool Call (JSON Schema) → FactChange[] | DSL 正则 Parser 健壮性远低于 JSON Schema 校验 |
| 存储结构 | 计划图结构（用 subject 字符串代替） | 明确为时序三元组存储，图是派生视图 | 关系本质是 Fact，图拓扑是查询视角而非存储结构 |
| 关系表达 | GraphEdge（计划中） | 关系谓词 Fact（`predicate = 'enemy_of'`） | 统一所有世界状态为 Fact，消除异构数据结构 |
| LLM 上下文 | Pull：LLM 主动调用 get_context_slice 查询 | Push：系统语义检索后主动注入 LLM 上下文 | LLM 不知道自己不知道什么，Pull 模式在大规模设定下失效 |
| Wiki 协议层 | WikiParser + WikiRenderer 作为整体设计 | 删除 WikiParser，保留 FactRenderer（原 WikiRenderer） | Wiki 协议作为整体时写入路径引入了不必要脆弱性 |
| 语义检索 | 后续迭代（GraphRAG） | 核心组件（Semantic Retrieval Layer） | 没有语义检索，FactStore 在大规模设定下形同虚设 |
| 向量库 | Milvus（需 Docker） | LanceDB via @lancedb/lancedb（嵌入式 npm 包，零服务进程） | Windows 原生支持，无需 Docker |
| 主存储 | 全内存 | SQLite via better-sqlite3 | 持久化 + 同步 API + 零配置 |
| Embedding | OpenAI text-embedding-3-small | 硅基流动 BAAI/bge-m3（1024维，免费） | 免费 API，1024 维适配 |
| LLM | 未指定 | DeepSeek v4-flash / v4-pro | 高性价比 |
| 架构 | 直接调用存储 | 适配器模式（接口抽象） | 可替换存储后端，不改业务逻辑 |
| 多租户 | 无 | 用户 + 小说项目模型 | 多用户多项目隔离，按项目分库 |

### 2026-06-06 审核修复（14 项）

| # | 严重度 | 修复内容 | 涉及章节 |
|---|--------|---------|---------|
| 1 | 🔴 | `applyFactGroup` 回滚机制从内存 Map 手动撤销改为 SQLite 原生事务 | 4.4 |
| 2 | 🔴 | LanceDB 异步同步从 `applyFactGroup` 内分离到 `commit_event` 调用层 | 4.4, 4.5, 10.1 |
| 3 | 🔴 | Retcon BFS 算法缩小依赖判定范围（subject + predicate 双重匹配），标注保守估计 | 9.2 Tool 4 |
| 4 | 🔴 | `CostFilter` 接口补充 `filledByEvent` 字段 | 4.3.1 |
| 5 | 🟡 | 新增 `EventStore` 接口定义（事件持久化存储） | 4.3.3 |
| 6 | 🟡 | 明确推理规则产生的 Fact 在 `commit_event` 时随主 FactGroup 原子提升为 canonical | 5.5, 10.1 |
| 7 | 🟡 | 新增附录 E：完整 SQLite 表结构定义（7 张表） | 附录 E |
| 8 | 🟡 | 新增统一错误处理 `ToolError` / `ToolErrorCode` / `ToolResult<T>` 类型 | 9.3 |
| 9 | 🟡 | `assert` 方法签名补充 `causeEvent` 注入说明 | 4.3 |
| 10 | 🟢 | `ProposalStore.expireStale` 补充 内存存储场景说明 | 4.3.2 |
| 11 | 🟢 | 补充章节号重排/插入的应对策略 | 3.4 |
| 12 | 🟢 | `WritingContext.sceneEntityIds` 来源说明（手动指定 + commit_event 副作用） | 7.2.2 |
| 13 | 🟢 | API Key 安全存储策略（.env.local + dotenv） | 1.4 |
| 14 | 🟢 | `FactValue` 不支持结构化值的 限制说明及后续迭代 | 3.1 |

### 2026-06-06 二次审核修复（4 项）

| # | 描述 | 涉及章节 |
|---|------|---------|
| 15 | 双通道核销机制：`CostResolver` 接口补充 `explicitResolutionIds` 参数，新增 6.2.1 节详述自动核销与显式核销的互补关系 | 6.1, 6.2.1 |
| 16 | LanceDB 哨兵值消除：`valid_to = -1` 改为 `valid_to = null` + `is_current: boolean` 辅助字段 | 4.5, 7.4, 10.2 |
| 17 | ContextCache 缓存键实现明确：排序后 `\|` 连接字符串，移除未定义的哈希依赖 | 7.2.2 |
| 18 | 全局元数据库并发保护：SQLite WAL 模式说明，并发策略分层 | 1.4 |

### 2026-06-06 架构升级（5 项重大变更）

| # | 类别 | 变更内容 | 涉及章节 |
|---|------|---------|---------|
| 19 | 🔵 | `EntityType`（7种）升级为 `EntityKind`（14种），对齐知识图谱语义分类体系 | 3.1.4, 9.2 Tool 8 |
| 20 | 🔵 | 新增 `RelationKind`（15种）语义分类，作为 Fact 可选元数据字段 | 3.1, 3.1.4 |
| 21 | 🔵 | 新增 `Knowledge` 知识可见性模型，建模角色/组织的信息不对称 | 3.6, 4.3.4 |
| 22 | 🔵 | `NarrativeCost` 与伏笔系统合并为统一 `NarrativeThread` 叙事线索模型 | 3.5, 6 |
| 23 | 🔵 | 新增 `ThreadMilestone` 生命周期追踪，支持伏笔多次暗示和渐进揭示 | 3.5 |

### 2026-06-06 文档审查修复 + 知识传播架构（19 项）

| # | 类别 | 变更内容 | 涉及章节 |
|---|------|---------|---------|
| 24 | 🔴 | 审查修复 7 项严重问题：核心机制计数、Cost→Thread 重命名、fillCondition→closeCondition、SQL 语法、isThreadClosable 状态遗漏、minHints 未使用、FactQuery 位置错误 | 全文 |
| 25 | 🟡 | 审查修复 8 项中等问题：Knowledge/KnowledgeSource/KnowledgeFilter 接口补全、kno_/thr_ ID 规则、relatedEntities 填充说明、章节编号修正、目录结构补全、markInvalid 委托说明 | 3.1, 3.5, 3.6, 4.3, D.3 |
| 26 | 🔵 | 新增 `KnowledgeSource`（8种）三层级枚举，覆盖自动推导/事件触发/间接不确定三个来源 | 3.6 |
| 27 | 🔵 | 新增"知识投影（Knowledge Projection）"概念：commit_event 双投影写入（世界状态 + 认知状态） | 3.6, 10.1 |
| 28 | 🔵 | 新增第四类规则 `Propagation Rules`（知识传播规则）：从事件 + 实体关系推导 Knowledge 条目 | 5.2, 5.3, 5.6 |
| 29 | 🔵 | 硬编码 2 条传播规则：主体自动知晓（subject_auto）+ 同场景目击传播（witness_propagation） | 5.6 |
| 30 | 🔵 | `propose_event` 新增 `knowledge_broadcast` 参数：粗粒度广播声明（explicit_entities / faction_members / scene_participants） | 9.2 Tool 2 |
| 31 | 🔵 | `EventConsequence` 新增 `proposedKnowledge` 字段，沙盒推演产出知识传播建议 | 3.7, 5.5 |
| 32 | 🔵 | `ContextScope` 升级为核心设计：作用域继承 + 遮蔽机制 + 作者控制的退出持久化 + Thread tags | 3.4.1, 4.2, 4.3, 7.4, 9.2 |
| 33 | 🔵 | 新增 `World Package`（3.9）：题材无关配置包，所有规则/谓词映射/实体模板外挂加载，Core 引擎零题材假设 | 3.9, 5.4, 7.2.1, 11.1 |
| 34 | 🔵 | 新增附录 F：7 部跨题材作品框架验证（诡秘之主/凡人修仙传/蛊真人/三体/盗墓笔记/一人之下/传说管理局） | 附录 F |
| 35 | 🔵 | 附录 F 大幅扩展：新增 30 部起点白金 T0 级作品分析（中原五白+其他白金大神），共计 36 部作品 279 个设定维度全部覆盖 | 附录 F |
| 36 | 🔴 | 深度审查修复（24 项）：修复 PropagationRule 参数签名（#1）、EntityRef 比较Bug（#2）、FactStore.update context 参数（#3）、FactChangeInput.relation_kind（#4）、is_current 生成列（#5）等 20 个具体问题 + 4 个设计缺失（附录 G：LLM 集成提示词/LanceDB 并发保护/项目清理策略） | 3.9, 4.3, 4.3.1, 5.6, 9.2, 附录 E, 附录 G |
| 37 | 🔵 | 新增附录 H：World Package 声明式规则系统——变量绑定、条件表达式、DeclarativeRuleEvaluator 解释器、三层渐进增强策略、LLM 辅助创作流程 | 3.9, 5.2, 附录 H |
| 38 | 🔵 | World Package 深度解析修复（6 项）：加载管线、三层优先级链合并规则、作用域包加载/卸载、overrideRules 语义、运行时动态扩展、版本升级流程、LLM 上下文注入格式（G.1.1）、修复多余 } 语法错误 | 3.9, G.1.1 |
| 39 | 🔵 | World Package 全面完善（9 项）：实体模板继承、多包并存命名空间隔离、LLM生成新包约束、运行时回溯策略、FactStore校验交互、FactRenderer渲染交互、Embedder向量化交互、题材族分组（H.8） | 3.9, H.8 |
| 40 | 🔵 | World Package 存储从 JSON 文件改为 SQLite 表（wp_predicates/wp_predicate_aliases/wp_rules/wp_entity_templates/wp_scope_presets），全文 20 处引用同步更新，附录 E 新增建表 SQL | 3.9, E.8, H.1, H.2, H.6, H.7 |
| 41 | 🔵 | World Package 用户视角文档补全：§3.9 新增"四层来源模型"（系统预置/作者自定义/LLM辅助/运行时补充）、"无模板创建流程"（情况A/B/C）、"端到端创作流程"（4个场景示例）；附录 H.6 扩展为完整的技术实现流程（H.6.1-H.6.4），含四层架构交互关系图和触发时机表 | 3.9, H.6 |
| 42 | 🔵 | 核心细节补全（4 项）：①§1.2 新增原则八"Headless Core"；②§3.6 新增 Knowledge 状态变迁机制（遗忘/封印/搜魂/植入），新增 4 种 KnowledgeSource，KnowledgeChangeInput 接口，检索时最新记录覆盖规则；③§9.2 Tool 1 返回值升级为 fact_index（含 FactIndexEntry），新增"ID传递契约"；④§9.2 新增 Tool 9/10（propose_schema_extension / commit_schema_extension），WP Schema 层独立写入通道；⑤§9.3 错误码从 12 扩充至 20，新增 FACT_NOT_CURRENT / FACT_ID_FABRICATED / PREDICATE_CONFLICT 等防御性错误码及纠错指导 | 1.2, 3.6, 9.2, 9.3 |
| 43 | 🔵 | 读取流防呆 + Retcon 认知失调：①§7.2.3 检索流程新增 Step 0 短期工作记忆强制注入（Recent Events Force-Inject），防止 LanceDB 异步同步延迟导致 LLM "失忆"；②§9.2 Tool 4 Retcon BFS 算法新增 Knowledge 级联扫描，受影响的 Knowledge 生成 cognitive_dissonance 类型 NarrativeThread，提供三种闭环路径（记忆修正/重新认知/保持冲突） | 7.2.3, 9.2 Tool 4 |
| 44 | 🔵 | 附录 G 新增 G.5-G.9 共 5 个 LLM System Prompt 模板：G.5 Tool 使用规范与核心工作流（含决策树）；G.6 ID 传递契约防幻觉硬约束；G.7 错误恢复与重试策略（可自动重试/需作者介入/系统级三类）；G.8 认知失调叙事注入模板（曼德拉效应三选一）；G.9 记忆操作引导模板（seal/decay/soul_read/implant 四种操作引导话术） | 附录 G |
| 45 | 🔵 | 核心边界重构（回应外部架构审查）：①§1.2 新增原则九"Core 只维护客观状态，禁止主观模拟"（Belief/Theory of Mind/Emotion/Intent/Trust 五项红线）；②§3.6 新增 Knowledge 硬边界（明确 Knowledge = Fact 投影，不是独立认知世界）；③§5.2 新增 Rule Engine 确定性原则（允许/禁止的规则类型明确化，Propagation Rules 边界澄清）；④§3.1.4 新增 EntityKind 定位说明（检索标签非本体论）；⑤§4.7 新增快照系统 WorldSnapshot（100 章自动快照，O(n)→O(k) 查询优化）；⑥§11.3 新增 Dependency Graph（Phase 2）+ Narrative Query Layer（Phase 1.5）；⑦附录 H.5 新增 World Package 图灵完备性红线 | 1.2, 3.1.4, 3.6, 5.2, 4.7, 11.3, H.5 |
| 46 | 🔵 | 控制膨胀（回应第二轮审查）：①§1.2 原则九强化 Fact First 声明（Fact=真相来源，Event=变更记录）；②§5.2 新增 Rule Engine 复杂度预算（深度≤10/Fact≤100/Thread≤50/禁止循环推导）；③§4.7 快照策略细化（5 种触发类型：auto/chapter/pre_retcon/major_event/manual）；④§3.4.1 ContextScope 标注未来拆分可能（Timeline+RealityLayer+Scope，Phase 2）；⑤§H.5 World Package 安全白名单（允许声明6项/禁止执行6项）；⑥§11.5 新增 Core Invariants（8 条不变式，测试锚点）；⑦§11.3 Query Layer 从 Phase 3 提前到 Phase 1.5（MVP findFacts/findEntities/findThreads/findKnowledge/findEvents） | 1.2, 3.4.1, 4.7, 5.2, 11.3, 11.5, H.5 |
| 47 | 🔵 | 架构收敛（回应第三轮审查）：①§3.1.4 删除 EntityKind.event/time（12→12种，含删除说明）；②§3.5 Thread 新增单向依赖不变式（禁止 Thread→Fact/Knowledge）；③§4.7 Snapshot 标注 Projection 本质（派生数据=查询缓存）；④§5.2 Rule Engine Boundary（允许 Fact/Event→Fact/Knowledge/Thread，禁止 Rule→Rule/Schema/Package/Tool）；⑤§3.9 World Package Invariant 补强（数据不是代码，禁止可执行代码）；⑥§11.6 新增 Core Dependency Graph（5 层依赖 + 8 条逆向依赖禁令 + Fact First 恢复不变式） | 3.1.4, 3.5, 3.9, 4.7, 5.2, 11.6 |
| 48 | 🔴 | 架构宪法补充（回应深度架构讨论）：①§11.5 新增 I-9 **Thread Never Has Causal Power**（Thread 永远不作为任何规则推理/事实写入/知识投影/检索信号的输入，含 6 条允许/禁止清单）；②§3.1 Fact 接口 + §E.2 facts 表新增 `schemaVersion` 字段（默认 1，为 Schema Evolution 预留版本化反序列化入口）；③§E.7 knowledge 表新增 `(entity_id, fact_id, known_since)` 复合索引（覆盖"取某实体对某条 Fact 最新认知状态"核心查询模式） | 3.1, 11.5, E.2, E.7 |
| 49 | 🔵 | 深度架构讨论共识落盘（9 项）：①§3.6 Knowledge 术语从"投影"升级为"认知事件流"（双流写入，不可从 Fact 重算），全文 6 处同步更新；②§4.3.4 新增 KnowledgeStoreMode 预留接口（eager/compressed-eager/experimental-lazy）及 lazy 模式不可行论证；③§4.4 新增 commit_event 事务拆分设计（Phase A 事务外推演 / Phase B 事务内写入 / Phase C 异步后处理 + 乐观锁）；④§3.9 新增谓词不可变性原则（Predicate Immutability），解决 World Package 演化时历史 Fact 解释断裂问题；⑤§7.2.2 ContextAnalyzer 改为双模式实现（规则化快速路径 80% + LLM 深度分析 20%），异步预生成缓存移出热路径；⑥§7.3 新增 Retrieval 核心地位声明（Silent Failure 风险 + 与 FactStore 构成双核心）；⑦§11.7 新增 Latency Budget（延迟预算：热路径 <200ms，Phase B <20ms，性能优先级排序）；⑧§11.8 新增 Retrieval 质量评估框架（工程指标 Recall@K + 产品指标 SceneCoverage + Step 0 边际贡献 + Spike 驱动决策树）；⑨附录 C Phase 排序重构：新增 Phase 0.5 Integration Spike（3 个 Spike 验证 Embedding 质量/SQLite+LanceDB 基础设施/Knowledge 查询性能），ContextAnalyzer 更新为双模式 + 异步缓存 | 3.6, 3.9, 4.3.4, 4.4, 7.2.2, 7.3, 10.1, 11.6, 11.7(新), 11.8(新), 附录 C |
| 50 | 🔴 | Retcon 级联压力测试收敛（4 个边界 Case）：①🔴 §4.5 新增 `scheduleRetconSync` + 内存级 contested 黑名单，填补 Retcon 后 LanceDB 向量 certainty 未同步的设计空隙（幽灵检索防护）；VectorStore 接口新增 `updateCertainty` 方法；§9.2 Tool 5 新增 commit_retcon Phase A/B/C 分解设计；②🟡 §9.2 Tool 2 propose_event 新增 `dependent_fact_ids` 可选参数，§E.3 events 表新增 `dependencies_json` 字段，§11.3 Dependency Graph 轻量级前置方案从 Phase 2 降到 Phase 1，解决 BFS 启发式搜索的隐式依赖漏判；③🟢 §7.2.3 Step 5 知识感知过滤新增 Fact 活性校验规则（contested 降级、orphaned 屏蔽）；④🟡 §9.2 Tool 4 级联影响报告新增"跨作用域潜在影响"信息区块 + 跨作用域主题扫描逻辑设计，不改 BFS 主循环 | 4.5, 7.2.3, 9.2 Tool 2/4/5, 11.3, E.3, 附录 C |
| 51 | 🔴 | 认知战+梦境副本压力测试收敛（3 个边界 Case）：①🔴 §3.6 Knowledge "取最新"查询新增 `rowid DESC` tiebreaker，消除同一章节内 seal 与 propagation 记录的排序不确定性；§10.1 写入流新增 Knowledge 写入顺序约束（显式操作 rowid > 自动推导 rowid）；②🟡 §3.4.1 新增作用域边界校验（跨作用域 Fact 引用防护），`applyFactGroup` 内 update/retract 操作检查 target Fact 的 context，不一致时报 `SCOPE_FACT_MISMATCH`；§9.3 新增 `SCOPE_FACT_MISMATCH` 错误码（第 21 个）；③🟢 §5.2 新增 Rule Engine 客观性原则声明（永不接触 KnowledgeStore，认知判断属于读取流）；§11.5 新增 I-10 **Rule Engine Never Reads Knowledge** 不变式 | 3.4.1, 3.6, 5.2, 9.3, 10.1, 11.5 |
| 52 | 🔵 | Phase 0.5 Spike 1 设计收敛 + Retrieval 降级预案：①§11.8.1 新增 Spike 1 测试集构造规范（Golden Dataset：4800 条基准 Fact + 200 条硬负样本 + 20 个四级查询，含三类硬负样本构造规则与评估执行规范）；②§11.8.2 新增 Retrieval 失败降级预案（预案 A：BM25+向量混合检索 RRF 融合 / 预案 B：依赖图遍历降级，含决策矩阵与工期影响评估）；③附录 G.10 新增 LLM 接口兼容性验证用例（3 个 Prompt Spike 边界用例：知识封印防幻觉 / 多目标搜魂消歧 / 隐性依赖声明提取，含验证指标与执行说明） | 11.8.1(新), 11.8.2(新), G.10(新) |
| 53 | 🔴 | World Package JSON 实体化反向验证——3 个 Schema 表达力缺陷修复：①§3.9 + §9.2 Tool 9 `PredicateDefinition` 新增 `sequenceOrder?: string[]` 可选字段（有序枚举递进，如修炼境界链），支持 Rule Engine 检测"跳级"违规；②H.3 条件类型从 6 种扩展至 9 种：新增 `snapshot_gte` / `snapshot_lte`（数值 ≥/≤ 比较）+ `snapshot_sequence_jump`（有序枚举递进跨度检查，含完整解释器逻辑约 15 行代码）；③H.4 `InferenceRule` 新增 `update_math` 动作（数值算术推理，如 `lifespan += 500`），含表达式安全约束白名单（仅允许四则运算 + $变量引用，严禁函数调用/嵌套超2层/条件分支） | 3.9, 9.2 Tool 9, H.3, H.4 |
| 54 | 🔵 | 全局时间轴不变式：①§11.5 新增 I-11 **Global Monotonic Timeline**（chapter 是全局绝对单调递增的时间坐标，无局部时间轴，无时间分支）；②§3.4.1 ContextScope 新增"作用域与绝对时间轴"声明（作用域只隔离空间与物理法则，不隔离时间坐标，含多作用域切换的章节推进示例 + 设计边界说明：平行宇宙独立时间线属 Phase 2 Timeline 维度） | 3.4.1, 11.5 |
| 55 | 🔴 | 跨作用域因果链断点修复（Cross-Scope Lineage Tracking）：①§3.4.1 exit_scope 新增自动依赖注入规则——exit_scope 事件自动在 dependent_fact_ids 中记录原始作用域 Fact 的 ID（系统强制注入，不依赖 LLM 声明，存入 events.dependencies_json）；②§9.2 Tool 4 跨作用域扫描从单路径启发式升级为双路径：优先路径（dependent_fact_ids 精确匹配→🔴 高优"因果污染"警告）+ 兜底路径（subject+predicate 模糊匹配→🟡 低优"潜在关联"提示），含蝴蝶效应场景说明 | 3.4.1, 9.2 Tool 4 |
| 56 | 🔴 | 深度审查收敛（12 项）：①🔴 §5.4 示例五 identityExposureRule 重写——移除 knowledgeStore 引用，改为纯客观条件检查（遵守 I-10）；②🔴 §9.2 Tool 2 propose_event 新增 `knowledge_changes?: KnowledgeChangeInput[]` 参数（认知操作管线闭环）；③🔴 §4.3.3 EventStore 新增 `getByDependentFactIds()` 方法（Retcon BFS 优先路径接口缺口）；④🟡 §5.6 PropagationRule.propagate() 移除 knowledgeStore 参数，去重上移到 commit_event 层；⑤🟡 §5.2 + §11.5 I-10 措辞细化（四类规则判定输入不含 Knowledge，传播规则可产出但不消费）；⑥🟡 §3.1.4 EntityKind 枚举恢复 event/time（12→14，与全文标注一致）；⑦🟡 §11.1 Tool 数量订正（8→10）、目录错误码数量订正（20→21）；⑧🟢 §E.3 events 表 + §E.6 audit_log 表 SQL 逗号修复；⑨🟢 §4.4 applyFactGroup update 调用补 context 省略说明；⑩🟢 §3.1.3 contested→canonical 实现路径说明；⑪🟢 §7.2.3 Step 5 补 non-current Fact Knowledge 设计意图 | 3.1.3, 3.1.4, 4.3.3, 4.4, 5.2, 5.4, 5.6, 7.2.3, 9.2 Tool 2, 11.1, 11.5, E.3, E.6 |
| 57 | 🔴 | 文档审查修复（6 项）：①§1.2 Knowledge 旧"Fact 投影"表述改为"引用 Fact 的认知事件流"；②§3.4.1 / §9.2 Tool 4 统一 dependent_fact_ids 为事件级依赖，存储于 events.dependencies_json；③§5.3 RuleEngine.propagateKnowledge 移除 KnowledgeStore 入参；④§4.3.4 KnowledgeStore 补 `getByFactId()`；⑤§9.3 修复 ToolErrorCode 联合类型分号位置；⑥附录 C Tool 数量 8→10 | 1.2, 3.4.1, 4.3.4, 5.3, 9.2, 9.3, 附录 C |
| 58 | 🔴 | 架构审查优化（10 项）：①commit_event/commit_retcon 统一为 SQLite 事务内写入 audit_log + sync_queue outbox；②sync_queue 增加 operation/payload/status，支持 insert_vector/mark_invalid/update_certainty；③dependent_fact_ids 查询源从 JSON 扫描升级为 event_dependencies 边表，dependencies_json 仅保留审计冗余；④World Package 谓词演化改为 deprecated + predicateAliases，禁止版本升级物理改写历史 Fact；⑤FactValue SQLite 序列化新增 value_scalar_type，避免 string/number/boolean 混淆；⑥FactQuery 增加 current/history 查询语义，明确 exit_scope 后历史查询边界；⑦KnowledgeStore 最小实现提前到 Phase 1，Spike 3 改为临时 SQL 原型；⑧Retrieval 统一为六段检索管线 Step 0~5；⑨附录 E 补齐 project_state 与 World Package 存储表；⑩清理 Tool 数量和 manage_scope 残留 | 3.1, 3.4.1, 3.9, 4.3, 4.4, 4.5, 9.2, 10.1, 附录 C, 附录 E, 附录 H |
| 59 | 🟡 | 架构审查收尾一致性修复：①`applyFactGroup` 明确只负责 Fact 子操作，上层 `commit_event` Phase B 事务统一包裹 Event/Fact/Knowledge/Thread/audit/outbox；②端到端示例中的 LanceDB 异步写入改为 `sync_queue outbox` + 后台 worker；③延迟预算修正为审计日志在 Phase B、后台只做 LanceDB 同步与缓存刷新；④附录 D/E 将 `sync_queue` 命名为 outbox/重试队列 | 4.4, 4.5, 10.1, 11.7, 附录 D, 附录 E |
| 60 | 🟡 | 架构审查第二轮一致性修复：①单会话假设下仍保留 `state_version` 作为 stale proposal / Phase A 快照校验；②写入流总览改为 Phase B 原子提交 + Phase C outbox 消费；③`dependent_fact_ids` 明确写入 `event_dependencies` 边表，`dependencies_json` 仅审计冗余；④`events` 表默认只存 committed 事件，提案继续由 `ProposalStore` 管理；⑤附录编号引用修正 | 1.2, 1.4, 2.2, 3.2, 10.1, 11.3, 11.8.2, 附录 D, 附录 E |
| 61 | 🟡 | 术语一致性修复：正文规范与示例中的旧 `Cost/cst_` 技术对象统一为 `NarrativeThread/thr_`，仅在历史说明和向后兼容说明中保留旧名；`commit_retcon` 返回字段、渲染接口、读取流示例同步改名 | 1.3, 2.2, 3.1, 5.4, 6.2, 8.3, 9.2, 10.3, 10.4, 11.1 |
| 62 | 🔴 | 乐观锁闭环修复：`ProposalResult` 增加 `expectedStateVersion`，`commit_event` 从 ProposalStore 读取该值并在 Phase B 校验；`commit_retcon` Phase B 同样递增 `project_state.state_version`，保证 Retcon 后旧 proposal 自动失效 | 3.8, 4.4, 9.2 Tool 3/5, 附录 E |
| 63 | 🔴 | 事务与错误码落地修复：①Phase B 乐观锁改为事务开头条件更新 `project_state`，更新行数为 0 立即回滚，避免写入后才发现版本冲突；②错误码旧 `COST_*` 技术名替换为 `THREAD_*`，旧名仅作为迁移兼容别名，不进入新 ToolErrorCode | 4.4, 9.3, 附录 E |
| 64 | 🔴 | Retcon 落盘锚点修复：`commit_retcon` 确认后必须创建 `evt_retcon_*` 系统事件，作为 contested 标记、Thread 恢复、audit_log、sync_queue、event_dependencies 的统一事件锚点；补齐 `cause_event` / audit / outbox 外键约束，保证所有持久副作用都可追溯到已提交 Event | 3.1, 3.4, 4.4, 9.2 Tool 5, 11.5, 附录 E |
| 65 | 🔴 | Schema Extension 提交闭环：`commit_schema_extension` 改为 SQLite Phase B 原子写入 `evt_schema_*` 系统事件 + wp_* 表 + audit_log，并递增 `project_state.state_version`，避免旧 proposal 在新谓词/规则生效后继续提交 | 3.4, 9.2 Tool 9/10, 附录 E |
| 66 | 🔵 | 架构规定补强（6 项）：①§1.2 新增原则十"复杂度隔离原则"；②§3.4.1 ContextScope 职责边界与 Phase 2 拆分预留编码规范；③§3.5 NarrativeThread 依赖关系开发守则；④§3.6 Knowledge 概念边界开发守则（不可变认知事件流 vs 可变当前状态）；⑤§5.2 Rule Engine 与 Knowledge 交互边界开发守则（I-10 精确表述）；⑥§3.9 World Package 演化开发守则与后向兼容边界情况 | 1.2, 3.4.1, 3.5, 3.6, 5.2, 3.9 |
| 67 | 🔵 | Core 可观测性锚点（2 项，为 Agent 编排层预留接口）：①§9.2 `ToolResult<T>` 新增可选 `system_metadata` 字段，含 `state_version`（乐观锁）、`retrieval_telemetry`（检索模式/深度/LanceDB 同步延迟/Step0 命中率）、`concurrency_telemetry`（contested 黑名单大小/热实体）、`latency_budget_consumed_ms`（延迟预算消耗），使上层 Agent 可感知 Core 内部状态用于熔断/降级决策；②附录 G.11 新增冲突场景 LLM 引导模板（CONFLICT_DIAGNOSIS_START/END 结构化诊断报告），含异常类型、冲突源头、驳回证据链、双路径修复建议（Retcon 路径/实体替换路径），使 LLM 重试失败后产出可追溯诊断而非反复猜测 | 9.2, G.11 |
| 68 | 🔴 | 深度流程模拟审查（13 项，沿写入流/读取流/校验流端到端推演）：①🔴 §5.4 示例 `bidirectionalEnemyRule` 第3138行 `certainty:'canonical'` 与 §5.5/§10.1 写入流"推理 Fact 标记 potential→commit 时提升 canonical"矛盾——示例应改为 `certainty:'potential'` 或标注"commit 时由系统提升"；②🔴 §3.5 NarrativeThread 回溯型线索缺少超期终态——`withinChapters` 时限到期后 `isThreadClosable` 返回 false 但不触发任何状态变更，UNFILLED 线索变永久僵尸（无法自动关闭也永不清理），建议新增超期提醒强度递增机制或自动 ABANDONED 路径；③🔴 §9.2 Tool 4 Retcon BFS 启发式路径 `Object.values(evt.params).includes(fact.predicate)` 匹配逻辑有误——params 值包含嵌套对象（`Record<string,unknown>`）、number、string[] 等类型，`includes` 对嵌套对象永远返回 false 导致漏判，且可能因参数值巧合匹配 predicate 导致误判，建议改为显式遍历 params 值的字符串类型字段；④🔴 §9.2 Tool 2 FactChangeInput 缺少 `valid_from` 字段，但 §4.4 applyFactGroup update 操作读取 `change.payload!.validFrom!`（第2518行），且 §3.2.1 FACT_CHANGE_MAPPING.fieldMap 未映射 `valid_from → validFrom`——update 操作的 validFrom 来源不明确，建议明确"默认取事件 chapter"并写入文档，或增加 FactChangeInput.valid_from 可选字段；⑤🟡 §7.2.3 Step 2 LanceDB 二次校验未指定批量查询方式——逐条 SQLite 查询 validTo 在高频场景效率低，建议明确 `SELECT id FROM facts WHERE id IN (?) AND valid_to IS NOT NULL` 批量查询；⑥🟡 §7.2.3 Step 4 topK=20 在 5000+ Fact 规模（约300万字）可能严重不足，建议文档增加 topK 缩放推荐策略（如 Fact 数量 >1000 时自动调为 30-50）；⑦🟡 §7.2.2 ContextCache 每次 commit_event 即失效过于激进——一章写 5-10 段产生 5-10 次 ContextAnalyzer LLM 调用（1-2s/次），建议改为"出场实体列表变化时才失效"或增量更新缓存；⑧🟡 §9.2 Tool 4 Retcon BFS 无深度/超时限制——极端场景（修改第1章初始设定）可能遍历全部事件，BFS 期间 SQLite 被锁阻塞写入，建议增加最大深度（如20层）或超时保护（如3s），与 §5.2 Rule Engine 复杂度预算对齐；⑨🟡 §7.2.3 Step 5 知识感知过滤后 RelevantFactSet.entityKnowledge 的更新逻辑未明确——过滤移除角色不知晓的 Fact 后，entityKnowledge 中对应的 Knowledge 条目是否同步移除？建议明确 entityKnowledge 只包含"角色实际知晓的"Knowledge；⑩🟡 §3.4.1 exit_scope 批量设置 validTo 的性能评估缺失——作用域内 500+ Fact 的 UPDATE 可能超出 Phase B 20ms 延迟预算，建议增加批量 UPDATE 策略或放松延迟预算说明；⑪🟢 §5.4 meridianBreakthroughRule 示例缺少 upstreamFactIds 填充逻辑示例——虽有文字说明但无代码示例，建议补充；⑫🟢 §9.2 KnowledgeBroadcast `faction_members` 标注"后续"但无明确里程碑——当前实现收到此值应报错还是忽略？建议 Phase 0 标注为不支持；⑬🟢 §4.7 SnapshotData.activeKnowledge 缺少对应 Fact 的 context 信息——快照恢复时无法区分"角色知道梦境 Fact"和"角色知道全局 Fact" |
| 69 | 🔴 | 全量通读深度审查（12 项新增，基于 7344 行完整通读）：①🔴 §5.6 `subjectAutoPropagation` 的 `propagate()` 方法签名不接收 `factStore` 参数（§5.6 PropagationRule 接口定义需 factStore），但 TypeScript 实现示例中省略了——不阻塞但需确认这是否为简化省略；②🔴 §6.2 `isThreadClosable` 渐进型线索只检查 `status !== 'PLANTED' && status !== 'HINTED' && status !== 'PARTIALLY_REVEALED'` 时返回 false，但 `RESOLVED` 状态不在检查中——已被 resolve_thread 关闭的渐进型线索如果被 Retcon 恢复为 PLANTED/HINTED，`isThreadClosable` 会重新放行，可能产生重复关闭（与 I-3 "Closed Thread cannot reopen automatically" 不冲突但需确认 Retcon 恢复后的状态是 UNFILLED 还是 PLANTED）；③🔴 §9.2 Tool 2 `propose_event` 的 `fact_changes[].change_id` 客户端生成但无格式校验——如果 LLM 生成的 change_id 包含特殊字符（如空格、中文、`/`），后续 `PropagationRule` 的 `(entityId, changeId)` 去重键和 `indexMap` 可能异常，建议增加 change_id 正则校验（如 `^[a-zA-Z0-9_-]+$`）；④🟡 §E.2 facts 表 `is_current` 为 VIRTUAL 生成列，但 §E.5 sync_queue 的 `operation='mark_invalid'` 需要更新 LanceDB 的 `is_current` 字段——如果 SQLite 的 is_current 是虚拟列不能直接 UPDATE，那 `markInvalid` 在 SQLite 侧只需 `UPDATE facts SET valid_to = ? WHERE id = ?` 即可让 is_current 自动变为 0，这是正确的，但文档未明确说明此依赖关系；⑤🟡 §5.6 传播规则 `witnessPropagation` 查询同场景实体时 `factStore.query({ predicate: 'location', atChapter })` 不限定 subject，可能返回数千条 location Fact——大规模场景（如"全城角色位置"）下性能不可控，建议增加 subject 范围预过滤或限制返回数量；⑥🟡 §3.6 KnowledgeChangeInput 定义了 seal/implant/decay/soul_read/restore 五种操作，但 `restore` 操作缺少触发场景说明——什么情况下需要恢复已封印的 Knowledge？建议补充至少一个叙事场景示例；⑦🟡 §E.3.1 event_dependencies 的 `source='rule_inference'` 在 §5.5 推理 Fact 提升路径中未写入——推理 Fact 提升时（第3292-3311行）只说"追加到 FactGroup.changes"但未提及是否也写入 event_dependencies，如果推理 Fact 的因事件也需记录依赖则存在缺口；⑧🟡 §7.2.3 Step 2 语义检索配额分配 `ceil(topK / semanticQueries.length)` 在 semanticQueries 数量大于 topK 时每条查询只能返回 1 条或 0 条——极端情况 10 条查询分 20 个配额，每条只得 2 条，可能遗漏重要 Fact，建议设置每条查询的最低返回数量（如 min 3）；⑨🟡 §G.1 ContextAnalyzer 提示词输出含 `scopeHints` 和 `entityDependencies` 字段，但 §7.2.2 ContextSignals 接口只有 `entityIds`、`semanticQueries`、`temporalFocus` 三个字段——提示词模板与接口定义不一致，`scopeHints` 和 `entityDependencies` 在检索管线中无处消费；⑩🟢 §8.3 renderEntityProfile 示例中"绝脉突破"线索显示"已超期190章"——这与 §6.2 中回溯型线索超期后无任何处理的设计一致，但渲染时未使用任何视觉强调（如加粗/变色），建议 FactRenderer 对超期线索增加渲染标记；⑪🟢 §E.7 knowledge 表未定义 `source` 字段的枚举校验约束——§3.6 定义了 8 种 KnowledgeSource，但 SQLite 表无 CHECK 约束，依赖应用层校验，与 wp_rules.type 无 CHECK 约束的约定一致（文档风格统一即可）；⑫🟢 §H.3 变量绑定系统中 `.predicate` 和 `.subject` 对 TransitionRule 和 InferenceRule 的含义不同（TransitionRule 指事件参数，InferenceRule 指触发 Fact），但变量名相同——实现时需根据规则类型切换 resolvePath 上下文，建议文档明确此歧义 | 3.6, 5.6, 6.2, 7.2.2, 7.2.3, 8.3, 9.2, E.2, E.5, E.7, G.1, H.3 |

---

## 目录

1. 项目定位与设计哲学
   - 1.1 项目定义 / 1.2 设计原则（含原则一~十） / 1.3 Core 职责边界 / 1.4 用户与项目模型 / 1.5 项目元数据
2. 系统架构全景
   - 2.1 分层架构 / 2.2 三条数据流概要
3. 核心领域模型
   - 3.1 Fact / 3.1.1 属性与关系对比 / 3.1.2 embeddingText 规范 / 3.1.3 Certainty / 3.1.4 EntityKind（14种）与 RelationKind
   - 3.2 FactChange / 3.2.1 转换机制
   - 3.3 FactGroup（原子事务）
   - 3.4 NarrativeEvent / 3.4.1 ContextScope（作用域与遮蔽，含 Phase 2 拆分预留） / 3.4.2 ContextScope 开发守则
   - 3.5 NarrativeThread（含单向依赖不变式）/ 3.5.1 生命周期 / 3.5.2 关闭判定 / 3.5.3 与写作流程集成
   - 3.6 Knowledge（知识可见性）/ Knowledge 状态变迁（遗忘/封印/搜魂）/ Knowledge 硬边界 / 3.6.1 Knowledge 概念边界开发守则
   - 3.7 EventConsequence / 3.8 ProposalResult
   - 3.9 World Package（世界观配置包，含不变式）/ 四层来源模型 / 无模板创建流程 / 端到端创作流程 / World Package 演化开发守则
4. FactStore：时序三元组存储层
   - 4.4 原子事务回滚 / 4.5 LanceDB 同步 / 4.6 同步可靠性保障（故障恢复/健康检查） / 4.7 快照系统（5 种触发类型）
5. Rule Engine：规则引擎
   - 5.1 职责 / 5.2 规则分类（含确定性原则 + 复杂度预算 + Rule Engine Boundary） / 5.2.1 Rule Engine 与 Knowledge 交互边界开发守则 / 5.3 接口定义 / 5.4 配置示例 / 5.5 沙盒推演 / 5.6 Propagation Rules
6. NarrativeThread：叙事线索系统
   - 6.1 ThreadResolver / 6.2 关闭判定（含双通道机制） / 6.3 与写作流程集成
7. Semantic Retrieval Layer：语义检索层
   - 7.1 根本问题 / 7.2 组件设计（FactEmbedder / ContextAnalyzer / RelevantFactRetriever 六段检索管线） / 7.3 主动注入时机 / 7.4 LanceDB Table 设计
8. FactRenderer：事实渲染层
9. LLM Tool Interface：工具接口层
   - 9.1 写入路径 / 9.2 工具列表（Tool 1~10，含 ID 传递契约、propose_schema_extension） / 9.3 统一错误处理（21 个错误码）
10. 三条数据流
    - 10.1 写入流 / 10.2 读取流 / 10.3 校验流 / 10.4 端到端场景
11. 实现范围与后续迭代
    - 11.3 明确不包含（含 Dependency Graph / Query Layer Phase 1.5）
    - 11.4 后续迭代路线图 / 11.7 Latency Budget（延迟预算） / 11.8 Retrieval 质量评估框架
    - 11.5 Core Invariants（11 条不变式） / 11.6 Core Dependency Graph（5 层依赖 + 认知层）
        - 11.8.1 Spike 1 测试集构造规范（Golden Dataset）
        - 11.8.2 Retrieval 失败降级预案（Plan B Architecture）
- 附录 A：术语表
- 附录 B：架构对比总结
- 附录 C：开发顺序建议
- 附录 D：技术栈与适配器模式（D.1~D.5）
- 附录 E：SQLite 表结构定义（E.1~E.10，含 World Package 存储表）
- 附录 F：多作品框架验证（F.1~F.37，36 部作品 279 个设定维度）
- 附录 G：LLM 集成与提示词工程
    - G.1 ContextAnalyzer 提示词模板 / G.1.1 World Package 上下文注入
    - G.2 Tool Interface 的 LLM 请求集成
    - G.3 LanceDB 并发写入保护 / G.4 项目删除与数据清理
    - G.5 Tool 使用规范与核心工作流 / G.6 ID 传递契约（防幻觉）
    - G.7 错误恢复与重试策略 / G.8 认知失调叙事注入 / G.9 记忆操作引导
    - G.10 LLM 接口兼容性验证用例（Prompt Spike Design）
- 附录 H：World Package 声明式规则系统
    - H.1 存储架构 / H.2 静态数据格式 / H.3 声明式规则 JSON 格式 / H.4 解释器实现
    - H.5 四层渐进增强策略（含图灵完备性红线）
    - H.6 LLM 辅助创作流程（H.6.1~H.6.4） / H.7 覆盖分析 / H.8 题材族分组

---

## 1. 项目定位与设计哲学

### 1.1 项目定义

Narrative-OS-Core 是一个面向超长篇叙事创作的**世界状态一致性引擎**。

它通过六项核心机制解决一个核心问题：

**核心问题**：500 万字以上的小说，第 12 章埋下的设定矛盾，在第 380 章发作时，没有人（包括 AI）能可靠地察觉并追溯。

**六项核心机制**：

1. **时序三元组存储**：所有世界状态以不可变 Fact 存储，支持任意章节时间切片查询
2. **Event Sourcing**：所有状态变更必须通过 NarrativeEvent 驱动，保证完整因果链
3. **统一叙事线索（NarrativeThread）**：将逻辑代价和伏笔统一为叙事线索，追踪从埋设到回收的完整生命周期——回溯型（先写结果后补原因）和渐进型（先埋种子后开花）共用一套追踪体系
4. **语义检索注入**：主动发现相关设定并注入 LLM 上下文，不依赖 LLM 自己记得查什么
5. **知识可见性（Knowledge）**：建模角色/组织的信息不对称，追踪"谁在什么时刻知道了什么，确信度如何"——诡秘之主式的信息迷雾叙事从此可被系统建模
6. **语义分类体系（EntityKind + RelationKind）**：在扁平三元组上叠加结构化语义元数据——14 种实体分类 + 15 种关系语义分类，让系统具备领域感知能力

### 1.2 设计原则

**原则一：Core 是世界已发生事实的守护者，不是叙事决策者**

Core 只维护已确认的 Fact，计算可能状态但绝不自动选择。作者拥有最终决定权。

**原则二：Fact-Centric，关系也是 Fact**

世界状态的最小单元是 Fact（三元组）。实体属性、关系、状态统一表达为 Fact，不存在异构数据结构。图拓扑是 Fact 集合的派生视图，不是独立存储层。

**原则三：Event Sourcing，不可变存储**

所有状态变更通过 NarrativeEvent 驱动。每条 Fact 记录其 causeEvent。当前世界状态从 facts 表按时间切片查询得到；Event 是审计账本和因果入口，不是热路径上的唯一重放来源。Fact 不删除，只失效（设置 validTo）。

**原则四：Atomic Transaction，杜绝半截子状态**

一个 Event 产生的所有 FactChange 打包为 FactGroup，原子提交或整体回滚。不存在"主角中毒了 HP 下降但面容未变"的中间态。

**原则五：NarrativeThread 叙事线索闭环**

违背世界规则或埋设伏笔时 Core 不拒绝，而是生成叙事线索账单。后续事件满足关闭条件时自动核销。回溯型（先写结果后补原因）和渐进型（先埋种子后开花）线索可以存在，但必须被记录和追踪。

**原则六：Push 优先于 Pull**

不依赖 LLM 主动知道需要查什么。系统在 LLM 写作前主动分析上下文，语义检索相关 Fact，注入上下文。这是大规模设定下保证一致性的根本机制。

**原则七：写入路径结构化，读取路径可读化**

LLM 写入通过 JSON Schema Tool Call，由系统校验结构完整性。LLM 读取通过 FactRenderer 格式化后的 Wiki Markdown，提升上下文理解质量。两条路径完全分离，不共用一套 DSL。

**原则八：Headless Core，LLM 是唯一的交互代理**

Core 是无头（Headless）引擎——它不包含任何 UI 概念（没有弹窗、按钮、勾选框），不提供 HTTP/WebSocket 服务，不处理用户认证。Core 与外界的唯一通道是 LLM Tool Call 接口。Core 的所有输出（包括"建议"、"提示"、"审核请求"）都是结构化 JSON 或 Markdown 文本，由 LLM 读取并翻译为自然语言与作者交互。

这意味着：
- 文档中提到的"提示作者确认"、"建议保留"等描述，Core 的实际行为是在 Tool Call 返回值中输出 `suggestions: [...]` 或 Markdown 文本。LLM 读取后用自然语言向作者转述
- Core 不关心作者是人类还是 AI，不关心对话发生在 CLI、Web 还是 IDE 中——它只认 Tool Call 的 JSON Schema
- 未来如果需要 Web UI，只需在 Core 之上加一层 BFF（Backend for Frontend），将前端操作翻译为 Tool Call，Core 代码一行不改

**原则九：Core 只维护客观状态，禁止主观模拟**

Fact 是世界状态的唯一真相来源。Event 记录变更，Fact 定义现实。世界状态从 Fact 查询获得，不从 Event 推导。Event 只是 FactChange 的容器和溯源凭据。

Core 只记录三类客观记录：
- 世界是什么（Fact）——第一公民，状态查询的唯一来源
- 世界发生了什么变化（Event）——变更记录，不是状态来源
- 谁以什么确信度接触了什么事实（Knowledge）——引用 Fact 的认知事件流，不是独立世界

Core 严格禁止以下概念进入：
- **Belief（信念）**：A 认为 X 是真的 → 不记录。Knowledge 的 confidence ≠ 信念，它是"信息接触渠道的可信度"，不是"角色内心是否真正相信"
- **Theory of Mind（心理理论）**：A 认为 B 认为 X → 禁止。这是嵌套认知，深度无限
- **Emotion（情绪）**：A 对 B 感到愤怒 → 禁止
- **Intent（意图）**：A 计划杀 B → 禁止（只有"杀了"或"没杀"是 Fact）
- **Trust（信任）**：A 信任/不信任 B → 禁止

**边界判断标准**：如果一条信息的深度可以用"谁认为谁认为谁认为..."无限嵌套，它不属于 Core。Core 的 Knowledge 只有一层：entity → fact → confidence → source。嵌套认知、情感模拟、行为预测全部属于未来的 Agent Layer。

**原则十：复杂度隔离原则**

每个核心概念（Fact / NarrativeThread / Knowledge / ContextScope）应该：
- 有明确的状态转换规则
- 有清晰的边界定义
- 有独立的测试策略
- 不与其他概念产生循环依赖

如果发现两个概念之间有双向影响，必须：
1. 明确谁是"主导"谁是"被动"
2. 在架构文档中明确说明依赖方向
3. 避免隐式的循环依赖

开发者必须遵守：当新增功能涉及两个以上核心概念的交互时，先在架构文档中补充依赖方向声明，再开始实现。未声明依赖方向的跨概念交互代码不得合入主分支。

### 1.3 Core 职责边界

**Core 负责**：

- 事实的不可变存储与时间切片查询
- 事实的语义检索与上下文注入
- 规则校验与约束检测
- 叙事线索的生成、追踪与关闭
- 事实的因果溯源

**Core 不负责**：

- 叙事内容的生成
- 写作风格与文笔
- 题材逻辑判断
- 读者反馈处理

### 1.4 用户与项目模型

Narrative-OS-Core 支持多用户、多项目的隔离架构。用户是系统的使用者（作者），项目是用户创作的一部小说及其完整的设定世界。

**用户（User）**：

- 每个用户拥有独立的身份标识
- 用户持有自己的 LLM API Key（DeepSeek）和 Embedding API Key（硅基流动）
- API Key 安全存储策略：存储在项目根目录的 `.env.local` 文件中（`.gitignore` 排除），以 `DEEPSEEK_API_KEY` / `SILICONFLOW_API_KEY` 为 key。进程启动时通过 dotenv 加载到环境变量，不进入数据库、不进入日志。后续版本可考虑操作系统密钥链集成或加密配置文件。
- 一个用户可以创建和管理多个小说项目
- 用户级别的配置（偏好语言、默认规则集等）跨项目共享

**小说项目（Novel Project）**：

- 一个项目 = 一部小说的完整世界状态
- 每个项目拥有独立的 SQLite 数据库文件（`{project_id}.db`）
- 每个项目拥有独立的 LanceDB 向量数据目录（`lancedb/{project_id}/`）
- 项目之间的 Fact、Rule、NarrativeThread 完全隔离，互不干扰
- 一个项目可以绑定专属的 World Package（世界观规则集），后续支持

**并发约束**：

- 项目是用户私有的，不存在多用户协作场景。其他用户无法查看或操作不属于自己的项目
- 一个用户同一时间只能对一个项目进行写入操作（同一时刻只有一个活跃的 LLM 写作会话）
- 用户可以在不同项目之间切换，但切换时前一个项目的写入会话需结束
- 不需要多写者锁或复杂并发控制——单会话单项目的假设简化了 FactStore 和 ProposalStore 的实现
- 仍保留项目级 `state_version` 乐观校验：它不是为多用户并发准备，而是防止 `propose_event` 基于旧快照生成的 proposal 在世界状态已变化后被静默提交

**并发保护（SQLite 层面）**：

- 项目级数据库（`{project_id}.db`）：单会话单项目假设下无并发写入风险，`better-sqlite3` 的同步 API 天然串行化
- 全局元数据库（`narrative_os_meta.db`）：所有用户共享，可能面临多进程并发访问（如热重载期间）。SQLite WAL（Write-Ahead Logging）模式提供文件级并发保护——多读者单写者，写操作自动排队。`better-sqlite3` 不默认启用 WAL，需在 `SQLiteConnectionFactory.open()` 中显式调用 `db.pragma('journal_mode = WAL')` 启用
- 如需跨进程互斥（如两个 CLI 实例同时操作同一项目），可在 `narrative_os_meta.db` 的 `projects` 表中维护 `locked_by` 字段，当前不实现，后续按需引入

**Core 引擎与项目的对应关系**：

```
┌─────────────────────────────────────────────────┐
│              Narrative-OS-Core                    │
│                                                 │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐      │
│  │  用户 A   │  │  用户 B   │  │  用户 C   │      │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘      │
│       │             │             │             │
│  ┌────▼─────┐  ┌────▼─────┐  ┌────▼─────┐      │
│  │ 项目 1   │  │ 项目 3   │  │ 项目 4   │      │
│  │ 项目 2   │  └──────────┘  │ 项目 5   │      │
│  └──────────┘                │ 项目 6   │      │
│                              └──────────┘      │
│                                                 │
│  ┌─────────────────────────────────────────┐   │
│  │           Core Engine（共享实例）         │   │
│  │  每个项目实例化独立的 FactStore +        │   │
│  │  VectorStore + RuleEngine 组合           │   │
│  └─────────────────────────────────────────┘   │
└─────────────────────────────────────────────────┘
```

Core Engine 本身是逻辑层，按项目 ID 实例化对应的存储适配器。用户 A 的项目 1 和项目 2 使用不同的数据库文件，数据完全隔离。

### 1.5 项目元数据

每个小说项目在创建时需指定以下元数据：

```typescript
interface NovelProject {
  id: string;                // 项目唯一 ID，如 'proj_xianxia_01'
  title: string;             // 小说标题，如 '凡人修仙传'
  ownerId: string;           // 所属用户 ID
  worldType: string;         // 世界观类型标记，如 'xianxia'/'western-fantasy'/'scifi' 等，自由字符串，当前仅作标记，后续据此加载对应 World Package
  createdAt: string;         // 项目创建时间 ISO 8601
  defaultContext: string;    // 默认作用域，通常 'global'（见 3.4.1）
  dbPath: string;            // SQLite 数据库文件路径
  lancedbPath: string;       // LanceDB 向量数据目录路径
}
```

---

## 2. 系统架构全景

### 2.1 分层架构

```
┌──────────────────────────────────────────────────┐
│              人类作者（自然语言）                    │
└─────────────────────┬────────────────────────────┘
                      │
                      ▼
┌──────────────────────────────────────────────────┐
│         LLM（写作 / 规划 / 决策）                   │
│  ← 接收 FactRenderer 注入的 Wiki 格式上下文          │
│  → 通过 Tool Call (JSON Schema) 写入 Core           │
└───────────┬──────────────────────┬───────────────┘
            │                      │
       Tool Interface         Semantic Retrieval
      (JSON Schema 写入)       (主动 Push 读取)
            │                      │
            ▼                      ▼
┌──────────────────────────────────────────────────┐
│                    Core Engine                    │
│                                                  │
│  ┌──────────────┐   ┌────────────────────────┐  │
│  │  FactStore   │◄──│  Semantic Retrieval     │  │
│  │  (SQLite     │   │  Layer                 │  │
│  │   Adapter)   │──►│  ContextAnalyzer        │  │
│  │  时序三元组   │   │  FactEmbedder           │  │
│  │  存储        │   │  RelevantFactRetriever  │  │
│  └──────┬───────┘   └───────────┬────────────┘  │
│         │                       │               │
│  ┌──────▼───────┐   ┌───────────▼────────────┐  │
│  │  Rule Engine │   │     FactRenderer        │  │
│  │  规则引擎    │   │  Fact → Wiki Markdown  │  │
│  └──────┬───────┘   └────────────────────────┘  │
│         │                                       │
│  ┌──────▼───────┐                               │
│  │ ThreadResolver │   ┌────────────────────────┐  │
│  │  线索系统    │   │     Event Store         │  │
│  └──────────────┘   │  (SQLite 事务日志)      │  │
│                     └────────────────────────┘  │
└──────────────────────────────────────────────────┘
                      │
                      ▼
             ┌────────────────┐
             │    LanceDB     │
             │  向量索引/检索  │
             │  (嵌入式, 无服务)│
             └────────────────┘
```

### 2.2 三条数据流概要

**写入流（确定性，作者驱动）**：

```
人类意图 → LLM 翻译 → Tool Call JSON
  → FactChange[] → Rule Engine 沙盒推演
  → EventConsequence（含潜在线索）
  → 人类确认 → Phase B 原子提交 Event/Fact/Knowledge/Thread/audit/outbox
  → Phase C 后台 worker 消费 sync_queue，同步 LanceDB 向量索引
```

**读取流（语义，系统驱动）**：

```
写作上下文（章节摘要 + 出场实体 + 近期段落）
  → ContextAnalyzer 提取查询信号
  → LanceDB 向量检索 Top-K Facts
  → FactStore 获取完整 Fact 数据
  → FactRenderer 渲染为 Wiki Markdown
  → 注入 LLM 上下文窗口
```

**校验流（持续，自动）**：

```
LLM 生成内容 → 实体/事件抽取
  → Rule Engine 校验一致性
  → NarrativeThread 生成 / 关闭
  → 未关闭线索列表维护
```

---

## 3. 核心领域模型

### 3.1 Fact（事实）

世界状态的最小原子单元，不可变。

**关键设计决策**：关系也是 Fact，没有独立的 GraphEdge 类型，关系通过 predicate 字段表达。

```typescript
interface Fact {
  id: string;             // 'fct_{type}_{chapter}[_{eventSeq}]_{factSeq}'，如 'fct_tribulation_50_01'
  subject: string;        // 主体实体 ID，如 'ent_zhangsan'
  predicate: string;      // 谓词：'realm' | 'enemy_of' | 'disciple_of' | ...
  value: FactValue;       // 值：标量或另一个实体的引用

  certainty: Certainty;   // canonical | contested | potential | orphaned
  causeEvent: string;     // 产生此事实的事件 ID（溯源核心）
  validFrom: number;      // 叙事生效章节号
  validTo: number | null; // null = 当前仍有效

  relationKind?: RelationKind; // 关系语义类别（可选），见 3.1.4
  context: string;        // 作用域（见 3.4.1 ContextScope），默认 'global'
  embeddingText: string;  // 向量化输入文本，见 3.1.2
  schemaVersion: number;  // Fact 结构版本号，默认 1。用于 Schema Evolution 时按版本反序列化历史数据
}

// ID 生成规则
// ─────────────────────────────────────────────────────────────
//
// 统一 ID 规则（当前版本）
// ─────────────────────────────────────────────────────────────
//
// 核心原则：
//   1. 所有 ID 首段为 3 字母类别前缀，一眼识别对象类型
//   2. ID 只负责唯一标识 + 类型识别，对象关系由数据字段维护
//   3. 所有区间用下划线分隔，所有区间为单段小写不含下划线
//   4. 同类型同定位冲突时，末尾追加序号（两位数字）
//
// 前缀含义与生命周期：
//
//   ent_  实体（基础层）  register_entity 创建 → 被 fct_ 的 subject 引用
//   evt_  事件（因果中心） commit_event / commit_retcon 创建 → 产生 fct_/thr_ 或系统级级联标记
//   fct_  事实（世界状态） evt_ 提交时生成    → ID 编码父事件的 type + chapter + seq
//   prp_  提案（暂态）    propose_event 创建  → 确认后消失，产生 evt_
//   rtc_  Retcon（暂态）  propose_retcon 创建 → 确认后消失，产生 evt_retcon_*
//   thr_  叙事线索       Rule Engine 产生 或 作者埋设 → 被后续 evt_ 核销
//   kno_  知识可见性     commit_event 时自动或 LLM 推断创建 → 记录谁知道了什么
//
//   生命周期流：
//     ent_（基础）← 被所有人引用
//     prp_ → evt_ → fct_ + thr_（主写入流）
//     rtc_ → evt_retcon_* → contested fct_ + reactivated thr_（历史修订流）
//
// ─────────────────────────────────────────────────────────────
//
// 【实体 ID】  ent_{name}[_{seq}]
//
//   ent_zhangsan              角色：张三
//   ent_lisi                  角色：李四
//   ent_chenlao               角色：陈老
//   ent_zhuxianjian            物品：诛仙剑
//   ent_zhuxianjian_01         物品：诛仙剑（同名第1把）
//   ent_gumu                  地点：古墓
//   ent_qingyunzong           势力：青云宗
//   ent_yaozu                 种族：妖族
//   ent_global                世界：全局设定
//
//   实体类型存储在 EntityRecord.type 字段（character/item/location/...），不在 ID 中。
//   name 为拼音连写，不含下划线。同名实体末尾加序号。
//
// ─────────────────────────────────────────────────────────────
//
// 【事件 ID】  evt_{type}_{chapter}[_{seq}]
//
//   evt_tribulation_50        第50章渡劫事件
//   evt_tribulation_50_02     第50章第2个渡劫事件（另一角色渡劫）
//   evt_encounter_55          第55章奇遇事件
//   evt_origin_01             第1章初始设定事件
//   evt_conflict_30           第30章冲突事件
//   evt_battle_200            第200章大战事件
//   evt_retcon_30             第30章目标事件的 Retcon 系统事件
//   evt_schema_50             第50章运行时 Schema Extension 系统事件
//
//   type 为事件类型（单段，不含下划线）。
//   同章同类型冲突时末尾加序号。
//
// ─────────────────────────────────────────────────────────────
//
// 【事实 ID】  fct_{type}_{chapter}[_{eventSeq}]_{factSeq}
//
//   fct_tribulation_50_01        渡劫50事件产生的第1条 Fact
//   fct_tribulation_50_02        渡劫50事件产生的第2条 Fact
//   fct_conflict_30_01_02        冲突30_01事件产生的第2条 Fact
//   fct_battle_200_05            大战200事件产生的第5条 Fact
//
//   去掉 fct_ 前缀后，剩余部分 = 父事件去掉 evt_ 前缀的部分 + factSeq。
//   eventSeq 仅在父事件有 seq 时出现。
//   factSeq 为该事件产生的第几条 Fact（两位整数，始终存在）。
//
// ─────────────────────────────────────────────────────────────
//
// 【提案 ID】  prp_{type}_{chapter}[_{seq}]
//
//   prp_encounter_250         第250章奇遇提案
//   prp_tribulation_50        第50章渡劫提案
//
// 【Retcon ID】  rtc_{targetType}_{targetChapter}[_{targetSeq}]
//
//   rtc_conflict_30           修改冲突30事件的 Retcon
//
//   prp_ 和 rtc_ 是暂态，确认后消失。commit 后产生 evt_。
//   rtc_ 提交后产生的事件固定使用 type='retcon'，例如 rtc_conflict_30 → evt_retcon_30。
//   Retcon Event 是系统事件：不生成普通 fct_，但作为 audit_log / sync_queue / event_dependencies 的事件锚点。
//   Schema Extension Event 固定使用 type='schema'，例如第50章新增谓词 → evt_schema_50。
//   Schema Event 也不生成普通 fct_，只作为 wp_* 写入和 audit_log 的事件锚点。
//
// ─────────────────────────────────────────────────────────────
//
// 【叙事线索 ID】  thr_{tag}_{chapter}[_{seq}]
//
//   thr_miracle_50            第50章·绝脉突破代价
//   thr_lostsword_200         第200章·诛仙剑丢失代价
//   thr_dreamdoor_12          第12章·梦中的门伏笔
//   thr_prophecy_100          第100章·大预言
//
//   tag 为线索的简短描述标签（拼音连写，不含下划线）。
//   原 cst_ 前缀仅作为历史导入兼容别名，新数据禁止生成 cst_。
//   关联事件通过 createdAtEvent 字段维护，不在 ID 中。
//
// ─────────────────────────────────────────────────────────────
//
// 【知识可见性 ID】  kno_{knower}_{factRef}
//
//   kno_claine_tribulation_50_01    克莱恩知道渡劫50事件第1条 Fact
//   kno_dunn_tribulation_50_01      邓恩知道渡劫50事件第1条 Fact
//
//   knower 为知晓者实体 ID 去掉 ent_ 前缀的部分。
//   factRef 为被知晓 Fact 的 ID 去掉 fct_ 前缀的部分。
//   同一实体对同一 Fact 的当前认知状态由最新一条 Knowledge 记录决定
//   （检索时取 known_since DESC, rowid DESC LIMIT 1）。历史记录不可变，
//   支持 seal/restore/decay 等状态变迁叠加（见 §3.6）。不使用联合唯一约束。
//
// ─────────────────────────────────────────────────────────────
//
// 【FactGroup ID】
//   与事件 ID 一致（1:1 绑定），如 evt_tribulation_50
//
// 【生成时机】
//   ent_：register_entity 时生成
//   prp_：propose_event 时生成
//   evt_：commit_event 时生成（消费 prp_）；commit_retcon 时也生成 evt_retcon_*（消费 rtc_）
//   fct_：commit_event → applyFactGroup → assert() 内部生成
//   thr_：Rule Engine 检测违规 或 作者埋设伏笔时生成
//   kno_：commit_event 时自动创建（主体）或 LLM knowledge_hints 显式创建
//   rtc_：propose_retcon 时生成

// 限制：FactValue 不支持数组或嵌套对象。
// 有序列表应拆成多条 Fact 或使用 PredicateDefinition.sequenceOrder 表达顺序。
// 不建议把列表编码为单个字符串；这样会丢失可查询性和规则可解释性。
// 后续若扩展 JSON 值类型，必须保留 scalar / EntityRef 的向后兼容。
type FactValue = string | number | boolean | EntityRef;

**SQLite 序列化约定**：SQLite 存储层必须同时保存标量值文本和标量子类型，避免 `"1"`、`1`、`true` 三者反序列化混淆。`value_type = 'scalar'` 时，`value_scalar_type` 取 `'string' | 'number' | 'boolean'`；`value_type = 'entity_ref'` 时，`value_entity_ref` 保存目标实体 ID。`types.ts` 中提供 `serializeFactValue / deserializeFactValue` 工具函数，所有 SQLite 读写均经由这两个函数。

// 关系 Fact 的目标引用
interface EntityRef {
  type: 'entity_ref';
  entityId: string;  // 'ent_lisi'
}
```

#### 3.1.1 属性 Fact 与关系 Fact 的对比

```typescript
// 属性 Fact：主体的内在状态
{ subject: 'ent_zhangsan', predicate: 'realm',    value: '金丹期' }
{ subject: 'ent_zhangsan', predicate: 'meridian', value: 'shattered' }
{ subject: 'ent_zhangsan', predicate: 'hp',       value: 8500 }

// 关系 Fact：主体与其他实体的关系（value 是 EntityRef）
{ subject: 'ent_zhangsan', predicate: 'enemy_of',    value: { type: 'entity_ref', entityId: 'ent_lisi' } }
{ subject: 'ent_zhangsan', predicate: 'disciple_of', value: { type: 'entity_ref', entityId: 'ent_chenlao' } }
{ subject: 'ent_zhangsan', predicate: 'holds_item',  value: { type: 'entity_ref', entityId: 'ent_zhuxianjian' } }

// 世界级别 Fact：设定规则本身
{ subject: 'ent_global',      predicate: 'cultivation_system', value: '炼体-练气-筑基-金丹-元婴' }
{ subject: 'ent_xiezong',  predicate: 'alignment',          value: 'evil' }
```

图结构可以从上述 Fact 集合中实时派生，但图不作为存储层的组成部分存在。

#### 3.1.2 embeddingText 生成规范

embeddingText 是写入 LanceDB 前向量化的输入字符串，需要把尽量多的语义信息压缩进去：

```
格式：{subject_name} 的{predicate_zh}是 {value_natural}（第{validFrom}章）

示例：
  张三 的修炼境界是 金丹期（第50章）
  张三 的经脉状态是 碎裂（绝脉）（第1章）
  张三 与李四的关系是 敌对（第30章）
  邪宗 的阵营是 邪道（第1章）
```

predicate 到中文标签的映射由 World Package 提供（见 3.9）。以下为通用映射 + 仙侠世界观扩展的示例。

#### 3.1.3 Certainty 枚举

```typescript
type Certainty =
  | 'canonical'   // 正史：作者确认的世界真实状态
  | 'contested'   // 争议：被 Retcon 影响，等待作者裁决
  | 'potential'   // 潜在：沙盒推演中的候选状态，未确认
  | 'orphaned';   // 孤儿：前置依赖断裂，逻辑上已废弃
```

**合法的 certainty 状态转换路径**：

```
canonical ──→ contested    Retcon 修改了该 Fact 的上游事件，需要作者裁决
canonical ──→ orphaned     上游依赖链断裂（如 causeEvent 被彻底删除）
contested ──→ canonical    作者通过 propose_event 重新确认或替换 contested Fact
contested ──→ orphaned     作者确认放弃，该 Fact 逻辑废弃
potential ──→ canonical    沙盒推演结果被 commit_event 确认
potential ──→ orphaned     沙盒推演结果被 commit_event 拒绝，或被更好的方案取代
orphaned   ──→ canonical   上游依赖被恢复（如 Retcon 被再次 Retcon 撤回）

不可逆转换：canonical / contested 一旦进入 orphaned，原则上不再转回（例外：Retcon 撤回恢复依赖链）。
```

> **简化**：当前仅实现 `potential → canonical`（沙盒确认写入）和 `canonical → contested`（Retcon 标记），
> `orphaned` 相关转换推迟到后续迭代（需要因果图遍历支持）。
>
> **contested → canonical 的实现路径**：状态机中画了此箭头，但实际并非直接 UPDATE certainty 字段
> （那会违反 Event Sourcing 不可变性）。正确做法是作者通过 `propose_event` 创建一条新的 canonical Fact
> 替代 contested Fact。原 contested Fact 保留为历史记录（certainty=contested 不变），查询时因
> 新 canonical Fact 的 is_current=true 而自然遮蔽旧 contested Fact。这符合"世界状态 = 最新 canonical
> Fact"的查询语义，同时保留完整的争议历史。

#### 3.1.4 EntityKind 与 RelationKind 语义分类体系

引入两层语义分类，在扁平三元组存储上叠加结构化元数据。这两层不是独立的存储结构，而是 Entity 和 Fact 的可选标签字段，由 LLM 自动推断或作者显式指定。

**设计意图**：Fact 三元组是语义扁平的——系统不区分"张三的境界"和"张三知道的秘密"属于不同类别。语义分类体系让系统具备领域感知能力，支持按类别聚合查询（"所有伏笔"、"所有角色知道的信息"），同时保持底层存储模型的简洁性。

```typescript
// EntityKind：实体分类（注册时指定，register_entity 的 kind 参数）
// 14 种分类，覆盖诡秘之主级别的设定复杂度
type EntityKind =
  | 'entity'            // 实体：角色、物品等可独立存在的对象（通用兜底）
  | 'place'             // 地点：具体的地理位置或场所
  | 'spatial_domain'    // 空间域：抽象的空间范围或领域（如秘境、位面、灰雾之上）
  | 'state'             // 状态：封印状态、污染状态等可变化的状态实体
  | 'goal'              // 目标：角色、组织或世界阶段正在追求的结果
  | 'resource'          // 资源：货币、材料、线索、权柄等可消耗或争夺的对象
  | 'ability'           // 能力：技能、权限、仪式资格、序列能力等行动条件
  | 'identity'          // 身份：公开身份、隐藏身份、阵营身份、社会标签
  | 'theme'             // 主题：命运、代价、背叛等抽象叙事母题
  | 'rule'              // 规则：世界运行的法则、约束或机制
  | 'information'       // 信息：知识、情报、秘密等认知内容
  | 'foreshadowing'     // 伏笔：预先埋下的线索或暗示
  | 'event'             // 事件：已发生或正在发生的事情
  | 'time';             // 时间：时间点、时间段等时间相关概念

// RelationKind：关系语义分类（Fact 的可选元数据字段）
// 15 种语义类别，覆盖叙事中的所有关系维度
type RelationKind =
  | 'structural'    // 结构关系：组成、包含、分类等结构性连接
  | 'social'        // 社会关系：人际、组织、阵营等社会性连接
  | 'possession'    // 拥有关系：所有权、控制权、归属等
  | 'causal'        // 因果关系：导致、引发、影响等因果连接
  | 'informational' // 信息关系：知晓、传播、隐藏等信息流动
  | 'spatial'       // 空间关系：位置、方向、距离等空间连接
  | 'temporal'      // 时间关系：先后、期限、周期、倒计时等时间连接
  | 'state'         // 状态关系：处于、感染、封印、激活等状态连接
  | 'goal'          // 目标关系：追求、阻碍、牺牲、完成等目标连接
  | 'dependency'    // 依赖关系：行动、知识、资源、条件之间的依赖连接
  | 'permission'    // 权限关系：允许、禁止、需要资格、可进入等许可连接
  | 'identity'      // 身份关系：伪装、真实身份、公开身份、隶属标签等连接
  | 'thematic'      // 主题关系：象征、映射、呼应、反讽等主题连接
  | 'rule'          // 规则关系：约束、限制、遵循等规则性连接
  | 'narrative';    // 叙事关系：伏笔照应、情节关联等叙事性连接
```

**与旧版 EntityType 的关系**：`EntityType`（7种）已被 `EntityKind`（14种）完全替代。原 `EntityType` 的 `character`/`item`/`location` 等被 `entity` 统一吸收（通过 `EntityKind` + `description` 组合区分），新增的 `identity`/`information`/`foreshadowing` 等是之前缺失的关键分类。

**RelationKind 的推断时机**：

| 来源 | 时机 | 可靠性 |
|------|------|--------|
| 谓词映射表 | 系统根据 `predicate` 查预定义映射（如 `enemy_of` → `social`） | 最高（确定性规则） |
| LLM 标注 | `propose_event` 时 LLM 在 FactChangeInput 中附带 `relation_kind` | 高（LLM 理解语义） |
| 作者指定 | 作者在 LLM 对话中说明 | 最高（人工确认） |

优先使用谓词映射表（确定性），LLM 标注覆盖未收录谓词，作者指定作为兜底。映射表定义在 World Package 中（见 3.9）。

```typescript
// 谓词映射表（部分示例）
const PREDICATE_RELATION_MAP: Record<string, RelationKind> = {
  realm: 'state',
  meridian: 'state',
  hp: 'state',
  status: 'state',
  bloodline: 'state',
  location: 'spatial',
  enemy_of: 'social',
  disciple_of: 'social',
  holds_item: 'possession',
  alignment: 'identity',
  knows: 'informational',
  prerequisite_of: 'dependency',
  foreshadows: 'narrative',
  reflects: 'thematic',
  constrains: 'rule',
  // ... World Package 扩展
};
```

**EntityKind 定位**：EntityKind 是检索优化标签，不是世界本体论。

- EntityKind 的唯一用途：辅助 FactEmbedder 生成更精准的 embeddingText，辅助 RelevantFactRetriever 按类型过滤结果
- EntityKind 不决定实体的行为、能力、关系——这些全部由 Fact 表达
- 新增 EntityKind 的门槛：必须有至少 3 部作品需要此类型来提升检索质量
- 如果未来需要更细的分类，优先使用 World Package 的自定义标签（entity 元数据字段），而不是扩展 EntityKind 枚举

### 3.2 FactChange（事实变更指令）

LLM 或系统试图修改世界的意图，写入操作的原子单元。

```typescript
// FactChange：内部领域模型，引擎内部使用
// LLM 通过 Tool Interface 提交 FactChangeInput（见 9.2），系统在 propose_event 时将其转换为 FactChange
interface FactChange {
  changeId?: string;      // 对应 FactChangeInput.change_id，propose_event 阶段的临时 ID
  op: 'assert' | 'retract' | 'update';
  targetFactId?: string;  // retract / update 时必填，指定要操作的目标 Fact
  payload?: Partial<Omit<Fact, 'id' | 'causeEvent' | 'embeddingText'>>; // assert / update 时的新数据
}
```

#### 3.2.1 FactChangeInput → FactChange 转换机制

FactChangeInput 是 LLM 面向的外部接口（字段扁平、命名 snake_case），
FactChange 是引擎内部模型（payload 包裹、命名 camelCase）。
两者职责不同：前者追求 LLM 填写便利，后者保证引擎内部类型安全。

**转换时机**：Tool Interface 层，LLM 提交后立即转换。下游所有组件（Rule Engine、ThreadResolver、FactStore）只感知 FactChange。

**实现方式：声明式映射表（定义在 types.ts 中，与 FactChange 定义放在一起）**：

```typescript
// 字段映射声明：外部 key → 内部 key
const FACT_CHANGE_MAPPING = {
  fieldMap: {
    'change_id':      'changeId',
    'subject':        'subject',
    'predicate':      'predicate',
    'value':          'value',
    'target_fact_id': 'targetFactId',
  },
  // 按 op 定义必填/可选字段
  opRules: {
    assert:  { required: ['subject', 'predicate', 'value'] },
    retract: { required: ['target_fact_id'] },
    update:  { required: ['target_fact_id'], optional: ['subject', 'predicate', 'value'] },
  }
} as const;
```

Tool Interface 层的转换引擎是通用函数（约 20 行），不随字段增加而膨胀：
1. 按 `opRules` 校验必填字段
2. 按 `fieldMap` 做 key 重命名 + 包裹进 `payload`
3. 返回 FactChange

**时间默认值**：`FactChangeInput` 不向 LLM 暴露 `valid_from`。Tool Interface 转换后，提交编排层必须在 Phase A 就把默认时间补齐：`assert/update` 的 `payload.validFrom` 默认等于 `NarrativeEvent.chapter`，`retract` 的 `payload.validTo` 默认等于 `NarrativeEvent.chapter`。Phase B 只能复用归一化后的 FactChange，不得回退到硬编码第 1 章。需要表达"第 50 章事件导致第 45 章状态生效"这类回填语义时，应通过 Retcon 或专门的历史修订流程处理，不走普通 `propose_event` 默认路径。

**Phase A 入口硬校验**：`propose_event` 在沙盒推演前必须拒绝会污染状态入口的输入：业务事件缺少 `params.subject`、`fact_changes` 为空、`change_id` 缺失/重复/不符合 `^[a-zA-Z0-9_-]+$`、`update/retract` 的 `target_fact_id` 不存在或已失效、目标 Fact 的 `context` 与当前事件 `context` 不一致、`dependent_fact_ids` 指向不存在或在事件章节不可见的 Fact。这些错误必须在 Phase A 暴露，不能依赖 Phase B 的 SQLite 外键或默认值兜底。

**正确性保障（三层）**：

| 层级 | 机制 | 作用 |
|------|------|------|
| 第一层 | 声明式映射表 | 转换引擎只做"查表+赋值"，无分支逻辑，逻辑 bug 无处藏身 |
| 第二层 | 往返一致性测试 | `FactChangeInput → FactChange → 反向展开` 应与原始输入一致，覆盖所有 op × 字段组合 |
| 第三层 | 快照测试 | 每个 op 类型一组 input/output 对照，映射表变更时立即捕获 |

**审计日志**：转换时将原始 FactChangeInput 存入 SQLite `audit_log` 表，定位为给人类作者的叙事可追溯性（"LLM 到底提交了什么"），而非开发者的 debug 工具。

| op | 含义 | 效果 |
|----|------|------|
| `assert` | 断言新事实 | 创建新 Fact，写入 FactStore，并在同事务写入 `sync_queue` 的 `insert_vector` outbox |
| `retract` | 撤回事实 | 设置目标 Fact 的 `validTo`，不删除，并在同事务写入 `sync_queue` 的 `mark_invalid` outbox |
| `update` | 更新事实 | retract 旧 + assert 新，保证不可变性 |

### 3.3 FactGroup（原子事务）

一个 Event 产生的所有 FactChange 的原子集合。要么全部成功，要么全部回滚。

```typescript
interface FactGroup {
  id: string;             // 与 causeEvent 一致，如 'evt_tribulation_50'
  causeEvent: string;     // 绑定的事件 ID（所有 Fact 的 causeEvent 都是这个）
  changes: FactChange[];  // 原子执行的变更集
}
```

### 3.4 NarrativeEvent（叙事事件）

推动世界时间线前进的唯一动力，所有状态变更的唯一入口。

```typescript
interface NarrativeEvent {
  id: string;                // 'evt_tribulation_50'
  kind: 'business' | 'system'; // business=剧情事件；system=Retcon/Schema 等审计锚点
  type: string;              // 事件类型，如 'tribulation' | 'ancient_encounter'
  chapter: number;           // 叙事章节（时间轴坐标）
  params: EventParams;       // 事件参数，规则引擎通过此字段获取事件主体等信息
  context: string;           // 事件发生的作用域，默认 'global'
  description: string;       // 自然语言摘要
  timestamp: string;         // 系统时间 ISO 8601（作者何时写的）
  factGroupId: string;       // 关联的原子事务 ID
  resolvedThreads: string[];   // 此事件关闭的 NarrativeThread ID 列表
  dependentFactIds: string[];  // 事件级依赖边的冗余快照，查询以 event_dependencies 表为准
}

// 事件参数：携带规则引擎和 ThreadResolver 判定所需的上下文信息
type EventParamValue =
  | string
  | number
  | boolean
  | string[]
  | number[]
  | Record<string, unknown>
  | null;

interface EventParams {
  subject?: string;                    // 业务事件主体实体 ID；系统事件可为空
  [key: string]: EventParamValue | undefined; // 扩展参数，如目标实体、Fact ID 列表、规则配置摘要等
}
```

> **业务事件参数约束**：普通 `commit_event` 写入的业务事件必须提供 `subject`，否则 Rule Engine 和 ThreadResolver 无法判断主体状态。系统事件（当前包括 `type='retcon'` / `type='schema'`）允许不提供 `subject`，但必须在 `params` 中写明自己的目标对象，例如 `target_event_id`、`affected_tables` 或 `new_predicate_names`。

> **提交安全门槛**：`ProposalResult.isSafeToCommit = false` 的提案不得被 `commit_event` 直接写入。当前 Tool Interface 没有 override 字段，因此 Phase 1 的安全策略是要求 LLM / 作者重新 `propose_event` 修正冲突；未来若要支持人工强制提交，必须增加显式 override 参数并写入 audit_log。

**Retcon 系统事件**：`commit_retcon` 也必须创建一条 `NarrativeEvent`，事件类型固定为 `retcon`，ID 形如 `evt_retcon_{targetChapter}`。该事件的 `params` 至少包含 `retcon_proposal_id`、`target_event_id`、`contested_fact_ids`、`reactivated_thread_ids`，`factGroupId` 等于事件 ID 但对应空 FactGroup。Retcon Event 不产生普通 Fact，它的职责是给 contested 标记、Thread 恢复、审计日志、LanceDB outbox 和依赖边提供统一的 Event Sourcing 锚点。

**Schema Extension 系统事件**：`commit_schema_extension` 必须创建一条 `NarrativeEvent`，事件类型固定为 `schema`，ID 形如 `evt_schema_{currentChapter}`。该事件的 `params` 至少包含 `proposal_id`、`extension_type`、`affected_tables`、`new_predicate_names`、`new_rule_ids`，`factGroupId` 等于事件 ID 但对应空 FactGroup。Schema Event 不参与 Rule Engine 判定，不产生 Fact，不写 `sync_queue`，只负责审计 wp_* 表变更并让 `project_state.state_version` 递增。

**事件种类边界**：Retcon BFS、ThreadResolver、Rule Engine、ContextAnalyzer 的叙事因果遍历默认只读取 `kind='business'` 的事件。`kind='system'` 事件只用于审计、版本推进、outbox 锚点和运维查询；除非调用方显式传入 `kind='system'` 或 `kind='all'`，EventStore 查询不得把系统事件返回给叙事推理流程。

**时间双轴说明**：

| 时间轴 | 字段 | 含义 | 用途 |
|--------|------|------|------|
| 叙事时间 | `NarrativeEvent.chapter` / `Fact.validFrom` | 故事内的时间线 | 查询"第50章主角什么状态" |
| 系统时间 | `NarrativeEvent.timestamp` | 作者创作的现实时间 | 审计"这个设定是什么时候加的" |

**时间模型**：章节号（chapter）是严格单调递增的数字（通常为整数，支持小数编号如 49.5 用于子章节插入），代表主线时间轴。非线性叙事结构（插叙、倒叙）视为正序章节的特殊事件描述。平行时间线通过 ContextScope（3.4.1）解决。DDL 中 chapter 相关列统一使用 REAL 类型。

**章节号重排/插入**：章节号一旦分配就不变。需在已有章节之间插入时，采用小数编号（如 49.5）或从末尾追加。批量重编号不在支持范围内，会触发大规模 `validFrom` / `validTo` 更新。

#### 3.4.1 ContextScope：作用域与遮蔽模型

`context` 字段是解决"局部设定割裂"的核心机制——梦境、副本空间、神弃之地、整活番外等场景，通过作用域隔离实现"不污染主线设定"。

> **设计注记（Phase 2 考虑）**：当前 ContextScope 同时承担空间（秘境/副本）、时间（历史回溯）、现实层级（梦境/幻术）三种职责。MVP 阶段统一为 context 字段处理是合理的。未来如果出现"梦境中的过去副本"等深层嵌套场景，可能需要拆分为 Timeline（时间线）+ RealityLayer（现实层级）+ ContextScope（可见性边界）三个独立维度。当前不拆，但保留此扩展点。

**核心概念：胶片叠层模型**

世界设定不是一块焊死的钢板，而是一叠可以随时叠加、摘除的透明胶片。`context` 决定当前视角能叠加哪些胶片，`knowledge`（3.6）决定当前角色能看清胶片上的哪些字。

**作用域与绝对时间轴（Global Timeline）**：

作用域（ContextScope）只隔离**空间与物理法则**，不隔离**时间坐标**。小说的章节号（chapter）是全局唯一且绝对单调递增的时间轴（见 I-11），无论当前处于什么作用域。

```
示例场景：
  第 100-110 章：主角在主线（global）
  第 111-120 章：主角进入副本（arc_dungeon），副本内度过"十年"
  第 121-122 章：视点切回主线，描写反派动作（global）
  第 123-130 章：视点切回副本，主角继续探索（arc_dungeon）

系统不关心副本内的"十年"如何与主线对齐。
系统只认知叙事章节号——这是一维的整数，没有分支、没有相对偏移。

  第 121 章主线反派的状态变更（validFrom = 121），客观存在于第 123 章的副本视角中。
  退出副本时（exit_scope），新全局 Fact 的 validFrom = 退出时的章节号。
  这使得时间切片查询 getSnapshot(atChapter) 永远只需要处理一维整数比较。
```

> **设计边界**：如果未来需要支持"平行宇宙各有独立时间线"（如《复联4》的时间劫持），需要引入 Timeline 维度（Phase 2 拆分预留，见上方设计注记）。当前的绝对时间轴假设排除了这种场景——所有叙事共享同一条时间线，分支通过 ContextScope 遮蔽而非时间偏移实现。

```typescript
// ContextScope 定义
interface ContextScope {
  name: string;              // 作用域名称，如 'global' | 'arc_dream_01' | 'arc_forbidden_zone'
  displayName: string;       // 人类可读名称，如 '主线' | '梦境篇' | '神弃之地'
  parentScope: string;       // 继承的父作用域（默认 'global'），形成作用域树
  defaultExitBehavior: 'suggest_promote' | 'suggest_discard';
                             // 退出时的默认行为提示（非硬约束，作者始终可以覆盖）：
                             //   suggest_promote：默认建议将角色状态变更持久化（副本/秘境）
                             //   suggest_discard：默认建议不持久化（梦境/幻境）
  description?: string;      // 此作用域的设定偏移说明
  isActive: boolean;         // 当前是否激活（同一时刻只有一个非 global 作用域激活）
}
```

**核心设计原则：退出作用域时，作者始终拥有最终决定权**。

`defaultExitBehavior` 是 UI 层面的**建议**（审计报告中预先勾选/不勾选哪些 Fact 建议持久化），不构成系统级硬约束。原因：同一个梦境可能产出真实的后果——角色 A 对 B 施加造梦能力，B 在梦中获知了某个秘密，醒来后 B 确实知道了这个信息。如果系统硬性规定"梦境 = 什么都不持久化"，就封死了这种合法的叙事路径。

**作用域继承规则**：

```
global（主线设定：世界规则、角色基础属性、历史事件）
  ├── arc_forbidden_zone（神弃之地，suggest_promote：继承全局，但魔法体系不同）
  ├── arc_dream_01（梦境篇，suggest_discard：继承全局，但重力反转、死者复活）
  └── arc_sidequest_03（支线副本，suggest_promote：继承全局，独立空间）
```

子作用域默认继承父作用域（通常是 `global`）的所有 Fact。子作用域中写入的 Fact 会**遮蔽（Shadow）**同 subject+predicate 的全局 Fact——读取侧看到的始终是"最内层"的值。

**遮蔽机制的四种叙事场景**：

| 场景 | 叙事性质 | defaultExitBehavior | context 值 | 退出时行为 |
|------|---------|---------------------|-----------|-----------|
| 副本/秘境/异世界 | 主线承认，真实发生，规则不同 | `'suggest_promote'` | `'arc_forbidden_zone'` | 审计报告建议持久化角色状态变更；作者确认/调整 |
| 纯梦境/幻境 | 发生但非真实，无后遗症 | `'suggest_discard'` | `'arc_dream_01'` | 审计报告建议不持久化；如无后遗症则空操作 |
| 有后果的梦境 | 非真实但留下了真实影响 | `'suggest_discard'` → 作者覆盖 | `'arc_dream_01'` | 作者在 exit_scope 的 fact_changes 中显式声明后遗症（创伤、获知的信息等） |
| If线/整活番外 | 不计入主线因果 | N/A | 独立项目 | 直接克隆项目数据库，随意折腾后丢弃 |

**检索管线的作用域感知**：当写作上下文的 `currentScope` 非 `global` 时，FactStore 的查询自动扩展为双层叠加：

```sql
-- 获取当前作用域 + 全局的 Fact，局部优先
SELECT *, CASE context WHEN :current_scope THEN 0 WHEN 'global' THEN 1 END AS priority
FROM facts
WHERE (context = :current_scope OR context = 'global')
  AND certainty = 'canonical'
  AND is_current = true
  AND valid_from <= :at_chapter
ORDER BY priority ASC, valid_from DESC
```

同一个 `subject + predicate` 如果在 `arc_dream_01` 和 `global` 中都存在，检索结果只保留 `priority = 0`（局部）的那条——这就是遮蔽。

**作用域的退出机制（统一流程，不区分 real/unreal）**：

所有作用域的退出走**同一条路径**——作者通过 `exit_scope` 事件的 `fact_changes` 显式声明哪些变更持久化到主线。系统不做假设，不设硬约束。

**作用域边界校验（跨作用域 Fact 引用防护）**：

虽然 `exit_scope` 的设计惯例是使用 `op: "assert"` 创建新的全局 Fact（见下方示例），但 `FactChangeInput` 类型层面也支持 `op: "update"` / `op: "retract"`。当这些操作引用的 `target_fact_id` 指向一个与当前事件 `context` 不同的作用域时，存在将局部设定"偷渡"到全局的风险。

校验规则：在 `applyFactGroup` 执行 `update` 或 `retract` 操作前，检查 `target_fact_id` 对应 Fact 的 `context` 字段。如果 Fact 的 context 与当前事件的 context 不一致，且当前事件不是 `propose_retcon`（Retcon 有自己的跨作用域报告机制），则返回 `SCOPE_FACT_MISMATCH` 错误。

```typescript
// applyFactGroup 内的跨作用域校验（在 SQLite 事务内、实际写入前）
if (['update', 'retract'].includes(change.op)) {
  const targetFact = this.getById(change.target_fact_id);
  if (targetFact && targetFact.context !== event.context) {
    throw new ToolError(
      'SCOPE_FACT_MISMATCH',
      `Fact ${change.target_fact_id} 属于作用域 ${targetFact.context}，` +
      `当前事件作用域为 ${event.context}。` +
      `跨作用域操作请使用 op='assert' 在目标作用域创建新 Fact。`
    );
  }
}
```

> **设计边界**：此校验阻止的是"静默的跨作用域修改"，而非"作者有意的跨作用域叙事"。作者如果需要将梦境中的设定带到现实，正确方式是在 `exit_scope` 中用 `op: "assert"` **重新声明**一个全局 Fact，系统会生成新的 `causeEvent`（指向退出事件），保持因果链清晰。而 `op: "update"` 修改梦境 Fact 的 context 字段，会在因果链上留下无法解释的"来源断裂"——这个 Fact 的 causeEvent 指向一个梦境事件，但它的 context 是 global，违反"Fact 的 context 与 causeEvent 的 context 一致"的隐性不变式。

```
退出任意作用域：

  propose_event({
    event_type: "exit_scope",
    context: "global",           // 切回全局
    exit_from: "arc_forbidden_zone",  // 从哪个作用域退出
    fact_changes: [              // 作者决定哪些变更持久化（可以为空）
      { op: "assert", subject: "ent_zhangsan", predicate: "ability", value: "空间操控" },
      { op: "assert", subject: "ent_zhangsan", predicate: "status", value: "重伤" }
    ]
  })

  效果：
    → fact_changes 中的 Fact 以 context='global' 写入（持久化到主线）
    → 作用域内的所有 Fact（含持久化的和未持久化的）设置 validTo（在作用域内失效）
    → 未持久化的 Fact 保留在数据库中（不删除），只能通过历史查询 get_context_slice({ context: 'arc_...', mode: 'history', atChapter }) 查询
    → 持久化到 global 的 Fact 通过 causeEvent 关联退出事件，可追溯"从哪个作用域带来的"

**跨作用域依赖溯源（Cross-Scope Lineage Tracking）**：

当 `exit_scope` 将作用域内的设定导出为全局 Fact 时，系统必须在退出事件的 `dependent_fact_ids` 中**自动注入**指向原始作用域 Fact 的显式依赖。这不是 LLM 声明的（LLM 可能遗漏），而是系统强制注入的。Phase 1 轻量依赖追踪以 `event_dependencies` 边表为查询来源，并在 `events.dependencies_json` 中冗余保存一份用于审计展示：

```
自动注入逻辑（propose_event Phase A 归一化 exit_scope 事件时执行；commit_event Phase B 只负责落盘）：
  FOR EACH fact_change WHERE op == 'assert':
    // 在退出作用域中查找 subject + predicate 匹配的 canonical Fact
    originFacts = FactStore.query({
      subject: fact_change.subject,
      predicate: fact_change.predicate,
      context: exit_from,         // 被退出的作用域
      certainty: 'canonical',
      isCurrent: true
    })
    IF originFacts 非空:
      当前 exit_scope 事件的 dependent_fact_ids 追加 originFacts[0].id
      // 如果作用域内有多条匹配（如境界从炼气变到筑基），取最新一条
```

Phase A 注入后的 `dependent_fact_ids` 必须随 Proposal 一起保存。Phase B 提交时，`events.dependencies_json` 保存同一份 ID 列表用于审计展示，`event_dependencies(event_id, fact_id, source='system_exit_scope')` 作为 Retcon / 跨作用域扫描的查询来源。若同一 Fact 同时由 LLM 显式声明和系统自动注入，保留一条依赖边即可。

> **为什么需要这条规则**：没有它，跨作用域扫描（§9.2 Tool 4 级联报告中的"跨作用域潜在影响"区块）只能靠 subject + predicate 模糊匹配来发现受影响的全局 Fact。有了显式 `dependent_fact_ids`，扫描变成确定性查询——直接通过 `event_dependencies.fact_id` 索引查找下游事件，不依赖启发式匹配。
>
> **蝴蝶效应场景**：主角在副本（arc_dungeon）获得神器（Fact A），exit_scope 将其带回主线并生成 Fact B，同时退出事件记录 dependencies_json=[A]。后续作者 Retcon 副本中神器诞生的源头事件，Fact A 被标记 contested。跨作用域扫描通过 dependent_fact_ids 精确发现产生 Fact B 的退出事件，在级联报告中生成"因果污染"警告。
```

**审计报告中的退出建议（UI 层行为，非系统约束）**：

当 `defaultExitBehavior = 'suggest_promote'` 时，退出前的审计报告会列出作用域内的角色状态变更，建议作者勾选要持久化的项：

```markdown
## 退出作用域建议 · arc_forbidden_zone

以下为作用域内产生的角色状态变更，请勾选要带回主线的项目：

- [x] 张三 获得能力"空间操控"（第201章）
- [x] 张三 状态 → 重伤（第203章）
- [ ] 张三 位置 → 神弃之地（空间规则，不需带回）
- [x] 张三 与 古老剑 的持有关系（获得新物品）
```

当 `defaultExitBehavior = 'suggest_discard'` 时，默认全不勾选，但作者仍可手动添加：

```markdown
## 退出作用域建议 · arc_dream_01

此作用域默认不持久化任何内容。如梦境留下了真实影响，请手动添加：

- [ ] 张三 获知了"克莱恩的真实身份"（梦境中被告知）
- [ ] 张三 状态 → 心理创伤（梦境后遗症）

（以上两项默认未勾选，作者可手动勾选以持久化到主线）
```

**造梦/幻术能力的因果链**：

当角色 A 对角色 B 施加造梦能力时，因果链如下：

```
全局层面（context='global'）：
  Fact: 角色 A 拥有"造梦"能力                    ← 能力本身是全局设定
  Event: 角色 A 对角色 B 施加造梦                  ← 行为发生在主线时空中
  Fact: 角色 B 进入梦境状态                        ← 全局可见的状态变更

梦境层面（context='arc_dream_01'）：
  Event: B 在梦中看到死去的母亲                     ← 梦境内容，仅作用域内可见
  Fact: B 在梦中被告知了某个秘密                    ← 梦境内容

退出梦境（exit_scope）：
  Event: B 醒来
  fact_changes（作者决定）：
    ✅ B 获知了某个秘密（从梦中得知，但信息本身是真的）  ← 持久化到 global
    ✅ B 产生心理创伤                                    ← 持久化到 global
    ❌ B 看到死去的母亲复活                               ← 不持久化（梦境内容）
    ❌ 梦境中的重力反转                                    ← 不持久化（空间规则）
```

**关键设计决策**：持久化行为不由系统硬性规定，而由作者在每次退出时逐条决定。系统的角色是**提供建议和审计界面**，而非做叙事判断。原因：

1. 叙事逻辑远比"真实/虚幻"二分法复杂——造梦能力可以传递真实信息、精神攻击可以留下真实伤害
2. 同一个梦境对不同角色可能有不同的后果——A 醒来后遗忘了梦境内容，B 却永远记住了
3. 作者可能在不同章节改变主意——第 200 章以为梦境无后果，第 300 章却发现角色一直受梦境影响
4. 固定逻辑会封死合法的叙事路径——与"作者拥有最终决定权"的根本原则冲突

作者在退出事件中声明的 `fact_changes` 会以 `context='global'` 写入，与正常事件提交走完全相同的规则引擎沙盒推演流程（包括知识传播、叙事线索追踪等）。

**Retcon 兼容**：作用域内的 Fact 与全局 Fact 共享同一个 FactStore 和因果链。对作用域内事件的 Retcon 按照正常的 BFS 级联规则处理。由于作用域 Fact 的 `context` 字段不同，Retcon 级联**不会跨越作用域边界**——修改 `arc_dream_01` 中的事件不会影响 `global` 的 Fact。

**NarrativeThread tags（线索标签）**：与 ContextScope 互补，用于"主线时空中的超纲操作"场景。

```typescript
// ⚠ 以下仅为 tags/arcTag 扩展字段的局部定义。NarrativeThread 的完整接口定义见 §3.5，
// 包含 id/type/direction/severity/description/closeCondition/status 等全部字段。
interface NarrativeThread {
  // ... 现有字段（见 §3.5 完整定义）...
  tags?: string[];   // 自由标签，如 ['side_arc', 'arc_dream_01']
  arcTag?: string;   // 快捷字段：关联的作用域名称（可选）
}

// ThreadFilter 扩展（完整定义见 §6.1）
// ⚠ 以下仅为 arcTag 相关的扩展字段，ThreadFilter 的完整接口见 §6.1。
interface ThreadFilter {
  // ... 现有字段（见 §6.1 完整定义）...
  arcTag?: string;             // 只展示属于某作用域的线索
  excludeArcTags?: string[];   // 排除属于某些作用域的线索（主线写作时排除副本线索）
}
```

当作者在主线写作时，设置 `excludeArcTags: ['arc_dream_01']` 即可屏蔽梦境篇的未关闭线索，避免干扰。

#### 3.4.2 ContextScope 开发守则

**ContextScope 的职责边界**：ContextScope 只负责**空间隔离与物理法则隔离**，不隔离时间坐标（见 §3.4.1 全局时间轴声明）。

**Phase 1 编码规范**：
- Phase 1 实现时，不把时间/现实层级的逻辑写死到 ContextScope 专用的代码路径中
- context 字段使用统一的命名模式：
  - `global`：主线
  - `arc_*`：空间域（副本/秘境）
  - `flashback_*`：时间回溯（Phase 1 兼容处理，Phase 2 会迁移到 Timeline 维度）
  - `dream_*`：现实层级（Phase 1 兼容处理，Phase 2 会迁移到 RealityLayer 维度）

**Phase 2 拆分预留**：
- Phase 2 计划拆分为：Timeline（时间线）+ RealityLayer（现实层级）+ ContextScope（空间可见性边界）
- Phase 1 使用 `flashback_ch1_ch10` 或 `dream_01` 的数据，Phase 2 会迁移到 `timeline_id + context` 的组合
- 迁移脚本由架构团队提供，开发者不需要自己设计迁移方案
- **开发者约束**：不要在代码中硬编码 `flashback_*` / `dream_*` 前缀的特殊处理逻辑，所有 context 值统一走查询与遮蔽机制

### 3.5 NarrativeThread（叙事线索）

统一追踪两类叙事承诺：回溯型（Cost：先写结果后补原因）和渐进型（Foreshadowing：先埋种子后开花）。

**统一理由**：Cost 和 Foreshadowing 本质上都是"对读者的叙事承诺，等待被兑现"。在诡秘之主里，克莱恩身份的伏笔同时也是对"克莱恩只是普通人"这条设定的违反——分开系统无法追踪这种跨类型场景。统一为 NarrativeThread 后，同一条线索可以同时是伏笔和规则违反。

```typescript
// 线索方向
type ThreadDirection = 'retroactive' | 'progressive';

// 线索类型
type ThreadType =
  // 回溯型（原 Cost 类别）
  | 'causal_gap'            // 因果缺口：先写了结果，后需要补原因
  | 'timeline_perturbation'  // 时间线扰动
  | 'rule_violation'        // 规则违反
  | 'logic_conflict'        // 逻辑矛盾
  // 渐进型（原 Foreshadowing 类别）
  | 'foreshadowing'         // 伏笔：预先埋下的线索或暗示
  | 'mystery'               // 谜团：尚未揭示的真相
  | 'prophecy'              // 预言：未来必然发生的事件
  | 'promise'               // 承诺：角色间或对读者的叙事期待
  | 'pattern';              // 模式：重复出现的规律等待最终解释

// 线索状态
type ThreadStatus =
  // 回溯型路径
  | 'UNFILLED'              // 结果已写，原因待补
  | 'FILLED'                // 原因已补完
  // 渐进型路径
  | 'PLANTED'               // 种子已埋下
  | 'HINTED'                // 再次暗示（可多次，每次追加 Milestone）
  | 'PARTIALLY_REVEALED'    // 部分揭示
  | 'RESOLVED'              // 完全回收/揭示
  // 共享终态
  | 'ABANDONED'             // 作者显式放弃
  | 'OBSOLETE';             // 上游依赖断裂

// 生命周期里程碑
interface ThreadMilestone {
  id: string;
  status: ThreadStatus;
  chapter: number;
  eventId?: string;
  description: string;
  createdAt: string;
}

interface NarrativeThread {
  id: string;               // 'thr_{tag}_{chapter}[_{seq}]'
  type: ThreadType;
  direction: ThreadDirection;
  severity: 'minor' | 'major' | 'critical';
  description: string;

  closeCondition: {
    requiredEventType?: string;
    withinChapters?: number;
    customRule?: string;
    minHints?: number;           // 渐进型：至少暗示几次才能揭示
  };

  status: ThreadStatus;
  closedBy: string | null;
  createdAtEvent: string;
  createdAtChapter: number;
  milestones: ThreadMilestone[];
  relatedEntities: string[];    // 关联实体 ID 列表，见下方说明
  upstreamFactIds: string[];    // 上游依赖的 Fact ID 列表，用于 OBSOLETE 检测（见下方说明）
  tags?: string[];              // 自由标签（如 ['side_arc', 'humor']）
  arcTag?: string;              // 关联的作用域名称（可选，见 3.4.1），用于主线写作时排除副本线索
}

// relatedEntities 填充规则（按优先级）：
//   1. Rule Engine 自动推断：生成 NarrativeThread 时，从触发事件的 params.subject
//      及 FactChange 中引用的实体 ID 自动提取
//   2. LLM 指定：propose_event 时 LLM 在 ThreadMetadata 中附带相关实体
//   3. 作者补充：通过 resolve_thread 或手动编辑追加
//   用途：语义检索时按实体过滤未关闭线索（RelevantFactRetriever Step 3）
//
// upstreamFactIds 填充规则：
//   在 NarrativeThread 被创建时（Rule Engine 生成或 LLM 显式指定），
//   记录触发此线索的核心 Fact ID。例如：
//   - causal_gap 线索：记录产生因果缺口的那条 Fact（先写了结果）
//   - rule_violation 线索：记录违反规则的那条 Fact
//   - foreshadowing 线索：记录伏笔种子 Fact
//   当这些上游 Fact 被 Retcon 标记为 contested/orphaned 时，
//   commit_retcon Phase B 中扫描所有未关闭 Thread，比对 upstreamFactIds，
//   将受影响的 Thread 状态迁移为 OBSOLETE。
//   用途：实现 §3.5 状态机中 "任意 → OBSOLETE" 的自动触发路径。
```

**合法状态转换**：

```
回溯型（direction = 'retroactive'）：
  UNFILLED → FILLED       条件满足（自动或显式关闭）
  UNFILLED → ABANDONED    作者显式放弃
  FILLED   → UNFILLED     关闭事件被 Retcon 撤回
  任意     → OBSOLETE     上游 Fact 被标记 contested/orphaned

渐进型（direction = 'progressive'）：
  PLANTED → HINTED              再次暗示（可多次）
  PLANTED → HINTED              再次暗示（可多次）
  PLANTED → PARTIALLY_REVEALED  跳过暗示直接部分揭示
  PLANTED → RESOLVED            直接回收（短伏笔）
  HINTED  → HINTED              继续暗示（诡秘之主式反复铺垫）
  HINTED  → PARTIALLY_REVEALED  部分揭示
  HINTED  → RESOLVED            完全回收
  PARTIALLY_REVEALED → RESOLVED 完全揭示
  任意    → ABANDONED           作者显式放弃
  任意    → OBSOLETE            上游依赖断裂
```

**OBSOLETE 自动触发机制**：当 Retcon 将某条 Fact 标记为 contested/orphaned 时，`commit_retcon` Phase B 扫描所有未关闭 Thread（status ∈ {UNFILLED, PLANTED, HINTED, PARTIALLY_REVEALED}），检查其 `upstreamFactIds` 是否包含被影响的 Fact。匹配的 Thread 自动迁移至 OBSOLETE 状态，并记录 Milestone 注明触发事件和被断裂的上游 Fact ID。此机制保证线索不会指向已失效的世界状态。

**ID 生成**：`thr_{tag}_{chapter}[_{seq}]`，如 `thr_miracle_50`（绝脉突破代价）、`thr_dreamdoor_12`（梦中的门伏笔）。原 `cst_` 前缀保留为向后兼容别名。`ThreadStore` 实现层提供 `normalizeThreadId(id)` 函数将 `cst_xxx` → `thr_xxx` 转换，所有新数据只使用 `thr_` 前缀。

> **简化**：回溯型完整状态机 + 渐进型 PLANTED→HINTED→RESOLVED 三步。PARTIALLY_REVEALED 和多次 HINTED 的 Milestone 追踪推迟到后续迭代。ThreadMilestone 数组始终写入，为后续迭代预留数据。

**Thread 单向依赖不变式**：NarrativeThread 是 Fact 的观察层，不是世界状态的来源。

- ✅ 允许：Fact/Event → Thread（规则检查、伏笔回收、认知失调均可生成 Thread）
- ❌ 禁止：Thread → Fact（ThreadResolver 不得创建、修改、删除 Fact）
- ❌ 禁止：Thread → Knowledge（Thread 不得改变角色的认知状态）

Thread 是只读标记——它记录"这里有未兑现的叙事债务"，但不执行任何状态变更。核销 Thread 的唯一方式是通过新的 propose_event（由作者/LLM 驱动），Thread 本身不具备任何主动行为。

#### 3.5.4 NarrativeThread 开发守则

**I-9 不变式（Thread Never Has Causal Power）的开发约束**：

Thread 对 Fact / Knowledge / Event 的依赖方向是单向的——Thread 只被读取和修改，不反作用于世界状态。开发者必须遵守以下规则：

**禁止的操作**：
- ThreadResolver 不得调用 `FactStore.applyFactGroup()`（Thread 不能创建/修改 Fact）
- ThreadResolver 不得调用 `KnowledgeStore` 的写入方法（Thread 不能修改认知状态）
- Rule Engine 不得基于 Thread 状态创建新 Thread（避免循环线索生成）
- Tool 的实现不得让 Thread 的 `status` 作为 FactChange 的前置条件

**允许的依赖方向**：
- `Fact / Event → Thread`：规则检查生成 Thread、事件关闭 Thread、Fact Retcon 导致 Thread → OBSOLETE
- `Thread → LLM 提示`：未关闭 Thread 列表注入 LLM 上下文，帮助作者规划叙事
- `Thread → UI 展示`：Thread 状态和里程碑在界面上展示

**关闭流程的开发约束**：
```
所有 Thread 关闭路径：
1. 自动关闭：Event → isThreadClosable → 标记 FILLED
2. 显式关闭：thread_resolutions → 标记 FILLED
3. 独立工具：resolve_thread → 标记 FILLED
4. OBSOLETE：Fact Retcon → upstreamFactIds 匹配 → 标记 OBSOLETE

所有路径都是：Event（或作者操作）→ Thread 状态变化
不存在：Thread → 新事件 → Fact 的路径
```

### 3.6 Knowledge（知识可见性）

建模角色/组织对 Fact 的认知状态——“谁在什么时刻知道了什么，确信度如何”。

**这是诡秘之主级别复杂度的核心需求**：同一事件对不同角色有不同的可见性。克莱恩第 1 章就知道自己是愚者，邓恩到第 380 章才发现，读者到第 200 章才确认。Knowledge 层补上了信息不对称这个维度。

**与 Fact 的关系**：Knowledge 不是对 Fact 的修改，而是 Fact 之上的认知层。一条 Fact 可以被 0 个实体知晓（只有读者/作者知道的秘密），也可以被所有实体知晓（公开信息）。Knowledge 不改变 Fact 的 certainty，它记录的是“谁知道”而不是“是不是真的”。



**确信度（confidence）的叙事意义**：

| 确信度 | 叙事含义 | 示例 |
|--------|---------|------|
| 1.0 | 完全确信 | 克莱恩知道自己就是愚者（self_action） |
| 0.7-0.9 | 高度确信 | 邓恩通过调查确信克莱恩有问题（inferred） |
| 0.4-0.6 | 半信半疑 | 克莱恩猜到因斯可能是幕后黑手（inferred） |
| 0.1-0.3 | 将信将疑 | 罗塞尔日记中的模糊暗示（rumor） |
| 无记录 | 完全不知 | 邓恩不知道克莱恩是愚者 |

**Knowledge 的创建路径**：

| 路径 | 触发时机 | 适用场景 | 优先级 |
|------|---------|---------|--------|
| 事件主体自动 | commit_event 时，params.subject 自动获得 Knowledge（source=self_action, confidence=1.0） | 任何事件提交 | 最高（确定性规则） |
| Propagation Rules | commit_event 沙盒推演中，规则引擎自动推导（同场景目击、组织广播等） | 多角色同时在场的公开事件 | 中（自动推导） |
| LLM 显式广播 | LLM 通过 propose_event 的 knowledge_broadcast 参数声明感知范围 | 塔罗会等已知多人在场场景 | 中（LLM 判断） |
| LLM 细粒度推断 | LLM 通过 propose_event 的 knowledge_hints 参数逐条指定 | 特定角色的非典型知晓方式 | 中高（覆盖自动推导） |
| 作者订正 | 作者通过 LLM 对话补充或修正 Knowledge 条目 | LLM 遗漏或推断错误 | 最高（人工裁决） |

**合并优先级（同一 entityId + factId 去重时）**：`knowledge_hints` > `knowledge_broadcast` > `Propagation Rules` > `subject_auto`

**去重策略**：Knowledge 表不使用联合唯一约束（`entity_id + fact_id`）。同一实体对同一 Fact 可以存在多条 Knowledge 记录（分别对应不同时间点的认知状态变迁，如从 rumor → confirmed 的 seal 操作）。当前认知状态通过查询 `WHERE entity_id = ? AND fact_id = ? ORDER BY known_since DESC, rowid DESC LIMIT 1` 获取。

commit_event 中的合并逻辑：
1. 收集所有来源（subject_auto、Propagation Rules、knowledge_broadcast、knowledge_hints）生成的 ProposedKnowledge
2. 按 (entityId, factId) 分组，组内按合并优先级保留最高优先级的那一条
3. 显式操作（knowledge_changes 中的 seal/implant/decay）不参与合并——它们总是被写入，因为它们是对已有记录的状态变更
4. 最终全部写入 Knowledge 表，检索时依靠 rowid tiebreaker 取最新记录

> **关键约束**：Knowledge 的 entityId 必须引用已注册实体，且该实体的 EntityKind 应为 entity、faction 等具备认知能力的类型。information 和 foreshadowing 类型的实体不能作为 Knowledge 的主体——它们没有”知道”的能力。

```typescript
// 知识来源：角色获取这条知识的途径
// 分为三个梯队，对应不同的推导时机和确定性
type KnowledgeSource =
  // ---- 第一梯队：写入时自动推导（Propagation Rules 产出，见 5.6）----
  | 'self_action'      // 亲身经历：事件主体自动知晓（confidence 通常为 1.0）
  | 'witnessed'        // 直接目击：与事件主体同场景的实体自动知晓
  | 'faction_share'    // 组织共享：事件属于某阵营公开秘密，向成员广播

  // ---- 第二梯队：需要独立事件触发 ----
  | 'informed'         // 被告知：通过对话、信件、报告等主动传递
  | 'intelligence'     // 情报获取：通过占卜、监控、间谍等手段获取

  // ---- 第三梯队：间接/不确定 ----
  | 'inferred'         // 推断：角色根据已知信息逻辑推理得出
  | 'rumor'            // 传闻：通过非正式渠道获得的二手信息
  | 'revelation'       // 启示：通过超自然手段获得（奇幻/仙侠设定）

  // ---- 第四梯队：认知层事件驱动（§3.6 状态变迁机制）----
  | 'memory_seal'      // 记忆封印：confidence 被压至 0.0，Knowledge 仍在但不可被检索命中
  | 'memory_decay'     // 记忆衰退：confidence 按时间衰减公式降低
  | 'memory_restore'   // 记忆恢复：从封印状态恢复，confidence 回到封印前的值
  | 'implanted';       // 记忆植入：confidence 正常但内容可能为假（记录来源供 LLM 判断）

// Knowledge：角色对某条 Fact 的认知记录
interface Knowledge {
  id: string;               // 'kno_{knower}_{factSeq}'，如 'kno_claine_fct_001'
  factId: string;           // 被知晓的 Fact ID
  entityId: string;         // 知晓者实体 ID（如 'ent_claine'）
  knownSince: number;       // 从哪个章节开始知道（支持小数编号，见 §3.4）
  source: KnowledgeSource;  // 知识来源
  confidence: number;       // 确信度 0.0-1.0
  previousConfidence?: number; // seal 操作前的 confidence 值，用于 restore 恢复到封印前状态
                                // （见 §3.6 Knowledge 状态变迁：记忆封印/恢复流程）
  updatedAtEvent?: string;  // 最后更新此知识的事件 ID
}

// Knowledge ID 生成规则：
//   kno_{knower}_{factSeq}
//   knower 为知晓者实体 ID 去掉 ent_ 前缀的部分
//   factSeq 为被知晓 Fact 的 ID 去掉 fct_ 前缀的部分
//   示例：kno_claine_tribulation_50_01（克莱恩知道渡劫50事件产生的第1条 Fact）
```

**双流写入（Dual Stream Write）**：commit_event 的写入流包含两个并行事件流——

| 事件流 | 目标存储 | 写入内容 | 性质 |
|--------|---------|---------|------|
| 客观事实流 | FactStore（facts 表） | FactGroup（客观事实） | "世界是什么" |
| 认知事件流 | KnowledgeStore（knowledge 表） | Knowledge[]（主观认知） | "谁知道世界是什么" |

每个 NarrativeEvent 同时改变客观世界状态和角色的认知状态。两条事件流在同一个 SQLite 事务中原子写入——世界状态和认知状态永远不会出现不一致。详见 10.1 写入流的双流分支。

> **术语说明**：Knowledge 曾被称为"Fact 的投影"，但自引入 seal/restore/decay 状态变迁后，Knowledge 已成为独立的 Event Sourcing 对象，拥有不可从 Fact 重算的认知状态历史。因此"投影"一词不再准确——Knowledge 是与 Fact 流并行的认知事件流，而非 Fact 的派生视图。参见 §11.6 "Fact First 恢复不变式"的修正说明。

#### Knowledge 状态变迁：遗忘、封印与搜魂

Knowledge 遵循与 Fact 相同的 Event Sourcing 原则——不能删除，只能通过新事件覆盖或封印。这是修仙/玄幻/奇幻题材中极高频的叙事需求（搜魂、洗去记忆、喝孟婆汤、时间流逝导致记忆模糊）。

**Knowledge 的状态变迁由事件驱动，不是手动修改**：

| 事件类型 | 对 Knowledge 的影响 | confidence 变化 | 示例 |
|---------|---------------------|-----------------|------|
| 正常获取 | 新增 Knowledge 条目 | 0.0 → 0.1~1.0 | 角色亲眼目睹事件 |
| 记忆模糊 | 新增 Knowledge 条目，source 标记为 `memory_decay`，confidence 按衰减公式降低 | 0.8 → 0.3 | 十年后角色对某事件的记忆模糊 |
| 记忆封印 | 新增 Knowledge 条目，confidence=0.0，source=`memory_seal` | → 0.0 | 仙人封印凡人关于仙界的记忆 |
| 记忆恢复 | 新增 Knowledge 条目，恢复到封印前的 confidence | 0.0 → 原值 | 封印被解除，记忆恢复 |
| 搜魂读取 | 施法者批量获得被搜魂者的 Knowledge，source=`intelligence`，confidence 按来源衰减 | 按被搜魂者的 confidence × 0.9 | 反派对主角施展搜魂术 |
| 记忆篡改 | 新增 Knowledge 条目，confidence 不变但 source 变为 `implanted` | 不变（但知识内容可能是假的） | 敌人植入虚假记忆 |

```typescript
// Knowledge 状态变迁接口（由 propose_event 中的特殊 fact_changes 驱动）
// LLM 不直接操作 Knowledge 表，而是通过事件间接触发

interface KnowledgeChangeInput {
  op: 'seal' | 'restore' | 'decay' | 'soul_read' | 'implant';
  target_entity_id: string;       // 被操作的目标实体（如被搜魂者）
  fact_id_scope: 'all' | 'by_predicate' | 'by_time_range' | 'explicit';
  // ⚠ L2 扩展预留：当前不支持 'by_target_entity' scope（封印某实体对另一实体的所有认知）。
  // 此场景可通过 by_predicate + 先查询目标实体相关 predicate 的组合方式实现。
  // 如后续版本需求增加，可扩展为 'by_target_entity' scope + target_entity_id 参数。
  fact_ids?: string[];            // scope = explicit 时指定
  predicates?: string[];          // scope = by_predicate 时指定（如只封印关于"仙界"的知识）
  time_range?: { from: number; to: number }; // scope = by_time_range 时指定
  source_entity_id?: string;      // op = soul_read 时：施法者（获得知识的一方）
  implanted_confidence?: number;  // op = implant 时：植入的确信度
}

// Core 内部的 Knowledge 状态变迁处理（在 commit_event 中执行）
// 核心原则：永远不 DELETE knowledge 表中的记录，只 INSERT 新记录

// seal 操作：为 target_entity 匹配到的每条 Knowledge 插入一条新记录
//   新记录：confidence=0.0, source='memory_seal', updatedAtEvent=<当前事件>
//   原记录不受影响（Event Sourcing 不可变）
//   检索时：对同一 factId + entityId，按 knownSince DESC, rowid DESC 取最新一条
//   （rowid 作为同章节内的确定性 tiebreaker，见下方"同章节覆盖竞态"说明）
//   ⚠ 性能优化：seal 时将封印前的 confidence 值存入 Knowledge 记录的扩展字段
//   previous_confidence（JSON 字段，或在 knowledge 表中添加 previous_confidence 列），
//   避免 restore 时回溯 knowledge 表历史找封印前的 confidence。
//   批量 seal/restore（scope='all'）时每条 Knowledge 不需要单独回溯查询。

// restore 操作：查找该实体最近一条 source='memory_seal' 的记录，
//   直接读取其中存储的 previous_confidence 值（无需回溯 knowledge 表历史）
//   插入新记录：confidence=previous_confidence, source='memory_restore'

// soul_read 操作：将 target_entity 的所有活跃 Knowledge（最新记录 confidence > 0）
//   批量复制给 source_entity，新记录 source='intelligence',
//   confidence = 原confidence × 0.9（搜魂信息不完全可靠）
//   ⚠ 过滤规则：只复制指向 canonical Fact 的 Knowledge。
//   跳过其对应 Fact 的 certainty 为 contested 或 orphaned 的 Knowledge——
//   复制指向已废弃事实的认知在语义上无意义（施法者从未经历过导致 Fact contested 的事件，
//   复制后的 Knowledge 对施法者来说是无根之木）。

// decay 操作：按时间衰减公式重新计算 confidence
//   decayed = original_confidence × exp(-λ × elapsed_chapters)
//   其中 λ 由 World Package 配置（不同题材的记忆衰减速率不同）
//   插入新记录：confidence=decayed, source='memory_decay'
```

**检索时的 Knowledge 状态叠加规则**：

`RelevantFactRetriever` 在知识感知过滤（§7.2.3 Step 5）时，对同一 `entityId + factId` 组合，按 `knownSince DESC, rowid DESC` 取**最新一条** Knowledge 记录的 confidence。这意味着：

- 如果最近一条是 `memory_seal`（confidence=0.0），该角色"不知道"这件事——检索时被过滤
- 如果最近一条是 `memory_restore`（confidence=恢复值），该角色"重新知道"了——检索时正常命中
- 如果历史上有多次 seal/restore 交替，以时间线上最近的一次为准

**同章节覆盖竞态（rowid tiebreaker）**：

当同一事件内对同一 `(entityId, FactId)` 同时产生自动推导 Knowledge（如 `witness_propagation`）和显式认知操作 Knowledge（如 `memory_seal` / `implant`）时，两者的 `known_since` 相同（同一章节号）。此时仅靠 `known_since DESC` 排序结果不确定——SQLite 在相同值时返回顺序取决于物理存储。

解决方案：`rowid DESC` 作为第二排序键。SQLite 的 `rowid` 是自增整数，后插入的行 `rowid` 更大。只要保证显式认知操作（seal/implant/decay）的写入晚于自动推导（propagation/broadcast）的写入，seal/implant 记录的 `rowid` 永远更高，确保"主动的认知篡改"覆盖"被动的环境感知"。

```sql
-- Knowledge "取最新" 查询模板（含 rowid tiebreaker）
SELECT * FROM knowledge
WHERE entity_id = :entityId AND fact_id = :factId AND known_since <= :atChapter
ORDER BY known_since DESC, rowid DESC
LIMIT 1;
```

**为什么不用 valid_to 失效机制**：Knowledge 的封印/恢复与 Fact 的失效不同。Fact 失效意味着"这个事实不再是世界状态"，是不可逆的时序推进。Knowledge 封印意味着"这个角色暂时不知道"，是可逆的认知状态。如果用 valid_to 失效来处理封印，恢复时就需要"复活"已失效的记录，违反 Event Sourcing 的不可变性。因此 Knowledge 的状态叠加采用"最新记录覆盖"而非"失效-新建"模式。

#### Knowledge 的硬边界

Knowledge 不是 Fact 的投影——它拥有独立的状态变迁生命周期（seal / restore / decay / soul_read / implant），这些状态是事件驱动的认知历史，不可从 Fact 重算。Knowledge 是与 Fact 流并行的认知事件流，回答一个问题："实体 X 是否接触过 Fact Y，通过什么渠道，确信度多少？"

它不回答：
- "实体 X 是否真心相信 Fact Y？" → 这是 Belief，Core 不管（原则九）
- "实体 X 认为实体 Y 怎么看待 Fact Z？" → 这是 Theory of Mind，Core 不管（原则九）
- "实体 X 接触 Fact Y 后产生了什么心理变化？" → 这是 Emotion，Core 不管（原则九）

memory_seal / memory_decay / soul_read 等操作不违反此边界——它们操作的是"信息接触渠道"（是否接触、确信度多少），而不是"内心世界"（是否相信、有何感受）。

#### 3.6.1 Knowledge 概念边界开发守则

**Knowledge 的双面性规定**：

Knowledge 是独立的认知事件流，不是 Fact 的投影。它具有不可变的"事件记录"和可变的"当前状态"两个层面，开发者必须严格区分：

**不可变层（认知事件流）**：
- knowledge 表中的每一条记录都是不可变的事件
- 永远不 DELETE knowledge 表中的记录
- 永远不 UPDATE 已有记录
- 认知状态变化通过 INSERT 新记录实现

**可变层（当前认知状态）**：
- 查询时通过 `ORDER BY known_since DESC, rowid DESC LIMIT 1` 获取当前状态
- 当前状态是"最新事件"的自然结果，不是独立维护的状态字段
- `rowid DESC` 作为同章节内的确定性 tiebreaker，保证显式认知操作覆盖自动推导

**seal/restore 与 Event Sourcing 的一致性**：
- seal 操作：INSERT 一条 `confidence=0.0, source='memory_seal'` 的新记录，同时将封印前的 confidence 值存入 `previous_confidence` 字段
- restore 操作：读取 `previous_confidence`，INSERT 一条 `confidence=原值, source='memory_restore'` 的新记录
- 部分失败处理：seal/restore 操作在 SQLite 事务内执行，单条失败则整体回滚，不存在"部分成功"的中间状态
- **开发者约束**：禁止在代码中出现 `UPDATE knowledge SET confidence = ...` 的语句，所有认知状态变更必须通过 INSERT 新记录实现

**与 Fact 的关系界定**：
- Knowledge 引用 Fact（通过 factId），但不改变 Fact 的 certainty
- Knowledge 的 `confidence` 描述的是"信息接触渠道的可信度"，不是"角色是否真心相信"
- Knowledge 不回答"实体 X 是否真心相信 Fact Y"——这是 Belief，Core 不管（原则九）
- 禁止嵌套认知：不存在"实体 X 认为实体 Y 怎么看待 Fact Z"的 Knowledge 记录

### 3.7 EventConsequence（事件后果）

Rule Engine 在沙盒中推演一个 Event 后产出的完整结果集。

```typescript
interface EventConsequence {
  generatedFacts: Fact[];           // 规则推导出的新事实（certainty = 'potential'）
  generatedThreads: NarrativeThread[];  // 违规/伏笔产生的叙事线索
  proposedKnowledge: ProposedKnowledge[];  // 知识传播规则建议的 Knowledge 条目（见 5.6）
  warnings: string[];               // 给 LLM 的警告信息（非阻塞）
}
```

### 3.8 ProposalResult（提案预演结果）

Core 对 LLM 提议的反馈，包含是否可安全提交的判定。

```typescript
interface ProposalResult {
  proposalId: string;
  expectedStateVersion: number;        // propose_event 读取到的 project_state.state_version
  isSafeToCommit: boolean;
  consequences: EventConsequence;
  simulationReportMarkdown: string;  // FactRenderer 渲染的审计报告
}
```

> **版本校验**：`expectedStateVersion` 在 `propose_event` 的 Phase A 开始时读取，并随 Proposal 存入 `ProposalStore`。`commit_event(proposal_id)` 不要求 LLM 再传版本号，而是从 Proposal 中取出该值；Phase B 提交时必须执行 `WHERE state_version = expectedStateVersion` 的条件更新。如果更新行数为 0，说明 proposal 基于旧世界状态，提交应拒绝并要求重新 `propose_event`。

---

### 3.9 World Package：世界观配置包

Core 引擎是题材无关的通用框架——它不知道什么是"修炼境界"、"魔法等级"或"序列途径"。所有题材特定的规则、谓词映射、实体模板都通过 **World Package（世界观配置包）** 注入引擎。

**设计原则**：Core 只理解 Fact、Rule、Scope、Knowledge 这四个抽象概念。World Package 负责"把这些抽象概念翻译成具体世界的语言"。

```typescript
// World Package：一个完整的世界观配置
interface WorldPackage {
  id: string;                    // 如 'xianxia_cultivation' | 'lotm_sequences' | 'modern_fantasy'
  name: string;                  // 如 '仙侠修炼体系' | '诡秘序列体系' | '现代奇幻'
  version: string;

  // 谓词注册表：定义这个世界观中合法的 predicate 及其中文标签
  predicates: PredicateDefinition[];

  // 规则集：这个世界观的状态转换规则、推理规则、约束规则、传播规则
  rules: RuleSet;

  // 谓词→关系语义映射：覆盖默认的 PREDICATE_RELATION_MAP
  predicateRelationMap: Record<string, RelationKind>;

  // 谓词→中文映射：覆盖默认的 PREDICATE_ZH_MAP
  predicateZhMap: Record<string, string>;

  // 实体模板：这个世界观中常见的实体类型预设
  entityTemplates?: EntityTemplate[];

  // 作用域预设：这个世界观中常见的作用域配置
  scopePresets?: ContextScopePreset[];

  // 谓词别名：旧名称 → 当前推荐名称。只影响新写入和渲染提示，不物理改写历史 Fact。
  predicateAliases?: Record<string, string>;
}

// 谓词定义：注册一个合法的 predicate
interface PredicateDefinition {
  name: string;                  // 谓词名，如 'realm' | 'sequence' | 'spell_slot'
  displayName: string;           // 中文名，如 '修炼境界' | '序列' | '法术位'
  valueType: 'scalar' | 'entity_ref' | 'enum';
  enumValues?: string[];         // valueType = 'enum' 时的合法值列表
  sequenceOrder?: string[];      // 可选：有序枚举的递进序列（如 ['炼气','筑基','结丹','元婴']）
                                 // 当存在时，Rule Engine 可通过 snapshot_sequence_jump 检查"跳级"违规
                                 // 省略时 enumValues 视为无序集合（如 ['天灵根','异灵根','无']）
  description: string;           // 谓词的语义说明（帮助 LLM 理解）
  relationKind: RelationKind;    // 默认的关系语义类别
  deprecated?: boolean;          // 旧谓词保留解释能力，但不再建议新 Fact 使用
  replacementPredicate?: string; // deprecated 时可选，指向推荐的新谓词
}

// 实体模板：预定义常见实体类型的属性组合
interface EntityTemplate {
  kind: EntityKind;
  name: string;                  // 模板名，如 'character_cultivator' | 'character_beyonder'
  defaultPredicates: string[];   // 此类实体通常有哪些 predicate（帮助 LLM 补全）
  description: string;
}

// 作用域预设：预定义常见的作用域配置
interface ContextScopePreset {
  name: string;                  // 如 'dream' | 'dungeon' | 'legend_world'
  displayName: string;
  defaultExitBehavior: 'suggest_promote' | 'suggest_discard';
  inheritsGlobalRules: boolean;  // 是否继承全局规则
  overrideRules?: RuleSet;       // 覆盖全局规则的规则集
  description: string;
}
```

**World Package 的加载时机**：

| 时机 | 行为 |
|------|------|
| 创建项目时 | 作者指定 `worldType`，系统加载对应的 World Package 作为默认配置 |
| 进入新作用域时 | 可选加载作用域专属的 World Package（如进入传说世界时加载该世界的规则集） |
| 运行时 | Rule Engine、FactEmbedder、FactRenderer 从当前活跃的 World Package 读取配置 |

**World Package 与 Core 的边界**：

```
┌─────────────────────────────────────────────────┐
│                 World Package（可替换）            │
│  谓词注册表 | 规则集 | 映射表 | 实体模板 | 作用域预设 │
├─────────────────────────────────────────────────┤
│                  Core Engine（通用）              │
│  FactStore | RuleEngine | ThreadResolver         │
│  KnowledgeStore | ContextScope | SemanticRetrieval│
│  FactRenderer | Tool Interface                   │
└─────────────────────────────────────────────────┘

同一个 Core Engine，加载不同的 World Package：
  'xianxia_cultivation' → 谓词含 realm/meridian/bloodline，规则含绝脉突破检测
  'lotm_sequences'      → 谓词含 sequence/pathway/acting，规则含序列副作用检测
  'modern_urban'        → 谓词含 job/skill/reputation，规则含身份暴露检测
  'scifi_space'         → 谓词含 tech_level/faction/planet，规则含科技树依赖检测
```

**内置默认 World Package**：Core 随附一个 `generic` 默认包，包含最基础的谓词（status、location、relationship、ability）和通用规则（死亡实体约束、双向关系推理），确保无自定义包时仍可运行。题材特定的 World Package 作为独立配置文件分发，作者也可以从零创建自己的包。

**World Package 不变式**：World Package 是数据，不是代码。

- ✅ 允许声明：谓词、关系映射、规则元数据（trigger/conditions/consequence 描述）、实体模板、分类标签、作用域预设
- ❌ 禁止执行：JavaScript、TypeScript、Lua、Python 或任何可执行代码
- ❌ 禁止运行时自修改：规则不得在运行时修改其他规则或 World Package 配置（见 §5.2 Rule Engine 边界不变式）

**判断标准**：如果 World Package 中的某个条目需要 `function`/`eval`/`execute` 才能工作，它不属于 World Package，应该用 Core 的 TypeScript 脚本规则（第三层，见 H.5）实现。

**谓词不可变性原则（Predicate Immutability）**：

谓词（predicate）是 Fact 的逻辑标识符，一旦有 Fact 使用了某个谓词名，该谓词在 World Package 中不得被删除或重定义。这条原则与 Event Sourcing 的"事件不可变"精神一致——历史 Fact 的解释方式不能因 World Package 版本更迭而断裂。

| 操作 | 允许 | 说明 |
|------|------|------|
| 新增谓词 | ✅ | 随时可以添加新谓词 |
| 标记谓词为 deprecated | ✅ | 旧谓词仍可查询和渲染，只是不再推荐新 Fact 使用 |
| 删除谓词 | ❌ | 已有 Fact 引用的谓词不得删除 |
| 重命名谓词 | ❌ | 会导致历史 Fact 不可解释 |
| 拆分谓词语义 | ⚠️ 仅新增子谓词 | 如 `knows` → 新增 `secretly_knows` / `publicly_knows`，旧 `knows` 保留 |

> **未来风险（V2 架构挑战）**：World Package 的演化比 Fact Schema 演化更危险——Fact 的结构（subject/predicate/value）极其稳定，但谓词的语义解释会随题材包升级而变化。这是 Narrative-OS-Core V2 时期最大的架构问题之一，当前通过"谓词不可变"原则规避，但未来可能需要引入 `FactInterpretationContext`（World Package 版本绑定）来彻底解决。

**谓词别名与弃用策略**：

`predicateAliases` 只用于 LLM 提示、渲染和新写入归一化，不能用于批量改写历史 Fact。示例：`predicateAliases: { "cultivation_level": "realm" }` 表示 LLM 后续应使用 `realm`，但历史中已存在的 `cultivation_level` Fact 仍按原谓词查询和解释。若确需物理迁移历史 Fact，必须走显式 `commit_schema_migration` 事件（V2），生成审计报告并保留旧谓词解释，不允许 World Package 升级时静默 SQL 迁移。


#### 加载管线：从文件系统到运行时

World Package 的运行时数据全部存储在项目 SQLite 数据库的 wp_* 表中（见附录 E.9）。WorldPackageLoader 负责导入/导出和查询：



WorldPackageLoader 的核心职责：
1. **读取**：解析 JSON 格式的 World Package 文件，写入 SQLite 的 wp_* 表
2. **校验**：验证 JSON 格式正确、枚举值不重复、谓词名无冲突
3. **编译**：将导入的声明式 JSON 规则解析为 DeclarativeRule 对象，存入 wp_rules 表（见附录 H）
4. **注入**：将编译后的 WorldPackage 存入 ProjectSession.worldPackage

#### 三层优先级链：包间合并规则

运行时可能有多个 World Package 同时活跃：generic（内置）、topic（题材包）、scope（作用域专属包）。合并规则如下：

**优先级**：

| 配置项 | 合并策略 |
|--------|---------|
| predicates（谓词注册表） | **按名合并**：同名谓词由高优先级覆盖（字段级覆盖，非全量替换）；不同名谓词合并叠加 |
| predicateRelationMap | **按键覆盖**：同名 key 由高优先级决定 |
| predicateZhMap | **按键覆盖**：同上 |
| rules | **全量叠加**：所有包的规则同时生效，但 ConstraintRule 冲突时高优先级包可标记 suppress_rule_id 禁用低优先级包的某条规则 |
| entityTemplates | **按模板名叠加**：同名模板由高优先级覆盖 |
| scopePresets | **按预设名叠加**：同上 |

**禁用规则的机制**：题材包中可以通过  字段声明要禁用的 generic 包规则 ID。例如  中 （如果修仙世界有灵魂出窍等非标死亡机制）。

#### 作用域专属包的加载与卸载

当  中  参数指向一个绑定了 World Package 的作用域时：

- **enter_scope**：加载作用域专属包，按三层优先级合并到当前活跃配置
- **exit_scope**：卸载作用域包，恢复到进入前的配置快照

作用域专属包的绑定来源有两个：
1.  中  非空的预设——进入该作用域时自动加载
2. 作者手动指定——在  事件中声明要加载的 World Package ID

#### scopePresets.overrideRules 的语义

 是**增量覆盖**而非全量替换：
- 新增的规则：直接加入活跃规则集
- 与全局规则同 ID 的规则：覆盖（替换）全局版本
- 未提及的全局规则：继续生效（不受影响）
- 要完全禁用某条全局规则：在 overrideRules 中用  声明

#### 运行时动态扩展

写作过程中，LLM 发现需要新的谓词或规则时：

1. **新增谓词**：通过  工具提议新谓词（name/displayName/valueType/description/relationKind），作者审核后追加到当前 World Package 的 predicates 列表。已有 Fact 不受影响（新谓词对历史数据无意义，只对后续事件有效）
2. **新增规则**：LLM 生成声明式 JSON 规则，作者审核后写入 SQLite 的 wp_rules 表，立即生效。历史事件不回溯检查（规则只约束未来事件）
3. **修改规则**：更新 wp_rules 表中的规则记录。已通过旧规则检查的事件保持不变（Event Sourcing 不可变性），但后续事件使用新规则
4. **热加载**：修改后自动生效（SQLite 表更新即可查询到新数据），不需要额外的热加载步骤。不需要重建向量索引（向量只存 Fact 内容，不含规则信息）

#### World Package 版本升级流程

当 World Package 的 version 字段发生变化（如 xianxia_cultivation 从 1.0 升级到 1.1）：

1. 对比新旧版本的 predicates 列表
2. 新增谓词直接追加；旧谓词只能标记 `deprecated`，不得删除
3. 如存在 `predicateAliases`，只更新 LLM 提示、渲染提示和新写入归一化策略，不改写 `facts.predicate`
4. 重新加载规则集；新规则只约束后续事件
5. 输出升级报告给作者确认（列出新增谓词、弃用谓词、别名映射和可能受影响的历史 Fact 数量）

> **禁止项**：World Package 版本升级不得自动执行 `UPDATE facts SET predicate = ...`。Knowledge 通过 `fact_id` 引用 Fact，不需要因谓词别名而迁移。物理迁移历史 Fact 属于显式 Schema Migration 事件，不属于普通包升级。

#### 实体模板继承机制

EntityTemplate 支持 `extends` 字段实现模板继承。当题材包定义了 `character_cultivator extends character` 时：

```typescript
interface EntityTemplate {
  kind: EntityKind;
  name: string;
  extends?: string;             // 继承的父模板名
  defaultPredicates: string[];  // 自身追加的谓词（父模板的谓词自动继承）
  overridePredicates?: Record<string, Partial<PredicateDefinition>>; // 覆盖父模板中某些谓词的属性
  description: string;
}
```

**合并规则**：`defaultPredicates` = 父模板的 defaultPredicates + 自身的 defaultPredicates（去重）。当 LLM 在 propose_event 中创建新角色时，匹配"最具体的模板"——有 extends 链的子模板优先于 generic 父模板。

示例：`character_cultivator extends character` → 创建修仙角色时自动补全 [status, location, relationship, realm, meridian, lifespan_remaining]。

#### 多包并存与命名空间隔离

当一部小说涉及多个题材（如修仙角色穿越到科幻世界），通过 ContextScope 绑定不同的 World Package：

- 修仙世界（scope: xianxia_world）→ 活跃包: xianxia_cultivation
- 科幻世界（scope: scifi_world）→ 活跃包: scifi_space
- 角色穿越时：exit_scope(xianxia_world) + enter_scope(scifi_world)，活跃包自动切换

**谓词不跨作用域共享**：在 xianxia_world 中 assert 的 `realm=元婴期`，在 scifi_world 中不可见（ContextScope 的遮蔽机制）。但角色的 `status=alive` 在两个作用域中都可见（因为 status 属于 generic 包，generic 包在所有作用域中始终活跃）。

**命名空间冲突解决**：如果两个包都定义了同名但语义不同的谓词（如 xianxia 的 `rank` = 修炼排名 vs scifi 的 `rank` = 军衔），通过作用域隔离自然解决——同一时刻只有一个包的 `rank` 活跃。

#### LLM 生成新包时的 generic 上下文

当作者描述的世界没有现成 World Package 时，LLM 需要从零生成。生成时必须遵守以下约束：

1. 先读取 generic 包的 predicates 列表（status, location, relationship, ability, ...）
2. 只追加 generic 中不存在的谓词，不重复定义
3. 新谓词的 relationKind 不能与 generic 冲突（如同名谓词不同 relationKind → 报错）
4. 生成的规则中引用 generic 谓词时使用 generic 的定义（如 constraint_dead_entity_action 不需要在新包中重复定义）

LLM 收到的 system prompt 注入格式：

```
你要为作者创建一个新的 World Package。
以下是 generic 包中已有的谓词（不需要重复定义）：
- status（存活状态）, location（所在位置）, relationship（关系）, ability（能力）

请只为这个题材新增 generic 中不存在的谓词和规则。
```

#### 运行时演化回溯策略

写作过程中修改 World Package 后，对历史数据的不同处理策略：

| 修改类型 | 历史数据处理 | 理由 |
|---------|------------|------|
| 新增谓词 | 不回溯，只对后续事件生效 | 历史事件发生时此谓词不存在，回填没有意义 |
| 新增规则 | 不回溯，只检查后续事件 | Event Sourcing 不可变性——已提交事件的后果不可追溯修改 |
| 修改规则条件 | 不回溯，但输出"差异报告" | 作者可能想知道"如果这条规则一直存在，会有多少条线索被触发" |
| 删除规则 | 已触发的线索保留（历史事实） | 已生成的 NarrativeThread 是历史承诺，不应被规则删除而消失 |
| 重命名谓词 | 不物理重命名；旧谓词 deprecated + predicateAliases 指向新谓词 | 历史 Fact 的 predicate 是不可变逻辑标识，重命名会破坏 Event Sourcing 可解释性 |

#### FactStore 与 World Package 的校验交互

FactStore 在 assert 时需要 World Package 的 predicates 进行校验，这是 World Package 最关键的消费者之一：

```typescript
// FactStore.assert() 内部的 World Package 校验流程
assert(fact: Omit<Fact, 'id' | 'embeddingText'>): Fact {
  // 1. 谓词存在性校验
  const predDef = this.worldPackage.predicates.find(p => p.name === fact.predicate);
  if (!predDef) {
    throw new ToolError(`UNKNOWN_PREDICATE: "${fact.predicate}" 不在当前 World Package 的谓词注册表中`);
  }

  // 2. 值类型校验
  if (predDef.valueType === 'enum' && predDef.enumValues) {
    if (!predDef.enumValues.includes(String(fact.value))) {
      throw new ToolError(`INVALID_ENUM_VALUE: "${fact.value}" 不在 ${fact.predicate} 的合法值列表中`);
    }
  }
  if (predDef.valueType === 'entity_ref') {
    if (typeof fact.value !== 'object' || (fact.value as EntityRef).type !== 'entity_ref') {
      throw new ToolError(`TYPE_MISMATCH: ${fact.predicate} 的值必须是 EntityRef`);
    }
  }

  // 3. relationKind 自动填充（如果 FactChangeInput 未提供）
  // 见审查修复 #4

  // 4. 写入 + 向量同步
  // ...
}
```

**校验可降级**：在沙盒推演（propose_event）阶段，未知谓词不直接 reject，而是生成一条 NarrativeThread(type=logic_conflict, severity=info) 提醒"这个谓词不在当前注册表中，建议注册"。只有 commit_event 时才严格执行校验。这给作者留了"先写后补"的灵活空间。

#### FactRenderer 与 World Package 的渲染交互

FactRenderer 将 Fact 渲染为人类可读的 Markdown 实体档案。World Package 提供渲染所需的翻译表：

```typescript
// FactRenderer 渲染一条 Fact 时的 World Package 查询
renderFact(fact: Fact): string {
  const predDef = this.worldPackage.predicates.find(p => p.name === fact.predicate);
  const displayName = predDef?.displayName ?? fact.predicate; // 优先使用中文名
  const zhMap = this.worldPackage.predicateZhMap[fact.predicate];
  const label = zhMap ?? displayName;

  // 渲染值
  let valueStr: string;
  if (typeof fact.value === 'object' && (fact.value as EntityRef).type === 'entity_ref') {
    valueStr = `[${(fact.value as EntityRef).entityId}]`; // 实体引用渲染为链接
  } else {
    valueStr = String(fact.value);
  }

  return `- **${label}**: ${valueStr}（第${fact.validFrom}章生效）`;
}
```

渲染示例（修仙角色韩立）：

```
=== 韩立 (ent_hanli) ===
- **修炼境界**: 元婴期（第320章生效）
- **经脉状态**: normal（第150章修复后生效）
- **所在位置**: [ent_luanxingu]（第500章生效）
- **存活状态**: alive（第1章生效）
- **剩余寿元**: 850（第320章生效）
```

如果谓词不在 World Package 中（运行时动态扩展的新谓词），降级显示原始英文名。

#### Embedder 与 World Package 的向量化交互

FactEmbedder 生成 embeddingText 时，利用 World Package 的 PredicateDefinition.description 增强语义表达：

```typescript
// embeddingText 生成策略
generateEmbeddingText(fact: Fact, worldPackage: WorldPackage): string {
  const predDef = worldPackage.predicates.find(p => p.name === fact.predicate);
  const displayName = predDef?.displayName ?? fact.predicate;
  const description = predDef?.description ?? '';

  // 组合策略：中文名 + 描述 + 实体名 + 值
  // 例："修炼境界（角色的修炼境界等级）韩立 元婴期"
  const parts = [
    displayName,
    description ? `（${description}）` : '',
    fact.subject.replace('ent_', ''),
    String(fact.value)
  ].filter(Boolean);

  return parts.join(' ');
}
```

**为什么用 description 增强**：纯 "realm=元婴期" 的语义对向量模型不友好（realm 是英文缩写，元婴期是中文专有名词）。加上 "修炼境界（角色的修炼境界等级）韩立 元婴期" 后，向量模型可以建立 "修炼境界" 和 "元婴期" 之间的语义关联，使得搜索 "主角当前修为" 时能命中这条 Fact。

#### 谁配置 World Package——四层来源模型

World Package 的配置不是单一角色的责任，而是由系统、作者、LLM、运行时四个来源逐层叠加：

| 层级 | 谁来做 | 做什么 | 作者感知 |
|------|--------|--------|---------|
| **第一层：系统预置** | Core 内置 | 内置热门题材包（xianxia_cultivation / lotm_sequences / western_fantasy / modern_urban / scifi_space / game_esports），以及兜底的 generic 通用包 | 零难度，创建项目时选一个 |
| **第二层：作者自定义** | 作者 | 在预置包基础上微调：增删谓词、修改规则、自定义实体模板和作用域预设 | 改配置文件（JSON），未来提供可视化 UI |
| **第三层：LLM 辅助生成** | LLM + 作者审核 | 作者用自然语言描述世界规则，LLM 生成 World Package 草稿（谓词 + 规则 + 模板），作者审核后确认 | 作者描述，LLM 生成 |
| **第四层：运行时动态补充** | LLM 自动检测 + 作者确认 | 写作过程中 LLM 发现新设定不在当前 World Package 中，提示作者注册新谓词/规则 | 自然写作，系统自动捕捉 |

**四层的叠加顺序**：第一层（generic）永远存在 → 第二层（题材包）覆盖/扩展 generic → 第三层（作者自定义 + LLM 生成）覆盖/扩展题材包 → 第四层（运行时补充）追加到当前活跃配置。这与前面"三层优先级链"的合并规则一致。

#### 没有内置模板时的创建流程

并非所有题材都有预置包可用。按匹配程度分三种情况：

**情况 A：有匹配的内置模板**

作者说"我要写修仙" → 系统匹配 `xianxia_cultivation` → 复制模板到项目 SQLite → 作者微调 → 开始写作。

这是最简单的路径，作者只需要选一个模板，然后根据自己小说的独特设定做少量修改。例如：
- "我的修仙世界没有灵根，靠觉醒血脉" → 删掉灵根相关谓词和规则，新增血脉相关规则
- "我的秘境出来后所有东西都保留" → 把 scopePresets 中 `dungeon` 的 `defaultExitBehavior` 改为 `suggest_promote`

**情况 B：没有完全匹配的模板（混合/冷门题材）**

作者说"我要写蒸汽朋克+克苏鲁+修仙的混合题材" → 没有任何预置包能完全匹配。

流程：
1. 系统仅加载 generic 包（status, location, relationship, ability 等基础谓词）
2. LLM 分析作者的描述，识别出三个维度的规则需求：
   - 蒸汽朋克维度 → 需要蒸汽技术等级、机械改造程度等谓词
   - 克苏鲁维度 → 需要理智值、SAN 值、古神侵蚀度等谓词
   - 修仙维度 → 需要境界、功法等谓词
3. LLM 从 generic 包开始，逐个追加新谓词和规则，生成完整 World Package 草稿
4. 作者审核每个追加项，修改或删除不合理的部分
5. 确认后保存为该项目的 World Package

**情况 C：完全从零开始**

作者说"我要写一个完全独创的世界，有独特的力量体系" → 没有任何可参考的模板。

流程：
1. 系统加载 generic 包（保证基础功能可用）
2. LLM 通过交互式对话引导作者描述世界规则：
   - "你的世界有哪些核心属性？" → 收集谓词
   - "这些属性之间有什么关系？" → 收集规则
   - "常见的角色类型有哪些？" → 收集实体模板
   - "有没有特殊区域/空间？" → 收集作用域预设
3. LLM 将收集到的信息组装为 World Package JSON 草稿
4. 作者逐项审核确认
5. 确认后保存

**关键约束**（适用于情况 B 和 C）：LLM 生成新谓词时，必须先读取 generic 包的谓词列表，只追加不重复定义；新谓词的 relationKind 不能与 generic 冲突（同名谓词不同 relationKind → 报错拒绝）。详见前文"LLM 生成新包时的 generic 上下文"。

#### 端到端创作流程：作者与系统的完整交互

以下展示一个作者从创建项目到写作第 50 章的完整交互过程，说明四层架构（用户界面 → LLM 智能层 → Tool Interface → Core Engine）如何协作。

> **架构层次对照**：作者只和 LLM 聊天，LLM 通过 Tool Interface 调用 Core Engine。Core Engine 对作者完全透明。

**场景一：创建项目，加载 World Package**

```
作者: "我要写一本修仙小说，主角叫韩立，有灵根体系，
       境界分炼气筑基金丹元婴，世界有人界灵界仙界"

LLM（内部动作）:
  1. 匹配 World Package → xianxia_cultivation
  2. 加载题材包中的境界链谓词和规则
  3. 识别"韩立"是新角色 → 调用 register_entity
  4. 识别"人界灵界仙界" → 匹配 scopePresets

LLM（回复作者）:
  "好的，我已为你创建修仙项目，加载了以下配置：
   - 境界链：炼气→筑基→金丹→元婴→化神→...
   - 核心谓词：灵根、境界、寿元、功法
   - 世界层级：人界→灵界→仙界（三层作用域）
   主角'韩立'已创建。请问韩立是什么灵根？"
```

**场景二：设定角色初始属性**

```
作者: "四属性伪灵根，资质很差"

LLM（内部动作）:
  1. 调用 propose_event:
     fact_changes = [
       {op: "assert", subject: "ent_hanli", predicate: "spirit_root",
        value: "四属性伪灵根"},
       {op: "assert", subject: "ent_hanli", predicate: "realm",
        value: "炼气期一层"}
     ]
  2. Core 沙盒预演 → Rule Engine 检查：
     - "四属性伪灵根" 是否在 enumValues 中？✅
     - 境界"炼气期一层"是否是合法起点？✅
     - 无冲突，is_safe_to_commit = true
  3. LLM 调用 commit_event → 正式写入 SQLite + LanceDB

LLM（回复作者）:
  "已设定：韩立，四属性伪灵根，炼气期一层。
   系统提示：伪灵根修炼速度是天灵根的 1/5，后续突破瓶颈会更难。"
```

**场景三：写作到第 30 章，剧情突破（触发 Rule Engine）**

```
作者（写到第30章时）:
  "韩立在小瓶的帮助下炼制了筑基丹，成功突破到筑基期"

LLM（内部动作）:
  1. 解析这段文字 → 这是一个事件："韩立突破筑基"
  2. 调用 get_context_slice("ent_hanli", chapter=30)
     → 发现当前状态：炼气期十三层
  3. 调用 propose_event:
     fact_changes = [
       {op: "assert", subject: "ent_hanli", predicate: "realm",
        value: "筑基期"}
     ]
  4. Core 沙盒预演 → Rule Engine 执行所有活跃规则：
     - generic: 死亡约束检查 → ✅（韩立 status=alive）
     - xianxia_cultivation: 境界突破条件检查
       → "炼气期十三层" → "筑基期" 是合法相邻境界 ✅
     - xianxia_cultivation: 绝脉突破检测
       → 韩立 meridian=normal ✅
  5. 无警告，is_safe_to_commit = true
  6. commit_event → 写入

LLM（回复作者）:
  "第 30 章：韩立成功突破到筑基期。已记录。"
```

**场景四：引入新设定（运行时动态补充，第四层生效）**

```
作者（写到第50章时）:
  "韩立在海外发现了上古传送阵，通过传送阵到了灵界"

LLM（内部动作）:
  1. 解析 → 这涉及作用域切换：人界 → 灵界
  2. 调用 propose_event:
     type: "enter_scope"
     scopeId: "scope_spirit_world"
  3. 沙盒预演 → 发现 scopePresets 中有 spirit_world 预设
     → exitBehavior = suggest_promote（灵界的东西可以带回人界）
  4. commit_event → 作用域切换生效

  5. 同时检测到新概念"传送阵"：
     → World Package 中没有 teleport_array 相关谓词
     → 这是运行时第四层的场景

LLM（回复作者）:
  "第 50 章：韩立通过传送阵进入灵界。作用域已切换到'灵界'。
   ⚡ 检测到新设定'传送阵'，是否添加到世界规则中？
      - 传送阵属于：空间类设施（space_facility）
      - 建议谓词：teleport_array，值类型 entity_ref
   请确认或修改。"

作者: "确认，传送阵只能连接同源阵法，不能跨世界"

LLM（内部动作）:
  1. 新增谓词 teleport_array → 写入 wp_predicates 表
  2. 生成新规则：
     {
       id: "rule_teleport_same_origin",
       type: "ConstraintRule",
       description: "传送阵只能连接同源阵法，不能跨世界传送"
       // ... 声明式格式
     }
  3. 写入 wp_rules 表 → 立即生效
  4. 后续所有涉及传送阵的事件都会受此规则约束

LLM（回复作者）:
  "已添加：
   - 谓词：传送阵（teleport_array，空间设施引用）
   - 规则：传送阵同源约束（跨世界传送将被检测为违规）
   后续剧情中涉及传送阵的操作将自动校验。"
```

**数据流全程总结**：

```
作者 ──(自然语言)──→ LLM ──(Tool调用)──→ Tool Interface ──(API)──→ Core Engine
                         │                                        │
                    理解意图                                  沙盒预演
                    生成Tool参数                              Rule Engine检查
                    翻译结果                                  SQLite写入
                         │                                  LanceDB同步
                         │                                        │
                    ←────┘         ←──(结构化数据)─────←──────┘
                  回复作者                    返回结果
```

#### World Package 演化开发守则

**谓词不可变性规定**：

已使用的谓词（已被 Fact 引用的谓词）**绝对不可删除或重命名**。这不仅是数据完整性问题，更是 Event Sourcing 的根本约束——历史 Fact 的 predicate 字段是不可变的逻辑标识。

**演化操作的兼容性矩阵**：

| 操作 | 是否允许 | 理由 |
|------|---------|------|
| 新增谓词 | ✅ 允许 | 只影响后续事件，历史不受影响 |
| 新增规则 | ✅ 允许 | 只检查后续事件，已提交事件不可追溯 |
| 修改规则条件 | ✅ 允许（附带差异报告） | 输出"如果规则一直存在会有多少线索被触发"供作者参考 |
| 废弃谓词 | ✅ 允许（deprecated 标记） | 旧谓词保留，新 Fact 禁止使用，历史数据不受影响 |
| 删除未使用的谓词 | ✅ 允许 | 无 Fact 引用，删除安全 |
| 删除已使用的谓词 | ❌ 禁止 | 历史 Fact 的 predicate 字段不可变 |
| 物理重命名谓词 | ❌ 禁止 | 等价于删除旧谓词+新增新谓词，破坏 Event Sourcing |
| 删除规则 | ✅ 允许（已触发的 Thread 保留） | 已生成的 Thread 是历史承诺，不应因规则删除而消失 |

**deprecated 标记的处理流程**：
1. 谓词标记为 `deprecated: true`
2. `FactStore.assert()` 校验时拒绝 `deprecated` 谓词的新 Fact（commit_event 阶段）
3. 沙盒推演（propose_event）阶段生成 info 级别的 Thread："使用了已废弃谓词"
4. 历史 Fact 的渲染和查询不受影响
5. FactRenderer 渲染时在已废弃谓词旁标注 `[已废弃]` 标记

**后向兼容的边界情况**：

- **跨包谓词引用**：如果 World Package A 的规则引用了 generic 包的谓词，generic 包的谓词废弃后，A 包的规则仍然可以正常运行（废弃不影响已有逻辑）
- **Retcon 触及已废弃谓词**：如果 Retcon 修改了含有已废弃谓词的 Fact，Retcon 可以执行（废弃只是禁止新 Fact，不阻止修改已有 Fact）
- **快照恢复**：快照中可能包含已废弃谓词的 Fact，恢复时这些 Fact 不受影响

**开发者约束**：
- World Package 的修改操作必须通过 `commit_schema_extension` 工具执行，不允许直接修改 SQLite 的 wp_* 表
- `commit_schema_extension` 在 Phase B 中原子性地写入谓词/规则变更 + 系统事件 + audit_log + 递增 state_version
- 任何 World Package 变更必须产生 `evt_schema_*` 系统事件，作为变更的唯一合法记录

---

## 4. FactStore：时序三元组存储层

### 4.1 设计定位

FactStore 是一个**以时间为第一维度的三元组存储**，不是图数据库。

- 存储的基本单元是 (subject, predicate, value, time) 四元组
- 关系 Fact 和属性 Fact 统一存储，没有类型区别
- 图可视化是 FactStore 的只读派生视图，不是存储层的组成部分
- LanceDB 是 FactStore 的语义检索索引，两者保持最终一致（见 4.6）
- 实现为 `SQLiteFactStoreAdapter`，通过 better-sqlite3 持久化到本地文件，接口层保持不变以便替换存储后端

### 4.2 四级索引设计

```
主索引：subject → predicate → Fact[]
  用途：给定实体 + 属性，快速获取所有历史版本
  结构：Map<string, Map<string, Fact[]>>
  查询模式：张三的境界是什么？(O(1 + k)，k 为版本数)

事件溯源索引：causeEvent → Fact[]
  用途：给定事件，追溯其产生的所有事实
  结构：Map<string, Fact[]>
  查询模式：evt_encounter_55 改变了哪些事实？

ID 索引：factId → Fact
  用途：精准定位单条 Fact（retract / update 时使用）
  结构：Map<string, Fact>

关系反向索引：targetEntityId → Fact[]
  用途：给定目标实体，查询所有指向它的关系 Fact
  结构：Map<string, Fact[]>
  查询模式：谁是张三的敌人？谁的师父是陈老？
  说明：没有此索引，反向关系查询需要全表扫描
```

### 4.3 核心接口

```typescript
interface FactStore {
  // ---- 写入 ----

  // 断言新事实（自动生成 id 和 embeddingText）
  // 注意：causeEvent 由 applyFactGroup 从 group.causeEvent 注入，
  // 直接调用 assert 时需自行提供 causeEvent。
  // embeddingText 由 FactEmbedder 在 assert 内部生成。
  assert(fact: Omit<Fact, 'id' | 'embeddingText'>): Fact;

  // 撤回事实（设置 validTo，不删除）
  retract(factId: string, validTo: number): void;

  // 更新事实（retract 旧 + assert 新，保证不可变性）
  // context 参数用于 exit_scope 场景：将 arc_dream_01 作用域的 Fact 更新并"提升"到 global
  // 省略 context 时继承原 Fact 的 context
  update(
    factId: string,
    newValue: FactValue,
    newCauseEvent: string,
    validFrom: number,
    context?: string
  ): Fact;

  // 原子应用一组变更（全成功或全回滚）
  // 返回 changeId → factId 映射表，供 commit_event 构建 sync_queue 和 Knowledge 写入时使用
  applyFactGroup(group: FactGroup): Map<string, string>;

  // ---- 内部方法（仅 applyFactGroup 回滚时使用，不对外暴露） ----

  // 物理删除一条 Fact（仅用于事务回滚时撤销已 assert 的 Fact）
  forceRemove(factId: string): void;

  // ---- Retcon 操作 ----

  // 批量将 canonical 事实标记为 contested（仅更新 certainty='canonical' 的行）
  // 返回实际更新的行数，供调用方验证预期标记数量
  markContested(factIds: string[], causeEvent: string): number;

  // 单条事实的确定性字段变更（主要用于测试重置或特殊恢复路径）
  // 注意：正常 contested → canonical 不应直接 UPDATE，应通过 propose_event 创建新 Fact
  updateCertainty(factId: string, certainty: Certainty): void;

  // ---- 乐观锁 ----

  // 获取项目当前乐观锁版本号（commit_event / commit_retcon Phase B 使用）
  getStateVersion(projectId: string): number;

  // 乐观锁条件更新：仅当 state_version == expectedVersion 时递增
  // 返回 true = 成功获取锁，false = 版本冲突（STALE_PROPOSAL）
  tryUpdateStateVersion(projectId: string, expectedVersion: number): boolean;

  // ---- 查询 ----

  // 通用多维查询
  query(query: FactQuery): Fact[];

  // 实体在某章节时刻的状态快照
  getSnapshot(subject: string, atChapter: number): Record<string, FactValue>;

  // 按事件追溯其产生的所有事实
  getFactsByEvent(eventId: string): Fact[];

  // 按 ID 获取单条事实
  getById(factId: string): Fact | undefined;

  // 查询所有指向某实体的关系 Fact（反向查询）
  getRelationsTargeting(entityId: string, atChapter?: number): Fact[];
}

interface FactQuery {
  subject?: string;
  predicate?: string;
  atChapter?: number;              // 时间切片
  certainties?: Certainty[];       // 默认 ['canonical', 'contested']
  relationKind?: RelationKind;     // 按关系语义类别过滤
  valueEntityRef?: string;         // 按关系目标实体过滤（反向关系查询用）
  context?: string;                // 作用域过滤（见 3.4.1），默认当前激活的作用域
  includeInherited?: boolean;      // 是否叠加继承的父作用域 Fact（默认 true）
  mode?: 'current' | 'history';    // current 默认只查当前有效 Fact；history 允许查询已 validTo 的历史 Fact
  includeInactive?: boolean;       // 仅 mode='history' 时允许，显式包含 validTo 已结束的 Fact
}
```

**时间切片过滤规则**：

```
fact.validFrom <= query.atChapter
AND (
  query.mode = 'history'
  OR fact.validTo === null
  OR fact.validTo > query.atChapter
)
AND (fact.context = query.context OR (query.includeInherited AND fact.context = 'global'))
```

当 `includeInherited = true`（默认）且 `context != 'global'` 时，检索结果按 context 优先级排序：局部 Fact 遮蔽同 subject+predicate 的全局 Fact（见 3.4.1 遮蔽机制）。

**作用域退出后的查询语义**：

- `mode='current'`：默认模式。`exit_scope` 后已设置 `validTo` 的局部 Fact 不出现在当前视图中。
- `mode='history'`：历史回放模式。必须传入 `atChapter`，可查询某个作用域在指定章节曾经成立的 Fact。
- `includeInactive=true`：仅用于审计和 Retcon 报告，允许列出已经失效的局部 Fact；普通写作读取流不得默认启用。

### 4.3.1 ThreadStore：叙事线索存储接口（独立于 FactStore）

NarrativeThread 与 Fact 是本质不同的领域概念：Fact 不可变（时序三元组），Thread 有状态流转和生命周期里程碑。ThreadStore 与 FactStore 共享同一个 SQLite 连接（同库不同表），但接口层面职责完全分离。

```typescript
interface ThreadStore {
  // 创建叙事线索（Rule Engine 检测到违规 / 作者埋设伏笔时调用）
  create(thread: Omit<NarrativeThread, 'id'>): NarrativeThread;

  // 更新线索状态（ThreadResolver 判定关闭 / Retcon 撤销 / 伏笔暗示时调用）
  updateStatus(threadId: string, status: ThreadStatus, closedBy?: string): void;

  // 追加里程碑（伏笔被再次暗示、部分揭示时调用）
  addMilestone(threadId: string, milestone: Omit<ThreadMilestone, 'id'>): void;

  // 获取所有未关闭的线索（语义检索层注入写作上下文时调用）
  getOpen(): NarrativeThread[];

  // 按 ID 获取单条线索
  getById(threadId: string): NarrativeThread | undefined;

  // 按条件过滤线索
  getByFilters(filters: ThreadFilter): NarrativeThread[];
}

interface ThreadFilter {
  direction?: ThreadDirection;      // 按方向过滤：retroactive / progressive
  type?: ThreadType[];              // 按类型过滤
  severity?: ('minor' | 'major' | 'critical')[];
  status?: ThreadStatus[];          // 按状态过滤
  nearChapter?: number;             // 距此章节 N 章内截止
  window?: number;                  // nearChapter 的窗口大小，默认 5
  closedByEvent?: string;           // 按关闭事件过滤（Retcon BFS 使用）
  relatedEntity?: string;           // 按关联实体过滤
  arcTag?: string;                  // 只展示属于某作用域的线索（见 3.4.1）
  excludeArcTags?: string[];        // 排除属于某些作用域的线索（主线写作时排除副本线索）
}
```

### 4.3.2 ProposalStore：提案存储接口（独立于 FactStore）

Proposal 是 propose_event 和 commit_event 之间的临时数据，生命周期短暂。
使用内存 Map 实现（进程重启后 Proposal 丢失，需重新提交）。

```typescript
interface ProposalStore {
  // 保存 Proposal（propose_event 时创建）
  save(proposal: ProposalResult, originalFactChanges?: FactChange[]): void;

  // 获取 Proposal（commit_event 时消费）
  get(proposalId: string): ProposalResult | undefined;

  // 获取 Phase A 归一化后的原始 FactChange 列表（commit_event 重建 FactGroup）
  getOriginalChanges(proposalId: string): FactChange[];

  // 删除已消费或过期的 Proposal
  remove(proposalId: string): void;

  // 清理超过指定章节数的过期 Proposal（每次 commit_event 后调用）
  // 注：内存 Map 在进程重启后自动清空，此方法主要用于长会话中
  // 防止大量未确认 Proposal 累积占用内存。短会话场景下可视为空操作。
  expireStale(currentChapter: number, maxAge?: number): void;
}
```

> **L8 进程重启后的 Proposal 生命周期**：ProposalStore 使用内存 Map，进程重启后清空。
> 如果 LLM 在重启后使用旧的 proposal_id 尝试 commit_event，会收到 `PROPOSAL_NOT_FOUND` 错误。
> LLM 应按照 §9.3 重试指导重新发起 propose_event——新的 ProposalResult 携带正确的
> expectedStateVersion，系统行为与首次 propose 一致。state_version 存储在 SQLite project_state
> 表中，重启后保留，不会因为 ProposalStore 清空而丢失乐观锁保护。

> **Phase 1 存储契约**：ProposalStore 必须保存 Phase A 的完整提交上下文：`proposedEvent`、归一化后的 `FactChange[]`、`expectedStateVersion` 和 `dependentFactIds`。`commit_event` 不得从 `proposal_id` 字符串反推事件类型、章节、context 或依赖声明；这些字段以 Phase A 保存的 Proposal 为准。

### 4.3.3 EventStore：事件存储接口（独立于 FactStore）

NarrativeEvent 是世界状态变更的唯一入口，需要持久化存储以支持 Retcon BFS 级联遍历和事件溯源。
EventStore 与 FactStore / ThreadStore 共享同一个 SQLite 连接，使用独立的 `events` 表。

```typescript
type EventKindFilter = 'business' | 'system' | 'all';

interface EventStore {
  // 创建事件（commit_event 时写入）
  create(event: Omit<NarrativeEvent, 'id'>): NarrativeEvent;

  // 按 ID 获取单条事件
  getById(eventId: string): NarrativeEvent | undefined;

  // 按章节范围查询事件（Retcon BFS 和时间线浏览使用）
  getByChapterRange(fromChapter: number, toChapter?: number, kind?: EventKindFilter): NarrativeEvent[];

  // 按事件主体查询（Retcon BFS 查找后续相关事件时使用）
  getBySubject(entityId: string, fromChapter?: number, kind?: EventKindFilter): NarrativeEvent[];

  // 按事件类型查询（ThreadResolver 关闭判定时使用）
  getByType(eventType: string, fromChapter?: number, kind?: EventKindFilter): NarrativeEvent[];

  // 按前置 Fact 依赖查询事件（Retcon BFS 优先路径使用，见 §9.2 Tool 4）
  // 查询 event_dependencies 中引用任意指定 factId 的所有事件
  // 用于 Retcon BFS 的"确定性依赖链"追踪——跳过启发式搜索，直接定位因果下游
  getByDependentFactIds(factIds: string[], kind?: EventKindFilter): NarrativeEvent[];
}
```

> **设计说明**：EventStore 是 Retcon BFS 算法（9.2 Tool 4）的前置依赖——BFS 需要
> `getBySubject()` 查找某实体在指定章节之后的所有事件，以构建因果级联图。
> `getByDependentFactIds()` 用于 BFS 的优先路径（§9.2 Tool 4 propose_retcon 的 BFS 算法），通过
> `event_dependencies(fact_id, event_id)` 索引，精确匹配声明了依赖关系的事件。
> 所有查询方法的 `kind` 默认值为 `'business'`。系统事件需要审计或运维查询时显式传入 `'system'` 或 `'all'`。
> 实现为 `SQLiteEventStoreAdapter`，与 FactStore 同库不同表。

### 4.3.4 KnowledgeStore：知识可见性存储接口（独立于 FactStore）

Knowledge 是 Fact 之上的认知层，独立存储。KnowledgeStore 与 FactStore 共享同一个 SQLite 连接（同库不同表）。

```typescript
interface KnowledgeStore {
  // 创建知识条目（commit_event 时自动或显式创建）
  create(knowledge: Omit<Knowledge, 'id'>): Knowledge;

  // 批量创建（事件提交时一次性创建多条）
  batchCreate(entries: Omit<Knowledge, 'id'>[]): Knowledge[];

  // 查询某实体在指定章节知道的所有 Fact
  getKnownFacts(entityId: string, atChapter?: number): Knowledge[];

  // L6 安全查询方法：过滤掉指向 contested/orphaned Fact 的 Knowledge
  // 适用场景：检索管线 Step 5 的知识感知过滤应优先使用此方法，
  // 避免将指向已失效 Fact 的 Knowledge 注入 LLM 上下文。
  // 内部实现：JOIN facts 表过滤 certainty IN ('canonical', 'potential')
  getActiveKnowledge(entityId: string, atChapter?: number): Knowledge[];

  // 查询某条 Fact 被哪些实体知晓
  getKnowersOfFact(factId: string): Knowledge[];

  // 查询某 Fact 的全部认知记录（Retcon 级联扫描使用）
  getByFactId(factId: string): Knowledge[];

  // 更新确信度（作者订正时使用）
  updateConfidence(knowledgeId: string, confidence: number, updatedByEvent?: string): void;

  // 按条件查询
  query(filter: KnowledgeFilter): Knowledge[];
}

interface KnowledgeFilter {
  entityId?: string;              // 按知晓者实体过滤
  factId?: string;                // 按被知晓的 Fact 过滤
  source?: KnowledgeSource[];     // 按知识来源过滤
  minConfidence?: number;         // 最低确信度阈值
  atChapter?: number;             // 时间切片：只返回 knownSince <= atChapter 的记录
}
```

> **与读取流的集成**：`RelevantFactRetriever`（7.2.3）在检索中新增知识感知步骤——根据场景实体 ID 查询它们知道什么，过滤掉它们不知道的 Fact，确保注入 LLM 的上下文符合角色视角。详见 7.2.3。

**未来扩展预留：KnowledgeStoreMode**

Knowledge 的实际规模取决于作品类型——角色视角小说（如诡秘之主）可能仅 5 万-25 万条，但组织密集型作品（如一人之下、三体）中组织实体的知识接触面远大于个人，可能膨胀至百万级。为应对未来规模压力，预留以下策略接口（当前仅实现 `eager`，其余标记为实验性，不做过早优化）：

```typescript
// Knowledge 存储策略（当前固定为 eager，未来按需切换）
type KnowledgeStoreMode =
  | 'eager'               // 默认：commit_event 时立即写入 Knowledge 表
  | 'compressed-eager'    // 乐观写 + 定期压缩历史记录（同一 entity+fact 仅保留最新 N 条）
  | 'experimental-lazy';  // 实验性：按需推导（注意：seal/restore/decay 状态不可重算，lazy 模式存在语义风险）

// KnowledgeStore 在初始化时读取配置，决定存储策略
// 当前阶段所有项目统一使用 eager 模式
// compressed-eager 的压缩阈值（如每 entity+fact 最多保留 20 条历史）由 World Package 配置
```

> **为什么 Knowledge 不能完全 lazy**：Knowledge 已拥有独立的状态变迁生命周期（seal / restore / decay / soul_read / implant），这些状态是事件驱动的认知历史，无法从 Fact + Propagation Rules 重算。完全 lazy 模式意味着丢弃 seal/restore 历史，这在语义上是不可接受的。未来如需优化规模，正确方向是 `eager 写入 + 定期压缩 + 归档`，而非运行时推导。

### 4.3.1 ProjectSession：核心上下文对象

所有引擎组件共享同一个项目上下文，通过 `ProjectSession` 统一持有所有 Store 和服务实例，避免调用签名膨胀（每个函数 4-5 个 Store 参数）和实例版本不一致风险。

```typescript
interface ProjectSession {
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
```

所有引擎组件的构造函数接收 `ProjectSession` 而非独立的 Store 参数。`ProjectSession` 在项目打开时创建，项目关闭时释放。
### 4.4 原子事务回滚机制（SQLite 事务实现）

> **修订说明**：原伪代码使用内存 Map 手动撤销，与 SQLiteFactStoreAdapter 的实际存储
> 后端不匹配。以下改为基于 SQLite 原生事务的实现。`better-sqlite3` 的同步 API 与
> `db.transaction()` 配合，天然保证原子性——事务内任意步骤抛出异常，SQLite 自动回滚
> 全部变更，无需手动 snapshot 撤销。

```typescript
// applyFactGroup：FactGroup 子操作的原子写入
// ⚠ 调用约定：此方法不独立开事务，必须在 commit_event Phase B 的 SQLite 事务内调用。
//
// ⚠ 事务语义修正（重要）：
//   better-sqlite3 的 db.transaction() 不支持"自动将内层事务转为 SAVEPOINT"——
//   在已有事务的连接上执行 BEGIN 会触发 SQLITE_ERROR: cannot start a transaction within a transaction。
//   因此本方法不使用 db.transaction()，而是通过显式 SAVEPOINT / RELEASE 实现局部回滚：
//     - 外层 commit_event Phase B 的 BEGIN/COMMIT 保证全局原子性
//     - 本方法的 SAVEPOINT factgroup_sp 保证 FactGroup 内部可独立回滚，不影响外层事务
//   如果不需要局部回滚语义（FactGroup 失败应直接回滚整个 Phase B），可省略 SAVEPOINT。
//
// 关键设计：LanceDB 同步不在此方法内执行（见 4.5 节说明）
applyFactGroup(group: FactGroup): Map<string, string> {
  const idMap = new Map<string, string>();  // changeId → factId 映射表

  // 显式 SAVEPOINT：在外层事务内创建保存点，失败时只回滚到此处
  this.db.prepare('SAVEPOINT factgroup_sp').run();
  try {
    for (const change of group.changes) {
      if (change.op === 'assert') {
        const fact = { ...change.payload!, causeEvent: group.causeEvent };
        const newFact = this.assert(fact);  // INSERT INTO facts ... RETURNING *
        idMap.set(change.changeId, newFact.id);  // 收集 changeId → 新 factId

      } else if (change.op === 'retract') {
        // UPDATE facts SET valid_to = validTo WHERE id = targetFactId
        this.retract(change.targetFactId!, change.payload!.validTo as number);
        // retract 不产生新 Fact。changeId 映射到被 retract 的目标 Fact ID。
        // 用途：PropagationRule 为 retract change 生成的 ProposedKnowledge 需要 factId，
        // 此处映射到 change.targetFactId（被撤销的那条 Fact）。
        idMap.set(change.changeId, change.targetFactId!);

      } else if (change.op === 'update') {
        // 内部：retract 旧行 + assert 新行，在同一事务中
        const target = this.getById(change.targetFactId!)!;
        // 注意：省略 context 参数，继承原 Fact 的 context。
        // exit_scope 的跨作用域 update 场景通过 SCOPE_FACT_MISMATCH 校验（§3.4.1）
        // 阻止静默跨作用域修改，作者应使用 op='assert' 创建新全局 Fact。
        const newFact = this.update(
          target.id,
          change.payload!.value!,
          group.causeEvent,
          change.payload!.validFrom!
          // context 省略 → 继承 target.context
        );
        // update 产生新 Fact，changeId 映射到新 Fact（assert 产出的那条）。
        // 理由：Knowledge 应指向新的 canonical Fact，而非即将失效的旧 Fact。
        idMap.set(change.changeId, newFact.id);
      }
    }
    // 全部成功，释放保存点
    this.db.prepare('RELEASE factgroup_sp').run();
  } catch (err) {
    // 回滚到保存点，外层事务不受影响
    this.db.prepare('ROLLBACK TO factgroup_sp').run();
    throw err;  // 向上传播异常，由 commit_event Phase B 决定是否回滚整个事务
  }

  // applyFactGroup 只负责 Fact 子操作；event / knowledge / thread / audit_log / sync_queue
  // 由上层 commit_event Phase B 事务协调器在同一 SQLite 事务中统一写入。
  //
  // 底层防线：禁止用 unknown、空字符串或第 1 章作为缺失字段兜底。
  // assert 缺少 subject/predicate/value/validFrom，retract 缺少 targetFactId/validTo，
  // update 缺少 targetFactId/validFrom 时必须抛出 SCHEMA_VALIDATION_FAILED。
  // update 采用完整新 Fact 语义：payload 中提供的 subject/predicate/value 覆盖旧 Fact，
  // 未提供的字段继承旧 Fact。
  //
  // changeId → factId 映射规则（返回给上层 commit_event 消费）：
  //   - assert：映射到新 INSERT 的 Fact ID（如 'fct_ch01_claine_power_xxx'）
  //   - retract：映射到被 retract 的目标 Fact ID（change.targetFactId）
  //   - update：映射到新 assert 的 Fact ID（非旧 Fact）
  //
  // 消费路径：
  //   - KnowledgeStore 写入时需要 factId 作为外键
  //   - ThreadStore 关联 upstreamFactIds 时需要 factId
  //   - audit_log 审计记录中引用 factId
  //   - Phase C sync_queue 构建时使用 factId 定位 LanceDB 向量
  //   如果 assert 因唯一约束冲突被忽略（幂等重试场景），映射表中记录实际存在的 factId。
  return idMap;
}
```

**LanceDB 同步为何不在此方法内**：

1. `applyFactGroup` 是同步方法（`better-sqlite3` 同步 API），但 LanceDB 写入和 Embedding API 调用都是异步操作
2. 在同步函数中 fire-and-forget 一个 Promise 会导致静默失败，且无法被上层 catch
3. LanceDB 是可重建的派生索引，延迟同步不影响数据正确性（见 4.6 设计原则）
4. 因此，`commit_event` 的 Phase B 只在 SQLite 事务内写入 `sync_queue` outbox；真正的 Embedding API / LanceDB 操作由后台 worker 消费 outbox 后执行（见 10.1 写入流）

> **事务边界说明**：示例代码展示的是 FactStore 的局部原子能力。完整 `commit_event` 不应让 `applyFactGroup` 单独开启一个与 Event/Knowledge/Thread/audit/outbox 分离的事务；实现时应通过同一个 SQLite 连接上的上层事务协调器，把这些写入作为一个不可分割的 Phase B 提交单元。

**commit_event 事务拆分设计（Phase A / B / C）**：

commit_event 的完整流程应拆分为三个阶段，避免长事务阻塞事件循环。SQLite 事务必须覆盖所有不可丢失的持久化事实：客观 Fact、认知 Knowledge、Thread 状态、审计日志和 LanceDB 同步 outbox。事务后只能执行可重试的后台消费，不能再创建唯一的持久化任务。

```
Phase A（事务外，可重试）：
  → FactStore.getSnapshot() × N          // 读当前世界状态
  → RuleEngine.computeConsequences()      // 沙盒推演（纯函数：相同输入→相同输出）
  → Knowledge 推导（Propagation Rules）
  → 生成 EventConsequence
  → 返回 ProposalResult 给 LLM/作者审核
  → 结果可缓存（连续两次 propose_event 基于同一快照，第二次直接返回缓存）

Phase B（事务内，目标 5-20ms）：
  → BEGIN
  → UPDATE project_state
       SET state_version = state_version + 1, updated_at = now()
       WHERE project_id = ? AND state_version = expectedStateVersion
     // 更新行数为 0：ROLLBACK，返回 STALE_PROPOSAL，要求重新 propose_event
  → INSERT event                          // 1 行；普通提交为业务事件，Retcon 提交为 evt_retcon_* 系统事件
  → INSERT facts                          // N 行（通常 1-5）
  → INSERT knowledge                      // M 行（通常 0-10）
  → UPDATE/INSERT threads                 // 通常 0-2 行
  → INSERT audit_log                      // 审计必须和状态变更同事务落盘
  → INSERT sync_queue                     // outbox：记录待执行的 LanceDB 操作
    // sync_queue 包含三类 operation：
    //   'insert_vector'  — 新 assert 的 canonical Fact（向量写入）
    //   'mark_invalid'   — 被 retract/update 导致 validTo 被设置的旧 Fact（is_current→false）
    //   'update_certainty' — Retcon 导致 certainty 变更的 Fact（certainty 字段同步）
    // commit_event 事务协调器根据 applyFactGroup 返回的 idMap 和操作类型，
    // 统一构建 insert_vector 和 mark_invalid 两种 outbox 记录
  → COMMIT

Phase C（事务后，异步）：
  → 后台 worker 扫描 sync_queue
  → 执行 LanceDB / Embedding 操作并更新 sync_queue.status
  → 缓存失效 / 快照刷新（可从 SQLite 状态重建）
```

> **L1 Phase B 延迟预算验证**：Phase B 包含 UPDATE project_state + INSERT event + N 个 INSERT facts + M 个 INSERT knowledge + K 个 UPDATE/INSERT threads + INSERT audit_log + INSERT sync_queue。当 N=5、M=10、K=2 时约 20+ 条 SQL statement。better-sqlite3 的同步 API 在 WAL 模式下通常 <10ms，但 fsync 场景（磁盘写入确认）可能接近 20ms。建议在 Phase 0.5 Spike 2 中加入 Phase B 事务延迟基准测试。

> **崩溃一致性原则**：如果 Phase B 提交成功，即使进程在下一行崩溃，重启后也能从 `sync_queue` 恢复所有未完成的 LanceDB 同步任务，并从 `audit_log` 看到完整写入记录。如果 Phase B 回滚，则 Fact / Knowledge / Thread / audit_log / sync_queue 全部不可见。

> **事件锚点原则**：任何 Phase B 持久副作用都必须绑定到一条已提交 `events` 记录。`commit_event` 绑定业务事件，`commit_retcon` 绑定 `evt_retcon_*` 系统事件；不允许 `audit_log`、`sync_queue`、`event_dependencies` 或 Fact.causeEvent 指向暂态 `prp_` / `rtc_` ID。

> **为什么不能把 Phase A 放进事务**：Rule Engine 沙盒推演涉及多次 getSnapshot 读取 + 规则评估，耗时可能 50-200ms。在 `better-sqlite3` 同步 API 下，整个推演过程会阻塞事件循环。Phase A 的纯函数特性保证：即使基于稍旧的快照推演，结果仍然一致——最坏情况是乐观锁检测到版本冲突，重跑一次 Phase A。

### 4.5 LanceDB 同步策略

FactStore 写入成功后，LanceDB 同步由后台 worker 消费 `sync_queue` outbox 触发，不阻塞主写入链路。
LanceDB 是嵌入式向量数据库，通过 npm 包 `@lancedb/lancedb` 直接操作本地文件，无需独立服务进程。

> **调用链路**：`commit_event` → Phase B SQLite 事务写入 Fact + `sync_queue` outbox → 后台 worker 读取 outbox → `scheduleLanceDBSync` 执行 Embedding API + LanceDB 写入。状态写入、任务持久化、派生索引消费三层职责完全分离。

```typescript
// 此方法由后台 sync worker 调用，不在 applyFactGroup / commit_event 事务内调用
// 处理两类 outbox 操作：insert_vector（新 Fact）和 mark_invalid（旧 Fact 失效）
private async scheduleLanceDBSync(eventId: string): Promise<void> {
  const newFacts = this.getFactsByEvent(eventId)
    .filter(f => f.certainty === 'canonical');

  const vectors = [];
  for (const fact of newFacts) {
    vectors.push({
      id: fact.id,
      vector: await embedder.embed(fact.embeddingText),
      subject: fact.subject,
      predicate: fact.predicate,
      valid_from: fact.validFrom,
      valid_to: fact.validTo ?? null,  // null 表示当前有效，LanceDB 原生 null
      is_current: fact.validTo === null,  // 布尔辅助字段，避免 null 哨兵值
      certainty: fact.certainty,
      context: fact.context
    });
  }

  // LanceDB 批量 add，一次写入多条
  await this.lanceTable.add(vectors);
}

// 后台 sync worker 消费 operation='mark_invalid' 时调用
// retract/update 操作使旧 Fact 失效后，LanceDB 中的对应向量必须同步更新，
// 否则语义检索的 is_current=true 过滤条件无法排除已失效向量——产生幽灵检索。
private async markInvalidInLanceDB(invalidatedFactIds: string[]): Promise<void> {
  for (const factId of invalidatedFactIds) {
    // LanceDB 不支持单字段 UPDATE，需要 delete + re-add（去掉 is_current 标记）
    // 或使用 LanceDB 的 update API（如果支持）
    await this.vectorStore.markInvalid(factId);
  }
}
```

**Retcon 场景的 LanceDB certainty 同步**：

`scheduleLanceDBSync` 只处理新 Fact 的向量写入。Retcon 将 Fact 的 certainty 从 `canonical` 改为 `contested` 时，LanceDB 中已有向量的 certainty 字段必须同步更新，否则语义检索（Step 2）的 `certainty='canonical'` 过滤条件无法排除已失效的向量——产生"幽灵检索"。

```typescript
// 后台 sync worker 消费 operation='update_certainty' 时调用，批量更新受影响向量的 certainty 字段
// 与 scheduleLanceDBSync 的区别：不产生新向量，只修改已有向量的 certainty 和 is_current
private async scheduleRetconSync(contestedFactIds: string[]): Promise<void> {
  for (const factId of contestedFactIds) {
    await this.vectorStore.updateCertainty(factId, 'contested');
  }
}
```

**风险窗口兜底**：`commit_retcon` SQLite 写入成功 → LanceDB certainty 更新完成之间（通常 < 1s），如果恰好有检索请求命中未更新的向量，需要一层内存级防护：

```typescript
// 检索管线中的 contested 黑名单（内存级，随 commit_retcon 写入，随 certainty 更新完成清除）
// 不持久化——进程重启后从 SQLite 重建
private contestedBlacklist: Set<string> = new Set();

// commit_retcon 成功后立即写入黑名单（同步，不依赖 LanceDB）
updateContestedBlacklist(contestedFactIds: string[]): void {
  for (const id of contestedFactIds) this.contestedBlacklist.add(id);
}

// LanceDB certainty 更新完成后清除
clearFromBlacklist(factId: string): void {
  this.contestedBlacklist.delete(factId);
}

// Step 2 检索结果后过滤
filterContested(results: ScoredFact[]): ScoredFact[] {
  return results.filter(r => !this.contestedBlacklist.has(r.factId));
}
```

> **为什么不用同步屏障（Sync-Barrier）**：`commit_retcon` 是低频操作（整部小说可能不到 10 次），为其引入同步阻塞机制会过度设计。内存级黑名单 + 异步 certainty 更新的组合在工程复杂度和可靠性之间取得了更好的平衡。进程重启后的冷启动场景，黑名单从 SQLite 重建（`SELECT id FROM facts WHERE certainty = 'contested'`），成本可忽略。

### 4.6 LanceDB 同步可靠性保障

异步同步可能因各种原因中断。FactStore（SQLite）是权威数据源，LanceDB 是可重建的派生索引。
以下按故障场景分别给出检测和恢复方案。

#### 4.6.1 故障场景与恢复矩阵

| 故障场景 | 触发原因 | 检测方式 | 恢复策略 | 恢复粒度 |
|---------|---------|---------|---------|---------|
| Embedding API 失败 | 网络超时、API 宕机、配额耗尽 | 同步函数抛出异常 | 自动重试 | 单条 Fact |
| LanceDB 写入失败 | 磁盘满、权限错误、内部错误 | 同步函数抛出异常 | 自动重试 | 单条 Fact |
| 进程崩溃 | OOM、未捕获异常、被 kill | 下次启动时 ID 差集比对 | 增量重建 | 缺失的 Fact |
| LanceDB 文件损坏 | 断电、磁盘故障、写入中断 | 启动时文件校验失败 | 全量重建 | 所有 canonical Fact |

#### 4.6.2 场景一：Embedding API 失败 / LanceDB 写入失败（自动重试）

```typescript
interface SyncQueueEntry {
  eventId: string;        // 关联的事件 ID
  factIds: string[];      // 需要同步的 Fact ID 列表
  operation: 'insert_vector' | 'mark_invalid' | 'update_certainty' | 'rebuild_event_vectors';
  payload: Record<string, unknown>; // 操作参数，如 { certainty: 'contested' }
  retryCount: number;     // 已重试次数
  maxRetries: number;     // 最大重试次数，默认 3
  nextRetryAt: number;    // 下次重试的 UNIX 时间戳（指数退避）
  error?: string;         // 最近一次失败的错误信息
}
```

**流程**：

```
commit_event 成功
  → Phase B 已在 sync_queue 写入 operation='insert_vector' 的 outbox 记录
  → 后台 worker 扫描 sync_queue
    → 调用 Embedding API → 写入 LanceDB
      ├── 成功 → 结束
      └── 失败 → 更新 sync_queue.retry_count / next_retry_at / last_error
                → 后台定时器继续扫描 sync_queue
                → 到达 nextRetryAt 时重试（退避：2s → 4s → 8s）
                  ├── 成功 → 标记 status='done' 或从 sync_queue 删除
                  └── retryCount >= maxRetries → 标记 SYNC_FAILED，记录日志
```

**sync_queue 持久化**：存储在 SQLite 的 `sync_queue` 表中，并作为 outbox 与主写入事务同提交。进程崩溃后重启，后台定时器自动恢复队列中的重试任务。

**降级**：重试耗尽后不阻塞主链路，语义检索暂时搜不到这些 Fact。等待场景三（启动校验）或人工介入修复。

#### 4.6.3 场景二：进程崩溃（启动时增量重建）

进程崩溃时 SQLite 已落盘（数据完好），但 LanceDB 可能缺少最后几批向量。

**启动时增量校验流程**：

```
进程启动
  → 场景四检测（LanceDB 文件是否可读）
    → 不可读 → 跳到场景三（全量重建）
    → 可读 → 继续
  → 【M9 冷启动时序】先消费 sync_queue 中的 update_certainty 条目，
    确保 LanceDB 中 contested Fact 的 certainty 字段与 SQLite 一致。
    此步骤必须在 contestedBlacklist 重建之前完成，否则冷启动后存在
    较长的黑名单活跃期（不是 <1s 而是"后台 worker 首次运行前"）。
  → 读取 SQLite 中所有 canonical Fact 的 ID 集合 A
  → 读取 LanceDB 中所有记录的 ID 集合 B
  → 差集 missingIds = A - B
    → 差集为空 → 无需恢复，启动完成
    → 差集非空 → 对 missingIds 的 Fact 调用 Embedding API → 写入 LanceDB
  → contestedBlacklist 从 SQLite 重建：
    SELECT id FROM facts WHERE certainty = 'contested'
    （此时 LanceDB 的 certainty 已同步完毕，黑名单仅作额外保险）
  → 恢复完成
```

**性能**：ID 集合比对是 O(N) 操作，即使 10000 条 Fact 也在毫秒级完成。增量 embed 只处理缺失的条目。

#### 4.6.4 场景三：LanceDB 文件损坏（全量重建）

LanceDB 文件不可读时（文件校验失败、open 抛出异常），执行全量重建。

```
启动时检测 LanceDB 文件
  → open() 抛出异常
  → 删除损坏的 LanceDB 数据目录
  → 重新创建空 LanceDB Table
  → 从 SQLite 读取所有 certainty='canonical' 的 Fact
  → 批量 embed（每批 50 条，避免 API 限流）
  → 全量写入 LanceDB
  → 重建完成
```

**性能**：全量重建是最重的操作。1000 条 Fact × 1024 维 embed ≈ 20 批 × 每批 1-2 秒 ≈ 30-60 秒。
当前数据量小（<500 条），重建时间在 30 秒以内可接受。

#### 4.6.5 定期健康检查

每执行 N 次 `commit_event`（默认 N=50）后，执行一次快速数量比对：

```
SQLite canonical Fact 数量 vs LanceDB 记录数量
  → 差异 < 5% → 正常，记录日志
  → 差异 >= 5% → 触发增量重建（复用场景二的流程）
```

这覆盖了"重试耗尽 + 进程没重启"的中间地带——日常同步持续失败但没有触发启动校验时，定期检查兜底。

#### 4.6.6 设计原则

> **LanceDB 数据丢失不影响业务逻辑正确性**。最坏情况下降级为仅精确查询（无语义检索），
> 所有 Fact 的完整数据都在 SQLite 中，重新 embed 即可完全恢复。
> 这也是 LanceDB 作为"派生索引"而非"主存储"的核心价值。

### 4.7 快照系统（WorldSnapshot）

纯 Event Sourcing 在理论上可以重放任意章节的世界状态，但实践中，当 Fact 数量达到 50 万+（约 300 万字小说的规模），每次查询都从初始状态重放的成本将不可接受。

**快照机制**：定期将当前时刻的完整世界状态序列化保存，后续查询只需从最近的快照 + 少量增量 Event 恢复。

```typescript
interface WorldSnapshot {
  id: string;                    // 'snap_chapter_100'
  projectId: string;
  atChapter: number;             // 快照对应的章节
  createdAt: string;             // 快照生成时间 ISO 8601
  entityCount: number;           // 快照中的实体数量
  factCount: number;             // 快照中的活跃 Fact 数量
  // 快照数据存储为独立的 SQLite 文件或 JSON 文件
  // 不内联存储，避免主库膨胀
  storagePath: string;           // 'snapshots/{project_id}/snap_chapter_100.json'
}

// 快照数据结构（storagePath 指向的文件内容）
interface SnapshotData {
  atChapter: number;
  // 当前活跃的 Fact（is_current=true 的所有 Fact）
  activeFacts: Array<{
    id: string;
    subject: string;
    predicate: string;
    value: FactValue;
    context: string;
    validFrom: number;
    causeEvent: string;
  }>;
  // 当前活跃的实体
  entities: Array<{
    id: string;
    name: string;
    kind: EntityKind;
  }>;
  // 当前未关闭的 Thread
  openThreads: Array<{
    id: string;
    type: string;
    status: string;
  }>;
  // 当前活跃的 Knowledge（最新记录 confidence > 0）
  activeKnowledge: Array<{
    id: string;
    entityId: string;
    factId: string;
    confidence: number;
    source: KnowledgeSource;
  }>;
}
```

**快照策略**：

| 触发条件 | 快照类型 | 行为 |
|---------|---------|------|
| 每 100 章自动触发 | `auto` | 生成快照，异步写入，不阻塞主链路 |
| 章节结束时（commit_event 且 chapter 递增） | `chapter` | 强制生成，确保每个章节节点都有恢复点 |
| Retcon 执行前 | `pre_retcon` | 强制生成，保留 Retcon 前的世界状态供回退 |
| Major Event（Rule Engine 触发 ≥ 3 条 Thread） | `major_event` | 强制生成，重大剧情转折点必须可恢复 |
| 手动触发 | `manual` | 作者可在任意章节请求生成快照 |

**查询时的快照恢复**：

```
查询第 250 章的世界状态：
1. 找到最近的快照：snap_chapter_200（atChapter=200）
2. 加载快照数据到内存
3. 从 EventStore 查询第 201-250 章的增量 Event
4. 在内存中重放 50 个 Event（而非从第 1 章重放 250 个）
5. 返回最终状态

复杂度：O(n) → O(k)，k = 距离最近快照的章节数
```

**快照存储空间估算**：50 万 Fact 的快照约 50-80MB（JSON 格式），每 100 章一个快照，500 万字小说（约 1000 章）= 10 个快照 = 约 500MB-800MB。可接受。

**快照与 LanceDB 的关系**：快照是 SQLite 层的优化，不影响 LanceDB。LanceDB 的重建策略（§4.6.4）从 SQLite 的 facts 表全量重建，快照加速的是 `FactStore.getSnapshot()` 的查询，不是向量检索。

**快照的 Projection 本质**：Snapshot 属于派生数据（Projection），不是状态源。删除所有快照文件不影响世界状态的完整性——Fact + Event Replay 可以完全重建任意快照。Snapshot ≈ 查询缓存，不是状态存储。

---

## 5. Rule Engine：规则引擎

### 5.1 职责

- 接收 NarrativeEvent + 当前 FactStore → 在沙盒中计算 EventConsequence
- 不修改真实 FactStore（通过 atChapter 切片实现隔离，无需克隆）
- 检测规则违规并生成 NarrativeThread
- 提供一致性后验校验（给已提交的内容做检查）

### 5.2 规则分类

```
Rule Engine
├── Transition Rules（状态转换规则）
│     判定"事件 + 当前状态"的组合是否合法
│     例：绝脉体质 + 突破事件 → logic_conflict 回溯型线索
│     例：已死亡实体 + 任何行动事件 → rule_violation 回溯型线索
│
├── Inference Rules（推理规则）
│     从已有 Fact 推导必然成立的新 Fact
│     例：A enemy_of B → B enemy_of A（双向敌对推导）
│     例：A parent_of B, B parent_of C → A grandparent_of C
│
├── Constraint Rules（约束规则）
│     检查 Fact 集合是否违反硬约束
│     例：同一实体同一属性不能同时有两条 canonical Fact
│     例：chapter 只能正向递增，不能出现 validFrom > validTo
│
└── Propagation Rules（知识传播规则）       ← 新增
      从事件 + 实体关系推导 Knowledge 条目
      决定"谁在什么事件后知道了什么"
      例：事件主体 → 自动知晓（self_action, 1.0）
      例：同场景实体 → 自动目击（witnessed, 0.8）
      例：组织成员 → 组织内广播（faction_share, 1.0）
```

**Rule Engine 确定性原则**：所有规则必须满足"相同输入，永远相同输出"。

**Rule Engine 客观性原则**：Transition / Inference / Constraint / Propagation 四类规则的判定输入只有 `FactStore`（客观世界状态）和 `NarrativeEvent`（变更事件），**永不读取 `KnowledgeStore`**。传播规则可以**产出** Knowledge（写），但不将已有 Knowledge 作为**判定依据**（读）——去重逻辑在 `commit_event` 处理层执行，不在规则内部。规则引擎检查的是"世界是什么"，不是"谁知道什么"。涉及角色认知的叙事判断由 LLM 在读取流中完成（§7.2.3 Step 5 知识感知过滤），不属于规则引擎职责。

> **为什么 Rule Engine 不读取 Knowledge**：Knowledge 描述的是"实体 X 以什么确信度接触了 Fact Y"。如果规则引擎可以基于 Knowledge 触发后果，就建立了"认知状态 → 规则后果"的因果链，打开了 Belief / Theory of Mind 的通道（原则九）。例如：如果杀阵规则写成"入侵者知道 Cave B 危险时触发"，规则引擎就需要判断"知道"的真假，这是主观模拟。正确做法：杀阵规则检查客观条件（"入侵者进入 Cave B"），叙事后果由 LLM 基于角色认知决定。

允许的规则类型（确定性）：
- 状态转换规则：境界 X → 境界 Y 需要条件 Z（确定性条件检查）
- 约束规则：死亡实体不能行动（确定性状态检查）
- 推理规则：A 是 B 的敌人 → B 也是 A 的敌人（确定性逻辑推理）
- 传播规则：事件主体自动知晓 + 同场景目击传播（确定性场景规则）

Propagation Rules 的边界：`witness_propagation`（目击传播）的语义是"信息传递渠道"，不是"角色是否理解/相信"。张三看见李四杀人 → 张三接触了这个信息（Knowledge 创建），但张三是否"理解"为谋杀还是"认为"是正当防卫，不在 Core 范围内。LLM 可以通过 `knowledge_hints` 覆盖自动推导的结果（如降低 confidence）。

禁止的规则类型（非确定性）：
- 概率规则："有 30% 概率突破失败" → 禁止（非确定性）
- 心理规则："恐惧导致逃跑" → 禁止（主观模拟，违反原则九）
- 社交规则："好感度 < 30 时拒绝对话" → 禁止（情感量化，违反原则九）

**Rule Engine 复杂度预算**：规则执行必须有硬性上限，防止传播链爆炸：

| 约束 | 上限 | 原因 |
|------|------|------|
| 单次推理最大深度 | ≤ 10 层 | 防止规则链无限递归 |
| 单次推理最大生成 Fact 数 | ≤ 100 条 | 防止推理产出爆炸 |
| 单次推理最大生成 Thread 数 | ≤ 50 条 | 防止线索爆炸 |
| 传播规则单次触发最大 Knowledge 数 | ≤ 200 条 | 防止目击广播撑爆 |
| 禁止循环推导 | 规则 A 触发规则 B，规则 B 不得再触发规则 A | 防止死循环 |

超过上限时，Rule Engine 停止推理并返回 `INTERNAL_ERROR`，在 `detail` 中说明超限的具体规则链。这保证了 Core 在任何输入下都能在有限时间内返回结果。

**Rule Engine 边界不变式**：规则引擎只能从 Fact/Event 推导产出，禁止修改自身或系统配置：

| 允许 | 禁止 |
|------|------|
| Fact/Event → Fact（推理规则产出新 Fact） | Rule → Rule（规则不得修改/生成/禁用其他规则） |
| Fact/Event → Knowledge（传播规则产出 Knowledge） | Rule → Schema（规则不得修改数据库 Schema） |
| Fact/Event → Thread（约束规则产出叙事线索） | Rule → World Package（规则不得修改世界配置包） |
| | Rule → Tool（规则不得触发 Tool Call） |

**原因**：允许 Rule → Rule 会导致规则链自修改，形成不可预测的推理回路。允许 Rule → Schema/Package 会让 World Package 变成运行时可编程系统。Rule Engine 是推理器，不是解释器。

#### 5.2.1 Rule Engine 与 Knowledge 交互边界开发守则

**I-10 不变式的精确表述**：

Rule Engine 的**输入**不包含 Knowledge（Rule Engine Never **Reads** Knowledge）。Rule Engine 的**输出**可以包含 ProposedKnowledge（Rule Engine May **Write** Knowledge）。

```
允许的依赖方向：
  FactStore + Event → ProposedKnowledge（Propagation Rules 产出建议的认知条目）
  FactStore + Event → Fact（Inference Rules 产出推理 Fact）
  FactStore + Event → Thread（Transition/Constraint Rules 产出叙事线索）

禁止的依赖方向：
  Knowledge → Rule 判定结果（认知状态不得作为规则的输入条件）
  Knowledge → Fact 推理（认知状态不得影响客观事实的推理）
  Knowledge → Thread 生成（认知状态不得触发叙事线索的创建）
```

**开发约束**：
- 所有 Rule 的实现（Transition / Inference / Constraint / Propagation）的方法签名中不包含 `knowledgeStore` 参数
- PropagationRule.propagate() 的参数只有 `event`、`factGroup`、`factStore`，不含 `knowledgeStore`
- 如果某个规则需要"角色已经知道 X"的信息，这属于认知判断，由 Tool 层面或 LLM 读取流处理，不在 Rule Engine 内部处理
- Rule Engine 的去重逻辑（同一 entityId + changeId 的 Knowledge 条目合并）由 `commit_event` 处理层执行，不在规则内部

**为什么 ProposedKnowledge 是"建议"而非"判定"**：
- Propagation Rules 根据客观状态（位置、组织关系）建议"谁应该知道这件事"
- 建议可能被 LLM 的 `knowledge_hints` 覆盖（优先级：hints > broadcast > Propagation）
- 建议可能被作者的显式操作覆盖（seal/restore）
- 最终的认知状态由 commit_event 决定，不是 Rule Engine 的直接写入

```typescript
interface RuleEngine {
  // 沙盒推演：计算事件后果，不写入真实 FactStore
  computeConsequences(
    event: NarrativeEvent,
    factStore: FactStore,
    ruleSet: RuleSet
  ): EventConsequence;

  // 知识传播推演：从事件 + 实体关系推导建议的 Knowledge 条目
  // 在沙盒推演中与 Transition/Inference/Constraint Rules 并行执行
  // 注意：不接收 KnowledgeStore。传播规则只基于客观状态产出 Knowledge 建议，
  // 去重与显式认知操作覆盖由 commit_event 处理层负责，遵守 I-10。
  propagateKnowledge(
    event: NarrativeEvent,
    factStore: FactStore,
    propagationRules: PropagationRule[]
  ): ProposedKnowledge[];

  // 一致性后验：对已提交内容进行检查（每次 commit_event 后自动调用）
  validateConsistency(
    factStore: FactStore,
    atChapter: number
  ): ValidationReport;
}

interface RuleSet {
  transitions: TransitionRule[];
  inferences: InferenceRule[];
  constraints: ConstraintRule[];
  propagations?: PropagationRule[];  // 可选：通用 World Package 可能不包含传播规则
}

interface ValidationReport {
  violations: ConsistencyViolation[];
  warnings: string[];
}

interface ConsistencyViolation {
  factIds: string[];       // 相关 Fact 的 ID
  ruleId: string;
  description: string;
  suggestedAction: string;
}
```

### 5.4 规则配置示例（由 World Package 提供）

以下为三个不同题材的规则示例，展示 Rule Engine 如何通过 World Package 适配任意世界观。所有规则均通过 `WorldPackage.rules` 加载，Core 引擎不内置任何题材特定逻辑。

#### 示例一：仙侠世界观——绝脉突破检测（TransitionRule）

```typescript
const meridianBreakthroughRule: TransitionRule = {
  id: 'rule_meridian_breakthrough',
  description: '经脉尽毁者突破大境界属于逻辑断裂',
  check(event: NarrativeEvent, factStore: FactStore): NarrativeThread | null {
    if (event.type !== 'tribulation') return null;

    const snapshot = factStore.getSnapshot(event.params.subject, event.chapter);
    if (snapshot['meridian'] === 'shattered') {
      return {
        id: `thr_miracle_${event.chapter}`,
        type: 'logic_conflict',
        severity: 'critical',
        description: `绝脉体质在第 ${event.chapter} 章突破，缺乏逻辑支撑`,
        closeCondition: {
          requiredEventType: 'ancient_encounter',
          withinChapters: 10
        },
        status: 'UNFILLED',
        closedBy: null,
        createdAtEvent: event.id,
        createdAtChapter: event.chapter,
        direction: 'retroactive',
        milestones: [],
        relatedEntities: [event.params.subject],
        upstreamFactIds: []  // 由 Rule Engine 根据触发 Fact 填充
      };
    }
    return null;
  }
};
```

#### 死亡实体行动约束（ConstraintRule）

```typescript
const deadEntityConstraint: ConstraintRule = {
  id: 'constraint_dead_entity_action',
  description: '已死亡实体不能作为新事件的行动主体',
  check(event: NarrativeEvent, factStore: FactStore): NarrativeThread | null {
    const snapshot = factStore.getSnapshot(event.params.subject, event.chapter);
    if (snapshot['status'] === 'dead') {
      return {
        id: `thr_deadaction_${event.chapter}`,
        type: 'rule_violation',
        severity: 'critical',
        description: `已死亡实体 ${event.params.subject} 在第 ${event.chapter} 章作为事件主体行动`,
        closeCondition: {
          customRule: '需要补充复活事件，或修改死亡事件为其他状态'
        },
        status: 'UNFILLED',
        closedBy: null,
        createdAtEvent: event.id,
        createdAtChapter: event.chapter,
        direction: 'retroactive',
        milestones: [],
        relatedEntities: [event.params.subject],
        upstreamFactIds: []
      };
    }
    return null;
  }
};
```

#### 双向敌对关系推理（InferenceRule）

```typescript
const bidirectionalEnemyRule: InferenceRule = {
  id: 'inference_bidirectional_enemy',
  description: '敌对关系是双向的，A 视 B 为敌，B 也视 A 为敌',
  infer(newFact: Fact, factStore: FactStore): Fact[] {
    if (newFact.predicate !== 'enemy_of') return [];

    const targetEntityId = (newFact.value as EntityRef).entityId;

    // 检查反向关系是否已存在
    const alreadyExists = factStore.query({
      subject: targetEntityId,
      predicate: 'enemy_of',
      atChapter: newFact.validFrom
    }).some(f => (f.value as EntityRef)?.entityId === newFact.subject);

    if (!alreadyExists) {
      return [{
        subject: targetEntityId,
        predicate: 'enemy_of',
        value: { type: 'entity_ref', entityId: newFact.subject } as EntityRef,
        certainty: 'canonical',
        causeEvent: newFact.causeEvent,
        validFrom: newFact.validFrom,
        validTo: null,
        context: 'global',
        embeddingText: '' // FactStore.assert 时由 FactEmbedder 填充
      } as Omit<Fact, 'id' | 'embeddingText'>];
    }
    return [];
  }
};
```

#### 示例四：诡秘之主世界观——序列扮演副作用检测（TransitionRule）

```typescript
// 诡秘之主：角色扮演序列魔药后，如果行为不符合该序列的"扮演守则"，产生回溯型线索
const actingDeviationRule: TransitionRule = {
  id: 'rule_acting_deviation',
  description: '序列扮演者行为偏离扮演守则，将积累精神污染',
  check(event: NarrativeEvent, factStore: FactStore): NarrativeThread | null {
    if (event.type !== 'acting_deviation') return null;

    const snapshot = factStore.getSnapshot(event.params.subject, event.chapter);
    // 检查该角色是否处于序列扮演中
    if (snapshot['acting_progress'] && snapshot['acting_progress'] !== 'complete') {
      return {
        id: `thr_acting_${event.chapter}`,
        type: 'rule_violation',
        severity: 'major',
        description: `${event.params.subject} 在第 ${event.chapter} 章偏离扮演守则，精神污染积累`,
        closeCondition: {
          customRule: '需要通过消化魔药或回归扮演来消除污染'
        },
        status: 'UNFILLED',
        closedBy: null,
        createdAtEvent: event.id,
        createdAtChapter: event.chapter
      };
    }
    return null;
  }
};
```

#### 示例五：现代都市世界观——身份暴露检测（TransitionRule）

```typescript
// 现代都市异能：角色在公开场合使用超能力，产生身份暴露线索
// 注意：此规则只检查客观条件（是否有非异能者在场），不读取 Knowledge。
// "目击者是否已经知道主角是异能者"属于认知判断，由 LLM 在读取流处理。
const identityExposureRule: TransitionRule = {
  id: 'rule_identity_exposure',
  description: '在公开场合使用超能力将触发身份暴露风险',
  check(event: NarrativeEvent, factStore: FactStore): NarrativeThread | null {
    if (event.type !== 'use_ability') return null;

    // 检查场景中是否有非异能者实体（客观条件：location 匹配 + kind 排除已知异能者组织成员）
    // 只做客观状态检查，不读取 KnowledgeStore（遵守 I-10）
    const subjectLocation = factStore.query({
      subject: event.params.subject,
      predicate: 'location',
      atChapter: event.chapter
    })[0];
    if (!subjectLocation) return null;

    const sameLocationEntities = factStore.query({
      predicate: 'location',
      atChapter: event.chapter
    }).filter(f =>
      f.subject !== event.params.subject
      && f.value === subjectLocation.value
      // 排除已注册为异能者组织成员的实体（通过客观 Fact 判断，非认知判断）
      && !factStore.query({
        subject: f.subject,
        predicate: 'faction',
        atChapter: event.chapter
      }).some(r => r.value === 'ability_user_org')
    );

    if (sameLocationEntities.length > 0) {
      return {
        id: `thr_exposure_${event.chapter}`,
        type: 'foreshadowing',
        severity: 'major',
        description: `${event.params.subject} 在 ${sameLocationEntities.length} 个非异能者面前使用了超能力`,
        closeCondition: {
          customRule: '需要消除目击者的记忆或公开身份'
        },
        status: 'PLANTED',
        closedBy: null,
        createdAtEvent: event.id,
        createdAtChapter: event.chapter
      };
    }
    return null;
  }
};
```

### 5.5 沙盒推演流程

```
1. 从 FactStore 读取当前状态快照（只读，通过 atChapter 切片，不克隆整个存储）
2. 依次执行 Transition Rules → 收集违规/伏笔产生的 NarrativeThread
3. 依次执行 Inference Rules → 收集推导出的新 Fact（certainty = 'potential'）
4. 依次执行 Constraint Rules → 收集约束违规 Thread
5. 依次执行 Propagation Rules → 收集建议的 Knowledge 条目（见 5.6）
6. 打包为 EventConsequence（含 proposedKnowledge）返回
7. 真实 FactStore / KnowledgeStore 全程不变
```

**⚠ 执行顺序是架构约束（不可调整）**：Transition → Inference → Constraint → Propagation
这个顺序是硬性要求，原因：
- Inference Rules 的产出（新 Fact）必须参与 Constraint Rules 的约束检查。
  例如推理规则推导出"A 死亡"，约束规则才能检查"A 死亡与其他 Fact 是否冲突"。
  如果 Inference 和 Constraint 顺序反转会漏检此类冲突。
- Propagation Rules 放在最后，因为它只推导知识传播建议（ProposedKnowledge），
  不影响 Fact 状态，不需要参与约束检查。
- Transition Rules 放在最前，因为它生成的新 Thread 可能影响后续规则的行为
  （如某些 Propagation Rule 会检查"是否有未关闭的身份暴露 Thread"）。

**Inference Rule 链式推理策略**：推理规则支持迭代执行直至收敛——
第 1 轮的推理产出（新 Fact）作为第 2 轮的输入，直到没有新产出或达到深度上限。
深度控制由 `computeConsequences` 内部的迭代循环保证：

```
maxInferenceDepth = 10  // 单次推理最大深度（§5.2 复杂度预算）
for (depth = 0; depth < maxInferenceDepth; depth++):
    newFactsThisRound = []
    for each inferenceRule:
        inferred = inferenceRule.infer(newFactsFromLastRound, factStore)
        newFactsThisRound.push(...inferred)
    if newFactsThisRound.length == 0:
        break  // 收敛，无新产出
    newFactsFromLastRound = newFactsThisRound
```

**Phase B 中 validateConsistency 的语义**：`Rule Engine.validateConsistency()` 出现在
Phase B 事务内、audit_log 写入之前，但它的角色是**诊断性后验审计**（diagnostic post-hoc audit），
**不是**阻塞性二次校验。原因：
- 真正的约束检查已在 Phase A 沙盒推演中的 Constraint Rules 完成
- Phase B 是确定性写入阶段，如果 Phase A 的校验通过，Phase B 不应因约束问题回滚
- validateConsistency 发现的违规写入 audit_log（severity='warning'），供事后审查
- 如果需要阻塞性校验，应将约束前置到 Phase A 的 Constraint Rules 中

**推理规则 Fact 的提升时机**：`propose_event` 返回的 `EventConsequence` 中，
推理规则产生的 Fact 标记为 `certainty = 'potential'`。当作者调用 `commit_event` 确认提交时，
这些 potential Fact **随主 FactGroup 一起原子提升为 `canonical`**，作为 FactGroup 的一部分
一并写入 FactStore。以双向敌对关系为例：A 敌对 B 被确认提交后，B 敌对 A 的推理 Fact
也自动生效，无需作者单独确认。这是 设计选择——推理规则被视为系统自动推导的确定性逻辑，
不属于需要人工裁决的范畴。

**推理 Fact → FactGroup 的转化步骤**（commit_event 处理层执行）：

```
commit_event 处理流程中的推理 Fact 提升路径：

  1. 从 ProposalStore 取出 ProposalResult
  2. 从 EventConsequence.generatedFacts 提取 certainty='potential' 的推理 Fact
  3. 为每个推理 Fact 构造 FactChangeInput：
     {
       op: 'assert',
       change_id: 'inferred_' + fact.id,  // 使用 'inferred_' 前缀区分推理 Fact 与 LLM 提交的 Fact
       payload: { ...fact, certainty: 'canonical' }  // 提升为 canonical
     }
  4. 追加到原始 FactGroup.changes 数组末尾（推理 Fact 在 LLM FactChange 之后写入）
  5. 传递给 applyFactGroup 一并写入，返回的 idMap 中包含推理 Fact 的 changeId→factId 映射
  6. PropagationRule 对推理 Fact 的 knowledge 传播与主 Fact 遵循相同规则

  注意：如果推理 Fact 的 subject+predicate+context 与已有的 canonical Fact 冲突
  （如双向关系中 B→A 已存在），applyFactGroup 的幂等设计会忽略重复 assert，
  idMap 中记录实际存在的 factId（非新插入的 ID）。
```

### 5.6 Propagation Rules：知识传播规则

新增的第四类规则，负责从事件 + 当前实体关系推导"谁在事件后知道了什么"。

**设计哲学**：知识传播在本质上与 Fact 推理是同一类问题——Inference Rules 推导"世界还发生了什么"，Propagation Rules 推导"谁知道世界发生了什么"。两者共享沙盒推演流程，结果合并到同一个 EventConsequence 中。

```typescript
// 知识传播规则接口
interface PropagationRule {
  id: string;
  description: string;

  // 给定事件 + FactGroup（FactChange 列表）+ 当前 FactStore，
  // 返回建议创建的 Knowledge 条目列表。
  // 注意：NarrativeEvent 只持有 factGroupId（非 factGroup 对象），
  // 因此 PropagationRule 需要额外的 factGroup 参数来访问 FactChange 内容。
  // 注意：propagate 不接收 knowledgeStore 参数——传播规则基于客观状态推导，
  // 不依赖已有认知记录。去重逻辑在 commit_event 处理层统一执行。
  propagate(
    event: NarrativeEvent,
    factGroup: FactGroup,       // ← FactChange 列表，用于构建 changeId 映射
    factStore: FactStore
  ): ProposedKnowledge[];
}

// 沙盒推演产出的建议知识条目（需作者在审计报告中确认）
interface ProposedKnowledge {
  entityId: string;           // 谁获得了新知识
  changeId: string;           // 对应 FactChangeInput.change_id（稳定引用，非数组下标）
  source: KnowledgeSource;    // 知识来源（见 3.6）
  confidence: number;         // 确信度
  reason: string;             // 推导理由（展示在审计报告中，如"该角色与事件主体同在古墓"）
}
```

#### 传播规则

**规则一：事件主体自动知晓（subject_auto）**

```typescript
const subjectAutoPropagation: PropagationRule = {
  id: 'propagation_subject_auto',
  description: '事件主体自动获得事件产生的所有 Fact 的知识（self_action, confidence=1.0）',

  propagate(event: NarrativeEvent, factGroup: FactGroup): ProposedKnowledge[] {
    const results: ProposedKnowledge[] = [];
    // 事件主体对其参与的所有 FactChange 自动知晓
    for (const change of factGroup.changes) {
      results.push({
        entityId: event.params.subject,
        changeId: change.changeId,  // 通过 changeId 稳定引用
        source: 'self_action',
        confidence: 1.0,
        reason: `${event.params.subject} 是事件主体，亲身参与`
      });
    }
    return results;
  }
};
```

**规则二：同场景实体目击传播（witness_propagation）**

```typescript
const witnessPropagation: PropagationRule = {
  id: 'propagation_witness',
  description: '与事件主体在同一地点的实体自动目击事件（witnessed, confidence=0.8）',

  propagate(event: NarrativeEvent, factGroup: FactGroup, factStore: FactStore): ProposedKnowledge[] {
    const results: ProposedKnowledge[] = [];
    const subjectLocation = factStore.query({
      subject: event.params.subject,
      predicate: 'location',
      atChapter: event.chapter
    })[0];

    // L7 边界条件：如果事件主体没有 location Fact（新角色刚注册、location 被 retract），
    // subjectLocation 为 undefined，直接返回空结果——没有位置信息就不传播。
    // 这在语义上是正确的（"不知身在何处"自然无法"目击"）。
    // 对于远程观察能力（如天眼通），不通过 witness_propagation 实现，
    // 而是通过 knowledge_hints 手动覆盖。
    if (!subjectLocation) return results;

    // 查找同一地点的其他实体
    // 注意：使用 sameValue() 而非 === 比较，因为 location 值可能是 EntityRef 对象
    const sameLocationFacts = factStore.query({
      predicate: 'location',
      atChapter: event.chapter
    }).filter(f =>
      sameValue(f.value, subjectLocation.value)  // ← 语义等价比较，非引用比较
      && f.subject !== event.params.subject
    );

    for (const locFact of sameLocationFacts) {
      for (const change of factGroup.changes) {
        results.push({
          entityId: locFact.subject,
          changeId: change.changeId,
          source: 'witnessed',
          confidence: 0.8,
          reason: `${locFact.subject} 与事件主体同在 ${formatFactValue(subjectLocation.value)}`
        });
      }
    }
    return results;
  }
};
```

**FactValue 比较工具函数**：由于 `FactValue` 可以是 `EntityRef` 对象（如 `{ type: 'entity_ref', entityId: 'ent_gumu' }`），`===` 比较的是对象引用地址而非语义等价性。所有 FactValue 比较必须通过以下工具函数：

```typescript
// types.ts 中定义的 FactValue 语义等价比较
function sameValue(a: FactValue, b: FactValue): boolean {
  if (a === b) return true;                              // 标量或同一引用
  if (typeof a !== 'object' || typeof b !== 'object') return false;
  if (!a || !b) return false;
  // EntityRef 语义等价：比较 entityId
  return (a as EntityRef).entityId === (b as EntityRef).entityId;
}
```

**传播级联控制**：不自动级联——传播规则只在当前 `commit_event` 的沙盒中运行一次。二次传播（"B 被告知后，B 又告诉 C"）需要作者发起新的 `propose_event`，让传播规则在下一轮重新计算。这保证了每次传播都有作者可见的审计记录。

**合并去重规则**：当 Propagation Rules、LLM knowledge_broadcast、LLM knowledge_hints 三者对同一 `(entityId, changeId)` 给出不同建议时，按 3.6 节定义的优先级合并——高优先级覆盖低优先级。

**⚠ knowledge_hints 的 factIndex→changeId 转换**：
KnowledgeHint 使用 `factIndex?: number`（fact_changes 数组下标）引用目标 FactChange，
而 ProposedKnowledge 使用 `changeId: string`（FactChangeInput.change_id）。
两者是不同的引用机制，合并前必须统一为 changeId：

```
转换步骤（commit_event 处理层，合并知识建议之前执行）：
  1. 构建 factIndex → changeId 映射表：
     const indexMap = new Map<number, string>();
     proposal.fact_changes.forEach((fc, i) => indexMap.set(i, fc.change_id));

  2. 将 KnowledgeHint 转换为 ProposedKnowledge 格式：
     for each hint in knowledge_hints:
       changeId = hint.factIndex !== undefined
         ? indexMap.get(hint.factIndex)     // factIndex → changeId
         : undefined;                       // 无 factIndex 的 hint 不参与去重
       convertedHints.push({
         entityId: hint.entityId,
         changeId: changeId!,
         source: hint.source,
         confidence: hint.confidence,
         reason: '作者显式指定'
       })

  3. 合并去重：按 (entityId, changeId) 分组，高优先级覆盖低优先级
     优先级：knowledge_hints > knowledge_broadcast > PropagationRule
```

**retract 操作与 PropagationRule 的交互**：
retract 不产生新 Fact，其 changeId 映射到 targetFactId（见 applyFactGroup 映射规则）。
PropagationRule 的 `propagate()` 方法在内部**过滤掉 op='retract' 的 change**——
只有 assert 和 update 会触发知识传播。retract 操作对被撤销 Fact 的 Knowledge 不做自动处理
（Knowledge 指向的 Fact 仍存在，只是 validTo 被设置）；如果需要角色"遗忘"，
应通过 knowledge_changes(op='seal') 显式封印。

---

## 6. NarrativeThread：叙事线索系统

### 6.1 ThreadResolver

```typescript
interface ThreadResolver {
  // 新事件提交后，扫描所有未关闭线索，判断是否满足关闭条件
  // 整合自动关闭和显式关闭两个通道（见 6.2.1 双通道说明）
  resolveThreads(
    newEvent: NarrativeEvent,
    allThreads: NarrativeThread[],
    explicitResolutionIds?: string[]  // 来自 propose_event 的 thread_resolutions 参数
  ): {
    resolved: NarrativeThread[];       // 被本次事件关闭的线索
    stillOpen: NarrativeThread[];      // 仍未关闭的线索
  };

  // 检查即将超期的回溯型线索（距截止章节 <= 5 章）
  getExpiringThreads(
    allThreads: NarrativeThread[],
    currentChapter: number,
    warningWindow?: number
  ): NarrativeThread[];

  // 渐进型线索：检查可以被暗示或揭示的伏笔
  getHintableThreads(
    allThreads: NarrativeThread[],
    newEvent: NarrativeEvent
  ): NarrativeThread[];
}
```

### 6.2 关闭判定逻辑

```typescript
function isThreadClosable(thread: NarrativeThread, event: NarrativeEvent): boolean {
  if (thread.status !== 'UNFILLED' && thread.direction === 'retroactive') return false;
  if (thread.direction === 'progressive'
      && thread.status !== 'PLANTED'
      && thread.status !== 'HINTED'
      && thread.status !== 'PARTIALLY_REVEALED') {
    return false;
  }

  const { closeCondition } = thread;

  // 检查事件类型是否匹配
  if (closeCondition.requiredEventType
      && event.type !== closeCondition.requiredEventType) {
    return false;
  }

  // 检查是否在章节时限内
  if (closeCondition.withinChapters
      && event.chapter > thread.createdAtChapter + closeCondition.withinChapters) {
    return false;
  }

  // 渐进型线索：检查最低暗示次数（minHints）
  // PARTIALLY_REVEALED 状态已隐含满足暗示要求，无需再检查
  if (thread.direction === 'progressive'
      && thread.status !== 'PARTIALLY_REVEALED'
      && closeCondition.minHints) {
    const hintCount = thread.milestones.filter(m => m.status === 'HINTED').length;
    if (hintCount < closeCondition.minHints) {
      return false;
    }
  }

  // customRule 分支：标记为"需人工确认"的线索不走自动关闭通道（6.2.1 显式关闭）。
  // 注意：此 return false 不影响 minHints 的语义——minHints 的计数在 addMilestone 时已通过
  // hint_count 字段维护（见 threads 表），customRule 的存在只是将关闭方式从"自动"改为"手动"。
  if (closeCondition.customRule) {
    return false;
  }

  return true;
}
```

#### 6.2.1 双通道关闭机制

`commit_event` 处理时存在两条并行的线索关闭通道，共同决定哪些未关闭线索被填补或回收：

```
commit_event 处理流程中的线索关闭：

  通道一：自动关闭（isThreadClosable）
    FOR EACH open_thread IN ThreadStore.getOpen()：
      IF isThreadClosable(open_thread, newEvent)：
        → 自动标记 FILLED，closedBy = newEvent.id
    适用场景：requiredEventType + withinChapters 条件明确匹配的回溯型线索

  通道二：显式关闭（thread_resolutions）
    FOR EACH thread_id IN proposal.thread_resolutions：
      thread = ThreadStore.getById(thread_id)
      IF thread.status IN ['UNFILLED', 'PLANTED', 'HINTED']：
        → 回溯型：标记 FILLED，closedBy = newEvent.id
        → 渐进型：追加 RESOLVED Milestone，closedBy = newEvent.id
        （作者显式声明，跳过 closeCondition 检查）
      ELSE：
        → 返回 ToolError(THREAD_ALREADY_CLOSED)
    适用场景：customRule 类型线索、closeCondition 不精确匹配但作者认为已关闭

  合并结果：
    resolved = 通道一结果 ∪ 通道二结果
    两条通道互补，不互斥——同一条线索可以同时满足两个通道
```

**关键设计决策**：`customRule` 类型的线索（如"需要补充复活事件"）在自动通道走不通（`isThreadClosable` 对 `customRule` 固定返回 false），**只能通过显式通道关闭**。作者在 `propose_event` 里把 thread_id 放进 `thread_resolutions` 就是在说"我知道这条线索存在，我选择用这个事件填补它"。这保证了作者对模糊条件的最终裁决权。

**`resolve_thread` 工具的关系**：`resolve_thread`（Tool 6）是第三条独立的关闭路径——事后手动关闭，不绑定任何 `propose_event`。适用于"这条线索在 3 章前就被填了但我当时忘了声明"的场景。三条路径最终效果一致：回溯型 `thread.status = 'FILLED'`，渐进型 `thread.status = 'RESOLVED'`。

```
回溯型：
  UNFILLED → FILLED     （自动关闭：满足 closeCondition）
  UNFILLED → FILLED     （显式关闭：thread_resolutions 或 resolve_thread）
  UNFILLED → ABANDONED  （作者显式放弃）
  UNFILLED → OBSOLETE   （上游 Fact 被 Retcon 标记）
  FILLED   → UNFILLED   （关闭事件被 Retcon 撤回）

渐进型：
  PLANTED  → HINTED     （自动/显式暗示）
  HINTED   → HINTED     （多次暗示，追加 Milestone）
  HINTED   → RESOLVED   （自动/显式回收）
  PLANTED  → RESOLVED   （直接回收）
  任意     → ABANDONED  （作者放弃）
  任意     → OBSOLETE   （上游依赖断裂）
```

### 6.3 叙事线索与写作流程的集成

在 LLM 每次开始写一章正文之前，系统在读取流中自动注入当前所有未关闭的叙事线索，提醒作者：

```markdown
## 📋 未关闭叙事线索（当前第250章）

| ID | 类型 | 方向 | 描述 | 关闭条件 | 产生章节 | 截止章节 |
|----|---------|------|---------|---------|---------|
| thr_miracle_50 | critical | 绝脉体质突破，缺逻辑 | encounter | 第50章 | 第60章 |
| thr_lostsword_200 | major | 诛仙剑下落不明 | recovery | 第200章 | 第250章 |
```

---

## 7. Semantic Retrieval Layer：语义检索层

### 7.1 这一层解决的根本问题

Pull 模式存在一个无法克服的矛盾：**LLM 不知道自己不知道什么。**

第 250 章写到一个剑法，LLM 不会主动去查"这个剑法在第 12 章有没有设定来源"，因为它不知道应该查。在设定量超过 LLM 上下文窗口（约 100 条 Fact 即开始退化）后，Pull 模式的一致性保障形同虚设。

**语义检索层的解法**：不等 LLM 来问，系统先把相关 Fact 找出来，在 LLM 写作前强制注入到上下文。

### 7.2 组件设计

#### 7.2.1 FactEmbedder

把 Fact 转化为可向量化的文本表示，调用硅基流动 BAAI/bge-m3 模型生成 Embedding，写入 LanceDB。

**Embedding 模型**：硅基流动 BAAI/bge-m3（1024 维，免费 API），通过标准 HTTP fetch 调用。

```typescript
interface FactEmbedder {
  // 生成 embeddingText（根据 fact + 实体名称映射表）
  generateEmbeddingText(fact: Fact, entityNames: Record<string, string>): string;

  // 批量向量化并写入 LanceDB（FactStore 写入后异步调用）
  embedAndIndex(facts: Fact[]): Promise<void>;

  // 标记失效（Fact retract 后调用，更新 LanceDB 中的 is_current = false）
  // 注意：此方法委托给 VectorStore.markInvalid 执行实际的 LanceDB 写入。
  // FactEmbedder 作为业务层入口，负责构造查询参数（factId → LanceDB 行定位）；
  // VectorStore 作为存储适配器，负责执行具体的 LanceDB update 操作。
  // 调用方只需调用 FactEmbedder.markInvalid，不应直接调用 VectorStore.markInvalid。
  markInvalid(factId: string, validTo: number): Promise<void>;
}
```

**embeddingText 生成实现**：

```typescript
function generateEmbeddingText(
  fact: Fact,
  entityNames: Record<string, string>
): string {
  const subjectName = entityNames[fact.subject] ?? fact.subject;
  const predicateZh = PREDICATE_ZH_MAP[fact.predicate] ?? fact.predicate;

  if (isEntityRef(fact.value)) {
    const targetName = entityNames[fact.value.entityId] ?? fact.value.entityId;
    return `${subjectName} 与${targetName}的关系是 ${predicateZh}（第${fact.validFrom}章）`;
  }

  return `${subjectName} 的${predicateZh}是 ${fact.value}（第${fact.validFrom}章）`;
}

// 谓词中文映射
const PREDICATE_ZH_MAP: Record<string, string> = {
  realm: '修炼境界',
  meridian: '经脉状态',
  hp: '生命值',
  status: '当前状态',
  bloodline: '血脉',
  location: '位置',
  enemy_of: '敌对关系',
  disciple_of: '师承关系',
  holds_item: '持有物品',
  alignment: '阵营',
  // ... 更多在 World Package 中扩展
};
```

#### 7.2.2 ContextAnalyzer

分析当前写作上下文，提取语义查询信号。

```typescript
interface ContextAnalyzer {
  analyze(context: WritingContext): ContextSignals;
}

// ContextAnalyzer 有两种实现策略，按场景自动切换：
//
// 1. 规则化快速路径（不调用 LLM，<5ms）：
//    - entityIds 直接取自 sceneEntityIds（作者手动指定 + commit_event 副作用维护）
//    - semanticQueries 用模板化规则生成（World Package 中的查询模板 + 变量替换）：
//      示例模板：["${entityName}的当前${predicateZh}", "${entityName}与${outline关键词}相关的设定"]
//      实际输出：["张三的当前修炼境界", "张三与阵法相关的设定"]
//      模板来源：World Package 的 contextQueryTemplates 配置项（默认提供通用模板，
//      题材包可覆盖）。模板变量包括 entityName、predicateZh、chapter、outlineKeywords。
//    - temporalFocus 直接取 chapterNumber
//    - 覆盖 80% 的常规写作场景
//
// 2. LLM 深度分析（调用轻量 LLM，~200-500ms）：
//    - 仅在 authorIntent 存在或大纲语义复杂时触发
//    - 输出更精准的 semanticQueries
//    - 覆盖 20% 的复杂场景（多线交织、伏笔回收、认知不对称叙事）
//
// 关键：ContextAnalyzer 的调用结果应异步预生成并缓存。
// 章节/大纲确定时就跑一次，缓存 ContextSignals。
// get_context_slice 直接读缓存，不等待 ContextAnalyzer 执行。
// 这样 ContextAnalyzer 完全移出热路径（见 §11.7 Latency Budget）。
```

interface WritingContext {
  chapterNumber: number;
  chapterOutline: string;          // 本章大纲（约 200 字）
  sceneEntityIds: string[];        // 场景中出现的实体 ID（已知）
  recentParagraphs?: string;       // 最近写的段落（约 500 字，可选）
  authorIntent?: string;           // 作者这一章的写作意图（可选）
  currentScope?: string;           // 当前作用域（见 3.4.1），默认 'global'
  povEntityId?: string;            // 角色视角实体 ID；非 undefined 时 Step 5 知识感知过滤激活
}

// sceneEntityIds 的来源（按优先级）：
// 1. 作者在写作界面手动指定的出场角色/地点（最可靠）
// 2. 系统 commit_event 的副作用自动维护——每个 commit_event 的 params.subject
//    及 EventParams 中引用的实体 ID 自动追加到当前章节的"活跃实体列表"
// 3. 以上两者合并去重后作为 sceneEntityIds 传入
// 当前不做 NER（命名实体识别），依赖作者手动 + commit_event 副作用维护

interface ContextSignals {
  entityIds: string[];             // 需要精确查询的核心实体
  semanticQueries: string[];       // 用于向量检索的自然语言查询串（3-5 条）
  temporalFocus: number;           // 主要关注哪个章节时间点
}
```

**ContextSignals 生成示例**：

```
输入：
  chapter: 250
  outline: "张三进入古墓，发现壁画，意外激活阵法"
  sceneEntityIds: ['ent_zhangsan', 'ent_gumu']

输出：
  entityIds: ['ent_zhangsan', 'ent_gumu']
  semanticQueries: [
    "张三当前的修炼境界和身体状态",
    "古墓的来历和相关设定",
    "张三与阵法相关的历史和能力",
    "激活阵法的条件和禁忌"
  ]
  temporalFocus: 250
```

**实现**：ContextAnalyzer 由一次轻量 LLM 调用实现，给定写作上下文，输出 JSON 格式的 ContextSignals。不需要复杂的 NLP 管道。

**延迟预算与缓存策略**：

读取流的完整链路延迟预估：

```
ContextAnalyzer（LLM 调用）    ~1-2s
Embedding（3-5 条 × API）      ~0.5-1s（批量接口）
LanceDB 检索（3-5 条 × K=5）  ~0.1-0.3s（本地）
SQLite 精确查询（N 实体）       ~0.01s（本地）
FactRenderer 渲染               ~0.01s
─────────────────────────────────
总计                           ~1.6-3.3s
```

**章节级缓存**：同一章写作过程中，章节大纲和出场实体基本不变，
ContextAnalyzer 的分析结果可以跨段落复用，跳过 LLM 调用，节省 1-2 秒和一次 API 开销。

```typescript
interface ContextCache {
  // 缓存键构造规则（确定性，无碰撞）：
  //   key = `${chapter}:${entityIds.sort().join('|')}`
  //   示例："250:ent_gumu|ent_zhangsan"
  // entityIds 数量通常 < 10，排序后 join 的性能开销可忽略。
  // entity ID 是唯一前缀字符串（ent_），碰撞概率为零。
  get(chapter: number, entityIds: string[]): ContextSignals | null;
  set(chapter: number, entityIds: string[], signals: ContextSignals): void;
  // commit_event 成功后使当前章节缓存失效，保证下次检索反映最新状态
  invalidate(chapter: number): void;
}
```

**缓存生命周期**：

```
第 1 段写作前：
  写作上下文 = { chapter: 250, entities: [张三, 古墓] }
  → ContextAnalyzer 分析（LLM 调用）→ 拿到查询信号
  → 缓存结果，key = "250:ent_gumu|ent_zhangsan"

第 2 段写作前：
  写作上下文 = { chapter: 250, entities: [张三, 古墓] }
  → 缓存命中 → 跳过 LLM 调用，直接用上次的查询信号
  → 后续检索仍然执行（LanceDB + SQLite），确保拿到最新 Fact

第 N 段后 commit_event 成功（张三被阵法束缚）：
  → 缓存失效（第 250 章的缓存被清除）
  → 下次读取流重新分析，反映"张三被束缚"后的新状态
```

**设计要点**：
- 缓存只跳过 ContextAnalyzer（最慢的环节），后续的 LanceDB 检索和 SQLite 查询每次都执行
- 失效条件是 `commit_event`（世界状态实际改变了），而不是"段落变了"
- 同一章内，出场实体列表变化时（新角色登场），entityIds 不同（排序 join 后的 key 不同），自然产生新的缓存条目

#### 7.2.3 RelevantFactRetriever

结合 LanceDB 向量检索和 FactStore 精确查询，获取最相关的 Fact 集合。

```typescript
interface RelevantFactRetriever {
  retrieve(
    signals: ContextSignals,
    factStore: FactStore,
    options?: RetrievalOptions
  ): Promise<RelevantFactSet>;
}

interface RetrievalOptions {
  topK?: number;              // 语义检索返回数量，默认 20
  includeRelations?: boolean; // 是否包含关系 Fact，默认 true
  atChapter?: number;         // 时间切片（默认 signals.temporalFocus）
}

interface RelevantFactSet {
  // 精确查询：场景实体的完整状态快照
  entitySnapshots: Record<string, Record<string, FactValue>>;

  // 精确查询：场景实体的关系 Fact
  entityRelations: Fact[];

  // 语义检索：与写作上下文语义相关的其他 Fact
  semanticFacts: Fact[];

  // 当前未关闭的叙事线索
  openThreads: NarrativeThread[];

  // 角色知识状态（每个场景实体知道什么）
  entityKnowledge: Record<string, Knowledge[]>;
}
```

**六段检索管线（Step 0~5，含短期记忆兜底与知识感知过滤）**：

```
Step 0：短期工作记忆强制注入（Recent Events Force-Inject）
  → 从 SQLite facts 表直接拉取最近章节的所有 canonical Fact
  → 不经过 LanceDB，不依赖向量同步状态
  → 拼入结果集，标记来源为 'recent_event'

  SQL 查询模板（精确语义：拉取"当前章节 + 上一整数章节"范围内产生的 canonical Fact）：
    SELECT * FROM facts
    WHERE certainty = 'canonical'
      AND is_current = 1
      AND valid_from >= :floorChapterMinus1
      AND valid_from <= :currentChapter
    ORDER BY valid_from DESC
  其中 :floorChapterMinus1 = FLOOR(currentChapter) - 1
  示例：currentChapter=49.5 → 拉取 valid_from ∈ [48, 49.5] 的 canonical Fact

  ⚠ 章节范围语义说明：
    "上一章"定义为 FLOOR(currentChapter) - 1，而非 currentChapter - 1。
    这样当 currentChapter=49.5 时，拉取范围是 [48, 49.5]，覆盖第 48 章到 49.5 章的全部 Fact，
    不会遗漏 48.1~49 章之间的内容。当 currentChapter=50（整数）时，拉取范围是 [49, 50]，
    等价于"上一章 + 本章"。

  ⚠ Knowledge 感知边界：Step 0 注入的 Fact 不区分角色可见性（因为是客观事实拉取）。
  知识感知过滤发生在 Step 5，届时会根据当前视角实体过滤掉该角色不应知晓的 Fact。
  因此 Step 0 与 Step 5 必须配合使用——单独依赖 Step 0 会导致信息泄露。
  为什么需要这一步：LanceDB 向量同步是异步的（§4.5），commit_event 成功后
  向量可能尚未就绪。如果没有这个兜底，LLM 会"失忆"——"韩立刚捡到的神秘小瓶，
  下一句就忘了"。Step 0 保证 LLM 拥有可靠的短期工作记忆，
  无论 LanceDB 同步是否有延迟。

  ⚠ LanceDB 竞态补充：Step 0 只拉取 is_current=1 的 canonical Fact。
  对于"非场景实体的新 Fact"（如新引入的宝箱），如果 LanceDB 尚未同步且该实体不在
  sceneEntityIds 中，Step 0 不会拉取，Step 2 也搜不到（向量未同步）。
  这个盲区在实际使用中影响有限：(1) Phase C 通常在几百毫秒内完成同步；
  (2) 如果 semanticQueries 包含相关关键词，下次检索会命中已同步的向量；
  (3) 作者可以通过 get_context_slice 手动查询。对于更严格的兜底，可以在内存中
  维护一个最近 N 条 commit 产生的 Fact ID 缓冲区（recentCommitsRingBuffer），
  在 Step 2 之前先检查这些 Fact 是否已在 LanceDB 中，缺失则从 SQLite 补充。

Step 1：精确检索（高优先级）
  对 signals.entityIds 中的每个实体：
    → FactStore.getSnapshot(entityId, atChapter)   // 属性快照
    → FactStore.getRelationsTargeting(entityId)    // 关系 Fact
  结果：完整的实体状态（含 context 信息，供 Step 4 作用域优先级去重使用）

Step 2：语义检索（补充上下文）
  对 signals.semanticQueries 中的每条查询：
    → 调用 EmbeddingService.embed() 将自然语言查询串转化为 1024 维向量
    → 注意：查询向量来自 ContextAnalyzer 生成的自然语言文本，
      而 Fact 的索引向量来自 Fact.embeddingText（半结构化文本）。
      两者文本域不同——bge-m3 在跨域检索（自然语言查询 vs 半结构化文本）上的
      效果需在 Phase 0.5 Spike 1 中验证。
    → LanceDB Table.search(queryVector)
        .where(contextFilter)
        .limit(ceil(topK / semanticQueries.length))  // 均匀分配语义检索配额
        .execute()
    → 过滤条件补充 is_current 校验：
      LanceDB .where() 已包含 is_current=true，但向量可能因 Phase C 延迟而未更新。
      对返回结果做二次校验：SQLite 查询 fact.validTo IS NULL 确认仍然有效。
    → 去重：以 Fact.id 为键，过滤掉 Step 0 和 Step 1 已获取的 Fact（精确去重）
    → 作用域处理：contextFilter 同时包含 currentScope 和 'global'，
      如果返回的语义 Fact 与 Step 1 的精确 Fact 在 subject+predicate 上相同但 context 不同，
      Step 4 中按作用域优先级去重（保留局部作用域的那条）。
  结果：语义相关的 Fact（包含 Step 1 未覆盖到的边缘设定）

Step 3：线索注入
  → ThreadStore.getOpen()
  → 过滤规则（形式化）：
    条件一（实体相关）：thread.relatedEntities ∩ signals.entityIds 非空
    条件二（临近截止）：thread.closeCondition.withinChapters 存在
      AND (currentChapter - thread.createdAtChapter) >= withinChapters * 0.8
      （在截止窗口的 80% 位置开始提醒）
    条件三（OBSOLETE 排除）：thread.status ≠ 'OBSOLETE'
    满足条件一 OR 条件二 AND 条件三 的线索被保留
  结果：提醒作者当前未填的叙事承诺

Step 4：排序 + 截断
  → 精确检索结果（Step 1）优先排列，不参与截断
  → 精确检索不计入 topK 配额——它们是"必须有的"场景上下文
  → 语义检索结果（Step 2）按向量相似度降序
  → 短期记忆（Step 0）按 validFrom 降序（最近的排前面）
  → 语义检索 + 短期记忆合计控制在 options.topK（默认 20）以内
  → 作用域优先级去重：当两条 Fact 的 subject+predicate 相同但 context 不同时，
    保留局部作用域（currentScope）的那条，丢弃全局的。

Step 5：知识感知过滤（可选，按需启用）
  对 signals.entityIds 中的每个场景实体：
    → KnowledgeStore.getKnownFacts(entityId, atChapter)
  构建 entityKnowledge 映射
  过滤粒度：整条 Fact 级别——如果角色不知道 Fact A，Fact A 从注入内容中完全移除。
  启用条件：WritingContext.povEntityId 非 undefined 时激活（角色视角写作模式）。
  默认不启用（作者视角可看所有信息）。
  ⚠ 环境类 Fact（如 predicate='location'/'status'）的处理：
    场景内角色默认应知晓环境信息。如果使用知识感知过滤，需要确保环境类 Fact
    通过 witness_propagation 或 knowledge_broadcast 确保场景内角色自动知晓，
    避免"地板有毒但角色看不见"的荒谬场景。
  隐藏其不知晓的 Fact，实现信息不对称的叙事效果。
  默认不启用此过滤（作者视角可看所有信息），仅在角色视角写作时激活。

  **Fact 活性校验（强制）**：Knowledge 记录指向的 Fact 如果 certainty 为
  `contested` 或 `orphaned`，该 Knowledge 条目应当降级处理：
  - contested Fact 的 Knowledge：标记为"待裁决"，注入 LLM 上下文时附带冲突警告
    ⚠ L5 contested 原因事件附加： contested Fact 的检索结果应附带"contested 原因事件"信息，
    从 event_dependencies 表反查（WHERE fact_id = contested_fact_id AND source='retcon_cascade'），
    让 LLM 理解该 Fact 为何处于争议状态，避免基于冲突信息生成新剧情。
  - orphaned Fact 的 Knowledge：完全屏蔽，不注入上下文（指向已废弃事实的认知无意义）
  这不是外键问题（Fact 行不会物理删除），而是检索语义问题——确保 LLM 不会基于
  已失效的 Fact 生成新的剧情内容。

  **关于 non-current Fact（validTo 已设，certainty 仍为 canonical）**：
  scope exit 后作用域内 Fact 的 validTo 被设置，但 certainty 不变。角色对这些 Fact 的
  Knowledge 不会被过滤——"角色记得梦境中发生过的事"是合法叙事需求。LLM 读取流会注入
  这些 Knowledge，由 LLM 根据当前叙事上下文判断是否需要提及。这是设计意图而非遗漏：
  Core 不假设"退出作用域 = 角色遗忘"，遗忘需要显式 KnowledgeChangeInput(op='seal')。
```

### 7.3 主动注入时机

语义检索层在以下时机自动触发，不需要 LLM 主动请求：

| 触发时机 | 注入内容 | 优先级 |
|--------|---------|-------|
| LLM 开始写某章正文前 | 场景实体快照 + 语义相关 Fact + 未关闭线索 | 高 |
| LLM 调用 `propose_event` 前 | 事件相关实体的当前状态 + 相关规则说明 | 高 |
| 提案审计报告生成时 | 违规相关的 Fact 详情 | 中 |
| 作者手动调用 `get_context_slice` | 指定实体的完整档案 | 低（按需） |

> **Retrieval 是 Narrative-OS-Core 的核心成功判定**：FactStore 再正确，如果 RelevantFactRetriever 漏召回，对 LLM 来说等于不存在。Rule Engine 的错误是 Loud Failure（沙盒推演阶段立即暴露），Retrieval 的错误是 Silent Failure（写作完成后读者才发现矛盾），且会级联——基于错误上下文的写作会产生新的错误 Fact，形成恶性循环。因此 Semantic Retrieval Layer 的质量直接决定系统的实际可用性，与 FactStore 构成双核心。

### 7.4 LanceDB Table 设计

```
Table：narrative_facts

Schema：
  id         : string  (PK, = Fact.id)
  vector     : float[1024]  (硅基流动 BAAI/bge-m3 维度)
  subject    : string  (索引，用于按实体过滤)
  predicate  : string  (索引，用于按属性类型过滤)
  valid_from : number  (索引，用于时间范围过滤)
  valid_to   : number | null  (null 表示当前有效，避免魔法数字)
  is_current : boolean (true 表示当前有效，查询过滤用此字段)
  certainty  : string  (索引，只检索 canonical)
  context    : string  (索引，作用域，见 3.4.1，默认 'global')

  ⚠ L3 LanceDB boolean metadata filter 兼容性：
  LanceDB 的 .where() 子句对 boolean 字段的过滤支持需在 Phase 0.5 Spike 2 中验证。
  降级方案：如果 LanceDB 不支持 boolean metadata filter，将 is_current 改为 integer 0/1，
  .where() 条件改为 is_current = 1。Schema 其他部分无需变更。

索引策略：
  vector 字段：IVF_PQ 索引（LanceDB 默认，适合 1024 维向量）
  其他字段：B-Tree 标量索引，用于 metadata filter

典型检索调用：
  // 当 currentScope = 'arc_dream_01' 时，叠加局部 + 全局
  const currentScope = writingContext.currentScope ?? 'global';
  const contextFilter = currentScope === 'global'
    ? "certainty = 'canonical' AND is_current = true AND context = 'global'"
    : `certainty = 'canonical' AND is_current = true AND (context = '${currentScope}' OR context = 'global')`;

  this.lanceTable
    .search(queryVector)
    .where(contextFilter)
    .select(['id', 'subject', 'predicate', 'context'])
    .limit(20)
    .execute()
```

---

## 8. FactRenderer：事实渲染层

### 8.1 定位

FactRenderer 是原 WikiRenderer 的重命名版本。

**重命名原因**："Wiki" 这个名称暗示了读写双向能力（WikiParser + WikiRenderer）。删除 WikiParser 后，保留 WikiRenderer 容易造成架构误解，以为仍有一个 Wiki 协议层作为整体存在。重命名为 FactRenderer 明确它只是一个单向输出层。

**职责**：将 FactStore 中的结构化数据渲染为 LLM 可读的 Wiki Markdown 格式文本。只负责输出，不解析输入。

### 8.2 接口

```typescript
interface FactRenderer {
  // 渲染实体完整档案（注入 LLM 上下文，或响应 get_context_slice 调用）
  renderEntityProfile(
    entityId: string,
    snapshot: Record<string, FactValue>,
    relations: Fact[],
    openThreads: NarrativeThread[],
    atChapter: number,
    entityNames: Record<string, string>
  ): string;

  // 渲染相关 Fact 集合（写作前的主动注入）
  renderRelevantFacts(
    factSet: RelevantFactSet,
    entityNames: Record<string, string>
  ): string;

  // 渲染事件推演的审计报告（响应 propose_event）
  renderSimulationReport(
    proposalId: string,
    consequences: EventConsequence,
    isSafe: boolean
  ): string;

  // 渲染叙事线索清单（响应 get_open_threads）
  renderThreadSummary(threads: NarrativeThread[], currentChapter: number): string;

  // 渲染角色知识视角（某个角色在指定章节知道什么）
  renderKnowledgePerspective(
    entityId: string,
    knowledge: Knowledge[],
    facts: Fact[],
    atChapter: number,
    entityNames: Record<string, string>
  ): string;
}
```

### 8.3 renderEntityProfile 输出示例

```markdown
## 张三（ent_zhangsan）档案 · 第250章视角

### 核心属性

* 修炼境界：金丹期 ← evt_tribulation_50（第50章）
* 经脉状态：碎裂（绝脉）← evt_origin_01（第1章）
* 血脉：太古魔神 ← evt_encounter_55（第55章）
* 当前状态：魔气噬体 ← evt_encounter_55（第55章）
* 生命值：8500 ← evt_battle_200（第200章）

### 关系

* 敌对 → 李四（ent_lisi）← evt_conflict_30（第30章）
* 师承 ← 陈老（ent_chenlao）← evt_apprentice_05（第5章）
* 持有 → 诛仙剑（ent_zhuxianjian）← evt_obtain_120（第120章）

### 📋 未关闭叙事线索

* [critical] thr_miracle_50：绝脉体质在第50章突破，缺乏逻辑支撑
  填补条件：encounter 类型事件 | 截止第60章 | **已超期190章**
```

### 8.4 renderSimulationReport 输出示例

```markdown
## 推演报告 · prp_encounter_250

**状态**：SAFE_TO_COMMIT（含警告）

### 新产生的事实

* 张三 location = 古墓（第250章）← evt_encounter_250_01
* 张三 status = 阵法束缚（第250章）← evt_encounter_250_01

### 产生的叙事线索

（无）

### 推理规则产生的附带事实

（无）

### 警告

* 张三当前处于"魔气噬体"状态，古墓阵法激活可能与魔气产生交互，建议检查相关设定是否有说明

### 操作建议

确认无误后调用 commit_event，传入 proposal_id = "prp_encounter_250"。
```

---

## 9. LLM Tool Interface：工具接口层

### 9.1 写入路径设计说明

早期方案要求 LLM 提交 `wiki_dsl` 字符串，Core 通过 WikiParser 正则解析。这条路径有三个失效点：

1. LLM 偶尔产生格式微偏差（多空格、缺 `<ref>` 标签）导致 silent parse failure
2. 中文值里的全角冒号 `：` 与语法分隔符 `:` 边界情况需要大量特殊处理
3. `~ resolve: thread_id` 等自定义语法的 test coverage 极难写全

最终方案将所有写入参数改为 JSON Schema 结构体，由平台级 JSON Schema Validation 兜底，LLM 只需填写字段，不需要学习 DSL 语法。

### 9.2 工具列表

#### Tool 1：get_context_slice

```typescript
{
  name: "get_context_slice",
  description: "获取特定实体在当前章节的完整状态档案。写作前主动调用以确认相关设定。",
  parameters: {
    entity_id: string;           // 'ent_zhangsan'
    current_chapter: number;
    include_relations?: boolean; // 默认 true
  },
  returns: {
    profile_markdown: string;        // FactRenderer 渲染的实体档案
    fact_index: FactIndexEntry[];    // 底层 Fact 索引（后续 update/retract 的"手术刀柄"）
  }
}

// Fact 索引条目：为 LLM 的 update/retract 操作提供精确的"手术刀柄"
// Core 保证此索引与 profile_markdown 的内容严格对应
interface FactIndexEntry {
  factId: string;               // 如 'fct_encounter_50_02'
  predicate: string;            // 如 'weapon'
  value: string;                // 如 '青竹蜂云剑'（已渲染为可读文本）
  validFrom: number;            // 如 50
  validTo: number | null;       // null = 当前仍有效
  isCurrent: boolean;           // true = 当前活跃状态
  context?: string;             // 所属作用域（非 global 时标注）
  action_hint?: string;         // 给 LLM 的防呆操作提示，如："若要修改此设定，请在 propose_event 中使用 op='update', target_fact_id='fct_...'"
}
```

**ID 传递契约（get_context_slice → propose_event）**：

LLM 是无状态的——它没有持久记忆，无法"记住"某个 Fact ID。因此 `get_context_slice` 返回的 `fact_index` 是 LLM 执行 `update` 或 `retract` 操作时的唯一合法 Fact ID 来源。

规则：
1. LLM 在 `propose_event` 中使用 `op: 'update'` 或 `op: 'retract'` 时，`target_fact_id` 必须从最近一次 `get_context_slice` 或 `propose_event` 返回结果中的 `fact_index` / `new_fact_ids` 提取
2. LLM 严禁凭空捏造 Fact ID。如果 `target_fact_id` 在系统中不存在，Core 返回 `FACT_NOT_FOUND` 错误并附带纠错信息（见 §9.3）
3. `fact_index` 中的 `isCurrent` 字段标记该 Fact 是否为当前活跃状态。对已失效的 Fact（`isCurrent=false`）执行 update/retract 将返回 `FACT_NOT_CURRENT` 错误

#### Tool 2：propose_event

```typescript
{
  name: "propose_event",
  description: "提议一个叙事事件（沙盒预演，不写入世界状态）。返回推演报告供确认后再提交。",
  parameters: {
    event_type: string;              // 'tribulation' | 'ancient_encounter' | ...
    event_description: string;       // 自然语言描述
    chapter: number;
    fact_changes: FactChangeInput[]; // 直接 JSON，无 DSL
    context?: string;                // 作用域（见 3.4.1），默认 'global'，用于副本/梦境等局部设定
    exit_from?: string;              // 退出作用域名称（仅 event_type 为 exit_scope 时使用，见 3.4.1）
    thread_resolutions?: string[];    // 要关闭的线索 ID（可选）
    knowledge_hints?: KnowledgeHint[]; // 知识可见性细粒度推断（可选，见 3.6）
    knowledge_broadcast?: KnowledgeBroadcast; // 知识可见性粗粒度广播（可选，见 3.6）
    knowledge_changes?: KnowledgeChangeInput[]; // 认知层显式操作（封印/搜魂/植入/衰退/恢复，可选，见 3.6）
    dependent_fact_ids?: string[];   // 依赖的前置 Fact ID（可选，见下方说明）
  },
  returns: {
    proposal_id: string;
    is_safe_to_commit: boolean;
    simulation_report_markdown: string;
  }
}

// 知识可见性细粒度推断（LLM 在 propose_event 中提供，Core 合并自动推断）
interface KnowledgeHint {
  entityId: string;        // 谁获得了新知识
  factIndex?: number;      // 对应 fact_changes 中的哪条（省略=所有）
  source: KnowledgeSource;
  confidence: number;
}

// 知识可见性粗粒度广播（LLM 声明感知范围，系统展开为多条 Knowledge）
// 优先级低于 knowledge_hints，高于 Propagation Rules 自动推导
interface KnowledgeBroadcast {
  visibility: 'explicit_entities'     // 显式列出感知者实体
            | 'faction_members'       // 向某组织全部成员广播
            | 'scene_participants';   // 向当前场景所有在场实体广播
  target_entity_ids?: string[];       // visibility = explicit_entities 时必填
  target_faction_id?: string;         // visibility = faction_members 时必填（后续）
  confidence: number;                 // 广播确信度（默认 0.8）
  source: KnowledgeSource;            // 广播来源（默认 witnessed）
}

// LLM 提交的 Fact 变更输入（JSON Schema 校验）
interface FactChangeInput {
  op: 'assert' | 'retract' | 'update';
  change_id: string;          // 客户端生成的稳定 ID（如 'fc_001'），供 ProposedKnowledge.changeId 引用
  // ⚠ 唯一性约束：同一 fact_changes 数组内的 change_id 必须互不相同。
  // 重复的 change_id 会导致 PropagationRule 产出的 ProposedKnowledge 按 (entityId, changeId)
  // 去重时静默丢失一条，applyFactGroup 的 changeId→factId 映射也只保留最后一个。
  // Tool Interface 层校验：重复时返回 SCHEMA_VALIDATION_FAILED。

  // assert / update 时填写
  subject?: string;   // 'ent_zhangsan'
  predicate?: string; // 'realm'
  value?: FactValue;  // '金丹期' 或 { type: 'entity_ref', entityId: 'ent_lisi' }
  relation_kind?: RelationKind; // 仅在 op='assert'/'update' 且谓词不在 PREDICATE_RELATION_MAP 中时使用（见 3.1.4）

  // retract / update 时填写
  target_fact_id?: string; // 要撤回/更新的 Fact ID（从 get_context_slice 返回的 underlying_fact_ids 获取）
}
```

**写入路径对比**：

```typescript
// 旧方案：LLM 生成 DSL 字符串，Parser 解析
wiki_dsl: `
> !event "张三渡劫突破"
> type: tribulation
> chapter: 50
>
> + realm: 金丹期 (source: evt_tribulation_50)
`

// 当前方案：LLM 填写结构体，JSON Schema 校验
fact_changes: [
  {
    op: "assert",
    subject: "ent_zhangsan",
    predicate: "realm",
    value: "金丹期"
  }
]
```

#### Tool 3：commit_event

```typescript
{
  name: "commit_event",
  description: "确认提交预演通过的事件，正式写入世界状态。此操作不可自动撤销，修改历史需使用 propose_retcon。",
  parameters: {
    proposal_id: string;
  },
  returns: {
    status: "success" | "failed";
    committed_event_id: string;
    resolved_threads: string[];  // 被本次事件关闭的线索 ID
    created_knowledge: string[];  // 本次创建的知识条目 ID
    new_fact_ids: string[];    // 新写入的 Fact ID
  }
}
```

#### Tool 4：propose_retcon

```typescript
{
  name: "propose_retcon",
  description: "提议修改历史事件（Retcon）。Core 会计算因果级联影响，让作者看清改一处会牵连什么。",
  parameters: {
    target_event_id: string;
    new_description: string;
    new_fact_changes: FactChangeInput[]; // 直接 JSON，无 DSL
  },
  returns: {
    retcon_proposal_id: string;
    is_safe_to_commit: boolean;
    cascade_impact_report_markdown: string; // 因果级联影响报告
  }
}
```

**Retcon 深度因果级联机制**：

Retcon 不是简单地撤回一个事件——一个事件被修改后，所有依赖它产生的 Fact、由这些 Fact 衍生的后续事件、被后续事件关闭的 NarrativeThread，都可能需要重新评估。

**级联遍历算法（BFS，含 Knowledge 级联）**：

```
输入：被 Retcon 的目标事件 ID
输出：所有受影响的 Fact / Event / NarrativeThread / Knowledge 列表

1. 种子队列 = [target_event_id]
2. 受影响事件集合 = {}
3. 受影响 Fact 集合 = {}
4. 受影响 Thread 集合 = {}
5. 受影响 Knowledge 集合 = {}  // ← 新增：认知层级联

6. WHILE 种子队列非空：
     current_event = 种子队列.dequeue()
     受影响事件集合.add(current_event)

     // 查找此事件直接产生的所有 Fact
     facts = FactStore.getFactsByEvent(current_event)
     受影响 Fact 集合.add(facts)

     // 查找引用这些 Fact 的后续事件
     FOR EACH fact IN facts：
       // 优先路径：走显式依赖声明（Phase 1 引入的 dependent_fact_ids）
       explicit_deps = EventStore.getByDependentFactIds([fact.id], 'business')
       FOR EACH dep_event IN explicit_deps：
         IF dep_event NOT IN 受影响事件集合：
           种子队列.enqueue(dep_event)

       // 兜底路径：启发式搜索（subject + predicate + context 三重过滤）
       // 策略（保守估计）：按 subject + predicate + context 缩小范围，
       // 避免将同一实体的所有后续事件全部标记为受影响。
       // 注意：BFS 在作用域边界处停止——不跨 scope 追溯因果（见 3.4.1 “Retcon 兼容”）。
       // 注意：此策略可能遗漏跨实体的间接依赖（如”张三持有诛仙剑”依赖
       // “诛仙剑具有剑灵”），当前不做跨实体因果追踪，后续由 CausalTracer 解决。
       dependent_events = EventStore.getBySubject(fact.subject, fact.validFrom, 'business')
                          .filter(evt =>
                            evt.params.subject === fact.subject
			    AND evt.context === fact.context   // 限制在同一作用域内
                            AND Object.values(evt.params).includes(fact.predicate))
       FOR EACH dep_event IN dependent_events：
         IF dep_event NOT IN 受影响事件集合：
           种子队列.enqueue(dep_event)

     // 查找被这些事件关闭的 Thread
     FOR EACH event IN 受影响事件集合：
       threads = ThreadStore.getByFilters({ closedByEvent: event.id })
       受影响 Thread 集合.add(threads)

     // ← 新增：查找指向被影响 Fact 的 Knowledge 记录
     FOR EACH fact IN 受影响 Fact 集合：
       knowledge_records = KnowledgeStore.getByFactId(fact.id)
       受影响 Knowledge 集合.add(knowledge_records)

7. RETURN 受影响事件集合, 受影响 Fact 集合, 受影响 Thread 集合, 受影响 Knowledge 集合
```

**级联影响的处理方式**：

```
propose_retcon 调用后：
  1. 执行上述 BFS，收集所有受影响的实体（含 Knowledge）
  2. FactRenderer 渲染级联影响报告（cascade_impact_report_markdown）
  3. 报告分四级展示：

     直接影响（Level 1）：被 Retcon 事件本身产生的 Fact
     二级影响（Level 2）：依赖直接 Fact 的后续事件及其 Fact
     深层影响（Level 3+）：更远链条上的 Event / Fact / Thread
     认知失调（Knowledge Impact）：所有指向被影响 Fact 的 Knowledge 记录

  4. 作者确认 commit_retcon 后：
     - Level 1 的 Fact → certainty 改为 'contested'
     - Level 2+ 的 Fact → certainty 改为 'contested'
     - 被关闭的 Thread → status 恢复为 'UNFILLED'（closedBy 清空）
     - 作者通过后续 propose_event 逐个裁决 contested Fact 的去留

  5. Knowledge 认知失调处理（曼德拉效应）：
     - 对受影响 Knowledge 集合中的每条记录，
       生成一条 NarrativeThread：
         type = 'logic_conflict'
         tag = 'cognitive_dissonance'
         description = "⚠️ 认知冲突：{entityName} 的记忆（旧事实）与世界线（新事实）矛盾"
         status = 'UNFILLED'
     - LLM 在后续写作时，ContextAnalyzer 会主动注入此线索，
       提示作者处理角色的认知冲突
     - 闭环方式（三选一）：
       a. 记忆修正：通过 propose_event 的 KnowledgeChangeInput(op='seal') 封印旧记忆
       b. 重新认知：角色通过新事件"发现真相"，Knowledge 更新为新 Fact
       c. 保持冲突：作者有意保留认知失调（如平行时空/幻术设定），
          Thread 状态保持 UNFILLED 直到剧情自然收束
```

**级联影响报告示例**：

```markdown
## Retcon 级联影响报告 · evt_conflict_30

### 📍 直接影响（Level 1）
- Fact `fct_conflict_30_01` 张三 enemy_of 李四 ← **将标记 contested**
- Fact `fct_conflict_30_02` 李四 enemy_of 张三 ← **将标记 contested**

### 📍 二级影响（Level 2）
- Event `evt_ambush_50`：李四偷袭张三（依赖敌对关系）
  - Fact `fct_ambush_50_01` 张三 hp=8500 ← **将标记 contested**
- Event `evt_revenge_55`：张三报复李四（依赖偷袭事件）
  - Fact `fct_revenge_55_01` 张三 status=被追杀 ← **将标记 contested**

### 📍 Thread 影响
- Thread `thr_miracle_50`：已由 evt_encounter_55 关闭 ← **关闭将撤销，恢复 UNFILLED**

### 🔮 跨作用域潜在影响（非自动级联）
以下作用域中存在引用了受影响实体的 Fact，可能需要作者手动检查：
- 作用域 `arc_dream_01`（纯梦境/幻境，exitBehavior=suggest_discard）：
  - `fct_dream_050_02`：梦境戒指精灵（引用了张三持有的戒指）→ 建议检查
- 作用域 `arc_underworld_03`（秘境副本，exitBehavior=suggest_promote）：
  - 无相关 Fact

> ⚠️ BFS 不跨作用域自动级联（设计原则，见 §3.4.1）。以上信息仅供参考，
> 作者决定是否同步修改其他作用域的设定。

### ⚠️ 建议
此 Retcon 影响 3 个事件、5 条 Fact、1 条 Thread。确认后需要逐个裁决 contested Fact。
```

> **设计说明**：BFS 遍历的深度在 当前不做硬限制，但级联报告中按 Level 分组展示，
> 让作者先处理直接影响再逐层向下。极端情况下（比如修改第 1 章的初始设定），
> 级联可能波及整部小说，此时报告会非常长，作者应谨慎操作。

**跨作用域潜在影响扫描**：

BFS 算法在作用域边界硬停止（`evt.context === fact.context`），这是正确的设计——作用域隔离是 Feature。但级联报告生成阶段应执行一次轻量的跨作用域主题扫描，提醒作者可能受影响的设定：

```
跨作用域扫描逻辑（报告生成阶段，不在 BFS 主循环中）：

  优先路径（确定性，通过 event_dependencies）：
    1. 收集所有被标记 contested 的 Fact ID 列表
    2. 在 event_dependencies 中搜索依赖这些 Fact 的跨作用域事件：
       SELECT e.id, e.context, e.fact_group_id
       FROM event_dependencies d
       JOIN events e ON e.id = d.event_id
       WHERE d.fact_id IN (contested_fact_ids)
         AND e.kind = 'business'
         AND e.context != 当前作用域
         AND e.status = 'committed'
    3. 对命中的事件调用 FactStore.getFactsByEvent(event.id)，筛选 canonical + is_current 的下游 Fact
    4. 命中的 Fact 标记为"因果污染"（依赖源头已 contested），在报告中以 🔴 高优展示

  兜底路径（启发式，通过 subject + predicate 模糊匹配）：
    5. 收集受影响 Fact 的 subject + predicate 组合
    6. 跨所有作用域查询 FactStore：
       SELECT id, context, subject, predicate, value
       FROM facts
       WHERE subject IN (受影响实体列表)
         AND context != 当前作用域
         AND certainty = 'canonical'
         AND is_current = 1
         AND valid_from >= :minRetconChapter   // ⚠ 时间上限：只搜索 Retcon 目标章节之后的事件
    7. 排除已被优先路径命中的 Fact（去重）
    8. 命中的 Fact 标记为"潜在关联"（启发式匹配，非确定性），在报告中以 🟡 低优展示
    注意：兜底路径的匹配精度有限（subject+predicate 相同即可匹配，不检查 value 语义），
    结果仅供作者参考，不自动标记为 contested。
```

> **设计边界**：跨作用域扫描的结果仍仅供作者参考，不自动级联。原因不变：梦境/幻境中的设定
> 可能是作者刻意保持独立的。但通过 `dependent_fact_ids` 精确命中的"因果污染"Fact，
> 其警告级别高于启发式匹配的结果——前者是确定性的因果链断裂，后者只是主题关联推测。
> `exit_scope` 自动注入的 `dependent_fact_ids`（见 §3.4.1 跨作用域依赖溯源）保证了
> "副本产出物带回主线"的场景一定走优先路径。

#### Tool 5：commit_retcon（新增）

```typescript
{
  name: "commit_retcon",
  description: "确认提交 Retcon 预演，执行因果级联标记。此操作会产生大量 contested Fact，需逐个裁决。",
  parameters: {
    retcon_proposal_id: string;
  },
  returns: {
    status: "success" | "failed";
    retcon_event_id?: string;            // 成功时返回，提交后生成的 evt_retcon_* 系统事件 ID
    contested_fact_count: number;     // 被标记 contested 的 Fact 数量
    reactivated_thread_count: number; // 被恢复 UNFILLED 的 Thread 数量
    contested_fact_ids: string[];     // 所有 contested Fact 的 ID（供后续裁决）
    reactivated_thread_ids: string[]; // 所有被恢复的 Thread ID
  }
}
```

> **设计说明**：`commit_retcon` 与 `commit_event` 职责完全分离——前者处理历史修改的级联标记，
> 后者处理新事件的 Fact 写入。两者返回值结构不同，操作语义不同，不应合并。

**commit_retcon 的 Phase A/B/C 分解**：

与 `commit_event` 类似，`commit_retcon` 也遵循三阶段分解，但各阶段职责不同：

```
Phase A（事务外）：BFS 级联遍历 + 级联影响报告渲染（propose_retcon 已完成）
Phase B（事务内，5-20ms）：
  → BEGIN
  → UPDATE project_state.state_version     // 条件更新并递增，令旧 proposal 失效；失败则 ROLLBACK + STALE_PROPOSAL
  → INSERT events: evt_retcon_*            // 系统事件，kind='system', type='retcon'，fact_group_id=event_id，FactGroup 为空
  → SQLite 事务：UPDATE facts SET certainty='contested' WHERE id IN (contested_fact_ids)
  → UPDATE/INSERT threads                  // 恢复受影响 Thread，并插入 cognitive_dissonance 类型 NarrativeThread
    // ⚠ cognitive_dissonance Thread 数量限制：同一 Retcon 最多生成 50 条，
    // 超出部分在级联报告 Markdown 中汇总为统计数字，建议作者按需通过 resolve_thread 处理。
    // 原因：Retcon 第 1 章的初始设定可能导致 1000+ 条受影响 Knowledge，
    // 全部生成 Thread 会违反 §5.2 复杂度预算并淹没作者的通知队列。
    // 阈值内的 cognitive_dissonance Thread 按 confidence 降序排列（高确信度的 Knowledge 优先展示）。
  → INSERT event_dependencies              // evt_retcon_* → 所有 contested_fact_ids，source='retcon_cascade'
  → INSERT audit_log                       // event_id = evt_retcon_*
  → INSERT sync_queue：operation='update_certainty', payload={ certainty:'contested' }, event_id = evt_retcon_*
  → COMMIT
Phase C（事务后，异步）：
  → contestedBlacklist 写入                  // 内存级防护（同步，不依赖 LanceDB）
  → 后台 worker 消费 sync_queue              // LanceDB certainty 批量更新
  → LanceDB 更新完成后逐条 clearFromBlacklist
```

> **关键差异**：`commit_event` 的 Phase C 同步的是"新向量写入"（`scheduleLanceDBSync`），
> `commit_retcon` 的 Phase C 同步的是"已有向量 certainty 更新"（`scheduleRetconSync`）。
> 两者触发条件不同、操作语义不同、失败恢复策略不同（Retcon 同步失败不影响数据正确性，
> 但会导致幽灵检索窗口延长，需监控 sync_queue 中的 Retcon 类型条目）。

> **系统事件约束**：`retcon_proposal_id` 只存在于 `ProposalStore` 和审计原始输入中，不得作为持久外键。提交成功后，所有持久副作用统一关联 `retcon_event_id`。这样 `audit_log.event_id`、`sync_queue.event_id`、`event_dependencies.event_id` 可以保持 `NOT NULL` 并继续引用 `events(id)`。

> **retcon_cascade 边界**：`source='retcon_cascade'` 的 `event_dependencies` 记录表示"此 Retcon 系统事件处理了这些 Fact"，不是"剧情事件依赖这些 Fact"。因此默认叙事因果查询必须同时过滤 `events.kind='business'`，否则系统事件会污染 Retcon BFS / ContextAnalyzer 的因果遍历。

#### Tool 6：resolve_thread

```typescript
{
  name: "resolve_thread",
  description: "手动关闭叙事线索。用于 customRule 类型线索，或自动关闭未能识别的情况。",
  parameters: {
    thread_id: string;
    resolution_event_id: string; // 关闭此线索的事件 ID
    explanation: string;          // 作者解释为什么此事件关闭了这条线索
    new_status?: ThreadStatus;    // 目标状态（默认 FILLED/RESOLVED）
  },
  returns: {
    status: "resolved" | "rejected";
    milestone_id?: string;  // 如果追加了 Milestone，返回其 ID
    message: string;
  }
}
```

#### Tool 7：get_open_threads

```typescript
{
  name: "get_open_threads",
  description: "获取所有未关闭的叙事线索清单。写作前调用以了解当前存在的逻辑债务。",
  parameters: {
    current_chapter: number;
    severity_filter?: ('minor' | 'major' | 'critical')[];
    direction?: ThreadDirection;
    type?: ThreadType[];
  },
  returns: {
    threads_markdown: string;  // FactRenderer 渲染的线索清单
    expiring_soon: string[];   // 即将超期的回溯型线索 ID
    hintable: string[];       // 可以被暗示的渐进型线索 ID
    total_open: number;
  }
}
```

#### Tool 8：register_entity

```typescript
{
  name: "register_entity",
  description: "注册一个新实体到世界设定中。在创建任何关于该实体的 Fact 之前，必须先注册实体。",
  parameters: {
    entity_id: string;       // 实体 ID，如 'ent_zhangsan'、'ent_zhuxianjian'、'ent_gumu'
    name: string;            // 实体的自然语言名称，如 '张三'、'诛仙剑'、'古墓'
    kind: EntityKind;        // 实体分类（14种，见 3.1.4）
    description?: string;    // 实体的简要描述（可选）
    first_appearance: number; // 实体首次出现的章节号
  },
  returns: {
    status: "created" | "already_exists";
    entity_id: string;
  }
}
```

**实体注册表**：FactStore 维护一个 `entities` 表，存储所有已注册实体的元数据。

```typescript
// EntityKind 已在 3.1.4 节定义（14 种）。
// 原 EntityType 的 7 种分类已被 EntityKind 完全替代：
//   character/item/location/faction/ability/species/world
//   → 统一为 entity（通用兜底）+ 14 种细分类型
// register_entity 的 kind 参数使用 EntityKind 枚举。

interface EntityRecord {
  id: string;              // 'ent_zhangsan'
  name: string;            // '张三'
  kind: EntityKind;        // 实体分类（14种，见 3.1.4）
  description?: string;    // 简要描述
  firstAppearance: number; // 首次出场章节
  createdAt: string;       // 系统注册时间 ISO 8601
}
```

> **设计说明**：实体注册表是 `entityNames` 映射（`Record<string, string>`）的权威数据源。
> FactEmbedder 和 FactRenderer 从此表获取实体 ID → 名称的映射，不再依赖外部传入。
> 要求所有 Fact 的 subject 和 EntityRef.entityId 必须已在实体注册表中存在，
> 否则 `propose_event` 返回校验错误。

#### Tool 9：propose_schema_extension

```typescript
{
  name: "propose_schema_extension",
  description: "提议扩展当前 World Package——注册新谓词、新增/修改声明式规则、新增实体模板。" +
               "不直接写入数据库，生成提案后需由作者确认。",
  parameters: {
    extension_type: 'predicate' | 'rule' | 'entity_template' | 'scope_preset';
    // 当 extension_type = 'predicate' 时
    predicate?: {
      name: string;                 // 谓词名，如 'teleport_array'
      displayName: string;          // 中文名，如 '传送阵'
      valueType: 'scalar' | 'entity_ref' | 'enum';
      enumValues?: string[];        // valueType = 'enum' 时
      sequenceOrder?: string[];     // 可选：有序枚举递进序列（见 §3.9 PredicateDefinition）
      description: string;          // 语义说明（帮助 LLM 理解 + 用于 embedding 增强）
      relationKind: RelationKind;
    };
    // 当 extension_type = 'rule' 时
    rule?: {
      id: string;                   // 规则 ID，如 'rule_teleport_same_origin'
      // ⚠ type 不包含 'PropagationRule'——传播规则（subject_auto / witness_propagation）
      // 是 Core 内置的，不可通过 Tool 9 注册。如需自定义传播行为，
      // 应通过 World Package JSON 文件导入或直接 SQL 写入 wp_rules。
      // DDL wp_rules.type 列允许存储 'PropagationRule' 值，但 Tool 9 接口层拒绝创建。
      type: 'TransitionRule' | 'ConstraintRule' | 'InferenceRule';
      description: string;          // 规则的自然语言描述
      declarativeJson: object;      // 声明式规则 JSON（格式见附录 H.3）
    };
    // 当 extension_type = 'entity_template' 时
    template?: {
      name: string;
      extends?: string;
      defaultPredicates: string[];
      description: string;
    };
    // 当 extension_type = 'scope_preset' 时
    scopePreset?: {
      name: string;
      displayName: string;
      defaultExitBehavior: 'suggest_promote' | 'suggest_discard';
      inheritsGlobalRules: boolean;
      description: string;
    };
    // 扩展原因——供作者审核时参考
    reason: string;                  // 如"检测到新设定'传送阵'，需要注册空间设施谓词"
  },
  returns: {
    proposal_id: string;
    extension_summary: string;       // 人类可读的扩展摘要（供 LLM 转述给作者）
    conflicts: string[];             // 与现有 WP 的冲突列表（空=无冲突）
  }
}
```

**为什么需要独立的 Tool**：`propose_event` 只能操作 Fact/Event/Thread/Knowledge 数据（业务数据层），无权修改 World Package 的 wp_* 表（Schema 层）。`propose_schema_extension` 是唯一的 Schema 层写入通道。

**执行流程（两阶段提交）**：

1. LLM 检测到新概念（§3.9"四层来源模型"第四层）或作者主动描述新规则
2. LLM 调用 `propose_schema_extension`，传入扩展内容和原因
3. Core 校验：
   - predicate：检查是否与 generic 包已有谓词重名、relationKind 是否冲突
   - rule：校验声明式 JSON 格式是否合法
   - entity_template：检查 extends 指向的父模板是否存在
   - scope_preset：检查 name 是否重复
4. Core 返回 `proposal_id` + 扩展摘要 + 冲突列表
5. LLM 将摘要翻译为自然语言，向作者转述："检测到新设定'传送阵'，建议注册为空间设施类谓词，是否确认？"
6. 作者确认后，LLM 调用 `commit_schema_extension(proposal_id)` 执行写入
7. Core 执行 `INSERT INTO wp_*` + 自动更新 LLM system prompt 中的 WP 摘要（§G.1.1）

```typescript
// commit_schema_extension（与 commit_event 类似的确认步骤）
{
  name: "commit_schema_extension",
  parameters: {
    proposal_id: string;
  },
  returns: {
    status: "success" | "failed";
    schema_event_id?: string;         // 成功时返回，提交后生成的 evt_schema_* 系统事件 ID
    affected_tables: string[];      // 实际写入的 wp_* 表列表
    new_predicate_names?: string[]; // 新注册的谓词名
    new_rule_ids?: string[];        // 新注册的规则 ID
  }
}
```

**commit_schema_extension 的 Phase A/B/C 分解**：

```
Phase A（事务外）：
  → 从 ProposalStore 读取 schema extension proposal
  → 重新校验 predicate/rule/template/scope_preset 与当前 wp_* 表无冲突

Phase B（事务内，5-20ms）：
  → BEGIN
  → UPDATE project_state.state_version     // 条件更新并递增，令旧 propose_event / schema proposal 失效
  → INSERT events: evt_schema_*            // 系统事件，kind='system', type='schema'，fact_group_id=event_id，FactGroup 为空
  → INSERT/UPDATE wp_*                     // 写入 wp_predicates / wp_rules / wp_entity_templates / wp_scope_presets
  → INSERT audit_log                       // event_id = evt_schema_*
  → COMMIT

Phase C（事务后，异步或同步轻量刷新）：
  → 重建当前项目的 World Package 摘要缓存
  → 更新后续 LLM system prompt 注入内容
```

> **Schema 写入边界**：`commit_schema_extension` 不写 Fact / Knowledge / Thread，也不写 `sync_queue`，因为没有 LanceDB 向量需要同步。它仍必须写 `events` 和 `audit_log`，并递增 `project_state.state_version`，否则旧的 `propose_event` 可能绕过新谓词或新规则继续提交。

### 9.3 统一错误处理

所有 10 个 Tool（含 propose_schema_extension / commit_schema_extension）在失败时返回统一的错误结构，便于 LLM 理解错误原因并决定是否重试：

```typescript
interface ToolError {
  code: ToolErrorCode;     // 语义化错误码，LLM 可据此判断处理策略
  message: string;         // 人类和 LLM 可读的错误描述
  retryable: boolean;      // LLM 是否可以通过修改参数重试
  detail?: unknown;        // 调试用附加信息（如 JSON Schema 校验详情）
}

// 错误码枚举：按根因分类，不按工具分类
type ToolErrorCode =
  // 校验类（可重试：修改参数后重试）
  | 'SCHEMA_VALIDATION_FAILED'    // FactChangeInput 字段校验失败（缺必填字段、类型不匹配）
  | 'ENTITY_NOT_FOUND'            // 引用的实体 ID 不在实体注册表中
  | 'FACT_NOT_FOUND'              // retract/update 目标 Fact ID 不存在
  | 'FACT_NOT_CURRENT'            // update/retract 目标 Fact 已失效（isCurrent=false）
  | 'FACT_ID_FABRICATED'          // target_fact_id 不属于当前项目的任何 Fact（疑似 LLM 捏造）
  | 'PROPOSAL_NOT_FOUND'          // commit_event 时 proposal_id 不存在或已过期
  | 'STALE_PROPOSAL'              // proposal 基于旧 state_version，需重新 propose_event
  | 'INVALID_CHAPTER'             // chapter 参数不合法（非正整数、非单调递增等）
  | 'THREAD_NOT_FOUND'            // resolve_thread 时 thread_id 不存在
  | 'THREAD_ALREADY_CLOSED'       // resolve_thread 时线索已关闭
  | 'PREDICATE_CONFLICT'          // propose_schema_extension 新谓词与 generic 包冲突
  | 'RULE_JSON_INVALID'           // propose_schema_extension 声明式规则 JSON 格式错误
  | 'TEMPLATE_PARENT_NOT_FOUND'   // propose_schema_extension extends 的父模板不存在

  // 业务逻辑类（可能需人工介入）
  | 'DUPLICATE_ENTITY'            // register_entity 时实体已存在（返回 already_exists，非报错）
  | 'THREAD_ALREADY_RESOLVED'     // resolve_thread 时线索已被关闭（业务语义同 THREAD_ALREADY_CLOSED）
  | 'RETCON_CASCADE_TOO_DEEP'     // Retcon 级联超过安全阈值（防止误操作）
  | 'SCHEMA_EXTENSION_CONFLICT'   // propose_schema_extension 与现有 WP 存在不可自动解决的冲突

  // 系统类（一般不可重试）
  | 'INTERNAL_ERROR'              // 未预期的内部错误（SQLite 异常等）
  | 'EMBEDDING_SERVICE_UNAVAILABLE' // Embedding API 不可用（语义检索降级）
  | 'EXTENSION_NOT_FOUND'       // commit_schema_extension 时 extension_id 不存在或已过期
  | 'KNOWLEDGE_TARGET_MISSING' // 记忆操作（seal/decay 等）时，指定的目标范围内没有任何 Knowledge 记录
  | 'SCOPE_FACT_MISMATCH';     // update/retract 的 target_fact_id 指向不同作用域的 Fact（跨作用域防护，见 §3.4.1）

// Tool 返回值统一结构
type ToolResult<T> =
  | { status: 'success'; data: T; system_metadata?: SystemMetadata }
  | { status: 'failed'; error: ToolError };

// §9.2 系统元数据——每次 Tool 返回值可选携带的可观测性信号
// 设计意图：Core 保持 Headless，不主动推送，但通过返回值让上层 Agent 编排层
// 感知内部状态，用于 L1/L2/L3 熔断决策、检索质量监控、并发冲突诊断。
interface SystemMetadata {
  /** 当前项目状态版本（乐观锁），上层据此检测自身缓存是否过期 */
  state_version: number;

  /** 检索管线遥测——仅读取类 Tool（get_context_slice / get_open_threads）携带 */
  retrieval_telemetry?: {
    /** 本轮实际使用的检索模式 */
    active_mode: 'full_pipeline' | 'bm25_hybrid_fallback' | 'graph_walk_fallback';
    /** 检索深度（实际命中的 LanceDB search_depth） */
    search_depth: number;
    /** LanceDB 向量库与 SQLite 权威源的同步延迟（ms），正值表示有未同步写入 */
    lance_db_sync_lag_ms: number;
    /** Step 0 短期工作记忆命中率滑动窗口（最近 20 次查询） */
    step0_hit_rate_window: number;  // 0.0 ~ 1.0
  };

  /** 并发冲突遥测——仅写入类 Tool（propose/commit 系列）携带 */
  concurrency_telemetry?: {
    /** 当前内存 contested 黑名单大小（Retcon 后尚未同步 LanceDB 的 Fact 数） */
    contested_blacklist_size: number;
    /** 近 10 分钟内被多个 proposal 争抢的热实体 ID（最多 10 个） */
    hot_entities: string[];
  };

  /** 本轮 Tool 调用消耗的延迟预算（ms），上层用于熔断决策 */
  latency_budget_consumed_ms: number;
}
```

> **兼容说明**：历史文档和旧导入数据中可能出现 `COST_NOT_FOUND` / `COST_ALREADY_RESOLVED`，实现层可以把它们映射为 `THREAD_NOT_FOUND` / `THREAD_ALREADY_RESOLVED`。新 Tool 返回值必须使用 `THREAD_*` 错误码，避免重新引入第二套 Cost 概念。

**LLM 重试指导**：
- `retryable = true` + `code = 'SCHEMA_VALIDATION_FAILED'`：LLM 根据 `detail` 修正参数后重试
- `retryable = true` + `code = 'ENTITY_NOT_FOUND'`：LLM 先调用 `register_entity` 注册实体，再重试
- `retryable = true` + `code = 'FACT_NOT_FOUND'` / `'FACT_ID_FABRICATED'`：Core 在 `detail` 中返回纠错信息——该实体在该 predicate 下的当前活跃 Fact ID 列表 + 最近一次 `get_context_slice` 返回的 `fact_index` 摘要。LLM 据此重新选择正确的 `target_fact_id`
- `retryable = true` + `code = 'FACT_NOT_CURRENT'`：Core 在 `detail` 中说明该 Fact 已在哪个章节被哪个事件失效，并返回当前活跃的同 predicate Fact ID。LLM 据此重试
- `retryable = true` + `code = 'PREDICATE_CONFLICT'`：LLM 修改新谓词的 name 或 relationKind 后重试，或选择已有谓词代替
- `retryable = true` + `code = 'RULE_JSON_INVALID'`：LLM 根据 `detail` 中的 JSON Schema 校验错误修正声明式规则后重试
- `retryable = false` + `code = 'SCHEMA_EXTENSION_CONFLICT'`：LLM 向作者报告冲突详情，等待人工决策
- `retryable = false`：LLM 向作者报告错误，等待人工决策

---

## 10. 三条数据流

### 10.1 写入流（作者驱动，确定性）

```
┌────────────────────────────────────────────────────────────┐
│                          写入流                             │
├────────────────────────────────────────────────────────────┤
│                                                            │
│  人类自然语言意图                                            │
│       ↓                                                    │
│  LLM 理解意图，构造 Tool Call 参数                           │
│       ↓                                                    │
│  propose_event (JSON Schema FactChange[])                  │
│       ↓                                                    │
│  JSON Schema 校验                                           │
│    ├── 失败 → 返回 SchemaError，LLM 修正后重试               │
│    └── 成功 → 继续                                          │
│       ↓                                                    │
│  Rule Engine 沙盒推演                                       │
│    ├── Transition Rules → NarrativeThread[]                  │
│    ├── Inference Rules → 推导 Fact[]（certainty=potential） │
│    ├── Constraint Rules → 约束违规 Thread[]                 │
│    └── Propagation Rules → ProposedKnowledge[]（知识传播建议）│
│       ↓                                                    │
│  合并知识建议（knowledge_hints > broadcast > propagation）   │
│       ↓                                                    │
│  EventConsequence 打包（含 proposedKnowledge）               │
│       ↓                                                    │
│  FactRenderer 渲染审计报告（含知识传播建议列表）            │
│       ↓                                                    │
│  返回 ProposalResult（含 is_safe_to_commit）                 │
│       ↓                                                    │
│  人类/作者查看报告并决定                                     │
│    ├── 确认 → commit_event(proposal_id)                               │
│    └── 拒绝 → 丢弃提案，世界状态不变                         │
│       ↓（确认分支）                                         │
│  推理规则 Fact 提升：potential → canonical                   │
│  （推理 Fact 随主 FactGroup 一起原子提升，见 5.5 说明）       │
│       ↓                                                    │
│  exit_scope 事件特殊处理（如适用）：                          │
│    → 遍历 fact_changes 中 op='assert' 的条目                 │
│    → 在退出作用域中查找 subject+predicate 匹配的 origin Fact  │
│    → 将 origin Fact ID 追加到事件的 dependent_fact_ids        │
│    → 写入 event_dependencies 边表（见 §3.4.1 自动注入逻辑）  │
│       ↓                                                    │
│  Phase B SQLite 原子提交开始                                │
│    → 条件更新 project_state.state_version                   │
│      （失败则 ROLLBACK，返回 STALE_PROPOSAL）                │
│    → INSERT event                                           │
│    → FactGroup 写入 facts                                   │
│       ↓                                                    │
│  ThreadResolver 扫描所有未关闭线索
│    ├── 回溯型满足条件 → 标记 FILLED
│    ├── 渐进型满足条件 → 追加 RESOLVED Milestone
│    └── 不满足 → 保持当前状态
│       ↓
│  知识可见性更新（认知事件流，与 FactGroup 在同一事务）
│    → 事件主体自动获得 Knowledge（self_action, confidence=1.0）
│    → Propagation Rules 推导的同场景目击等 Knowledge
│    → LLM knowledge_broadcast 展开的多条 Knowledge
│    → LLM knowledge_hints 细粒度覆盖（最高优先级）
│    → LLM knowledge_changes 显式操作（seal/implant/decay）——写入顺序最晚
│    → KnowledgeStore 两阶段写入（保证 rowid tiebreaker 正确性）：
│      第一阶段：batchCreate(自动推导 Knowledge[])
│        包含 self_action / witnessed / faction_share / broadcast / hints
│      第二阶段：batchCreate(显式操作 Knowledge[])
│        包含 seal / implant / decay / soul_read（显式操作 rowid > 自动推导 rowid）
│      顺序保证：§3.6 tiebreaker 中 "显式操作 > 自动推导" 依赖 SQLite rowid 递增，
│      因此两阶段必须严格按"先自动后显式"的顺序写入，不可混在一个数组中传入。
│  Rule Engine.validateConsistency()（后验校验）              │
│       ↓                                                    │
│  同事务写入 audit_log / event_dependencies / sync_queue     │
│    sync_queue 包含两类 outbox 记录：                          │
│    ├─ operation='insert_vector'：新 assert 的 canonical Fact  │
│    └─ operation='mark_invalid'：被 retract/update 失效的旧 Fact
│      （Phase C worker 消费后将 LanceDB 向量 is_current=false）│
│       ↓                                                    │
│  Phase B COMMIT                                             │
│       ↓                                                    │
│  Phase C 后台 worker：scheduleLanceDBSync() → LanceDB 同步  │
│  （只消费已持久化 outbox，不在 applyFactGroup 事务内执行）    │
│                                                            │
└────────────────────────────────────────────────────────────┘
```

### 10.2 读取流（系统驱动，Push 模式）

```
┌────────────────────────────────────────────────────────────┐
│                          读取流                             │
├────────────────────────────────────────────────────────────┤
│                                                            │
│  触发条件：LLM 即将开始写某章正文                            │
│                                                            │
│  写作上下文（章节号 + 大纲 + 出场实体 + 近期段落）            │
│       ↓                                                    │
│  ContextAnalyzer.analyze()                                 │
│    → entityIds[]（精确查询目标）                            │
│    → semanticQueries[]（向量检索查询串）                    │
│    → temporalFocus（章节时间点）                            │
│       ↓                                                    │
│  RelevantFactRetriever.retrieve()                          │
│    ├── Step 1：精确查询                                      │
│    │     FactStore.getSnapshot() × entityIds               │
│    │     FactStore.getRelationsTargeting() × entityIds     │
│    ├── Step 2：语义检索                                      │
│    │     embed(semanticQueries) → LanceDB.search()          │
│    │     过滤 is_current == true（当前有效）                 │
│    │     去重（与 Step 1 结果合并）                           │
│    ├── Step 3：线索注入                                      │
│    │     ThreadStore.getOpen()                            │
│    │     过滤与场景相关的线索                                 │
│    ├── Step 4：排序 + 截断至 topK=20                         │
│    └── Step 5：知识感知过滤（角色视角写作时按需激活）            │
│       ↓                                                    │
│  RelevantFactSet                                           │
│       ↓                                                    │
│  FactRenderer.renderRelevantFacts()                        │
│       ↓                                                    │
│  Wiki Markdown 注入 LLM 系统提示（写作上下文区块）           │
│       ↓                                                    │
│  LLM 带完整世界上下文进行写作                                │
│                                                            │
└────────────────────────────────────────────────────────────┘
```

### 10.3 校验流（持续，自动）

> **概要视图说明**：以下为校验流的概要流程图。详细的步骤顺序和事务边界见 §10.1 写入流总览。
> 概要视图中 validateConsistency 在 ThreadResolver 之前，但实际在 §10.1 的 Phase B 事务中，
> 执行顺序为 ThreadResolver → Knowledge 写入 → validateConsistency → audit_log。

```
┌────────────────────────────────────────────────────────────┐
│                          校验流                             │
├────────────────────────────────────────────────────────────┤
│                                                            │
│  触发条件：                                                 │
│    A. 每次 commit_event 成功后自动触发                      │
│    B. 作者手动发起全局一致性检查                             │
│       ↓                                                    │
│  ThreadResolver.resolveThreads()（扫描新提交事件的关闭效果）     │
│    ├── 被填补的回溯型线索 → status = 'FILLED'               │
│    └── 即将超期的线索 → 推送提醒给作者                      │
│       ↓                                                    │
│  Rule Engine.validateConsistency(factStore, atChapter)     │
│  （后验诊断性审计，非阻塞性校验——详见 §10.1 和 §5.5 说明）   │
│       ↓                                                    │
│  ValidationReport                                          │
│    ├── violations[]（硬约束冲突，需要处理）                  │
│    └── warnings[]（软约束提醒，可忽略）                      │
│       ↓                                                    │
│  FactRenderer.renderThreadSummary() 展示给作者                │
│                                                            │
└────────────────────────────────────────────────────────────┘
```

### 10.4 端到端场景：绝脉主角突破（完整流程）

#### 阶段一：第50章，作者的"任性"与 Core 的"记账"

```
人类：第50章让张三渡劫突破金丹期

── 读取流先触发 ──
ContextAnalyzer 分析 → ent_zhangsan
LanceDB 检索 + FactStore 精确查询 → 注入 LLM 上下文：
  张三 meridian = 'shattered'（第1章）
  张三 realm = '练气期'（第1章）

── LLM 调用 propose_event ──
{
  event_type: "tribulation",
  event_description: "张三渡劫突破金丹期",
  chapter: 50,
  fact_changes: [
    { op: "assert", subject: "ent_zhangsan", predicate: "realm", value: "金丹期" }
  ]
}

── Rule Engine 沙盒推演 ──
TransitionRule meridianBreakthrough：
  ent_zhangsan.meridian = 'shattered' + event_type = 'tribulation'
  → 生成 NarrativeThread thr_miracle_50 [critical, UNFILLED]
    closeCondition: requiredEventType='ancient_encounter', withinChapters=10

── FactRenderer 渲染审计报告 ──
Status: SAFE_TO_COMMIT（含警告）
线索：绝脉体质突破，需在第60章前安排 ancient_encounter 填补

── 人类确认 → LLM 调用 commit_event ──

── Phase B 原子提交 ──
  Event:  evt_tribulation_50
  Fact:   fct_tribulation_50_01  ent_zhangsan realm = '金丹期' [canonical, validFrom=50]
  Thread: thr_miracle_50 [UNFILLED, retroactive, createdAtEvent=evt_tribulation_50, createdAtChapter=50]
  sync_queue outbox: insert_vector(fct_tribulation_50_01)
  后台 worker: 生成向量 "张三 的修炼境界是 金丹期（第50章）" 并同步 LanceDB
```

#### 阶段二：第55章，因果的闭环

```
人类：第55章张三掉下悬崖，发现魔神血池，吸收魔神血脉

── 读取流先触发 ──
ContextAnalyzer 分析 → ent_zhangsan
RelevantFactRetriever 检索到 thr_miracle_50 [UNFILLED]
FactRenderer 注入提醒：⚠️ 未填线索 thr_miracle_50，距截止还有5章

── LLM 调用 propose_event ──
{
  event_type: "ancient_encounter",
  event_description: "发现魔神血池，吸收太古魔神血脉",
  chapter: 55,
  fact_changes: [
    { op: "assert", subject: "ent_zhangsan", predicate: "bloodline", value: "太古魔神" },
    { op: "assert", subject: "ent_zhangsan", predicate: "status",   value: "魔气噬体" }
  ],
  thread_resolutions: ["thr_miracle_50"]
}

── Rule Engine + ThreadResolver 推演 ──
isThreadClosable(thr_miracle_50, evt_encounter_55)：
  closeCondition.requiredEventType = 'ancient_encounter' == event.type ✓
  closeCondition.withinChapters: 55 <= 50 + 10 ✓
  → 满足填补条件

── 审计报告 ──
Status: SAFE_TO_COMMIT
新产生事实：bloodline = 太古魔神，status = 魔气噬体
关闭线索：thr_miracle_50 ✓（绝脉突破逻辑已由魔神血脉解释）

── 提交后 ──
Event:  evt_encounter_55
Fact:   fct_encounter_55_01  ent_zhangsan bloodline = '太古魔神' [canonical, validFrom=55]
        fct_encounter_55_02  ent_zhangsan status = '魔气噬体' [canonical, validFrom=55]
Thread: thr_miracle_50 [FILLED, retroactive, closedBy=evt_encounter_55]
sync_queue outbox: insert_vector(fct_encounter_55_01, fct_encounter_55_02)
后台 worker: 2条新向量同步到 LanceDB

── 闭环完成 ──
```

---

## 11. 实现范围与后续迭代

### 11.1 包含范围

| 模块 | 状态 | 说明 |
|------|------|------|
| 核心类型定义（types.ts） | ✅ 设计完成 | Fact / FactGroup / NarrativeEvent / NarrativeThread / Knowledge / EventConsequence |
| FactStore | ✅ 设计完成 | 四级索引，时间切片，原子事务，SQLite（better-sqlite3）实现，LanceDB 同步接口 |
| Rule Engine | 🔜 待实现 | 通过 World Package 加载规则集（含 5 个跨题材示例规则）+ 2 条通用传播规则，沙盒推演 |
| ThreadResolver | 🔜 待实现 | 线索生成、关闭判定、到期提醒、伏笔暗示 |
| KnowledgeStore | 🔜 待实现 | 知识可见性存储、角色知识查询、LLM 推断合并、知识广播展开 |
| FactEmbedder | 🔜 待实现 | embeddingText 生成 + LanceDB 批量写入 |
| ContextAnalyzer | 🔜 待实现 | 基于轻量 LLM 调用，输出 JSON ContextSignals |
| RelevantFactRetriever | 🔜 待实现 | 六段检索管线（短期记忆 + 精确 + 语义 + 线索注入 + 排序 + 知识过滤） |
| FactRenderer | 🔜 待实现 | 四种格式（EntityProfile / RelevantFacts / SimReport / ThreadSummary） |
| LLM Tool Interface | 🔜 待实现 | 10 个 Tool（含 register_entity + resolve_thread + propose/commit_schema_extension + 知识推断 + 认知操作），纯 JSON Schema |
| 端到端测试 | 🔜 待实现 | 绝脉突破场景完整覆盖 |

### 11.2 明确删除（对比旧版）

| 删除的模块 | 删除原因 |
|-----------|--------|
| WikiParser（DSL 写入解析器） | JSON Schema Tool Call 更可靠，DSL 正则 Parser 引入不必要脆弱性 |
| Wiki DSL 写入语法（`> !event` 等语法） | 同上，LLM 填 JSON 字段比生成 DSL 字符串出错率更低 |
| GraphNode / GraphEdge 类型 | 关系是 Fact，图拓扑是派生视图，不需要独立存储类型 |

### 11.3 明确不包含（后续迭代）

| 模块 | 推迟原因 |
|------|--------|
| CausalTracer 因果图遍历 | 当前通过 causeEvent 字段单向溯源已足够，图算法后续迭代 |
| Ontology 编译器（World Package 高级功能） | 当前通过 SQLite 表存储 World Package 数据，支持运行时动态增删改查 |
| 增量计算 / 依赖缓存 | 当前数据量 < 100 条，不需要性能优化 |
| GraphLayer 可视化层 | 可从 Fact 实时推导，非核心 |
| Wiki DSL 人工编辑格式 | 后续可作为人类直接编辑入口（非 LLM 写入路径）重新引入 |

#### Dependency Graph（依赖图，Phase 2）+ 轻量级前置（Phase 1）

当前 Retcon BFS 算法通过 subject + predicate 启发式搜索依赖关系（§9.2 Tool 4），这是保守估计，可能误标或遗漏。未来引入显式依赖图后，Retcon 精度会大幅提升：

```typescript
interface DependencyEdge {
  fromFact: FactId;    // 上游 Fact
  toFact: FactId;      // 下游 Fact（依赖上游）
  type: 'requires'     // A 存在是 B 存在的前提（如：皇帝死亡 → 太子继位）
      | 'derived_from' // B 由 A 推导而来（InferenceRule 产出）
      | 'caused_by';   // B 的 causeEvent 同时产生了 A（同事件产出）
}
```

**轻量级前置方案（Phase 1 引入）**：完整的 DependencyGraph 基础设施推迟到 Phase 2，但 Phase 1 即引入 `dependent_fact_ids` 轻量声明机制——LLM 在 `propose_event` 时可选声明"本次事件依赖哪些前置 Fact"。提交时系统必须把这些依赖写入 `event_dependencies(event_id, fact_id, source)` 边表，`events.dependencies_json` 仅保留同一份 ID 列表用于审计展示。Retcon BFS 遍历时优先查询 `event_dependencies`，启发式搜索作为兜底补充。

```typescript
// Phase 1 轻量版：propose_event 的可选参数；commit_event Phase B 写入 event_dependencies
dependent_fact_ids?: string[];  // LLM 声明的前置 Fact 依赖

// Phase 2 完整版：独立的 DependencyEdge 图结构
// 支持跨实体因果追踪（如"张三持有诛仙剑"依赖"诛仙剑具有剑灵"）
// 当前 Phase 1 不解决跨实体问题，Phase 2 的 CausalTracer 解决
```

> **为什么 Phase 1 就引入**：启发式 BFS 的"语义依赖但结构无痕"漏判（如：李四因搜魂得知戒指存在→派兵去洞穴，但事件参数里无 `holds_item`）在 MVP 阶段就会影响 Retcon 准确性。`dependent_fact_ids` 是低成本基础设施——只需 LLM System Prompt 增加一条指令、Phase B 写入一张轻量边表，并让 BFS 增加一个索引查询优先路径，即可将 Retcon 的依赖漏判率大幅降低。

延迟原因（完整 DependencyGraph）：Phase 0 的核心闭环（写入流 + 读取流 + 规则校验）不依赖完整依赖图。依赖图是 Retcon 的精度优化，不是 MVP 的必要条件。Phase 1 稳定后引入完整版。

#### Narrative Query Layer（叙事查询层，Phase 1.5）

当前 Core 提供的查询能力（get_context_slice / get_open_threads）是面向 LLM 的结构化接口，不适合作者直接使用。Query Layer 是验证 Core 是否成功的最快方式——作者最终操作的是 Query，不是 FactStore。

```typescript
// MVP Query API（Phase 1.5，FactStore + EventStore 就绪后立即实现）
interface NarrativeQueryEngine {
  findFacts(filter: FactFilter): Promise<Fact[]>;         // 按实体/谓词/章节查询 Fact
  findEntities(filter: EntityFilter): Promise<EntityRecord[]>; // 按名称/类型查询实体
  findThreads(filter: ThreadFilter): Promise<Thread[]>;   // 按状态/类型查询线索
  findKnowledge(filter: KnowledgeFilter): Promise<Knowledge[]>; // 按实体/事实查询认知
  findEvents(filter: EventFilter): Promise<Event[]>;      // 按章节/类型查询事件
}

// 完整自然语言查询（Phase 3，需要 LLM 辅助翻译查询意图）
interface NarrativeQueryEngineV2 {
  // 作者自然语言问题 → LLM 翻译 → Core 查询 → 结构化结果 → LLM 回答
  query(question: string, atChapter: number): Promise<QueryResult>;
}

// 支持的典型查询：
// "谁知道克莱恩的真实身份？"
//   → findKnowledge({ factPredicate: 'identity', factSubject: 'ent_klein' })
//     → 返回所有 confidence > 0 的 Knowledge 记录
//
// "第200章有哪些未关闭伏笔？"
//   → findThreads({ status: 'UNFILLED', createdBefore: 200 })
//
// "谁见过诛仙剑？"
//   → findKnowledge({ factSubject: 'ent_zhuxianjian', source: 'witnessed' })
```

**为什么提前到 Phase 1.5**：Query 的底层能力（FactStore / KnowledgeStore / ThreadStore 的查询方法）在 Phase 0-1 就已存在。MVP 的五个 find 方法只是对现有 Store 查询接口的薄封装，工程量小但验证价值极大——有了 Query，作者可以立即验证"我写入的世界状态是否正确"，而不需要等 LLM 集成完整后再验证。自然语言查询（V2）仍留在 Phase 3。

**Phase 1.5A 启动边界（2026-06-10 冻结）**：当前 `ThreadStore` 仍为占位，`ThreadResolver` 属于 Phase 2 主体。因此 Phase 1.5A 先实现 `findFacts / findKnowledge / findEvents / findEntities` 四个只读查询；`findThreads` 等 Phase 2 的 Thread 生命周期管理起步后再接入。Phase 1 的写入验收与 Phase 1.5 启动门槛见 `docs/phase-1-acceptance.md`。

### 11.4 后续迭代路线图

1. **CausalTracer**：因果依赖图，环路检测，Retcon 级联失效树（DFS/Tarjan）
2. **Ontology 编译器**：World Package（Schema + Rules + Knowledge Data）存储在 SQLite 中，支持运行时动态扩展
3. **持久化与版本控制**：Event Store 落盘，Snapshot，时间线分支管理
4. **GraphLayer 多层语义**：canon / belief / timeline / rule 多层图谱，只读视图
5. **增量计算**：依赖缓存，脏标记传播，惰性重算
6. **Wiki DSL（人工入口）**：作为人类直接编辑世界设定的可选格式，编译为 FactChange[]，不走 LLM 路径

### 11.7 Latency Budget（延迟预算）

Narrative-OS-Core 的用户模型是**单作者单项目**，不是 SaaS。性能优化的目标不是 QPS，而是**交互响应**——作者在写作过程中的操作延迟必须在人类感知阈值内。

**热路径延迟预算**（`get_context_slice` → RelevantFactRetriever）：

| 步骤 | 目标延迟 | 说明 |
|------|---------|------|
| Step 0：短期记忆注入（SQLite） | < 10ms | 最近章节 Fact 直接查询 |
| Step 1：精确检索（SQLite） | < 20ms | 实体快照 + 关系 Fact |
| Step 2：语义检索（LanceDB） | < 100ms | 向量相似度查询 |
| Step 3：线索注入（ThreadStore） | < 10ms | 未关闭线索查询 |
| Step 4：排序截断 | < 5ms | 内存操作 |
| Step 5：知识感知过滤 | < 10ms | KnowledgeStore 查询 |
| **总计** | **< 200ms** | 超出则作者感知卡顿 |

**写入路径延迟预算**：

| 操作 | 目标延迟 | 说明 |
|------|---------|------|
| `propose_event`（含沙盒推演） | < 500ms | 含 Phase A（事务外推演） |
| `commit_event`（Phase B 事务） | < 20ms | 仅 SQLite 写入 |
| `commit_event`（Phase C 异步） | 不阻塞 | LanceDB 同步与缓存刷新在后台；审计日志已在 Phase B 落盘 |
| `propose_retcon`（BFS 遍历） | < 1000ms | 低频操作，可接受较高延迟 |

**ContextAnalyzer 不在热路径上**：ContextAnalyzer 的调用结果应异步预生成并缓存——章节/大纲确定时就跑一次，`get_context_slice` 直接读缓存。LLM 调用（即使只有 200-500ms）不应阻塞任何用户操作。

**性能优先级排序**：

| 指标 | 重要度 | 原因 |
|------|--------|------|
| Context / Retrieval Latency | 🔴 最高 | 直接影响写作体验 |
| Commit Latency | 🟡 中等 | 人类操作驱动，200ms 内无感知 |
| Concurrent Throughput | 🟢 最低 | 单用户模型，无需优化 |

### 11.8 Retrieval 质量评估框架

> **设计前提**：以下评估框架的落地依赖于 Phase 0.5 Integration Spike 的结果。如果 Spike 证明 bge-m3 对中文叙事检索的基本可行性不足，整个 Retrieval 路线可能需要调整（引入 reranker、BM25 混合检索、或更换 embedding 模型）。

**工程指标（Recall@K，固定 K，横向可比较）**：

| 指标 | 含义 | 目标 |
|------|------|------|
| Recall@5 | 前 5 条结果中的召回率 | 关键 Fact 不遗漏 |
| Recall@10 | 前 10 条结果中的召回率 | 主线场景完整覆盖 |
| Recall@20 | 前 20 条结果中的召回率（默认 topK） | 系统实际工作点 |
| Recall@50 | 前 50 条结果中的召回率 | 大型场景兜底 |

**产品指标（SceneCoverage，按场景类型）**：

| 场景类型 | 语义难度 | 示例 |
|---------|---------|------|
| 修炼突破 | 简单 | "张三渡劫" → 召回"张三怕雷" |
| 探索解谜 | 中等 | "张三进入古墓" → 召回"古墓门口有师父留下的禁制" |
| 人物谈判 | 困难 | "李四与王五谈判" → 召回"王五曾背叛李四的师兄" |
| 立场转变 | 极难 | "赵六决定帮主角" → 召回"赵六欠主角一条命（第50章）" |

**Step 0 边际贡献评估**：

Step 0（短期工作记忆强制注入）与 Step 2（LanceDB 语义检索）存在职责重叠。必须通过对比实验量化 Step 0 的独立价值：

```
实验设计：
  A 组：不含 Step 0 的 Recall@K
  B 组：含 Step 0 的 Recall@K
  差值 = Step 0 的边际贡献

判定标准：
  差值 ≥ 30%：Step 0 是不可或缺的兜底机制
  差值 10-30%：Step 0 有价值但可考虑简化
  差值 < 10%：Step 0 是不必要的复杂度，考虑移除
```

**决策树（Phase 0.5 Spike 结果驱动）**：

```
Spike 结果：bge-m3 + LanceDB 对中文叙事检索的 Recall（困难级别）
├── ≥ 60% → 继续当前六段检索路线，Phase 3 做完整 Retrieval
├── 40-60% → 引入 reranker 或 BM25+向量混合检索，调整 Phase 3 工期
└── < 40% → 换 embedding 模型或重构 Retrieval 基本路线
```

#### §11.8.1 Spike 1 测试集构造规范 (Golden Dataset)

Spike 1 的可信度完全取决于测试集的质量。必须通过程序化规则构造包含"硬负样本（Hard Negatives）"的基准数据集，避免测试数据过于简单导致 Recall 虚高。

**1. 数据规模与生成策略**

| 数据类型 | 数量 | 生成方式 | 质量控制 |
|:---|:---|:---|:---|
| 基准 Fact | 4800 条 | 基于 World Package 模板程序化生成（修仙/诡秘/科幻三套世界观） | 人工抽检 5%，确保 predicate 符合 World Package 规范 |
| 硬负样本 | 200 条 | 按下方规则程序化注入，确保与正样本高度相似但逻辑无关 | 100% 规则生成，禁止 LLM 自由发挥 |
| 查询 Query | 20 个 | 覆盖简单/中等/困难/极难四级，每级 5 个 | 每个 Query 绑定 1-3 个 Ground Truth Fact ID |

**2. 硬负样本构造规则（核心）**

向量模型最容易在以下三类场景中发生语义混淆，必须针对性构造干扰项：

| 混淆类型 | 构造规则 | 示例（Query vs 硬负样本） | 考察能力 |
|:---|:---|:---|:---|
| 实体重叠+谓词错位 | 保持 subject/object 一致，替换为无关 predicate | Q: "韩立突破筑基的前置条件" → N: "韩立筑基期使用的法器" | 区分因果关系与状态关联 |
| 时间邻近+因果无关 | 保持 chapter 范围一致，提取同场景无关 Fact | Q: "张三进入古墓触发的禁制" → N: "张三在古墓门口遇到的野狗" | 过滤空间邻近噪声 |
| 语义相似+作用域隔离 | 保持文本相似度 >0.85，但 context 不同 | Q: "李四在现实世界的仇人" → N: "李四在梦境副本中的仇人" | 验证 ContextScope 遮蔽有效性 |

**3. 评估执行规范**

- 所有 Query 必须通过 `RelevantFactRetriever` 的六段检索管线执行（Step 0~5），禁用人工过滤。
- 记录每个 Query 的 `Recall@5/10/20/50`、硬负样本误命中率（False Positive Rate）、平均查询延迟。
- 验证数据与裁决结论记录于本节下方，作为后续 Phase 的门控依据。

#### §11.8.2 Retrieval 失败降级预案 (Plan B Architecture)

若 Spike 1 触发决策树的 Conditional Pass 或 Fail 分支，Core 必须具备平滑降级能力。以下预案在设计期预留接口，实施期按需激活，确保不破坏 Core Invariants。

**预案 A：BM25 + 向量混合检索（Conditional Pass 触发）**

- **适用场景**：Recall@20 在 40-60% 之间，或硬负样本误命中率 >20%（语义噪声大）。
- **架构调整**：
  - 新增 `HybridRetrieverAdapter` 实现 `VectorStore` 接口。
  - 检索策略改为双路召回：LanceDB（语义） + 嵌入式倒排索引（BM25，如 `flexsearch`）。
  - 结果融合采用 RRF（Reciprocal Rank Fusion）：`Score = 1/(k + rank_semantic) + 1/(k + rank_lexical)`，默认 k=60。
- **接口影响**：`RelevantFactRetriever` Step 2 无需修改，仅底层 Adapter 替换。延迟预算增加 30-50ms，仍在热路径 <200ms 范围内。
- **数据影响**：Fact 写入时同步提取 `predicate + object` 关键词构建倒排索引，存储于 SQLite FTS5 虚拟表。

**预案 B：轻量级依赖图遍历降级（Fail 触发）**

- **适用场景**：Recall@20 < 40%，纯向量路线对中文叙事长程依赖彻底失效。
- **架构调整**：
  - 放弃 Step 2 的语义 Push 主导权，降级为"辅助兜底"。
  - 激活 Phase 1.5 的 `Dependency Graph` 与 `Narrative Query Layer`（见 §11.3）。
  - `ContextAnalyzer` 切换为确定性图遍历模式：基于当前场景 Entity 提取 `subject`，沿 `Fact.causeEvent → event_dependencies` 边进行 BFS/DFS 追溯（深度≤3）。
- **接口影响**：`ContextAnalyzer` 增加 `mode: 'semantic' | 'graph'` 策略开关。`FactStore` 需提供 `getFactDependencies(factId)` 投影查询。
- **设计边界**：此预案牺牲了"隐性语义关联"的发现能力，但保证了"显式因果链"的 100% 召回。符合 I-1（Fact First）与 I-7（确定性优先）不变式。

**预案激活决策矩阵**

| Spike 1 结果 | 激活预案 | 工期影响 | 架构风险 |
|:---|:---|:---|:---|
| Recall ≥ 60% | 无（维持纯向量） | 无 | 低 |
| 40% ≤ Recall < 60% | 预案 A（混合检索） | Phase 4 +3 天 | 中（需调优 RRF 权重） |
| Recall < 40% | 预案 B（图遍历降级） | Phase 4 +7 天，Phase 1.5 提前 | 高（ContextAnalyzer 逻辑重构） |

### 11.5 Core Invariants（核心不变式）

以下不变式是 Core Engine 的铁律，任何实现都必须满足。它们也是未来测试套件的锚点——每个 Invariant 对应至少一个集成测试。

| # | 不变式 | 含义 | 违反后果 |
|---|--------|------|---------|
| I-1 | **Every Fact has a source Event** | 每条 Fact 的 causeEvent 必须指向一个已存在的 NarrativeEvent | 野 Fact 污染世界状态 |
| I-2 | **Knowledge must reference an existing Fact** | Knowledge.factId 必须指向 facts 表中的真实记录 | 幻觉 Knowledge |
| I-3 | **Closed Thread cannot reopen automatically** | 状态为 FILLED / RESOLVED 的 Thread 只能被 Retcon 手动恢复（回退到 UNFILLED / PLANTED），不能被普通事件自动重开 | 线索系统崩坏 |
| I-4 | **Rule Engine cannot modify historical Events** | 规则只能影响沙盒预演和未来事件，不能改写已 commit 的 Event | Event Sourcing 失效 |
| I-5 | **World Package cannot execute code** | 声明式规则 JSON 不包含循环、递归、函数、副作用（见 H.5 白名单） | Core 变成 VM |
| I-6 | **Knowledge is single-layer only** | Knowledge 只记录 entity→fact 的单层映射，禁止嵌套（A 认为 B 认为 X） | 复杂度爆炸（原则九） |
| I-7 | **Fact is the source of truth, Event is the ledger** | 当前世界状态从 Fact 查询，不从 Event 重放推导（Snapshot 除外） | Event-Centric 偏移 |
| I-8 | **Single-writer per project** | 同一时刻只有一个活跃的写入会话，无并发写入 | 数据竞态 |
| I-9 | **Thread Never Has Causal Power** | NarrativeThread 永远不作为任何规则推理、事实写入、知识投影的输入。Thread 只能被创建、被关闭、被渲染、被检索展示——它没有因果权 | Thread 退化为第二事实系统，形成 Fact→Thread→Fact 环路 |
| I-10 | **Rule Engine Never Reads Knowledge** | Transition / Inference / Constraint / Propagation 四类规则的判定输入只有 FactStore + NarrativeEvent，永不读取 KnowledgeStore。传播规则产出 Knowledge（写）但不消费已有 Knowledge 作为判定依据（读）。去重由 commit_event 处理层执行，不在规则内部。认知状态的叙事判断由 LLM 在读取流完成 | 违反原则九，打开 Belief / Theory of Mind 通道 |
| I-11 | **Global Monotonic Timeline** | `chapter` 是系统的绝对时间坐标，全局单调递增。无论当前处于什么 ContextScope（副本/梦境/主线），chapter 不停不退不分支。系统不存在"局部时间轴" | 时间切片查询（validFrom <= atChapter）失效，Retcon 跨作用域因果链断裂，陷入相对时间转换死局 |

**I-9 的具体禁止清单**：

| 允许 | 禁止 |
|------|------|
| Fact → Thread（规则引擎生成线索） | Thread → Rule Engine（线索状态不得触发规则） |
| Knowledge → Thread（认知冲突生成线索） | Thread → Fact（线索不得创建/修改/删除事实） |
| Event → Thread（事件核销线索） | Thread → Knowledge（线索不得改变角色认知状态） |
| Retriever → Thread（检索展示未关闭线索） | Thread → Retrieval Query Signal（线索不得影响检索策略） |
| Renderer → Thread（渲染线索摘要） | Thread → World Package（线索不得修改配置） |

> **设计意图**：Thread 是叙事账本，记录"作者对读者欠了什么承诺"。它是被动的观察记录，不是主动的因果参与者。一旦 Thread 获得因果权（例如"如果有一个未填的代价线程就禁止某类事件"），Thread 就不再是叙事账本而是第二套世界状态，系统复杂度将失控。此不变式是 Core 边界的第一道防线。

### 11.6 Core Dependency Graph（核心依赖图）

Narrative-OS-Core 的 10 个核心概念之间存在严格的单向依赖关系。此依赖图是架构的"宪法"——任何新增模块或修改必须回答：它依赖谁？谁依赖它？

```
Core Dependency Graph（单向，禁止逆向）

  Entity
    ↓
  Event
    ↓
  Fact ────────────────┬──────────────┬──────────────┐
    ↓                   ↓              ↓              ↓
  Knowledge          Thread       Embedding      Snapshot
  (认知事件流)    (Fact 观察)   (Fact 派生)   (Fact 缓存)
    ↓
  Retrieval
  (Knowledge 感知)

  World Package（配置层，注入 Rule Engine 和 FactStore，不被任何模块修改）
  Rule Engine（推理层，从 Fact/Event → Fact/Knowledge/Thread，不反向修改）
```

**禁止的逆向依赖**：

| 禁止 | 原因 |
|------|------|
| Knowledge → Fact | Knowledge 是独立的认知事件流（非 Fact 投影），不得反向修改事实 |
| Thread → Fact | Thread 是观察层标记，不得生成/修改/删除 Fact |
| Thread → Knowledge | Thread 不得改变角色的认知状态 |
| Embedding → Fact | 向量索引是派生数据，不得反向修改 SQLite |
| Snapshot → Fact | 快照是查询缓存，不是状态源 |
| Rule → Rule | 规则不得自修改或生成其他规则（§5.2） |
| Rule → World Package | 规则不得修改世界配置包（§5.2） |
| Retrieval → Fact | 检索只读，不得修改被检索的数据 |

**核心分层**：

| 层级 | 模块 | 性质 |
|------|------|------|
| Truth Layer（真相层） | Entity → Event → Fact | 世界状态的唯一真相来源 |
| Validation Layer（校验层） | Rule Engine, Retcon | 从真相推导/校验，不反向修改真相 |
| Projection Layer（投影层） | Thread, Snapshot, Embedding | Fact 的派生视图，删除可重建 |
| Cognitive Layer（认知层） | Knowledge | 独立认知事件流，拥有不可重算的 seal/restore/decay 历史 |
| Retrieval Layer（检索层） | Semantic Search | 只读查询 |
| Package Layer（配置层） | World Package | 声明式配置，不执行代码 |

**Fact First 恢复不变式**：只要保留 Fact + Event，Projection 层数据（Thread / Snapshot / Embedding）均可完全重建——Thread 从 Fact + Rule Engine 重跑，Snapshot 从 Fact + Event 重放，Embedding 从 Fact 重算。

> **Knowledge 的例外**：Knowledge 不属于可重建的 Projection——它拥有独立的 seal / restore / decay / soul_read / implant 状态变迁历史，这些认知状态由事件驱动且不可从 Fact 重算。Knowledge 与 Fact 是两条并行的事件流（§3.6 "双流写入"），重建 Knowledge 需要保留 Knowledge 自身的事件历史，而非仅依赖 Fact + Event。

---

## 附录 A：术语表

| 术语 | 英文 | 定义 |
|------|------|------|
| 事实 | Fact | 世界状态的最小原子单元，三元组（subject, predicate, value），不可变 |
| 事实组 | FactGroup | 原子事务单元，一个事件产生的所有变更的集合 |
| 叙事事件 | NarrativeEvent | 驱动世界状态变更的唯一入口 |
| 叙事线索 | NarrativeThread | 统一的叙事承诺追踪（原 Cost + Foreshadowing），回溯型和渐进型共用 |
| 关系 Fact | Relation Fact | predicate 描述关系类型、value 为 EntityRef 的 Fact |
| 知识可见性 | Knowledge | 角色/组织对 Fact 的认知状态：谁在何时知道了什么，确信度如何 |
| 实体分类 | EntityKind | 14 种实体类型标签，替代原 EntityType |
| 关系语义 | RelationKind | 15 种关系语义类别，Fact 的可选元数据字段 |
| 语义检索层 | Semantic Retrieval Layer | 主动发现并注入相关 Fact 的系统组件，解决 LLM 上下文盲区 |
| 事实渲染层 | FactRenderer | 将 Fact 结构化数据转化为 LLM 可读 Wiki Markdown 的单向输出层 |
| Push 模式 | Push Mode | 系统主动语义检索并注入上下文，不等 LLM 主动查询 |
| Pull 模式 | Pull Mode | LLM 主动发起查询请求（仍保留 get_context_slice 作为按需补充） |
| 时间切片 | Time Slice | 查询某一特定章节时刻的世界状态快照 |
| 沙盒推演 | Sandbox Simulation | Rule Engine 在不修改真实 FactStore 的前提下计算事件后果 |
| 确定性状态 | Certainty | Fact 的四种状态：canonical / contested / potential / orphaned |

---

## 附录 B：架构对比总结

```
                旧方案                          当前方案
─────────────────────────────────────────────────────────────
写入路径        LLM → DSL 字符串              LLM → JSON Schema
                → WikiParser                  → 直接 FactChange[]
                → FactChange[]                （WikiParser 已删除）

关系表达        GraphEdge（计划中）            关系 Fact
                GraphNode（计划中）            predicate = 'enemy_of'等

图结构          存储层（计划中）               派生视图（只读，不存储）

上下文策略      Pull：LLM 主动查询             Push：系统主动检索注入
                get_context_slice 为主         ContextAnalyzer + LanceDB 为主
                （LLM 不知道该查什么）          get_context_slice 降级为按需补充

语义检索        后续迭代（GraphRAG）            核心组件
                                               Semantic Retrieval Layer

Tool 参数       wiki_dsl: string               fact_changes: FactChangeInput[]
                （正则解析，脆弱）              （JSON Schema，可靠）

Wiki 协议层     WikiParser + WikiRenderer       WikiParser 删除
                （作为整体存在）                FactRenderer（仅输出）
─────────────────────────────────────────────────────────────
```

---

## 附录 C：开发顺序建议

根据依赖关系，建议按以下顺序实现：

```
Phase 0（项目骨架）：
  package.json + tsconfig.json + Vitest 配置
  → 安装依赖：better-sqlite3 / @lancedb/lancedb / @types/better-sqlite3
  → 适配器接口定义（types.ts 中的接口 + 各适配器的 constructor）

Phase 0.5（Integration Spike —— 架构假设验证，关键门控）：
  目标：用最小实验验证三个技术假设是否成立，输出 Architecture Validation Report。
  假设失败则调整技术路线，不继续后续 Phase。

  Spike 1（最关键）：Embedding + Retrieval 端到端验证
    → 构造 5000 条中文小说设定 Fact（含 200 条相似干扰项）
    → 20 个查询场景（覆盖简单/中等/困难/极难四个级别，重点验证困难级）
    → 输出：Recall@5/10/20/50、按难度分层的 Recall、干扰项误命中率、平均查询延迟
    → 判定标准：困难级 Recall ≥ 60% 为通过（见 §11.8 决策树）

  Spike 2（基础设施）：SQLite + LanceDB 功能/性能
    → SQLite WAL 模式验证：单事务 Phase B 延迟 < 20ms
    → LanceDB metadata filter 兼容性验证（certainty + is_current + context 组合过滤）
    → SQLite 递归 CTE 性能：scope 深度 10 层的 Fact 查询延迟
    → 并发事务延迟：两个串行 propose_event 的排队影响

  Spike 3（独立验证）：Knowledge 查询模式
    → 使用临时 SQLite schema 生成 5 万条 Knowledge 测试数据，不依赖正式 KnowledgeStore 实现
    → seal/restore/decay 叠加后的"取最新一条"SQL 查询性能
    → 复合索引 (entity_id, fact_id, known_since) 的实际效果

Phase 1（基础）：
  types.ts → SQLiteFactStoreAdapter（better-sqlite3 实现）
  → 最小 SQLiteKnowledgeStoreAdapter（表结构 + create/batchCreate/getLatest/getByFactId）
  → Rule Engine（通过 World Package 加载规则集 + 2条通用传播规则，沙盒推演）
  → propose_event 支持 dependent_fact_ids 可选声明（轻量级依赖追踪，见 §11.3）
  → knowledge_changes 最小写入闭环（seal/restore/decay/soul_read/implant 追加 Knowledge 事件）

Phase 2（线索系统 + 知识合并）：
  ThreadResolver → NarrativeThread 生命周期管理
  → 知识广播合并逻辑（hints > broadcast > propagation > auto）
  → knowledge_changes 高级合并策略与实体认知能力校验

Phase 3（渲染与工具）：
  FactRenderer → Tool Interface（10个 LLM 工具）

Phase 4（语义检索）：
  FactEmbedder（硅基流动 bge-m3 API 调用）
  → LanceDBTableAdapter（LanceDB 表初始化 + 检索）
  → ContextAnalyzer（规则化快速路径 + LLM 深度分析双模式，异步预生成缓存）
  → RelevantFactRetriever（六段检索管线 + 知识感知过滤）

Phase 5（集成验证）：
  端到端测试（绝脉突破完整场景）
  Push 模式完整流程验证
  Retrieval 质量评估（Recall@K + SceneCoverage + Step 0 边际贡献）
```

Phase 0 是新增的前置步骤，确保项目骨架和适配器接口就绪后再开始实现。
Phase 4 依赖 Phase 1-3 已有数据，但其设计决策需要在 Phase 1 的类型定义中就预留（embeddingText 字段、LanceDB 同步接口）。

---

*文档结束*

*本文档定义了 Narrative-OS-Core 的架构设计，整合了关键设计决策：JSON Schema 写入路径、时序三元组存储模型、语义检索层、知识传播架构、World Package 配置化。下一步按附录 C 的开发顺序推进。*

---

## 附录 D：技术栈与适配器模式

### D.1 技术栈

| 层面 | 选择 | 说明 |
|------|------|------|
| 运行时 | Node.js 18+ | TypeScript 原生支持 |
| 语言 | TypeScript 5.x | 严格模式，类型安全 |
| 结构化存储 | SQLite via better-sqlite3 | 同步 API，零配置，本地文件存储 |
| 向量存储 | LanceDB via @lancedb/lancedb (npm) | 嵌入式向量数据库，原生 Windows 支持，零服务进程 |
| Embedding | 硅基流动 BAAI/bge-m3 | 1024 维，免费 API |
| LLM | DeepSeek v4-flash / v4-pro | 写作、规划、决策 |
| 测试 | Vitest | TypeScript 原生，Vite 生态 |
| 包管理 | npm 或 pnpm | 无特殊要求 |

### D.2 适配器模式设计

为每个外部依赖定义适配器接口，业务逻辑只依赖接口，不直接调用 better-sqlite3 或 LanceDB API。后续如需替换存储后端，只需编写新的适配器实现。

**设计原则**：
- 适配器是纯实现层，不包含业务逻辑
- 接口定义在 `types.ts`，适配器实现在各 `adapters/` 目录
- 单元测试 mock 接口即可，不碰真实数据库
- 集成测试使用临时文件（`:memory:` SQLite + LanceDB temp dir），测试后清理

**适配器清单**：

| 接口 | 适配器实现 | 后端 |
|------|-----------|------|
| `FactStore` | `SQLiteFactStoreAdapter` | better-sqlite3 |
| `ThreadStore` | `SQLiteThreadStoreAdapter` | better-sqlite3（与 FactStore 同库不同表） |
| `KnowledgeStore` | `SQLiteKnowledgeStoreAdapter` | better-sqlite3（与 FactStore 同库不同表） |
| `EventStore` | `SQLiteEventStoreAdapter` | better-sqlite3（与 FactStore 同库不同表） |
| `ProposalStore` | `InMemoryProposalStore` | 内存 Map（当前） |
| `VectorStore` | `LanceDBVectorStoreAdapter` | @lancedb/lancedb |
| `FactEmbedder` | `SiliconFlowEmbedderAdapter` | 硅基流动 bge-m3 API |
| `LLMClient` | `DeepSeekLLMClientAdapter` | DeepSeek API |

> **存储说明**：Proposal 使用内存 Map 存储（进程重启后丢失，需重新提交）。
> EntityRecord 存储在 SQLite 的 `entities` 表中，与 Fact 表同库。
> NarrativeEvent 存储在 SQLite 的 `events` 表中，与 Fact 表同库。
> NarrativeThread 存储在 SQLite 的 `threads` 表中，与 Fact 表同库。
> Knowledge 存储在 SQLite 的 `knowledge` 表中，与 Fact 表同库。
> LanceDB 同步 outbox/重试队列存储在 SQLite 的 `sync_queue` 表中。
> FactStore、ThreadStore、EventStore、KnowledgeStore、EntityRecord 共享同一个 SQLite 连接（`{project_id}.db`），通过 `SQLiteConnectionFactory` 统一管理。
> 项目元数据存储在全局 `narrative_os_meta.db` 中（见附录 E.10）。

### D.3 目录结构

```
Narrative-OS-Core/
├── narrative_os_core/              # Core 引擎（本项目的核心代码）
│   ├── src/
│   │   ├── types.ts                # 所有接口 + 类型定义（零依赖）
│   │   ├── adapters/
│   │   │   ├── sqlite-fact-store.ts    # SQLiteFactStoreAdapter
│   │   │   ├── sqlite-thread-store.ts    # SQLiteThreadStoreAdapter
│   │   │   ├── sqlite-knowledge-store.ts # SQLiteKnowledgeStoreAdapter
│   │   │   ├── sqlite-event-store.ts   # SQLiteEventStoreAdapter
│   │   │   ├── lancedb-vector-store.ts # LanceDBVectorStoreAdapter
│   │   │   ├── siliconflow-embedder.ts # SiliconFlowEmbedderAdapter
│   │   │   └── deepseek-llm.ts         # DeepSeekLLMClientAdapter
│   │   ├── engine/
│   │   │   ├── rule-engine.ts      # Rule Engine（依赖 FactStore 接口）
│   │   │   ├── thread-resolver.ts    # ThreadResolver
│   │   │   ├── context-analyzer.ts # ContextAnalyzer（轻量 LLM 调用）
│   │   │   └── relevant-fact-retriever.ts # RelevantFactRetriever（六段检索管线）
│   │   ├── renderer/
│   │   │   └── fact-renderer.ts    # FactRenderer（纯函数，无外部依赖）
│   │   └── tools/
│   │       └── tool-interface.ts   # 10个 LLM Tool 定义 + 路由
│   ├── index.ts                    # 包入口文件（导出公共接口和类型）
│   ├── tests/
│   │   ├── unit/                   # 单元测试（mock 适配器接口）
│   │   └── integration/            # 集成测试（真实 SQLite + LanceDB）
│   ├── .env.local                  # API Key 存储（DEEPSEEK_API_KEY / SILICONFLOW_API_KEY）
│   ├── .gitignore                  # 排除 data/、.env.local、node_modules/
│   ├── data/                       # 运行时数据目录（.gitignore 排除）
│   │   ├── narrative_os_meta.db      # 全局元数据库（用户 + 项目注册信息）
│   │   ├── projects/               # 按项目 ID 分目录
│   │   │   ├── proj_xianxia_01.db  # 项目 1 的 SQLite 数据库
│   │   │   ├── proj_xianxia_02.db  # 项目 2 的 SQLite 数据库
│   │   │   └── ...
│   │   └── lancedb/                # LanceDB 向量数据
│   │       ├── proj_xianxia_01/    # 项目 1 的 LanceDB 数据
│   │       ├── proj_xianxia_02/    # 项目 2 的 LanceDB 数据
│   │       └── ...
│   ├── package.json
│   ├── tsconfig.json
│   └── vitest.config.ts
├── docs/                           # 项目文档
│   └── Narrative-OS-Core-Architecture.md
└── README.md
```

### D.4 依赖清单（package.json）

```json
{
  "dependencies": {
    "better-sqlite3": "^11.x",
    "@lancedb/lancedb": "^0.x",
    "dotenv": "^16.x"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.x",
    "typescript": "^5.x",
    "vitest": "^2.x"
  }
}
```

**选型理由**：
- **better-sqlite3**：Node.js 生态最成熟的 SQLite 绑定，同步 API（无需 async/await 管理事务），C++ 原生模块，Windows 兼容性一流
- **@lancedb/lancedb**：LanceDB 官方 Node.js SDK，嵌入式运行，无需 Docker/服务进程，支持 metadata filter + 向量混合检索，IVF_PQ 索引适合 1024 维向量
- 两个依赖都是纯本地文件操作，不引入任何网络服务依赖

### D.5 适配器接口定义示例

```typescript
// types.ts —— 接口定义，零依赖

// LLM 客户端接口（业务代码通过接口调用 LLM，不直接 fetch DeepSeek API）
interface LLMClient {
  chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResponse>;
}

// Embedding 服务接口（业务代码通过接口调用，不直接 fetch 硅基流动 API）
interface EmbeddingService {
  embed(texts: string[]): Promise<number[][]>;  // N × 1024
  embedSingle(text: string): Promise<number[]>;  // 单条，1024 维
}

// 向量存储接口
interface VectorStore {
  search(vector: number[], filter?: string, topK?: number): Promise<ScoredFact[]>;
  add(facts: VectorFact[]): Promise<void>;
  markInvalid(factId: string, validTo: number): Promise<void>;
  // 批量更新向量的 certainty 字段（Retcon 场景：canonical → contested）
  // 不删除向量，只修改 certainty 和 is_current 字段，保证后续检索不命中
  updateCertainty(factId: string, certainty: string): Promise<void>;
  initTable(): Promise<void>;
}

interface ScoredFact {
  factId: string;
  subject: string;
  predicate: string;
  score: number;  // 向量相似度
}
```

---

## 附录 E：SQLite 表结构定义

每个小说项目使用一个独立的 SQLite 数据库文件（`{project_id}.db`），以下为完整的表结构定义。

### E.1 entities 表（实体注册表）

```sql
CREATE TABLE IF NOT EXISTS entities (
  id               TEXT PRIMARY KEY,            -- 'ent_zhangsan'
  name             TEXT NOT NULL,                -- '张三'
  kind             TEXT NOT NULL,                -- EntityKind 枚举值（14种）
  description      TEXT,                         -- 可选描述
  first_appearance REAL NOT NULL,               -- 首次出场章节（支持小数编号）
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),  -- ISO 8601
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))   -- 最后更新时间，审计追踪用
);

CREATE INDEX idx_entities_kind ON entities(kind);
CREATE INDEX idx_entities_first_appearance ON entities(first_appearance);
```

### E.2 facts 表（时序三元组存储）

```sql
CREATE TABLE IF NOT EXISTS facts (
  id               TEXT PRIMARY KEY,             -- 'fct_tribulation_50_01'
  subject          TEXT NOT NULL,                 -- 实体 ID，REFERENCES entities(id)
  predicate        TEXT NOT NULL,                 -- 谓词
  value_type       TEXT NOT NULL DEFAULT 'scalar', -- 'scalar' | 'entity_ref'
  value_scalar_type TEXT,                         -- scalar 子类型：'string' | 'number' | 'boolean'
  value_scalar     TEXT,                          -- 标量值（string / number / boolean 的文本表示）
  value_entity_ref TEXT,                          -- EntityRef 时目标实体 ID
  certainty        TEXT NOT NULL DEFAULT 'canonical', -- Certainty 枚举
  cause_event      TEXT NOT NULL,                 -- 产生此 Fact 的事件 ID
  valid_from       REAL NOT NULL,                 -- 生效章节号（支持小数编号如 49.5，见 §3.4）
  valid_to         REAL,                          -- 失效章节号（NULL = 当前有效，支持小数编号）
  -- is_current 为生成列，由 valid_to 自动推导，彻底消除双字段不一致风险
  is_current       INTEGER GENERATED ALWAYS AS (CASE WHEN valid_to IS NULL THEN 1 ELSE 0 END) VIRTUAL,
  context          TEXT NOT NULL DEFAULT 'global', -- 作用域
  relation_kind    TEXT,                          -- RelationKind 枚举（可选）
  embedding_text   TEXT NOT NULL DEFAULT '',       -- 向量化输入文本
  schema_version   INTEGER NOT NULL DEFAULT 1,     -- Fact 结构版本号（Schema Evolution 保险）
  FOREIGN KEY (subject) REFERENCES entities(id),
  FOREIGN KEY (cause_event) REFERENCES events(id)
);

-- 主索引：subject + predicate → 历史版本查询
CREATE INDEX idx_facts_subject_predicate ON facts(subject, predicate);
-- 事件溯源索引：cause_event → 事件产生的所有 Fact
CREATE INDEX idx_facts_cause_event ON facts(cause_event);
-- 关系反向索引：value_entity_ref → 指向某实体的所有关系 Fact
CREATE INDEX idx_facts_value_entity_ref ON facts(value_entity_ref)
  WHERE value_type = 'entity_ref';
-- 时间切片过滤：有效范围查询
CREATE INDEX idx_facts_valid_range ON facts(valid_from, valid_to);
-- certainty 索引：通常只查询 canonical / contested
CREATE INDEX idx_facts_certainty ON facts(certainty);
-- 作用域隔离索引：按 context 过滤的 canonical + current 查询是高频操作（§3.4.1）
CREATE INDEX idx_facts_context ON facts(context, certainty, is_current);
-- L9 注意：is_current 是 VIRTUAL 生成列（GENERATED ALWAYS AS）。SQLite 3.9+ 支持对
-- VIRTUAL 生成列创建索引，但 WHERE is_current = 1 的实际执行计划是否使用此索引
-- 需在 Phase 0.5 Spike 2 中通过 EXPLAIN QUERY PLAN 验证。如果验证发现 SQLite
-- 不利用此索引，降级方案为删除 is_current 列的索引，改用 WHERE valid_to IS NULL
-- 直接过滤（valid_to 是 STORED 列，索引利用率更可靠）。
```

### E.3 events 表（叙事事件存储）

```sql
CREATE TABLE IF NOT EXISTS events (
  id               TEXT PRIMARY KEY,             -- 'evt_tribulation_50'
  kind             TEXT NOT NULL DEFAULT 'business', -- 'business' | 'system'
  type             TEXT NOT NULL,                 -- 事件类型
  chapter          REAL NOT NULL,                 -- 叙事章节（支持小数编号如 49.5，见 §3.4）
  description      TEXT NOT NULL,                 -- 自然语言摘要
  params_json      TEXT NOT NULL,                 -- JSON 序列化的 EventParams
  context          TEXT NOT NULL DEFAULT 'global', -- 事件发生的作用域
  timestamp        TEXT NOT NULL DEFAULT (datetime('now')),  -- 系统时间 ISO 8601
  status           TEXT NOT NULL DEFAULT 'committed', -- 当前仅落盘已提交事件；'abandoned' 预留给未来持久化提案/撤销记录
  fact_group_id    TEXT NOT NULL,                 -- 关联的 FactGroup ID（与事件 ID 相同）
  resolved_threads TEXT NOT NULL DEFAULT '[]',    -- JSON 数组：核销的 Thread ID 列表
  dependencies_json TEXT NOT NULL DEFAULT '[]'    -- JSON 数组：依赖的前置 Fact ID 列表（审计冗余；查询以 event_dependencies 为准）
);

-- Retcon 提交也写入 events，type='retcon'，ID 形如 evt_retcon_30。
-- 这类系统事件不产生普通 Fact，但作为 contested 标记、Thread 恢复、audit_log、sync_queue 的统一锚点。
-- Schema Extension 提交也写入 events，type='schema'，ID 形如 evt_schema_50。
-- 这类系统事件不产生普通 Fact，也不写 sync_queue，只作为 wp_* 变更和 audit_log 的统一锚点。
-- kind='system' 的事件默认不进入 Retcon BFS / ThreadResolver / Rule Engine 的叙事因果查询。

-- 按章节范围查询（Retcon BFS 使用）
CREATE INDEX idx_events_chapter ON events(chapter);
CREATE INDEX idx_events_context ON events(context);
CREATE INDEX idx_events_kind ON events(kind);
-- 按事件类型查询（ThreadResolver 关闭判定使用）
CREATE INDEX idx_events_type ON events(type);
-- committed 是热路径默认状态；如未来持久化 abandoned/proposed 事件，此索引用于过滤当前账本
CREATE INDEX idx_events_status ON events(status);
-- 按主体查询（Retcon BFS 查找后续相关事件）
-- 注意：subject 存储在 params_json 中，此索引为生成列索引（SQLite 3.31+）
CREATE INDEX idx_events_params_subject ON events(json_extract(params_json, '$.subject'));
-- 性能洼地：BFS 的 Object.values(evt.params).includes(predicate) 过滤无法走索引，需遍历 JSON 值。
-- 当前数据量可接受，后续由 CausalTracer 迭代时优化（考虑 params_json 的 GIN 索引或拆分谓词列）。
```

### E.3.1 event_dependencies 表（事件级轻量依赖边）

```sql
CREATE TABLE IF NOT EXISTS event_dependencies (
  event_id         TEXT NOT NULL,                 -- 下游事件 ID
  fact_id          TEXT NOT NULL,                 -- 该事件依赖的上游 Fact ID
  source           TEXT NOT NULL DEFAULT 'llm',   -- 'llm' | 'system_exit_scope' | 'rule_inference' | 'retcon_cascade'
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (event_id, fact_id),
  FOREIGN KEY (event_id) REFERENCES events(id),
  FOREIGN KEY (fact_id) REFERENCES facts(id)
);

CREATE INDEX idx_event_dependencies_fact ON event_dependencies(fact_id);
CREATE INDEX idx_event_dependencies_event ON event_dependencies(event_id);
```

> **source 语义**：`llm` / `system_exit_scope` / `rule_inference` 表示业务事件对前置 Fact 的叙事依赖；`retcon_cascade` 仅表示 Retcon 系统事件的处理目标，默认因果遍历必须通过 `events.kind='business'` 排除。

### E.4 threads 表（叙事线索存储）

```sql
CREATE TABLE IF NOT EXISTS threads (
  id               TEXT PRIMARY KEY,             -- 'thr_miracle_50'
  type             TEXT NOT NULL,                 -- ThreadType 枚举
  direction        TEXT NOT NULL,                 -- 'retroactive' | 'progressive'
  severity         TEXT NOT NULL,                 -- 'minor' | 'major' | 'critical'
  description      TEXT NOT NULL,                 -- 自然语言描述
  close_condition  TEXT NOT NULL,                 -- JSON 序列化的 closeCondition
  status           TEXT NOT NULL,                 -- ThreadStatus 枚举
  closed_by        TEXT,                          -- 关闭此线索的事件 ID
  created_at_event TEXT NOT NULL,                 -- 产生此线索的源头事件 ID
  created_at_chapter REAL NOT NULL,              -- 产生此线索的章节（支持小数编号）
  related_entities TEXT NOT NULL DEFAULT '[]',     -- JSON 数组：关联实体 ID 列表
  upstream_fact_ids TEXT NOT NULL DEFAULT '[]',    -- JSON 数组：上游依赖的 Fact ID 列表，用于 OBSOLETE 自动检测
  milestones       TEXT NOT NULL DEFAULT '[]',     -- JSON 数组：ThreadMilestone 列表（全历史审计用）
  hint_count       INTEGER NOT NULL DEFAULT 0,     -- HINTED 状态里程碑计数（热路径查询用，addMilestone 时原子自增）
  tags             TEXT DEFAULT NULL,              -- JSON 数组：自由标签（如 ['side_arc', 'humor']），对应 NarrativeThread.tags
  arc_tag          TEXT DEFAULT NULL,              -- 关联的作用域名称（如 'arc_dream_01'），对应 NarrativeThread.arcTag，用于主线写作时排除副本线索
  FOREIGN KEY (created_at_event) REFERENCES events(id),
  FOREIGN KEY (closed_by) REFERENCES events(id)
);

CREATE INDEX idx_threads_status ON threads(status);
CREATE INDEX idx_threads_direction ON threads(direction);
CREATE INDEX idx_threads_severity ON threads(severity);
CREATE INDEX idx_threads_closed_by ON threads(closed_by);
CREATE INDEX idx_threads_created_chapter ON threads(created_at_chapter);
CREATE INDEX idx_threads_related_entities ON threads(json_extract(related_entities, '$[0]'));
-- OBSOLETE 扫描索引：commit_retcon Phase B 按上游 Fact ID 查找受影响的未关闭 Thread
-- 注：仅索引数组首元素，多上游场景需应用层二次过滤（与 related_entities 索引策略一致）
CREATE INDEX idx_threads_upstream_fact ON threads(json_extract(upstream_fact_ids, '$[0]'));
```

### E.5 sync_queue 表（LanceDB 同步 outbox / 重试队列）

```sql
CREATE TABLE IF NOT EXISTS sync_queue (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id         TEXT NOT NULL,                 -- 关联的事件 ID；Retcon 使用 evt_retcon_* 系统事件
  operation        TEXT NOT NULL,                 -- 'insert_vector' | 'mark_invalid' | 'update_certainty' | 'rebuild_event_vectors'
  fact_ids         TEXT NOT NULL,                 -- JSON 数组：需同步的 Fact ID
  payload_json     TEXT NOT NULL DEFAULT '{}',    -- 操作参数，如 certainty 更新目标值
  status           TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'running' | 'done' | 'failed'
  retry_count      INTEGER NOT NULL DEFAULT 0,
  max_retries      INTEGER NOT NULL DEFAULT 3,
  next_retry_at    TEXT NOT NULL,                 -- ISO 8601，下次重试时间
  last_error       TEXT,                          -- 最近一次失败的错误信息
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (event_id) REFERENCES events(id)
);

CREATE INDEX idx_sync_queue_next_retry ON sync_queue(next_retry_at);
CREATE INDEX idx_sync_queue_status_retry ON sync_queue(status, next_retry_at);
CREATE INDEX idx_sync_queue_operation ON sync_queue(operation);
```

### E.6 audit_log 表（LLM 提交审计日志）

```sql
CREATE TABLE IF NOT EXISTS audit_log (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id         TEXT NOT NULL,                 -- 关联的已提交事件 ID；Retcon 使用 evt_retcon_* 系统事件
  tool_name        TEXT NOT NULL,                 -- 调用的 Tool 名称
  raw_input_json   TEXT NOT NULL,                 -- 原始 Tool Call / FactChangeInput JSON
  timestamp        TEXT NOT NULL DEFAULT (datetime('now')),  -- 系统时间 ISO 8601
  status           TEXT NOT NULL DEFAULT 'committed', -- 已提交审计记录；未来持久化被拒绝提案时可用 'abandoned'
  FOREIGN KEY (event_id) REFERENCES events(id)
);

CREATE INDEX idx_audit_log_event ON audit_log(event_id);
CREATE INDEX idx_audit_log_timestamp ON audit_log(timestamp);
```

### E.7 knowledge 表（知识可见性存储）

```sql
CREATE TABLE IF NOT EXISTS knowledge (
  id               TEXT PRIMARY KEY,             -- 'kno_claine_fct_xxx'
  fact_id          TEXT NOT NULL,                 -- 被知晓的 Fact ID
  entity_id        TEXT NOT NULL,                 -- 知晓者实体 ID
  known_since      REAL NOT NULL,                 -- 从哪章开始知道（支持小数编号）
  source           TEXT NOT NULL,                 -- KnowledgeSource 枚举
  confidence       REAL NOT NULL DEFAULT 1.0,     -- 确信度 0.0-1.0
  previous_confidence REAL,                       -- seal 操作前的 confidence 值，用于 restore 恢复
  updated_at_event TEXT,                          -- 最后更新此知识的事件 ID
  FOREIGN KEY (fact_id) REFERENCES facts(id),
  FOREIGN KEY (entity_id) REFERENCES entities(id),
  FOREIGN KEY (updated_at_event) REFERENCES events(id)
);

CREATE INDEX idx_knowledge_entity ON knowledge(entity_id, known_since);
CREATE INDEX idx_knowledge_fact ON knowledge(fact_id);
CREATE INDEX idx_knowledge_confidence ON knowledge(confidence);
-- 核心查询模式索引：取某实体对某条 Fact 的最新认知状态（known_since DESC LIMIT 1）
-- 核心查询模式索引：取某实体对某条 Fact 的最新认知状态（known_since DESC, rowid DESC LIMIT 1）
-- 注：known_since DESC 通过反向扫描索引满足；rowid DESC 作为 tiebreaker 假设同一章节内的
-- Knowledge 记录按插入顺序递增（即 rowid 与写入顺序一致），此假设在 commit_event 事务内成立。
-- 若需严格保证，可升级为 (entity_id, fact_id, known_since DESC)。
CREATE INDEX idx_knowledge_entity_fact_time ON knowledge(entity_id, fact_id, known_since);
```

### E.8 project_state 表（项目级运行状态）

```sql
CREATE TABLE IF NOT EXISTS project_state (
  project_id        TEXT PRIMARY KEY,
  state_version     INTEGER NOT NULL DEFAULT 0,    -- commit_event / commit_retcon 成功时递增
  current_chapter   REAL NOT NULL DEFAULT 1,
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_project_state_version ON project_state(state_version);
```

> **用途**：`state_version` 是 Phase B 乐观锁的落点。`commit_event` 提交时必须先用 `expectedStateVersion` 条件更新本行；只有更新成功才能继续写 Event/Fact/Knowledge/Thread/audit/outbox。这样可以避免 Phase A 基于旧快照的推演被静默提交。

### E.9 World Package 存储表（项目库）

World Package 的运行时数据存储在项目 SQLite 数据库中，与 Fact/Event/Knowledge 共用同一实例。JSON 文件仅作为导入/导出格式。

```sql
CREATE TABLE IF NOT EXISTS wp_predicates (
  name                  TEXT PRIMARY KEY,             -- 谓词名，如 realm
  display_name          TEXT NOT NULL,                 -- 中文显示名
  value_type            TEXT NOT NULL,                 -- 'scalar' | 'entity_ref' | 'enum'
  enum_values_json      TEXT NOT NULL DEFAULT '[]',    -- JSON 数组
  sequence_order_json   TEXT NOT NULL DEFAULT '[]',    -- 有序枚举递进链，空数组表示无序
  description           TEXT NOT NULL DEFAULT '',
  relation_kind         TEXT NOT NULL,
  deprecated            INTEGER NOT NULL DEFAULT 0,    -- 1 表示不推荐新 Fact 使用
  replacement_predicate TEXT,                          -- deprecated 时可选
  package_id            TEXT NOT NULL DEFAULT 'project',
  package_version       TEXT NOT NULL DEFAULT '',
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS wp_predicate_aliases (
  alias_name            TEXT PRIMARY KEY,              -- 旧名称或 LLM 常用别名
  canonical_name        TEXT NOT NULL,                 -- 推荐写入的新谓词
  reason                TEXT NOT NULL DEFAULT '',
  package_id            TEXT NOT NULL DEFAULT 'project',
  FOREIGN KEY (canonical_name) REFERENCES wp_predicates(name)
);

CREATE TABLE IF NOT EXISTS wp_rules (
  id                    TEXT PRIMARY KEY,
  type                  TEXT NOT NULL,                 -- TransitionRule / InferenceRule / ConstraintRule / PropagationRule
  trigger_json          TEXT NOT NULL DEFAULT '{}',
  conditions_json       TEXT NOT NULL DEFAULT '[]',
  consequence_json      TEXT NOT NULL DEFAULT '{}',
  description           TEXT NOT NULL DEFAULT '',
  enabled               INTEGER NOT NULL DEFAULT 1,
  suppress_rule_id      TEXT,                          -- 禁用低优先级包规则
  package_id            TEXT NOT NULL DEFAULT 'project',
  package_version       TEXT NOT NULL DEFAULT '',
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS wp_entity_templates (
  name                  TEXT PRIMARY KEY,
  kind                  TEXT NOT NULL,
  extends               TEXT,
  default_predicates_json TEXT NOT NULL DEFAULT '[]',
  override_predicates_json TEXT NOT NULL DEFAULT '{}',
  package_id            TEXT NOT NULL DEFAULT 'project'
);

CREATE TABLE IF NOT EXISTS wp_scope_presets (
  id                    TEXT PRIMARY KEY,
  name                  TEXT NOT NULL,
  parent_scope_id       TEXT,
  default_exit_behavior TEXT NOT NULL DEFAULT 'suggest_discard',
  inherits_global_rules INTEGER NOT NULL DEFAULT 1, -- 是否继承全局规则（1=true, 0=false）
  override_rules_json   TEXT NOT NULL DEFAULT '[]',
  description           TEXT NOT NULL DEFAULT '',   -- 作用域预设的语义说明
  world_package_ids_json TEXT NOT NULL DEFAULT '[]',
  package_id            TEXT NOT NULL DEFAULT 'project'
);

CREATE INDEX idx_wp_predicates_deprecated ON wp_predicates(deprecated);
CREATE INDEX idx_wp_rules_type_enabled ON wp_rules(type, enabled);
CREATE INDEX idx_wp_templates_kind ON wp_entity_templates(kind);
```

> **演化约束**：`wp_predicate_aliases` 和 `wp_predicates.deprecated` 只影响后续写入、渲染提示和 LLM system prompt。它们不能触发对 `facts` 表的批量改写。

### E.10 projects 元数据表（全局库：narrative_os_meta.db）

```sql
-- 全局元数据库（非项目库），存储所有用户和项目的元信息
CREATE TABLE IF NOT EXISTS projects (
  id               TEXT PRIMARY KEY,              -- 'proj_xianxia_01'
  title            TEXT NOT NULL,                  -- '凡人修仙传'
  owner_id         TEXT NOT NULL,                  -- 所属用户 ID
  world_type       TEXT NOT NULL DEFAULT '',       -- 'xianxia' / 'western-fantasy' 等
  default_context  TEXT NOT NULL DEFAULT 'global', -- 默认作用域（对应 NovelProject.defaultContext）
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  db_path          TEXT NOT NULL,                  -- SQLite 文件路径
  lancedb_path     TEXT NOT NULL                   -- LanceDB 目录路径
);

CREATE INDEX idx_projects_owner ON projects(owner_id);
```

---

## 附录 F：多作品框架验证

以下选取不同题材、不同复杂度的知名作品，按**完整设定维度**逐一验证框架的建模能力。每个作品从力量体系、世界地理、势力组织、物品经济、信息机制、时间线结构、特殊机制、角色状态、伏笔结构等维度全面拆解。

### F.1 《诡秘之主》（乌贼）——维多利亚蒸汽朋克 + 克苏鲁

| 设定维度 | 具体设定 | 框架映射 | 状态 |
|---------|---------|---------|------|
| **力量体系：22条途径** | 占卜家、观众、秘祈人等22条途径，每条10个序列（9→0），序列0为真神，之上还有旧日/外神 | EntityKind.ability；Fact predicates: sequence/pathway/acting_method/corruption_level | ✅ |
| **序列扮演法** | 角色必须按序列对应的扮演守则行动来消化魔药，偏离导致精神污染 | Rule Engine TransitionRule：检测行为偏离 → 生成 NarrativeThread(rule_violation) | ✅ |
| **途径互换** | 相邻途径在序列4及以上可互换（如占卜家↔学徒） | Fact: pathway_switchable_to；Rule Engine ConstraintRule 校验互换合法性 | ✅ |
| **魔药消化进度** | 扮演法消化魔药需时间，消化完成才能晋升下一序列 | Fact: digestion_progress(0.0-1.0)；Rule Engine：消化完成是晋升前置条件 | ✅ |
| **非凡特性守恒** | 非凡特性总量不变，杀一个人会析出对应非凡特性 | Rule Engine InferenceRule：死亡事件 → 自动生成非凡特性析出 Fact | ✅ |
| **封印物** | 分0-3级危险度，使用有副作用，0级不可接触 | EntityKind.resource；Fact: danger_level/usage_cost；Rule Engine：使用0级封印物自动生成代价 | ✅ |
| **世界地理：多层空间** | 现实世界、灵界、灰雾之上、冥界、星空、神弃之地，规则各不相同 | ContextScope：global(现实)/spirit_world(灵界)/grey_fog(灰雾之上)/underworld(冥界)/godforsaken(神弃之地) | ✅ |
| **灰雾之上** | 克莱恩的特殊空间，可召开塔罗会、查阅历史、进行占卜 | ContextScope(grey_fog) + 特殊 World Package 规则（占卜增强、时间回溯） | ✅ |
| **神弃之地** | 真神无法进入的封闭空间，规则与现实不同 | ContextScope(godforsaken, suggest_promote) + 独立 World Package | ✅ |
| **势力组织** | 正神教会（7个）、隐秘组织（密修会、极光会等）、政府（5国）、海盗、值夜者 | EntityKind.entity + RelationKind.structural/social | ✅ |
| **塔罗会** | 克莱恩在灰雾之上建立的隐秘组织，成员以塔罗牌代号称呼 | EntityKind.entity(组织) + ContextScope(grey_fog) + Knowledge(成员间互相知道/不知道真实身份) | ✅ |
| **信息不对称（核心）** | 克莱恩多重身份（愚者/夏洛克/格尔曼/道恩），不同人知道不同身份；罗塞尔日记秘密只有克莱恩能解读 | Knowledge：每个身份 Fact 对不同角色 confidence 不同 | ✅ |
| **占卜术体系** | 灵视、梦境占卜、仪式魔法、灵体线等，各有约束条件 | EntityKind.ability + Rule Engine：占卜结果置信度、反噬代价 | ✅ |
| **仪式魔法** | 需要特定材料、咒文、环境，复杂仪式可能失败 | Fact: ritual_requirement + Rule Engine ConstraintRule：校验材料是否齐备 | ✅ |
| **历史设定：多个纪元** | 所罗门帝国、图铎帝国、苍白年代等，历史事件影响现代 | Event Sourcing + 时间切片查询任意历史时期 | ✅ |
| **时间线复杂性** | 罗塞尔穿越到500年前、克莱恩穿越到现代 | 事件章节号作为时间轴，通过 causeEvent 溯源任何设定到源头事件 | ✅ |
| **伏笔结构（超复杂）** | 愚者身份从第1章埋到第1000+章、罗塞尔日记碎片贯穿全文、白银城的秘密 | NarrativeThread progressive：PLANTED→HINTED(多次)→PARTIALLY_REVEALED→RESOLVED | ✅ |
| **角色精神状态** | 扮演不同身份的精神压力、融合前人格记忆、失控风险 | Fact: mental_state/persona_integration/loss_of_control_risk | ✅ |
| **跨界影响** | 现实世界的行为影响灵界，灵界变化反向影响现实 | Fact 的 context 跨作用域关联；Retcon BFS 跨 scope 通过 causeEvent 追溯 | ✅ |

### F.2 《凡人修仙传》（忘语）——传统修仙 700万字

| 设定维度 | 具体设定 | 框架映射 | 状态 |
|---------|---------|---------|------|
| **修炼境界** | 炼气→筑基→结丹→元婴→化神→炼虚→合体→大乘→渡劫→真仙→金仙→太乙→大罗→道祖，每境界有初期/中期/后期/大圆满 | Fact: cultivation_realm(含阶段)、World Package 规则集定义境界递进链 | ✅ |
| **灵根体系** | 五行灵根、异灵根（风雷冰暗）、天灵根、真灵根、伪灵根 | Fact: spiritual_root；Rule Engine：灵根品质影响修炼速度和突破概率 | ✅ |
| **突破瓶颈** | 每个大境界突破需特定条件，可能失败导致修为倒退 | Rule Engine TransitionRule：校验突破条件；失败 → NarrativeThread(回溯型) | ✅ |
| **寿元系统** | 每个境界有寿元上限，突破失败可能折寿 | Fact: lifespan_remaining/lifespan_cap；Rule Engine ConstraintRule：寿元为0不可行动 | ✅ |
| **丹药体系** | 不同品阶丹药（1-9品），炼丹需丹方、灵药、丹炉 | EntityKind.resource + Fact: alchemy_level + Rule Engine | ✅ |
| **法宝体系** | 法宝/灵宝/玄天之宝，有品阶可升级需认主 | EntityKind.resource + Fact: treasure_grade/owner_bond | ✅ |
| **功法体系** | 各种修炼功法，不同功法适合不同灵根 | EntityKind.ability + Fact: technique_mastery/technique_completeness | ✅ |
| **世界地理** | 人界（多大陆海域）→灵界→仙界→真仙界，飞升机制连接 | ContextScope：human_realm→spirit_realm→immortal_realm，飞升=exit_scope+enter_scope | ✅ |
| **秘境/副本** | 血色禁地、虚天殿、坠魔谷等独立空间 | ContextScope：每个秘境独立作用域 + 独立 World Package | ✅ |
| **妖兽/灵兽** | 妖兽修炼体系与人类不同，可签约灵兽 | EntityKind.entity(妖兽/灵兽) + Fact: beast_contract | ✅ |
| **势力组织** | 宗门、家族、散修联盟、魔道六宗 | EntityKind.entity + RelationKind.structural/social | ✅ |
| **交易经济** | 灵石体系、拍卖行、坊市 | EntityKind.resource(灵石) + Fact: market_price | ✅ |
| **功法传承** | 古修遗址中的传承需特定条件 | Fact: inheritance_requirement + Rule Engine ConstraintRule | ✅ |
| **因果/天劫** | 修炼到一定境界引来天劫，杀戮过重引来心魔劫 | Rule Engine TransitionRule：境界+杀业值→天劫事件 | ✅ |
| **飞升机制** | 人界→灵界→仙界的飞升通道，空间节点不稳定 | ContextScope 切换 + Fact: ascension_node_stable | ✅ |
| **超长篇追溯** | 700万字中第100章设定在第5000章被引用 | FactStore 时间切片 + 语义检索 Push 注入 | ✅ |
| **转世/夺舍** | 元婴修士可夺舍重生，保留部分记忆 | NarrativeThread(回溯型) + Knowledge：转世后对前世信息部分保留 | ✅ |

### F.3 《蛊真人》——黑暗修仙 + 智斗

| 设定维度 | 具体设定 | 框架映射 | 状态 |
|---------|---------|---------|------|
| **蛊虫体系** | 九大流派，蛊虫分1-9转，仙蛊、上古蛊 | EntityKind.resource(蛊虫) + Fact: gu_grade/gu_type；World Package 定义流派规则 | ✅ |
| **蛊师境界** | 1-9转，每转有初阶/中阶/高阶/巅峰 | Fact: gu_master_realm + Rule Engine：突破条件校验 | ✅ |
| **蛊虫消耗** | 使用蛊虫消耗真元/仙元，蛊虫可损坏 | Fact: essence_remaining；Rule Engine：真元不足时使用失败 | ✅ |
| **炼蛊机制** | 不同流派炼蛊方法，成功率受多因素影响 | Rule Engine TransitionRule：炼蛊成功率计算 | ✅ |
| **信息战（核心）** | 方源刻意释放假情报、误导势力、隐藏意图 | Knowledge with source=rumor、confidence=0.3（假情报）；confidence 动态更新 | ✅ |
| **阴谋多线并进** | 同时布下数十个计谋跨越数百章收网 | 多条 NarrativeThread progressive 并行，互相关联 | ✅ |
| **势力博弈** | 天庭、影宗、南疆蛊仙等各方利益交错 | EntityKind.entity(势力) + RelationKind.social + Knowledge | ✅ |
| **时空重生** | 春秋蝉重生、时光长河 | ContextScope(previous_life) + Retcon：重生=对历史事件的级联修改 | ✅ |
| **命运机制** | 命运长河中的命运支流，蛊仙可改命 | Fact: fate_branch；Rule Engine ConstraintRule：改命条件和代价 | ✅ |
| **仙蛊方** | 炼制仙蛊的秘方，极具价值 | EntityKind.information(仙蛊方) + Knowledge(谁知道这个秘方) | ✅ |
| **道痕体系** | 修炼积累道痕影响战斗力和突破条件 | Fact: dao_marks_count/dao_marks_type | ✅ |
| **角色行为一致性** | 方源纯粹利己但行为有内在逻辑 | Rule Engine 只检测设定逻辑一致性（承诺合作又背刺→可能生成代价） | ✅ |

### F.4 《三体》（刘慈欣）——硬科幻

| 设定维度 | 具体设定 | 框架映射 | 状态 |
|---------|---------|---------|------|
| **宇宙社会学三公理** | 生存第一、猜疑链、技术爆炸 | EntityKind.rule + Rule Engine ConstraintRule | ✅ |
| **黑暗森林威慑** | 地球对三体的威慑平衡 | Fact: deterrence_level(0-100%)/deterrence_controller | ✅ |
| **猜疑链** | 两文明间无法确认对方善意/恶意 | Knowledge：文明A对文明B真实意图 confidence 极低(0.1-0.3) | ✅ |
| **技术锁死（智子）** | 三体用智子锁死地球基础科学 | Fact: science_locked=true + Rule Engine：基础科学突破被阻断 | ✅ |
| **面壁者计划** | 4位面壁者各自制定秘密战略，连人类自己都不知道 | Knowledge：面壁者计划 Fact 只有面壁者本人可见，对其他人 confidence=0 | ✅ |
| **技术等级体系** | 地球→三体→歌者→归零者 | Fact: tech_level + Rule Engine：低等级文明无法理解高等级技术 | ✅ |
| **降维打击** | 二向箔将三维空间降为二维 | Fact: dimension=2(受影响区域) + ContextScope：被降维区域规则完全不同 | ✅ |
| **光速飞船航迹** | 曲率驱动飞船留下航迹会降低光速形成黑域 | Rule Engine InferenceRule：航迹→光速降低→黑域形成 | ✅ |
| **冬眠技术** | 角色可冬眠数百年后醒来 | Fact: status=hibernating + validFrom/validTo 跨越数百年 | ✅ |
| **多时代时间线** | 危机纪元→威慑纪元→广播纪元→掩体纪元→银河纪元 | 时间切片查询 + ContextScope 按时代区分 | ✅ |
| **智子监控** | 三体通过智子实时监控地球但有盲区 | Knowledge：三体对地球事件 confidence=0.95，面壁者计划不可见 | ✅ |
| **宇宙规律作为武器** | 物理常数被高级文明修改 | EntityKind.rule + Rule Engine：规律修改后级联影响所有依赖 Fact | ✅ |

### F.5 《一人之下》——现代都市异能 + 道家体系

| 设定维度 | 具体设定 | 框架映射 | 状态 |
|---------|---------|---------|------|
| **炁的体系** | 先天一炁、炁体源流等特殊功法 | Fact: qi_type/qi_mastery_level | ✅ |
| **异人/普通人区分** | 异人世界有独立规则，对普通人保密 | ContextScope(yinren_world) + Knowledge：异人能力对普通人不可见 | ✅ |
| **八奇技** | 炁体源流、拘灵遣将、通天箓等，传承隐秘 | EntityKind.ability + Knowledge(谁知道谁拥有哪个八奇技) | ✅ |
| **身份隐藏** | 张楚岚隐藏炁体源流身份、宝儿姐真实身份 | EntityKind.identity + Knowledge.confidence | ✅ |
| **门派体系** | 武当、龙虎山、唐门、全性等各有传承 | EntityKind.entity(门派) + RelationKind.structural + World Package | ✅ |
| **甲申之乱** | 历史事件影响现代所有角色，真相逐步揭示 | Event Sourcing + NarrativeThread progressive | ✅ |
| **炁体源流争夺** | 多方势力争夺传承 | 多条 NarrativeThread 并行 + Knowledge | ✅ |
| **现代都市设定** | 异能存在于现代社会需遵守法律 | Rule Engine ConstraintRule：公共场合使用能力限制 | ✅ |

### F.6 《传说管理局》——穿越干预传说故事

| 设定维度 | 具体设定 | 框架映射 | 状态 |
|---------|---------|---------|------|
| **传说世界进入** | 通过机器进入各个传说世界 | ContextScope：每个传说=独立作用域+独立 World Package | ✅ |
| **传说世界规则** | 每个传说有独立力量体系/因果律/时间流速 | World Package 按传说加载 | ✅ |
| **干预行为** | 特工在传说中做出不同选择 | Fact 在传说作用域内 assert，可能违反原剧情因果 | ✅ |
| **因果律回溯代价** | 改变传说剧情产生的因果悖论 | NarrativeThread(回溯型)：干预产生代价需后续弥补 | ✅ |
| **回传现实** | 传说中获知信息/能力带回现实 | exit_scope + fact_changes 显式持久化 | ✅ |
| **传说侵蚀** | 过多干预导致现实与传说界限模糊 | Fact: legend_erosion_level + Rule Engine：超阈值触发事件 | ✅ |
| **管理局组织** | 管理局本身有层级/规则/任务系统 | EntityKind.entity + Fact: bureau_rank/mission_status | ✅ |
| **多传说并行** | 不同特工同时在不同传说中 | 多个 ContextScope 并存 | ✅ |
| **传说间影响** | 一个传说的干预影响其他传说 | Retcon BFS 跨作用域追溯 + NarrativeThread 追踪跨传说因果 | ✅ |

### F.7 《斗罗大陆》（唐家三少）——武魂+魂环体系

| 设定维度 | 具体设定 | 框架映射 | 状态 |
|---------|---------|---------|------|
| **武魂体系** | 先天觉醒，分器/兽/植物/本体武魂；先天满魂力为顶级天赋 | `Fact: martial_soul_type` + `Fact: innate_soul_power`；World Package 定义分类 | ✅ |
| **双生武魂** | 极稀有天赋，同一人拥有两个武魂（如唐三：蓝银草+昊天锤），各配9个魂环 | 同一实体两组 `Fact: soul_ring_N(martial_soul_index)`，双线并行追踪 | ✅ |
| **魂环体系** | 十年(白)→百年(黄)→千年(紫)→万年(黑)→十万年(红)→百万年(金)→神级；每武魂最多9环 | `Fact: ring_color/ring_year/ring_skill`；Rule Engine ConstraintRule：超限爆体 | ✅ |
| **魂师等级** | 魂士→魂师→大魂师→魂尊→魂宗→魂王→魂帝→魂圣→魂斗罗→封号斗罗(91-99细分)→神(100) | `Fact: soul_power_level`；Rule Engine TransitionRule：每10级突破+魂环吸收 | ✅ |
| **魂骨体系** | 六大骨位(头/躯干/四肢)+外附魂骨(可进化)；十万年魂兽必掉 | `Fact: bone_equipped(slot, source, skill)`；外附魂骨→NarrativeThread progressive | ✅ |
| **精神力等级** | 灵元境→灵通境→灵海境→灵渊境→灵域境→神元境→神王境，独立于魂力的第二成长线 | `Fact: spiritual_power_level`；Rule Engine：精神力对控制系/幻境的影响 | ✅ |
| **领域系统** | 蓝银领域/杀神领域/海神领域/修罗领域等；领域内改写战斗规则 | `Fact: domain_type/domain_active`；Rule Engine InferenceRule：范围内参数重算 | ✅ |
| **武魂融合技** | 两个魂师武魂高度契合时融合（幽冥白虎=白虎+灵猫），威力远超个体 | `RelationKind.social(fusion_partner)` + `Fact: fusion_technique`；Rule Engine：契合度判定 | ✅ |
| **唐门绝学** | 玄天功/紫极魔瞳/玄玉手/鬼影迷踪/暗器百解/控鹤擒龙，独立于武魂体系 | `Fact: tang_sect_technique(level)`；六条并行 NarrativeThread progressive | ✅ |
| **暗器体系** | 佛怒唐莲/暴雨梨花针/孔雀翎等；分机括类/手法类，威力可跨级甚至弑神 | `EntityKind.item(暗器)` + `Fact: hidden_weapon_mastery`；Rule Engine：伤害独立于魂力 | ✅ |
| **魂兽化形** | 十万年魂兽可化形为人从1级重修；幼年期身份暴露被猎杀；成熟期恢复实力 | `Fact: transformation_status/maturity`；Knowledge：化形身份对他人 confidence=0 | ✅ |
| **神位传承** | 海神九考→海神、天使九考→天使神、修罗传承；考核分白/黄/紫/黑/红五级 | NarrativeThread progressive（9里程碑）+ `Fact: divine_trial_current` | ✅ |
| **杀戮之都** | 独立空间禁用魂技，只有杀戮之气；通过地狱路获杀神领域 | ContextScope(杀戮之都) + Rule Engine ConstraintRule：禁用魂技 | ✅ |
| **身份伪装** | 千仞雪伪装雪清河十余年；唐三隐藏双生武魂；小舞隐藏魂兽身份 | Knowledge核心场景：不同角色对同一身份 confidence 差异巨大 | ✅ |
| **小舞献祭与复活** | 小舞献祭成魂环→唐三集齐条件复活小舞 | Event Sourcing：献祭事件+复活事件；NarrativeThread progressive（复活条件） | ✅ |
| **势力格局** | 武魂殿/天斗帝国/星罗帝国/上三宗/下四宗/史莱克学院/唐门 | `EntityKind.entity(势力)` + `RelationKind.structural(宗门归属)` | ✅ |
| **仙草药草** | 冰火两仪眼中仙品药草，服用可永久提升资质 | `EntityKind.resource(仙草)` + `Fact: herb_effect`；Rule Engine TransitionRule | ✅ |
| **宗门传承** | 昊天锤传人/七宝琉璃塔进化/蓝电霸王龙血脉 | `RelationKind.structural(传承)` + NarrativeThread progressive | ✅ |

### F.8 《神印王座》（唐家三少）——骑士+魔族对抗

| 设定维度 | 具体设定 | 框架映射 | 状态 |
|---------|---------|---------|------|
| **骑士等级** | 待从→预备→正式→大骑士→圣骑士→神眷骑士/惩戒骑士/守护骑士；以灵力衡量 | `Fact: knight_rank/inner_spirit_power`；Rule Engine TransitionRule：晋升条件 | ✅ |
| **六大圣殿** | 骑士/战士/刺客/法师/牧师/灵魂圣殿，各有传承和选拔体系 | `EntityKind.entity(圣殿)` + `RelationKind.structural(圣殿归属)` + World Package | ✅ |
| **神印王座** | 六大神印王座为创世神器（永恒与创造为超神器），只有被选中者可继承 | NarrativeThread progressive（传承选拔）+ `Fact: throne_inheritance_status` | ✅ |
| **灵炉** | 成长型特殊装备，可吸收进化；每人一生只能拥有一个 | `Fact: spirit_furnace_type/evolution_stage`；NarrativeThread progressive（灵炉进化） | ✅ |
| **猎魔团** | 六大圣殿精英组成的战斗小队，执行对抗魔族任务 | `EntityKind.entity(猎魔团)` + `RelationKind.social(队友)` + `Fact: mission_status` | ✅ |
| **七十二柱魔神** | 七十二柱魔神各有领地，魔神皇为最高统治者；魔族与人类世代战争 | `EntityKind.entity(魔族)` + `Fact: demon_rank(1-72)` + Knowledge：魔族情报 | ✅ |
| **天赋压制共享** | 扈从骑士制度：天赋压制使扈从先天内灵力大幅提升 | `RelationKind.structural(主从)` + Rule Engine InferenceRule：压制共享计算 | ✅ |
| **光暗对立** | 光明之子 vs 暗影力量，两种本源力量的对立 | `Fact: light_dark_affinity`；Rule Engine：光暗克制关系 | ✅ |

### F.9 《绝世唐门》（唐家三少）——斗罗续作+魂导科技

| 设定维度 | 具体设定 | 框架映射 | 状态 |
|---------|---------|---------|------|
| **魂导器体系** | 以稀有金属为载体雕刻核心法阵、魂力驱动的科技装备；魂导师为新职业 | `EntityKind.item(魂导器)` + `Fact: soul_guide_level/core_array_count`；独立技术线 | ✅ |
| **魂灵契约** | 魂兽自愿成为魂灵而非被猎杀，道德进步的体现 | `RelationKind.social(魂灵契约)` + `Fact: spirit_status`；Rule Engine：契约 vs 猎杀 | ✅ |
| **精神力升级** | 精神力地位大幅提升，精神探测/共享/冲击为核心技能 | `Fact: spiritual_power_level` + Rule Engine：精神力对战斗/侦查的影响 | ✅ |
| **极限单兵计划** | 史莱克学院培养终极战士的秘密计划 | NarrativeThread progressive + `Fact: training_progress` | ✅ |
| **传灵塔** | 新势力，连接魂师与魂兽的中介组织 | `EntityKind.entity(传灵塔)` + `RelationKind.structural(组织归属)` | ✅ |
| **日月帝国** | 第四大帝国（新增），专注魂导科技，与其他三国冷战 | `EntityKind.entity(帝国)` + `Fact: tech_level` | ✅ |
| **唐门复兴** | 霍雨浩以振兴唐门为己任，融合魂导科技与唐门绝学 | NarrativeThread progressive + Knowledge：唐门秘密传承 | ✅ |
| **双武魂** | 霍雨浩灵眸+冰碧帝皇蝎双武魂 | 同一实体双组 Fact，通过 `martial_soul_index` 区分 | ✅ |

### F.10 《星辰变》（我吃西红柿）——修真+自创宇宙

| 设定维度 | 具体设定 | 框架映射 | 状态 |
|---------|---------|---------|------|
| **正统修真境界** | 后天→先天→金丹→元婴→洞虚→空冥→渡劫→大成（凡人界）；天仙→金仙→玄仙→神王→掌控者（仙界/神界） | `Fact: cultivation_realm`；Rule Engine TransitionRule；World Package 境界链 | ✅ |
| **星辰变功法** | 秦羽自创功法，以外功入道，开辟丹田空间演化宇宙；四大专属境界 | `EntityKind.ability(功法)` + `Fact: technique_stage`；Rule Engine：自创功法独立进阶 | ✅ |
| **流星泪** | 神王之女留下的信物，蕴含巨大能量，与秦羽命运相连 | `EntityKind.resource(流星泪)` + `Fact: meteor_tear_bond`；NarrativeThread progressive | ✅ |
| **三界体系** | 凡人界（潜龙大陆+海外修真界）→仙魔妖界→神界→鸿蒙空间 | ContextScope 层级：mortal_realm → immortal_realm → divine_realm | ✅ |
| **九剑仙府** | 仙帝逆央遗府，需九把玉剑开启，内有迷魔幻境等关卡 | ContextScope(九剑仙府) + Rule Engine：关卡通过条件 | ✅ |
| **修真/修魔/修妖** | 三种修炼路线各有特色，仙魔对立 | `Fact: cultivation_path` + Rule Engine：不同路径优缺点 | ✅ |
| **势力格局** | 潜龙大陆三大势力/海外九煞殿碧水府青龙宫/仙界三方势力 | `EntityKind.entity(势力)` + `RelationKind.structural` + `Fact: power_balance` | ✅ |
| **外功逆天** | 秦羽先天无法修炼内功，以外功突破极限 | `Fact: cultivation_method=external`；Rule Engine：外功突破更苛刻 | ✅ |
| **宇宙演化** | 功法大成后体内演化独立宇宙，成为掌控者 | `Fact: universe_stage(行星→星系→星云→宇宙)`；NarrativeThread progressive | ✅ |

### F.11 《盘龙》（我吃西红柿）——西方奇幻+位面体系

| 设定维度 | 具体设定 | 框架映射 | 状态 |
|---------|---------|---------|------|
| **战士/法师双系** | 战士1-9级→圣域→神级；法师1-9级→圣域→神级；可双修 | `Fact: warrior_level/mage_level`；两条并行成长线 | ✅ |
| **龙血战士** | 巴鲁克家族血脉，激活后获得龙血战士形态；四神兽家族之一 | `Fact: bloodline_type/dragon_form_active`；Rule Engine：血脉激活条件与效果 | ✅ |
| **位面体系** | 物质位面→地狱→冥界→天界→位面战场；各位面规则不同 | ContextScope 层级：material → hell → underworld → heaven；各有 World Package | ✅ |
| **神格系统** | 下位神→中位神→上位神→大圆满上位神→主神→至高神；通过炼化神格晋升 | `Fact: divine_rank`；Rule Engine TransitionRule：炼化条件校验 | ✅ |
| **法则领悟** | 地/风/水/火/雷/光/暗/毁灭等法则，修炼到极致需领悟法则 | `Fact: law_mastery(element, level)`；Rule Engine：法则影响战力 | ✅ |
| **灵魂变异** | 多系融合产生的灵魂变异（如林雷地风火暗四系），极大增强战力 | `Fact: soul_mutation_type/element_count`；Rule Engine InferenceRule | ✅ |
| **四神兽家族** | 龙/虎/鸟/蛇四大神兽后裔家族，血脉传承 | `EntityKind.entity(家族)` + `Fact: bloodline_source` + `RelationKind.structural` | ✅ |
| **契约魔兽** | 魔兽可与人签订灵魂契约（如林雷与贝贝） | `RelationKind.social(灵魂契约)` + `Fact: contract_type` | ✅ |
| **神器体系** | 主神兵器/至高神器等；神器与主人绑定 | `EntityKind.item(神器)` + `Fact: artifact_bond` | ✅ |

### F.12 《九鼎记》（我吃西红柿）——高武武侠

| 设定维度 | 具体设定 | 框架映射 | 状态 |
|---------|---------|---------|------|
| **武道境界** | 后天→先天(虚丹/实丹/金丹)→虚境→洞虚→破虚→仙人 | `Fact: martial_realm`；Rule Engine TransitionRule | ✅ |
| **形意拳体系** | 十二形意拳为核心武学（龙/虎/鹰/蛇等），各有招式和内劲 | `EntityKind.ability(拳法)` + `Fact: boxing_mastery_level`；World Package 定义 | ✅ |
| **九州大陆** | 禹皇五斧劈山划分九州，九鼎象征天下 | `Fact: location(九州)` + `EntityKind.resource(九鼎)` + NarrativeThread progressive | ✅ |
| **先天真元** | 先天境凝练真元，分虚丹→实丹→金丹三个阶段 | `Fact: true_element_stage`；Rule Engine：真元品质影响战力 | ✅ |
| **虚境秘技** | 虚境强者可施展毁天灭地的秘技，消耗巨大 | `EntityKind.ability(秘技)` + `Fact: secret_technique_cost` | ✅ |
| **佛宗/道门/天神宫** | 三大势力各有传承和体系 | `EntityKind.entity(势力)` + `RelationKind.structural` | ✅ |
| **穿越设定** | 滕青山从现代穿越至九州大陆，保留形意拳传承 | `Fact: origin=modern`；Knowledge：现代知识在古代的应用 | ✅ |
| **妖兽体系** | 妖兽修炼至虚境称为神兽（佛宗称"菩萨果位"） | `EntityKind.entity(妖兽)` + `Fact: beast_realm` | ✅ |

### F.13 《吞噬星空》（我吃西红柿）——科幻+宇宙

| 设定维度 | 具体设定 | 框架映射 | 状态 |
|---------|---------|---------|------|
| **武者等级** | 学徒→行星级→恒星级→宇宙级→域主→界主→不朽→宇宙尊者→宇宙之主→真神；每阶1-9阶 | `Fact: warrior_rank`；超长境界链；Rule Engine 定义完整链 | ✅ |
| **精神念师** | 与武者并行的精神力修炼路线，用念力操控武器 | `Fact: psychic_rank`；两条并行成长线 | ✅ |
| **地球灾难** | RR病毒引发物种变异，人类建立基地市，武者成核心力量 | Event Sourcing：RR病毒事件 + `Fact: mutation_status` + ContextScope(地球灾后) | ✅ |
| **宇宙文明** | 人类五大势力/虫族/妖族联盟/机械族/星空巨兽等种族 | `EntityKind.entity(种族/势力)` + `RelationKind.social(联盟/敌对)` | ✅ |
| **夺舍机制** | 罗峰与星空吞噬巨兽合体夺舍，获得双重身体 | `Fact: possession_status/dual_body`；Rule Engine：夺舍条件与限制 | ✅ |
| **传承系统** | 陨墨星主人传承、宇宙各大强者传承 | NarrativeThread progressive（传承考核）+ Knowledge：传承秘密 | ✅ |
| **多层宇宙** | 原始宇宙→宇宙海→晋之世界 | ContextScope 层级：original_universe → cosmic_sea → jin_world | ✅ |
| **天赋秘法** | 各种族的天赋能力（如金角巨兽的吞噬天赋） | `Fact: innate_ability/racial_secret`；Rule Engine：种族天赋效果 | ✅ |
| **虚拟宇宙** | 高度发达的虚拟现实系统用于训练/社交/商业 | ContextScope(virtual_universe) + Rule Engine：虚拟世界规则 | ✅ |

### F.14 《斗破苍穹》（天蚕土豆）——斗气+异火+炼药师

| 设定维度 | 具体设定 | 框架映射 | 状态 |
|---------|---------|---------|------|
| **斗气等级** | 斗之气→斗者→斗师→大斗师→斗灵→斗王→斗皇→斗宗→斗尊→斗圣→斗帝；每级1-9星 | `Fact: douqi_rank/douqi_star`；Rule Engine TransitionRule：突破条件 | ✅ |
| **异火体系** | 二十三种天地异火，异火榜排名；可吞噬融合，威力巨大 | `EntityKind.resource(异火)` + `Fact: fire_rank/fire_owner`；Rule Engine：吞噬融合条件+失败代价 | ✅ |
| **炼药师** | 1-9品（九品分宝丹/玄丹/金丹），需火+木属性+灵魂感知力 | `Fact: alchemist_rank/soul_realm`（凡→灵→天→帝）；双线成长（斗气+炼药） | ✅ |
| **药老附体** | 药尘灵魂寄居戒指中，指导萧炎修炼并可短暂附体战斗 | `Fact: soul_parasite_status` + Rule Engine：附体条件/时间限制 | ✅ |
| **斗气倒退** | 萧炎从天才跌落到废柴（药老吸走斗气），后逐步恢复 | Event Sourcing：倒退事件 + NarrativeThread progressive（恢复之路） | ✅ |
| **远古八族** | 萧族/古族/魂族/药族/炎族/雷族/石族/灵族，各有血脉和传承 | `EntityKind.entity(远古家族)` + `Fact: bloodline_purity/clan_rank` | ✅ |
| **魔兽体系** | 1-10阶魔兽与斗气等级对应；可签约 | `EntityKind.entity(魔兽)` + `RelationKind.social(契约)` + `Fact: beast_rank` | ✅ |
| **功法斗技** | 天地玄黄四阶每阶低中高三级 | `EntityKind.ability(功法)` + `Fact: technique_grade`；World Package 定义 | ✅ |
| **灵魂境界** | 凡境→灵境→天境→帝境；灵魂力决定炼药师等级 | `Fact: soul_realm`；Rule Engine：灵魂境界突破条件 | ✅ |
| **大千世界** | 斗帝之上飞升大千世界（与《大主宰》联动） | ContextScope 切换：douqi_world → great_world | ✅ |

### F.15 《大主宰》（天蚕土豆）——大千世界宇宙

| 设定维度 | 具体设定 | 框架映射 | 状态 |
|---------|---------|---------|------|
| **灵力体系** | 感应境→灵动境→灵轮境→神魄境→融天境→化天境→通天境→至尊→地至尊→天至尊→主宰 | `Fact: spirit_rank`；Rule Engine TransitionRule | ✅ |
| **九幽雀契约** | 牧尘与九幽雀灵魂契约，共享力量，可进入九幽体化状态 | `RelationKind.social(灵魂契约)` + `Fact: jiuyou_fusion_status` | ✅ |
| **远古部落** | 牧族/浮屠古族等远古大族，血脉传承 | `EntityKind.entity(古族)` + `Fact: bloodline_purity` | ✅ |
| **位面之胎** | 掌控位面的核心力量，获得后可掌控位面 | `EntityKind.resource(位面之胎)` + NarrativeThread progressive（争夺） | ✅ |
| **跨作品联动** | 萧炎（斗破苍穹）/林动（武动乾坤）客串，三大主角同台 | ContextScope(大千世界) 统一三作世界观；`Fact: character_origin` | ✅ |
| **邪族入侵** | 异魔族对大千世界的入侵 | `EntityKind.entity(邪族)` + NarrativeThread progressive | ✅ |
| **大罗天池** | 至尊级修炼圣地，蕴含海量灵力 | ContextScope(大罗天池) + Rule Engine：修炼加速 | ✅ |
| **大千世界地理** | 广阔宇宙无数大陆和位面，万族共存 | `Fact: location` + World Package 定义大千世界规则 | ✅ |

### F.16 《武动乾坤》（天蚕土豆）——元力+祖符

| 设定维度 | 具体设定 | 框架映射 | 状态 |
|---------|---------|---------|------|
| **元力等级** | 天元境→造化境→涅槃境→生玄境→死玄境→转轮境→轮回境→祖境 | `Fact: yuan_power_rank`；Rule Engine TransitionRule | ✅ |
| **八枚祖符** | 天/地/水/火/雷/风/暗/光八枚祖符各有至高力量；集齐者可开天辟地 | `EntityKind.resource(祖符)` + `Fact: ancestral_seal_status`；NarrativeThread progressive | ✅ |
| **异魔** | 来自异魔界的敌对种族，吞噬元力 | `EntityKind.entity(异魔)` + ContextScope(异魔界) | ✅ |
| **祖石/天妖貂** | 林动的伙伴/助力，各有来历和成长线 | `RelationKind.social(伙伴)` + NarrativeThread progressive | ✅ |
| **四大玄宗** | 道宗/元门/九天太清宫/万花谷等大势力 | `EntityKind.entity(宗门)` + `RelationKind.structural` | ✅ |
| **符文体系** | 独立于元力的符文修炼路线，林动双修 | `Fact: rune_mastery_level` + Rule Engine：符文效果 | ✅ |

### F.17 《神墓》（辰东）——死后复活+神魔墓地

| 设定维度 | 具体设定 | 框架映射 | 状态 |
|---------|---------|---------|------|
| **天阶体系** | 阶位/逆天阶/临神阶/神阶等辰东体系修炼境界 | `Fact: cultivation_rank`；Rule Engine TransitionRule | ✅ |
| **死后复活** | 辰南死后万年复活，万年前记忆与现实的断裂 | Event Sourcing：死亡事件(万年前) + 复活事件(现在) + Knowledge：记忆断裂 | ✅ |
| **神魔墓地** | 万年前神魔陨落的墓地，蕴含远古秘密 | ContextScope(神魔墓地) + NarrativeThread progressive | ✅ |
| **前世今生** | 独孤败天/魔主等角色跨越多个纪元的前世今生 | `Fact: reincarnation_count/past_life_identity`；NarrativeThread progressive | ✅ |
| **太古战争** | 远古神魔大战，影响当前世界格局 | Event Sourcing + 时间切片查询 + Knowledge：战争真相逐步揭示 | ✅ |
| **天道猎杀** | 天道对强者的猎杀规则 | Rule Engine ConstraintRule：天道猎杀条件 | ✅ |
| **多人穿越** | 多个角色从不同时代复活/穿越 | `Fact: origin_time`；不同时代的 Knowledge 差异 | ✅ |
| **法宝/天道** | 各种至宝和天道法则的争夺 | `EntityKind.resource(至宝)` + `Fact: artifact_power` | ✅ |

### F.18 《遮天》（辰东）——九龙拉棺+大帝体系

| 设定维度 | 具体设定 | 框架映射 | 状态 |
|---------|---------|---------|------|
| **仙台境界** | 仙台1-9重→半步大帝→大帝→红尘仙→仙 | `Fact: immortal_terrace_realm`；Rule Engine TransitionRule | ✅ |
| **荒古圣体** | 叶凡的特殊体质，曾被认为无法修炼，后逆天证明 | `Fact: body_type=sacred_body`；Rule Engine ConstraintRule：圣体修炼限制+突破 | ✅ |
| **九龙拉棺** | 九条龙拉青铜棺穿越星空，贯穿全书的核心谜团 | NarrativeThread progressive（九龙拉棺之谜）+ Knowledge：棺中秘密 | ✅ |
| **生命禁区** | 多个禁区由古代至尊把守，定期发动黑暗动乱 | ContextScope(生命禁区) + `Fact: forbidden_zone_ruler` + Rule Engine：黑暗动乱触发 | ✅ |
| **源术体系** | 独特体系：开采源石、炼化万物本源 | `Fact: source_technique_mastery` + Rule Engine：源术效果 | ✅ |
| **九秘** | 九种至高秘术（临/兵/斗/者/皆/阵/列/在/前），各属不同传承 | `EntityKind.ability(秘术)` + `Fact: secret_art_mastery`；9条并行收集线 | ✅ |
| **天庭建立** | 叶凡建立天庭对抗各圣地，逐步统一 | NarrativeThread progressive + `EntityKind.entity(天庭)` | ✅ |
| **大帝征战** | 多位大帝时代交叉，各有道果 | `Fact: great_emperor_status/dao_fruit`；Rule Engine：道果克制关系 | ✅ |
| **万年时间跨度** | 故事跨越数万年，叶凡从少年到红尘仙 | `validFrom/validTo` 时间切片 + 不同时代角色状态对比 | ✅ |

### F.19 《完美世界》（辰东）——石昊+三千道州

| 设定维度 | 具体设定 | 框架映射 | 状态 |
|---------|---------|---------|------|
| **超长境界链** | 搬血→洞天→化道→尊者→天神→教主→虚道→斩我→遁一→至尊→仙王→准仙帝→仙帝→道祖 | `Fact: cultivation_realm`；Rule Engine 定义完整境界链 | ✅ |
| **多层级世界** | 八域→三千道州→仙域→异域 | ContextScope 层级：lower_8 → upper_3000 → immortal → foreign | ✅ |
| **柳神** | 石昊的导师，本体为一株柳树，守护石村 | `RelationKind.structural(导师)` + `Fact: willow_spirit_power` | ✅ |
| **异域入侵** | 异域强者入侵三千道州，帝关为防线 | `EntityKind.entity(异域)` + NarrativeThread progressive（战争） | ✅ |
| **各种体质** | 雷道体/轮回体/混沌体等特殊体质 | `Fact: body_type` + Rule Engine：体质对修炼的影响 | ✅ |
| **荒的传说** | 石昊最终成为"荒"，独断万古 | NarrativeThread progressive 贯穿全书 | ✅ |
| **轮回战** | 石昊多次转世/轮回，记忆和力量部分保留 | `Fact: reincarnation_count` + Knowledge：前世记忆保留程度 | ✅ |
| **至尊殿堂** | 石昊建立的势力，聚拢各方强者 | `EntityKind.entity(至尊殿堂)` + `RelationKind.structural(成员)` | ✅ |

### F.20 《圣墟》（辰东）——遮天三部曲终章

| 设定维度 | 具体设定 | 框架映射 | 状态 |
|---------|---------|---------|------|
| **花粉进化路** | 通过花粉/进化物质实现生命层次跃迁 | `Fact: evolution_stage/pollen_path_level`；Rule Engine TransitionRule | ✅ |
| **多层宇宙** | 小阴间(地球)→大阳间→诸天万界 | ContextScope 层级：small_yin → great_yang → myriad_worlds | ✅ |
| **轮回路** | 连接生死的轮回通道，可窥探前世 | ContextScope(轮回路) + `Fact: past_life_accessible` + Knowledge | ✅ |
| **阳间大族** | 阳间各大家族/道统，势力格局复杂 | `EntityKind.entity(大族)` + `RelationKind.structural/social` | ✅ |
| **跨三部曲联动** | 叶凡/石昊/楚风三大主角最终汇合 | ContextScope 统一三部曲世界观；`Fact: character_origin` | ✅ |
| **诡异一族** | 超越仙帝的恐怖存在，诸天万界的终极威胁 | `EntityKind.entity(诡异族)` + `Fact: threat_level=supreme` | ✅ |
| **楚风身世** | 主角拥有特殊进化体质 | NarrativeThread progressive（身世）+ `Fact: body_type` | ✅ |

### F.21 《佛本是道》（梦入神机）——洪荒流开山

| 设定维度 | 具体设定 | 框架映射 | 状态 |
|---------|---------|---------|------|
| **圣人体系** | 天道之下六大圣人（三清+女娲+接引+准提），圣人之下皆蝼蚁 | `Fact: sage_status/sage_rank`；Rule Engine：圣人不可违天道 | ✅ |
| **修炼境界** | 天仙→金仙→太乙→大罗→准圣→圣人→天道 | `Fact: cultivation_realm`；Rule Engine TransitionRule | ✅ |
| **封神体系** | 封神榜定三教门人命运，封神为天意 | NarrativeThread progressive（封神大劫）+ Rule Engine ConstraintRule | ✅ |
| **因果功德** | 因果缠身影响修炼，功德可抵消因果 | `Fact: karma_value/merit_value`；Rule Engine：因果对修炼/渡劫的影响 | ✅ |
| **先天灵宝** | 天地初开时诞生的至宝（十二品莲台/太极图/盘古幡） | `EntityKind.resource(先天灵宝)` + `Fact: treasure_rank` | ✅ |
| **截教/阐教/人教** | 三清各立教派，封神之战中互相争斗 | `EntityKind.entity(教派)` + `RelationKind.social(联盟/敌对)` | ✅ |
| **量劫** | 天道定期降下量劫清洗众生，量劫中因果加速 | Rule Engine TransitionRule：量劫触发 + ConstraintRule：量劫中实力受限 | ✅ |
| **天庭** | 天帝统管三界，但受圣人制约 | `EntityKind.entity(天庭)` + Rule Engine：天庭权威限制 | ✅ |
| **洪荒六圣** | 各圣人有道场/门人/道统，互相制衡 | `EntityKind.entity(圣人道统)` + `RelationKind.structural(师徒)` | ✅ |

### F.22 《阳神》（梦入神机）——武道+神魂双修

| 设定维度 | 具体设定 | 框架映射 | 状态 |
|---------|---------|---------|------|
| **武道境界** | 练肉→练筋→练皮→练骨→练脏→练髓→换血→先天→武圣→人仙 | `Fact: martial_realm`；World Package 境界链 | ✅ |
| **阳神体系** | 修炼出阳神（灵魂出窍强化版），独立于武体的第二成长线 | `Fact: yang_spirit_stage`；两条并行成长线 | ✅ |
| **诸子百家** | 儒/道/佛/法/墨等诸子百家各有修炼体系 | `EntityKind.entity(学派)` + World Package 定义各学派功法 | ✅ |
| **大乾王朝** | 以真实历史为基础的架空王朝，朝廷与武林并存 | `EntityKind.entity(朝廷)` + `Fact: court_rank` + Rule Engine：朝廷约束 | ✅ |
| **神器** | 各种上古神器，拥有者战力大增 | `EntityKind.resource(神器)` + `Fact: artifact_power/bond` | ✅ |
| **轮回转世** | 部分角色有前世记忆，影响今生修炼 | `Fact: past_life_identity/memory_retention` + Knowledge | ✅ |
| **道术/法术** | 与武道并行的法术体系 | `Fact: spell_mastery` + Rule Engine：法术效果 | ✅ |

### F.23 《龙蛇演义》（梦入神机）——现代国术

| 设定维度 | 具体设定 | 框架映射 | 状态 |
|---------|---------|---------|------|
| **国术境界** | 明劲→暗劲→化劲→丹劲→罡劲→打破虚空可以见神 | `Fact: martial_realm`；Rule Engine TransitionRule | ✅ |
| **拳法体系** | 太极/形意/八卦/八极等传统拳法 | `EntityKind.ability(拳法)` + `Fact: boxing_mastery`；World Package | ✅ |
| **现实世界** | 现代都市背景，无超自然力量（写实武打） | World Package(现代写实)：无灵力/无超自然，Rule Engine 约束物理规律 | ✅ |
| **武术门派** | 各门各派有传承和门规 | `EntityKind.entity(门派)` + `RelationKind.structural(师徒)` | ✅ |
| **暗劲实战** | 暗劲的使用有严格物理逻辑（力从脚起、以腰为轴） | Rule Engine ConstraintRule：国术遵循物理规律 | ✅ |
| **打破虚空** | 传说中武学巅峰，超越人体极限 | NarrativeThread progressive（追求极致武道） | ✅ |

### F.24 《庆余年》（猫腻）——权谋+武侠

| 设定维度 | 具体设定 | 框架映射 | 状态 |
|---------|---------|---------|------|
| **武力等级** | 1-9品 + 大宗师（4位），大宗师一人可敌万军 | `Fact: martial_rank`；Rule Engine：大宗师战力质变非量变 | ✅ |
| **四大宗师** | 庆帝/四顾剑/苦荷/叶流云；身份各有秘密 | Knowledge：庆帝是大宗师的事实对绝大多数人 confidence=0；核心剧情 | ✅ |
| **穿越遗产** | 叶轻眉从未来穿越，留下内库/监察院/现代知识 | `EntityKind.information(现代知识)` + Knowledge：谁掌握穿越遗产 | ✅ |
| **监察院** | 叶轻眉创建的独立情报机构 | `EntityKind.entity(监察院)` + Knowledge：监察院情报网 | ✅ |
| **范闲多重身份** | 庆帝私生子+监察院提司+诗仙+内库继承人 | Knowledge：不同角色对范闲不同身份的 confidence 差异 | ✅ |
| **三国格局** | 庆国/北齐/东夷城，政治博弈 | `EntityKind.entity(国家)` + `RelationKind.social(外交)` | ✅ |
| **神庙** | 上古文明遗留的神秘机构 | NarrativeThread progressive（神庙之谜）+ ContextScope(神庙) | ✅ |
| **权谋暗线** | 庆帝阴谋/长公主反叛/陈萍萍算计，层层布局 | 多条 NarrativeThread progressive 交叉 + Knowledge：各方真实意图 | ✅ |
| **文学引用** | 范闲以唐诗宋词冒充自己作品 | `EntityKind.information(诗词)` + Knowledge：谁认为是原创 vs 知道真相 | ✅ |
| **内库** | 国家经济命脉，叶轻眉建立的现代工业体系 | `EntityKind.resource(内库)` + `Fact: economic_control` | ✅ |

### F.25 《间客》（猫腻）——科幻+修行

| 设定维度 | 具体设定 | 框架映射 | 状态 |
|---------|---------|---------|------|
| **修行体系** | 以真气为核心的战斗体系，与现代科技并存 | `Fact: cultivation_level` + Rule Engine：真气与科技的交互 | ✅ |
| **联邦/帝国** | 联邦(民主) vs 帝国(帝制)，两大星际文明对立 | `EntityKind.entity(国家)` + `RelationKind.social(敌对)` | ✅ |
| **机甲战斗** | MX系列机甲，与修行体系结合 | `EntityKind.item(机甲)` + `Fact: mecha_type/pilot_skill` | ✅ |
| **许乐身世** | 主角拥有特殊体质和隐藏身世 | NarrativeThread progressive + Knowledge：谁知道许乐真实身份 | ✅ |
| **星空战争** | 大规模星际战争 | Event Sourcing：战争事件 + `Fact: fleet_status` | ✅ |
| **暗杀/特工** | 联邦特工/帝国暗杀者的渗透战 | Knowledge：特工身份隐蔽 vs 暴露 + confidence 动态 | ✅ |

### F.26 《将夜》（猫腻）——书院+永夜

| 设定维度 | 具体设定 | 框架映射 | 状态 |
|---------|---------|---------|------|
| **修行境界** | 初识→感知→不惑→洞玄→知命→天启→昊天（夫子超越五境） | `Fact: cultivation_realm`；Rule Engine TransitionRule | ✅ |
| **永夜** | 昊天定期发动永夜清洗，世界末日循环 | Rule Engine TransitionRule：永夜触发 + NarrativeThread progressive | ✅ |
| **桑桑身份** | 女主桑桑是昊天化身，从不知到揭示 | NarrativeThread progressive + Knowledge：桑桑真实身份 confidence 动态 | ✅ |
| **夫子** | 天下第一，超越五境的存在，守护人间 | `Fact: master_power_level` + Rule Engine：夫子出手条件/限制 | ✅ |
| **书院十三先生** | 夫子创立的书院，后山十三先生各有所长 | `EntityKind.entity(书院)` + `RelationKind.structural(师兄弟)` | ✅ |
| **知守观/悬空寺** | 道门/佛门/魔宗三大势力 | `EntityKind.entity(势力)` + World Package 定义各势力功法 | ✅ |
| **道魔之争** | 道门（光明）vs 魔宗（黑暗）千年对抗 | `RelationKind.social(敌对)` + Rule Engine：道魔克制 | ✅ |
| **昊天道** | 昊天意志主导世界，永夜是昊天的审判 | Rule Engine ConstraintRule：昊天意志对修行的约束 | ✅ |
| **大唐/燕国/金帐** | 三大势力各有立场和利益 | `EntityKind.entity(国家)` + `RelationKind.social(外交)` | ✅ |

### F.27 《邪气凛然》（跳舞）——都市黑道+异能

| 设定维度 | 具体设定 | 框架映射 | 状态 |
|---------|---------|---------|------|
| **异能体系** | 主角拥有"运气"类特殊能力，概率操控 | `Fact: ability_type=luck_manipulation` + Rule Engine：运气效果计算 | ✅ |
| **都市黑道** | 黑帮势力/地下组织/警察，多方势力交织 | `EntityKind.entity(势力)` + `RelationKind.social(联盟/敌对)` | ✅ |
| **身份秘密** | 主角的异能身份需要隐藏 | Knowledge：谁知道主角有异能 confidence 差异 | ✅ |
| **都市经济** | 夜店/赌场/走私等地下经济 | `EntityKind.resource(资金)` + `Fact: business_status` | ✅ |
| **逃亡线** | 主角在国内的逃亡经历，多城市辗转 | `Fact: location` 动态变化 + Knowledge：追捕者情报 | ✅ |

### F.28 《恶魔法则》（跳舞）——西方奇幻+穿越

| 设定维度 | 具体设定 | 框架映射 | 状态 |
|---------|---------|---------|------|
| **穿越设定** | 杜维穿越到魔法世界，拥有现代知识 | `Fact: origin=modern` + Knowledge：现代知识在魔法世界的应用 | ✅ |
| **魔法/斗气** | 魔法师/骑士双体系，各有等级 | `Fact: magic_level/knight_level`；两条并行成长线 | ✅ |
| **恶魔契约** | 杜维与恶魔签订灵魂交易获得力量，代价逐步显现 | NarrativeThread(回溯型)：契约代价 + `Fact: contract_cost` | ✅ |
| **罗兰帝国** | 大陆最强帝国，皇室/贵族/军方多方博弈 | `EntityKind.entity(帝国)` + `RelationKind.structural/social` | ✅ |
| **多种族** | 精灵/兽人/龙族等多种族共存 | `EntityKind.entity(种族)` + World Package 定义种族特性 | ✅ |
| **神灵真相** | 善恶二神的历史真相 | NarrativeThread progressive + Knowledge：神灵真实面貌 confidence | ✅ |

### F.29 《升龙道》（血红）——现代修真

| 设定维度 | 具体设定 | 框架映射 | 状态 |
|---------|---------|---------|------|
| **现代修真** | 修真体系存在于现代都市，各国有隐秘修真组织 | World Package(现代修真)：修真+现代文明共存 | ✅ |
| **跨国势力** | 主角在英国发展，连接东西方修真界 | `EntityKind.entity(势力)` + `Fact: location` 跨国 | ✅ |
| **修真境界** | 传统修真境界链 | `Fact: cultivation_realm` + Rule Engine TransitionRule | ✅ |
| **血缘/传承** | 主角的华夏血脉和修真传承 | `Fact: bloodline/inheritance` + `RelationKind.structural(师徒)` | ✅ |
| **修真战斗** | 修真者间的战斗和暗杀 | Knowledge：敌对势力信息 + `Fact: threat_level` | ✅ |

### F.30 《神魔》（血红）——史诗奇幻

| 设定维度 | 具体设定 | 框架映射 | 状态 |
|---------|---------|---------|------|
| **神魔对立** | 神族/魔族两大阵营的永恒对抗 | `EntityKind.entity(阵营)` + `RelationKind.social(敌对)` + `Fact: allegiance` | ✅ |
| **天赋体系** | 不同天赋和体质决定修炼方向 | `Fact: talent_type/physique` + Rule Engine：天赋对修炼的影响 | ✅ |
| **多规则体系** | 不同种族/区域有不同的力量规则 | World Package 多套规则 + ContextScope 按区域切换 | ✅ |
| **种族战争** | 大规模种族战争，涉及多个大陆 | Event Sourcing：战争事件 + `Fact: war_status` | ✅ |
| **神器传承** | 上古神器各有传承和使命 | `EntityKind.resource(神器)` + NarrativeThread progressive | ✅ |
| **主角崛起** | 从底层到巅峰的成长历程 | NarrativeThread progressive + Rule Engine：实力增长曲线 | ✅ |

### F.31 《人道至尊》（宅猪）——上古洪荒+人族崛起

| 设定维度 | 具体设定 | 框架映射 | 状态 |
|---------|---------|---------|------|
| **修炼体系** | 以炼气/炼体/炼神为核心的修行 | `Fact: cultivation_realm` + Rule Engine TransitionRule | ✅ |
| **人族微末** | 人族在上古时代地位极低，被万族压迫 | `Fact: race_status=oppressed` + Rule Engine：人族修炼受压制 | ✅ |
| **三皇五帝** | 古代人族领袖的传承和遗产 | `EntityKind.entity(上古领袖)` + NarrativeThread progressive | ✅ |
| **伏羲/女娲** | 上古神灵，人族守护者 | `EntityKind.entity(神灵)` + `Fact: divine_protection_status` | ✅ |
| **万族** | 上古万族各有天赋和势力 | `EntityKind.entity(种族)` + World Package 定义万族特性 | ✅ |
| **先天/后天** | 先天神灵 vs 后天修炼者的区别 | `Fact: birth_type` + Rule Engine：先天 vs 后天实力差异 | ✅ |
| **六道轮回** | 轮回体系的设定和操控 | ContextScope(轮回) + `Fact: reincarnation_access` | ✅ |
| **钟岳崛起** | 主角带领人族崛起的史诗 | NarrativeThread progressive（人族崛起主线）贯穿全书 | ✅ |

### F.32 《独步天下》（宅猪）——高武天下

| 设定维度 | 具体设定 | 框架映射 | 状态 |
|---------|---------|---------|------|
| **武道境界** | 完整的武学境界链 | `Fact: martial_realm` + Rule Engine TransitionRule | ✅ |
| **自强主题** | "天行健，君子自强不息"核心主题 | Rule Engine：努力/毅力影响修炼速度（软规则） | ✅ |
| **独步武道** | 追求武道巅峰，独步天下 | NarrativeThread progressive（武道追求） | ✅ |
| **门派/势力** | 各方势力争夺资源 | `EntityKind.entity(势力)` + `RelationKind.structural/social` | ✅ |
| **天才云集** | 多位天才的竞争与成长 | `Fact: talent_rank` + 多条并行 NarrativeThread | ✅ |
| **秘境/遗迹** | 上古修炼遗迹的探索 | ContextScope(秘境) + Rule Engine：遗迹特殊规则 | ✅ |

### F.33 《全职高手》（蝴蝶蓝）——电竞+游戏

| 设定维度 | 具体设定 | 框架映射 | 状态 |
|---------|---------|---------|------|
| **24种职业** | 荣耀游戏中24种职业（剑客/枪手/元素师/召唤师等），各有技能树 | World Package 定义24种职业 + `Fact: profession` + Rule Engine：职业技能 | ✅ |
| **角色≠玩家** | 玩家操作的游戏角色账号（如君莫笑/一叶之秋），有独立装备和技能 | `EntityKind.entity(游戏角色)` + `Fact: character_level/equipment`；角色与玩家分离 | ✅ |
| **装备体系** | 银武/橙武等装备等级，装备搭配影响战力 | `EntityKind.item(装备)` + `Fact: equipment_slots` + Rule Engine | ✅ |
| **技能/连招** | 每个职业固定技能树，技能组合产生连招效果 | `EntityKind.ability(技能)` + Rule Engine InferenceRule：连招触发 | ✅ |
| **战队/转会** | 职业战队和选手转会系统 | `EntityKind.entity(战队)` + `RelationKind.structural(战队归属)` + `Fact: transfer_status` | ✅ |
| **叶修退役复出** | 被迫退役→网吧打杂→重组战队→夺冠 | NarrativeThread progressive + Event Sourcing：退役事件 + Knowledge：叶修真实身份 | ✅ |
| **副本/团本** | 游戏内副本挑战，有固定机制 | ContextScope(副本) + Rule Engine：副本机制 + `Fact: raid_progress` | ✅ |
| **赛季排名** | 职业联赛的赛季积分和排名 | `Fact: season_rank/points` + Rule Engine：排名计算 | ✅ |
| **信息战** | 隐藏战术/新人信息/秘密训练方法 | Knowledge：战队战术对其他队伍 confidence（赛前隐藏→赛后公开） | ✅ |

### F.34 《第一序列》（会说话的肘子）——末世废土

| 设定维度 | 具体设定 | 框架映射 | 状态 |
|---------|---------|---------|------|
| **觉醒者体系** | 末世中部分人觉醒超能力，按等级划分 | `Fact: awakening_rank` + Rule Engine：觉醒能力效果 | ✅ |
| **末世废土** | 核战后的人类废土世界，资源匮乏 | World Package(废土)：资源稀缺规则 + ConstraintRule：食物/水/弹药消耗 | ✅ |
| **高墙/壁垒** | 财团建立高墙壁垒保护精英，外部是难民 | ContextScope(壁垒内/壁垒外) + Rule Engine：资源/法律差异 | ✅ |
| **任小粟** | 主角，拥有特殊觉醒能力+穿越者记忆 | `Fact: ability_type` + `Fact: origin=transmigrated` + Knowledge | ✅ |
| **财团势力** | 多个财团控制资源，互相制衡 | `EntityKind.entity(财团)` + `RelationKind.social(联盟/对抗)` | ✅ |
| **异兽/变异体** | 末世中的变异生物 | `EntityKind.entity(异兽)` + `Fact: mutation_level` | ✅ |
| **佣兵团** | 壁垒外的战斗组织 | `EntityKind.entity(佣兵团)` + `RelationKind.structural(成员)` | ✅ |
| **幽默叙事** | 以幽默/调侃方式描述末世 | 纯叙事风格，World Package 不需要特殊机制 | ✅ |

### F.35 《夜的命名术》（会说话的肘子）——都市赛博+双世界

| 设定维度 | 具体设定 | 框架映射 | 状态 |
|---------|---------|---------|------|
| **双世界穿越** | 现实世界与"表里世界"之间的穿越 | ContextScope 层级：real_world → hidden_world；exit_scope 可携带知识/能力 | ✅ |
| **赛博朋克都市** | 钢铁苍穹/霓虹城市/数据洪流 | World Package(赛博朋克)：科技+超能力共存 | ✅ |
| **觉醒/异能** | 部分角色拥有超自然能力 | `Fact: ability_type/ability_rank` + Rule Engine：能力效果 | ✅ |
| **时间穿越** | 主角在不同时间线穿越 | ContextScope(时间线) + `Fact: timeline_id` + Knowledge：时间线信息差 | ✅ |
| **组织势力** | 各种秘密组织和财团 | `EntityKind.entity(组织)` + `RelationKind.social` | ✅ |
| **少年热血** | "若在许我少年时，一两黄金一两风" | NarrativeThread progressive（少年成长） | ✅ |
| **情报/暗线** | 多方势力的情报战和暗线操作 | Knowledge：各势力对主角身份/能力的 confidence 差异 | ✅ |

### F.36 《万族之劫》（老鹰吃小鸡）——万族大战+高武

| 设定维度 | 具体设定 | 框架映射 | 状态 |
|---------|---------|---------|------|
| **万族设定** | 人族/妖族/神族/魔族等海量种族，各有语言/文化/力量体系 | World Package 定义万族规则 + `EntityKind.entity(种族)` + `Fact: race_type` | ✅ |
| **文武双修** | 文道（神文）与武道（战技）双线修炼 | `Fact: civil_realm/martial_realm`；两条并行成长线 | ✅ |
| **洞天/福地** | 独立空间，各有规则和资源 | ContextScope(洞天/福地) + Rule Engine：独立规则 | ✅ |
| **苏宇天赋** | 主角拥有特殊天赋和时间加速修炼 | `Fact: talent_type/time_acceleration` + Rule Engine：修炼加速效果 | ✅ |
| **种族大战** | 万族之间战争，涉及多个位面 | Event Sourcing：战争事件 + `EntityKind.entity(种族)` + `RelationKind.social(敌对)` | ✅ |
| **文明等级** | 不同种族的文明等级差异 | `Fact: civilization_level` + Rule Engine：文明等级影响科技/战力 | ✅ |
| **人族困境** | 人族在万族中相对弱小，面临生存压力 | NarrativeThread progressive（人族崛起）+ Rule Engine：生存压力 | ✅ |
| **上古传承** | 上古人族强者的传承和遗产 | `EntityKind.information(传承)` + NarrativeThread progressive | ✅ |
| **海量种族数据** | 上百个种族各有详细设定 | World Package 批量定义 + `Fact: racial_trait` | ✅ |

### F.37 验证总结

| # | 作品 | 作者 | 题材 | 设定维度数 | 全覆盖 | 需要的 World Package |
|---|------|------|------|-----------|-------|---------------------|
| 1 | 诡秘之主 | 爱潜水的乌贼 | 维多利亚蒸汽朋克+克苏鲁 | 18 | ✅ | lotm_sequences |
| 2 | 凡人修仙传 | 忘语 | 传统修仙 | 17 | ✅ | xianxia_cultivation |
| 3 | 斗罗大陆 | 唐家三少 | 武魂+魂环 | 18 | ✅ | douluo_continent |
| 4 | 神印王座 | 唐家三少 | 骑士+魔族 | 8 | ✅ | throne_of_seal |
| 5 | 绝世唐门 | 唐家三少 | 魂导科技 | 8 | ✅ | douluo_ii |
| 6 | 星辰变 | 我吃西红柿 | 修真+自创宇宙 | 9 | ✅ | stellar_transformations |
| 7 | 盘龙 | 我吃西红柿 | 西方奇幻+位面 | 9 | ✅ | coiling_dragon |
| 8 | 九鼎记 | 我吃西红柿 | 高武武侠 | 8 | ✅ | nine_cauldrons |
| 9 | 吞噬星空 | 我吃西红柿 | 科幻+宇宙 | 9 | ✅ | devouring_stars |
| 10 | 斗破苍穹 | 天蚕土豆 | 斗气+异火 | 10 | ✅ | battle_through_heavens |
| 11 | 大主宰 | 天蚕土豆 | 大千世界 | 8 | ✅ | the_great_ruler |
| 12 | 武动乾坤 | 天蚕土豆 | 元力+祖符 | 6 | ✅ | martial_arts_through_heavens |
| 13 | 神墓 | 辰东 | 复活+神魔 | 8 | ✅ | tomb_of_gods |
| 14 | 遮天 | 辰东 | 大帝+禁区 | 9 | ✅ | covering_the_sky |
| 15 | 完美世界 | 辰东 | 三千道州 | 8 | ✅ | perfect_world |
| 16 | 圣墟 | 辰东 | 花粉进化 | 7 | ✅ | sacred_ruins |
| 17 | 佛本是道 | 梦入神机 | 洪荒流 | 9 | ✅ | buddha_is_the_tao |
| 18 | 阳神 | 梦入神机 | 武道+神魂 | 7 | ✅ | yang_spirit |
| 19 | 龙蛇演义 | 梦入神机 | 现代国术 | 6 | ✅ | modern_martial_arts |
| 20 | 庆余年 | 猫腻 | 权谋+武侠 | 10 | ✅ | joy_of_life |
| 21 | 间客 | 猫腻 | 科幻+修行 | 6 | ✅ | the_guest |
| 22 | 将夜 | 猫腻 | 书院+永夜 | 9 | ✅ | ever_night |
| 23 | 邪气凛然 | 跳舞 | 都市黑道+异能 | 5 | ✅ | evil_nature |
| 24 | 恶魔法则 | 跳舞 | 西方奇幻+穿越 | 6 | ✅ | demon_law |
| 25 | 升龙道 | 血红 | 现代修真 | 5 | ✅ | ascending_dragon |
| 26 | 神魔 | 血红 | 史诗奇幻 | 6 | ✅ | gods_and_demons |
| 27 | 人道至尊 | 宅猪 | 上古洪荒 | 8 | ✅ | human_supreme |
| 28 | 独步天下 | 宅猪 | 高武 | 6 | ✅ | unmatched_world |
| 29 | 全职高手 | 蝴蝶蓝 | 电竞+游戏 | 9 | ✅ | the_kings_avatar |
| 30 | 第一序列 | 会说话的肘子 | 末世废土 | 8 | ✅ | first_sequence |
| 31 | 夜的命名术 | 会说话的肘子 | 赛博朋克 | 7 | ✅ | naming_night |
| 32 | 万族之劫 | 老鹰吃小鸡 | 万族+高武 | 9 | ✅ | tribulation_of_all_races |
| 33 | 蛊真人 | 蛊真人 | 黑暗修仙+智斗 | 12 | ✅ | gu_master |
| 34 | 三体 | 刘慈欣 | 硬科幻 | 12 | ✅ | hard_scifi_cosmos |
| 35 | 一人之下 | 米二 | 都市异能+道家 | 8 | ✅ | modern_yinren |
| 36 | 传说管理局 | — | 穿越+传说 | 9 | ✅ | 每个传说独立 World Package |

**核心结论**：36 部不同题材、不同作者、不同复杂度的作品，涵盖起点白金T0级作者14位，共计 **279 个设定维度**，题材横跨：

- **东方玄幻/修仙/洪荒**（斗罗/星辰变/斗破/佛本是道/人道至尊/蛊真人/凡人修仙传）
- **西方奇幻/骑士/魔法**（盘龙/神印王座/恶魔法则/神魔）
- **科幻/赛博朋克/末世**（吞噬星空/三体/第一序列/夜的命名术/间客）
- **都市异能/写实武术**（一人之下/龙蛇演义/升龙道/邪气凛然）
- **电竞/游戏**（全职高手）
- **权谋/政治**（庆余年）
- **穿越/多世界**（传说管理局/完美世界/圣墟/九鼎记）

Narrative-OS-Core 的五大抽象（Fact/NarrativeThread/Knowledge/ContextScope/Rule Engine）配合 World Package 配置化，**全部完整覆盖，无需为任何单一作品添加特殊机制**。

---

## 附录 G：LLM 集成与提示词工程

### G.1 ContextAnalyzer 提示词模板

ContextAnalyzer 通过一次轻量 LLM 调用，将写作上下文转化为结构化的检索信号（ContextSignals）。以下是 System Prompt 草稿：

```
你是一个叙事写作助手，负责从作者的写作上下文中提取检索信号。

给定当前章节号、场景实体、最近段落、作者意图，输出 JSON 格式的 ContextSignals：
{
  "semanticQueries": string[],   // 3-5 条语义检索查询，覆盖不同角度
  "scopeHints": string[],        // 推荐检索的作用域（如 dream/secret_realm）
  "entityDependencies": string[] // 建议预加载的关联实体 ID
}

要求：
1. semanticQueries 应覆盖：角色当前状态、场景环境、伏笔相关、力量体系相关
2. 每条查询 10-30 字，使用自然语言描述而非关键词堆叠
3. 只输出 JSON，不要输出任何其他内容

示例输入：
{
  "chapterNumber": 50,
  "sceneEntityIds": ["ent_hanli", "ent_nan_gongwan"],
  "recentParagraphs": "韩立在密室中取出小瓶...",
  "authorIntent": "韩立使用小瓶催熟灵草"
}

示例输出：
{
  "semanticQueries": [
    "韩立的神秘小瓶使用记录和限制",
    "筑基丹炼制所需灵草清单",
    "韩立当前修为和突破条件",
    "南宫婉与韩立的关系进展"
  ],
  "scopeHints": [],
  "entityDependencies": ["item_mysterious_bottle", "item_spirit_grass"]
}
```

### G.1.1 World Package 上下文注入

LLM 写作时需要知道当前 World Package 定义了哪些谓词和规则，否则会在 propose_event 中使用不存在的 predicate 或违反已定义规则。注入方式为将 World Package 摘要拼接到 system prompt 的头部：



注入策略：
- predicates：全量注入（通常 10-30 个谓词，token 开销可控）
- rules：只注入摘要（id + 类型 + 触发条件一句话），不注入完整 JSON
- entityTemplates：不注入 system prompt，在 get_context_slice 返回结果时按需提示
- 当活跃 World Package 变更（进入/退出作用域、新增/修改规则）时，自动更新 system prompt 中的摘要

### G.2 Tool Interface 的 LLM 请求集成

Narrative-OS-Core 的 10 个工具以 OpenAI/DeepSeek 兼容的 Tool Definition JSON 格式注入 LLM 请求。以下是完整的 DeepSeek API 请求体结构示例：

```json
{
  "model": "deepseek-chat",
  "messages": [
    {
      "role": "system",
      "content": "你是 Narrative-OS-Core 叙事助手。[FactRenderer 输出的实体档案 Markdown 粘贴在此]"
    },
    {
      "role": "user",
      "content": "作者当前写作内容 / 提问 / 指令"
    }
  ],
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "propose_event",
        "description": "提议一个叙事事件（沙盒预演）...",
        "parameters": { "type": "object", "properties": { "..." : "..." } }
      }
    }
  ],
  "tool_choice": "auto"
}
```

**对话历史管理策略**：
- 已提交的 proposal：对话历史保留 proposal_id 供后续 commit_event 引用
- 被拒绝的 proposal：对话历史中保留但标记为 rejected，防止 LLM 重复提交
- 超过上下文窗口时：按时间裁剪最早的对话轮次，但 system 消息中的 FactRenderer 输出始终保留

### G.3 LanceDB 嵌入式模式并发写入保护

LanceDB 同步由后台 sync worker 消费 `sync_queue` 触发，与主线程的 `RelevantFactRetriever.retrieve()` 可能并发。`@lancedb/lancedb` 嵌入式模式（进程内访问本地文件）的并发写入安全性取决于其内部实现。

**当前策略**：在所有 LanceDB 写操作前加异步互斥锁（Node.js 的 `async-mutex` 库），确保同一时刻只有一个写入操作：

```typescript
import { Mutex } from 'async-mutex';
const lanceDbMutex = new Mutex();

async function scheduleLanceDBSync(factIds: string[]): Promise<void> {
  const release = await lanceDbMutex.acquire();
  try {
    // 执行 LanceDB 写入
  } finally {
    release();
  }
}
```

读取操作（`RelevantFactRetriever.retrieve()`）不加锁，因为 LanceDB 的读取在写入期间是快照一致的。

### G.4 项目删除与数据清理策略

| 操作 | 处理方式 |
|------|---------|
| 删除项目 | `narrative_os_meta.db` 中 `projects` 表标记 `deleted_at` 时间戳（软删除），保留 30 天可恢复期 |
| 永久删除 | 30 天后清理任务删除 `projects` 记录 + 物理删除 `{project_id}.db` 和 `lancedb/{project_id}/` 目录 |
| ID 可重用 | 软删除期间同名项目不可创建（ID 冲突检测）；永久删除后 ID 可重用但不推荐（新项目建议生成新 ID） |
| 清理触发 | 应用启动时检查 `deleted_at` 超过 30 天的记录，批量执行永久删除 |

### G.5 Tool 使用规范与核心工作流（System Prompt 核心片段）

以下内容作为 LLM System Prompt 的核心片段注入，定义 LLM 与 Core 交互的基本工作流：

```
你是 Narrative-OS-Core 叙事引擎的智能代理。你的职责是将作者的自然语言意图转化为精确的 Tool Call，
并维护世界状态的一致性。

【核心工作流】
1. 写作前准备：系统会自动注入相关 Fact 和未关闭的 NarrativeThread。
2. 事件提议：当作者描述剧情推进时，使用 propose_event 提交 fact_changes。
3. 审阅报告：仔细阅读 simulation_report_markdown。如果存在 logic_conflict 或
   rule_violation，必须向作者解释代价，并引导作者补充前置事件
   （如：绝脉突破需要奇遇）。
4. 确认提交：作者同意后，调用 commit_event。
5. 概念扩展：当作者引入当前 World Package 中不存在的新设定时，暂停剧情推进，
   先调用 propose_schema_extension 注册新谓词/规则，作者确认后再继续。

【Tool 选择决策树】
- 需要查看实体当前状态？→ get_context_slice
- 作者描述了剧情推进/状态变更？→ propose_event → commit_event
- 需要修改已写入的历史？→ propose_retcon → commit_retcon
- 需要关闭叙事线索？→ resolve_thread
- 需要查看当前未填的坑？→ get_open_threads
- 出现了全新的设定概念？→ propose_schema_extension → commit_schema_extension
- 需要注册新角色/物品/地点？→ register_entity
```

### G.6 ID 传递契约（防幻觉硬约束）

以下内容作为 LLM System Prompt 中的硬性约束注入，是防止 LLM 捏造 Fact ID 的核心防线：

```
【⚠️ 绝对规则：ID 传递契约】
你没有跨会话的持久记忆。在执行 update 或 retract 操作时：

1. target_fact_id 必须且只能从最近一次 get_context_slice 返回的 fact_index 数组中提取。
2. 严禁捏造 ID：绝不允许根据猜测拼接 fct_xxx 格式的字符串。
3. 如果 fact_index 中没有你需要的 Fact，或者你需要修改历史，
   必须先调用 get_context_slice 重新获取最新索引，或者使用 propose_retcon。
4. 仔细阅读 fact_index 中的 action_hint 字段，它包含了精确的操作指导。
   例如：action_hint = "若要修改此设定，请在 propose_event 中使用 op='update',
   target_fact_id='fct_encounter_50_02'"——直接照做即可。

【违反契约的后果】
如果 Core 返回 FACT_ID_FABRICATED 错误，说明你试图使用一个不存在的 ID。
此时必须立即调用 get_context_slice 重新获取真实的 fact_index，从中选择正确的 ID。
绝不允许再次猜测。
```

### G.7 错误恢复与重试策略（Error Handling Prompt）

以下内容指导 LLM 在 Tool Call 失败时的行为策略：

```
【错误处理协议】
当 Tool Call 返回 status: 'failed' 时，根据 error.code 执行以下策略：

【可自动重试的错误】
- SCHEMA_VALIDATION_FAILED：
  参数格式错误。根据 detail 修正 JSON 结构后静默重试，无需打扰作者。
- FACT_ID_FABRICATED / FACT_NOT_FOUND：
  你使用了无效的 ID。立即调用 get_context_slice 获取真实 ID，然后重试。
- FACT_NOT_CURRENT：
  你试图修改已失效的历史 Fact。向作者说明该设定已在第 X 章被新设定覆盖，
  询问是要修改当前最新设定，还是发起 propose_retcon 修改历史。
- ENTITY_NOT_FOUND：
  引用的实体尚未注册。先调用 register_entity 注册实体，再重试原始操作。

【需要作者介入的错误】
- PREDICATE_CONFLICT / SCHEMA_EXTENSION_CONFLICT：
  新设定与世界底层法则冲突。向作者展示冲突详情，
  建议重命名谓词或调整规则逻辑。等待作者决定后重试。
- RETCON_CASCADE_TOO_DEEP：
  Retcon 影响范围过大。向作者展示级联报告，建议缩小修改范围
  或分多次 Retcon 逐步调整。

【系统级错误（不可重试）】
- INTERNAL_ERROR / EMBEDDING_SERVICE_UNAVAILABLE：
  向作者报告系统暂时不可用，建议稍后重试。
```

### G.8 认知失调（曼德拉效应）叙事注入模板

当 Retcon 导致角色记忆与世界线冲突时，Core 会生成 `type: 'logic_conflict', tags: ['cognitive_dissonance']` 的 NarrativeThread。以下模板指导 LLM 如何向作者提示这一叙事爆发点：

```
【认知失调处理协议】
当读取流注入 type: 'logic_conflict', tags: ['cognitive_dissonance'] 的 NarrativeThread 时，
这意味着 Retcon 导致了角色的记忆与当前世界线冲突。

你必须向作者这样提示：

"⚠️ 曼德拉效应警告：由于我们在第 X 章修改了 [历史事件]，[角色名] 的记忆出现了认知失调。
 他/她目前仍然认为 [旧事实]，但世界线的真相已经是 [新事实]。
 这是一个绝佳的剧情爆点！你想如何处理？
 1. 记忆修正：安排一个事件封印或覆盖他/她的旧记忆。
 2. 重新认知：让他/她通过调查发现真相，产生信仰崩塌或震惊。
 3. 保持冲突：将其作为悬疑伏笔，让他/她带着错误的记忆做出致命决策。"

等待作者选择后，根据选择生成对应的事件：
- 选择 1 → propose_event 中附带 KnowledgeChangeInput(op='seal')
- 选择 2 → propose_event 中附带新的 Knowledge（source='informed', confidence=0.9）
- 选择 3 → 保持 NarrativeThread 状态为 UNFILLED，等待后续剧情自然收束
```

### G.9 记忆操作（封印/搜魂/遗忘）引导模板

当作者的描述涉及认知层操作时，LLM 需要引导作者明确操作边界，而非直接生成普通的 fact_changes：

```
【记忆与认知操作协议】
当作者的描述中包含"洗去记忆"、"搜魂"、"喝孟婆汤"、"记忆模糊"、"忘记"、
"抹除认知"、"读取记忆"等意图时，不要直接生成普通的 fact_changes，
而是引导作者明确认知操作的边界：

"检测到认知层操作。为了精确追踪 [目标角色] 的知识状态变化，请确认以下细节：
 1. 操作范围：是遗忘所有事情，还是只遗忘关于 [特定人物/事件/谓词] 的记忆？
 2. 操作类型：
    - seal（记忆封印：彻底遗忘，confidence 降为 0，可被后续解除）
    - decay（记忆衰退：随时间模糊，confidence 降低）
    - soul_read（搜魂：[施法者] 强制读取 [目标] 的所有活跃记忆）
    - implant（记忆植入：植入一段虚假记忆）
 请告诉我具体细节，我将生成对应的认知事件。"

作者确认后，在 propose_event 的 fact_changes 之外，
附带 KnowledgeChangeInput 参数，Core 会自动在 knowledge 表中
插入对应的认知状态变迁记录（遵循 Event Sourcing 不删除原则）。
```

### G.10 LLM 接口兼容性验证用例 (Prompt Spike Design)

本节定义 Phase 0.5 期间用于验证 Tool Interface JSON Schema 对 LLM 友好度的 3 个边界用例。用例仅包含设计规格，实际 API 调用与通过率统计留待 Phase 0.5 执行。

**用例 1：知识封印防幻觉测试（验证 G.6 ID 契约）**

- **输入自然语言**：`"张三对李四施展大梦心经，封印了李四关于'古墓位置'和'神秘戒指'的所有记忆。"`
- **期望 Tool Call**：
  ```json
  { "op": "seal", "target_entity_id": "ent_lisi", "fact_id_scope": "by_predicate", "predicates": ["location", "holds_item"] }
  ```
- **失败模式**：LLM 输出 `"fact_id_scope": "explicit"` 并捏造 `fact_ids` 数组。
- **验证指标**：JSON Schema 校验通过率 ≥ 90%。若失败，需在 G.6 增强 Negative Prompt 或简化 `fact_id_scope` 枚举。

**用例 2：多目标搜魂嵌套结构测试（验证数组与角色消歧）**

- **输入自然语言**：`"王五搜魂了赵六获取邪宗情报，同时读取了旁边小喽啰关于护阵阵眼的记忆。"`
- **期望 Tool Call**：`knowledge_changes` 数组包含两个独立对象，`source_entity_id` 与 `target_entity_id` 严格对应，无交叉污染。
- **失败模式**：LLM 将两次操作合并为单一对象，或混淆 source/target 指向。
- **验证指标**：结构消歧准确率 ≥ 85%。若失败，需考虑将 `knowledge_changes` 拆分为独立 Tool 或增加 Few-Shot 示例。

**用例 3：隐性依赖声明提取测试（验证 §11.3 轻量依赖图）**

- **输入自然语言**：`"因为张三之前获得了避火珠，所以他安然走过了熔岩地带。"`
- **期望 Tool Call**：`propose_event` 参数中包含 `"dependent_fact_ids": ["fct_fire_bead_01"]`（假设上下文已渲染该 ID）。
- **失败模式**：LLM 忽略依赖声明字段，或填入当前事件新生成的 Fact ID（因果倒置）。
- **验证指标**：依赖提取召回率 ≥ 70%。若失败，需在 FactRenderer 上下文中对可依赖 Fact 增加 `@dependable` 标记辅助 LLM 识别。

**执行说明**：

- 使用 DeepSeek v4-flash（§D.1 技术栈），Temperature=0.2，仅输出 JSON。
- 每个用例运行 10 次，统计 Schema 合规率与字段准确率。
- 验证数据与通过率记录于本节，作为 Phase 1 冻结 Tool Interface 的门控依据。

### G.11 冲突场景 LLM 引导模板（Conflict Diagnosis Prompt）

当 `propose_event` 或 `commit_event` 返回的 `simulation_report` 中包含 `logic_conflict` 或 `rule_violation`，且 LLM 自身重试仍无法解决时，使用以下结构化模板将冲突诊断信息呈现给作者或上层 Agent。该模板的目标是**将冲突从"LLM 私下猜测"转为"可追溯的结构化诊断报告"**，避免 LLM 在多次重试中反复踩同一个坑。

```
【冲突诊断协议】
当 Tool 返回 simulation_report 中包含 logic_conflict 或 rule_violation，
且你已在 2 轮内无法自行修复时，按以下结构输出冲突诊断报告：

[CONFLICT_DIAGNOSIS_START]

**异常类型**：logic_conflict | rule_violation | scope_violation
**触发 Tool**：propose_event | commit_event | commit_retcon

**1. 冲突源头**
- 违反的不变式/规则 ID：{invariant_id 或 rule_id}
- 冲突涉及的实体：{entity_ids}
- 冲突涉及的谓词：{predicates}

**2. 冲突死结分析**（仅在多次重试失败时填写）
- 之前尝试的修复方案：{attempt_1}, {attempt_2}
- 为何失败：{每次尝试的具体驳回原因}

**3. 驳回证据**
- FactIndex 中相关条目：{列出 fact_index 中与冲突直接相关的条目摘要}
- 历史事实：{列出被冲突事实直接否决的历史 Fact 的 subject/predicate/value/time}
- 记录锚点：{event_id 或 audit_log 行号，便于人类回溯}

**4. 修复建议（解耦导向）**
以下提供 2 条解耦路径，作者选择后由 LLM 生成对应操作：

  路径 A（Retcon 路径）：
  如果冲突源于历史设定需要修正 → 调用 propose_retcon 修改历史 Fact，
  再重新提交当前事件。Retcon 范围：{预估级联深度和影响实体}。

  路径 B（实体替换路径）：
  如果冲突源于当前事件选错了目标实体或谓词 → 修改 fact_changes 中的
  subject/predicate/value，使其与现有世界状态不冲突。
  建议替换为：{基于 fact_index 推导的合法替代方案}。

[CONFLICT_DIAGNOSIS_END]

等待作者选择路径后执行。
```

**设计意图**：
- `[CONFLICT_DIAGNOSIS_START/END]` 标记使上层 Agent 编排层可以正则解析诊断报告，自动执行 L2/L3 熔断逻辑
- **解耦导向**：始终提供 Retcon 路径和实体替换路径两条出路，避免 LLM 陷入"同一方案反复尝试"的死循环
- **证据链完整**：FactIndex + 历史 Fact + 审计锚点，使人类审查时可追溯
- **仅在 2 轮重试失败后触发**：避免简单冲突（如 SCHEMA_VALIDATION_FAILED）浪费 token

---

## 附录 H：World Package 声明式规则系统

World Package 中的静态数据（谓词注册表、映射表、实体模板、作用域预设）是纯 JSON，无设计歧义。但规则（TransitionRule / InferenceRule / ConstraintRule / PropagationRule）的 check() / infer() 方法本质上是可执行代码——可执行代码不能放进 JSON 配置文件。

**根本矛盾**：如果 World Package 必须是 TypeScript 代码，普通用户无法自己创作；如果必须是 JSON，规则逻辑表达力不足。

**解决方案**：把规则本身数据化——用声明式 JSON 描述规则逻辑，Rule Engine 充当这套 JSON 的解释器。对于声明式无法覆盖的复杂场景，提供四层渐进增强机制。

### H.1 World Package 存储架构

Core 自带的 generic 包使用 TypeScript 硬编码实现通用规则。题材特定的谓词、规则、模板、作用域预设全部存储在项目 SQLite 数据库的 wp_* 表中（见附录 E.9）。

典型目录结构：

- generic（Core 自带）：TypeScript 硬编码，包含死亡约束/双向关系/重复 Fact 等通用规则
- xianxia_cultivation（修仙题材）：约 25 条谓词 + 5-8 条声明式规则，存储在 wp_* 表中
- lotm_sequences（诡秘之主题材）：约 20 条谓词 + 8-10 条声明式规则，存储在 wp_* 表中
- battle_through_heavens（斗破苍穹题材）：约 15 条谓词 + 5-8 条声明式规则，存储在 wp_* 表中

### H.2 静态数据格式（纯 JSON）

wp_predicates 表数据示例（修仙题材）：

- realm（修炼境界）：valueType=enum，enumValues=[炼气期,筑基期,结丹期,元婴期,化神期]，relationKind=state
- meridian（经脉状态）：valueType=enum，enumValues=[normal,shattered,repaired]，relationKind=state
- location（所在位置）：valueType=entity_ref，relationKind=spatial

entity-templates.json 示例：

- character_cultivator（修仙者）：defaultPredicates=[realm, meridian, location, status, lifespan_remaining]
- resource_spirit_herb（灵草）：defaultPredicates=[herb_grade, herb_effect, location]

### H.3 声明式规则 JSON 格式

#### 变量绑定系统

规则中通过 $ 前缀的路径表达式引用动态值，解释器通过 resolvePath(expr, ctx) 解析（约 30 行代码）：

| 表达式 | 解析为 |
|--------|--------|
| .type | event.type |
| .chapter | event.chapter |
| .subject | event.params.subject |
| .meridian | factStore.getSnapshot(subject, chapter)['meridian'] |
| .predicate | 推理规则触发 Fact 的 predicate |
| .value.entityId | 触发 Fact 的 EntityRef 目标 ID |
| .subject | 触发 Fact 的 subject |

#### TransitionRule 声明式格式

绝脉突破检测（修仙题材）：id=rule_meridian_breakthrough，trigger.eventType=tribulation，conditions: AND[snapshot_equals(.subject, meridian, shattered)]，consequence: generate_thread(logic_conflict, critical, 描述模板含 .chapter 变量)

异火吞噬代价（斗破苍穹题材）：id=rule_fire_devour_cost，trigger.eventType=devour_heterogeneous_fire，conditions: AND[snapshot_in(.subject, fire_rank, [1,2,3,4,5])]，consequence: generate_thread(rule_violation, major)

序列扮演偏差检测（诡秘之主题材）：id=rule_acting_deviation，trigger.eventType=ability_use，conditions: AND[snapshot_equals(.subject, acting_deviation_count, 非null)]，consequence: generate_thread(rule_violation, major)

#### ConstraintRule 声明式格式

死亡实体行动约束：id=constraint_dead_entity_action，trigger.eventType=*，conditions: AND[snapshot_equals(.subject, status, dead)]，consequence: generate_thread(rule_violation, critical)

寿元耗尽约束（修仙题材）：id=constraint_lifespan_zero，trigger.eventType=*，conditions: AND[snapshot_equals(.subject, lifespan_remaining, 0)]，consequence: generate_thread(rule_violation, critical)

#### InferenceRule 声明式格式

双向敌对关系推理：id=inference_bidirectional_enemy，trigger.predicate=enemy_of，infer: assert(.value.entityId, enemy_of, {entity_ref: .subject})，onlyIfNotExists=true

非凡特性析出推理（诡秘之主题材）：id=inference_beyonder_characteristic_drop，trigger.predicate=status+value=dead，infer: assert(.subject, characteristic_dropped, true)

onlyIfNotExists: true 是防重复的内置标志，Rule Engine 解释时自动做一次查重。

#### 条件类型一览

| 条件类型 | 含义 | 参数 |
|---------|------|------|
| snapshot_equals | 实体快照中某谓词值 == 指定值 | subject, predicate, value, negate? |
| snapshot_in | 快照中某谓词值在枚举集合内 | subject, predicate, values[] |
| snapshot_greater_than | 快照中某谓词值 > 指定值（数值比较） | subject, predicate, value |
| snapshot_less_than | 快照中某谓词值 < 指定值（数值比较） | subject, predicate, value |
| snapshot_gte | 快照中某谓词值 ≥ 指定值（数值比较） | subject, predicate, value |
| snapshot_lte | 快照中某谓词值 ≤ 指定值（数值比较） | subject, predicate, value |
| snapshot_sequence_jump | 有序枚举递进跨度检查：新旧值在 sequenceOrder 中的索引差是否在 [minSteps, maxSteps] 范围外 | subject, predicate, minSteps, maxSteps |
| fact_exists | 某条 Fact 是否存在 | subject, predicate, atChapter |
| event_param_equals | 事件参数等于指定值 | param, value |

条件支持 AND / OR 逻辑组合和嵌套，每个 check 可附加 negate: true 取反。

**snapshot_sequence_jump 详解**：

此条件操作符用于检测"有序枚举的非法跳级"。前提是目标 predicate 的 `PredicateDefinition` 中已定义 `sequenceOrder` 字段。

```
解释器逻辑（约 15 行代码）：
  1. 读取 factStore.getSnapshot(subject, chapter)[predicate] 获取旧值
  2. 从 event 的 fact_changes 中找到同一 predicate 的变更，获取新值
  3. 在 sequenceOrder 数组中查找旧值和新值的索引：oldIdx, newIdx
  4. 计算 step = newIdx - oldIdx
  5. 如果 step 不在 [minSteps, maxSteps] 范围内 → 条件命中（触发违规 Thread）

示例（绝脉突破违规检测）：
  { "op": "snapshot_sequence_jump", "subject": ".subject", "predicate": "realm", "minSteps": 1, "maxSteps": 1 }
  → 含义：境界递进恰好 1 级是合法的，跳级（step > 1）命中条件（需结合 AND 中的其他条件）

边界情况：
  - 旧值或新值不在 sequenceOrder 中 → 条件不命中（无法判断，放行）
  - sequenceOrder 未定义 → 解释器报 INTERNAL_ERROR（配置错误）
```

### H.4 Rule Engine 解释器实现

RuleEngine.computeConsequences() 主流程同时支持 TypeScript 内置规则和声明式 JSON 规则：



DeclarativeRuleEvaluator 核心约 80 行代码：evaluate() 检查 trigger 匹配 -> evalConditions() 递归评估 AND/OR 条件组 -> resolve() 解析 $ 变量路径 -> buildThread() 模板字符串渲染 + Thread 构建 -> buildInferredFact() 推理 Fact 构建。

**InferenceRule 的 update_math 动作（数值算术推理）**：

现有 `infer` 动作仅支持 `assert`（断言固定值的新 Fact）。对于需要基于旧值做算术运算的场景（如突破境界增加寿元、战斗扣血），需要 `update_math` 动作：

```json
// 示例：突破大境界自动增加 500 年寿元
{
  "id": "xianxia_inference_lifespan_boost",
  "type": "InferenceRule",
  "description": "突破大境界自动增加寿元",
  "trigger": { "eventType": "breakthrough" },
  "infer": {
    "op": "update_math",
    "subject": ".subject",
    "predicate": "lifespan_remaining",
    "expr": "$lifespan_remaining + 500"
  }
}
```

**update_math 表达式安全约束**（图灵完备性红线 H.5 的延伸）：

| 允许 | 禁止 |
|------|------|
| `+` `-` `*` `/` 四则运算 | 函数调用（`sin()`, `pow()` 等） |
| `$variable` 引用当前快照值 | 嵌套表达式超过 2 层（如 `($a + ($b * ($c - 1)))`） |
| 整数字面量 | 变量引用链超过 1 跳（如 `$entity.master.realm`） |
| | 条件分支（`if-then-else`） |

解释器实现（约 20 行代码）：对 `expr` 做正则白名单校验（仅允许 `$[a-zA-Z_]+` 和 `[0-9]+` 和 `[+\-*/]` 和空格），然后 `eval()` 替换变量为快照值后计算。校验不通过则报 `RULE_JSON_INVALID` 错误。

> **为什么不用 TypeScript 脚本**：`update_math` 覆盖了 90% 的数值推理场景（加血/扣血/增加寿元/业力累积），且表达式足够简单，不需要第三层脚本逃生口。如果运算逻辑需要条件分支或查表，则应逃逸到第三层（`type: script`）。

### H.5 四层渐进增强策略

附录 F 中 36 部作品 279 个维度的分析表明，绝大多数规则可以用声明式 JSON 表达。对于少数复杂场景，采用四层渐进增强：

| 层级 | 实现方式 | 覆盖场景 | 谁来写 |
|------|---------|---------|--------|
| 第一层：内置规则 | TypeScript 硬编码，generic 包 | 通用规则（死亡约束/双向关系/重复 Fact） | Core 开发者 |
| 第二层：声明式规则 | JSON 配置，Rule Engine 解释执行 | 题材规则（绝脉突破/序列扮演/异火吞噬/寿元约束） | LLM 辅助生成，作者审核 |
| 第三层：脚本规则 | type: script + TypeScript 文件 | 跨实体联查（身份暴露检测/途径互换校验） | 高级用户 |
| 第四层：LLM 评估 | 自然语言描述 + LLM 沙盒判断 | 极复杂规则（信息战/情报推理/多步因果推理） | 自然语言描述 |

第三层（脚本逃生口）：当声明式条件无法表达跨实体联查等复杂逻辑时，规则 JSON 中指定 type=script + scriptId，指向 rules/scripts/ 目录下的 TypeScript 文件（脚本规则除外，仍以文件形式存放）。需要编程能力，作为高级用法存在。

第四层（LLM 评估器）：在 computeConsequences 沙盒推演阶段调用一次轻量 LLM，将世界状态 + 事件 + 规则描述作为 prompt，让 LLM 判断是否触发。适用于信息战、多步因果推理等连脚本都难以表达的场景。

**World Package 图灵完备性红线**：声明式规则系统（第二层）必须是图灵不完备的。

具体约束：
- 声明式 JSON 规则不允许：循环、递归、条件分支嵌套超过 3 层、变量引用链超过 2 跳
- 需要复杂逻辑时，必须逃逸到第三层（TypeScript 脚本），而不是在 JSON 里模拟编程
- World Package 是配置，不是程序。Core 是引擎，不是虚拟机

**判断标准**：如果一个声明式规则需要超过 5 分钟向作者解释它的逻辑，它应该被降级为 TypeScript 脚本规则。

**World Package 安全白名单（Package Safety Rules）**：

允许声明：
- Predicate（谓词定义）
- Relation（关系映射）
- Rule 的声明式条件（trigger / conditions / consequence 描述）
- Template（实体模板）
- Taxonomy（分类标签）
- Scope Preset（作用域预设）

禁止执行：
- ❌ Loop / While / For（循环）
- ❌ Function / Lambda（函数定义）
- ❌ Workflow / StateMachine（流程控制）
- ❌ Action / Command（副作用执行）
- ❌ Variable mutation（可变状态）
- ❌ Recursion（递归）

**一句话约束**：World Package must remain declarative. 它声明"世界有什么法则"，不执行"法则如何运转"。执行是 Core Engine 的事。

### H.6 LLM 辅助 World Package 创作流程

作者不需要直接编写 JSON。整个创作过程是作者与 LLM 的自然语言对话，LLM 在背后处理所有技术细节。

#### H.6.1 基本流程（单条规则创建）

最简单的场景——作者描述一条规则，LLM 生成并注册：

1. 作者描述世界规则（自然语言）：我在写一个修炼小说，主角有寒毒状态，当他使用冰系功法时寒毒会加重
2. LLM 分析规则类型并生成 JSON：识别为 TransitionRule → 生成 `transition-ice-poison` 规则写入 wp_rules 表 → 将新谓词写入 wp_predicates 表
3. 作者审核 JSON：确认逻辑正确
4. WorldPackageLoader.import() 写入 SQLite 表：立即生效

#### H.6.2 完整项目创建流程（从零到写作）

以下展示一个修仙小说项目从创建到第 50 章的完整创作流程，涵盖 World Package 的加载、实体创建、规则触发、运行时扩展等全部环节。

**前提**：§3.9 的"端到端创作流程"已展示了作者视角的交互。本节从技术实现角度说明每个交互步骤的内部数据流。

**阶段一：创建项目**

```
作者输入: "我要写一本修仙小说，主角叫韩立，
          境界分炼气筑基金丹元婴，世界有人界灵界仙界"

LLM 内部处理:
  ① 匹配 World Package
     → worldType="xianxia" → 匹配 xianxia_cultivation
     → WorldPackageLoader.import() 将 xianxia_cultivation.json
       解析并写入项目的 wp_predicates / wp_rules / wp_entity_templates 表
     → 编译声明式规则（H.3 格式 → DeclarativeRule 对象）存入 wp_rules 表

  ② 注册主角实体
     → 调用 register_entity(name="韩立", kind="character")
     → 匹配 EntityTemplate: character_cultivator
     → 自动补全 defaultPredicates: [realm, meridian, status, location, lifespan_remaining]
     → 写入 entities 表

  ③ 匹配世界层级
     → "人界/灵界/仙界" → 在 scopePresets 中匹配三个作用域预设
     → 创建三个 ContextScope 实例（hierarchy: human_world < spirit_world < immortal_world）

  ④ 注入 World Package 摘要到 LLM system prompt（见 G.1.1）
     → predicates 全量注入: realm, meridian, spirit_root, lifespan_remaining, ...
     → rules 摘要注入: "rule_meridian_breakthrough: 绝脉突破检测", ...
```

**阶段二：设定角色属性**

```
作者输入: "四属性伪灵根，资质很差"

LLM 内部处理:
  ① propose_event:
     fact_changes = [
       {op: "assert", subject: "ent_hanli", predicate: "spirit_root",
        value: "四属性伪灵根"},
       {op: "assert", subject: "ent_hanli", predicate: "realm",
        value: "炼气期一层"}
     ]

  ② Core 沙盒预演（ProposalStore + RuleEngine.computeConsequences）:
     → FactStore.validate(): "四属性伪灵根" ∈ spirit_root.enumValues? ✅
     → FactStore.validate(): "炼气期一层" ∈ realm.enumValues? ✅
     → generic 规则检查: 死亡约束 → status 未设置，默认 alive ✅
     → xianxia 规则检查: 无触发条件匹配
     → proposalResult.isSafeToCommit = true

  ③ commit_event:
     → 开启 SQLite 事务
     → 写入 facts 表（2条 Fact，valid_from=1, is_current=1）
     → 写入 events 表（1条 NarrativeEvent）
     → 写入 sync_queue outbox：operation='insert_vector'
     → 提交事务
     → 后台 worker 生成 embeddingText（利用 PredicateDefinition.description 增强）并同步 LanceDB
```

**阶段三：第 30 章，剧情突破**

```
作者写到第 30 章: "韩立在小瓶的帮助下炼制了筑基丹，成功突破到筑基期"

LLM 内部处理:
  ① 读取当前状态:
     → get_context_slice(entityId="ent_hanli", chapter=30)
     → FactStore.getSnapshot("ent_hanli", 30)
     → 返回: {realm: "炼气期十三层", meridian: "normal", status: "alive", ...}

  ② propose_event:
     fact_changes = [
       {op: "assert", subject: "ent_hanli", predicate: "realm",
        value: "筑基期"}
     ]

  ③ 沙盒预演 → Rule Engine 执行所有活跃规则:
     generic:
       → constraint_dead_entity_action: status=alive ✅（不触发）
     xianxia_cultivation:
       → rule_meridian_breakthrough: trigger=tribution, eventType 不匹配 ✅
       → rule_realm_transition: "炼气期十三层"→"筑基期" 是合法相邻 ✅

  ④ commit_event:
     → 旧 Fact: realm="炼气期十三层" → markInvalid(valid_to=30, is_current=0)
     → 新 Fact: realm="筑基期", valid_from=30, is_current=1
     → sync_queue: mark_invalid(旧 Fact) + insert_vector(新 Fact)
     → 后台 worker 更新 LanceDB：旧向量 is_current=0，新向量 is_current=1
```

**阶段四：第 50 章，引入新设定（运行时扩展）**

```
作者写到第 50 章: "韩立在海外发现了上古传送阵，通过传送阵到了灵界"

LLM 内部处理:
  ① 作用域切换:
     → propose_event(type="enter_scope", scopeId="scope_spirit_world")
     → 沙盒预演 → 检查 scopePresets 中 spirit_world 预设
     → exitBehavior = suggest_promote
     → commit_event → 加载作用域专属包（如果有），按三层优先级合并
     → World Package 摘要自动更新到 system prompt

  ② 检测到未注册概念:
     → LLM 解析出"传送阵"这个概念
     → 查询 wp_predicates 表 → 无 teleport_array 谓词
     → 触发运行时补充流程（四层来源模型的第四层）

  ③ LLM 向作者确认:
     "检测到新设定'传送阵'，建议谓词: teleport_array (entity_ref),
      是否添加到世界规则？"

  ④ 作者确认并补充约束: "传送阵只能连接同源阵法"

  ⑤ LLM 生成并写入:
     → INSERT INTO wp_predicates: name='teleport_array', displayName='传送阵',
       valueType='entity_ref', relationKind='spatial'
     → INSERT INTO wp_rules:
       {
         id: "rule_teleport_same_origin",
         type: "ConstraintRule",
         trigger: { predicate: "teleport_array" },
         conditions: [/* 跨世界检测条件 */],
         consequence: { generate_thread: "传送阵跨世界违规" }
       }
     → World Package 摘要自动更新 → 后续事件受此规则约束
```

#### H.6.3 World Package 与四层架构的交互关系

上述流程中，四个架构层次各司其职：

```
┌─────────────────────────────────────────────────────────────────┐
│ 第四层：用户界面（未来的 Web/桌面 App）                              │
│ 作者看到的界面：聊天框、设定面板、时间线可视化                       │
│ 职责：展示 LLM 回复、渲染 FactRenderer 输出                        │
├─────────────────────────────────────────────────────────────────┤
│ 第三层：LLM 智能层（DeepSeek / Claude）                            │
│ 负责：理解作者意图 → 选择正确的 Tool → 解析返回结果 → 翻译成人话     │
│ World Package 交互：                                              │
│   - system prompt 中注入 WP 摘要（G.1.1）                         │
│   - 理解谓词语义从而选择正确的 predicate 名称                      │
│   - 检测新概念不在 WP 中时提示作者注册                              │
│   - 辅助生成新 WP 规则的声明式 JSON                                │
├─────────────────────────────────────────────────────────────────┤
│ 第二层：Tool Interface（§9 定义的 10 个工具）                      │
│ 这是 LLM 和 Core 之间的"翻译官"                                   │
│ 负责：将 LLM 的结构化参数转为 Core API 调用                        │
│   get_context_slice / propose_event / commit_event /             │
│   propose_retcon / commit_retcon / resolve_thread /              │
│   get_open_threads / register_entity /                           │
│   propose_schema_extension / commit_schema_extension              │
│ World Package 交互：propose_event 中校验 predicate 是否在 WP 中注册│
├─────────────────────────────────────────────────────────────────┤
│ 第一层：Core Engine（§3-8 的六大组件 + World Package）              │
│ FactStore / RuleEngine / KnowledgeStore /                         │
│ ContextScope / NarrativeThread / SemanticRetrieval                │
│ World Package 交互：                                              │
│   - RuleEngine 从 wp_rules 表读取规则执行校验                      │
│   - FactStore 从 wp_predicates 表读取谓词定义做校验                │
│   - FactRenderer 从 wp_predicates 读取 displayName 做中文渲染     │
│   - FactEmbedder 从 wp_predicates 读取 description 做语义增强     │
│   - ContextScope 切换时加载/卸载作用域专属包                        │
└─────────────────────────────────────────────────────────────────┘

核心原则：作者从来不直接碰 Core，只和 LLM 聊天。
作者只管写小说、描述自己的世界，World Package 的技术细节由系统和 LLM 在背后处理。
```

#### H.6.4 何时触发 World Package 操作

| 触发时机 | 触发者 | 操作 | 对应 WP 数据表 |
|---------|--------|------|--------------|
| 创建项目 | 作者 | 选择/匹配题材包，导入到项目数据库 | wp_predicates, wp_rules, wp_entity_templates, wp_scope_presets |
| 进入新作用域 | 作者剧情触发 | 加载作用域专属包，三层合并 | 同上（查询 active 配置） |
| 作者自定义规则 | 作者主动描述 | LLM 生成声明式 JSON → 写入 wp_rules | wp_rules, wp_predicates |
| 运行时新概念检测 | LLM 自动 | 提示作者 → 确认后写入 | wp_predicates, wp_rules |
| 版本升级 | 系统更新 | 追加谓词、标记 deprecated、更新 predicateAliases；不改写历史 Fact | wp_predicates + wp_predicate_aliases |

### H.7 与附录 F 的覆盖分析

279 个设定维度中，按规则复杂度分类：

| 复杂度 | 占比 | 典型示例 | 覆盖方案 |
|--------|------|---------|---------|
| 无需规则（纯数据） | 约60% | 势力格局、地理设定、感情线、经济体系 | wp_predicates + wp_entity_templates 表 |
| 声明式可表达 | 约30% | 境界突破条件、异火吞噬代价、序列扮演检测 | 声明式 JSON 规则 |
| 需脚本/LLM | 约10% | 身份暴露检测、诡秘途径互换、信息战推理 | script 逃生口 / LLM 评估器 |

**结论**：声明式规则系统覆盖约 90% 的作品需求，剩余 10% 通过渐进增强机制解决。

### H.8 题材族分组与实际包数量

36 部作品不需要 36 个独立 World Package。大量作品共享同类谓词和规则，按题材族分组后只需约 12-15 个包：

| 题材族 | 包 ID | 代表作品 | 共享谓词 | 独有谓词 | 独有规则 |
|--------|-------|---------|---------|---------|---------|
| **修仙族** | xianxia_cultivation | 凡人修仙/星辰变/人道至尊/阳神 | realm, lifespan, technique, bloodline | 蛊真人:gu_type; 佛本是道:sage_rank; 阳神:yang_spirit_stage | 共享5条 + 各2-3条独有 |
| **斗气族** | douqi_battle | 斗罗大陆/斗破苍穹/武动乾坤/大主宰 | power_level, technique_grade | 斗罗:soul_ring,spiritual_power; 斗破:fire_rank,soul_realm; 武动:ancestral_seal | 各3-5条独有 |
| **科幻族** | scifi_space | 吞噬星空/三体/第一序列/夜的命名术/间客 | tech_level, faction, planet | 三体:dark_forest_deterrence; 第一序列:awakening_rank | 各2-4条独有 |
| **都市异能族** | modern_urban | 一人之下/全职高手/邪气凛然/升龙道/龙蛇演义 | job, skill, reputation | 全职:profession,game_rank,equipment; 一人:qi_type | 全职需完整游戏系统规则 |
| **西方奇幻族** | western_fantasy | 盘龙/神印王座/恶魔法则/神魔 | magic_level, race, faction | 盘龙:law_mastery,divine_rank; 神印:knight_rank,spirit_furnace | 各2-3条 |
| **权谋族** | eastern_political | 庆余年/将夜 | martial_rank, political_rank | 将夜:cultivation_realm(不同于修仙) | 身份暴露检测 |
| **洪荒族** | honghuang_myth | 佛本是道/人道至尊 | 与修仙族共享基础 + sage_rank, karma, merit | 天道/圣人/量劫规则 |
| **辰东宇宙族** | chendong_universe | 神墓/遮天/完美世界/圣墟 | body_type, cultivation_realm(超长链) | 跨作品联动用 ContextScope 切换 |

**实际包数量**：1 个 generic + 6 个基础题材族包 + 5-8 个作品专属扩展 = **约 12-15 个包**。同一题材族内的作品共享基础包，通过追加自定义谓词和规则文件扩展。

**作品专属扩展方式**：在项目的 wp_predicates 和 wp_rules 表中追加自定义条目。例如"凡人修仙传"项目 = 参考修仙题材模板导入基础谓词和规则 + 追加灵根/灵药/飞升相关谓词和规则。


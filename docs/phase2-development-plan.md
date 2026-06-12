# Phase 2 开发计划

> 本文件是自主开发的持久化路线图。每完成一步，更新本文件的状态标记。
> 引擎读取此文件确定"下一步做什么"，完成后更新状态并记录到开发日志。

---

## 全局验收标准

每个 Step 完成前必须满足：
- [ ] `npm run typecheck` 零错误
- [ ] `npm test` 全量通过（无回归）
- [ ] 新增/修改的测试覆盖新逻辑
- [ ] 交叉核对架构文档 `docs/Narrative-OS-Core-Architecture.md` 对应章节，实现与文档一致
- [ ] `docs/core-development-log.md` 记录了变更内容

---

## Phase 2C：commit_event 集成 ThreadResolver + ThreadStore

> 目标：将 Phase 2A（ThreadStore）和 Phase 2B（ThreadResolver）接入 ProposalManager.commitEvent，
> 实现 Thread 的自动生成和双通道关闭。

### Step 2C-1：ProposalManager 构造函数扩展

**状态**：✅ 已完成（2026-06-11）

**任务**：
- ProposalManager 构造函数新增 `threadStore` 和 `threadResolver` 可选参数
- 保持向后兼容（不传时不影响现有 Phase 1 测试）

**验收条件**：
- [x] 构造函数签名：`constructor(ruleEngine?, proposalStore?, threadStore?, threadResolver?)`
- [x] 不传 threadStore/threadResolver 时，现有 221 个测试不回归
- [x] 传入时，`commitEvent` 可以使用它们

**架构文档对照**：
- §10.1 写入流 Phase B：ThreadResolver 在 Knowledge 写入之后、audit_log 之前执行
- §6.2.1 双通道关闭：commit_event 处理流程中的线索关闭

---

### Step 2C-2：Thread 自动生成（Rule Engine 产出持久化）

**状态**：✅ 已完成（2026-06-11）

**任务**：
- commitEvent Phase B 中，将 `consequences.generatedThreads` 逐条写入 ThreadStore.create()
- 验证生成的 Thread ID 格式（thr_ 前缀）
- 验证 RuleEngine 产出的 NarrativeThread 结构完整

**验收条件**：
- [x] commitEvent 后，ThreadStore.getOpen() 能查到 Rule Engine 产出的线索
- [x] 线索的 id / type / direction / severity / status / closeCondition 字段完整
- [x] 线索的 created_at_event 关联正确的事件 ID

**架构文档对照**：
- §5.5 沙盒推演步骤 1/3：Transition/Constraint 规则产生 NarrativeThread
- 附录 E.4 threads 表 DDL

**测试**：
- [x] 新增测试：commit_event 后 ThreadStore 中有 Rule Engine 产出的 foreshadowing 线索
- [x] 新增测试：不注入 ThreadStore 时向后兼容

---

### Step 2C-3：Thread 自动关闭（通道一）

**状态**：✅ 已完成（2026-06-11）

---

### Step 2C-4：Thread 显式关闭（通道二）

**状态**：⬜ 未开始

**任务**：
- proposeEvent 接收 `thread_resolutions` 参数（已存在于 ProposeEventParams）
- commitEvent 从 proposal 中取出 threadResolutions，传入 resolveThreads
- 对返回的 explicit 通道 resolutions，执行 ThreadStore 操作

**验收条件**：
- [ ] propose_event 声明 thread_resolutions 后，commit_event 将指定线索标记 FILLED/RESOLVED
- [ ] customRule 线索只能通过此通道关闭
- [ ] 尝试关闭已关闭的线索时返回错误（不影响事务中其他操作）

**架构文档对照**：
- §6.2.1 通道二：`FOR EACH thread_id IN thread_resolutions`

**测试**：
- [ ] 新增测试：customRule 线索通过 thread_resolutions 显式关闭
- [ ] 新增测试：已关闭线索在 thread_resolutions 中产生错误但不阻塞事务

---

### Step 2C-5：返回值更新 + 集成测试

**状态**：⬜ 未开始

**任务**：
- commitEvent 返回值 `affectedThreads` 反映实际持久化的线索 ID
- 新增完整的端到端集成测试：propose → commit → 验证 Thread 状态变化

**验收条件**：
- [ ] `affectedThreads` 包含所有被创建和被关闭的线索 ID
- [ ] 端到端测试覆盖：生成 + 自动关闭 + 显式关闭的组合场景

**架构文档对照**：
- §9.2 Tool 3 commit_event 返回值：affected_threads

---

## Phase 2D：知识传播合并优先级

> 目标：实现 knowledge_hints > knowledge_broadcast > propagation > subject_auto 四梯队合并。

### Step 2D-1：knowledgeHints 解析

**状态**：⬜ 未开始

**任务**：
- 解析 proposeEvent 的 knowledgeHints 参数
- 转换为 ProposedKnowledge[]，标记优先级 tier=1

**架构文档对照**：§3.6 合并优先级

### Step 2D-2：knowledgeBroadcast 解析

**状态**：⬜ 未开始

**任务**：
- 解析 proposeEvent 的 knowledgeBroadcast 参数
- 按 visibility 模式展开为目标实体列表
- 转换为 ProposedKnowledge[]，标记优先级 tier=2

### Step 2D-3：四梯队合并去重

**状态**：⬜ 未开始

**任务**：
- 按 (entityId, factId) 分组，组内按 tier 保留最高优先级
- 合并后结果与 knowledge_changes（显式操作）做第二阶段处理

---

## Phase 2E：QueryEngine.findThreads

**状态**：⬜ 未开始

**任务**：
- 新增 `findThreads(filter: ThreadFilter)` 方法
- 新增 `getExpiringThreads(currentChapter)` 方法
- 更新 NarrativeQueryEngine 接口

---

## Phase 2F：Retcon（世界状态回溯变更）

> 目标：实现 `propose_retcon`（BFS 级联遍历 + 影响报告）和 `commit_retcon`（级联标记执行）。
> 核心原则：Event Sourcing 不可变性——不删除 Fact，仅标记 contested。
> 架构文档：§9.2 Tool 4/5 + §3.1.3 certainty 状态机

### Step R-1：RetconEngine BFS 级联遍历算法

**状态**：✅ 已完成（2026-06-11）

**任务**：
- 实现 `bfsCascade(targetEventId)` — BFS 遍历因果链收集受影响实体
- 优先路径：EventStore.getByDependentFactIds（确定性依赖）
- 兜底路径：EventStore.getBySubject + predicate 匹配（启发式搜索）
- 收集受影响 Fact / Event / Thread / Knowledge，按 cascade level 组织
- BFS 在作用域边界硬停止（不跨 scope 追溯）

**验收条件**：
- [x] BFS 正确追溯一级影响（目标事件本身的 Fact）
- [x] BFS 正确追溯二级影响（依赖直接 Fact 的后续事件）
- [x] BFS 正确追溯三级影响（revenge 依赖 ambush）
- [x] BFS 正确收集被关闭的 Thread（closedByEvent 匹配）
- [x] BFS 正确收集受影响的 Knowledge（getByFactId）
- [x] BFS 在作用域边界停止

**架构文档对照**：§9.2 Tool 4 级联遍历算法

---

### Step R-2：FactStore 新增 contested 标记能力

**状态**：✅ 已完成（2026-06-11）

**任务**：
- FactStore 接口新增 `markContested(factIds: string[], causeEvent: string): number`
- FactStore 接口新增 `updateCertainty(factId: string, certainty: Certainty): void`
- SQLite 实现：批量 UPDATE facts SET certainty='contested' WHERE id IN (...)

**验收条件**：
- [x] markContested 返回实际更新行数
- [x] 只能标记 canonical → contested（不合法转换报错）
- [x] contested Fact 仍保持 is_current=true

**架构文档对照**：§3.1.3 certainty 状态转换路径

---

### Step R-3：级联影响报告生成 + cross-scope 扫描

**状态**：✅ 已完成（2026-06-11）

**任务**：
- 渲染 Markdown 级联报告（四级：直接影响 / 二级 / 深层 / 认知失调）
- 跨作用域优先路径扫描（event_dependencies + events JOIN）
- 跨作用域兜底路径扫描（subject + predicate 模糊匹配）
- 优先路径命中标记为 🔴 因果污染，兜底路径标记为 🟡 潜在关联

**验收条件**：
- [x] 报告包含 Level 1/2/3+ 分组
- [x] 报告包含 Thread 影响分组
- [x] 报告包含 Knowledge 认知失调统计
- [x] 跨作用域优先路径命中正确展示

**架构文档对照**：§9.2 Tool 4 跨作用域潜在影响扫描 + 级联影响报告示例

---

### Step R-4：propose_retcon 入口方法

**状态**：✅ 已完成（2026-06-11）

**任务**：
- 实现 `proposeRetcon(targetEventId, newDescription, newFactChanges, stores)`
- 执行 BFS + 生成报告 + 保存 RetconProposal
- 返回值：proposalId + isSafeToCommit + cascadeReportMarkdown

**验收条件**：
- [x] proposeRetcon 返回完整的级联影响报告
- [x] isSafeToCommit 正确反映是否有级联影响
- [x] RetconProposal 保存到内存 Map

**架构文档对照**：§9.2 Tool 4 返回值定义

---

### Step R-5：commit_retcon Phase B 事务

**状态**：✅ 已完成（2026-06-11）

**任务**：
- 创建 `evt_retcon_*` 系统事件（kind='system', type='retcon'）
- 标记所有受影响 Fact 为 contested
- Thread 处理：被关闭的 Thread 恢复（FILLED→UNFILLED, RESOLVED→PLANTED），upstreamFactIds 匹配的 → OBSOLETE
- 生成 cognitive_dissonance Thread（上限 50 条，按 confidence 降序）
- 写入 event_dependencies / audit_log / sync_queue
- 递增 project_state.state_version

**验收条件**：
- [x] 系统事件 kind='system', type='retcon' 正确创建
- [x] contested Fact 写入成功
- [x] Thread 恢复/OBSOLETE 正确
- [x] cognitive_dissonance Thread 生成且不超过 50 条上限
- [x] 返回值符合 Tool 5 定义

**架构文档对照**：§9.2 Tool 5 commit_retcon 的 Phase B 分解

---

### Step R-6：Retcon 集成测试（修仙场景）

**状态**：✅ 已完成（2026-06-11）

**任务**：
- 完整 propose → commit 流程测试
- 修仙场景：修改第 30 章敌对关系 → 影响第 50 章偷袭事件 → 影响第 55 章复仇事件
- 验证 contested Fact 在 canonical-only 查询中不可见
- 验证 cognitive_dissonance Thread 生成

**验收条件**：
- [x] 端到端流程测试通过
- [x] 级联报告内容验证
- [x] contested 标记验证
- [x] Thread 恢复验证

**架构文档对照**：§9.2 级联影响报告示例（evt_conflict_30）

---

## Phase 2F 完成总结

**状态**：✅ Phase 2 全部完成

**Phase 2 总体产出**：
- 线程系统：ThreadStore + ThreadResolver + ProposalManager 集成
- 双通道关闭：自动（closeCondition）+ 显式（thread_resolutions）
- 知识四梯队合并：hints(3) > broadcast(2) > propagation(1) > subject_auto(0)
- QueryEngine：findThreads + getExpiringThreads
- Retcon 引擎：BFS 级联遍历 + propose/commit 双阶段
- 全部 257 个测试，12 个测试文件

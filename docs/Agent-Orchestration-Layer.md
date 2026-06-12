# Narrative-OS Agent 编排层设计文档

**项目代号**：Narrative-OS-Core
**最后更新**：2026-06-08
**状态**：骨架草稿（Scaffold）

---

## 1. 定位与边界

### 1.1 本文档是什么

Agent 编排层是 Narrative-OS-Core **之上**的智能调度层。Core 是 Headless 状态引擎（§1.2 原则八），本层消费 Core 的 Tool 返回值信号，编排多轮 LLM 交互，处理 Core 设计中**明确排除**的复杂决策逻辑。

### 1.2 本文档不是什么

- 不是 Core 的扩展——本层不修改 Core 内部状态，只通过 Tool Interface 与 Core 交互
- 不是 UI 层——本层不涉及渲染、交互组件或用户界面
- 不是替代 Core 的检索管线——本层消费检索结果（`system_metadata.retrieval_telemetry`），不替代它

### 1.3 与 Core 的边界定义

```
┌───────────────────────────────────────────────────────────────────┐
│                    Agent 编排层（本文档）                           │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────────────────┐  │
│  │ L1/L2/L3    │  │ Retrieval-   │  │ ConflictResolution      │  │
│  │ 冲突分级熔断 │  │ Aware 写作   │  │ Agent                   │  │
│  └──────┬──────┘  └──────┬───────┘  └───────────┬─────────────┘  │
│         │                │                       │                │
│         ▼                ▼                       ▼                │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │              Core Tool Interface (10 Tools)                  │  │
│  │  system_metadata ← 可观测性信号（编排层唯一信息源）          │  │
│  └──────────────────────────┬──────────────────────────────────┘  │
└─────────────────────────────┼─────────────────────────────────────┘
                              │
┌─────────────────────────────▼─────────────────────────────────────┐
│                    Core Engine（Headless）                         │
│  FactStore / RuleEngine / KnowledgeStore /                        │
│  ContextScope / NarrativeThread / SemanticRetrieval               │
│  World Package / Snapshot / Dependency Graph                      │
└───────────────────────────────────────────────────────────────────┘
```

**核心契约**：
- 编排层 → Core：**只通过 Tool Call**（§9 定义的 10 个工具）
- Core → 编排层：**只通过 ToolResult + system_metadata**（§9.2 可选字段）
- 编排层**绝不**直接读写 SQLite / LanceDB / 内存数据结构

---

## 2. Core 输出信号消费模式

### 2.1 system_metadata 信号清单

| 信号字段 | 信号源 Tool | 含义 | 编排层用途 |
|---------|-----------|------|----------|
| `state_version` | 所有 Tool | Core 当前乐观锁版本 | 检测 Agent 内存是否过期，触发状态回滚协议 |
| `retrieval_telemetry.active_mode` | get_context_slice, get_open_threads | 检索管线实际模式 | 检测降级状态，切换写作策略 |
| `retrieval_telemetry.lance_db_sync_lag_ms` | 同上 | LanceDB 同步延迟 | 判断检索结果可信度，决定是否延迟写入 |
| `retrieval_telemetry.step0_hit_rate_window` | 同上 | Step 0 命中率 | 检索质量监控，触发 Spike 1 预案 |
| `concurrency_telemetry.contested_blacklist_size` | propose/commit 系列 | contested 黑名单大小 | 判断 Retcon 后遗症严重程度 |
| `concurrency_telemetry.hot_entities` | 同上 | 热点实体 | L2 熔断——序列化热点实体的操作 |
| `latency_budget_consumed_ms` | 所有 Tool | 延迟预算消耗 | 全局熔断——超过预算暂停操作 |

### 2.2 冲突信号来源

| 信号 | 来源 | 编排层响应 |
|------|------|----------|
| `simulation_report.logic_conflict` | propose_event | L1 自修复 → L2 诊断 → L3 暂停 |
| `simulation_report.rule_violation` | propose_event | L1 自修复 → L2 诊断 → L3 暂停 |
| `CONFLICT_DIAGNOSIS_START/END` | G.11 模板输出 | L2/L3 解析入口 |
| `ToolError.code = FACT_ID_FABRICATED` | commit_event | L1 自修复（重新 get_context_slice）|
| `ToolError.code = SCOPE_FACT_MISMATCH` | commit_event | L2 诊断（跨作用域冲突）|

---

## 3. L1/L2/L3 冲突分级熔断

### 3.1 设计原则

- **分级递进**：L1（LLM 自修复）→ L2（结构化诊断）→ L3（人类接管），不跳级
- **无状态判定**：每级判定仅基于当前 ToolResult + 历史重试计数，不依赖编排层持久状态
- **可配置阈值**：各级的最大重试次数、延迟预算上限均可配置

### 3.2 L1：LLM 自修复（Auto-Retry）

**触发条件**：ToolError 的 `retryable = true`，且重试次数 ≤ L1_MAX_RETRY（默认 2）

**处理策略**（对应 G.7 错误恢复协议）：

| 错误码 | 自修复动作 |
|-------|----------|
| SCHEMA_VALIDATION_FAILED | 根据 detail 修正 JSON 结构，静默重试 |
| FACT_ID_FABRICATED / FACT_NOT_FOUND | 调用 get_context_slice 获取真实 ID，重试 |
| ENTITY_NOT_FOUND | 调用 register_entity 注册后重试 |
| FACT_NOT_CURRENT | 向作者说明历史覆盖，询问修改目标 |

**升级到 L2 的条件**：
- L1 重试次数耗尽仍失败
- 错误码为 PREDICATE_CONFLICT / RETCON_CASCADE_TOO_DEEP / SCOPE_FACT_MISMATCH（非 L1 可修复）

### 3.3 L2：结构化冲突诊断（Conflict Resolution Agent）

**触发条件**：L1 升级 或 simulation_report 包含 logic_conflict/rule_violation

**处理流程**：
1. LLM 按 G.11 模板输出 `CONFLICT_DIAGNOSIS_START/END` 结构化诊断报告
2. 编排层解析诊断报告中的：
   - 异常类型 + 冲突源头 → 判断冲突本质
   - 驳回证据 → 验证 LLM 诊断是否合理
   - 修复建议 → 选择路径 A（Retcon）或路径 B（实体替换）
3. 自动执行选定的修复路径，重新提交

**ConflictResolutionAgent 约束**：
- 最大重试次数：MAX_RETRY = 2
- 每次重试必须携带不同的修复策略（由诊断报告中的"冲突死结分析"验证）
- 禁止执行 `run_agent_node` 等副作用操作，只允许 `query` 类 Tool

**状态回滚协议**（Agent Memory 同步）：
```
当 system_metadata.state_version > Agent 本地缓存版本时：
1. 编排层强制 Agent 调用 get_context_slice 刷新完整状态
2. 作废所有基于旧 state_version 的 pending proposals
3. 以 Core 返回的最新 fact_index 作为后续操作基准
```

### 3.4 L3：人类接管（Suspended State）

**触发条件**：
- L2 ConflictResolutionAgent 重试次数耗尽（MAX_RETRY = 2）
- 延迟预算耗尽（`latency_budget_consumed_ms` 超过全局上限）
- contested_blacklist_size 超过安全阈值（如 > 100）

**处理流程**：
1. 将冲突上下文（L2 诊断报告 + 全部重试历史）持久化为 **Suspended Ticket**
2. Ticket 包含：冲突类型、涉及实体、尝试过的修复方案、Core 当前 state_version
3. 进入 **SUSPENDED** 状态，等待人类审查
4. 人类审查后的决策通过正常 Tool Call 路径提交（编排层不做任何假设）

**SUSPENDED 暂挂协议**：
- 编排层在 SUSPENDED 状态下拒绝所有新的 propose_event / propose_retcon
- 只允许 get_context_slice / get_open_threads（只读查询）
- 人类通过 resolve 操作解除 SUSPENDED 后恢复正常流程

---

## 4. Retrieval-Aware 写作策略

### 4.1 设计意图

Core 的检索管线（§7 六段管线 Step 0~5）存在三种运行模式，编排层需要根据 `system_metadata.retrieval_telemetry.active_mode` 调整 LLM 的写作行为。

### 4.2 策略矩阵

| 检索模式 | active_mode | 编排层策略 |
|---------|-------------|----------|
| 正常 | `full_pipeline` | 标准写作流程，无特殊处理 |
| 降级 A | `bm25_hybrid_fallback` | 提示 LLM "当前使用混合检索，结果可能包含词汇匹配噪声，请谨慎采纳设定细节" |
| 降级 B | `graph_walk_fallback` | 提示 LLM "检索系统严重降级，仅使用确定性图遍历，建议暂缓涉及复杂设定交叉的剧情" |

### 4.3 Step 0 命中率监控

`step0_hit_rate_window` 持续低于阈值（默认 0.3）时：
- 编排层向 Core 触发一次全量 get_context_slice 强制刷新
- 如果刷新后命中率仍低，说明短期工作记忆窗口不足，建议调大 Step 0 的 `recent_events_limit`（Core 配置参数）

---

## 5. 多智能体协作（Phase 2 预留）

### 5.1 当前状态

Phase 1 为单 Agent 架构——一个 LLM 实例通过 Tool Call 与 Core 交互。本节为 Phase 2 多 Agent 场景预留设计空间。

### 5.2 多 Agent 热点冲突

当多个 Agent 并发操作同一实体时（`concurrency_telemetry.hot_entities` 非空）：
- **乐观策略**：允许多个 Agent 并行 propose，commit 时由 Core 乐观锁仲裁
- **保守策略**：编排层对热点实体加应用级锁，序列化操作
- Phase 1 采用乐观策略（Core 已有 state_version 乐观锁），Phase 2 视冲突频率决定是否升级

### 5.3 Agent 间信息共享

多 Agent 场景下，Agent 间的信息共享仍通过 Core：
- Agent A 写入 Fact → Agent B 通过 get_context_slice 读到
- 不引入 Agent 间直接通信通道
- 保持 "Core 是唯一真相源" 原则

---

## 6. 接口定义（TypeScript）

### 6.1 编排层配置

```typescript
interface OrchestrationConfig {
  /** L1 最大自修复重试次数 */
  l1_max_retry: number;          // 默认 2

  /** L2 ConflictResolutionAgent 最大重试次数 */
  l2_max_retry: number;          // 默认 2

  /** 全局延迟预算上限（ms），超限进入 L3 */
  global_latency_budget_ms: number;  // 默认 10000

  /** contested 黑名单安全阈值，超限进入 L3 */
  contested_threshold: number;   // 默认 100

  /** Step 0 命中率告警阈值 */
  step0_hit_rate_floor: number;  // 默认 0.3

  /** 检索降级时的 LLM 提示注入（按 active_mode 索引） */
  degradation_prompts: Record<string, string>;
}
```

### 6.2 Suspended Ticket 结构

```typescript
interface SuspendedTicket {
  id: string;                     // 格式：ticket_{timestamp}_{random}
  created_at: string;             // ISO 8601
  conflict_type: 'logic_conflict' | 'rule_violation' | 'scope_violation' | 'latency_exhausted';
  core_state_version: number;     // 冻结时的 state_version
  involved_entities: string[];
  involved_predicates: string[];
  diagnosis_report: string;       // G.11 CONFLICT_DIAGNOSIS 原文
  retry_history: RetryAttempt[];  // L1 + L2 全部重试记录
  status: 'suspended' | 'resolved';
  resolved_by?: string;           // 人类审查者的决策摘要
}

interface RetryAttempt {
  level: 'L1' | 'L2';
  attempt_number: number;
  error_code: string;
  fix_strategy: string;
  result: 'success' | 'failed' | 'escalated';
}
```

---

## 7. 实现路线图

### 7.1 Phase 1（与 Core Phase 1 同步）

- [ ] 实现 L1 自修复循环（对应 G.7 错误恢复协议，包装在 Tool Call 重试逻辑中）
- [ ] 实现 `system_metadata` 解析器（从 ToolResult 提取遥测信号）
- [ ] 实现 Retrieval-Aware 写作策略（降级提示注入）
- [ ] 实现延迟预算计数器（累积 `latency_budget_consumed_ms`）

### 7.2 Phase 1.5

- [ ] 实现 L2 ConflictResolutionAgent（G.11 模板解析 + 自动路径选择）
- [ ] 实现 SUSPENDED 状态机 + Ticket 持久化
- [ ] 实现状态回滚协议（Agent Memory 强制同步 Core state_version）

### 7.3 Phase 2（预留）

- [ ] 多 Agent 并发策略（乐观 vs 保守）
- [ ] Agent 间通过 Core 的信息共享验证
- [ ] L2 诊断报告的可视化面板

---

## 附录 A：与 Core 架构文档的交叉引用

| 本文档章节 | Core 架构文档对应章节 | 关系 |
|-----------|-------------------|------|
| §2 信号消费 | §9.2 system_metadata | 编排层消费 Core 返回的遥测信号 |
| §3.2 L1 自修复 | 附录 G.7 错误恢复策略 | 编排层实现 G.7 定义的重试协议 |
| §3.3 L2 冲突诊断 | 附录 G.11 冲突诊断模板 | 编排层解析并执行 G.11 诊断报告 |
| §4 Retrieval-Aware | §7 语义检索层 + §11.8 降级预案 | 编排层根据检索模式调整写作策略 |
| §5 多 Agent | §11.6 Core Dependency Graph | 多 Agent 场景下的依赖边界 |
| §6.2 Suspended Ticket | §4.3.2 ProposalStore | Ticket 与 Proposal 的生命周期关系 |

---

*本文档是 Narrative-OS-Core 架构设计文档的伴生文档，不独立存在。Core 文档路径：`docs/Narrative-OS-Core-Architecture.md`*

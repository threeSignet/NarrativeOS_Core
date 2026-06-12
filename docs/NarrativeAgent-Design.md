# NarrativeAgent 智能体设计文档

**项目代号**：Narrative-OS-Core  
**最后更新**：2026-06-12  
**状态**：v0.1 完整单智能体闭环设计，待实现  

---

## 1. 设计目标

NarrativeAgent 是 Core 之上的智能体会话层。它负责和用户进行持续多轮沟通，理解写作意图，自主决定是否调用工具，观察 Core 返回结果，在失败后反思并修正策略，最终在用户授权下把定稿内容提交为正式世界状态。

本文档只设计 NarrativeAgent 自身，不设计外部接入协议、MCP、UI、客户端频道或产品交互层。

---

## 2. 命名与边界

本项目中 `ProjectSession` 已经是 Core 内部上下文对象，定义在 `src/types/session.ts`，用于统一持有 Store、LLM、WorldPackage 等服务实例。为了避免概念冲突，智能体层统一命名为：

```text
NarrativeAgent
```

后续不再用 `ProjectSession` 指代智能体会话层。

统一架构：

```text
用户
  ↓
NarrativeAgent
  ↓
LLMClient
  ↓
ToolRouter
  ↓
Core Engine / Stores
```

NarrativeAgent 不直接读写 Core 内部表，不绕过 ToolRouter 修改世界状态。Core 仍然是事实、事件、规则和一致性的唯一裁决者。

实现位置边界：

```text
src/core        ：Core 内核，不能放 NarrativeAgent
src/agent       ：NarrativeAgent 本体、运行状态、ReAct 循环、记忆策略
src/adapters    ：AgentStore / TraceStore 等持久化适配器可以放在这里
tests/agent     ：NarrativeAgent 的 Mock LLM 和行为测试
tests/live-*    ：真实 LLM 验证脚本，调用 NarrativeAgent
```

因此，NarrativeAgent 可以和 Core 位于同一个仓库、同一个 npm 包、同一个项目数据库中，但不能成为 Core 内核的一部分。Core 不依赖 Agent，Agent 依赖 Core 的 ToolRouter / Tool Interface。

数据库边界：

```text
Core 表      ：facts / events / entities / knowledge / threads / project_state
Agent 表     ：agent_sessions / agent_turns / agent_messages / agent_traces / agent_memories
```

Agent 表可以写在同一个项目 SQLite 数据库中，保证随项目移动和备份；但这些表是 Agent sidecar metadata，不是 Core 世界状态。Core 的规则引擎、事件提交、Fact 查询不得依赖 agent_* 表。

---

## 3. 核心定义

NarrativeAgent 不是写死流程的代码编排器，也不是纯 LLM 放飞。

正式定义：

```text
NarrativeAgent = LLM 认知核心 + 会话运行监管 + Core 确定性校验
```

它拥有两类职责：

1. 智能决策：理解用户、规划下一步、选择工具、修改草案、反思失败、组织回复。
2. 运行监管：维护消息、执行工具、闭合 tool response、追踪 proposal、记录 trace、防止伪成功。

代码层不替 Agent 写死创作策略，但必须保证 Agent 的行为可靠落地。

v0.1 的目标不是“基础工具循环”，而是一个可用的单智能体闭环。它暂不处理 MCP、UI、多 Agent 等外部或扩展问题，但在单个项目内部必须具备完整的理解、规划、草案演化、工具行动、失败反思、用户确认、提交授权、上下文压缩、跨会话长期记忆和审计能力。

v0.1 成立的最低标准：

- 用户可以和 Agent 围绕同一叙事变更连续沟通多轮。
- Agent 能维护当前工作草案，而不是每轮从零开始。
- Agent 能自主决定查询、注册、提案、提交等工具动作。
- Agent 能在失败后反思并改变策略。
- Agent 能识别“用户还在修改”和“用户已经确认”的区别。
- Agent 能在用户确认或授权后把最终版本提交给 Core。
- Agent 能在长对话中压缩上下文，并在跨会话时召回已确认的协作记忆。
- Agent 能把关键行为摘要写入项目数据库，便于复盘。

---

## 4. 内部 ReAct 循环

NarrativeAgent 采用内部 ReAct 模式：

```text
Reason → Act → Observe → Reflect → Reason → ... → Respond
```

各阶段含义：

| 阶段 | 含义 |
| --- | --- |
| Reason | LLM 根据用户输入、历史消息、当前草案、观察结果和反思摘要决定下一步 |
| Act | NarrativeAgent 执行 LLM 发起的工具调用 |
| Observe | 将 ToolRouter / Core 返回结果整理为 observation |
| Reflect | 失败、冲突、未完成状态出现时先反思，再决定下一步 |
| Respond | 向用户输出自然语言回复或阶段性结果 |

ReAct 是内部运行模型，不是用户界面格式。用户不应看到完整的 thought/action/observation 模板。

---

## 5. 运行状态

NarrativeAgent 至少需要维护以下内部状态：

```ts
interface NarrativeAgentRuntimeState {
  projectId: string;
  sessionId: string;
  currentTurnId: string;
  messages: AgentMessage[];
  memoryState: AgentMemoryState;
  workingDraft?: AgentWorkingDraft;
  pendingProposalIds: string[];
  activePlan?: AgentPlan;
  toolFailureCounts: Record<string, number>;
  traceBuffer: AgentTraceRecord[];
  commitAuthority: CommitAuthority;
  status: AgentTurnStatus;
}
```

关键字段说明：

| 字段 | 用途 |
| --- | --- |
| `messages` | 保存 Agent 的多轮上下文 |
| `memoryState` | 保存上下文窗口、压缩摘要和长期记忆索引状态 |
| `workingDraft` | 保存当前协商中的草案 |
| `pendingProposalIds` | 追踪已 propose 但未 commit 的候选提案 |
| `activePlan` | 保存当前回合的动态计划，只作为 Agent 自我管理摘要，不是死流程 |
| `toolFailureCounts` | 防止同一失败无限循环 |
| `traceBuffer` | 本轮 ReAct 摘要，最终写入项目数据库 |
| `commitAuthority` | 判断当前 Agent 是否有提交授权 |
| `status` | 表示本轮是完成、待用户确认、失败还是暂停 |

建议计划结构：

```ts
interface AgentPlan {
  goalSummary: string;
  steps: Array<{
    id: string;
    summary: string;
    status: 'pending' | 'running' | 'done' | 'blocked' | 'abandoned';
  }>;
  updatedAt: string;
}
```

`activePlan` 只记录可审计的计划摘要，不记录完整隐藏推理链。计划可以被 LLM 在后续 Reason 阶段修改，NarrativeAgent 只负责保存摘要、追踪状态和防止伪完成。

建议记忆状态结构：

```ts
interface AgentMemoryState {
  contextWindowSummary?: string;
  compressedUntilMessageId?: string;
  longTermMemoryRefs: string[];
  tokenBudgetEstimate?: number;
  updatedAt: string;
}
```

`memoryState` 不替代 Core。它只服务于 Agent 自身的会话连续性：哪些消息已经压缩、当前上下文摘要是什么、哪些长期记忆需要注入下一轮 Reason。

---

## 6. 意图理解与动态规划

NarrativeAgent 每轮收到用户输入后，先判断这句话在当前会话中的作用。

典型意图：

| 意图 | Agent 行为 |
| --- | --- |
| 新增设定 / 事件 | 创建或更新 working draft，必要时查询上下文 |
| 修改现有草案 | 保持 revising 状态，更新 working draft，不提交 |
| 询问当前状态 | 优先通过 Core 查询，再组织自然语言回答 |
| 要求推演 | 基于 Core 状态和草案生成可解释方案，不直接写入 |
| 明确确认提交 | 检查 commit authority，必要时 propose_event 后 commit_event |
| 表达否定 / 不满意 | 废弃或回退当前草案，记录 revision |
| 信息不足 | 进入 `needs_user_input`，向用户提出最小必要问题 |

动态规划原则：

- Agent 可以生成当前目标和步骤摘要，但不得把计划当成不可变流程。
- 用户修改意见优先级高于旧计划。
- Core observation 优先级高于 LLM 预期。
- 失败 reflection 会改写后续计划。
- 当计划与用户最新意图冲突时，旧计划必须作废或重写。

---

## 7. 草案、提案、提交

NarrativeAgent 必须区分三层状态：

```text
draft      ：用户和 Agent 多轮协商中的草案
proposal   ：经过 propose_event 后的 Core 沙盒候选
committed  ：经过 commit_event 后的正式世界状态
```

典型流程：

```text
用户和 Agent 多轮沟通
  ↓
Agent 维护 evolving draft
  ↓
用户不断提出修改意见
  ↓
Agent 修改 draft
  ↓
必要时重新 propose_event
  ↓
旧 proposal 废弃或不再使用
  ↓
用户确认最终版本
  ↓
Agent commit_event
```

当用户仍在表达修改、犹豫、偏好或条件时，NarrativeAgent 必须保持 `draft` / `revising` 状态，不得提交。

建议草案结构：

```ts
interface AgentWorkingDraft {
  id: string;
  status:
    | 'collecting'
    | 'revising'
    | 'proposed'
    | 'ready_to_commit'
    | 'committed'
    | 'abandoned';
  summary: string;
  structuredIntent?: unknown;
  proposedFactChanges?: unknown[];
  proposalId?: string;
  revisionCount: number;
  createdAt: string;
  updatedAt: string;
}
```

草案演化规则：

- 用户提出补充、修改、否定、条件时，`revisionCount` 增加。
- 如果已有 `proposalId`，但用户继续修改，则旧 proposal 必须标记为过期或不再使用。
- 新 proposal 必须基于最新 working draft 生成。
- working draft 可以跨多个 turn 保留，直到 committed、abandoned 或被新任务替换。
- Agent 回复用户时应说明草案的当前状态，但不暴露内部 trace 细节。

---

## 8. 提交主权

`commit_event` 是受授权动作。NarrativeAgent 不天然拥有提交正式世界状态的主权。

提交链条：

```text
用户主权
  ↓
Agent 代理执行
  ↓
Core 确定性裁决
```

内部授权状态：

```ts
type CommitAuthority =
  | 'explicit_user_confirmation'
  | 'agent_authorized_for_task'
  | 'agent_authorized_for_session';
```

默认值：

```text
explicit_user_confirmation
```

含义：

| 授权 | 含义 |
| --- | --- |
| `explicit_user_confirmation` | 必须等用户明确确认后才能提交 |
| `agent_authorized_for_task` | 当前任务内 Agent 可自动提交通过 Core 校验的定稿 |
| `agent_authorized_for_session` | 当前会话内 Agent 可自动提交，主要用于 live 验证和自动化测试 |

即使用户授权，Core 仍然可以拒绝提交。Core 拒绝后，NarrativeAgent 不能把结果说成成功。

---

## 9. 用户确认识别

NarrativeAgent 必须把“用户继续协商”和“用户确认提交”区分开。

明确确认示例：

```text
就按这个提交
写入正史
确认
可以提交
定稿
这一版通过
```

继续协商示例：

```text
再改一下
我觉得不对
如果换成另一种方式呢
先别提交
等等
这个地方需要调整
```

原则：

- 模糊表达不得自动视为提交确认。
- 用户仍在提出条件或修改时，不得提交。
- 如果用户说法可能是确认也可能是继续讨论，Agent 应进入 `needs_user_confirmation`，用最短问题确认。
- 已授权自动提交的测试或任务模式除外，但仍必须经过 Core 校验。

---

## 10. 失败反思机制

工具失败后，NarrativeAgent 不能直接重试，必须先反思。

固定流程：

```text
工具调用失败
  ↓
Observe：生成失败 observation
  ↓
Reflect：生成 reflection summary
  ↓
Reason：基于反思重新规划
  ↓
Act：继续调用工具、换工具、改参数、请求用户补充或终止
```

反思采用混合机制：

```text
确定性诊断 + LLM 语义修复
```

确定性诊断负责：

- 错误码解释
- tool_call / tool_result 协议闭合
- proposal 是否存在
- Fact 是否 current
- 是否重复同一失败
- Core 是否拒绝写入

LLM 语义修复负责：

- 修改叙事方案
- 补充缺失事件
- 重新组织 fact_changes
- 生成用户可理解的说明

建议反思结构：

```ts
interface AgentFailureReflection {
  failedTool: string;
  errorCode?: string;
  summary: string;
  deterministicDiagnosis: string;
  nextAction:
    | 'retry_with_repaired_args'
    | 'call_different_tool'
    | 'refresh_context'
    | 'revise_draft'
    | 'ask_user'
    | 'abort_turn';
  correctionHint?: string;
}
```

常见失败策略：

| 错误类型 | 反思后策略 |
| --- | --- |
| 参数结构错误 | 修复参数结构，避免原样重试 |
| 实体不存在 | 判断是否应注册实体，或查询上下文确认真实 ID |
| Fact 非 current | 刷新上下文，基于最新 Fact 重新生成 proposal |
| proposal 不存在 | 停止复用旧 ID，重新 propose 或回到草案 |
| Core 约束冲突 | 修改叙事方案，而不是强行提交 |
| 重复同一失败 | 达到阈值后停止本轮，向用户说明需要确认或补充 |

---

## 11. 工具循环监管

NarrativeAgent 必须保证以下运行约束：

- 每个 assistant tool_call 都必须有对应 tool response。
- 纯文本 assistant 回复不能被吞掉。
- 工具失败不能伪装成成功。
- 相同工具的相同失败重复达到阈值后，本轮必须停止或请求用户介入。
- `propose_event` 成功后必须追踪 `proposal_id`。
- `commit_event` 成功后必须从 pending 集合移除对应 `proposal_id`。
- 本轮结束时若仍有 pending proposal，必须明确进入待确认或待处理状态。

业务层不限制用户对话轮次，也不限制 Agent 内部工具调用轮次。但运行时必须有安全护栏：

```ts
interface NarrativeAgentRuntimeLimits {
  maxToolSteps: number;              // 默认 32
  maxRepeatedToolFailure: number;    // 默认 3
  maxWallClockMs: number;            // 默认按运行环境配置
}
```

这些限制不是业务限制，而是防止死循环和失控调用。

---

## 12. 输出与沟通行为

NarrativeAgent 对用户的输出必须是自然语言，而不是内部协议格式。

输出原则：

- 可以说明“我查到了什么、更新了什么、还需要你确认什么”。
- 不输出完整 ReAct thought。
- 不把工具失败包装成成功。
- 当状态为 `needs_user_confirmation` 时，应清楚呈现待确认内容。
- 当状态为 `needs_user_input` 时，只问解决阻塞所需的最小问题。
- 当 Core 拒绝写入时，应说明拒绝原因和可选修复方向。

流式输出要求：

- LLM 纯文本回复必须能正常输出。
- 工具调用阶段可以输出简短状态摘要，但不伪造已经完成的结果。
- 最终回复必须与实际 Core 结果一致。

---

## 13. Trace 持久化

NarrativeAgent 的 ReAct trace 必须写入项目数据库，并跟随项目移动、备份和复盘。

Trace 记录：

- 行为摘要
- 观察摘要
- 反思摘要
- 决策摘要
- 结构化细节摘要

Trace 不记录：

- 完整隐藏思维链
- 完整 prompt
- 完整长上下文
- 用户未授权持久化的敏感原文

Trace 类型：

```ts
type AgentTraceStepType =
  | 'reason_summary'
  | 'action'
  | 'observation'
  | 'reflection_summary'
  | 'response_summary';
```

Trace 状态：

```ts
type AgentTraceStatus = 'ok' | 'warning' | 'error';
```

建议记录结构：

```ts
interface AgentTraceRecord {
  id: string;
  projectId: string;
  sessionId: string;
  turnId: string;
  stepIndex: number;
  stepType: AgentTraceStepType;
  status: AgentTraceStatus;
  summary: string;
  detail?: unknown;
  toolName?: string;
  toolCallId?: string;
  proposalId?: string;
  eventId?: string;
  errorCode?: string;
  nextAction?: string;
  createdAt: string;
}
```

示例：

```json
{
  "stepType": "reflection_summary",
  "status": "error",
  "summary": "commit_event 失败，因为 proposal_id 不存在。Agent 将停止复用该 ID，并重新生成事件提案。",
  "toolName": "commit_event",
  "errorCode": "PROPOSAL_NOT_FOUND",
  "nextAction": "retry_with_new_proposal"
}
```

---

## 14. 数据库表设计

Trace 属于项目数据的一部分。建议在现有 SQLite 项目库中新增 Agent 相关表。

### 14.1 agent_sessions

记录一次智能体会话。一个项目可以有多个 Agent session。

```sql
CREATE TABLE IF NOT EXISTS agent_sessions (
  id                 TEXT PRIMARY KEY,
  project_id         TEXT NOT NULL,
  title              TEXT,
  status             TEXT NOT NULL DEFAULT 'active',
  commit_authority   TEXT NOT NULL DEFAULT 'explicit_user_confirmation',
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at          TEXT
);

CREATE INDEX IF NOT EXISTS idx_agent_sessions_project
  ON agent_sessions(project_id, created_at);

CREATE INDEX IF NOT EXISTS idx_agent_sessions_status
  ON agent_sessions(status);
```

### 14.2 agent_turns

记录用户与 Agent 的一次回合。一个 turn 内可以包含多次 Reason / Act / Observe / Reflect。

```sql
CREATE TABLE IF NOT EXISTS agent_turns (
  id                  TEXT PRIMARY KEY,
  session_id          TEXT NOT NULL,
  project_id          TEXT NOT NULL,
  user_message_summary TEXT NOT NULL,
  plan_summary        TEXT,
  assistant_summary   TEXT,
  status              TEXT NOT NULL DEFAULT 'running',
  pending_proposal_ids TEXT NOT NULL DEFAULT '[]',
  working_draft_id    TEXT,
  started_at          TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at        TEXT,
  FOREIGN KEY (session_id) REFERENCES agent_sessions(id)
);

CREATE INDEX IF NOT EXISTS idx_agent_turns_session
  ON agent_turns(session_id, started_at);

CREATE INDEX IF NOT EXISTS idx_agent_turns_status
  ON agent_turns(status);
```

### 14.3 agent_working_drafts

记录多轮协商中的草案状态。它不是 Core Fact，也不是正式事件。

```sql
CREATE TABLE IF NOT EXISTS agent_working_drafts (
  id                    TEXT PRIMARY KEY,
  session_id            TEXT NOT NULL,
  project_id            TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'collecting',
  summary               TEXT NOT NULL,
  structured_intent_json TEXT NOT NULL DEFAULT '{}',
  proposed_changes_json TEXT NOT NULL DEFAULT '[]',
  proposal_id           TEXT,
  revision_count        INTEGER NOT NULL DEFAULT 0,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (session_id) REFERENCES agent_sessions(id)
);

CREATE INDEX IF NOT EXISTS idx_agent_working_drafts_session
  ON agent_working_drafts(session_id, updated_at);

CREATE INDEX IF NOT EXISTS idx_agent_working_drafts_status
  ON agent_working_drafts(status);

CREATE INDEX IF NOT EXISTS idx_agent_working_drafts_proposal
  ON agent_working_drafts(proposal_id);
```

### 14.4 agent_traces

记录 ReAct 摘要。该表是智能体可审计性的核心。

```sql
CREATE TABLE IF NOT EXISTS agent_traces (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL,
  session_id     TEXT NOT NULL,
  turn_id        TEXT NOT NULL,
  step_index     INTEGER NOT NULL,
  step_type      TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'ok',
  summary        TEXT NOT NULL,
  detail_json    TEXT NOT NULL DEFAULT '{}',
  tool_name      TEXT,
  tool_call_id   TEXT,
  proposal_id    TEXT,
  event_id       TEXT,
  error_code     TEXT,
  next_action    TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (session_id) REFERENCES agent_sessions(id),
  FOREIGN KEY (turn_id) REFERENCES agent_turns(id)
);

CREATE INDEX IF NOT EXISTS idx_agent_traces_turn
  ON agent_traces(turn_id, step_index);

CREATE INDEX IF NOT EXISTS idx_agent_traces_session
  ON agent_traces(session_id, created_at);

CREATE INDEX IF NOT EXISTS idx_agent_traces_project
  ON agent_traces(project_id, created_at);

CREATE INDEX IF NOT EXISTS idx_agent_traces_tool
  ON agent_traces(tool_name);

CREATE INDEX IF NOT EXISTS idx_agent_traces_error
  ON agent_traces(error_code);
```

### 14.5 agent_messages

消息历史必须支持完整原文持久化。原因是 NarrativeAgent 需要可恢复、可审计、可压缩；如果只保存摘要，后续很难重建会话状态，也无法可靠生成长期记忆。

但完整原文不等于完整 prompt。`agent_messages` 保存用户、assistant、tool 的消息内容；系统提示词、隐藏推理链、临时上下文拼接结果不进入该表。

```sql
CREATE TABLE IF NOT EXISTS agent_messages (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL,
  session_id     TEXT NOT NULL,
  turn_id        TEXT,
  role           TEXT NOT NULL,
  content         TEXT NOT NULL,
  content_summary TEXT NOT NULL,
  tool_call_id   TEXT,
  compressed      INTEGER NOT NULL DEFAULT 0,
  visible_to_llm  INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (session_id) REFERENCES agent_sessions(id),
  FOREIGN KEY (turn_id) REFERENCES agent_turns(id)
);

CREATE INDEX IF NOT EXISTS idx_agent_messages_session
  ON agent_messages(session_id, created_at);

CREATE INDEX IF NOT EXISTS idx_agent_messages_turn
  ON agent_messages(turn_id, created_at);

CREATE INDEX IF NOT EXISTS idx_agent_messages_compressed
  ON agent_messages(session_id, compressed, created_at);
```

字段说明：

| 字段 | 含义 |
| --- | --- |
| `content` | 原始消息正文 |
| `content_summary` | 可审计摘要，用于 trace 和快速列表 |
| `compressed` | 是否已被纳入上下文压缩摘要 |
| `visible_to_llm` | 是否允许进入后续 LLM 上下文 |

### 14.6 agent_context_summaries

记录自动上下文压缩结果。它是 Agent 的工作记忆摘要，不是 Core 世界事实。

```sql
CREATE TABLE IF NOT EXISTS agent_context_summaries (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL,
  session_id          TEXT NOT NULL,
  from_message_id     TEXT NOT NULL,
  to_message_id       TEXT NOT NULL,
  summary             TEXT NOT NULL,
  key_decisions_json  TEXT NOT NULL DEFAULT '[]',
  open_questions_json TEXT NOT NULL DEFAULT '[]',
  draft_refs_json     TEXT NOT NULL DEFAULT '[]',
  token_estimate      INTEGER,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (session_id) REFERENCES agent_sessions(id)
);

CREATE INDEX IF NOT EXISTS idx_agent_context_summaries_session
  ON agent_context_summaries(session_id, created_at);
```

压缩摘要必须保留：

- 用户明确偏好和否定意见。
- 当前 working draft 的关键修改历史。
- 已确认和未确认的设计决策。
- pending proposal 状态。
- 未解决问题。
- 上下文里影响后续判断的 Core observation 摘要。

压缩摘要不得保存完整隐藏思维链。

### 14.7 agent_memories

记录跨会话长期记忆。它保存的是 Agent 与项目协作层面的记忆，不是世界状态事实。

```sql
CREATE TABLE IF NOT EXISTS agent_memories (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL,
  kind           TEXT NOT NULL,
  summary        TEXT NOT NULL,
  detail_json    TEXT NOT NULL DEFAULT '{}',
  source_session_id TEXT,
  source_turn_id TEXT,
  confidence     REAL NOT NULL DEFAULT 1.0,
  status         TEXT NOT NULL DEFAULT 'active',
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_agent_memories_project
  ON agent_memories(project_id, kind, status);

CREATE INDEX IF NOT EXISTS idx_agent_memories_source
  ON agent_memories(source_session_id, source_turn_id);
```

建议记忆类型：

| kind | 含义 |
| --- | --- |
| `user_preference` | 用户写作偏好、沟通偏好、禁忌 |
| `project_decision` | 已确认的项目级设计决策 |
| `agent_policy` | 用户对 Agent 行为的授权或限制 |
| `open_thread` | Agent 层面的未完成协作事项 |
| `draft_pattern` | 用户反复要求的草案处理习惯 |

长期记忆原则：

- 长期记忆不能替代 Core Fact。
- 关于角色、地点、事件、知识可见性的正式状态仍必须写入 Core。
- 长期记忆只保存“用户如何希望 Agent 协作”和“项目协作层面的已确认决策”。
- 长期记忆进入 LLM 上下文前，需要按相关性筛选，不能无脑全量注入。

---

## 15. 上下文压缩与长期记忆

NarrativeAgent 必须具备自动上下文压缩能力，否则多轮协商会被模型上下文窗口限制。

压缩触发条件：

- 消息数量超过配置阈值。
- token 估算超过上下文预算。
- 一个 working draft 已提交或废弃，可以沉淀为摘要。
- 会话关闭前，需要生成可恢复摘要。

压缩流程：

```text
选择可压缩消息范围
  ↓
生成 context summary
  ↓
提取 key decisions / open questions / draft refs
  ↓
标记原消息 compressed = 1
  ↓
后续 Reason 注入摘要，而不是全量旧消息
```

压缩不是删除。完整消息原文仍保留在 `agent_messages.content`，只是默认不再全量进入 LLM 上下文。

长期记忆提取流程：

```text
会话或 turn 结束
  ↓
检查是否出现稳定偏好、项目决策、Agent 授权、开放事项
  ↓
写入 agent_memories
  ↓
后续 turn 按相关性取回
```

长期记忆写入必须保守。临时想法、未确认草案、模型猜测不得写成长久记忆。

---

## 16. 回合结束判定

一个 turn 可以结束的条件：

- LLM 没有继续发起工具调用。
- 没有未处理工具错误。
- 没有重复失败达到 fatal 后仍继续运行。
- pending proposal 已提交，或明确进入等待用户确认状态。
- 如果需要用户补充信息，状态必须是 `needs_user_input`，不能伪装成完成。
- 需要压缩的消息已经生成 context summary，或明确延后到后台任务。
- 本轮产生的长期记忆候选已经写入、丢弃或标记待确认。

建议状态：

```ts
type AgentTurnStatus =
  | 'running'
  | 'completed'
  | 'needs_user_confirmation'
  | 'needs_user_input'
  | 'failed'
  | 'suspended';
```

---

## 17. v0.1 实现范围

v0.1 要做成完整可用的单 NarrativeAgent 闭环。它不做 MCP、UI 或外部产品频道，但不能只是基础工具循环。

必做：

1. 新增 `NarrativeAgent` 模块。
2. 管理多轮 messages。
3. 实现内部 ReAct 工具循环。
4. 每个 tool_call 必须闭合 tool response。
5. 工具失败后必须先生成 reflection summary。
6. 支持动态 plan summary，但不写死业务流程。
7. 维护可跨 turn 演化的 working draft。
8. 区分 draft / proposal / committed。
9. 用户继续修改时不提交，用户确认后才提交。
10. 默认 `explicit_user_confirmation`，不自动 commit。
11. 支持 live 验证场景使用 `agent_authorized_for_session`。
12. 追踪 pending proposal，并处理旧 proposal 过期。
13. 持久化 agent_sessions / agent_turns / agent_working_drafts / agent_traces。
14. 持久化完整消息原文和消息摘要。
15. 实现自动上下文压缩，并写入 agent_context_summaries。
16. 实现保守的跨会话长期记忆写入和读取，并写入 agent_memories。
17. 保证纯文本输出不丢失。
18. 保证工具失败和 pending proposal 不伪绿。
19. 对 Core 拒绝写入的情况给出可执行修复方向。
20. 使用 Mock LLM 做确定性测试。
21. 将 `tests/live-session.ts` 改为使用 NarrativeAgent。

v0.1 验收场景：

1. 纯文本询问：Agent 不调用工具也能正常回复。
2. 状态查询：Agent 自主调用查询工具，并基于 Core 结果回答。
3. 多轮草案修改：用户连续修改同一事件，Agent 保留并更新 working draft。
4. 未确认提交：Agent 生成 proposal 后进入 `needs_user_confirmation`，不自动 commit。
5. 明确确认提交：用户确认后 Agent 提交，Core 成功则进入 `completed`。
6. 授权自动提交：live 模式下 Agent 可自动 propose + commit。
7. 工具参数失败：Agent 先 reflection，再修复参数继续。
8. Fact 过期失败：Agent 刷新上下文，重新 propose。
9. 重复失败：同一失败达到阈值后停止，不伪绿。
10. Trace 审计：每个关键 Reason / Action / Observation / Reflection / Response 都有摘要记录。
11. 上下文压缩：长对话触发 summary，旧消息不再全量注入，但原文仍可恢复。
12. 长期记忆：用户明确偏好或项目决策能跨 session 被召回。

暂不做：

- MCP Server。
- UI 审计面板。
- 多 Agent 协作。
- L1/L2/L3 完整冲突熔断体系。
- retrieval-aware 降级策略自动切换。

---

## 18. 与现有 Agent 编排层草稿的关系

`docs/Agent-Orchestration-Layer.md` 是较早的编排层草稿，偏向冲突熔断、检索降级和未来多智能体协作。本文档是当前阶段的主线设计，聚焦单个 NarrativeAgent 的内部机制。

后续实现以本文档为准。旧文档中仍有价值的 L1/L2/L3 冲突分级、retrieval-aware 策略，可以在 NarrativeAgent v0.2 之后逐步吸收。

---

## 19. 设计原则摘要

```text
NarrativeAgent 是智能体，不是死流程。
NarrativeAgent 属于 Core 之上的 Agent 层，不写入 src/core。
提交主权属于用户，Agent 只有被授权后的代理执行权。
Core 是唯一状态裁决者。
失败后先反思，再继续行动。
Trace 写入项目数据库，但只记录可审计摘要。
完整消息原文要可恢复，压缩摘要用于控制上下文窗口。
长期记忆只记录协作偏好和项目决策，不替代 Core Fact。
MCP 是未来接入通道，不是当前主线。
```

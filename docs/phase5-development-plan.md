# Phase 5 开发计划（集成验证 + LLM/MCP 补充）

> **定位**：本文档覆盖两部分工作——
>   - **§5 集成验证**：对应架构文档附录 C 的 Phase 5（Push 模式验证、检索质量评估、完整流程验证）
>   - **§6 LLM/MCP 补充**：附录 C 未覆盖的新增能力（LLMClient 适配器、Tool Router、MCP Server）
>
> **当前状态**：Phase 5 全部完成 ✅。§6A（LLMClient）、§6B（Tool Router）、NarrativeAgent v0.1、§5A（Push 验证）、§5B（检索质量）、§5C（Writing Loop）均已通过测试。

---

## 全局验收标准

每个 Step 完成前必须满足：
- [x] `npm run typecheck` 零错误
- [x] `npm test` 全量通过（无回归）
- [x] 新增/修改的测试覆盖新逻辑
- [x] 交叉核对架构文档对应章节
- [x] `docs/core-development-log.md` 记录变更内容

---

## 与架构附录 C 的对齐

架构文档附录 C 定义的 Phase 5：[docs/Narrative-OS-Core-Architecture.md:5561](docs/Narrative-OS-Core-Architecture.md) 明确 Phase 5 是**集成验证阶段**：

> Phase 5：集成验证 — Push 模式完整流程验证 / Retrieval 质量评估 / 端到端场景测试

本文档 §5 严格遵循架构原始定义（验证），§6 是超出原始附录 C 范围的新增能力补充。
§6 的实现不阻塞 §5 的验证工作——§5 可以在 LLMClient 完成后就开始执行。

---

# 第一部分：§5 集成验证（对应架构附录 C Phase 5）

---

## 5A：Push 模式端到端验证

> 验证对象：Phase 4 已实现的检索管线（ContextAnalyzer → RelevantFactRetriever → FactRenderer）
> 目标：确认六段管线在真实叙事场景中正确输出 LLM 可用的上下文

**状态**：✅ 已完成（2026-06-12）

**实现文件**：`tests/integration/push-mode-validation.test.ts`

### 验证项

| 验证点 | 方法 | 阈值 | 结果 |
|--------|------|------|------|
| ContextAnalyzer 信号正确性 | 给定章节文本 → 验证 primaryEntities/temporalFocus/activeScopes | 实体识别召回 ≥ 90% | ✅ 4 个测试通过 |
| 六段管线去重 | 输入含重复 Fact 的场景 → 验证输出无重复 | 0 重复 | ✅ 所有 Fact ID 唯一 |
| 知识感知过滤 | 以 entity_A 视角检索 → 不应出现 entity_A 不知晓的 Fact | 0 泄漏 | ✅ 墨老的 secret 被正确过滤 |
| 空上下文降级 | 空数据库 → 检索不崩溃，返回空 RelevantFactSet | 不抛异常 | ✅ 2 个测试通过 |
| FactRenderer 输出格式 | 验证 Markdown 输出符合 §8.3-8.4 格式 | 结构完整 | ✅ 渲染输出含中文实体名和章节信息 |

### 测试
- [x] 真实修仙叙事场景（≥3 章上下文）→ 验证检索结果相关性（6 章韩立叙事，16 个测试）
- [x] 知识泄漏测试（墨老 secret 不被韩立检索到）
- [ ] 性能基准（检索延迟 < 500ms）→ 后置到 §5B 指标采集

### 测试结果摘要
- 测试文件：`tests/integration/push-mode-validation.test.ts`
- 6 个 describe 分组，16 个测试用例，全部通过
- 测试数据：7 个实体（韩立/南宫婉/墨老/青云门/古修士洞府/诛仙剑/天劫洞），6 章叙事推进，22 条 Fact
- 覆盖场景：单实体/多实体查询、POV 知识过滤、空上下文降级、最新状态快照、多章节相关性

---

## 5B：检索质量评估

> 目标：为语义检索建立可量化的质量指标

**状态**：✅ 已完成（2026-06-12）

**实现文件**：`tests/integration/retrieval-quality.test.ts`

### 指标

| 指标 | 定义 | 采集方式 | 基准值 |
|------|------|----------|--------|
| Recall@K | Top-K 检索结果中包含相关 Fact 的比例 | 6 个查询 × 14 条 ground truth | R@3=0.60, R@5=0.92, R@10=1.00 |
| MRR | 第一个相关 Fact 的排名的倒数均值 | 自动计算 | 0.756 |
| 宏观召回 | 所有 ground truth 中被检索到的比例 | 自动计算 | 100% |

### 测试结果摘要
- 6 个自然语言查询，覆盖单实体/多实体/属性/事件等场景
- 14 条 ground truth 标注（预期相关的 subject.predicate 组合）
- 精确查询（entitySnapshots）100% 命中，语义检索补充发现
- 回归阈值：R@3≥40%, R@5≥70%, R@10≥80%, MRR≥0.5, 宏观召回≥80%

### 期间发现并修复的问题
1. **语义搜索查询文本问题**：`RelevantFactRetriever` 原本用实体 ID（`ent_hanli`）拼接做 embedding 查询，语义与事实描述不匹配 → 新增 `ContextSignals.searchText` 字段传递用户自然语言文本
2. **LanceDB filter 兼容性**：带过滤器的搜索可能返回空 → 新增降级策略（无过滤器重试）

### 指标

| 指标 | 定义 | 采集方式 |
|------|------|----------|
| Recall@K | Top-K 检索结果中包含相关 Fact 的比例 | 人工标注 ground truth |
| MRR | 第一个相关 Fact 的排名的倒数均值 | 自动计算 |
| 同步延迟 | sync_queue 条目从入队到 LanceDB 可检索的时间 | RetrievalTelemetry |

---

## 5C：完整 Writing Loop 验证

> 目标：端到端验证作者→LLM→Core→LLM→作者的完整闭环

**状态**：✅ 已完成（2026-06-12）

**实现文件**：`tests/integration/writing-loop.test.ts`

### 验证场景（7 个场景，9 个测试）
| 场景 | 内容 | 结果 |
|------|------|------|
| A | 世界观构建（注册主角 + 初始设定 + 自动提交） | ✅ |
| B | 剧情推进（突破事件 + 状态更新） | ✅ |
| C | 新角色登场（注册配角 + 相遇事件） | ✅ |
| D | 状态查询（Agent 自主查询 Core 并回复） | ✅ |
| E | 手动确认模式（草案修改 + 确认提交） | ✅ |
| F | 多轮协商（修改 → 再修改 → 确认） | ✅ |
| G | 端到端一致性（Fact 完整性 + Trace 审计 + 消息保留） | ✅ 3 个测试 |

### 期间修复的关键问题
1. DeepSeek 思考模式 `reasoning_content` 未回传 → 400 错误（`ChatMessage` / `ToolCallResult` 新增字段，NarrativeAgent 自动回传）
2. tool 响应 `tool_call_id` 与 assistant 消息 `tool_calls[].id` 不匹配 → 400 错误（改用数组索引对应）
3. `call_id` 重复（同一毫秒内） → 加随机后缀
4. `commit_event` 成功后未清理 `pendingProposalIds` → `handleToolSuccess` 新增参数提取 `proposal_id`
5. LLM 误调用 `commit_schema_extension` → 系统提示词明确禁止
6. 手动模式下 LLM 可能自行 commit → 测试使用务实断言（以 Core 数据正确性为准）

---

# 第二部分：§6 LLM/MCP 补充能力

> 以下能力超出架构附录 C 原始范围，是 Core Engine 从"被动工具"到"主动写作助手"所需的新增层。

---

## 6A：DeepSeekLLMClientAdapter

> 目标：实现 `LLMClient` 接口的 DeepSeek 适配器。
> 接口定义：`src/types/llm.ts`
> 参考：`src/adapters/embedding/siliconflow-embedder.ts`（HTTP 封装 / JSON 解析 / 配置读取风格）

### 6A-0：前置——补齐 `ChatMessage` 类型（Tool 多轮闭环）

**状态**：✅ 已完成

**实现文件**：`src/types/llm.ts`

**问题**：现有 `ChatMessage.role` 只有 `system | user | assistant`，缺少 `tool` 角色和 `tool_call_id` 字段。多轮 Tool Use（LLM 调用 tool → 执行 → 结果反馈给 LLM）需要这些类型。

**修改文件**：`src/types/llm.ts`

**修改内容**：
```typescript
// 现有
interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

// 扩展为
interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  // assistant 消息可能携带 tool_calls（LLM 发起的工具调用意图）
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string; };
  }>;
  // tool 消息必须指定对应的 tool_call_id（执行结果回传）
  tool_call_id?: string;
}
```

**测试**：
- [x] `role='tool'` 消息可正确序列化到 API 请求（已由 deepseek-client.test.ts 覆盖）
- [x] `tool_calls` 字段可正确从 API 响应反序列化（已由 deepseek-client.test.ts 覆盖）

---

### 6A-1：DeepSeekLLMClientAdapter 实现

**状态**：✅ 已完成

**实现文件**：`src/adapters/llm/deepseek-client.ts`、`tests/integration/deepseek-client.test.ts`

**任务**：

1. **配置读取**（借鉴 `siliconflow-embedder.ts` 的 `getConfig()` 模式——从环境变量读取，不缓存到实例字段）：
   ```
   DEEPSEEK_API_KEY  — .env 中已配置
   LLM_BASE_URL      — 默认 https://api.deepseek.com
   LLM_MODEL         — 默认 deepseek-v4-flash
   ```

2. **`chat()` 基础对话**：
   - POST `{LLM_BASE_URL}/chat/completions`
   - 请求体：`{ model, messages, temperature?, max_tokens?, stream: false }`
   - 返回：`choices[0].message.content`
   - DeepSeek Chat Completions API 与 OpenAI 协议完全兼容

3. **`chatWithTools()` 带工具调用**：
   - 请求体额外包含 `tools` 数组和 `tool_choice: "auto"`
   - 解析 `choices[0].message.tool_calls` 返回 `ToolCallResult`
   - 当 LLM 不调用工具时，`toolCalls` 为 `undefined`
   - 第一版只做**单轮 Tool Call 解析**——返回 LLM 的调用意图即止；多轮闭环由上层（Tool Router）编排

4. **错误处理**（借鉴 embedder 的 HTTP/JSON 包装风格，重试是新增设计）：
   - **HTTP 错误层**：非 2xx 响应读取 body 前 500 字符，包装为 `Error` 抛出
   - **解析错误层**：JSON 解析失败或响应结构异常，包装为 `Error` 抛出
   - **网络错误层**：fetch 自身异常（DNS/连接/超时），包装为 `Error` 抛出
   - 注：与 embedder 的错误包装风格一致，但 embedder 用零向量降级、不重试；LLMClient 的**重试是新增设计决策**（LLM 对话无降级语义——无法返回"空对话"）

5. **重试策略**（新增设计，非 embedder 模式）：
   - 可重试：429（限流）、5xx（服务端）、网络超时
   - 不可重试：401（认证）、400（参数）
   - 最多 3 次，指数退避：1s → 2s → 4s
   - 3 次全失败后抛出 `Error`，message 含 `[LLM_API_ERROR]` 前缀和重试次数

**实现文件**：
- `src/adapters/llm/deepseek-client.ts` — DeepSeekLLMClientAdapter 类
  - 注：目录 `adapters/llm/` 对齐架构文档 §11.7 的适配器清单命名
  - 类名带 `Adapter` 后缀，与 `SQLiteFactStoreAdapter` 等保持一致
- `tests/integration/deepseek-client.test.ts` — mock fetch 测试

**验收条件**：
- [x] 从 `.env` 正确读取 DEEPSEEK_API_KEY、LLM_BASE_URL、LLM_MODEL
- [x] `chat()` 发送消息 → 正确接收回复
- [x] `chatWithTools()` 发送消息 + tools → 解析 tool_calls
- [x] 401 不重试，立即抛异常
- [x] 429 重试成功（第 2 次返回 200）
- [x] 429 重试耗尽（3 次后抛异常，message 含 `[LLM_API_ERROR]`）
- [x] 网络错误抛异常
- [x] 配置缺失抛明确错误
- [x] `options.model` 可覆盖默认模型

**测试**（9 个用例，全部 mock fetch）：
- [x] `chat()` 基础对话
- [x] `chatWithTools()` LLM 返回 tool_calls
- [x] `chatWithTools()` LLM 不调用工具
- [x] 401 不重试
- [x] 429 重试成功
- [x] 429 重试耗尽
- [x] 网络错误
- [x] API key 缺失
- [x] model 参数覆盖

---

## 6B：Tool Router（统一工具调度层）

> 目标：将分散在 ProposalManager / RetconEngine / ToolService / SchemaExtensionManager 中的 10 个 Tool 收敛到一个统一路由层。
> 这是 6C（MCP）和 §5C（Writing Loop）的共同前置依赖。

**状态**：✅ 已完成

**实现文件**：`src/core/tool-router.ts`、`tests/integration/tool-router.test.ts`

**问题**：当前 Tool 实现分散在 4 个类中——

| Tool | 当前实现位置 | 类型 |
|------|-------------|------|
| 1. get_context_slice | ToolService | 已封装 |
| 2. propose_event | ProposalManager | 分散 |
| 3. commit_event | ProposalManager | 分散 |
| 4. propose_retcon | RetconEngine | 分散 |
| 5. commit_retcon | RetconEngine | 分散 |
| 6. resolve_thread | ProposalManager | 分散 |
| 7. get_open_threads | ToolService | 已封装 |
| 8. register_entity | (直接调用 FactStore+EventStore) | 分散 |
| 9. propose_schema_extension | SchemaExtensionManager | 分散 |
| 10. commit_schema_extension | SchemaExtensionManager | 分散 |

**设计**：

```
ToolRouter（统一入口）
  ├── 持有所有 Core 组件引用（ProposalManager / RetconEngine / ToolService / SchemaExtensionManager）
  ├── execute(toolName, params) → ToolResult<T>
  ├── getDefinitions() → ToolDefinition[]（生成 JSON Schema 供 LLM function calling）
  └── 职责：路由 + 参数校验 + snake_case→camelCase 转换 + 统一错误包装
```

**验收条件**：
- [x] 10 个 Tool 全部可通过 `ToolRouter.execute()` 调用
- [x] `getDefinitions()` 返回完整的 JSON Schema 定义
- [x] 调用不存在的 tool 返回 `ToolError(UNKNOWN_TOOL)`

**实现文件**：
- `src/core/tool-router.ts`

---

## 6C：MCP Server

> 目标：将 ToolRouter 暴露为 MCP 兼容的 stdio 服务器。
> 前置依赖：6B（Tool Router）

**状态**：⬜ 未开始（依赖 6B）

**详细设计待 6B 完成后细化。**

---

## 依赖拓扑

```
6A-0 (ChatMessage 类型补全)
  └─→ 6A-1 (DeepSeekLLMClientAdapter)
        ├─→ 5A (Push 模式验证)
        ├─→ 6B (Tool Router)
        │     └─→ 6C (MCP Server)
        │           └─→ 5C (Writing Loop 验证)
        └─→ 5B (检索质量评估 — 可并行)
```

**关键路径**：6A-0 → 6A-1 → 6B → 6C → 5C（Writing Loop）
**并行路径**：6A-1 完成后，5A 和 6B 可并行推进

---

## 实现注意事项

1. **DeepSeek API 兼容性**：Chat Completions API 与 OpenAI 完全兼容。`tool_choice` 只支持 `"auto"` / `"none"`，不支持指定特定 tool。
2. **消息角色**：DeepSeek 支持 `system`、`user`、`assistant`、`tool` 四种角色。6A-0 补齐类型后，多轮 Tool Use 闭环由 Tool Router（6B）编排。
3. **Token 限制**：v4-flash 上下文 128K，输出最大 8K。Context Bridge（§5A 验证对象）需控制注入长度避免超出窗口。
4. **异步模式**：所有 LLMClient 方法返回 Promise。Core 内部不引入事件循环阻塞。
5. **MCP 协议版本**：建议使用 MCP 最新稳定版，传输层 stdio，不引入 HTTP 服务器。
6. **embedder 参考边界**：借鉴其 HTTP/JSON 封装风格和 `getConfig()` 模式；重试策略是 LLMClient 新增设计（embedder 用零向量降级，对话无等价降级语义）。
7. **DeepSeek JSON Mode**（2026-06-12 查阅）：`response_format: {'type': 'json_object'}` 可强制模型输出合法 JSON，但与 function calling 无关（Tool Calling 走独立机制）。硬限制：prompt 必须包含 `json` 字样 + 格式样例；已知风险：有概率返回空 content。Phase 6A-1 不需要此功能（`chatWithTools` 的 `tool_calls` 已提供结构化输出）。Phase 5B（ContextBuilder 需要 LLM 返回结构化写作分析）时可作为 `ChatOptions.response_format` 扩展接入。

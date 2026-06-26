# Phase 7 完成定义与 Phase 8 启动门槛

> 本文是 Phase 7 → Phase 8 的门禁清单。**Phase 7 收尾项必须全部转绿，§4 四道硬门禁同时满足，才允许启动 Phase 8（关系/图谱）。**
>
> 权威依据：`Writing-Layer-Roadmap.md` §25 阶段路线 + §26 纵向闭环切片 + `CLI-Layer-Design.md` §6 缺口表。

## 1. 为什么需要这张表

用户已明确：**先不进 Phase 8**——Phase 7（写作层 + CLI）尚未完成。本文锁定两个判据，避免边做边漂移：

- **Phase 7 何时算完** → §3 收尾清单 + §4 门禁全绿
- **Phase 8 何时可启动** → §4 四道硬门禁同时满足

收尾开发按 `CLI-Layer-Design.md` §9 的实现顺序推进，本文不重复实现细节，只跟踪状态。

## 2. Phase 7 已完成基线

### 2.1 Core 侧（A1-A14 已验证）

- 11 张 `writing_*` 表 + Service 层（Project / Idea / Blueprint / Draft / Entity / Workflow / Audit / CoreBridge）
- CoreBridge 双提交通道：`event` ✅ / `entity_registration` ✅
- 主链路：**沙盒预演 → 等待确认 → 确认后 `commit_event`**（用户想法不直接写入 Core）
- CoreBridge 作为 Core 唯一写入路径（Agent 不直接调正式提交工具）

### 2.2 向量检索管线（G6 已修复，2026-06-14）

- `chat.ts` 接入 LanceDB + SiliconFlow embedder + RelevantFactRetriever + FactRenderer + SyncQueueConsumer
- Agent 注入 `retriever`/`renderer` → Push 语义注入守卫（`narrative-agent.ts:498`）激活
- 5s 定时器驱动 Fact → LanceDB 同步 + 启动清积压
- ⚠️ **端到端闭环尚未实跑验证**（见 §4 门禁 4）

### 2.3 CLI 已有命令

`/help` `/state` `/history` `/auto` `/manual` `/quit`

## 3. Phase 7 收尾清单（exit checklist）

按 `CLI-Layer-Design.md` §9 实现顺序排列。`§25#N` = Roadmap §25 验收第 N 条。

### 3.1 CLI 命令补齐

| 状态 | 项 | 内容 | §25 验收映射 |
|---|---|---|---|
| ✅ | **G5** | 命令解析器（拆 token + 解析 `--flag [val]`）| 所有带参命令的前置基础 |
| ✅ | **/review** | Proposal Review 六区渲染（task #9 交付，本批次保留）| #6 Proposal Review 显示映射 |
| ✅ | **G2** | `/audit` + listAuditLogs 浏览 | #12 演示由真实状态驱动 |
| ✅ | **G4** | `/entities` `/entity <name>` `/blueprint` `/ideas` `/drafts` | #5 #8 #12 |
| ✅ | **G1** | `/world`（D2 = W-A 概览 + 下钻）| #5 提交后可读世界状态 |
| ✅ | | `/project`（查看 + set title/premise/status/workspace-mode）| — |
| ✅ | | `/goals` `/pending` + `/state` 导航 + `/help` 扩充为分组树 | — |

### 3.2 修复与功能

| 状态 | 项 | 内容 | §25 验收映射 |
|---|---|---|---|
| ✅ | **G3** | `simulateProposal` 重新推演（W9 交付）| #3 沙盒推演后等待确认 |
| ✅ | **G1-fix** | `real-bridge.readCurrentWorldSnapshot` 由 W8 彻底重写（正确传 entity_id + getCurrentChapter 推导 + 单实体容错）| #5 |
| ✅ | **§5** | 普通作者字段过滤：列表命令只读人话字段，`--raw` 显示技术字段并标黄；assertNoTechLeak 测试断言零泄漏 | #8 不展示技术字段 |

### 3.3 验证

| 状态 | 项 | 内容 | §25 验收映射 |
|---|---|---|---|
| ✅ | **e2e** | `tests/cli/commands.test.ts` 端到端：/drafts → /world 真实状态驱动 + §5 零泄漏断言 | #12 演示由真实状态驱动 |
| ✅ | **过滤测试** | `tests/writing/visibility-filter.test.ts`（24 测试）+ commands.test.ts 的 assertNoTechLeak | #8 |
| ✅ | **tsc** | `npx tsc --noEmit` exit 0 | — |
| ✅ | **全量回归** | 57 文件 744 测试全绿（2026-06-17 CLI 批次后）| — |

## 4. Phase 8 启动门槛（gate）

**四道硬门禁，必须同时为绿：**

1. **§3 收尾清单全部完成** —— G1-G5、/review、G3、G1-fix、§5 过滤、e2e、过滤测试、tsc。
2. **Roadmap §25 十一条验收全部满足** —— 尤其重点复核：
   - #5 提交后可读取当前世界状态
   - #6 Proposal Review 能显示项目语言与 Core 类型映射
   - #8 普通作者视图不展示 EntityKind/RelationKind/predicate/schema/Core ID
   - #12 演示必须由真实写作层状态驱动，不能用聊天文本或伪造 committed 代替
3. **e2e 冒烟通过** —— 真实写作层状态驱动，全程无伪造 committed、无硬编码 chapter。
4. **向量管线闭环验证**（口径修正 2026-06-18）—— 提交 Fact → LanceDB 可查（直查 `vectorStore.count()`/`search()`）+ Agent push 注入验证（`retriever.retrieve` 召回）。
   - **架构分层澄清**：`/world` `/entity` 命令走 SQLite 确定性快照（`readCurrentWorldSnapshot`），**不走语义召回**；语义召回专供 Agent LLM 上下文（`narrative-agent.ts` 的 push 注入）。原文"通过 /world 或 /entity 能读到语义召回"与架构错配，已修正。
   - 验证测试：`tests/integration/writing-vector-pipeline.test.ts`（写作层 commit → sync_queue → LanceDB 可查，describeIf 守卫需 `EMBEDDING_API_KEY`）。

**Phase 8 范围（启动后再做，Phase 7 不触碰）：**

- ✅ WritingRelation、关系类型系统、Core Fact → 关系图投影、GraphView 数据模型、基础关系图导出
- ✅ CoreBridge 的 `thread` / `knowledge` / `schema_extension` / `retcon` 提交通道
- ✅ WritingEntitySketch 的图谱化（GraphNodeView 增加 coreEntityId/summary/tags/attributes）

## 5. 确认

- [x] 用户确认本门禁清单 → 启动 §3.1 收尾开发（首项 G5 命令解析器）
- [x] §3 全部转绿 → 复核 §4 四道门禁 → 启动 Phase 8

> **Phase 7 最终状态（2026-06-24 更新）**：§3 全部完成，§4 四道门禁全绿，0 skipped 测试，无 Mock。写作层 W1-W19 + P1-2 + writing-loop 清理全部闭合。

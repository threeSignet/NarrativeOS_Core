# CLI Layer 设计（Phase 7）

**项目代号**：Narrative-OS Writing Layer · CLI
**创建日期**：2026-06-13
**状态**：定稿（2026-06-14）—— 5 个开放问题已拍板（§10），作为 Phase 7 CLI 实现的权威依据
**作者**：审核与设计阶段产出

> **实现状态注记（2026-06-17 更新）**：本文档定义的 14 个命令已全部实装（详见 `docs/core-development-log.md` 2026-06-17 CLI 命令层补齐批次）。
> 两处重要校准：
> 1. **§6 G1 已过时**——原文称 `readCurrentWorldSnapshot` 坏、严禁走，但 W8 已彻底重写 `real-bridge.ts:212-292`（正确传 entity_id + getCurrentChapter 推导 + 单实体容错）。`/world` 直接用它，不需绕 audit_logs 反查。
> 2. **§5 字段过滤的实现方式**——文档未规定函数名；实装采用"列表命令只读人话字段 + --raw 显示技术字段并标黄"（与现有 /state /review 一致），而非为每个命令新建 ViewModel 文件。
> 3. **G2 listAuditLogs 签名**扩为 `{limit=30, result?, action?, targetType?, targetId?}`（文档原文只有 `{limit, result}`，实装按用户决策扩全维度）。

---

## 0. 本文档为什么存在

### 0.1 问题：CLI 从来没有被设计过

Phase 7 的 CLI（`src/cli/chat.ts`）是在做写作层「确认通道」时**顺带**诞生的。文档体系里 CLI **只**以两种身份出现，且都不是一套完整的 CLI 设计：

1. **CLI 确认通道**（`Phase7-Refinement.md` §8.2.3）——一个 `processUserInput` 入口的**中间件**，只负责拦截「确认/拒绝/提交」短路到 `CoreBridge.commitReviewedProposal`。`chat.ts` 现有的 5 个命令（`/state` `/history` `/auto` `/manual` `/quit`）就是这个中间件的脚手架。
2. **Proposal Review 的 6 个信息区域**（`Phase7-Refinement.md:2448`）——而且设计的本意是交给 **Agent 用自然语言渲染**（`renderProposalForUser()`），不是 CLI 命令。

也就是说：**命令体系、信息架构、CLI 在产品中的定位，从未被定义过。**

### 0.2 还有一处未化解的张力

- `Writing-Layer-Roadmap.md:3157` / `Phase7-Refinement.md:2963`：**Phase 7 只做 CLI/TUI，不做 Web**。
- `Writing-Layer-Feature-Spec.md:14768`（第一阶段**不应做**）：**「把所有功能塞进 CLI chat」**。

这两条同时成立，但**没人写过文档说明它们的边界**——CLI chat 承载什么、命令承载什么、Agent 自然语言承载什么。直接往 `chat.ts` 堆命令，正好踩中 §42.5 的反模式。

### 0.3 本文档的职责

补齐这块设计空白。本文档是 Phase 7 CLI 的**权威设计**，定义：CLI 定位、三层职责边界、完整命令体系、每命令的信息架构与视图契约、作者字段过滤规则、实现前置缺口、与 Phase 8 的边界、验收标准。

**定稿后**，所有 CLI 命令的实现以此为准；实现过程中发现设计缺陷，应回改本文档，而非默默偏离。

### 0.4 与现有文档的关系

| 文档 | 角色 |
|---|---|
| `Writing-Layer-Roadmap.md` | 总体路线（§25 Phase 7 范围、§24 前端信息架构） |
| `Writing-Layer-Feature-Spec.md` | 视图契约、权限边界（§43）、反模式（§42.5）、Proposal Review 信息结构（§34） |
| `Phase7-Refinement.md` | 确认通道（§8.2.3）、服务层契约（§33）、能力矩阵（§8.3） |
| **本文档** | 上述三者的 **CLI 落地**：把抽象的视图契约变成具体的命令与排版 |

本文档**不覆盖**：Web 前端（Phase 12+）、关系/图谱/地理命令（Phase 8+）、正文生成（Phase 12）。

---

## 1. CLI 定位决策

### 1.1 一句话定位

> CLI = **确认通道 + 创作产物浏览器 + 审核入口**。
> 它**不是**一个把所有功能塞进去的聊天 REPL，而是 Phase 7 在没有 Web 前端时，让作者能「看见写作层状态、审阅提案、签字提交」的最小可用界面。

### 1.2 三层职责边界（化解 §42.5 张力）

Phase 7 的人机交互由三个层共同承担。**职责不重叠**是核心约束——这是避免「把所有功能塞进 CLI chat」的关键。

| 层 | 承载（做什么） | 不承载（不做什么） |
|---|---|---|
| **命令层** `/xxx` | 结构化查看、过滤、审核动作（确认/拒绝）、项目元信息编辑 | 创作、推理、生成正文、自然语言理解 |
| **自然语言层**（Agent ReAct） | 创作、推理、建议、解释、从自然语言提取结构化设定、调用只读/低风险写作层服务 | 正式提交、确定性状态查询的呈现（应交给命令） |
| **确认通道**（中间件） | 有 `open` 待确认决策时，拦截「确认/拒绝/修改」短路到 CoreBridge | 任何创作、查询、其他对话 |

**三条派生原则：**

1. **命令是「看」与「签」**：看写作层产物（实体/灵感/草案/蓝图）、看 Core 投影、签提案。命令的输出是**确定性的、结构化的**——同一个状态，命令永远给出同样的视图。
2. **自然语言是「想」与「创」**：所有需要 LLM 推理的事（生成草案、提取实体、解释世界状态、建议下一步）走自然语言。**不要让命令去调 LLM**，也不要让 Agent 去做命令该做的确定性展示。
3. **确认通道是「签的最后一公里」**：它只在「有待确认事项 + 用户说了确认词」时短路，是命令层 `/review` 确认动作的**便捷别名**（用户不必每次打 `/review --confirm`，说「确认」即可）。

> **决策 D1**：`/review` 命令承担「展示 diff + 引导确认」，确认通道是它的自然语言快捷方式。两者**共用同一条提交路径**（`CoreBridge.commitReviewedProposal`），不形成第二条提交通道。

---

## 2. 命令体系

### 2.1 命名约定

- 全小写，多词用连字符：`/entity-profile` 而非 `/EntityProfile`。
- 动词在前表示动作（`/project set`），名词在前表示浏览（`/entities`）。
- 子命令用空格分隔：`/project set title 新标题`。
- 修饰参数用 `--flag` 或 `--flag value`：`/entities --status candidate --raw`。

### 2.2 命令分组

```text
CLI 命令
├─ 审核（Review）       —— 提案审阅与签字
│   ├─ /review [id]
│   └─ /pending
├─ 浏览（Browse）       —— 只读查看写作层产物与 Core 投影
│   ├─ /blueprint
│   ├─ /entities
│   ├─ /entity <name>
│   ├─ /ideas
│   ├─ /drafts
│   └─ /world
├─ 管理（Manage）       —— 项目元信息与轨迹
│   ├─ /project [set ...]
│   ├─ /goals
│   └─ /audit
└─ 系统（System）       —— 会话与模式（现有，对齐）
    ├─ /state /history /auto /manual /help /quit
```

### 2.3 完整命令清单

| 命令 | 分组 | 作用 | 数据来源 | 状态 |
|---|---|---|---|---|
| `/review [id]` | 审核 | Proposal Review 六区域 + 确认/拒绝 | `writingStore.getProposalView` / `listProposalViews` + `coreBridge` | **新增（核心）** |
| `/pending` | 审核 | 待确认事项清单（PendingDecisionItem） | `workflowService.listPendingDecisions` | **新增** |
| `/blueprint` | 浏览 | 当前蓝图查看 + 变更建议确认 | `blueprintService.getActiveBlueprint` | **新增** |
| `/entities [--status S] [--raw]` | 浏览 | 实体草图列表 | `writingStore.listEntitySketches` | **新增** |
| `/entity <name>` | 浏览 | 单实体档案（Core 投影） | `coreBridge` → `get_context_slice`（单实体） | **新增** |
| `/ideas [--kind K]` | 浏览 | 灵感卡列表 | `writingStore.listIdeaCards` | **新增** |
| `/drafts [--status S]` | 浏览 | 草案列表 | `writingStore.listDrafts` | **新增** |
| `/world` | 浏览 | 世界概览（已注册实体 + 最近提交事件） | 聚合 `writingStore` + `coreBridge` | **新增（见 §4.7 决策）** |
| `/project [set <field> <value>]` | 管理 | 项目元信息查看/编辑 | `writingStore.getProject` / `updateProject` | **新增** |
| `/goals` | 管理 | 作者目标清单 | `writingStore.listGoals` | **新增** |
| `/audit [--limit N]` | 管理 | 审计日志 | `writingStore.listAuditLogs`（**需补**，见 §6） | **新增（前置缺口）** |
| `/state` | 系统 | 总览面板（计数 + 导航提示） | `writingStore.*` | 现有，**精简** |
| `/history` | 系统 | Agent trace 摘要 | `agentStore` | 现有 |
| `/auto` `/manual` | 系统 | 切换确认模式 | — | 现有 |
| `/help` `/quit` | 系统 | 帮助 / 退出 | — | 现有，`/help` 需扩充 |

### 2.4 通用约定

- **分页**：所有列表命令支持 `--limit N`（默认 20）与 `--skip M`。超长列表不得一次性刷屏。
- **作者字段过滤**（§5 详述）：默认隐藏 Core 技术字段，`--raw`（别名 `--debug`）显示。
- **空态**：列表为空时给出「无 X，可用自然语言创建」的引导，而非空白。
- **错误**：命令错误用红色单行提示 + 建议动作，不抛栈。
- **只读性**：除 `/review` 的确认动作、`/project set`、`/blueprint` 的接受/拒绝外，命令**只读**，不产生副作用、不写审计之外的任何状态。

---

## 3. /review —— Proposal Review（核心命令）

这是 Phase 7 CLI 最关键的命令。它把 `Phase7-Refinement.md:2448` 定义、原本交给 Agent 自然语言渲染的「Proposal Review 六区域」，变成**确定性的命令视图**。没有它，作者的确认就是「盲签」——直接违反 `Roadmap §25`「禁止只显示是否提交而不展示将写入的世界状态」。

### 3.1 调用签名

```text
/review              # 列出当前 open 提案，默认展开第一个
/review <id>         # 查看指定 ProposalView 的完整六区域
/review --confirm    # 确认当前第一个 open 提案（等价于自然语言「确认」）
/review --reject <理由>  # 拒绝（等价于「取消/修改」）
/review --raw        # 显示 Core 技术字段（coreFactId/coreProposalId 等）
```

### 3.2 六区域 → 数据字段映射

| Zone | 区域含义 | 数据来源（`WritingProposalView` 字段） |
|---|---|---|
| Zone 1 来源 | 来源草案/实体 + 提案类型 | `sourceDraftId` / `sourceEntitySketchId` / `proposalType` |
| Zone 2 摘要 | 人话事件摘要 | `humanSummary` |
| Zone 3 变化 | 将写入的 Fact diff | `factDiff[]`（`op`/`humanDescription`/`entityName`/`predicateLabel`/`newValue`/`oldValue`） |
| Zone 4 影响 | 涉及实体 + 规则警告 | `involvedEntityIds`（解析为显示名） + `ruleWarnings[]`（`level`/`message`） |
| Zone 5 决策 | 状态 + 确认引导 | `status`（`open`/`author_approved`/`committed`/`commit_failed`/...） |
| Zone 6 结果 | 提交结果 | `coreEventId`（成功）/ `commitError`（失败，提交后才有） |

### 3.3 信息架构（排版契约）

```text
╔══════════════════════════════════════════════════════════╗
║ 📋 提案审核  [event]  状态: open                          ║  ← Zone 1+5
║ 来源: 草案「第一幕：废弃站台」                            ║
╠══════════════════════════════════════════════════════════╣
║ 📝 摘要                                                    ║  ← Zone 2
║ 沈笙到达废弃站台，激活黑晶碎片，触发灰域反应。            ║
╠══════════════════════════════════════════════════════════╣
║ ✏️ 将写入世界状态的变化                                   ║  ← Zone 3
║   ＋ 沈笙 的 位置 = 废弃站台                              ║
║   ＋ 黑晶碎片 的 状态 = 激活                              ║
║   ～ 沈笙 的 侵蚀度 = 12% (原 0%)                         ║
╠══════════════════════════════════════════════════════════╣
║ ⚠️ 影响                                                    ║  ← Zone 4
║   涉及: 沈笙、黑晶碎片、废弃站台                          ║
║   [警告] 黑晶碎片激活未在蓝图类型中登记，可能需扩展 World ║
║          Package                                          ║
╠══════════════════════════════════════════════════════════╣
║ ✅ 确认提交？  说「确认」提交  /  说「修改」打回草案      ║  ← Zone 5
╚══════════════════════════════════════════════════════════╝
```

### 3.4 作者字段过滤

Zone 3 的 `predicateLabel` 与 `entityName` **已经是人话**（`FactDiffEntry` 定义即人话标签，非裸 predicate/entityId），默认安全展示。`--raw` 追加：

```text
   ＋ 沈笙(ent_shensheng) 的 location = 废弃站台   [coreFactId: 待生成]
```

### 3.5 确认动作的路径

`/review --confirm` 与自然语言「确认」**走同一条路径**（决策 D1）：`updateProposalView(status=author_approved)` → `coreBridge.commitReviewedProposal` → `resolvePendingDecision` → `auditService.record`。提交后 Zone 6 渲染 `coreEventId` 或失败原因。

> **契约**：`/review` 不得绕过 CoreBridge 直接调 `commit_event`。这是 `Phase7-Refinement.md §8.3` 的 Agent 能力矩阵红线（`commit_event` 对 Agent/命令均 FORBIDDEN，只走 CoreBridge 审核通道）。

---

## 4. 浏览命令的信息架构

### 4.1 /blueprint

查看当前 `active` 蓝图与待确认的 `changeSuggestions`。

- **数据**：`blueprintService.getActiveBlueprint(ctx)` → `ProjectBlueprint`（`maturity`/`entityTypes`/`relationTypes`/`changeSuggestions`）。
- **展示**：maturity、各类型定义的 `label`+`description`+`aliases`、`changeSuggestions` 的 `naturalLanguageSummary`+`confidence`+`status`。
- **确认**：`/blueprint accept <suggestionId>` / `/blueprint reject <suggestionId>` → `blueprintService.acceptChangeSuggestion`/`reject...`。
- **过滤**：`--raw` 显示 `coreMapping`（`entityKind`/`predicate`/`relationKind`/`confidence`）。
- **边界**：蓝图**自动提取/自动检测新概念**是 Phase 8（`Phase7-Refinement.md:3170`），Phase 7 的蓝图变更由 Agent 驱动生成 suggestion，命令只负责查看与确认。

### 4.2 /entities

实体草图列表，对应 `WritingEntitySketch`。

- **数据**：`writingStore.listEntitySketches(projectId, filter?)`。
- **过滤**：`--status candidate|approved|registered|deprecated|hint`；`--raw` 显示 `coreEntityId`/`coreKind`/`typeLabel→EntityKind` 映射。
- **展示**：`displayName`、`typeLabel`、`status`、`summary`、`aliases`、`tags`。
- **列表示例**：

```text
实体库（候选 3 / 已批准 2 / 已注册 5）
  👤 沈笙          [角色] 候选      灰域退缩者  别名: 笙笙
  🗺️ 废弃站台      [地点] 已注册    长庚站旧址
  💎 黑晶碎片      [物品] 候选      可激活灰域
```

### 4.3 /entity \<name>

单实体档案——**Core 已注册实体的世界状态投影**。

- **数据**：`findEntitySketchesByName` 解析名称 → 取 `coreEntityId` → `coreBridge` 调 `get_context_slice`（**单实体**，非全局）。
- **展示**：`profileMarkdown`（FactRenderer 渲染的实体档案：属性、关系、关联线索）。
- **关键**：这是 Core `get_context_slice` 工具的正确用法（按 `entity_id`+`current_chapter` 查单实体）。见 §4.7 与 §6——它**不是** `/world` 的实现。
- **过滤**：`profileMarkdown` 本身是人话档案；`--raw` 追加 `factIndex`（`fact_id` 列表，供调试）。

### 4.4 /ideas

灵感卡列表，对应 `IdeaCard`。

- **数据**：`writingStore.listIdeaCards(projectId, filter?)`。
- **过滤**：`--kind premise|character|location|...`、`--status`（maturity）。
- **展示**：`summary`/`content`（截断）、`kind`、`maturity`、`tags`、`linkedDraftIds` 数量。

### 4.5 /drafts

草案列表，对应 `WritingDraft`。

- **数据**：`writingStore.listDrafts(projectId, filter?)`。
- **过滤**：`--status drafting|ready_to_simulate|simulated|committed|...`、`--kind scene|chapter|...`。
- **展示**：`title`/`summary`、`kind`、`chapter`、`status`、`linkedProposalViewId`（有则提示「有待审提案，用 /review 查看」）。

### 4.6 /pending

待确认事项清单（PendingDecisionItem），是 `/review` 的索引页。

- **数据**：`workflowService.listPendingDecisions(ctx)`。
- **展示**：每项 `kind`/`title`/`description` + 「→ `/review <linkedObjectId>` 处理」。
- **定位**：作者一进 CLI，`/state` 显示「待确认 N 项」后，用 `/pending` 看清单，再用 `/review <id>` 逐个处理。

### 4.7 /world —— 世界概览（需评审的设计决策）

**问题**：Core 没有「全局世界快照」工具。`get_context_slice` 是**单实体**档案；而 `RealCoreBridge.readCurrentWorldSnapshot`（real-bridge.ts:115）调它时**缺 `entity_id`、`current_chapter` 硬编码 1**——当前实现是坏的（见 §6 缺口 G1）。

**决策建议（二选一，需评审）：**

| 方案 | 定义 | 优点 | 缺点 |
|---|---|---|---|
| **W-A 概览+下钻（推荐）** | `/world` = 项目下**已注册实体清单** + **最近 N 个已提交事件**；点实体用 `/entity <name>` 下钻单实体档案 | 对齐现有能力（`listEntitySketches(status=registered)` + `WritingCoreRef` 反查事件），无需新工具 | 「世界状态」是聚合视图，非 Core 原生 |
| W-B 全局快照 | 新增 Core 工具 `get_world_snapshot`，返回全部实体+当前 Fact | 概念干净 | 需改 Core（超 Phase 7 范围），且大世界下返回体积爆炸 |

> **决策 D2（建议）**：采用 W-A。`/world` = 已注册实体清单（来自 `writingStore`，按 `coreEntityId` 是否存在判定「已进 Core」）+ 最近提交事件（从 `writing_audit_logs` 的 `commit_proposal` 成功记录反查 `coreEventId`）。`readCurrentWorldSnapshot` 在 CoreBridge 层标记为「Phase 7 不通过 CLI 暴露」，避免调用坏实现。

### 4.8 /project

项目元信息查看/编辑。

- **查看**：`writingStore.getProject(id)` → `title`/`premise`/`status`/`workspaceMode`/`activeBlueprintId`/`currentDraftId`。
- **编辑**：`/project set title <新标题>` / `set premise <...>` / `set status <planning|drafting|...>` / `set workspace-mode <...>`。映射到 `writingStore.updateProject`（可更新字段：`title`/`premise`/`status`/`activeBlueprintId`/`currentDraftId`/`workspaceMode`）。
- **边界**：`WritingProject` 类型当前**没有** `genreTags`/卖点/世界观摘要等 Roadmap §6 的「功能池」字段——Phase 7 不扩展类型，`/project` 只暴露现有字段。多作品管理（`listProjects`+切换）列为后续。

### 4.9 /goals

作者目标清单，对应 `AuthorGoal`。

- **数据**：`writingStore.listGoals(projectId, status?)`。
- **展示**：`text`、`kind`（goal/avoid/style/reader_experience）、`priority`、`scope`、`status`。

### 4.10 /audit

审计日志，对应 `WritingAuditLog`。

- **数据**：`writingStore.listAuditLogs(projectId, {limit})`——**此方法当前不存在**（store 仅有 `getAuditLog(logId)`），是前置缺口 G2（§6）。
- **展示**：`createdAt`/`action`/`triggerSource`/`result`/`targetType`+`targetId`。失败记录附 `errorCode`。
- **过滤**：`--limit N`（默认 30）、`--result success|failure|partial`。

---

## 5. 作者字段过滤（§25 验收红线）

`Roadmap §25` 与 `Feature-Spec §24.5` 明确：**普通作者视图不得展示 `EntityKind`/`RelationKind`/`predicate`/`schema`/Core ID 等技术字段**。

### 5.1 默认隐藏字段清单

| 对象 | 默认隐藏的技术字段 | 来源 |
|---|---|---|
| EntitySketch | `coreEntityId`、`coreKind` | `types.ts:254-255` |
| BlueprintTypeDef | `coreMapping`（`entityKind`/`predicate`/`relationKind`/`confidence`/`requiresWorldPackageExtension`） | `types.ts:152-159` |
| ProposalView | `coreProposalId`、`coreFactId`、`factDiff[].coreFactId` | `types.ts:321,336` |
| CoreRef | 整个 `WritingCoreRef`（仅调试可见） | `types.ts:405` |

### 5.2 三层显示（Feature-Spec §24.5）

每个命令输出默认只显示**作者可见层**：

```text
作者可见层    —— displayName/typeLabel/summary/humanSummary/predicateLabel（人话）
写作过程层    —— status/maturity/kind/linkedIds（草案、候选、审核状态）
Core 状态层   —— coreEntityId/coreKind/coreMapping/coreFactId（仅 --raw）
```

`--raw`（或 `--debug`）才解锁 Core 状态层，供调试。**`/state` 总览也遵守此规则**——不泄露 Core ID。

---

## 6. 实现前置缺口（实现前必须处理）

设计过程中发现的真实代码缺口，实现命令前要逐个确认/修复：

| 编号 | 缺口 | 位置 | 影响 | 处理 |
|---|---|---|---|---|
| **G1** | `readCurrentWorldSnapshot` 调 `get_context_slice` **缺 `entity_id`、`current_chapter` 硬编码 1** | `real-bridge.ts:115` | `/world` 若直接用它会失败 | 按 D2：`/world` 不依赖它；或修复为按实体查询并改名 `readEntityProfile` |
| **G2** | **无 `listAuditLogs`** 方法 | `writing-store.ts`（仅 `getAuditLog(id)`） | `/audit` 无法列表 | 新增 `listAuditLogs(projectId, {limit, result?})` |
| **G3** | `simulateProposal` 重新推演**未实现**（直接 throw） | `real-bridge.ts:105` | `/review` 无法「重新推演后再审」 | Phase 7 范围内应补（`Phase7-Refinement.md:3945` 已记）；若不补，`/review` 暂不支持重推，需在 Zone 5 注明 |
| **G4** | CoreBridge 提交通道仅 `event`+`entity_registration` 通；`thread`/`knowledge`/`schema_extension`/`retcon` 标 Phase 8 | `Phase7-Refinement.md:2158-2161` | `/review` 只能审这两类提案 | Phase 7 接受；其他类型提案出现时 Zone 5 提示「该类型提交 Phase 8 支持」 |
| **G5** | 命令解析层缺失 | `chat.ts` 仅有 `switch(cmd)` 硬编码，无参数/flag 解析 | 所有带参数命令（`/entity <name>`、`--status` 等） | 新增轻量命令解析（拆分 `命令 + 位置参数 + --flags`），不引入 CLI 框架依赖 |
| **G6** | CLI 未接入向量管线 | `chat.ts` 未创建 vectorStore/embedder/consumer，agent 未注入 retriever/renderer | Push 语义注入 + LanceDB 同步在 CLI 场景完全缺失 | ✅ **已修复（2026-06-14）**：chat.ts 接入 LanceDBTableAdapter/SiliconFlowEmbedder/RelevantFactRetriever/FactRenderer/SyncQueueConsumer，agent 注入 retriever+renderer，5s 定时器驱动 consumer |

> **G5 说明**：当前 `handleCommand` 是 `switch(input.trim())`，无法处理 `/entities --status candidate`。需先实现一个最小命令解析器（拆 token + 解析 `--flag [val]`），作为所有新命令的基础。这是第一个实现任务。
>
> **G6 说明（已修复）**：这是调研阶段挖出的最关键缺口——不是某个命令的问题，而是整个向量检索基础设施在 CLI 进程里没接。NarrativeAgent 的 Push 注入守卫（`narrative-agent.ts:498`）要求 `retriever && renderer` 同时存在才执行，而 chat.ts 两者都没传，所以提交的 Fact 不进 LanceDB、Agent 永远拿不到语义召回。修复后 CLI 具备完整的「提交→向量化→语义召回→Push 注入」闭环。

---

## 7. 与 Phase 8 的边界

明确**不**在 Phase 7 CLI 做的命令（属于 Phase 8+）：

- `/relations`、`/graph` —— 实体关系与图谱（Phase 8）
- `/map`、`/spatial` —— 地理与多层宇宙（Phase 9）
- `/chapters`、`/scenes`、`/timeline` —— 章节/场景/时间线（Phase 10）
- `/reader`、`/foreshadow`（深度） —— 读者模型/伏笔规划（Phase 11）
- `/prose`、`/revise`、`/retcon`（视图） —— 正文/修订/Retcon 可视化（Phase 12）

**注意**：Core 已有 `get_open_threads`/`resolve_thread` 工具与 `NarrativeThread`。`/threads`（查看开放线索）属于「读取已提交世界状态」，技术上可做，但 Roadmap 把伏笔**系统**划到 Phase 11。**决策 D3**：Phase 7 不提供 `/threads` 命令；若 `/entity` 档案里的关联线索足够，先不单独立命令。

---

## 8. 验收标准（Phase 7 CLI 达标线）

对照 `Roadmap §25` Phase 7 验收，逐条映射到 CLI 命令：

| Roadmap §25 验收项 | CLI 落地 |
|---|---|
| 用户想法不会直接写入 Core | 自然语言层只走 `propose`，提交必经 `/review`/确认通道 → CoreBridge |
| 草案可修改，不产生正式 Fact | `/drafts` 可查看草案状态，草案停留在 `simulated`/`drafting` |
| 沙盒推演后进入等待确认 | 推演产出 ProposalView(`open`)，`/pending`、`/state` 可见 |
| 用户确认后才提交到 Core | `/review --confirm`/确认通道 → `commitReviewedProposal` |
| 提交后可读取当前世界状态 | `/world`（D2）+ `/entity <name>` |
| Proposal Review 显示项目语言与 Core 类型映射 | `/review` 六区域 + `--raw` 映射 |
| Agent 不能直接调用正式提交工具 | 命令层亦不绕过 CoreBridge（§3.5 契约） |
| 普通作者视图不展示技术字段 | §5 作者字段过滤 |
| 提交失败/回写失败有可恢复状态 | `/review` Zone 6 + `/audit` 可查 `commit_failed` |
| 演示由真实写作层状态驱动 | 命令读真实 store，不伪造 |

---

## 9. 实现顺序建议

定稿后，按依赖顺序实现（每步含测试）：

1. **G5 命令解析器** —— 所有命令的基础
2. **G2 `listAuditLogs`** —— 补 store 方法（小，先清缺口）
3. **`/review` + `/pending`** —— 核心，确立 Proposal Review 视图契约范式
4. **`/entities` + `/entity`** —— 浏览范式 + 验证作者字段过滤
5. **`/blueprint` + `/ideas` + `/drafts` + `/goals`** —— 同质浏览命令批量
6. **`/world`（D2）+ `/project` + `/audit`** —— 聚合与管理
7. **G1 决策落地** —— 修复或弃用 `readCurrentWorldSnapshot`
8. `/state` 精简 + `/help` 扩充 —— 收尾
9. 端到端测试：真实写作层状态驱动走完 `/drafts → /review → /world` 闭环

---

## 10. 设计决策（已拍板，2026-06-14）

| 编号 | 问题 | 决策 | 依据 |
|---|---|---|---|
| **D2** | `/world` 形态 | **W-A 概览+下钻** | 对齐现有能力（`listEntitySketches` + audit 反查），不新增 Core 工具，不超 Phase 7 |
| **D3** | `simulateProposal` 重新推演 | **Phase 7 补** | Phase 7 范围内（`Phase7-Refinement.md:3945` 已记为缺口 G3），`/review` 需支持重推后再审 |
| **D4** | `/threads` 开放线索命令 | **不提供** | 伏笔系统划 Phase 11；`/entity` 档案内的关联线索足够 Phase 7 演示 |
| **D5** | 多项目切换 `/project switch` | **不进 Phase 7** | 单项目足够演示，多作品管理留后续 |
| **D6** | 命令输出语言 | **仅中文** | Phase 7 不做国际化 |

> **决策原则**：对齐现有能力、不超 Phase 7 范围。这些决策固化了 §2-§4 中标注「建议」的选项，实现时不再讨论。Phase 8（关系/图谱）启动门槛见阶段确认文档。

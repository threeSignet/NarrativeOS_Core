# NarrativeOS Web 端设计文档审查报告

**审查对象**：`docs/Web-Frontend-Design.md`（2106 行，2026-06-26 版）
**审查基准**：
- `docs/Writing-Layer-Gap-Register.md`（权威缺口登记表，截至 2026-06-25 基线）
- `src/writing/` 真实代码（types.ts / state-machine.ts / 全部 service / CoreBridge 接口）
- `src/cli/chat.ts` + `command-handlers.ts`（CLI 命令 = BFF 最接近的参考实现）
- `narrativeos-web-demo/`（现有 9 页静态 HTML 原型）
**审查日期**：2026-06-26
**审查结论**：**架构方向正确、产品理念清晰，但存在 3 类硬错误、2 个被严重低估的能力、若干术语漂移**。最关键问题是文档"后端依赖"判断严重滞后于真实代码（按 Phase 7 基线写，实际已到 Phase 8 完成态）。

---

## 一、🔴 必须修复的硬错误（会直接误导开发）

### R1. §18 后端依赖统计整体过时（最严重）

文档 §18（`Web-Frontend-Design.md:1299-1307`）的统计基于 Phase 7 基线，与真实代码严重脱节。

| 文档声称 | 真实状态（代码核实） |
|---|---|
| 已支持（Phase 7）22 场景 / 34% | 实际远高于此 |
| 需新功能（Phase 8-11）14 场景 / 22% | **Phase 8 已 100% 完成**（见 Gap-Register 基线表） |

逐条核对被误标的场景：

| # | 文档标注 | 真实后端状态 | 代码依据 |
|---|---|---|---|
| 7 大纲规划 | 需 Phase 10 | 章节即 `WritingDraft(chapter=N)`，DraftService 已支持，仅缺前端大纲视图 | `types.ts:253` DraftKind.chapter |
| 11 光标上下文感知 | 需适配 | `WritingDraft.entityReferences` 已存在；世界快照 `readCurrentWorldSnapshot` 已实装（W8） | `Web-Frontend-Design.md:1407` |
| 13/14/15 帮写/改写/续写 | 需适配 | Agent ReAct + WS 流式框架已在 W13 落地；生成预览属前端+WS 事件 | Gap-Register W13 |
| 21 一致性微提示 | 需适配 | Rule Engine 实时校验已存在；`consistency_warning` WS 事件已定义 | `Web-Frontend-Design.md:1018` |
| 29 闪回/梦境标记 | 需适配 | ContextScope 是 Core 五大抽象之一，已完整实现 | 架构文档 §ContextScope |
| 31 变更提取 | 需适配 | `simulateDraft` + `materializeProposalView` 已完整实现（W13），CLI `/draft simulate` 已可用 | Gap-Register W13 |
| 33 选择性提交 | 需适配 | `factDiff[].selected` 字段已在 ProposalView 模型中 | `Web-Frontend-Design.md:1437` |
| **41 关系图** | **需 Phase 8** | **Phase 8 已 100% 完成**：GraphService.buildGraphView + 16 张表 + Tool 12/13 已接入 | `graph-service.ts:45` |
| 42 地图 | 需 Phase 9 | spatial 数据已落 `WritingRelationCandidate.layer='spatial'`，Phase 9 是渲染增强 | `types.ts:529` |
| 44 伏笔看板 | 需 Phase 11 | NarrativeThread 是 Core 五大抽象，`thread` 图模式已支持 | `types.ts:622` |
| 45 读者视角 | 需 Phase 11 | Knowledge 是 Core 五大抽象，`commitReviewedKnowledgeChange` 已实装 | `core-bridge-service.ts:207` |

**修正建议**：§18 统计表改为"截至 Phase 8（2026-06-25）"，真实分布约为：**已支持 ~60% / 需适配（BFF 封装）~25% / 需新功能（Phase 9-11 渲染）~10% / 纯前端 ~5%**。

### R2. 实体审核状态机术语漂移（文档自相矛盾）

真实状态机（`state-machine.ts:155-166`）：

```
hint → candidate → approved → registered →（废弃/合并须走 Retcon）
```

文档内部三处不一致：

| 位置 | 文档写法 | 问题 |
|---|---|---|
| §9.2（`:651`） | `hint → candidate → 待确认 → registered` | **跳过了 `approved` 态** |
| §19.2（`:1352`） | status 含 `'approved'` | ✅ 正确 |
| §6.3 / §10.1 来源层 | committed/candidate/draft/hint/association/deprecated | `approved` 未在来源层颜色中体现，但它有独立语义 |

**修正建议**：§9.2 审核动线应为 `hint → [promote] → candidate → [approve] → approved → [Core 注册审核] → registered`，与 `EntityService.promoteHintToSketch` / `approveCandidate` 两步方法对齐（`entity-service.ts:120,173`）。`approved`（写作层已批准）与 `registered`（Core 已回写 `coreEntityId`）必须在 UI 上有视觉区分。

### R3. "写作模式快捷键 = 1" 与活动栏模块数冲突

| 位置 | 内容 | 计数 |
|---|---|---|
| §3.3 活动栏（`:109-121`） | draft/outline/graph/timeline/knowledge/idea/settings | **7 模块** |
| §4 工作模式（`:170-409`） | 写作/参考写作/图谱/大纲/审核/知识/灵感 | **7 模式**（含参考写作，无时间线独立模式） |
| §5.1 菜单（`:421`） | 写作/图谱/大纲/审核/知识/灵感 | **6 项** |
| §22.1 快捷键（`:1636`） | Cmd+1..6 | **6 项** |

**修正建议**：明确"活动栏 7 模块"（含 settings）vs"可切换工作模式 6 个"（settings 不算模式、参考写作是写作模式子态、时间线在 Phase 10 前是图谱子视图），消除计数歧义。

---

## 二、🟡 被严重低估的能力（设计应充分利用）

### U1. Phase 8 关系/图谱系统完全缺席于 API 设计

文档 §14.2（`:917-1001`）的 API 路由**完全没有**关系管理端点，但真实 `RelationService` 已提供 11 个方法：

```typescript
createRelationHints / confirmHintToCandidate / ignoreHint        // 检测提示链
createRelationCandidate / listRelationCandidates / advanceRelationCandidate
mergeRelationCandidates / deprecateRelationCandidate             // 候选链
createAssociation / listAssociations / archiveAssociation        // 创作关联链
```

CLI 已有 `/relation`、`/association`、`/graph` 三条命令（`chat.ts:344-346`）。

**修正建议**：§14.2 补充：
```
GET/POST  /api/projects/:projectId/relation-hints
PATCH     /api/projects/:projectId/relation-hints/:id/{confirm|ignore}
GET/POST  /api/projects/:projectId/relation-candidates
PATCH     /api/projects/:projectId/relation-candidates/:id/{advance|merge|deprecate}
GET/POST  /api/projects/:projectId/associations
DELETE    /api/projects/:projectId/associations/:id
```

### U2. 三层数据模型在图谱设计里只体现一层

真实 `GraphView`（`types.ts:625-677`）节点/边各有 6 种 `sourceLayer`：`committed/candidate/draft/hint/association/view`。但 §13.1/§13.2（`:868-894`）只笼统提了"正式关系/候选关系/视图关联"三种，**漏了 `association`（创作关联，作者手动标注，不进 Core）这一独立层**。

`AuthoringAssociation`（`types.ts:586-597`）有 7 种 kind（reference/echo/theme/draft_link/evidence/note/manual）——这是写作工具区别于普通图谱工具的核心特性（作者能标记"这两处是呼应/回响/主题关联"），设计文档应专门描述。

### U3. ProposalView 的 7 个状态在审核 UI 里未完整覆盖

真实状态机（`state-machine.ts:187-201`）：

```
open → author_approved / author_rejected / expired
author_approved → open / committed / commit_failed / expired
author_rejected → superseded
commit_failed → open
expired → superseded
```

文档 §23.2（`:1750-1759`）画了 `open→author_approved→committed` 和 `commit_failed`，**漏了 `expired`（Core proposal 跨会话丢失，§7.11.6 懒机制）和 `superseded`**。这两个状态在 UI 上需专门表达（expired 提示"重新推演"、superseded 灰显归档）。

**修正建议**：§23.2 状态机图补全 7 态，并明确 `expired` 触发条件 = "提交时 Core 返回 PROPOSAL_NOT_FOUND"（对应 §21.4 错误码表，该行已正确）。

---

## 三、🟢 术语与一致性建议（打磨项）

| 位置 | 问题 | 建议 |
|---|---|---|
| §9.2（`:651`） | "approve（候选→注册）" | 应为"approve（candidate→approved）"，Core 注册是独立的 `commitReviewedEntity` 通道 |
| §27 内部小节 | 标为 `26.1` `26.2`（`:1993,2009`） | 章节号笔误，应为 27.1/27.2 |
| §17.3 审核步骤 | 4 步 | 与 §9.3/§4.5 的"5 步（摘要/Diff/实体/规则/决策）"不一致，统一为 5 步 |
| §13.2 "出处关联" | 标注"需适配" | 已通过 `Draft.sourceRefs`（W14/W15）+ `entityReferences` 支持，应标"已支持" |
| §19.1 `status` 枚举 | 5 态 | ✅ 与 `ProjectStatus`（`types.ts:20`）完全一致 |
| §19.3 `DraftStatus` | 漏 `'error'` | `types.ts:245-251` 有 6 态，且 `ready_to_simulate` 是关键中间态应在 UI 可见 |
| §6.3 来源层颜色 | 6 层 | ✅ 与 `GraphSourceLayer`（`types.ts:623`）吻合，但 `deprecated` 与 `association` 在亮色下红/紫邻近，应补图案辅助（§30.3 已提，前置到 §6.3） |
| §27.2 Agent 权限边界 | 5 项"不能做" | 与 `permission-check.ts` 的 `AGENT_PERMISSIONS` 矩阵（5 级 AgentCapability）未交叉引用，建议加引用 |

---

## 四、现有 Demo（`narrativeos-web-demo/`）与设计文档的差距

现有 demo = 9 个独立静态 HTML（project-select/overview/editor/entities/review/agent/ideas/world-state/blueprint），纯 HTML + 内联 CSS，无 Vue/Tauri/WS。

| 维度 | Demo 现状 | 设计文档要求 |
|---|---|---|
| 技术栈 | 静态 HTML | Vue3 + Tauri + Pinia + TipTap |
| 模式系统 | 9 个独立页面，无模式切换 | 7 种工作模式 + 顶栏切换器（§4/§5） |
| 编辑器 | 普通 div/textarea | TipTap + 实体高亮 + 光标感知（§9.1/§17.4） |
| 图谱/关系 | **完全缺失** | 图谱是一级视图（§4.3、§10、§13） |
| 审核动线 | review.html 静态 | 5 步分步审核 + 状态机 + WS（§9.3/§17.3/§23.2） |
| 来源层颜色 | ✅ index.html 已定义 6 色 CSS 变量 | 与 §6.3 吻合 |
| 引导体系 | 无 | §26 五层引导（L1-L5） |

**结论**：demo 验证了视觉风格（暖色中性 + 来源层颜色 + 衬线正文），但**架构层面需完全重写**为 Vue 组件化。建议保留 demo 作"视觉风格参考"与"像素级还原基准"，新建 `narrativeos-web/` Vue 工程。

---

## 五、技术与架构风险提示

1. **Tauri + Node.js BFF 同进程**（§27.1）落地风险：Tauri sidecar 跑 Node.js 非主流路径。更稳妥是 Rust 侧经 `tauri::command` 调 TS。建议设计文档明确选型并给出 PoC 计划，否则是后期最大架构返工点。

2. **Cytoscape.js vs vue-flow 二选一未定**（§2.4 `:70`）。§20 提到"10 万+节点用 WebGL"——这个量级**只有 Cytoscape + WebGL 插件能扛**，vue-flow 会崩。应明确选 Cytoscape。

3. **光标感知"不发网络请求"（§17.4）与世界快照实时性冲突**：世界状态会因审核提交而变（§4.5 提交后版本+1）。需补一条"提交事件后推送 `world_update` 事件刷新本地缓存"的 WS 事件（§14.3 现有 `audit_update` 不够语义化）。

4. **§20 "TipTap 虚拟滚动"方案不成立**：TipTap/ProseMirror 原生不支持虚拟滚动（文档结构需完整驻留）。单章 3 万字不卡（纯文本 ~60KB），真正卡的是实体高亮装饰节点数量。建议改为"**单章无上限，实体装饰节点用懒绑定**"。

5. **§8.2 "导航状态不写入 Core"** ✅ 正确，但应补充：导航状态也不应与 `writing_workspace_layouts` 表（W12 已建）混淆——后者是 UI 布局持久化，前者是会话级导航。边界要在文档划清。

---

## 六、修订优先级汇总

| 优先级 | 修订项 | 对应问题 | 工作量 |
|---|---|---|---|
| P0 | §18 后端依赖统计全面重估（基于 Phase 8 现状） | R1 | 中 |
| P0 | §14.2 补充 relation/association API 路由 | U1 | 小 |
| P0 | §9.2 / §23.2 修正实体与提案状态机（补 approved/expired/superseded） | R2/U3 | 小 |
| P1 | §2.4 明确 Cytoscape（删 vue-flow 二选一） | 风险2 | 小 |
| P1 | §27 Tauri+BFF 落地选型 + PoC 计划 | 风险1 | 中 |
| P1 | §13 补充 association（创作关联）7 种 kind 的设计 | U2 | 中 |
| P2 | §13.2 / §29 出处关联改标"已支持" | R1 | 小 |
| P2 | §20 删除 TipTap 虚拟滚动方案 | 风险4 | 小 |
| P2 | §17.4 补 world_update WS 事件 | 风险3 | 小 |
| P2 | 章节编号/术语统一（§27→27.1、审核步骤统一 5 步、§19.3 补 error 态） | 术语 | 小 |

---

## 七、值得保持的设计（已验证正确）

- 七模式切换 + 沉浸式理念（§3/§4）——写作工具的核心矛盾（信息密度 vs 沉浸感）抓得准
- 来源层 6 色体系（§6.3）——与 `GraphSourceLayer` 完全吻合，产品差异化
- 审核保护 + blocker 禁提交（§9.3/§21.4）——"提交受保护"原则落地清晰
- 三层显示 + 不露技术字段（§16.3/§1.3）——与 ViewModel 过滤层（W6）哲学一致
- Agent 生成结果必预览（§12.3 关键原则）——与 `renderProposalForUser` Zone1-5 不泄漏 `ent_` 一致
- 模式自动触发规则（§5.2）——"灵感转草案→写作""提交→审核"动线直觉
- 引导体系五层（§26）——L1-L5 递进 + 写作模式静默，设计成熟

---

**下一步**：本报告作为审查基线存档。后续前端细化设计以本报告 R1-R3 / U1-U3 的修正为前提，按一问一答方式推进。

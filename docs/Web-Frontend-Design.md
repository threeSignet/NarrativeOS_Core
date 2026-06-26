# NarrativeOS Web 端设计文档

**项目代号**：NarrativeOS-Core
**创建日期**：2026-06-21
**状态**：设计阶段（开发前完善中，所有内容持续往上堆，不分版本）
**作者**：设计收敛 + 技术补全

> 本文档收敛了 Writing-Layer-Feature-Spec §22（前端体验）、Writing-Layer-Roadmap §24（前端设计语言预留）、§9.4（空间视图）、§10.1-10.7（图谱视图）、§13.13（跨端编辑器）、§4.8（蓝图前端）等散落的前端设计，并补齐技术选型、组件设计、API 设计、交互流程。

---

## 1. 定位与目标

### 1.1 这是什么

NarrativeOS Web 端是写作层的**产品界面**——把 CLI 验证过的所有能力（灵感→蓝图→实体→草案→事件→审核→提交→世界状态）套上可视化的创作工作台。

### 1.2 不是什么

- 不是 Core 引擎的扩展——不改 Core 代码
- 不是简单的聊天界面——是完整的创作工作台
- 不是一次性做完的——分阶段交付，但设计一次想清楚

### 1.3 核心原则（来自 Roadmap §24.2）

1. **写作工作台优先**——界面服务写作，不是把所有功能堆在第一屏
2. **信息密度适中**——PC 支持多面板，移动端优先单任务
3. **视觉区分**——正式状态/候选/草案/提示必须有稳定视觉区分
4. **提交受保护**——正式写入必须走审核确认流程，不可误触
5. **作者不见技术字段**——普通界面不出现 schema/JSON/predicate/Core ID
6. **图谱/地图/时间线是一级视图**——不是弹窗附属功能

---

## 2. 技术选型

### 2.1 前端框架

**Vue 3+**（Composition API + TypeScript）

理由：
- 响应式系统天然适合编辑器状态管理（选中实体、当前章节、面板显隐）
- 组件化契合面板布局——每个面板就是一个 Vue 组件，按需挂载
- Composition API 让面板逻辑独立，互不干扰
- TypeScript 原生支持（与后端共享类型定义）

### 2.2 桌面端壳

**Tauri 2.0**（Rust + WebView）

理由：
- 比 Electron 小 10 倍（安装包 ~10MB vs ~100MB）
- 直接复用系统 WebView，不打包 Chromium
- Rust 侧可做文件系统操作（项目 db 文件管理）
- 支持 Windows/macOS/Linux

### 2.3 后端服务

**Node.js + Express/Fastify**（BFF 层）

架构文档 :228 明确定义："未来如果需要 Web UI，只需在 Core 之上加一层 BFF（Backend for Frontend），将前端操作翻译为 Tool Call，Core 代码一行不改"。

BFF 职责：
- 把前端的 HTTP/REST 请求翻译为写作层 service 调用
- WebSocket 实时推送（Agent 响应流、审计更新）
- 文件系统管理（项目 db 文件选择/创建/切换）
- 会话管理（当前活跃项目、Agent 会话状态）

### 2.4 关键依赖库

| 用途 | 库 | 说明 |
|---|---|---|
| 富文本编辑器 | TipTap (ProseMirror) | 可扩展、支持自定义节点/标记（实体高亮、伏笔标记），有 Vue 版本 |
| 图可视化 | Cytoscape.js / vue-flow | 关系图、空间图、影响图 |
| 状态管理 | Pinia | Vue 官方推荐，TypeScript 友好 |
| 路由 | Vue Router | 多视图导航 |
| UI 组件库 | **自研组件**（不用第三方 UI 框架） | 完全自主控制样式，适配编辑器类产品的高度定制需求 |
| 实时通信 | Socket.io / 原生 WebSocket | Agent 流式响应 |
| 拖拽布局 | 自研（基于 Vue 拖拽指令） | 面板大小调整、拖拽布局 |

---

## 3. 信息架构（来自 Feature-Spec §22.3 + Roadmap §24.3）

### 3.1 导航结构

```
顶栏：作品名 / 当前章节 / 当前工作模式 / 提交状态指示 / 待处理徽标
├── 概览（Project Overview）
│   ├── 项目状态卡片（状态/模式/实体数/草案数/待确认数）
│   ├── 最近活动（审计时间线摘要）
│   └── 快速入口（继续写作/查看待确认/新建灵感）
├── 写作（Draft Editor）★ 主工作区
│   ├── 章节列表（左侧）
│   ├── 正文编辑器（中间）
│   └── 场景面板（可展开）
├── 设定（Entity Database）
│   ├── 实体列表（按类型分组）
│   ├── 实体详情页（档案/属性/出场记录/关系）
│   └── 候选实体审核（hint→candidate→approve）
├── 关系图（Relation Graph）
│   ├── 关系网络可视化
│   ├── 布局编辑（拖拽）
│   └── 过滤器（类型/状态/来源层）
├── 地图（Map / Spatial View）
│   ├── 空间图视图
│   ├── 视图切换（图/树/平面/多层）
│   └── 角色位置追踪
├── 时间线（Timeline View）[Phase 10]
│   ├── 事件时间轴
│   ├── 章节排列
│   └── 时序冲突检查
├── 伏笔与读者（Foreshadowing & Reader）[Phase 11]
│   ├── 伏笔看板
│   ├── 读者知识状态
│   └── 信息释放计划
├── 灵感板（Idea Board）
│   ├── 灵感卡列表
│   ├── 成熟度管理
│   └── 灵感→草案转换
├── 蓝图（Blueprint Panel）
│   ├── 当前蓝图状态
│   ├── 实体类型/关系类型定义
│   └── 变更建议审核
├── 审核（Proposal Review）★ 关键动线
│   ├── 待审核提案列表
│   ├── 提案详情（人话 Diff/影响范围/规则警告）
│   └── 确认/拒绝/暂存
├── 世界状态（World State Snapshot）
│   ├── 全实体快照
│   ├── 最近提交事件
│   └── 知识可见性视图
├── 审计（Audit Log）
│   ├── 操作历史
│   └── 过滤/搜索
└── 设置（Project Settings）
    ├── 项目元信息（标题/前提/状态/模式）
    ├── 导入导出
    └── 项目归档
```

### 3.2 导航原则

- 导航树**不展示 Core ID 或技术类型**——用人话（"角色"而非"EntityKind: character"）
- 待处理数量**可点击追溯**（徽标 → 审核页）
- 搜索结果**区分来源层级**（正文/草案/正式状态/候选用不同颜色标记）
- 导航状态**不写入 Core**（面板布局/最近访问/收藏都是前端状态）

---

## 4. PC 工作台布局（来自 Feature-Spec §22.1 + Roadmap §24.1）

### 4.1 默认三栏布局

```
┌─────────────────────────────────────────────────────────────────┐
│ 顶栏：灰域行者 / 第1章 / 写作模式 / ●提交就绪 / ⏳2待确认       │
├───────────────┬─────────────────────────────┬───────────────────┤
│ 左栏：世界设定  │ 中栏：写作工作区              │ 右栏：Agent 助手   │
│               │                             │                   │
│ 📋 实体 (5)    │ 第一章：黑晶碎片              │ 🤖 Agent           │
│  沈墨 [角色]   │                             │                   │
│  沈笙 [角色]   │ 灰域边缘的废弃站台像一具...   │ "检测到2个实体线索"│
│  长庚站 [地点] │                             │                   │
│               │ 沈墨把沈笙拉到广告牌后面...   │ [检测实体] [推演]  │
│ 🗺️ 地图        │                             │                   │
│ 📊 关系图      │ [草案] [推演报告] [待写入]    │ 💬 对话输入框      │
│ ⏰ 时间线      │                             │                   │
│ 🔮 伏笔        │                             │                   │
├───────────────┴─────────────────────────────┴───────────────────┤
│ 底栏：审计摘要 / 同步状态 / 向量检索状态                         │
└─────────────────────────────────────────────────────────────────┘
```

### 4.2 布局规则

- **中间正文编辑区始终是视觉中心**——写作模式下降低非必要提醒的视觉权重
- **左栏可折叠**——全屏写作时收起
- **右栏可固定/收起**——Agent 对话可最小化为浮窗
- **面板宽度可拖动**——作者自定义比例
- **布局可保存**——`SavedLayoutPreset`（写作模式/规划模式/审核模式各有默认布局）
- **工作模式切换**——写作/规划/审核/分析/导入/修订，不同模式调整默认面板组合

### 4.3 工作模式（WorkspaceMode）

| 模式 | 默认面板组合 | 重点 |
|---|---|---|
| **写作** (writing) | 正文编辑器为主，左右栏收起或精简 | 降低打扰，专注创作 |
| **规划** (planning) | 灵感板+蓝图+实体为主，正文区显示大纲 | 结构化思考 |
| **审核** (reviewing) | 审核页全屏或占据主区 | 清晰确认流程，防误触 |
| **分析** (analysis) | 世界状态+关系图+审计为主 | 检查一致性 |
| **导入** (importing) | 导入向导全屏 | 结构化导入 |

---

## 5. 核心页面设计

### 5.1 概览页（Project Overview）

**定位**：进入项目后的首页，一屏看清当前状态。

**内容**：
- 项目状态卡片：标题/前提/状态/模式/实体数/草案数/待确认数/审核视图数
- 最近活动（审计时间线摘要，最近 5 条）
- 快速入口按钮：继续写作 / 查看待确认 / 新建灵感 / 查看世界状态

**数据源**：`projectService.getProjectHomeView`（CLI 已验证）

### 5.2 写作编辑器（Draft Editor）★

**定位**：主工作区，作者花最多时间的地方。

**布局**：
- 左侧：章节列表（可折叠）+ 场景面板
- 中间：TipTap 富文本编辑器
- 右侧：Agent 反馈面板（可收起）

**编辑器能力**：
- 富文本编辑（段落/标题/引用/列表）
- 实体高亮：输入"沈墨"时自动标记（从已注册实体列表匹配）
- 矛盾标记：写到与设定冲突的内容时，Agent 标红提示
- 场景分隔：用分隔线标记场景切换
- 字数统计
- 自动保存（每 30 秒或失焦时保存为草案）

**Agent 交互**：
- 右侧 Agent 面板：对话式交互（描述剧情 → Agent 检测实体 → 推演事件）
- 光标反馈：写到实体名时，光标附近显示轻提示（当前状态/相关伏笔）
- 候选池：Agent 检测到的实体线索/事件提案，需作者显式确认

**数据源**：`draftService.createDraft/updateDraftContent/listDrafts` + `agent.processUserInput`

### 5.3 实体管理（Entity Database）

**定位**：管理所有角色/地点/物品/概念。

**列表页**：
- 按类型分组（角色/地点/物品/概念，图标区分 👤🗺️💎💡）
- 每个实体卡片：显示名/类型/状态标签/属性计数
- 状态颜色：registered(绿)/candidate(黄)/hint(灰)/deprecated(红)
- 筛选器：按状态/类型
- 搜索：按名称

**详情页**：
- 实体档案（Core 的 profileMarkdown，经 §5 过滤渲染）
- 属性列表（当前 status/realm/location 等）
- 出场记录（在哪些章节/事件出现）
- 关系列表（与其他实体的关系）
- 操作按钮：approve（候选→注册）/ deprecate（废弃）

**审核动线**：
- hint → [approve] → candidate → [approve] → 待确认 → [确认] → registered
- 每步有明确的视觉状态变化和确认

**数据源**：`entityService` + `coreBridge.readCurrentWorldSnapshot` + `writingStore.listEntitySketches`

### 5.4 审核页（Proposal Review）★

**定位**：正式写入 Core 的关键动线。**必须独立、清晰、可理解**。

**布局**：
- 独立页面或全屏模式（与普通写作区隔离，防误触）
- 分步骤审核：
  1. **摘要**：这个事件要做什么（人话描述）
  2. **事实变更**：人话 Diff（新增/修改/删除哪些设定）
  3. **涉及实体**：哪些角色/地点受影响
  4. **规则警告**：有无矛盾/冲突（blocker 红色/warning 黄色/info 蓝色）
  5. **决策**：确认/拒绝/暂存/返回修改

**视觉规则**：
- 提交按钮**不在第一步显示**——必须看完所有步骤
- blocker 级警告**禁用提交按钮**（除非显式覆盖）
- 提交结果**明确反馈**（成功显示事件 ID，失败显示原因）

**数据源**：`coreBridge.commitReviewedProposal` + `workflowService.listPendingDecisions`

### 5.5 Agent 对话面板

**定位**：作者与 AI 的交互通道。

**布局**：
- 右侧固定面板或浮动窗口
- 对话历史（可滚动）
- 输入框（自然语言输入）
- 快捷操作按钮（检测实体/推演事件/查询状态）

**交互模式**：
- 流式响应（Agent 回复逐字显示，类似 ChatGPT）
- 工具调用可视化（Agent 调 detect_entity_hints 时显示"正在检测实体..."）
- 候选推送（Agent 检测到实体/产出提案时，推送到候选池供作者审核）
- 确认通道（作者输入"确认"触发 PendingDecision 处理）

**数据源**：`agent.processUserInput`（WebSocket 流式）

### 5.6 蓝图面板（Blueprint Panel）

**定位**：展示"系统对作品结构的理解"——不是配置页。

**内容**：
- 当前蓝图状态（implicit/drafted/active/evolving）
- 实体类型列表（label/description/aliases）
- 关系类型列表
- 变更建议（待确认的 accept/reject）

**交互**：
- 轻量确认（不是复杂配置表单）
- 作者可以完全不打开这个面板继续写作
- 类型变更建议用 accept/reject 卡片展示

**数据源**：`blueprintService.getActiveBlueprint/getLatestBlueprint`

### 5.7 灵感板（Idea Board）

**定位**：捕捉和管理创作灵感。

**布局**：
- 看板式布局（按成熟度分列：raw/candidate/ready）
- 灵感卡：内容摘要/类型标签/标签/关联草案数
- 操作：新建/编辑/归档/转草案

**数据源**：`ideaService.listIdeaCards/captureIdea/discardIdea`

### 5.8 世界状态快照（World State Snapshot）

**定位**：查看当前已提交的世界状态。

**内容**：
- 全实体概览（name/typeLabel/attributeCount）
- 每个实体的属性快照（location/status/realm 等）
- 最近提交事件列表（时间/事件 ID/摘要）
- 知识可见性视图（谁知道什么——Phase 11 增强）

**数据源**：`coreBridge.readCurrentWorldSnapshot` + `buildWorldSnapshotView`

---

## 6. 图谱/地图/时间线视图

### 6.1 统一图谱视图（来自 Feature-Spec §10.1）

**定位**：把实体、关系、空间、时间、伏笔连成可视化网络。

**视图模式**：
- `world`：世界状态图（全实体+全关系）
- `relationship`：人物关系图
- `spatial`：空间图（地点+可达性）
- `timeline`：时间线图（事件按章节排列）
- `thread`：伏笔图（线索依赖网络）
- `proposal`：提案影响图（某事件影响哪些实体）

**数据模型**（来自 Feature-Spec）：
```ts
interface GraphView {
  id: string;
  projectId: string;
  label: string;
  mode: 'world' | 'relationship' | 'spatial' | 'timeline' | 'thread' | 'proposal' | 'custom';
  nodes: GraphNodeView[];
  edges: GraphEdgeView[];
  filters: GraphFilterState;
  layout: GraphLayoutState;
}
```

**节点来源层级**（视觉颜色区分）：
- `committed`（绿色）：已提交到 Core 的正式状态
- `candidate`（黄色）：候选中的实体/关系
- `draft`（蓝色）：草案中的内容
- `hint`（灰色）：检测到的线索
- `association`（紫色）：视图层关联（非正式）
- `view`（浅灰）：纯视图对象

### 6.2 地图/空间视图（来自 Feature-Spec §9.4）

**定位**：空间数据的可视化。

**视图模式**：
- 通用空间图（默认）——节点+边的网络图
- 树状层级——多层宇宙的树形展开
- 平面地图——2D 平面布局
- 多层视图——多层宇宙的堆叠
- 时间变化图——不同章节的空间状态对比

**交互**：
- 拖动节点调整布局
- 过滤（空间类型/关系类型/状态）
- 点击节点/边查看详情
- 保存视图布局（前端状态，不写 Core）

### 6.3 时间线视图 [Phase 10]

**定位**：事件按时间排列。

**内容**：
- 水平时间轴（章节为刻度）
- 每个事件标记（位置/颜色按类型）
- 角色行程线（某角色在各章节的位置变化）
- 时序冲突标记（规则引擎检测到的矛盾）

---

## 7. API 设计（BFF 层）

### 7.1 架构

```
前端 (Vue) ←→ BFF (Node.js) ←→ 写作层 Service ←→ Core Engine
     ↑                    ↑
  WebSocket            REST API
  (Agent 流式)         (CRUD 操作)
```

### 7.2 REST API 路由

**项目管理**：
```
GET    /api/projects                    列出所有项目
POST   /api/projects                    创建项目
GET    /api/projects/:projectId         获取项目详情
PATCH  /api/projects/:projectId         更新项目元信息
DELETE /api/projects/:projectId         归档项目
```

**实体管理**：
```
GET    /api/projects/:projectId/entities           列出实体
POST   /api/projects/:projectId/entities/detect    检测实体线索
PATCH  /api/projects/:projectId/entities/:id/promote   hint→candidate
PATCH  /api/projects/:projectId/entities/:id/approve   candidate→approved
PATCH  /api/projects/:projectId/entities/:id/deprecate 废弃
GET    /api/projects/:projectId/entities/:id       实体详情（档案）
```

**草案管理**：
```
GET    /api/projects/:projectId/drafts              列出草案
POST   /api/projects/:projectId/drafts              创建草案
PATCH  /api/projects/:projectId/drafts/:id          更新草案内容
DELETE /api/projects/:projectId/drafts/:id/abandon  废弃草案
```

**事件推演与审核**：
```
POST   /api/projects/:projectId/simulate            沙盒推演事件
GET    /api/projects/:projectId/proposals           列出审核视图
GET    /api/projects/:projectId/proposals/:id       审核详情
POST   /api/projects/:projectId/proposals/:id/approve   批准提案
POST   /api/projects/:projectId/proposals/:id/reject    拒绝提案
POST   /api/projects/:projectId/proposals/:id/commit    确认提交到 Core
```

**灵感/目标/蓝图**：
```
GET/POST  /api/projects/:projectId/ideas
DELETE    /api/projects/:projectId/ideas/:id        归档灵感
GET/POST  /api/projects/:projectId/goals
GET       /api/projects/:projectId/blueprint
POST      /api/projects/:projectId/blueprint/generate
POST      /api/projects/:projectId/blueprint/accept
```

**世界状态与审计**：
```
GET    /api/projects/:projectId/world               世界快照
GET    /api/projects/:projectId/audit               审计日志
GET    /api/projects/:projectId/pending             待确认事项
```

### 7.3 WebSocket 事件

```
// Agent 对话
ws.send({ type: 'agent_input', projectId, text })
ws.on('agent_token', (data) => { /* 流式 token */ })
ws.on('agent_tool_call', (data) => { /* 工具调用可视化 */ })
ws.on('agent_complete', (data) => { /* 回复完成 */ })

// 实时状态更新
ws.on('pending_update', (data) => { /* 待确认数量变化 */ })
ws.on('audit_update', (data) => { /* 新审计记录 */ })
```

---

## 8. 前端状态管理

### 8.1 全局状态（Zustand stores）

```ts
// 项目 store
useProjectStore: { currentProject, projects[], selectProject(), createProject() }

// 实体 store
useEntityStore: { entities[], candidates[], detect(), approve(), deprecate() }

// 草案 store
useDraftStore: { drafts[], currentDraft, create(), update(), abandon() }

// 审核 store
useProposalStore: { proposals[], pending[], approve(), reject(), commit() }

// Agent store
useAgentStore: { messages[], isStreaming, sendMessage(), toolCallProgress }

// 布局 store
useLayoutStore: { mode, panels, savedLayouts, setMode(), togglePanel() }
```

### 8.2 数据边界（来自 Roadmap §24.4）

**前端可保存的 UI 状态**（不写 Core）：
- 面板布局/宽度
- 图谱节点位置
- 地图视图配置
- 当前过滤器
- 草案编辑状态（光标位置/选区）
- 用户选中的工作流步骤

**前端不能做的**：
- 不能把 UI 状态混入 Core 世界状态
- 不能绕过审核流程直接写 Core
- 不能展示技术字段给普通作者

---

## 9. 设计语言

### 9.1 来源层级颜色系统

| 层级 | 颜色 | 含义 | 用途 |
|---|---|---|---|
| committed | 绿色 (#22c55e) | 已提交到 Core | 正式状态标记 |
| candidate | 黄色 (#eab308) | 候选中 | 待审核 |
| draft | 蓝色 (#3b82f6) | 草案中 | 编辑中的内容 |
| hint | 灰色 (#94a3b8) | 线索 | 自动检测到的 |
| association | 紫色 (#a855f7) | 视图关联 | 非正式关联 |
| deprecated | 红色 (#ef4444) | 已废弃 | 不再有效 |

### 9.2 排版原则

- 正文区：衬线字体（如 Noto Serif SC），阅读舒适
- UI 界面：无衬线字体（如 Inter / Noto Sans SC），清晰可扫描
- 代码/技术字段：等宽字体（仅调试视图）

### 9.3 组件风格

- 卡片：圆角(8px)、轻阴影、来源层颜色左边框
- 按钮：主操作(实色)、次操作(描边)、危险操作(红色)
- 标签：来源层颜色背景+白色文字
- 输入框：底部边框样式（写作感）

---

## 10. 交互流程

### 10.1 首次使用流程

```
打开应用
  → 项目选择页（列出已有项目 / 新建）
  → 新建项目（输入名称+前提）
  → 概览页（空状态引导）
  → "描述你的世界观和主角"（引导输入）
  → Agent 检测实体 → 候选实体出现
  → 作者审核实体 → 确认注册
  → "写第一章"（进入编辑器）
  → Agent 推演事件 → 审核提案
  → 确认提交 → 世界状态更新
```

### 10.2 日常写作流程

```
打开项目 → 概览页（看到上次进度）
  → 进入写作编辑器
  → 继续写正文 / 或与 Agent 对话推进剧情
  → Agent 检测到新实体/事件 → 推送到候选池
  → 作者在审核页确认
  → 世界状态实时更新
  → 左栏实体面板自动刷新
```

### 10.3 审核确认流程（关键动线）

```
Agent 产出提案 → 右栏显示"有待确认事项"
  → 作者点击 → 进入审核页
  → Step 1: 摘要（这个事件做什么）
  → Step 2: 事实变更（人话 Diff）
  → Step 3: 涉及实体 + 规则警告
  → Step 4: 决策（确认/拒绝/暂存/修改）
  → 确认 → 提交到 Core → 成功反馈
  → 世界状态更新 → 实体面板刷新
```

---

## 11. 移动端适配（来自 Feature-Spec §22.2）

### 11.1 定位

平板和手机需要能查看、轻量编辑、确认提案和接收反馈。小屏幕不强求完整多面板。

### 11.2 适配策略

- 手机：单栏优先（正文/审核/Agent 三选一），底部抽屉切换
- 平板横屏：双栏（正文 + Agent/审核）
- 重要确认按钮固定在安全区域内
- 大图谱/地图默认进入摘要模式
- 审核页全屏模式（防误触）

---

## 12. 前端数据边界（来自 Roadmap §24.4-24.5）

### 12.1 Core 类型适配

前端必须深度适配 Core 的基础类型，但不能直接展示：

| Core 类型 | 前端展示 | 调试视图 |
|---|---|---|
| EntityKind | 类型标签（"角色"/"地点"） | EntityKind 枚举值 |
| RelationKind | 关系标签（"师徒"/"敌对"） | RelationKind 枚举值 |
| Fact | 属性卡片（"位置：废弃站台"） | fact ID + predicate + certainty |
| NarrativeEvent | 事件摘要 | event ID + type + factChanges |
| NarrativeThread | 伏笔卡片 | thread ID + type + closeCondition |

### 12.2 三层显示

1. **作者可见层**（默认）：displayName/typeLabel/summary/humanSummary
2. **写作过程层**（可展开）：status/maturity/kind/linkedIds
3. **Core 状态层**（仅调试）：coreEntityId/coreKind/predicate/factChanges

---

## 13. 开发优先级

### 第一阶段：最小可用原型

目标：把 CLI 的核心能力搬到 Web 上，验证前端可行性。

- [ ] BFF 层骨架（Express + 项目管理 REST API）
- [ ] 项目选择/创建页
- [ ] 概览页
- [ ] 实体管理（列表+详情+审核动线）
- [ ] Agent 对话面板（WebSocket 流式）
- [ ] 审核页（人话 Diff + 确认提交）
- [ ] 世界状态快照

### 第二阶段：写作体验

- [ ] TipTap 富文本编辑器
- [ ] 章节管理
- [ ] 实体高亮（输入时自动标记）
- [ ] 灵感板
- [ ] 蓝图面板
- [ ] 布局保存

### 第三阶段：可视化

- [ ] 关系图（Cytoscape.js）
- [ ] 空间图/地图
- [ ] 审计日志页
- [ ] 移动端适配

### 第四阶段：高级

- [ ] 时间线视图 [依赖 Phase 10]
- [ ] 伏笔看板 [依赖 Phase 11]
- [ ] 读者知识视图 [依赖 Phase 11]
- [ ] 导入导出
- [ ] Retcon 可视化

---

## 14. 待细化内容（持续补充）

### 14.1 视觉规范（待 UI 设计）
- 完整色彩方案（深色/浅色主题）
- 图标体系
- 动画/过渡规范
- 响应式断点

### 14.2 性能指标（待定义）
- 首屏加载时间目标
- 编辑器输入延迟目标
- Agent 响应首 token 时间目标
- 图谱渲染节点数上限

### 14.3 安全（待细化）
- 项目文件加密（可选）
- API 鉴权（本地应用可简化）
- XSS 防护（富文本编辑器）

---

## 附录 A：与现有系统的关系

### A.1 复用的后端接口（CLI 已验证）

所有写作层 service 接口直接复用，BFF 只是套一层 HTTP/WebSocket：

| CLI 命令 | BFF API | 后端 Service |
|---|---|---|
| /entities | GET /entities | entityService + writingStore |
| /entity approve | PATCH /entities/:id/approve | entityService.approveCandidate |
| /draft add | POST /drafts | draftService.createDraft |
| /review | GET /proposals/:id | coreBridge + writingStore |
| 确认 | POST /proposals/:id/commit | coreBridge.commitReviewedProposal |
| /world | GET /world | coreBridge.readCurrentWorldSnapshot |
| 自然语言 | WS agent_input | agent.processUserInput |

### A.2 项目数据隔离复用

每项目独立 db 文件机制（project-selector.ts 已实现）直接复用——BFF 启动时选项目，后续所有 API 路由都带 `:projectId`。

### A.3 矛盾检测复用

规则引擎硬检测（deadEntityConstraint + settingConflictConstraint）+ LLM 软检测双轨机制直接复用——前端审核页展示 ruleWarnings（来自 PV 四件套）。

---

## 15. 完整场景清单（作者的真实工作流）

本章把作者写长篇小说的全部操作场景列出，每条标注后端依赖状态：
- ✅ **已支持**：Phase 7 已完成，后端接口可直接用
- 🔧 **需适配**：后端有数据但没 API/BFF 接口，需开发
- 📦 **需新功能**：后端需开发新功能（标注 Phase）
- 🎨 **纯前端**：不需要后端，纯展示/交互

---

### 一、打开应用

| # | 场景 | 后端依赖 | 前端展示 |
|---|---|---|---|
| 1 | 选择项目（列出已有/新建/记住上次） | ✅ project-selector.ts | 项目卡片列表 + 搜索 |
| 2 | 项目间切换 | ✅ 每项目独立 db | 返回项目列表页 |
| 3 | 项目概览（状态/进度/待处理） | ✅ projectService.getProjectHomeView | 概览仪表盘 |
| 4 | 上次进度恢复（回到上次编辑位置） | 🎨 前端 localStorage | 自动定位光标 |

### 二、规划阶段（动笔前）

| # | 场景 | 后端依赖 | 前端展示 |
|---|---|---|---|
| 5 | 世界观构建（和 Agent 对话→蓝图） | ✅ blueprintService.generateBlueprintDraft | Agent 对话 + 蓝图预览 |
| 6 | 角色设计（描述→实体候选→属性建议） | ✅ entityService.detectEntityHints | 实体候选卡 + 属性表单 |
| 7 | 大纲规划（章节列表+梗概） | 📦 Phase 10 ChapterPlan | 大纲编辑器（树形） |
| 8 | 灵感收集（随手记→成熟度管理→转章节） | ✅ ideaService.captureIdea | 看板式灵感板 |
| 9 | 设定文档（世界观/角色/势力整理） | 🔧 需从 Core 数据生成设定集 | 文档视图（可导出） |

### 三、日常写作

| # | 场景 | 后端依赖 | 前端展示 |
|---|---|---|---|
| 10 | 写正文（编辑器直接写，心流不打断） | 🎨 TipTap 编辑器 | 主编辑区 |
| 11 | 光标上下文感知（写到角色→侧边显示设定） | 🔧 需 Agent 光标位置→实体匹配→设定查询 | 侧边动态信息面板 |
| 12 | 随时问 Agent（"王林师父是谁"→查 Core 秒回） | ✅ agent.processUserInput | Agent 对话面板 |
| 13 | 让 Agent 帮写（指令生成→预览→采用） | 🔧 需 Agent 正文生成（非事件推演） | 侧边预览区 + 采用按钮 |
| 14 | 选中改写（去AI味/风格/润色/扩缩写→对比→采用） | 🔧 需 Agent 文本加工接口 | 对比视图（原文 vs 改写） |
| 15 | 续写（基于前文+世界状态→预览→采用） | 🔧 需 Agent 续写接口 | 侧边预览区 |
| 16 | 查实体详情（点名字→详情卡→关闭继续写） | ✅ coreBridge.readCurrentWorldSnapshot | 浮动实体详情卡 |
| 17 | 查历史设定（"第7章写了什么"→出场记录→跳转） | ✅ Core 事件+Facts 有时间戳 | 出场时间线视图 |
| 18 | 临时记灵感（快捷键→记完继续写） | ✅ ideaService.captureIdea | 快捷输入浮窗 |
| 19 | 自动保存（30秒/失焦） | ✅ draftService.updateDraftContent | 无（静默保存） |
| 20 | 字数统计（当前章/全书/目标进度） | 🎨 纯前端计算 | 底部状态栏 |

### 四、写作中的智能反馈（不打断心流）

| # | 场景 | 后端依赖 | 前端展示 |
|---|---|---|---|
| 21 | 一致性微提示（写到矛盾→侧边标黄） | 🔧 需光标位置→实时规则检测 | 侧边标黄条目（可忽略） |
| 22 | 文笔微提示（重复用词/句式雷同） | 🔧 需 Agent 文笔分析 | 侧边轻提示 |
| 23 | 遗忘提醒（角色久未出场/伏笔超期） | 📦 Phase 11（伏笔追踪）+ ✅ 实体出场统计 | 侧边提醒列表 |
| 24 | 设定参考（写到"灰域"→显示定义和规则） | ✅ coreBridge.readCurrentWorldSnapshot | 侧边设定卡片 |
| 25 | 反馈强度可调（专注/标准/详细三档） | 🎨 纯前端设置 | 设置开关 |

### 五、章节完成与检查

| # | 场景 | 后端依赖 | 前端展示 |
|---|---|---|---|
| 26 | 章节检查（全章扫描：一致性+时序+文笔+伏笔） | 🔧 需 Agent 全章分析接口 | 检查结果清单 |
| 27 | 问题清单（🔴阻断/🟡建议/🔵提示） | 🔧 同上 | 分类列表 |
| 28 | 逐条处理（点问题→跳正文→修改/忽略） | 🎨 纯前端交互 | 正文高亮跳转 |
| 29 | 闪回/梦境标记（排除世界状态提取） | 🔧 需正文段落标记系统 | 段落标记按钮 |
| 30 | 重新检查 | 🔧 同 #26 | 清单刷新 |

### 六、提交世界状态变更

| # | 场景 | 后端依赖 | 前端展示 |
|---|---|---|---|
| 31 | 提取变更（Agent 从全章正文提取设定变更） | 🔧 需 Agent 正文→factChanges 提取 | 变更候选列表 |
| 32 | 审核页（人话 Diff + 涉及实体 + 规则检测） | ✅ coreBridge + buildProposalReviewData | 审核页六区域 |
| 33 | 选择性提交（勾选/排除变更） | 🔧 需支持部分提交（当前全量） | 勾选 UI |
| 34 | 确认提交→Core 更新→面板刷新 | ✅ coreBridge.commitReviewedProposal | 成功反馈 + 自动刷新 |
| 35 | 提交失败处理 | ✅ CoreBridge 失败分流 | 错误信息 + 重试 |

### 七、修改已完成章节

| # | 场景 | 后端依赖 | 前端展示 |
|---|---|---|---|
| 36 | 回改正文（打开旧章节修改） | 🎨 编辑器 + ✅ draftService | 编辑器 |
| 37 | 变更重新提取（改正文后提示重审核） | 🔧 需草稿变更检测 | 提示条 |
| 38 | 影响检查（后续章节受影响标黄） | 🔧 需跨章节影响分析 | 后续章节列表标黄 |
| 39 | Retcon（正式修改 Core 世界状态→影响分析→批量更新） | ✅ retconEngine（Core 层）+ 🔧 写作层 Retcon 审核页 | Retcon 影响图 + 确认 |

### 八、全局管理

| # | 场景 | 后端依赖 | 前端展示 |
|---|---|---|---|
| 40 | 世界状态总览 | ✅ coreBridge.readCurrentWorldSnapshot | 实体卡片网格 |
| 41 | 关系图（实体+关系+事件+伏笔+知识+候选+草案全连接） | 📦 Phase 8（WritingRelation + GraphView） | Cytoscape 可交互图 |
| 42 | 地图（空间布局/角色位置/可达性） | 📦 Phase 9（SpatialNode + MapView） | 可切换的空间图 |
| 43 | 时间线（事件按章节/角色行程/时序冲突） | 📦 Phase 10（ChapterPlan + TimelineView） | 水平时间轴 |
| 44 | 伏笔看板（状态/回收计划/超期） | 📦 Phase 11（ForeshadowingPlanner） | 看板式布局 |
| 45 | 读者视角（"读者在第N章知道什么"） | 📦 Phase 11（ReaderKnowledgeState） | 知识可见性矩阵 |
| 46 | 巡检报告（遗忘实体/超期伏笔/设定悬空/冲突） | 🔧 需 Agent 主动巡检接口 | 巡检报告页 |
| 47 | 审计日志 | ✅ auditService.list | 时间线列表 |

### 九、导入与导出

| # | 场景 | 后端依赖 | 前端展示 |
|---|---|---|---|
| 48 | 导入已有文稿（txt/docx→自动检测实体/设定） | 🔧 需导入解析+实体提取流水线 | 导入向导 |
| 49 | 导出正文（txt/docx/epub） | 🎨 纯前端（编辑器内容导出） | 导出选项 |
| 50 | 导出设定集（角色卡/世界观/关系图） | 🔧 需设定集生成 | 导出预览 |
| 51 | 项目备份（压缩包：db+正文+设定） | 🔧 需 BFF 文件打包 | 备份按钮 |
| 52 | 项目迁移（跨设备） | 🔧 需 BFF 文件上传/下载 | 迁移向导 |

### 十、协作与分享（后续扩展）

| # | 场景 | 后端依赖 | 前端展示 |
|---|---|---|---|
| 53 | 分享设定集（只读链接给编辑） | 📦 需分享服务 | 分享链接 |
| 54 | 审稿批注（编辑在正文标注） | 📦 需批注系统 | 正文批注层 |
| 55 | 多人协作（多人写不同章节） | 📦 需协作锁机制 | 协作状态指示 |
| 56 | 版本管理（世界状态版本回滚） | 🔧 Core 已有乐观锁版本号 | 版本时间线 |

### 十一、系统与设置

| # | 场景 | 后端依赖 | 前端展示 |
|---|---|---|---|
| 57 | 项目设置（标题/前提/状态/模式/提醒强度） | ✅ projectService.updateProjectMeta | 设置表单 |
| 58 | AI 模型配置（选模型/调参数） | 🔧 需运行时模型切换 | 配置面板 |
| 59 | 界面偏好（主题/字体/布局） | 🎨 纯前端 localStorage | 偏好面板 |
| 60 | 快捷键（帮写/改写/查实体/检查/提交） | 🎨 纯前端 | 快捷键设置 |

### 十二、异常与容错

| # | 场景 | 后端依赖 | 前端展示 |
|---|---|---|---|
| 61 | 网络断开（降级：规则引擎保留，Agent 暂停） | 🔧 需 BFF 断线检测+降级模式 | 离线指示器 |
| 62 | 数据损坏（备份恢复） | 🔧 需 BFF 备份/恢复 | 恢复向导 |
| 63 | 误操作恢复（提交后撤回） | ✅ retconEngine | 撤回确认 |
| 64 | 大项目性能（100万字+500实体不卡） | 🎨 虚拟滚动/懒加载/索引 | 无（透明优化） |

---

## 16. 后端依赖矩阵

### 16.1 可立即开发的前端功能（后端已就绪 ✅）

这些功能的后端接口在 Phase 7 已完成并经 CLI 验证：

| 功能 | 后端接口 | 场景编号 |
|---|---|---|
| 项目选择/创建/切换 | project-selector.ts | #1, #2 |
| 项目概览 | projectService.getProjectHomeView | #3 |
| 世界观→蓝图 | blueprintService.generateBlueprintDraft/accept | #5 |
| 实体检测→审核→注册 | entityService + coreBridge | #6, #16 |
| 灵感管理 | ideaService.captureIdea/discard | #8, #18 |
| 写正文+自动保存 | draftService.createDraft/updateDraftContent | #10, #19 |
| Agent 对话 | agent.processUserInput | #12 |
| 世界状态快照 | coreBridge.readCurrentWorldSnapshot | #24, #40 |
| 审核页 | coreBridge.commitReviewedProposal + buildProposalReviewData | #32, #34, #35 |
| Retcon | retconEngine | #39, #63 |
| 审计日志 | auditService.list | #47 |
| 项目设置 | projectService.updateProjectMeta | #57 |

### 16.2 需开发 BFF/API 适配的功能（后端有数据，需接口 🔧）

| 功能 | 需要开发 | 场景编号 |
|---|---|---|
| 光标上下文感知 | BFF WebSocket（光标位置→实体匹配→设定查询） | #11 |
| Agent 帮写/改写/续写 | 新 API（正文生成/文本加工，非事件推演） | #13, #14, #15 |
| 章节检查 | 新 API（全章正文→一致性+文笔分析） | #26, #27, #30 |
| 变更提取 | 新 API（全章正文→factChanges 候选） | #31 |
| 选择性提交 | 改 commitReviewedProposal 支持部分变更 | #33 |
| 闪回/梦境标记 | 正文段落标记系统（前端+后端存储） | #29 |
| 跨章节影响分析 | 新 API（改第N章→检查后续章节影响） | #38 |
| 巡检报告 | 新 API（Agent 主动扫描全项目） | #46 |
| 设定集生成/导出 | 从 Core 数据生成设定文档 | #9, #50 |
| 导入解析 | txt/docx 解析→实体提取流水线 | #48 |
| 备份/迁移 | BFF 文件打包/上传/下载 | #51, #52 |
| AI 模型运行时切换 | LLMClient 支持动态切换 | #58 |

### 16.3 需新功能开发的前置依赖（后端需 Phase 8-11 📦）

| 功能 | 后端依赖 | 场景编号 | Phase |
|---|---|---|---|
| 关系图 | WritingRelation + GraphView 数据模型 | #41 | Phase 8 |
| 地图/空间视图 | SpatialNode + SpatialEdge + MapView | #42 | Phase 9 |
| 大纲/章节管理 | ChapterPlan + ScenePlan | #7 | Phase 10 |
| 时间线 | TimelineView + 角色行程 | #43 | Phase 10 |
| 伏笔看板 | ForeshadowingPlanner + Thread 追踪增强 | #23, #44 | Phase 11 |
| 读者视角 | ReaderKnowledgeState + Knowledge 可见性 | #45 | Phase 11 |
| 协作/分享 | 分享服务 + 批注系统 + 协作锁 | #53-55 | 后续 |

### 16.4 纯前端功能（不需要后端 🎨）

| 功能 | 场景编号 |
|---|---|
| 上次进度恢复（localStorage） | #4 |
| 字数统计 | #20 |
| 反馈强度调节 | #25 |
| 问题清单逐条处理（高亮跳转） | #28 |
| 导出正文（txt/docx/epub） | #49 |
| 界面偏好（主题/字体/布局） | #59 |
| 快捷键 | #60 |
| 大项目性能优化（虚拟滚动等） | #64 |

---

## 17. Agent 助手完整能力规格

### 17.1 被动回答（作者问了才答）

| 能力 | 输入 | 输出 | 后端依赖 |
|---|---|---|---|
| 查实体信息 | "王林的师父是谁" | 实体名+关系+设定摘要 | ✅ agent.processUserInput |
| 查历史设定 | "第7章写了什么" | 出场记录时间线 | ✅ Core 事件查询 |
| 查关系 | "张三和谁有关系" | 关系列表 | 📦 Phase 8 |
| 影响分析 | "把第5章境界改成金丹影响什么" | 受影响章节+内容列表 | 🔧 Retcon 影响分析 |

### 17.2 主动反馈（上下文感知，不打断心流）

| 能力 | 触发条件 | 反馈内容 | 后端依赖 |
|---|---|---|---|
| 实体设定显示 | 光标停在角色名附近 | 该角色当前状态/位置/关系 | 🔧 光标→实体匹配 |
| 一致性提示 | 正文出现与 Core 矛盾的内容 | "⚠️ 佩剑已在第8章碎裂" | 🔧 实时规则检测 |
| 文笔提示 | 正文段落完成 | "连续5句以'他'开头" | 🔧 文笔分析 |
| 遗忘提醒 | 角色长时间未出场 | "李四已15章未出场" | ✅ 实体出场统计 |
| 伏笔提醒 | 伏笔超期 | "第8章预言已超期" | 📦 Phase 11 |
| 设定参考 | 正文出现已定义概念 | 显示该概念的定义和规则 | ✅ Core 快照 |

**关键原则**：所有主动反馈都是**侧边显示**，不弹窗、不阻止写作、不要求确认。作者可以完全忽略。反馈强度三档可调（专注/标准/详细）。

### 17.3 生成与加工

| 能力 | 输入 | 输出 | 后端依赖 |
|---|---|---|---|
| 帮写段落 | 指令（"写一段追逐戏"）| 正文段落→预览→采用 | 🔧 正文生成 API |
| 续写 | 前文+世界状态 | 续写段落→预览→采用 | 🔧 续写 API |
| 选中改写 | 选中文字+改写类型 | 改写后文本→对比→采用 | 🔧 文本加工 API |
| 章节检查 | 全章正文+世界快照 | 问题清单（🔴🟡🔵） | 🔧 全章分析 API |
| 变更提取 | 全章正文 | factChanges 候选 | 🔧 提取 API |

**关键原则**：所有生成结果都**先预览，作者决定是否采用**。不直接插入编辑器或修改 Core。

### 17.4 Agent 能力与前端的交互模式

```
┌─────────────────────────────────────────────────┐
│ 编辑器（写作区）                                   │
│                                                  │
│  正文内容...                                      │
│  沈墨走到[沈墨]废弃站台 ← 写到角色名时自动标记      │
│                                                  │
│                                  ┌──────────────┐│
│                                  │ 侧边动态面板  ││
│                                  │              ││
│                                  │ 📋 沈墨      ││
│                                  │ 状态：义肢发热 ││
│                                  │ 位置：废弃站台 ││
│                                  │ 境界：筑基期  ││
│                                  │ 关系：沈笙(妹) ││
│                                  │              ││
│                                  │ ⚠️ 佩剑已在   ││
│                                  │ 第8章碎裂     ││
│                                  └──────────────┘│
│                                                  │
│ ┌─────────────────────────────────────────────┐ │
│ │ 💬 Agent 对话（可折叠）                       │ │
│ │ 用户：王林的师父是谁？                        │ │
│ │ Agent：张三丰，第3章出场，金丹期修士           │ │
│ │                                              │ │
│ │ [帮写] [改写] [续写] [检查] [提交]            │ │
│ └─────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────┘
```

---

## 18. 章节写作完整流程（修订版）

基于讨论收敛的最终流程：

### 18.1 流程图

```
新建章节 → 写正文（心流不打断）→ 章节检查 → 提取变更 → 审核 → 提交
                                    ↑                    │
                                    └── 修正后重新检查 ───┘
```

### 18.2 各阶段详解

**阶段 1：新建章节**
- 左栏章节列表点"+"，输入章节号+标题
- 系统创建 WritingDraft（status=drafting），绑定章节号
- 光标进入编辑器，右侧面板进入"写作辅助模式"

**阶段 2：写正文（核心阶段，零干扰）**
- 直接写、让 Agent 帮写、选中改写、续写
- 侧边动态显示当前段落的实体设定（只显示不确认）
- 一致性微提示（标黄，不打断）
- Agent 对话随时可用（查设定/问问题）
- 自动保存

**阶段 3：章节检查**
- 点"章节检查"→ Agent 全章扫描
- 结果分类：🔴阻断（矛盾）/ 🟡建议（一致性+文笔）/ 🔵提示（伏笔+风格）
- 逐条处理（跳转正文→修改/忽略）
- 闪回/梦境标记（排除提取）
- 可重新检查

**阶段 4：提取变更**
- 点"提取变更"→ Agent 从全章正文提取设定变更候选
- 变更列表（实体/属性/旧值→新值）
- 作者勾选/排除（去掉梦境/闪回/比喻）
- 生成 ProposalView

**阶段 5：审核提交**
- 审核页六区域展示（摘要/Diff/涉及实体/规则警告/知识影响/决策）
- 规则引擎硬阻断必须先解决
- 确认→commitReviewedProposal→Core 更新→全局面板刷新
- 章节状态→committed

### 18.3 特殊情况处理

| 情况 | 处理 |
|---|---|
| 纯过渡章节（无设定变更） | 跳过提取+审核，直接标记 committed |
| 一章多次提交 | 允许（每次提取部分变更，分批提交） |
| 不提交直接写下一章 | 允许（提示"上一章变更未提交"，但不强制） |
| 闪回/梦境 | 标记后排除提取；不进 Core |
| 多视角章节 | Agent 按段落视角分组提取变更 |
| 修改已提交的章节 | 重新提取+重审核+影响检查（后续章节标黄） |

---

## 19. 关系图完整规格

### 19.1 节点类型

| 类型 | 来源 | 图标 | 示例 |
|---|---|---|---|
| 角色 | Core 已注册实体 | 👤 | 沈墨、沈笙 |
| 地点 | Core 已注册实体 | 🗺️ | 废弃站台 |
| 物品 | Core 已注册实体 | 💎 | 黑晶碎片 |
| 概念/组织 | Core 已注册实体 | 💡 | 灰域、青云门 |
| 事件 | Core 已提交事件 | ⚡ | 发现黑晶碎片 |
| 伏笔 | NarrativeThread | 🔮 | 神秘预言 |
| 候选实体 | 写作层 hint/candidate | ❓ | 未审批的角色 |
| 草案 | WritingDraft | 📄 | 第一章 |
| 章节 | ChapterPlan（Phase 10） | 📑 | 第1章 |

### 19.2 边类型

| 类型 | 来源 | 示例 | 后端依赖 |
|---|---|---|---|
| 正式关系 | Core Fact（relation 谓词） | 沈墨 —[师兄]→ 张三 | 📦 Phase 8 |
| 位置关系 | Core Fact（location） | 沈墨 —[位于]→ 废弃站台 | ✅ |
| 事件参与 | Core Event subject/fact | 沈墨 —[参与]→ 发现黑晶事件 | ✅ |
| 伏笔关联 | Thread.relatedEntities | 预言 —[关联]→ 沈墨 | ✅ |
| 出处关联 | 草案/正文→实体引用 | 第一章 —[提及]→ 沈墨 | 🔧 |
| 知识关联 | Knowledge（谁知道什么） | 沈笙 —[知晓]→ 沈墨秘密 | 📦 Phase 11 |
| 候选关系 | hint 状态的关系 | 沈墨 ?-[疑似师徒]→ 神秘人 | 📦 Phase 8 |
| 视图关联 | 前端手动标记 | 作者拖线标记隐秘关系 | 🎨 |

### 19.3 视图模式

| 模式 | 显示内容 | 后端依赖 |
|---|---|---|
| world（世界全景） | 全实体+全关系+全事件 | 📦 Phase 8 |
| relationship（人物关系） | 角色+角色关系 | 📦 Phase 8 |
| spatial（空间图） | 地点+可达性+角色位置 | 📦 Phase 9 |
| timeline（时间线） | 事件按章节排列+角色行程 | 📦 Phase 10 |
| thread（伏笔图） | 伏笔节点+依赖网络 | 📦 Phase 11 |
| proposal（影响图） | 某事件影响的实体+Fact | ✅（可从 ProposalView 生成） |

### 19.4 节点来源层级颜色

| 层级 | 颜色 | 含义 |
|---|---|---|
| committed | 🟢 绿色 | 已提交到 Core |
| candidate | 🟡 黄色 | 候选中 |
| draft | 🔵 蓝色 | 草案中 |
| hint | ⚪ 灰色 | 线索 |
| association | 🟣 紫色 | 视图关联（非正式） |
| deprecated | 🔴 红色 | 已废弃 |

### 19.5 交互

- 拖动节点调整布局（保存为前端状态，不写 Core）
- 过滤器（类型/状态/来源层）
- 点击节点→详情抽屉
- 点击边→来源与证据
- 从图谱跳转到正文/草案/审核页
- 保存视图布局+过滤器为预设

### 19.6 实际使用场景

| 场景 | 操作 |
|---|---|
| 看人物关系网 | 切 relationship 模式，看角色间的连线 |
| 找孤立角色 | 全景图扫一眼，无连线的节点 |
| 查事件影响 | 点事件→proposal 模式→看影响范围 |
| 查伏笔依赖 | thread 模式→看伏笔依赖哪些 Fact |
| 检查关系断裂 | 某实体改了→相关边标黄"这条关系可能已失效" |

---

## 20. 前端开发优先级（修订版）

基于场景清单 + 后端依赖分析，修订开发优先级：

### 第一阶段：核心可用（后端已就绪的部分）

目标：替代 CLI，让作者能在 Web 上完成完整写作闭环。

**必须**：
- BFF 骨架（Express + REST + WebSocket）
- 项目选择/创建
- 概览页
- 实体管理（列表+详情+审核动线）
- 草案列表（只读，不含富文本编辑器）
- Agent 对话面板（WebSocket 流式）
- 审核页（人话 Diff + 确认提交）
- 世界状态快照
- 灵感板
- 蓝图面板
- 审计日志

### 第二阶段：写作体验

目标：让作者能真正在 Web 上写小说。

- TipTap 富文本编辑器
- 章节管理
- 光标上下文感知（侧边动态设定显示）
- Agent 帮写/改写/续写（正文生成 API）
- 一致性微提示（侧边标黄）
- 字数统计
- 自动保存
- 布局保存
- 移动端基础适配

### 第三阶段：检查与提交

目标：章节级检查和提交流程。

- 章节检查（全章扫描 API）
- 问题清单（🔴🟡🔵）
- 变更提取
- 闪回/梦境标记
- 选择性提交

### 第四阶段：可视化（依赖 Phase 8-11）

- 关系图 [依赖 Phase 8]
- 地图/空间视图 [依赖 Phase 9]
- 时间线 [依赖 Phase 10]
- 伏笔看板 [依赖 Phase 11]
- 读者视角 [依赖 Phase 11]
- 巡检报告

### 第五阶段：协作与生态

- 导入已有文稿
- 导出正文/设定集
- 项目备份/迁移
- 分享/审稿/协作
- 版本管理

---

## 附录 B：场景 → 后端依赖汇总统计

| 后端状态 | 场景数 | 占比 |
|---|---|---|
| ✅ 已支持（Phase 7） | 22 | 34% |
| 🔧 需适配（BFF/新 API） | 18 | 28% |
| 📦 需新功能（Phase 8-11） | 14 | 22% |
| 🎨 纯前端 | 10 | 16% |

**结论**：第一阶段（核心可用）覆盖 34% 的场景，第二+三阶段（写作体验+检查提交）覆盖到 62%，剩余 38% 需要 Phase 8-11 或协作功能支撑。

---

## 21. 数据结构（前端 ↔ BFF ↔ 后端）

本章定义前端每个页面/组件需要的**完整数据结构**，以及它与后端 service/Core 的关联。

### 21.1 项目概览数据

```typescript
// GET /api/projects/:projectId/overview
interface ProjectOverview {
  project: {
    id: string;
    title: string;
    premise: string;
    status: 'planning' | 'drafting' | 'reviewing' | 'paused' | 'archived';
    workspaceMode: 'planning' | 'writing' | 'reviewing' | 'analysis' | 'importing';
    currentChapter: number;        // 当前写到第几章
    totalWordCount: number;        // 全书累计字数（超大规模需增量统计）
    version: number;               // 世界状态版本（乐观锁）
    createdAt: string;
    updatedAt: string;
  };
  stats: {
    entityCount: number;           // 已注册实体总数
    candidateCount: number;        // 候选实体数（hint+candidate）
    draftCount: number;            // 草案数
    pendingDecisionCount: number;  // 待确认事项数
    proposalViewCount: number;     // 审核视图数
    ideaCount: number;             // 灵感数（非归档）
    goalCount: number;             // 目标数
    chapterCount: number;          // 章节数
    foreshadowingCount: number;    // 伏笔数 [Phase 11]
    overdueForeshadowingCount: number; // 超期伏笔数 [Phase 11]
  };
  recentActivity: Array<{          // 最近审计记录（摘要）
    timestamp: string;
    action: string;
    summary: string;
    result: 'success' | 'failure' | 'partial';
  }>;
  worldSnapshot: {                 // 世界快照摘要（不含详情，点击加载）
    totalEntities: number;
    totalFacts: number;
    totalEvents: number;
  };
}

// 后端关联：projectService.getProjectHomeView + writingStore 统计 + auditService.list
// 注意：超大规模（500+万字）下 stats 不能每次全表 COUNT，需缓存或增量维护
```

### 21.2 实体管理数据

```typescript
// GET /api/projects/:projectId/entities?status=registered&type=角色&page=1&limit=50
interface EntityListResponse {
  entities: EntityListItem[];
  total: number;
  page: number;
  limit: number;
  // 分组统计（用于侧栏徽标）
  counts: {
    byStatus: Record<string, number>;   // { registered: 120, candidate: 5, hint: 3 }
    byType: Record<string, number>;     // { 角色: 45, 地点: 30, 物品: 20, ... }
  };
}

interface EntityListItem {
  id: string;                      // 写作层 sketch id（wesk_xxx）
  displayName: string;
  typeLabel: string;               // 人话类型（"角色"/"地点"）
  status: 'hint' | 'candidate' | 'approved' | 'registered' | 'deprecated' | 'merged' | 'error';
  summary?: string;
  coreEntityId?: string;           // 仅 debug 模式返回
  attributeCount: number;          // 已注册的 Fact 数（超大规模需索引优化）
  lastAppearChapter?: number;      // 最后出场章节（遗忘检测用）
  aliases: string[];
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

// GET /api/projects/:projectId/entities/:id （详情）
interface EntityDetail {
  entity: EntityListItem;
  // Core 投影（经 §5 过滤，人话展示）
  profile: {
    attributes: Array<{
      predicateLabel: string;      // 人话谓词（"位置"/"境界"/"状态"）
      value: string;               // 人话值
      updatedAt: string;
      sourceEvent?: string;        // 来源事件摘要
    }>;
    profileMarkdown: string;       // Core 渲染的 Markdown 档案（已掩码技术字段）
  };
  // 出场记录（事件时间线）
  appearances: Array<{
    chapter: number;
    eventSummary: string;
    eventDescription: string;
    timestamp: string;
  }>;
  // 关系列表 [Phase 8]
  relations: Array<{
    targetEntityName: string;
    relationLabel: string;         // 人话关系（"师兄"/"敌人"/"位于"）
    sourceLayer: 'committed' | 'candidate' | 'hint';
    direction: 'directed' | 'bidirectional';
  }>;
  // 关联草案
  linkedDrafts: Array<{
    id: string;
    title: string;
    chapter: number;
  }>;
}

// 后端关联：
// entityService + writingStore.listEntitySketches（分页+过滤）
// coreBridge.readCurrentWorldSnapshot（属性+档案）
// Core 事件查询（出场记录）
// 超大规模：listEntitySketches 需加分页+索引；attributeCount 需缓存
```

### 21.3 草案与正文数据

```typescript
// GET /api/projects/:projectId/drafts?status=drafting&page=1
interface DraftListResponse {
  drafts: DraftListItem[];
  total: number;
}

interface DraftListItem {
  id: string;
  title: string;
  chapter: number;
  kind: string;                    // event/scene/chapter
  status: 'drafting' | 'ready_to_simulate' | 'simulated' | 'committed' | 'archived' | 'error';
  wordCount: number;
  linkedProposalViewId?: string;   // 关联的审核视图（有待审提案时）
  version: number;                 // 乐观锁版本
  updatedAt: string;
}

// GET /api/projects/:projectId/drafts/:id （编辑器加载）
interface DraftDetail {
  id: string;
  title: string;
  chapter: number;
  content: string;                 // 正文全文（TipTap ProseMirror JSON 或 HTML）
  contentFormat: 'tiptap' | 'html' | 'plaintext';
  wordCount: number;
  status: string;
  version: number;
  // 正文中的实体引用（光标感知用——预计算索引）
  entityReferences: Array<{
    entityId: string;
    displayName: string;
    position: { start: number; end: number };  // 在正文中的字符位置
    typeLabel: string;
  }>;
  // 场景分隔（一段正文可能含多个场景）
  scenes?: Array<{
    title?: string;
    startOffset: number;
    endOffset?: number;
    perspective?: string;          // 视角角色
    location?: string;             // 场景地点
    timeOfDay?: string;            // 时间
  }>;
}

// PATCH /api/projects/:projectId/drafts/:id （自动保存）
interface DraftUpdateRequest {
  content?: string;                // 新正文
  title?: string;
  version: number;                 // 乐观锁（防并发覆盖）
}

// 后端关联：
// draftService.createDraft/updateDraftContent/listDrafts
// entityReferences 需前端编辑器实时维护（TipTap 插件扫描正文匹配实体名）
// 超大规模：正文可能 10万字/章 × 500章 = 500万字。需分页加载（只加载当前章+前后章）
```

### 21.4 审核与提案数据

```typescript
// GET /api/projects/:projectId/proposals?status=open
interface ProposalListResponse {
  proposals: ProposalListItem[];
  total: number;
}

interface ProposalListItem {
  id: string;                      // PV id（wpvw_xxx）
  status: 'open' | 'author_approved' | 'committed' | 'commit_failed' | 'expired';
  humanSummary: string;
  factDiffCount: number;
  ruleWarningCount: number;
  blockerCount: number;            // 🔴 阻断级警告数
  sourceDraftTitle?: string;
  chapter: number;
  createdAt: string;
}

// GET /api/projects/:projectId/proposals/:id （审核详情）
interface ProposalDetail {
  id: string;
  status: string;
  proposalType: 'event' | 'entity_registration';
  coreProposalId?: string;         // 仅 debug
  chapter: number;

  // Zone 1: 来源
  source: {
    draftTitle?: string;
    draftId?: string;
    chapter: number;
    type: string;
  };

  // Zone 2: 人话摘要
  humanSummary: string;

  // Zone 3: 事实变更（人话 Diff）
  factDiff: Array<{
    op: 'new' | 'updated' | 'retracted';
    entityName: string;            // 人话实体名
    predicateLabel: string;        // 人话谓词
    newValue: string;
    oldValue?: string;
    humanDescription: string;      // "新增：沈墨 的位置 = 废弃站台"
    selected: boolean;             // 作者是否勾选（选择性提交用）
  }>;

  // Zone 4: 涉及实体 + 规则警告
  involvedEntities: Array<{
    name: string;
    typeLabel: string;
    coreEntityId?: string;         // 仅 debug
  }>;
  ruleWarnings: Array<{
    level: 'blocker' | 'warning' | 'info';
    message: string;
    sourceRuleId?: string;
  }>;

  // Zone 5: 决策状态
  isSafeToCommit: boolean;         // 规则引擎判定
  canSubmit: boolean;              // 前端综合判定（有 blocker 则 false）

  // Zone 6: 提交结果（提交后填充）
  commitResult?: {
    success: boolean;
    coreEventId?: string;
    error?: {
      code: string;
      humanMessage: string;
      isRecoverable: boolean;
    };
  };
}

// POST /api/projects/:projectId/proposals/:id/commit
interface CommitRequest {
  // 选择性提交：只提交勾选的 factDiff 项
  selectedFactDiffIndices?: number[];
}

// 后端关联：
// coreBridge.commitReviewedProposal + buildProposalReviewData
// 选择性提交需改 commitReviewedProposal 支持部分 factChanges（当前全量）
// 超大规模：一个事件可能涉及 100+ Fact 变更（如"战争"事件），需分页展示
```

### 21.5 Agent 对话数据

```typescript
// WebSocket 消息协议

// → 前端发送
interface AgentInputMessage {
  type: 'agent_input';
  projectId: string;
  text: string;                    // 用户输入
  context?: {
    currentChapter: number;
    cursorPosition?: number;       // 光标在正文中的位置（光标感知用）
    selectedText?: string;         // 选中的正文（改写用）
    selectedOperation?: 'rewrite' | 'expand' | 'compress' | 'de_ai' | 'style_adjust';
    styleHint?: string;            // 风格提示（"更紧张"/"更抒情"）
    draftId?: string;              // 当前编辑的草案
  };
}

// ← BFF 推送（流式）
interface AgentStreamMessage {
  type: 'agent_token';             // 逐 token 推送
  content: string;
}
interface AgentToolCallMessage {
  type: 'agent_tool_call';
  toolName: string;                // 'detect_entity_hints' / 'propose_event' / 'get_context_slice'
  status: 'started' | 'success' | 'error';
  result?: {
    summary: string;               // 人话结果摘要
    candidates?: EntityCandidate[];// 检测到的实体候选
    proposalId?: string;           // 产出的提案 ID
  };
}
interface AgentCompleteMessage {
  type: 'agent_complete';
  fullContent: string;             // 完整回复
  usage?: {                        // token 统计
    prompt_tokens: number;
    completion_tokens: number;
  };
  // Agent 产出的正文（帮写/续写/改写）
  generatedText?: string;
  generatedTextType?: 'new_paragraph' | 'rewrite' | 'continuation';
}

// 后端关联：
// agent.processUserInput（WebSocket 包装，流式推送 token）
// 光标感知：BFF 接收 cursorPosition → 查实体 → 推送设定到侧边
// 改写：BFF 接收 selectedText + operation → 调 LLM → 推送改写结果
// 超大规模：对话历史可能很长（多轮），需 context 压缩（已有 ContextCompressor）
```

### 21.6 世界状态快照数据

```typescript
// GET /api/projects/:projectId/world?chapter=15&page=1&limit=50&type=角色
interface WorldSnapshotResponse {
  currentChapter: number;
  totalEntities: number;
  entities: Array<{
    name: string;
    typeLabel: string;
    attributeCount: number;
    attributes: Array<{            // 展开（点击实体时加载）
      predicateLabel: string;
      value: string;
      chapter: number;             // 从哪章开始有效
    }>;
    error?: string;                // 读取失败
  }>;
  recentEvents: Array<{
    eventId: string;
    chapter: number;
    description: string;
    timestamp: string;
    factCount: number;
  }>;
}

// 后端关联：
// coreBridge.readCurrentWorldSnapshot（聚合所有实体的 get_context_slice）
// 超大规模（500+实体）：不能一次全查！需分页+懒加载：
//   - 列表页只显示 name + typeLabel + attributeCount（轻量查询）
//   - 点击展开才查具体属性（按需 get_context_slice）
//   - 或用 Core 新增"批量快照"接口（避免 N+1 查询）
```

### 21.7 关系图数据

```typescript
// GET /api/projects/:projectId/graph?mode=relationship&filter[type]=角色&filter[layer]=committed&page=1&limit=200
interface GraphResponse {
  mode: 'world' | 'relationship' | 'spatial' | 'timeline' | 'thread' | 'proposal';
  nodes: GraphNode[];
  edges: GraphEdge[];
  total: number;                   // 总节点数（可能数十万）
  filtered: number;                // 过滤后的节点数
  layout: {                        // 保存的布局（前端状态）
    positions: Record<string, { x: number; y: number }>;
  };
}

interface GraphNode {
  id: string;
  label: string;                   // 显示名
  type: 'character' | 'location' | 'item' | 'concept' | 'event' | 'thread' | 'draft' | 'chapter';
  sourceLayer: 'committed' | 'candidate' | 'draft' | 'hint' | 'association' | 'view';
  statusLabel?: string;            // 状态标签
  attributeCount?: number;
}

interface GraphEdge {
  id: string;
  label: string;                   // 关系标签（"师兄"/"位于"/"参与"）
  sourceNodeId: string;
  targetNodeId: string;
  sourceLayer: 'committed' | 'candidate' | 'draft' | 'hint' | 'association' | 'view';
  direction: 'directed' | 'bidirectional' | 'undirected' | 'hierarchical';
}

// 后端关联：📦 Phase 8（WritingRelation + Core Fact→GraphView 投影）
// 超大规模（数十万关系）：
//   - 不能一次加载全部节点+边
//   - 必须支持服务器端过滤+分页
//   - 图渲染用 WebGL（Cytoscape WebGL renderer / deck.gl），DOM 渲染 >1000 节点会卡
//   - LOD（Level of Detail）：远看只显示节点（无边），放大才加载边
//   - 聚类：自动聚类相关节点（如"青云门"的所有弟子聚成一个超级节点）
//   - 增量加载：拖拽/缩放时按视口范围加载
```

### 21.8 章节检查数据

```typescript
// POST /api/projects/:projectId/check?draftId=xxx
interface ChapterCheckRequest {
  draftId: string;
  chapter: number;
  content: string;                 // 全章正文
  // 闪回/梦境标记（排除检查的段落）
  excludedRanges?: Array<{
    start: number;
    end: number;
    reason: 'flashback' | 'dream' | 'metaphor' | 'other';
  }>;
}

interface ChapterCheckResponse {
  issues: Array<{
    id: string;
    level: 'blocker' | 'warning' | 'info';
    category: 'setting_conflict' | 'timeline_paradox' | 'character_consistency' | 'writing_quality' | 'foreshadowing' | 'knowledge_violation';
    message: string;               // 人话描述
    location?: {                   // 在正文中的位置
      start: number;
      end: number;
      excerpt: string;             // 相关正文摘录
    };
    suggestion?: string;           // 建议修改
    relatedEntity?: string;        // 涉及的实体名
    canIgnore: boolean;            // 是否可忽略（blocker 也可标记闪回忽略）
    resolved: boolean;             // 作者是否已处理
  }>;
  summary: {
    totalIssues: number;
    blockerCount: number;
    warningCount: number;
    infoCount: number;
    canProceed: boolean;           // 是否可以进入提取变更阶段
  };
}

// 后端关联：🔧 需新 API
// 规则引擎硬检测（deadEntityConstraint + settingConflictConstraint）做确定性检查
// Agent 做软检测（角色一致性/文笔/伏笔——需全章正文+世界快照喂给 LLM）
// 超大规模：全章可能 1-3 万字，加上世界状态上下文，单次 LLM 调用 token 可能超限
//   → 分段检查（按场景/段落分批送 LLM）
//   → 或用 RAG（从世界状态检索相关 Fact，而非全量注入）
```

### 21.9 变更提取数据

```typescript
// POST /api/projects/:projectId/extract?draftId=xxx
interface ExtractRequest {
  draftId: string;
  chapter: number;
  content: string;
  excludedRanges?: Array<{ start: number; end: number; reason: string }>;
}

interface ExtractResponse {
  changes: Array<{
    id: string;
    selected: boolean;             // 默认 true，作者可取消勾选
    subject: string;               // 实体名（人话）
    subjectId: string;             // 实体 ID（用于 commit）
    predicate: string;             // 谓词
    predicateLabel: string;        // 人话谓词
    op: 'assert' | 'update' | 'retract';
    value: string;
    oldValue?: string;
    humanDescription: string;      // "新增：沈墨 的位置 = 废弃站台"
    confidence: number;            // Agent 提取置信度
    sourceExcerpt: string;         // 正文中的依据摘录
  }>;
  summary: string;                 // "本章包含 4 项设定变更"
}

// 后端关联：🔧 需新 API
// Agent 从正文提取 factChanges（需理解正文语义+对照世界状态）
// 超大规模：提取需精确定位正文中的设定变更，不能全量扫描
//   → 先用实体名索引定位"涉及实体的段落"
//   → 只对这些段落做语义分析
```

---

## 22. 交互逻辑详述（每个操作的完整流程）

### 22.1 实体注册完整交互

```
用户输入正文或与 Agent 对话
  ↓
Agent 调用 detect_entity_hints
  ↓
BFF WebSocket 推送：agent_tool_call { toolName: 'detect_entity_hints', candidates: [...] }
  ↓
前端：右侧 Agent 面板显示"检测到 3 个实体线索"
  ↓
前端：左侧导航"实体"徽标 +3（闪烁提示）
  ↓
用户点击实体导航 → 进入实体列表页
  ↓
列表显示：3 个 [hint] 状态的实体（灰底）
  ↓
用户点击某个实体 → 详情卡
  ↓
详情卡显示：名字/类型/来源摘录/操作按钮 [批准]
  ↓
用户点击 [批准]
  ↓
前端：PATCH /entities/:id/approve
  ↓
BFF：entityService.promoteHintToSketch + approveCandidate
  ↓
状态：hint → candidate → approved + 创建 PendingDecision
  ↓
前端：实体卡变黄色 [candidate] → 绿色 [approved]
  ↓
前端：顶部"待确认"徽标 +1
  ↓
用户点击"待确认" → 进入审核页
  ↓
审核页显示：确认登记实体「沈墨」
  ↓
用户点 [确认]
  ↓
前端：POST /proposals/:id/commit
  ↓
BFF：coreBridge.registerReviewedEntity → Core 写入
  ↓
前端：成功反馈 ✅ → 世界状态面板自动刷新
  ↓
/world 实体数 +1 → /entities 沈墨变为 [registered]（绿底）
```

**异常处理**：
- 批准失败（状态不对）→ 红色错误提示 + 建议操作
- 确认注册失败（Core FK 约束等）→ 红色错误 + 重试按钮
- 实体重名 → 黄色警告"已存在同名实体，改用合并？"

### 22.2 章节写作→检查→提交完整交互

```
用户在章节列表点 [+] → 输入"第2章：灰域深处"
  ↓
前端：POST /drafts { title, chapter: 2 }
  ↓
BFF：draftService.createDraft → status=drafting
  ↓
前端：编辑器打开空白文档，光标聚焦
  ↓
—— 写作阶段（可能持续数小时）——
  ↓
用户写正文...
  ↓
（每 30 秒）：前端：PATCH /drafts/:id { content, version } → 自动保存
  ↓
（光标移动）：前端维护 entityReferences 索引
  ↓
（写到"沈墨"）：前端匹配实体名 → 侧边面板自动显示沈墨的当前设定
  ↓
（写到"佩剑"）：前端匹配实体名 → 侧边标黄"⚠️ 佩剑已在第8章碎裂"
  ↓
（用户问 Agent）："王林现在什么境界？" → WebSocket → Agent 回答
  ↓
（用户让 Agent 帮写）："写一段沈墨发现黑晶碎片的场景" → WebSocket
  ↓
BFF：Agent 生成正文段落 → 推送 generatedText
  ↓
前端：侧边预览区显示生成内容 + [采用] [修改] [丢弃] 按钮
  ↓
用户点 [采用] → 插入到编辑器光标位置
  ↓
—— 章节检查阶段 ——
  ↓
用户点 [章节检查] 按钮
  ↓
前端：POST /check { draftId, chapter, content }
  ↓
BFF：规则引擎硬检测 + Agent 软检测（全章扫描）
  ↓
前端：显示问题清单
  ↓
用户逐条处理：
  - 🔴 "沈墨佩剑已碎裂" → 点问题 → 跳到正文位置 → 修改正文 → 标记"已修正"
  - 🟡 "连续5句以他开头" → 标记"已知，不改"
  - 🔵 "伏笔'神秘预言'已超期" → 标记"后续章节回收"
  ↓
用户点 [重新检查] → 清单刷新 → 🔴 清零
  ↓
—— 提取变更阶段 ——
  ↓
用户点 [提取变更]
  ↓
前端：POST /extract { draftId, chapter, content }
  ↓
BFF：Agent 从正文提取设定变更候选
  ↓
前端：显示变更列表（4 条）
  ↓
用户检查：
  - ✅ 沈墨 location → 废弃站台（保留）
  - ✅ 沈墨 status → 义肢发热（保留）
  - ✅ 沈笙 ability → 灰域退缩（保留）
  - ❌ "沈墨死了"（这是比喻，取消勾选）
  ↓
用户点 [生成审核]
  ↓
前端：用勾选的变更生成 ProposalView → 跳转审核页
  ↓
—— 审核提交阶段 ——
  ↓
审核页显示六区域（摘要/Diff/实体/警告/影响/决策）
  ↓
用户检查：
  - 规则警告：✅ 无 blocker
  - 涉及实体：沈墨、沈笙
  - Diff：3 条变更（已勾选的）
  ↓
用户点 [确认提交]
  ↓
前端：POST /proposals/:id/commit { selectedFactDiffIndices: [0,1,2] }
  ↓
BFF：coreBridge.commitReviewedProposal → Core 写入
  ↓
前端：✅ 成功！事件 ID：evt_xxx
  ↓
自动刷新：/world 实体属性更新 + /drafts 状态→committed + /audit 新增记录
```

### 22.3 光标上下文感知交互

```
作者在编辑器里移动光标
  ↓
TipTap 编辑器 onSelectionUpdate 回调
  ↓
前端：提取光标附近的文字（前后 50 字符）
  ↓
前端：匹配 entityReferences 索引（本地，无网络请求）
  ↓
匹配到"沈墨"？
  ├── 是 → 侧边面板更新：
  │         ├── 显示沈墨的当前设定（从缓存的世界快照读取，无网络请求）
  │         ├── 显示"⚠️"标记（如果有未解决的提示）
  │         └── 可点击查看详情（点击才发网络请求）
  └── 否 → 侧边面板显示通用写作提示（或空白）
  ↓
（光标继续移动）→ 重复上述流程
  ↓
关键：日常光标移动不发任何网络请求（全部用本地缓存数据）
  ↓
只有以下情况发网络请求：
  - 作者点击实体名查看详情（GET /entities/:id）
  - 作者主动问 Agent（WebSocket）
  - Agent 主动推送（WebSocket onmessage）
```

### 22.4 Agent 帮写交互

```
作者在右侧 Agent 面板输入：
"帮我写沈墨在灰域深处发现一块黑晶碎片的场景，要紧张氛围"
  ↓
前端：WebSocket 发送 agent_input { text, context: { draftId, chapter } }
  ↓
BFF：Agent 处理（带上当前正文上下文 + 世界状态快照）
  ↓
BFF → 前端：流式推送 agent_token（逐字显示生成内容）
  ↓
生成完成：agent_complete { generatedText, generatedTextType: 'new_paragraph' }
  ↓
前端：侧边预览区显示生成的段落
  ├── [采用] → 插入编辑器光标位置 → 预览区关闭
  ├── [修改] → 预览区变为可编辑 → 作者修改后 [采用]
  ├── [重新生成] → 重发请求（换一个版本）
  └── [丢弃] → 关闭预览区
```

### 22.5 选中改写交互

```
作者在编辑器选中一段文字（如"沈墨快步走向碎片，捡了起来。"）
  ↓
右键 → 改写菜单（或快捷键 Cmd+R）
  ↓
菜单选项：
  - ✨ 去 AI 味
  - 🎭 风格调整 → 子菜单：更紧张/更抒情/更简洁/更幽默
  - 💎 润色优化
  - 📝 扩写（更详细）
  - ✂️ 缩写（更精炼）
  ↓
作者选"去 AI 味"
  ↓
前端：WebSocket 发送 agent_input {
  context: {
    selectedText: "沈墨快步走向碎片，捡了起来。",
    selectedOperation: 'de_ai'
  }
}
  ↓
BFF：Agent 改写（保留原意，调整文风）
  ↓
前端：对比视图（左原文 / 右改写）+ [采用] [再改] [丢弃]
  ↓
作者点 [采用] → 替换编辑器中选中的文字
```

---

## 23. 超大规模优化策略（500+万字 / 数十万关系）

### 23.1 数据加载策略

| 场景 | 数据量 | 策略 |
|---|---|---|
| 正文加载 | 单章 1-3 万字 | 只加载当前章+前后章，其余按需 |
| 实体列表 | 可能 1000+ 实体 | 分页（50/页）+ 虚拟滚动 + 按类型/状态过滤 |
| 世界快照 | 1000+ 实体 × N 属性 | 懒加载（列表只显示 name+count，点击才查属性）|
| 关系图 | 数十万节点+边 | 服务器端过滤+分页 + LOD（远看无边）+ WebGL 渲染 |
| 审计日志 | 可能数万条 | 分页 + 按时间/操作类型过滤 |
| Agent 上下文 | 可能超 token 限制 | RAG 检索相关 Fact（不全量注入）+ ContextCompressor |
| 正文中实体引用 | 单章可能引用 50+ 实体 | 本地索引（编辑器实时维护，无网络请求）|

### 23.2 渲染性能

| 场景 | 瓶颈 | 方案 |
|---|---|---|
| 关系图（10万+节点） | DOM 渲染崩溃 | WebGL（Cytoscape WebGL / deck.gl / PixiJS）|
| 正文编辑器（单章 3万字） | 大文档卡顿 | TipTap 支持虚拟滚动（只渲染可视区域段落）|
| 实体列表（1000+项） | 列表渲染慢 | vue-virtual-scroller 虚拟滚动 |
| 世界快照网格 | 大量卡片渲染 | 虚拟滚动 + 图片懒加载 |
| 审计日志 | 大量文本行 | 虚拟滚动 |

### 23.3 查询性能（后端）

| 场景 | 当前问题 | 优化方案 |
|---|---|---|
| listEntitySketches 全表扫描 | 1000+ 实体慢 | 加索引（status + typeLabel + project_id 联合索引）|
| readCurrentWorldSnapshot N+1 | 1000 实体 = 1000 次 get_context_slice | 新增批量快照接口（一次查全部实体的当前 Fact）|
| 关系图查询 | 数十万关系 JOIN 慢 | 图数据库（如 LanceDB 已有向量，可扩展图索引）或预计算 |
| 统计计数（COUNT(*)） | 全表 COUNT 慢 | 增量维护统计缓存（插入/删除时更新计数器表）|
| 正文搜索 | 500 万字全文搜索慢 | 倒排索引（SQLite FTS5 或 Elasticsearch）|
| 实体出场记录 | 遍历事件查 subject | events 表加 subject 索引 + 物化视图 |

### 23.4 存储策略

| 数据 | 量级 | 策略 |
|---|---|---|
| 正文 | 500 万字 ≈ 10-15MB | 单个 db 文件可承受（SQLite 上限 140TB）|
| Facts | 可能 10 万+ | SQLite 索引优化 + LanceDB 向量 |
| 实体 | 可能 1000+ | 无压力 |
| 关系 | 可能数十万 | 需图索引或预计算（Phase 8 设计时要考虑）|
| 向量 | 10 万 Fact × 1024 维 ≈ 400MB | LanceDB 支持分片 |
| 审计日志 | 可能数万条 | 定期归档（>6 个月的移到冷存储）|
| 正文历史版本 | 每章多版本 | 增量 diff 存储（非全量保存）|

### 23.5 Agent 调用优化

| 场景 | 问题 | 方案 |
|---|---|---|
| 全章检查 token 超限 | 3 万字正文 + 世界状态 > 32K token | 分段检查（按场景/段落）+ RAG（只检索相关 Fact）|
| 变更提取 token 超限 | 同上 | 先用实体名索引定位段落，只分析相关段落 |
| 光标感知延迟 | 每次光标移动查 Core | 本地缓存世界快照（定期刷新，不用实时查）|
| Agent 对话历史过长 | 多轮对话累积超 token | ContextCompressor（已有）+ 滑动窗口 |
| 关系图推理 | 数十万关系的推理超时 | 分层推理（先查直接关系，再扩展间接关系）|

---

## 附录 C：BFF 层完整 API 路由表（修订版）

### C.1 项目管理

| Method | Path | 说明 | 后端 Service |
|---|---|---|---|
| GET | /api/projects | 列出所有项目 | project-selector listProjects |
| POST | /api/projects | 创建项目 | projectService.createProject |
| GET | /api/projects/:projectId | 项目详情 | projectService.getProject |
| GET | /api/projects/:projectId/overview | 概览仪表盘 | projectService.getProjectHomeView + stats |
| PATCH | /api/projects/:projectId | 更新元信息 | projectService.updateProjectMeta/setWorkspaceMode/transitionProjectStatus |
| DELETE | /api/projects/:projectId | 归档项目 | projectService.archiveProject |

### C.2 实体管理

| Method | Path | 说明 | 后端 Service |
|---|---|---|---|
| GET | /api/projects/:projectId/entities | 实体列表（分页+过滤） | writingStore.listEntitySketches |
| GET | /api/projects/:projectId/entities/:id | 实体详情（档案+出场+关系） | coreBridge.readCurrentWorldSnapshot + Core 查询 |
| POST | /api/projects/:projectId/entities/detect | 检测实体线索 | entityService.detectEntityHints |
| PATCH | /api/projects/:projectId/entities/:id/promote | hint→candidate | entityService.promoteHintToSketch |
| PATCH | /api/projects/:projectId/entities/:id/approve | candidate→approved | entityService.approveCandidate |
| PATCH | /api/projects/:projectId/entities/:id/deprecate | 废弃实体 | entityService.deprecateEntitySketch |

### C.3 草案与正文

| Method | Path | 说明 | 后端 Service |
|---|---|---|---|
| GET | /api/projects/:projectId/drafts | 草案列表 | draftService.listDrafts |
| POST | /api/projects/:projectId/drafts | 创建草案 | draftService.createDraft |
| GET | /api/projects/:projectId/drafts/:id | 草案详情（正文+引用索引） | draftService.getDraft + 前端维护引用 |
| PATCH | /api/projects/:projectId/drafts/:id | 更新正文（自动保存） | draftService.updateDraftContent |
| DELETE | /api/projects/:projectId/drafts/:id | 废弃草案 | draftService.abandonDraft |

### C.4 章节检查与变更提取

| Method | Path | 说明 | 后端 Service |
|---|---|---|---|
| POST | /api/projects/:projectId/check | 章节检查 | 🔧 规则引擎 + Agent 全章分析 |
| POST | /api/projects/:projectId/extract | 变更提取 | 🔧 Agent 正文→factChanges |

### C.5 审核与提交

| Method | Path | 说明 | 后端 Service |
|---|---|---|---|
| GET | /api/projects/:projectId/proposals | 审核视图列表 | writingStore.listProposalViews |
| GET | /api/projects/:projectId/proposals/:id | 审核详情 | coreBridge + buildProposalReviewData |
| POST | /api/projects/:projectId/proposals/:id/commit | 确认提交 | coreBridge.commitReviewedProposal |
| POST | /api/projects/:projectId/proposals/:id/resim | 重新推演 | coreBridge.simulateProposal |

### C.6 世界状态

| Method | Path | 说明 | 后端 Service |
|---|---|---|---|
| GET | /api/projects/:projectId/world | 世界快照（分页） | coreBridge.readCurrentWorldSnapshot |
| GET | /api/projects/:projectId/world/:entityName | 单实体档案 | coreBridge.readCurrentWorldSnapshot（单实体） |
| GET | /api/projects/:projectId/pending | 待确认事项 | workflowService.listPendingDecisions |
| POST | /api/projects/:projectId/pending/:id/resolve | 处理待确认 | workflowService.resolvePendingDecision |

### C.7 灵感/目标/蓝图

| Method | Path | 说明 | 后端 Service |
|---|---|---|---|
| GET/POST | /api/projects/:projectId/ideas | 灵感列表/新建 | ideaService.listIdeaCards/captureIdea |
| DELETE | /api/projects/:projectId/ideas/:id | 归档灵感 | ideaService.discardIdea |
| GET/POST | /api/projects/:projectId/goals | 目标列表/新建 | projectService.listAuthorGoals/updateAuthorGoal |
| GET | /api/projects/:projectId/blueprint | 蓝图查看 | writingStore.getLatestBlueprint |
| POST | /api/projects/:projectId/blueprint/generate | 生成蓝图草案 | blueprintService.generateBlueprintDraft |
| POST | /api/projects/:projectId/blueprint/accept | 激活蓝图 | blueprintService.acceptBlueprintDraft |

### C.8 图谱/地图/时间线

| Method | Path | 说明 | 后端依赖 |
|---|---|---|---|
| GET | /api/projects/:projectId/graph | 关系图数据（分页+过滤） | 📦 Phase 8 |
| GET | /api/projects/:projectId/map | 空间图数据 | 📦 Phase 9 |
| GET | /api/projects/:projectId/timeline | 时间线数据 | 📦 Phase 10 |
| GET | /api/projects/:projectId/foreshadowing | 伏笔看板 | 📦 Phase 11 |
| GET | /api/projects/:projectId/reader | 读者知识状态 | 📦 Phase 11 |

### C.9 审计与巡检

| Method | Path | 说明 | 后端 Service |
|---|---|---|---|
| GET | /api/projects/:projectId/audit | 审计日志（分页+过滤） | auditService.list |
| POST | /api/projects/:projectId/inspect | 巡检报告 | 🔧 Agent 主动巡检 |

### C.10 WebSocket 事件

| Event | 方向 | 说明 |
|---|---|---|
| agent_input | → | 作者发送消息/指令 |
| agent_token | ← | Agent 流式回复（逐 token） |
| agent_tool_call | ← | Agent 工具调用进度 |
| agent_complete | ← | Agent 回复完成（含 usage + 生成文本） |
| cursor_context | → | 光标位置变化（光标感知） |
| entity_suggestion | ← | 侧边实体设定推送（基于光标位置） |
| consistency_warning | ← | 一致性提示推送 |
| pending_update | ← | 待确认数量变化 |
| audit_update | ← | 新审计记录 |

### C.11 导入导出

| Method | Path | 说明 | 后端依赖 |
|---|---|---|---|
| POST | /api/projects/:projectId/import | 导入文稿 | 🔧 解析+提取流水线 |
| GET | /api/projects/:projectId/export | 导出正文 | 🔧 docx/epub 需排版引擎 |
| GET | /api/projects/:projectId/export/settings | 导出设定集 | 🔧 设定集生成 |
| GET | /api/projects/:projectId/backup | 项目备份 | 🔧 文件打包 |

### C.12 搜索

| Method | Path | 说明 | 后端依赖 |
|---|---|---|---|
| GET | /api/projects/:projectId/search?q=&type=&chapter=&page= | 全局搜索 | 🔧 FTS5 倒排索引 |

### C.13 系统与版本

| Method | Path | 说明 | 后端依赖 |
|---|---|---|---|
| GET | /api/version | 版本与能力协商（Core 版本/写作层版本/feature flags） | 🔧 |
| GET | /api/projects/:projectId/usage | Agent token 用量统计 | ✅ trace usage 已支持 |

---

## 24. 错误处理与恢复（P0 必补）

### 24.1 编辑器崩溃与数据恢复

**问题**：作者可能写了几小时上万字，编辑器崩溃/标签页关闭/系统重启。

**方案**：
- TipTap 内容每 5 秒写入 `localStorage`（轻量，不等网络）
- 自动保存到 BFF 每 30 秒（重量，含乐观锁版本号）
- 启动时检测"本地有比服务端 version 更新的草稿"：
  - 弹出恢复对话框："检测到未保存的本地草稿（3 分钟前），是否恢复？"
  - [恢复] → 加载本地版本 → 标记为"需同步"
  - [丢弃] → 删除本地版本 → 加载服务端版本
- BFF 不可达时（离线）：正文只存本地，底栏显示"离线模式（本地保存）"
- 恢复联网后：自动同步本地积攒的内容

### 24.2 同步状态指示器

```typescript
type SyncStatus = 'synced' | 'syncing' | 'offline' | 'conflict' | 'error';
```

| 状态 | 视觉 | 含义 | 作者需做什么 |
|---|---|---|---|
| synced | ✅ 绿色圆点 | 已保存到服务端 | 无 |
| syncing | ⏳ 旋转图标 | 正在保存 | 无 |
| offline | 📴 灰色 | 离线模式（本地保存） | 联网后会自动同步 |
| conflict | ⚠️ 黄色 | 乐观锁冲突（别处改了） | 点击查看冲突详情 |
| error | ❌ 红色 | 保存失败 | 点击重试或手动保存到本地 |

底栏点击 → 展开同步详情面板（最近保存时间/失败次数/本地未同步内容量）

### 24.3 Agent 超时与中断

**WebSocket 协议扩展**：

```typescript
// 新增 WS 事件
interface AgentErrorMessage {
  type: 'agent_error';
  error: {
    code: 'timeout' | 'llm_error' | 'tool_failed' | 'rate_limit' | 'context_too_long';
    message: string;
    partialResult?: string;    // 流式中断时已生成的部分内容（保留还是丢弃由作者决定）
  };
}
interface AgentCanceledMessage {
  type: 'agent_canceled';     // 作者点了"停止生成"
  reason: 'user_canceled';
}

// 前端 → BFF：取消生成
interface CancelAgentMessage {
  type: 'cancel_agent';
  requestId: string;
}
```

**前端处理**：
- Agent 超时（60 秒无 token）→ 显示"Agent 响应超时"+ [重试] [取消] 按钮
- 流式中断 → 已生成部分内容保留在预览区 + "生成中断，是否采用已生成的部分？"
- 作者点"停止生成" → 发 cancel_agent → BFF 中断 LLM 流
- rate_limit → "请求过于频繁，请稍等" + 倒计时重试
- context_too_long → "当前上下文过长，请先压缩历史或缩小范围"

### 24.4 LLM 幻觉处理

**变更提取的置信度处理**：

| confidence | 视觉 | 行为 |
|---|---|---|
| ≥ 0.8 | 正常显示 | 默认勾选 |
| 0.5-0.8 | 🟡 黄色标记"低置信度" | 默认勾选但标注，作者可取消 |
| < 0.5 | 🔴 红色标记"Agent 不确定" | 默认不勾选 |

**Agent 输出与 Core 冲突的拦截**：
- 变更提取时，每条 factChange 与 Core 现有 Fact 比对
- 如果 Agent 提取的 subject 不存在 → 标红"实体未注册，需先 approve"
- 如果 op=update 但 oldValue 不匹配 → 标红"Agent 记录的旧值与实际不符"

**作者纠错反馈**：
- 每条变更/检查结果旁有 [反馈] 按钮
- 点击 → "这个判断错了" → 选择错误类型（实体搞错/属性搞错/虚构内容/其他）
- 反馈存入 audit_log，供后端调优 evals

### 24.5 并发编辑冲突

**乐观锁冲突处理**（HTTP 409 version mismatch）：

```
作者 A 在编辑器保存 → version=5 → 成功
作者 B（另一标签页）也保存 → version=5（过期）→ 409 冲突
  ↓
前端弹出冲突对话框：
  "该草案在别处已被修改（2 分钟前），你的保存未成功。"
  [查看差异] [覆盖对方版本] [放弃我的修改] [合并]
  ↓
[查看差异] → 双栏 Diff（我的版本 vs 服务端版本）
[覆盖] → 用我的版本提交（version 强制更新）
[放弃] → 加载服务端版本
[合并] → 手动选择保留哪些段落
```

**跨标签页实时同步**：
- 用 `BroadcastChannel` 在同源标签页间广播编辑状态
- 标签页 A 在编辑第 2 章 → 标签页 B 打开第 2 章 → B 显示"该草案正在另一处编辑"
- B 切换为只读模式或打开其他章节

### 24.6 提交失败错误码映射表

| 错误码 | 人话 | 可重试 | 重试前操作 |
|---|---|---|---|
| UNSAFE_PROPOSAL | "提案包含严重矛盾，无法提交" | ❌ | 先解决 🔴 blocker 问题 |
| STALE_PROPOSAL | "世界状态已变更，请重新推演" | ✅ | 点"重新推演" |
| VERSION_CONFLICT | "版本冲突，请刷新" | ✅ | 重新加载 |
| PROPOSAL_NOT_FOUND | "提案已过期或被删除" | ❌ | 重新提取变更 |
| SOURCE_DRAFT_MODIFIED | "来源草案已被修改" | ❌ | 重新提取变更 |
| FK_CONSTRAINT | "涉及未注册实体" | ❌ | 先 approve 对应实体 |
| INTERNAL_ERROR | "系统内部错误" | ✅ | 直接重试 |

---

## 25. 搜索系统（P0 必补——500 万字项目的生命线）

### 25.1 全局搜索入口

**位置**：顶栏中央搜索框（类似 VSCode Cmd+K / Notion 的 quick search）

**快捷键**：`Cmd+K` / `Ctrl+K`

**交互**：
```
作者按 Cmd+K
  ↓
弹出搜索面板（覆盖层，居中）
  ↓
输入关键词（如"灰域入口"）
  ↓
实时搜索（防抖 300ms）
  ↓
结果分组显示：
  📄 正文命中（3 处）
    第 12 章 · "...他们终于找到了灰域入口..."
    第 45 章 · "...灰域入口处的守卫..."
  👤 实体命中（1 处）
    灰域入口 [地点] · 第 12 章首次定义
  ⚡ 事件命中（2 处）
    发现灰域入口 · 第 12 章
    守卫灰域入口 · 第 45 章
  📋 设定命中（1 处）
    灰域 · 概念 · "灰域入口是灰域最薄弱的点..."
  ↓
点击结果 → 跳转到对应位置
  - 正文命中 → 打开编辑器，滚动到命中位置，高亮
  - 实体命中 → 打开实体详情页
  - 事件命中 → 打开时间线或审核页
  - 设定命中 → 打开世界状态快照，定位到该 Fact
```

### 25.2 搜索 API

```typescript
// GET /api/projects/:projectId/search?q=灰域入口&type=all&chapter=&page=1
interface SearchResponse {
  query: string;
  total: number;
  results: Array<{
    type: 'content' | 'entity' | 'event' | 'setting' | 'idea' | 'audit';
    id: string;
    title: string;              // 章节标题/实体名/事件摘要
    excerpt: string;            // 命中上下文（高亮关键词）
    highlightRange?: { start: number; end: number };
    chapter?: number;
    jumpTarget: {               // 跳转目标
      view: 'editor' | 'entity' | 'timeline' | 'world' | 'audit';
      params: Record<string, string>;
    };
  }>;
}
```

### 25.3 后端搜索实现

- **正文搜索**：SQLite FTS5（全文索引），建在 writing_drafts.content 上
- **实体搜索**：writing_entity_sketches 的 displayName + aliases + summary 模糊匹配
- **事件搜索**：events 表的 description 模糊匹配
- **设定搜索**：facts 表的 value + embedding_text 模糊匹配（或向量语义搜索）
- 超大规模：FTS5 支持百万级文档，性能足够；语义搜索走 LanceDB

---

## 26. 通知系统

### 26.1 通知中心

**位置**：顶栏铃铛图标 🔔（带未读数徽标）

**通知类型**：

| 类型 | 触发 | 示例 |
|---|---|---|
| 任务完成 | Agent 异步任务结束 | "章节检查完成：发现 2 个 blocker" |
| 提案就绪 | Agent 产出新提案 | "新提案：第一章设定变更（4 条）" |
| 巡检报告 | 定期巡检完成 | "巡检：2 个实体久未出场，1 个伏笔超期" |
| 提交结果 | 提交成功/失败 | "✅ 第一章已提交" / "❌ 提交失败：版本冲突" |
| 系统通知 | 版本升级/迁移 | "项目数据已升级到 v2" |

**交互**：
- 点击通知 → 跳转到对应结果页
- 批量已读/清除
- 离线期间的通知积累，重连后回流

### 26.2 写作模式下的通知降级

| 工作模式 | 通知行为 |
|---|---|
| writing（写作） | 只弹 blocker 级（如"提交失败"）；其余只更新徽标 |
| reviewing（审核） | 全部正常通知 |
| planning（规划） | 全部正常通知 |
| 专注模式 | 全部静音（只更新徽标，不弹窗不闪烁） |

---

## 27. 权限与部署形态

### 27.1 部署形态决策

**当前定位**：单机本地应用（Tauri 桌面端）

```
作者电脑
├── Tauri 应用（前端 + BFF 同进程）
│   ├── 前端（Vue，WebView 渲染）
│   ├── BFF（Node.js，嵌入 Tauri sidecar 或独立进程）
│   └── Core 引擎 + 写作层（直接 TS 调用，不需 HTTP）
└── 本地文件系统
    └── data/projects/<项目名>/cli.db
```

**无 auth**——本地应用不需要登录。项目文件就是"归属"。

### 27.2 分享/只读模式（后续扩展）

**只读模式行为**：

| 操作 | 正常模式 | 只读模式 |
|---|---|---|
| 查看实体/世界状态/关系图 | ✅ | ✅ |
| 搜索 | ✅ | ✅ |
| 导出 | ✅ | ✅ |
| 编辑正文 | ✅ | ❌（只读） |
| 提交变更 | ✅ | ❌（按钮隐藏） |
| Agent 对话 | ✅ | ✅（只查不改） |
| 审核/确认 | ✅ | ❌ |

### 27.3 Agent 权限边界

| Agent 能做 | Agent 不能做 |
|---|---|
| 查询实体状态（get_context_slice） | 直接提交到 Core（commit_event） |
| 检测实体线索（detect_entity_hints） | 直接注册实体（register_entity） |
| 推演事件（propose_event，沙盒） | 跳过审核流程 |
| 生成正文/改写（文本加工） | 删除/修改已提交的 Fact（不经 Retcon） |
| 章节检查/变更提取（分析） | 替换编辑器正文（不经作者确认） |

运行时由 `isToolForbiddenForAgent` + `assertAgentMayCall` 强制（Phase 7 已实现）。

---

## 28. 版本协商与数据迁移

### 28.1 版本协商

```typescript
// BFF 启动时
GET /api/version → {
  coreVersion: '7.0.0',
  writingLayerVersion: '7.0.0',
  features: {
    relationGraph: false,    // Phase 8 未完成
    spatialMap: false,       // Phase 9
    timeline: false,         // Phase 10
    foreshadowing: false,    // Phase 11
  }
}
```

前端按 feature flag 决定哪些导航项可用——不可用的灰显并 tooltip "此功能尚在开发中"。

### 28.2 数据库迁移

打开旧项目时：
1. 检测 db schema 版本（`PRAGMA user_version`）
2. 如版本旧 → 自动执行迁移脚本（`ALTER TABLE` / `CREATE INDEX`）
3. 迁移期间显示"项目升级中..."（全屏遮罩）
4. 迁移失败 → 回滚 + 提示"项目升级失败，请联系支持" + 导出备份

---

## 29. 组件级设计

### 29.1 核心复用组件

```typescript
// 来源层标签（全文档 6 种颜色，统一一个组件）
interface SourceLayerBadgeProps {
  layer: 'committed' | 'candidate' | 'draft' | 'hint' | 'association' | 'deprecated';
  size?: 'sm' | 'md' | 'lg';
  showLabel?: boolean;
}

// 实体卡片（列表/网格/迷你三种变体）
interface EntityCardProps {
  variant: 'list' | 'grid' | 'mini';
  entity: EntityListItem;
  onClick?: () => void;       // → 详情
  actions?: VNode;        // slot: approve/deprecate 按钮
}

// 人话 Diff 行
interface HumanDiffRowProps {
  op: 'new' | 'updated' | 'retracted';
  entityName: string;
  predicateLabel: string;
  newValue: string;
  oldValue?: string;
  selected?: boolean;         // 选择性提交
  onSelectChange?: (selected: boolean) => void;
  confidence?: number;        // 低置信度标黄
}

// 问题清单条目
interface IssueItemProps {
  level: 'blocker' | 'warning' | 'info';
  category: string;
  message: string;
  excerpt?: string;
  suggestion?: string;
  resolved: boolean;
  onResolve?: () => void;
  onJumpToContent?: () => void;
}

// Agent 消息气泡
interface AgentMessageProps {
  role: 'user' | 'agent';
  content: string;
  isStreaming?: boolean;       // 流式渲染中
  toolCalls?: Array<{          // 工具调用进度
    name: string;
    status: 'started' | 'success' | 'error';
    result?: string;
  }>;
  generatedText?: {            // Agent 生成的正文
    text: string;
    type: 'new' | 'rewrite' | 'continuation';
    onAdopt?: () => void;
    onModify?: () => void;
    onDiscard?: () => void;
  };
}

// 正文中的实体标记（TipTap Mark）
interface EntityMentionMark {
  type: 'entityMention';
  attrs: {
    entityId: string;
    displayName: string;
    typeLabel: string;
  };
}
// 悬浮卡：鼠标悬停 → 显示实体当前设定卡片
// 点击 → 打开实体详情抽屉
// 歧义处理：同名实体 → 显示候选列表让作者选

// 空状态
interface EmptyStateProps {
  icon: VNode;
  title: string;
  description: string;
  action?: { label: string; onClick: () => void };
}

// 加载骨架屏
interface SkeletonProps {
  variant: 'list' | 'grid' | 'editor' | 'graph';
  count?: number;
}
```

### 29.2 审核流程状态机

```
open → (作者审核) → author_approved → (提交) → committed
                                     ↘ commit_failed → (修复) → author_approved
open → (作者拒绝) → author_rejected
open → (来源草案修改) → expired
committed → (Retcon) → retracted

blocker 存在时：提交按钮禁用
暂存：保存当前审核进度（已查看的步骤），下次恢复
```

---

## 30. 快捷键体系

### 30.1 全局快捷键

| 快捷键 | 操作 | 说明 |
|---|---|---|
| Cmd/Ctrl+K | 全局搜索 | 弹出搜索面板 |
| Cmd/Ctrl+P | 切换项目 | 项目选择页 |
| Cmd/Ctrl+1..9 | 切换主导航 | 概览/写作/设定/关系图/... |
| Cmd/Ctrl+B | 收起/展开左栏 | |
| Cmd/Ctrl+Shift+B | 收起/展开右栏 | Agent 面板 |
| Cmd/Ctrl+, | 打开设置 | |
| Cmd/Ctrl+/ | 显示快捷键帮助 | |
| Esc | 关闭弹窗/面板 | |

### 30.2 编辑器快捷键

| 快捷键 | 操作 |
|---|---|
| Cmd/Ctrl+S | 强制保存 |
| Cmd/Ctrl+Enter | 提交章节（触发检查→提取→审核流程）|
| Cmd/Ctrl+Shift+C | 章节检查 |
| Cmd/Ctrl+Shift+E | 提取变更 |
| Cmd/Ctrl+/ | Agent 帮写（光标位置续写）|
| Cmd/Ctrl+R | 选中改写 |
| Cmd/Ctrl+Shift+F | 正文内搜索 |

### 30.3 Agent/审核快捷键

| 快捷键 | 操作 |
|---|---|
| Cmd/Ctrl+Enter | 发送 Agent 消息 |
| J / K | 审核步骤间移动（上/下） |
| Enter | 确认审核 |
| Esc | 暂存审核 / 取消 Agent 生成 |

### 30.4 IME 冲突处理

- 中文输入法 composing 期间（拼音未确认）屏蔽所有快捷键
- 监听 `compositionstart`/`compositionend` 事件
- composing 中按 Enter 确认拼音，不触发提交

---

## 31. 加载状态与空状态规范

### 31.1 加载状态

| 场景 | 加载组件 | 说明 |
|---|---|---|
| 页面首次加载 | 骨架屏（Skeleton） | 模拟最终布局，减少布局跳动 |
| 列表分页加载 | 底部加载条 + 旋转图标 | |
| Agent 流式响应 | 逐字渲染 + 打字机光标 | |
| 关系图加载 | 居中旋转 + "加载 N 个节点..." | |
| 审核页加载 | 分步骨架（先摘要后 Diff） | |

### 31.2 空状态

每个页面/面板的空状态设计：

| 页面 | 空状态文案 | 引导操作 |
|---|---|---|
| 概览（新项目） | "开始你的创作之旅" | [描述世界观] 按钮 |
| 实体列表 | "还没有任何实体" | [与 Agent 对话描述角色] |
| 草案列表 | "还没有开始写作" | [新建第一章] |
| 灵感板 | "灵感来了就记下来" | [新建灵感] |
| 审核页 | "暂无待审核提案" | 无（正常状态）|
| 关系图 | "实体注册后这里会显示关系网络" | [去注册实体] |
| 世界状态 | "世界还是一片空白" | [开始写作] |

---

## 32. 撤销/重做体系

### 32.1 正文编辑撤销

- TipTap 自带 ProseMirror 的 undo/redo（Cmd+Z / Cmd+Shift+Z）
- 撤销深度可配置（默认 100 步）

### 32.2 系统操作撤销

| 操作 | 可撤销 | 方式 |
|---|---|---|
| 实体 approve | ❌ | 需 deprecate（不可逆回到 candidate） |
| 提案 commit | ✅ | Retcon（回滚事件） |
| 实体 deprecate | ✅ | 恢复状态（Phase 8 可考虑） |
| 草案 abandon | ✅ | 恢复状态（drafting → archived 可逆） |
| 灵感 discard | ✅ | ideaService.restoreIdea |
| 项目归档 | ✅ | 恢复项目 |

**撤销 UI**：操作成功后的 toast 带 [撤销] 按钮（5 秒内可点）

---

## 33. 批量操作

### 33.1 批量审核

- 审核列表支持多选（checkbox）
- 选中多个 → [批量确认] / [批量拒绝]
- 批量确认：逐个提交，显示进度条（"3/5 已提交"）
- 某个失败：暂停，显示失败项，作者处理后继续

### 33.2 批量实体操作

- 实体列表多选 → [批量 approve] / [批量 deprecate]
- 按类型/状态批量操作（如"所有 hint 状态的实体 → 批量 approve"）

---

## 34. 性能监控

### 34.1 前端性能采集

| 指标 | 采集方式 | 目标值 |
|---|---|---|
| 编辑器按键延迟 | Performance API（keydown→paint） | < 16ms（60fps）|
| Agent 首 token 延迟 | WS agent_input→agent_token | < 3s |
| API 响应时间 | fetch 包装计时 | P95 < 500ms |
| 关系图渲染帧率 | requestAnimationFrame | > 30fps |
| 首屏加载 | Performance API | < 2s |

### 34.2 崩溃报告

- Vue errorCaptured 兜底：
  ```
  😵 编辑器发生错误
  你的内容已自动保存到本地。
  [恢复内容] [重新加载] [导出错误日志]
  ```
- 崩溃日志存 localStorage（最近 10 次）
- 可导出崩溃日志供排查

### 34.3 Agent 用量仪表盘

- 按操作类型统计（帮写/改写/检查/提取/对话）
- 按章节统计 token 消耗
- 按天统计成本估算
- 用量预警（超过阈值时提醒）

---

## 35. 国际化预留

**当前决策**：只做中文，但架构预留 i18n。

- UI 文案用 vue-i18n（key→中文映射）
- Core 返回的 label（typeLabel/predicateLabel/relationLabel）已有翻译层
- 不做英文/繁体版本，但文案不硬编码进组件

---

## 36. 可访问性 a11y

### 36.1 键盘导航

- 所有交互元素可 Tab 聚焦，焦点环可见
- 审核页用 focus trap（Tab 不跳出对话框）
- 关系图提供替代的列表视图（节点列表+边列表，键盘可导航）

### 36.2 ARIA 标注

- Agent 流式回复用 `aria-live="polite"`（屏幕阅读器实时朗读）
- 加载状态用 `aria-busy`
- 来源层标签用 `aria-label` 描述

### 36.3 高对比度

- 深色主题 + 高对比度模式（WCAG AA 对比度 ≥ 4.5:1）
- 来源层颜色在高对比度模式下加图案/纹理辅助区分（不只靠颜色）




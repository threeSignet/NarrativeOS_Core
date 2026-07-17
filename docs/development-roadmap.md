# 开发路线图（迭代式）

> 本文档是 NarrativeOS_Core 后续开发的总路线图。采用**小步迭代 + 深度检查 + 修复 + 触发下一步**的循环模式。
> 每个迭代完成的标准：代码落地 + 测试/验证通过 + 提交 + 在本表更新状态。
> 迭代纪律：一次只做一个可独立验证的小步子，不做大跃进。

## 当前基线（2026-07-17）

- **后端**：写作层 Phase 7-12 完成，929/929 测试绿。23 个 service 全部就绪。
- **前端**：基建阶段完成（12 个 Ui 组件 + 4 插件迁移 + panelView 契约）。92/92 运行时验证通过。
- **前端覆盖**：只接出 7 个 service（project/document/entity/relation/graph/workflow + 部分 import-export）。
- **待接前端**：14 个 service 沉睡在后端。

## 迭代原则

1. **小步子**：一个迭代只做 1 个 service 的前端闭环，或 1 个跨模块小功能。
2. **深度检查**：每个迭代结束跑 vue-tsc + vitest + Playwright 运行时验证，全绿才算完成。
3. **修复优先**：验证暴露的 bug 立即修，不积压。
4. **触发下一步**：当前迭代完成后，立即探索并启动下一个迭代，不停顿。

## 路线图

### 阶段 A · 章节正文闭环（产品核心价值）

目标：让工具能写小说。从"设定管理器"变成"写小说工具"。

| 迭代 | 主题 | 涉及 service | 完成标准 | 状态 |
|---|---|---|---|---|
| **A1** | ChapterService 接前端：章节列表 + CRUD | chapter | 章节活动栏 + 侧栏章节列表 + 新建/改名/排序/状态推进；vue-tsc 0 + Playwright 验证 | ✅ 完成 |
| A2 | ProseService 接前端：章节正文编辑 | prose | 章节下挂正文块；复用 TipTap 编辑器；自动保存 | ✅ 完成 |
| A3 | 章节正文联动：点章节 → 打开正文 | chapter + prose | 章节树点章节 → 主区打开该章正文编辑器 | ✅ 被 A2 吸收 |
| A4 | DraftService 轻接：章节草案 | draft | 章节可关联草案；草案基本 CRUD（不含 Agent 共写） | 待开始 |

### 阶段 B · 创意源头（灵感与蓝本）

目标：让作者能捕捉灵感、管理世界观蓝本。

| 迭代 | 主题 | 涉及 service | 完成标准 | 状态 |
|---|---|---|---|---|
| B1 | IdeaService 接前端：灵感卡片池 | idea | 灵感活动栏 + 卡片列表 + 新建/编辑/丢弃/恢复 | 待开始 |
| B2 | BlueprintService 接前端：世界观蓝本 | blueprint | 蓝本查看（谓词/规则集/实体模板/作用域预设）只读视图 | 待开始 |

### 阶段 C · 一致性能力（伏笔/时间线/读者/空间）

目标：差异化能力，让长篇写作不出现设定矛盾。

| 迭代 | 主题 | 涉及 service | 完成标准 | 状态 |
|---|---|---|---|---|
| C1 | ForeshadowingService 接前端：伏笔看板 | foreshadowing | 伏笔列表 + 状态（铺设/推进/回收） | 待开始 |
| C2 | TimelineService 接前端：时间线视图 | timeline | 时间线只读视图（Core 事件 + 章节/场景计划） | 待开始 |
| C3 | ReaderService 接前端：读者认知模型 | reader | 读者群体 + 认知状态只读视图 | 待开始 |
| C4 | SpatialService 接前端：空间地图 | spatial | 空间节点/边只读视图（复用图谱模式） | 待开始 |

### 阶段 D · 高级写作（修订/Retcon/风格/场景）

| 迭代 | 主题 | 涉及 service | 完成标准 | 状态 |
|---|---|---|---|---|
| D1 | SceneService 接前端：场景卡 | scene | 场景列表 + 目标/冲突/结果 + 关联章节 | 待开始 |
| D2 | RevisionService 接前端：修订记录 | revision | 修订历史查看 + 版本组 + 恢复 | 待开始 |
| D3 | StyleService 接前端：风格指南 | style | 风格指南/示例/禁用表达只读 | 待开始 |
| D4 | RetconViewService 接前端：追溯修改 | retcon | 影响报告只读视图 | 待开始 |

### 阶段 E · Agent 深度集成

| 迭代 | 主题 | 完成标准 | 状态 |
|---|---|---|---|
| E1 | Agent 工具调用 SSE 事件 | Agent 工具调用过程对用户可见（检测实体/建议关系/生成决策） | 待开始 |
| E2 | Agent 写正文通道 | Agent 在正文里生成草稿块 → 审核 → 落正文 | 待开始 |
| E3 | Agent 协作可见性强化 | 作者随时知道 AI 在做什么、需要确认什么 | 待开始 |

## 迭代记录

### 迭代 A1 · ChapterService 接前端 ✅（2026-07-17）

**做了什么**：
- 后端：ChapterService 补 `listChapters`/`getChapter` 方法
- BFF：新建 `apps/bff/src/routes/chapters.ts`（6 个端点：GET 列表/单个 + POST 创建 + PATCH 更新 + POST 状态推进 + POST 重排），server.ts 注册
- 前端：`api/chapters.ts`（含 ChapterStatus 标签/颜色映射）+ `stores/chapter.ts`（load/create/rename/transition/reorder）
- 插件：`chapter-planner`（ChapterPlannerIcon + ChapterListView 侧栏，复用 UiSideHead/UiButton/UiIcon/UiEmpty/UiInlineForm/UiStatusDot）+ manifest，注册到 registry（order=3）

**验证**：vue-tsc 0 错；Playwright 12/12（新建+序号递增/双击重命名/状态推进/选中态/无异常）

**发现并修复的 bug**：v-for 内 `ref="renameInput"` 收集成数组导致 `.focus is not a function`，改用函数 ref `:ref="setRenameInput"`

**下一步**：A2（ProseService 接前端，章节下挂正文块，复用 TipTap 编辑器）

### 迭代 A2 · 章节正文编辑器 ✅（2026-07-17）

**做了什么**：
- 后端 schema：ChapterPlan 加 `proseDocumentId` 字段（model + DDL + store CRUD + 已有库 ALTER TABLE 迁移）
- BFF：新建 `apps/bff/src/routes/prose.ts`（4 端点：GET 列表/单个 + POST 创建 + POST ingest 文本写入），server.ts 注册。chapters PATCH 支持 proseDocumentId
- 前端：`api/prose.ts`（ProseDocument/ProseBlock 类型 + blocksToMarkdown 转换）+ chapter store 扩展（activeProseText/proseSync + getOrCreateProse/saveProse action）
- 编辑器：`ChapterProseEditor.vue`（TipTap + StarterKit，复用 EditorToolbar，防抖1s自动保存，Markdown↔块转换）
- manifest：chapter-planner 加 mainView（模块独占主区，点章节打开正文）

**核心联动**：一章 = 一个 ProseDocument。点章节侧栏 → 若无正文自动创建并回填 proseDocumentId → 加载块转 Markdown → 编辑器渲染 → 编辑防抖保存 → 后端 ingestText 全量替换块

**验证**：vue-tsc 0 错；Playwright 8/8（无选中提示/选中后编辑器可编辑/输入自动保存状态栏已保存/刷新后内容持久化）

**下一步**：A3 已被 A2 吸收（点章节打开正文已实现）。下一迭代 B1（IdeaService 灵感卡片）或补章节的 goals/POV 编辑 UI



---

## 迭代 A1 · ChapterService 接前端（进行中）

**范围**：只接 ChapterService 的 CRUD（createChapter/updateChapter/transitionChapterStatus/reorderChapters）到前端，建章节活动栏 + 侧栏章节列表。

**不做**：不接 NarrativeStructureNode（§14.1 结构树，后端未实现）；不接 ProseService（A2 做）；不接场景关联（D1 做）。

**步骤**：
1. BFF 路由 `apps/bff/src/routes/chapters.ts`（GET 列表/单个 + POST 创建/更新/状态推进/重排）
2. server.ts 注册路由 + 注入 ChapterService
3. 前端 api/chapters.ts
4. 前端 stores/chapter.ts
5. 新建插件 `chapter-planner`（manifest + ChapterPlannerIcon + ChapterListView 侧栏）
6. 注册到 plugin-registry
7. vue-tsc + Playwright 验证

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
| B1 | IdeaService 接前端：灵感卡片池 | idea | 灵感活动栏 + 卡片列表 + 新建/编辑/丢弃/恢复 | ✅ 完成 |
| B2 | BlueprintService 接前端：世界观蓝本 | blueprint | 蓝本查看（谓词/规则集/实体模板/作用域预设）只读视图 | 待开始 |

### 阶段 C · 一致性能力（伏笔/时间线/读者/空间）

目标：差异化能力，让长篇写作不出现设定矛盾。

| 迭代 | 主题 | 涉及 service | 完成标准 | 状态 |
|---|---|---|---|---|
| C1 | ForeshadowingService 接前端：伏笔看板 | foreshadowing | 伏笔列表 + 状态（铺设/推进/回收） | ✅ 完成 |
| C2 | TimelineService 接前端：时间线视图 | timeline | 时间线只读视图（Core 事件 + 章节/场景计划） | ✅ 完成 |
| C3 | ReaderService 接前端：读者认知模型 | reader | 读者群体 + 认知状态只读视图 | ✅ 完成 |
| C4 | SpatialService 接前端：空间地图 | spatial | 空间节点/边只读视图（复用图谱模式） | ✅ 完成 |

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

### 迭代 B1 · IdeaService 接前端 ✅（2026-07-17）

**做了什么**：
- 后端：IdeaService 补 `updateIdea` 方法（编辑 content/summary/tags/kind）
- BFF：`apps/bff/src/routes/ideas.ts`（6 端点：GET 列表/单个 + POST 捕捉 + PATCH 编辑 + POST 废弃/恢复），server.ts 注册
- 前端：`api/ideas.ts`（IdeaCard 类型 + Kind/Maturity 中文标签/颜色映射）+ `stores/idea.ts`（load/capture/edit/discard/restore + 搜索/类型过滤 computed）
- 插件：`idea-board`（灯泡图标 + IdeaListView 侧栏[捕捉表单/搜索/类型芯片过滤/归档开关] + IdeaDetailView 主区[content/summary/tags/kind 编辑]）+ manifest（order=4）

**验证**：vue-tsc 0 错；Playwright 12/12（侧栏渲染/捕捉+列表增加/选中详情/编辑保存/类型过滤/搜索/归档/无异常）

**下一步**：B2（BlueprintService 蓝图只读）或回到阶段 A 补 goals/POV 编辑

### 中场深度检查 ✅（2026-07-17）

3 个功能迭代（A1/A2/B1）完成后的全量回归：
- **后端 vitest 929/929 全绿**（72 文件）—— A1/A2/B1 零回归
- **基建阶段 verify-runtime 32/32** —— 新插件未破坏已有功能（边标签中文/节点静止等）
- **A1 章节回归 12/12** —— 章节功能仍正常

### 迭代 A1' · 章节规划信息条（goals/POV）✅（2026-07-17）

**做了什么**：补全 A1 遗漏的章节规划编辑 UI——在正文编辑器主区顶部加可折叠信息条：
- chapter store 加 `editMeta` action（goals/povEntityId/title 乐观锁保存）
- ChapterProseEditor 加章节信息条：章节序号 + goals 标签式编辑（回车添加/×移除/退格删末尾）+ POV 下拉（从 entity store 取已注册实体，含"无/上帝视角"）+ 折叠展开
- 选中章节时自动加载已注册实体供 POV 选择

**验证**：vue-tsc 0 错；Playwright 12/12（信息条渲染/goals 增删/POV 下拉含3实体/折叠展开/无异常）

**下一步**：C1（伏笔看板）或 B2（蓝图只读）

### 迭代 C1 · ForeshadowingService 接前端（伏笔看板）✅（2026-07-17）

**做了什么**：
- BFF：`apps/bff/src/routes/foreshadowings.ts`（3 端点：GET 列表 + POST 创建 + POST 状态推进），server.ts 注册
- 前端：`api/foreshadowings.ts`（ForeshadowingPlan 类型 + Kind 6种/Status 6态中文标签+颜色 + STATUS_FLOW）+ `stores/foreshadowing.ts`（load/create/transition + groupedByStatus 看板分列 computed）
- 插件：`foreshadowing-board`（旗帜图标 + ForeshadowingListView 看板式按状态分列：已计划/铺设中/回收计划/已回收/已放弃，每列显示伏笔卡 + 推进/放弃按钮）
- manifest（order=5），仅侧栏（伏笔是规划对象，无主区编辑）

**范围控制**：只接 ForeshadowingPlan 看板，不碰 HintOccurrence/PayoffPlan/RevealPlan 子模型（后续迭代）

**验证**：vue-tsc 0 错；Playwright 9/9（侧栏渲染/创建归入已计划列/状态推进→铺设中/放弃→已放弃列/无异常）

**下一步**：C2（TimelineService 时间线只读）或 B2（蓝图只读）

### 迭代 C2 · TimelineService 接前端（时间线只读视图）✅（2026-07-17）

**做了什么**：
- BFF：`apps/bff/src/routes/timelines.ts`（1 个 GET 端点：buildTimelineView，支持 mode/sourceLayers/chapterRange 过滤），server.ts 注册
- 前端：`api/timelines.ts`（TimelineView/ItemView 类型 + Layer 5种中文标签/颜色）+ `stores/timeline.ts`（loadTimeline/switchMode/toggleLayer + filteredItems/groupedByChapter computed）
- 插件：`timeline-view`（时钟图标 + TimelineSideView 侧栏[模式切换 世界/叙述 + 来源层过滤芯片] + TimelineCanvas 主区[按章节分组的垂直时间轴，每章一节，条目带来源层标签]）+ manifest（order=6）
- 数据来源：合并 Core events 表（committed）+ 章节规划（planned）+ 场景规划（planned），双轨排序（world/narrative）

**验证**：vue-tsc 0 错；Playwright 10/10（侧栏渲染/模式切换/来源层过滤/13条目按10章分组/来源层标签已提交/无异常）

**下一步**：C3（ReaderService 读者认知模型）或 C4（SpatialService 空间地图）

### 迭代 C3 · ReaderService 接前端（读者认知模型）✅（2026-07-17）

**做了什么**：
- BFF：`apps/bff/src/routes/readers.ts`（5 端点：GET 群体 + POST 创建 + GET 认知 + POST 添加 + PATCH 更新），server.ts 注册
- 前端：`api/readers.ts`（Audience/KnowledgeState 类型 + Kind 4种/State 7态中文标签+颜色）+ `stores/reader.ts`（loadAudiences/loadKnowledge/create/addKnowledge/editKnowledge）
- 插件：`reader-model`（眼睛图标 + ReaderSideView 侧栏[群体列表/新建] + ReaderKnowledgeView 主区[认知状态列表 + 添加 + state 下拉切换]）+ manifest（order=7）

**发现并修复的 bug**：`writing_reader_audiences` / `writing_reader_knowledge_states` 两表缺 row mapper，直接 `as` 强转导致 camelCase 字段（projectId/subjectRef 等）丢失返回 undefined。补 `rowToReaderAudience` / `rowToReaderKnowledgeState` mapper（narrativePositionType/Id 组合为 narrativePositionRef）

**验证**：vue-tsc 0 错；Playwright 9/9（侧栏渲染/创建群体/选中标题/添加认知主体可见/state切换/无异常）

**下一步**：C4（SpatialService 空间地图）或 B2（蓝图只读）

### 迭代 C4 · SpatialService 接前端（空间地图只读树）✅（2026-07-17）· 阶段 C 完结

**做了什么**：
- BFF：`apps/bff/src/routes/spatials.ts`（1 个 GET 端点：buildSpatialTreeView，按 contains/parent_of 边构建父子树），server.ts 注册
- 前端：`api/spatials.ts`（SpatialNode/TreeNode/TreeView 类型）+ `stores/spatial.ts`（loadTree）
- 插件：`spatial-map`（地图标记图标 + SpatialSideView 侧栏[节点/关系统计卡片] + SpatialTreeView 主区[递归树视图 SpatialNodeItem 自引用组件，展开/折叠]）+ manifest（order=8）
- 范围控制：只接 SpatialViewService 的只读树视图，不碰 SpatialService 写操作（节点/边 CRUD 留后续）

**验证**：vue-tsc 0 错；Playwright 5/5（侧栏渲染/统计卡片/空状态正确/BFF树结构/无异常）

**★ 阶段 C 完结**：伏笔(C1) + 时间线(C2) + 读者(C3) + 空间(C4) 四大一致性能力全部接前端。前端覆盖 service 数：14/23

**下一步**：B2（BlueprintService 蓝图只读）或 D1（SceneService 场景卡）









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

# Writing Layer 总体路线图

**项目代号**：Narrative-OS Writing Layer  
**最后更新**：2026-06-13  
**状态**：总体蓝图草案，Phase 7 实现前置规划  

配套细化文档：

- `docs/Writing-Layer-Feature-Spec.md`：写作层完整功能规格、状态边界、服务契约、前端信息架构、Agent 运行时和 Phase 7 测试计划。

本文档负责总体路线和阶段切分；具体实现前以 `Writing-Layer-Feature-Spec.md` 的细化章节为准。

---

## 1. 文档目标

本文档定义 NarrativeOS 在 Core 与 NarrativeAgent 之上的写作层总体规划。

写作层不是 Core 的延伸，也不是单纯聊天界面。它是面向作者的创作过程系统，负责管理从灵感、草案、设定、场景、章节、地图、图谱、读者信息到正式世界状态提交的完整流程。

本文档的目标是：

1. 先完整规划未来功能池，避免第一版实现堵死后续扩展。
2. 明确写作层、NarrativeAgent、Core 的边界。
3. 明确哪些内容属于创作过程，哪些内容可提交为 Core 世界状态。
4. 为地理空间、多层宇宙、实体关系、图谱可视化和前端设计语言预留正式位置。
5. 将第一阶段实现收敛为可验证的最小闭环。

---

## 2. 总体定位

统一分层：

```text
作者 / 用户
  ↓
Writing Layer / Writing Workspace
  ↓
NarrativeAgent
  ↓
ToolRouter
  ↓
Core Engine
  ↓
SQLite / LanceDB / 外部适配器
```

职责边界：

| 层级 | 主要职责 | 不负责 |
|------|----------|--------|
| Core Engine | 已提交世界状态、Fact、Event、Knowledge、Thread、Rule、Retcon、一致性裁决 | 聊天、创作偏好、UI、草案审美 |
| ToolRouter | Core 能力的工具门面、参数校验、错误包装 | 作者工作流、长期创作策略 |
| NarrativeAgent | 理解用户意图、组装上下文、调用写作层服务、生成建议与解释 | 产品级写作流程、正式状态提交、地图视图、图谱布局 |
| Writing Layer | 创作过程状态、作品结构、草案、地图、关系、图谱、章节、读者模型、确认流程 | 绕过 Core 直接写正式世界状态 |

核心原则：

```text
Writing Layer owns authoring process state.
Core owns committed world state.
No authoring artifact becomes Core state unless it passes through an explicit proposal and confirmation flow.
```

中文表述：

```text
写作层拥有创作过程状态。
Core 拥有已提交的世界状态。
任何创作产物，只有经过明确的提案与确认流程，才能进入 Core。
```

---

## 3. 状态分类

写作层内容分为三类。

### 3.1 永远不进 Core

这些内容只属于作者创作过程：

- 审美偏好
- 文风要求
- 节奏判断
- 参考资料
- 禁用方向
- 读者体验目标
- 作者备注
- 多版本草案
- UI 布局和图谱布局
- 地图标注与视觉图层

### 3.2 暂时不进 Core

这些内容可能未来进入 Core，但在确认前只是候选：

- 未定角色
- 候选地点
- 候选组织
- 候选物品
- 候选能力
- 候选关系
- 场景草案
- 章节草案
- 多个互斥方案
- 第一幕事件草案

### 3.3 确认后进入 Core

这些内容经过 `propose_event` 与 `commit_event` 后成为正式世界状态：

- 实体注册
- 事件发生
- 角色状态变化
- 地点状态变化
- 物品归属变化
- 组织关系变化
- 谁知道什么
- 伏笔打开或关闭
- 规则推导出的事实
- 回溯修改提交结果

---

## 4. 全量模块地图

写作层按作者需要管理的对象划分为以下模块。

```text
Writing Layer
├─ Project / 作品项目
├─ ProjectBlueprint / 项目创作蓝图
├─ IdeaBoard / 创意与设定池
├─ Drafts / 草案系统
├─ Entities / 实体系统
├─ EntityRelations / 实体关系与关联关系
├─ Geography / 地理与多层宇宙
├─ Timeline / 时间线
├─ Scenes / 场景与事件
├─ Knowledge / POV / ReaderModel
├─ Threads / Foreshadowing
├─ Graph / Visualization
├─ Style / Prose
├─ Revision / Retcon
├─ Query / Analysis
├─ Rules / Constraints
├─ Collaboration
├─ ImportExport
├─ FrontendExperience
└─ CoreBridge
```

第一版不实现全部模块，但第一版的数据边界和命名必须允许这些模块后续接入。

---

## 5. 项目创作蓝图

写作层不能硬编码题材结构。每个作品的内部设定、实体类型、关系类型、空间结构、章节结构、读者视角和图谱视图都可能不同。

因此，写作层需要一个项目级创作蓝图。它不是给普通用户手写的技术配置，而是系统在创作对话中逐步生成、展示和修正的项目结构。

核心原则：

```text
Writing Layer 提供通用能力。
ProjectBlueprint 定义当前作品如何使用这些能力。
用户通过自然语言和可视化确认蓝图，而不是编辑技术 schema。
```

### 5.1 蓝图内容

项目创作蓝图可以定义：

- 作品使用哪些实体类型
- 作品使用哪些关系类型
- 作品使用哪些空间节点类型
- 作品使用哪些空间边类型
- 是否需要多时间线
- 是否需要读者模型
- 是否需要复杂地图
- 是否需要图谱视图
- 哪些内容适合进入 Core
- 哪些内容只保留为写作层备注
- 默认工作流
- 默认前端视图

候选数据对象：

```ts
interface ProjectBlueprint {
  id: string;
  projectId: string;
  entityTypes: BlueprintTypeDef[];
  relationTypes: BlueprintTypeDef[];
  spatialNodeTypes: BlueprintTypeDef[];
  spatialEdgeTypes: BlueprintTypeDef[];
  timelineTypes: BlueprintTypeDef[];
  workflowPresets: string[];
  graphViewPresets: string[];
  frontendViewHints: Record<string, unknown>;
  maturity: 'implicit' | 'drafted' | 'reviewed' | 'active';
}

interface BlueprintTypeDef {
  id: string;
  label: string;
  description?: string;
  parentTypeId?: string;
  properties?: Record<string, unknown>;
  coreMapping?: {
    entityKind?: string;
    predicate?: string;
    relationKind?: string;
  };
}
```

### 5.2 用户不直接选择技术模板

普通作者不应该面对如下问题：

```text
请选择 spatialNodeTypes、spatialEdgeTypes、GraphViewPreset。
```

更合适的体验是：

```text
用户：我想写一本多层宇宙科幻，现实世界外面还有梦境层和镜像层。

系统整理：
- 这个作品可能需要「现实层」「梦境层」「镜像层」三类空间。
- 层之间可能存在「进入」「映射」「污染」三类关系。
- 是否把这些先作为项目空间蓝图？
```

用户确认后，系统再生成 ProjectBlueprint。

### 5.3 预设的真实定位

系统可以有预设，但预设不是用户必须理解的模板包。

预设的定位：

- 帮助 Agent 初步理解作品结构
- 帮助新项目快速生成候选蓝图
- 帮助前端提供合适的默认视图
- 帮助测试覆盖典型题材

预设必须满足：

- 可修改
- 可合并
- 可删除
- 可被用户自然语言覆盖
- 不作为 Core 或写作层的硬编码真理

候选内部预设：

- 现实城市
- 奇幻大陆
- 修仙界域
- 科幻星际
- 多层宇宙
- 无限流副本
- 梦境 / 意识空间
- 历史 / 家族谱系

### 5.4 蓝图初始化方式

蓝图初始化应采用渐进式。

```text
Step 1：用户自然语言描述作品。
Step 2：Agent 提取可能的项目结构。
Step 3：Writing Layer 生成候选 ProjectBlueprint。
Step 4：前端用人话展示给用户确认。
Step 5：用户修改或接受。
Step 6：蓝图进入 active 状态。
Step 7：后续写作中持续演化。
```

第一版可以只实现 `implicit` 与 `drafted` 两个状态：

- `implicit`：系统根据用户输入临时推断，不持久承诺。
- `drafted`：系统生成候选蓝图，等待用户确认。

---

## 6. 作品项目模块

作品项目负责管理作品级元信息和当前工作上下文。

功能池：

- 作品标题
- 作品类型
- 题材标签
- 核心卖点
- 世界观摘要
- 作者目标
- 当前卷 / 幕 / 章 / 场景
- 项目状态
- 写作计划
- 版本分支
- 项目模板
- 多作品管理
- 导出发布状态

候选数据对象：

```ts
interface WritingProject {
  id: string;
  title: string;
  genreTags: string[];
  blueprintId?: string;
  premise?: string;
  authorGoals: string[];
  currentActId?: string;
  currentChapterId?: string;
  currentSceneId?: string;
  status: 'planning' | 'drafting' | 'revising' | 'paused' | 'archived';
}
```

---

## 7. 创意与设定池

创意池保存未定内容，不默认写入 Core。

功能池：

- 灵感卡片
- 未定设定
- 候选角色
- 候选地点
- 候选组织
- 候选物品
- 技术机制
- 魔法机制
- 异常机制
- 主题母题
- 禁用方向
- 参考资料
- 标签分类
- 成熟度标记
- 是否可转草案
- 是否可进入 Core 提案

候选数据对象：

```ts
interface IdeaCard {
  id: string;
  kind: 'premise' | 'character' | 'location' | 'faction' | 'item' | 'mechanism' | 'theme' | 'style' | 'other';
  content: string;
  tags: string[];
  maturity: 'raw' | 'candidate' | 'structured' | 'ready_for_draft';
  coreCandidate: boolean;
}
```

---

## 8. 草案系统

草案系统保存创作过程中的可编辑内容。

功能池：

- 设定草案
- 场景草案
- 章节草案
- 幕草案
- 第一幕草案
- 正文草稿
- 多版本草案
- 草案合并
- 草案废弃
- 草案来源追踪
- 草案与 Core proposal 的映射

状态机：

```text
collecting
  ↓
structured
  ↓
drafting
  ↓
ready_to_simulate
  ↓
simulated
  ↓
awaiting_confirmation
  ↓
committed / revising / abandoned
```

候选数据对象：

```ts
interface WritingDraft {
  id: string;
  kind: 'concept' | 'setting' | 'scene' | 'chapter' | 'act' | 'prose';
  summary: string;
  content: string;
  status: 'collecting' | 'structured' | 'drafting' | 'ready_to_simulate' | 'simulated' | 'awaiting_confirmation' | 'committed' | 'revising' | 'abandoned';
  sourceIdeaIds: string[];
  linkedProposalId?: string;
}
```

---

## 9. 实体系统

实体系统管理作者视角下的角色、地点、组织、物品、概念、机制等。

Core 已有 `EntityKind` 和 `EntityRecord`，但写作层不能把它们直接当作作者可见的完整实体分类系统。

Core 中的 `EntityKind` 定位是检索优化标签，不是世界本体论。写作层需要维护更贴近作品设定的项目级实体类型，并在需要进入 Core 时映射到 Core 的 `EntityKind`。

功能池：

- 角色档案
- 地点档案
- 组织档案
- 物品档案
- 抽象概念档案
- 技术 / 魔法 / 异常机制档案
- 实体别名
- 实体标签
- 实体成熟度
- 是否已注册到 Core
- Core entity id 映射
- 实体状态摘要
- 实体出场统计
- 作者可见实体分类
- Core EntityKind 映射
- EntityRecord 展示适配
- 项目级实体类型演化

候选数据对象：

```ts
interface WritingEntitySketch {
  id: string;
  displayName: string;
  typeId: string;
  summary: string;
  tags: string[];
  status: 'candidate' | 'approved' | 'registered' | 'deprecated';
  coreEntityId?: string;
  coreKind?: string;
}
```

### 9.1 Core 实体类型适配

前端需要同时理解三类类型：

```text
Project Entity Type
  当前作品内部的作者可见类型，例如「灰域区域」「调查局」「梦境锚点」。

Core EntityKind
  Core 用于检索和存储的通用标签，例如 place / spatial_domain / faction / rule。

EntityRecord
  Core 已注册实体的记录，包含 id / name / kind / tags / registeredAtChapter。
```

适配原则：

- 前端展示优先使用 ProjectBlueprint 中的 `entityTypes`。
- Core 查询和提交时必须映射到合法 `EntityKind`。
- 一个 Project Entity Type 可以映射到同一个 Core EntityKind。
- Core EntityKind 不足以表达作品内部分类时，不新增 Core 类型，先在 ProjectBlueprint 中表达。
- 只有当某类实体跨多个作品都需要提升检索质量时，才考虑扩展 Core EntityKind。

示例：

```text
项目类型「灰域区域」 → Core EntityKind: spatial_domain
项目类型「长庚站」   → Core EntityKind: place
项目类型「黑晶碎片」 → Core EntityKind: resource 或 entity
项目类型「静息规则」 → Core EntityKind: rule
```

---

## 10. 实体关系与关联关系

实体关系是写作层的一等模块，不能只依赖 Core 中零散的 Fact 查询。

Core 已有 `RelationKind`，但它是 Fact 的语义类别，不是作者可见的完整关系类型。写作层需要支持项目级关系类型，并在进入 Core 时映射到 `RelationKind`、predicate 和可选 `relationKind` 元数据。

### 10.1 关系类型

功能池：

- 亲属关系
- 情感关系
- 师徒关系
- 敌对关系
- 同盟关系
- 上下级关系
- 所属组织
- 拥有 / 持有
- 守护 / 追捕 / 监视
- 知识来源关系
- 因果关系
- 空间包含关系
- 地点连接关系
- 事件参与关系
- 伏笔关联关系
- 草案引用关系
- 读者误导关系
- 作者备注关系

关系分层：

```text
Core Relation
  已提交的世界内关系，例如 A 是 B 的导师。

Authoring Relation
  创作过程关系，例如这个设定来自哪个灵感卡。

View Relation
  可视化关系，例如图谱里这两个节点被手动归为一组。

Analytical Relation
  分析产生的关系，例如两个角色的冲突强度高。
```

### 10.2 关系属性

每条关系需要支持：

- 来源
- 方向性
- 强度
- 确定性
- 时间范围
- 章节范围
- 是否公开
- 谁知道
- 读者是否知道
- 是否已提交到 Core
- 是否只是作者标注

候选数据对象：

```ts
interface WritingRelation {
  id: string;
  sourceId: string;
  targetId: string;
  typeId: string;
  layer: 'core' | 'authoring' | 'view' | 'analysis';
  direction: 'directed' | 'undirected';
  strength?: number;
  certainty: 'candidate' | 'confirmed' | 'contested';
  visibleToReader?: boolean;
  knownByEntityIds?: string[];
  coreFactId?: string;
  coreRelationKind?: string;
  corePredicate?: string;
  sourceDraftId?: string;
}
```

### 10.3 Core 关系类型适配

前端需要同时处理三类关系：

```text
Project Relation Type
  作者可见关系，例如「临时庇护」「污染」「追捕」「镜像映射」。

Core RelationKind
  Core 的通用语义分类，例如 spatial / social / causal / informational。

Core Predicate
  真正写入 Fact 的谓词，例如 location / target / connected_to / erosion_level。
```

适配原则：

- 前端关系图展示优先使用 Project Relation Type。
- Core 提交必须转换为 predicate + value + relationKind。
- RelationKind 只用于语义分类和检索，不承担完整关系本体论。
- 用户不需要知道 RelationKind；用户只需要确认关系含义。
- Project Relation Type 可以随着写作演化，并逐渐映射到更稳定的 Core 谓词。

示例：

```text
项目关系「临时庇护」
  → Core predicate: location 或 shelter_at
  → RelationKind: spatial / state

项目关系「灰域污染」
  → Core predicate: contamination_source 或 erosion_level
  → RelationKind: causal / state

项目关系「调查局追捕」
  → Core predicate: target 或 pursued_by
  → RelationKind: goal / social
```

### 10.4 关系视图

关系系统需要服务多种视图：

- 角色关系图
- 组织结构图
- 物品归属图
- 地点连接图
- 因果链图
- 知识传播图
- 伏笔依赖图
- 草案来源图

---

## 11. 地理、空间与多层宇宙系统

地理系统不只是地图。它需要支持普通城市、奇幻大陆、修仙界域、星际空间、梦境层、平行宇宙、嵌套宇宙等完全不同的空间结构。

写作层不能内置固定空间层级。空间系统的内核只提供通用图模型：

```text
SpatialNode / 空间节点
SpatialEdge / 空间关系
SpatialLayer / 空间图层
SpatialRule / 空间规则
MapView / 地图视图
```

当前作品具体有哪些空间类型，由 ProjectBlueprint 定义。

### 11.1 空间类型由项目定义

系统不能固定认为所有作品都有：

```text
Multiverse / 多元宇宙
  ↓
Universe / 单一宇宙
  ↓
Dimension / 维度
  ↓
Realm / 界域
  ↓
Galaxy / 星系
  ↓
StarSystem / 恒星系
  ↓
Planet / 星球
  ↓
Continent / 大陆
  ↓
Nation / 国家
  ↓
Region / 区域
  ↓
City / 城市
  ↓
District / 街区
  ↓
Site / 地点
  ↓
Building / 建筑
  ↓
Room / 房间
```

上面只能作为“多层宇宙预设”的示例，不是写作层内置模型。

不同作品可能定义完全不同的空间类型。

现实悬疑：

```text
city
district
street
building
floor
room
crime_scene
```

修仙：

```text
realm
continent
sect_domain
mountain_gate
cave
secret_realm
forbidden_zone
```

科幻星际：

```text
universe
galaxy
star_system
planet
orbital_station
ship
deck
room
```

多层宇宙：

```text
timeline
parallel_world
mirror_layer
dream_layer
memory_space
anchor_point
rift
```

### 11.2 多层级宇宙能力

多层宇宙不是默认结构，而是一组可由 ProjectBlueprint 启用的能力。

需要支持的表达能力：

- 平行宇宙
- 多重时间线
- 镜像世界
- 梦境层
- 虚拟世界
- 异空间
- 口袋宇宙
- 嵌套宇宙
- 维度裂缝
- 可变空间
- 只在特定条件下可达的区域
- 不同宇宙之间的映射关系
- 同一实体在不同宇宙中的副本
- 跨宇宙事件

### 11.3 空间关系

空间关系同样由项目定义。系统可以提供常见关系建议，但不硬编码为固定枚举。

常见空间关系示例：

- contains：包含
- adjacent_to：相邻
- connected_to：可达
- portal_to：传送连接
- mirrors：镜像
- overlaps：空间重叠
- branches_from：分支宇宙
- nested_in：嵌套
- sealed_from：隔绝
- route_to：路线
- travel_time_to：通行耗时

### 11.4 地图展示细节

地图展示需要分为数据与视图。

空间数据：

- 空间节点
- 空间边
- 坐标
- 层级
- 尺度
- 可达性
- 危险等级
- 归属
- 状态
- 当前占用实体
- 事件发生地点

地图视图：

- 世界地图
- 区域地图
- 城市地图
- 建筑平面图
- 宇宙层级图
- 平行宇宙对照图
- 路线图
- 角色行程图
- 事件热力图
- 危险区域图
- 读者可见地图
- 作者完整地图

候选数据对象：

```ts
interface SpatialNode {
  id: string;
  name: string;
  typeId: string;
  parentId?: string;
  layerId?: string;
  coreEntityId?: string;
  coordinates?: { x: number; y: number; z?: number; scale?: string };
  properties: Record<string, unknown>;
}

interface SpatialEdge {
  id: string;
  sourceId: string;
  targetId: string;
  typeId: string;
  bidirectional: boolean;
  properties: Record<string, unknown>;
}

interface MapView {
  id: string;
  name: string;
  rootSpatialNodeId: string;
  layerIds: string[];
  filters: Record<string, unknown>;
  layout: Record<string, unknown>;
}
```

### 11.5 与 Core 的关系

Core 可保存：

- 地点实体
- 角色当前位置
- 地点包含关系
- 地点连接关系
- 地点状态
- 事件发生地点

写作层保存：

- 地图坐标
- 地图图层
- 手动布局
- 视觉样式
- 作者标注
- 读者可见地图版本
- 多尺度视图配置

---

## 12. 时间线系统

功能池：

- 世界时间线
- 章节时间线
- 角色个人时间线
- 地点历史
- 物品历史
- 组织历史
- 并行事件
- 回忆
- 插叙
- 倒叙
- 时间跳跃
- 时间锚点
- 事件持续时间
- 多时间线分支
- 时间矛盾检查
- 角色行程同步

候选视图：

- 年表视图
- 章节视图
- 角色轨迹视图
- 世界线分支视图
- Retcon 前后对比视图

---

## 13. 场景与事件系统

功能池：

- 场景目标
- 场景地点
- 场景时间
- 场景参与者
- 场景冲突
- 场景情绪
- 场景信息释放
- 场景结果
- 场景依赖
- 事件草案
- 正式事件
- 场景是否已写正文
- 场景转 Core proposal

场景状态：

```text
idea
  ↓
outlined
  ↓
drafted
  ↓
simulated
  ↓
committed_to_world
  ↓
prose_written
  ↓
revised
```

---

## 14. 知识、视角与读者模型

Core 已有 Knowledge，但写作层还需要作者、读者和叙述视角维度。

功能池：

- 谁知道什么
- 谁误以为什么
- 谁隐瞒了什么
- 作者知道但角色不知道
- 读者知道但角色不知道
- 角色知道但读者不知道
- POV 视角过滤
- 读者当前认知
- 信息释放计划
- 谎言与误导
- 知识泄漏检查
- 悬念强度
- 读者可见状态快照

候选对象：

```ts
interface ReaderKnowledgeState {
  id: string;
  atChapter: number;
  knownFactIds: string[];
  suspectedFactIds: string[];
  falseBeliefs: Array<{ description: string; intendedByAuthor: boolean }>;
}
```

---

## 15. 伏笔与悬念系统

功能池：

- 伏笔卡
- 暗示次数
- 首次埋设章节
- 预计回收章节
- 实际回收事件
- 关联角色
- 关联地点
- 关联物品
- 读者是否可见
- 角色是否可见
- 悬念强度
- 超期未回收提醒
- 回收方式
- 误导性伏笔
- 红鲱鱼管理

与 Core 的关系：

- Core Thread 保存正式线索生命周期。
- 写作层保存铺设策略、读者体验、候选暗示、误导计划。

---

## 16. 图谱与可视化系统

图谱系统需要分为图数据、图视图和前端渲染三层。

### 16.1 图数据

图谱数据来源：

- Core Facts
- Core Events
- Core Knowledge
- Core Threads
- Writing Entities
- Writing Relations
- Spatial Nodes
- Timeline Events
- Draft links
- Author notes

图节点类型：

- entity
- character
- location
- faction
- item
- concept
- event
- fact
- thread
- draft
- idea
- spatial_node
- timeline_node

图边类型：

- relation
- ownership
- membership
- location
- knowledge
- cause
- dependency
- foreshadowing
- spatial
- temporal
- draft_source
- proposal_diff

### 16.2 图视图

功能池：

- 世界状态图谱
- 角色关系图
- 组织关系图
- 实体关联图
- 知识传播图
- 事件因果图
- 伏笔依赖图
- 地点连接图
- 时间线图
- 章节结构图
- Fact 依赖图
- Retcon 影响图
- 当前草案到 Core 提案的 diff 图
- 按章节过滤
- 按角色过滤
- 按地点过滤
- 按关系类型过滤
- 按确定性过滤
- 按读者 / 角色视角过滤
- 节点点击查看详情
- 边显示关系类型
- 手动拖拽布局
- 布局缓存
- 导出图片

候选对象：

```ts
interface GraphNodeView {
  id: string;
  sourceId: string;
  kind: string;
  label: string;
  group?: string;
  position?: { x: number; y: number };
  collapsed?: boolean;
}

interface GraphEdgeView {
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  kind: string;
  label?: string;
  weight?: number;
}

interface GraphView {
  id: string;
  name: string;
  nodeIds: string[];
  edgeIds: string[];
  filters: Record<string, unknown>;
  layout: 'force' | 'hierarchy' | 'timeline' | 'spatial' | 'manual';
  viewport?: Record<string, unknown>;
}
```

### 16.3 与 Core 的关系

Core 不负责图谱布局。Core 只提供事实、事件、依赖和知识数据。

写作层负责：

- 将 Core 数据投影成图节点和图边。
- 合并草案、设定池、地图和作者备注。
- 维护用户选择的图谱视图。
- 保存 UI 布局和过滤器。

---

## 17. 文风与正文生成系统

功能池：

- 文风设定
- 叙述人称
- 语言密度
- 句式偏好
- 对话风格
- 场景氛围
- 禁用词
- 示例文本
- 正文草稿
- 场景扩写
- 段落改写
- 连贯性检查
- 风格一致性检查
- 文本版本对比

第一版只记录风格偏好，不做复杂正文生成。

---

## 18. 修订与 Retcon 系统

功能池：

- 草案版本
- 章节版本
- 设定重命名
- 局部改写
- 章节重排
- 已提交事件回溯
- Core Retcon 影响报告
- 分支世界线
- 接受 / 拒绝修改
- 旧设定废弃
- 影响范围可视化
- 修订历史
- 差异对比

与 Core 的关系：

- 未提交内容走写作层版本系统。
- 已提交世界状态变更必须走 Core Retcon。

---

## 19. 查询、问答与辅助分析

功能池：

- 查询当前世界状态
- 查询角色过去
- 查询地点历史
- 查询某个设定首次出现
- 查询未回收伏笔
- 查询矛盾风险
- 查询读者当前知道什么
- 查询某章需要注入哪些上下文
- 自动摘要
- 章节前情提要
- 写作前提醒
- 场景一致性检查
- 地理可达性检查
- 时间线冲突检查

---

## 20. 规则与约束系统

功能池：

- 世界规则
- 题材规则
- 物理规则
- 魔法规则
- 科技限制
- 组织制度
- 地理可达规则
- 时间规则
- 角色能力限制
- 自定义一致性检查
- 写作层软约束
- Core 硬约束

区分：

```text
硬约束：Core 必须拒绝冲突提交。
软约束：Writing Layer 给出提醒，但作者可以继续草案探索。
```

---

## 21. 协作与工作流系统

功能池：

- 作者决策记录
- Agent 建议记录
- 待确认事项
- TODO
- 评论
- 审阅意见
- 任务看板
- 多 Agent 分工
- 编辑 / 作者权限
- 会话恢复
- 操作审计

---

## 22. 导入导出与生态

功能池：

- Markdown 导入
- 小说正文导入
- 设定集导入
- World Package 导入
- 地图数据导入
- 图谱数据导入
- 导出世界状态
- 导出设定集
- 导出人物关系图
- 导出时间线
- 导出章节大纲
- 导出审计报告
- 导出前端可视化数据包

---

## 23. CoreBridge

CoreBridge 是写作层进入 Core 的唯一正式通道。

功能池：

- 候选实体注册
- 草案转 `fact_changes`
- `propose_event`
- 沙盒报告展示
- `commit_event`
- 当前世界状态快照
- 开放线索列表
- 一致性警告
- Retcon 提案
- Retcon 影响报告
- ProjectBlueprint 到 World Package 扩展建议
- WorldRuleCandidate 管理

禁止：

- Writing Layer 直接写 Core `facts` 表。
- Writing Layer 绕过 `propose_event` 提交正式状态。
- Writing Layer 把未确认草案伪装为已提交世界状态。

### 23.1 Writing Blueprint 与 Core World Package

写作层的 `ProjectBlueprint` 和 Core 的 `WorldPackage` 都可以逐渐完善，但二者节奏不同。

```text
ProjectBlueprint
  快速、柔性、可错、可改，用来组织创作过程。

Core WorldPackage
  缓慢、刚性、需确认、需验证，用来裁决正式世界状态。
```

作者不应该手写 World Package，也不应该在开书前完成全部规则配置。正确流程是：

```text
作者自然写作
  ↓
Writing Layer 在 ProjectBlueprint 中柔性记录概念、类型、关系和空间结构
  ↓
系统发现稳定世界规律
  ↓
生成 WorldRuleCandidate
  ↓
作者用自然语言确认规则含义
  ↓
Agent 生成 World Package Extension Proposal
  ↓
Core 沙盒验证
  ↓
用户确认后固化到 Core WorldPackage
```

### 23.2 WorldRuleCandidate

`WorldRuleCandidate` 是写作层与 Core World Package 之间的缓冲层。它是给作者看的规则候选，不是 Core 技术规则。

候选数据对象：

```ts
interface WorldRuleCandidate {
  id: string;
  projectId: string;
  naturalLanguageRule: string;
  examples: string[];
  detectedFromDraftIds: string[];
  relatedEntityIds: string[];
  relatedRelationIds: string[];
  confidence: number;
  status: 'observed' | 'suggested' | 'accepted_by_author' | 'rejected' | 'promoted_to_world_package';
  proposedWorldPackageExtensionId?: string;
}
```

前端展示必须使用人话：

```text
我观察到一条可能的世界规则：

“每个灰域区域都有侵蚀程度；当侵蚀程度达到 100% 时，该区域会被静息层吞没。”

以后是否要用这条规则检查剧情矛盾？
```

用户只确认含义，不编辑 predicate、schema 或 rule。

### 23.3 自动固化边界

系统不能自动把规则候选固化到 Core。

允许自动做：

- 发现反复出现的规律
- 生成自然语言规则候选
- 给出例子
- 建议是否固化
- 生成技术提案草稿

必须用户确认：

- 新增 Core predicate
- 新增 Core rule
- 新增 Core constraint
- 修改 World Package
- 让某条规则参与正式提交校验

---

## 24. 前端体验与设计语言预留

本章节用于后续前端设计语言细化。当前先定义信息架构和设计方向。

### 24.1 前端主视图

候选工作台布局：

```text
┌─────────────────────────────────────────────────────────────┐
│ 顶栏：作品 / 当前章节 / 当前流程阶段 / 提交状态              │
├───────────────┬───────────────────────────────┬─────────────┤
│ 世界与设定     │ 写作工作区                      │ Agent 对话   │
│               │                               │             │
│ 实体           │ 草案 / 正文 / 场景               │ 讨论设定     │
│ 关系           │                               │ 修改草案     │
│ 地图           │ 沙盒推演报告                    │ 查询状态     │
│ 时间线         │                               │ 确认提交     │
│ 伏笔           │ 待写入 Fact / diff              │             │
└───────────────┴───────────────────────────────┴─────────────┘
```

### 24.2 设计语言原则

后续前端应遵守：

- 写作工作台优先，不做营销页。
- 界面应支持长期、密集、可扫描的信息工作。
- 草案、提案、已提交状态必须视觉上明确区分。
- Core 世界状态与作者备注必须视觉上明确区分。
- 地图、图谱、时间线是一级视图，不是弹窗附属功能。
- 提交操作必须有清晰确认区域。
- 错误和规则冲突必须可读、可追踪、可修复。

### 24.3 关键视图预留

- Project Overview
- Idea Board
- Entity Database
- Relation Graph
- Map / Spatial View
- Timeline View
- Scene Board
- Draft Editor
- Proposal Review
- World State Snapshot
- Reader Knowledge View
- Retcon Impact View

### 24.4 前端数据边界

前端可以保存：

- 面板布局
- 图谱节点位置
- 地图视图配置
- 当前过滤器
- 草案编辑状态
- 用户选中的工作流步骤

前端不能把这些 UI 状态混入 Core 世界状态。

### 24.5 Core 类型深度适配

前端必须深度适配 Core 的基础类型，但不能把 Core 类型直接等同于作者看到的全部创作分类。

需要适配的 Core 类型：

- `EntityKind`
- `RelationKind`
- `EntityRecord`
- `Fact`
- `NarrativeEvent`
- `NarrativeThread`
- `Knowledge`
- `ProposalResult`
- `ValidationReport`

前端应分成三层显示：

```text
作者可见层
  使用 ProjectBlueprint 中的实体类型、关系类型、地图类型和视图名。

写作过程层
  显示草案、候选关系、候选规则、未确认设定和工作流阶段。

Core 状态层
  显示已提交 EntityRecord、Fact、Event、Thread、Knowledge 和规则校验结果。
```

适配原则：

- 作者默认看到项目语言，不直接看到 `EntityKind`、`RelationKind`。
- 高级/调试视图可以显示 Core 原始类型和 ID。
- 所有 Core 提交预览必须展示“人话说明 + Core diff”。
- 同一个实体需要展示两种身份：项目内身份与 Core 注册身份。
- 同一个关系需要展示三种映射：项目关系、Core predicate、Core RelationKind。
- 未提交草案必须和已提交 Core 状态视觉区分。

示例展示：

```text
作者可见：
  沈笙 是「灰域退缩者」

写作层映射：
  Project Entity Type: anomaly_bearer

Core 映射：
  EntityKind: entity
  Fact: ent_shensheng ability = 使灰域退缩
  RelationKind: state
```

### 24.6 Proposal Review 前端适配

提案审核页是前端的关键视图。

必须展示：

- 自然语言事件摘要
- 将新增 / 更新 / 撤销的 Fact
- 涉及的 EntityRecord
- ProjectBlueprint 类型映射
- Core EntityKind / RelationKind / predicate 映射
- 可能新增的 Thread
- Knowledge 可见性变化
- Rule / Validation 警告
- 是否需要 WorldRuleCandidate
- 用户确认按钮

禁止：

- 只显示“是否提交”而不展示将写入的世界状态。
- 只显示 Core ID 而不显示作者可理解的说明。
- 将 schema extension 和普通事件提交混在一个按钮里。

---

## 25. 阶段路线

### Phase 7：Writing Layer 基础

目标：建立写作层的最小正式流程。

范围：

- Writing Layer 总体设计
- ProjectBlueprint 最小模型
- Core 类型前端适配规范
- 写作层领域模型与状态机
- SourceRef、AuditLog、错误模型
- IdeaBoard / IdeaService 最小实现
- DraftManager / DraftService 最小实现
- EntitySketch / EntityService 最小实现
- Proposal Review 视图模型
- CoreBridge 最小实现和对账机制
- Agent 权限、意图识别和上下文组装改造
- 首页、设定池、草案、审核中心的最小前端或内部视图
- 禁止路径测试和普通作者字段过滤测试
- 权限、安全与隐私边界
- 写作层数据版本与迁移策略
- 前端交互状态和组件动作契约
- Phase 7 开发门禁与演示门禁

验收：

- 用户想法不会直接写入 Core。
- 草案可修改，不产生正式 Fact。
- 沙盒推演后进入等待确认。
- 用户确认后才提交到 Core。
- 提交后可读取当前世界状态。
- Proposal Review 能显示项目语言与 Core 类型映射。
- Agent 不能直接调用正式提交工具。
- 普通作者视图不展示 `EntityKind`、`RelationKind`、predicate、schema、Core ID 等技术字段。
- Core 提交失败和写作层回写失败都有可恢复状态。
- 保存成功不等于正式提交成功。
- 对账、迁移和后台任务都不能创造作者确认。
- 演示必须由真实写作层状态驱动，不能用聊天文本或伪造 committed 代替。

### Phase 8：实体、关系与图谱

范围：

- WritingEntitySketch
- WritingRelation
- 关系类型系统
- Core Fact 到关系图投影
- GraphView 数据模型
- 基础关系图导出

### Phase 9：地理与多层宇宙

范围：

- SpatialNode
- SpatialEdge
- MapView
- ProjectBlueprint 驱动的空间类型
- 内部预设到项目蓝图的生成机制
- 地点与 Core entity 映射
- 角色位置与路线视图
- 地理可达性软检查

### Phase 10：章节、场景与时间线

范围：

- ChapterPlan
- ScenePlan
- TimelineView
- 角色行程
- 场景调度
- 时间线冲突检查

### Phase 11：读者模型、伏笔与信息释放

范围：

- ReaderKnowledgeState
- RevealPlan
- ForeshadowingPlanner
- 读者可见状态
- 悬念与误导管理

### Phase 12：正文、修订与产品化前端

范围：

- 正文草稿
- 风格系统
- 修订系统
- Retcon 可视化
- 前端工作台
- 导入导出

---

## 26. Phase 7 第一阶段切片

第一阶段只实现一个纵向闭环：

```text
用户提出作品想法
  ↓
系统整理成 idea draft
  ↓
系统生成候选 ProjectBlueprint
  ↓
用户确认方向
  ↓
系统生成第一幕草案
  ↓
注册候选实体
  ↓
沙盒推演第一幕事件
  ↓
展示 proposal
  ↓
用户确认
  ↓
commit_event
  ↓
输出当前世界状态
```

第一阶段不做：

- 完整地图编辑器
- 完整图谱前端
- 正文长文本生成
- 多 Agent 协作
- 多宇宙可视化编辑
- 复杂读者模型
- 自动章节规划
- 自动固化 World Package
- Agent 自动提交 Core

但第一阶段的数据模型必须为这些能力预留扩展点。

---

## 27. 待确认问题

1. 写作层是否使用与 Core 相同的 SQLite 数据库，还是独立 sidecar 数据库？
2. WritingProject 是否应成为包内正式 API，还是先作为应用层对象？
3. 第一版是否需要持久化地图和图谱布局，还是只定义类型？
4. 前端工作台是否优先 CLI/TUI、Web、还是桌面集成？
5. ProjectBlueprint 第一版是否只保存在内存/AgentStore，还是新增 writing_* 表？
6. ReaderModel 是否应独立于 Core Knowledge，还是通过 Knowledge 的特殊 entity 表示读者？
7. 内部预设应放在代码中、配置文件中，还是后续作为可安装包分发？

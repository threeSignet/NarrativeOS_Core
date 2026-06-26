# NarrativeOS Web 端设计文档

**项目代号**：NarrativeOS-Core
**创建日期**：2026-06-21
**最后更新**：2026-06-26
**状态**：设计阶段

---

## 1. 定位与目标

### 1.1 这是什么

NarrativeOS Web 端是写作层的**产品界面**——把 CLI 验证过的所有能力（灵感→蓝图→实体→草案→事件→审核→提交→世界状态）套上可视化的创作工作台。

### 1.2 不是什么

- 不是 Core 引擎的扩展——不改 Core 代码
- 不是简单的聊天界面——是完整的创作工作台
- 不是一次性做完的——分阶段交付，但设计一次想清楚

### 1.3 核心原则

1. **写作工作台优先**——界面服务写作，不是把所有功能堆在第一屏
2. **沉浸式体验**——写作时 UI 消失，规划时信息密集，随场景切换
3. **视觉区分**——正式状态/候选/草案/提示必须有稳定视觉区分
4. **提交受保护**——正式写入必须走审核确认流程，不可误触
5. **作者不见技术字段**——普通界面不出现 schema/JSON/predicate/Core ID
6. **图谱/地图/时间线是一级视图**——不是弹窗附属功能

---

## 2. 技术选型

### 2.1 前端框架

**Vue 3+**（Composition API + TypeScript）

- 响应式系统天然适合编辑器状态管理（选中实体、当前章节、面板显隐）
- 组件化契合面板布局——每个面板就是一个 Vue 组件，按需挂载
- Composition API 让面板逻辑独立，互不干扰
- TypeScript 原生支持（与后端共享类型定义）

### 2.2 桌面端壳

**Tauri 2.0**（Rust + WebView）

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
| 富文本编辑器 | TipTap (ProseMirror) | 可扩展、支持自定义节点/标记，有 Vue 版本 |
| 图可视化 | Cytoscape.js / vue-flow | 关系图、空间图、影响图 |
| 状态管理 | Pinia | Vue 官方推荐，TypeScript 友好 |
| 路由 | Vue Router | 多视图导航 |
| UI 组件库 | **自研组件** | 完全自主控制样式，不用第三方 UI 框架 |
| 实时通信 | Socket.io / 原生 WebSocket | Agent 流式响应 |
| 拖拽布局 | 自研（基于 Vue 拖拽指令） | 面板大小调整、拖拽布局 |
| 图标 | 自研 SVG 图标组件 | 线性风格，2px 描边，24x24 基准，不用 emoji |
| 主题 | CSS 变量 + data-theme | 暗色/亮色切换，不用 UI 框架的主题系统 |

---

## 3. 布局系统

### 3.1 设计理念

写作工具不是管理后台，也不是代码编辑器。写作是沉浸式活动，UI 应该在需要时出现、不需要时消失。

核心矛盾：**信息密度** vs **沉浸感**。规划时需要密集信息，写作时需要零干扰。

**采用模式切换布局**：不同工作场景使用不同的面板组合，通过顶栏模式切换器切换。不是固定三栏，而是按场景动态变化。

### 3.2 区域定义

```
区域 A（活动栏）→ 区域 B（侧边面板）→ 区域 C（主工作区）→ 区域 D（右侧栏）
                                     ↕
                           区域 E（底部抽屉：Agent 对话）
```

顶部是全局顶栏，底部是状态栏。

| 区域 | 宽度 | 可折叠 | 职责 |
|------|------|--------|------|
| A. 活动栏 | 48px | 按模式显隐 | SVG 图标按钮，切换当前模块 |
| B. 侧边面板 | 240px | 是 | 当前模块的导航树/列表 |
| C. 主工作区 | 自适应 | 否 | 渲染当前模块对应的 Vue 视图组件 |
| D. 右侧栏 | 300px | 是 | 上下文面板（属性/检查/建议） |
| E. 底部抽屉 | 可拉起 | 是 | Agent 对话，全局可用 |

### 3.3 活动栏模块

从上到下排列的 SVG 图标按钮，每个对应一个视图组件：

| 图标 | 模块 ID | 名称 | 渲染组件 |
|------|---------|------|---------|
| 笔形 | draft | 写作 | DraftEditor（TipTap 编辑器） |
| 大纲形 | outline | 大纲 | OutlineView（章节结构编辑） |
| 网络形 | graph | 图谱 | GraphView（关系图谱可视化） |
| 时钟形 | timeline | 时间线 | TimelineView（时间轴） |
| 书本形 | knowledge | 知识 | KnowledgeView（知识可见性矩阵） |
| 灯泡形 | idea | 灵感 | IdeaBoard（灵感卡片墙） |
| 齿轮形 | settings | 设置 | ProjectSettings（项目配置） |

图标风格：线性 SVG，2px 描边，24x24 尺寸，不使用任何 emoji。

### 3.4 渲染路径链路

```
用户点击活动栏图标
  → AppStore.setActiveModule('draft')
    → 侧边面板：根据 module 渲染对应列表
    → 主工作区：<component :is="viewMap[activeModule]" />
    → 右侧栏：根据主工作区选中对象刷新上下文
```

```typescript
const viewMap: Record<ModuleId, Component> = {
  draft:     DraftEditor,
  outline:   OutlineView,
  graph:     GraphView,
  timeline:  TimelineView,
  knowledge: KnowledgeView,
  idea:      IdeaBoard,
  settings:  ProjectSettings,
}

const panelMap: Record<ModuleId, Component> = {
  draft:     ChapterList,
  outline:   OutlineTree,
  graph:     EntityList,
  timeline:  EventList,
  knowledge: EntityList,
  idea:      IdeaList,
  settings:  null,
}
```

### 3.5 右侧栏内容规则

右侧栏不跟随活动模块切换，跟随**主工作区中的选中对象**变化：

| 选中对象 | 右侧栏显示 |
|---------|-----------|
| 编辑器中光标在实体名上 | 该实体属性卡片 |
| 图谱中选中节点 | 节点详情 + 关联事实 |
| 大纲中选中章节 | 章节摘要 + 涉及实体列表 |
| 无选中对象 | 默认显示一致性检查摘要 |

---

## 4. 七种工作模式

### 4.1 模式一：纯净写作模式

适用场景：作者专注写正文，不需要任何辅助面板。

布局：编辑器居中独占，左右栏全部收起，顶栏和状态栏极简化。

```
+------------------------------------------------------------------+
|  作品名 · 第3章                [写作 v]              [亮/暗] [齿轮] |
+------------------------------------------------------------------+
|                                                                  |
|                 修仙界灵气复苏的第三百年。                          |
|                                                                  |
|                 沈墨独自站在青云峰顶，远眺群山。三百年前那场浩        |
|                 劫让整个修仙界灵气枯竭，如今终于有了复苏的迹象。      |
|                                                                  |
|                 他低头看了看手中的青虹剑，剑身微微泛着蓝光。          |
|                                                                  |
+------------------------------------------------------------------+
|  2,340 字  |  第3章/共12章  |  世界状态 v42  |  Agent 就绪        |
+------------------------------------------------------------------+
```

特点：
- 顶栏只保留作品名、章节、模式切换、主题和设置
- 左侧活动栏完全隐藏（鼠标移到左边缘时滑出）
- 右侧栏完全隐藏
- 编辑器内容区域居中，最大宽度 720px，两侧留白
- 状态栏只显示最基础的信息

### 4.2 模式二：参考写作模式

适用场景：写作过程中需要随时查看实体属性、一致性检查结果、Agent 建议。

布局：编辑器占主导，右侧栏按需显示上下文信息。

```
+------------------------------------------------------------------+
|  作品名 · 第3章                [写作 v]              [亮/暗] [齿轮] |
+------------------------------------------------------------------+
|                          |                       |                |
|                          |    修仙界灵气复苏      |   属性          |
|    （活动栏收起，          |    的第三百年。        |   沈墨          |
|     鼠标悬停展开）         |                       |   身份：修士    |
|                          |    沈墨独自站在        |   境界：金丹    |
|                          |    青云峰顶，远眺      |   武器：青虹剑  |
|                          |    群山。              |   门派：青云宗  |
|                          |                       |                |
|                          |    他低头看了看        |   ----          |
|                          |    手中的青虹剑...     |   一致性检查     |
|                          |                       |   一切正常      |
+------------------------------------------------------------------+
|  2,340 字  |  第3章/共12章  |  世界状态 v42  |  Agent 就绪        |
+------------------------------------------------------------------+
```

特点：
- 左侧活动栏默认收起，鼠标悬停到左边缘时滑出
- 编辑器占约 60% 宽度
- 右侧栏显示当前光标所在段落涉及的实体属性
- 如果编辑器中没有定位到具体实体，右侧栏显示一致性检查摘要

### 4.3 模式三：图谱模式

适用场景：查看和编辑实体关系网络。

布局：图谱可视化占主导，左侧实体列表辅助筛选。

```
+------------------------------------------------------------------+
|  作品名                      [写作 v]                [亮/暗] [齿轮]  |
+------------------------------------------------------------------+
|          |                          |                             |
|  实体列表 |       关系图谱            |   节点详情                  |
|          |    （Cytoscape 渲染）     |                             |
|  [x] 沈墨 |                          |   沈墨                      |
|  [ ] 沈笙 |     沈墨 ---兄妹--- 沈笙  |   与 沈笙：兄妹              |
|  [x] 青云宗|       |                  |   与 青云宗：所属            |
|  [ ] 李长老|     所属                   |   与 李长老：师徒            |
|          |       |                  |                             |
|  筛选：   |     青云宗               |   关联事件（5条）             |
|  人物 ●   |     师徒                  |   - 第1章：加入青云宗         |
|  门派 ○   |       |                  |   - 第3章：获得青虹剑         |
|  物品 ○   |     李长老                |                             |
+------------------------------------------------------------------+
|  节点 6  |  关系 8  |  最后更新：刚刚                |  Agent 就绪  |
+------------------------------------------------------------------+
```

特点：
- 左侧栏：实体列表，可按类型筛选，勾选决定图谱显示范围
- 主工作区：关系图谱可视化画布，支持拖拽、缩放、点击选中
- 右侧栏：选中节点详情（基本信息、所有关系、关联事件）

### 4.4 模式四：大纲模式

适用场景：规划章节结构、调整情节顺序。

```
+------------------------------------------------------------------+
|  作品名                      [写作 v]                [亮/暗] [齿轮]  |
+------------------------------------------------------------------+
|          |                          |                             |
|  章节树   |       大纲编辑区          |   章节详情                  |
|          |                          |                             |
|  第1章    |   第3章 青云峰危机         |   摘要：                     |
|    开篇  |   ----                   |   沈墨发现灵气异动，          |
|  第2章    |                          |   独自前往调查，              |
|    相遇  |   梗概：                  |   意外获得上古传承            |
|  第3章 ◀─|   沈墨在青云峰发现灵气      |                             |
|    危机  |   异动，前往调查时遭遇      |   涉及实体（4个）：           |
|  第4章    |   李长老阻拦。            |   沈墨、李长老、             |
|    传承  |                          |   青云宗、青虹剑             |
|  第5章    |                          |                             |
|    ...  |                          |   字数目标：3000              |
|  [+ 新章节]|                          |   当前：2340                 |
+------------------------------------------------------------------+
|  12 章  |  总字数 28,400  |  目标 36,000  |  完成度 79%            |
+------------------------------------------------------------------+
```

特点：
- 左侧栏：章节树，支持拖拽排序、折叠展开
- 主工作区：当前选中章节的大纲编辑区
- 右侧栏：章节元数据（摘要、涉及实体、字数目标与进度）

### 4.5 模式五：审核模式

适用场景：作者提交事件前，查看系统生成的变更预览和一致性检查。

```
+------------------------------------------------------------------+
|  作品名 · 提交审核                [写作 v]              [亮/暗] [齿轮] |
+------------------------------------------------------------------+
|          |                          |                             |
|  提交来源 |      变更预览             |   影响分析                  |
|          |                          |                             |
|  事件描述 |   新增事实（2条）：        |   涉及实体（3个）：           |
|  沈墨获得 |                          |   沈墨 - 境界变更             |
|  青虹剑   |   1. 沈墨.拥有.青虹剑     |   青虹剑 - 所属变更           |
|          |      [新增]               |   李长老 - 关系变更           |
|  事件类型 |                          |                             |
|  assert  |   2. 沈墨.境界.金丹       |   规则警告（1条）：           |
|          |      [更新：筑基→金丹]     |   金丹突破需间隔30天          |
|  章节    |                          |   （第2章已突破，符合）         |
|  第3章   |   删除事实（0条）          |                             |
|          |                          |   [批准提交]  [驳回修改]      |
+------------------------------------------------------------------+
|  审核模式  |  提交后世界状态版本将变为 v43                         |
+------------------------------------------------------------------+
```

特点：
- 左侧栏：提交元信息（事件描述、类型、章节）
- 主工作区：变更预览（新增/更新/删除的事实，颜色区分）
- 右侧栏：影响分析（涉及实体、规则检查结果）
- 底部：批准/驳回操作按钮
- 编辑器不可见（保护审核专注度）

### 4.6 模式六：知识模式

适用场景：查看某个角色在特定章节知道什么信息，管理信息可见性。

```
+------------------------------------------------------------------+
|  作品名                      [写作 v]                [亮/暗] [齿轮]  |
+------------------------------------------------------------------+
|          |                          |                             |
|  实体选择 |      知识可见性矩阵        |   知识详情                  |
|          |                          |                             |
|  > 沈墨  |   章节    已知信息          |   沈墨 在 第3章             |
|  沈笙    |   ----   ----------       |                             |
|  李长老  |   第1章   青云宗存在        |   已知：                     |
|          |   第2章   弟弟失踪          |   - 青云宗存在（确信度 100%） |
|  筛选：  |   第3章   灵气异动          |   - 弟弟失踪（确信度 80%）    |
|  全部 ●  |          青虹剑位置        |   - 灵气异动（确信度 60%）    |
|  已知 ○  |   第4章   上古传承          |                             |
|  疑惑 ○  |          ...              |   未知：                     |
|          |                          |   - 李长老真实身份            |
|          |                          |                             |
|          |                          |   [标记为已知]  [标记为遗忘]   |
+------------------------------------------------------------------+
|  沈墨 知道 12 条信息  |  不知道 5 条  |  最后更新：第3章             |
+------------------------------------------------------------------+
```

特点：
- 左侧栏：实体列表，点击切换查看不同角色的知识状态
- 主工作区：知识矩阵（行=章节，列=该角色在每章知道的信息）
- 右侧栏：选中章节的详细知识条目（内容、确信度、来源）

### 4.7 模式七：灵感模式

适用场景：收集和管理碎片化的灵感，不涉及正式的世界状态。

```
+------------------------------------------------------------------+
|  作品名 · 灵感板                [写作 v]              [亮/暗] [齿轮] |
+------------------------------------------------------------------+
|          |                                                     |
|  灵感列表 |    +----------------+  +----------------+           |
|          |    | 魔族入侵动机    |  | 沈笙隐藏身份    |           |
|  收集箱(3)|    |                |  |                |           |
|  成熟(1) |    | 不是为了毁灭    |  | 她其实不是人类  |           |
|  已转化(5)|    | 而是为了某种    |  | 而是半妖血统    |           |
|          |    | 更深层的目的... |  | 被青云宗收养... |           |
|  标签：   |    |                |  |                |           |
|  [角色] ● |    | 成熟度：酝酿中  |  | 成熟度：接近可用 |           |
|  [情节] ○ |    | [转化为草案]    |  | [转化为草案]    |           |
|  [设定] ○ |    +----------------+  +----------------+           |
|          |                                                     |
|          |    +----------------+  +----------------+           |
|          |    | 第三方势力      |  | 灵气复苏真相    |           |
|          |    | 除了正魔两道    |  | 复苏不是自然    |           |
|          |    | 还有隐藏的...   |  | 而是某种仪式... |           |
|          |    +----------------+  +----------------+           |
+------------------------------------------------------------------+
|  灵感 12 条  |  已转化 5 条  |  [+ 新灵感]                        |
+------------------------------------------------------------------+
```

特点：
- 左侧栏：灵感分类列表（收集箱/成熟/已转化），支持标签筛选
- 主工作区：卡片墙布局，每个灵感一张卡片
- 右侧栏：不使用
- 卡片可拖拽在分类之间移动，点击可"转化为草案"进入写作模式

### 4.8 模式与面板的关系

| 模式 | 左侧活动栏 | 侧边面板 | 右侧栏 | 编辑器 |
|------|-----------|---------|--------|--------|
| 写作 | 隐藏 | 隐藏 | 隐藏/按需 | 全屏 |
| 参考写作 | 隐藏 | 隐藏 | 显示 | 主导 |
| 图谱 | 显示 | 实体列表 | 节点详情 | 隐藏 |
| 大纲 | 显示 | 章节树 | 章节详情 | 隐藏 |
| 审核 | 显示 | 提交来源 | 影响分析 | 隐藏 |
| 知识 | 显示 | 实体选择 | 知识详情 | 隐藏 |
| 灵感 | 显示 | 灵感列表 | 隐藏 | 隐藏 |

---

## 5. 模式切换机制

### 5.1 切换入口

顶栏中央有模式切换器，显示当前模式名称和下拉菜单：

```
[写作 v]    点击展开：
             - 写作（快捷键 1）
             - 图谱（快捷键 2）
             - 大纲（快捷键 3）
             - 审核（快捷键 4）
             - 知识（快捷键 5）
             - 灵感（快捷键 6）
```

### 5.2 自动触发

| 触发操作 | 自动切换到 |
|---------|-----------|
| 从灵感卡片点击"转化为草案" | 写作模式 |
| 点击提交按钮 | 审核模式 |
| 审核模式下点击"驳回修改" | 写作模式 |
| 审核模式下点击"批准提交" | 写作模式 |

### 5.3 快捷键

| 快捷键 | 功能 |
|--------|------|
| Cmd/Ctrl + 1 | 切换到写作模式 |
| Cmd/Ctrl + 2 | 切换到图谱模式 |
| Cmd/Ctrl + 3 | 切换到大纲模式 |
| Cmd/Ctrl + K | 打开命令面板（全局搜索） |
| Cmd/Ctrl + Enter | 提交当前草稿（进入审核模式） |
| Esc | 回到写作模式 |

### 5.4 命令面板（Cmd+K）

全局命令面板，输入关键词直达任何功能：

```
+------------------------------------------------------------------+
|  Cmd+K                                                            |
|  输入命令或搜索...                                                 |
|  +--------------------------------------------------------------+ |
|  | 写作 > 编辑第3章正文                                          | |
|  | 图谱 > 查看沈墨的关系                                         | |
|  | 大纲 > 跳转到第5章                                            | |
|  | 知识 > 查看李长老在第3章知道什么                                | |
|  | 设置 > 修改项目名称                                           | |
|  +--------------------------------------------------------------+ |
+------------------------------------------------------------------+
```

---

## 6. 主题系统

### 6.1 CSS 变量定义

```css
:root[data-theme="light"] {
  --bg-primary: #FFFFFF;
  --bg-secondary: #F8F9FA;
  --bg-tertiary: #F3F4F6;
  --text-primary: #1A1A1A;
  --text-secondary: #6B7280;
  --border-color: #E5E7EB;
  --accent: #2563EB;
  --accent-hover: #1D4ED8;
  --danger: #DC2626;
  --success: #16A34A;
  --warning: #D97706;
}

:root[data-theme="dark"] {
  --bg-primary: #1A1A1A;
  --bg-secondary: #252525;
  --bg-tertiary: #2D2D2D;
  --text-primary: #E5E7EB;
  --text-secondary: #9CA3AF;
  --border-color: #374151;
  --accent: #60A5FA;
  --accent-hover: #93C5FD;
  --danger: #F87171;
  --success: #4ADE80;
  --warning: #FBBF24;
}
```

### 6.2 切换逻辑

- 首次访问检测 `prefers-color-scheme`
- 之后读取 `localStorage`
- 所有组件通过 `var(--xxx)` 引用颜色，禁止硬编码色值

### 6.3 来源层级颜色系统

| 层级 | 亮色 | 暗色 | 含义 |
|---|---|---|---|
| committed | #22c55e | #4ADE80 | 已提交到 Core |
| candidate | #eab308 | #FBBF24 | 候选中 |
| draft | #3b82f6 | #60A5FA | 草案中 |
| hint | #94a3b8 | #9CA3AF | 线索 |
| association | #a855f7 | #C084FC | 视图关联 |
| deprecated | #ef4444 | #F87171 | 已废弃 |

---

## 7. Agent 对话面板（全局）

Agent 对话面板不属于任何模式，全局可用。

默认状态：主工作区底部显示一行输入框和 Agent 状态指示。
向上拖拽或点击展开：显示完整对话历史。

```
+------------------------------------------------------------------+
|  模式内容区域...                                                   |
+------------------------------------------------------------------+
|  Agent 对话  |  [输入消息...]                       |  [发送]     |
+------------------------------------------------------------------+
```

展开后：

```
+------------------------------------------------------------------+
|  模式内容区域...                                                   |
+------------------------------------------------------------------+
|  Agent 对话                                        [收起] [清空]  |
|  +--------------------------------------------------------------+|
|  | 我：帮我看一下第3章有没有设定矛盾                               ||
|  |                                                              ||
|  | Agent：检查完成，发现1个潜在问题：                              ||
|  | - 沈墨的境界在第2章是筑基，但第3章中他使                        ||
|  |   用了需要金丹才能施展的剑法。建议确认是否                       ||
|  |   需要在第2章和第3章之间添加突破场景。                           ||
|  +--------------------------------------------------------------+|
|  | [输入消息...]                                      |  [发送]  ||
|  +--------------------------------------------------------------+|
+------------------------------------------------------------------+
```

---

## 8. 信息架构

### 8.1 导航结构

```
顶栏：作品名 / 当前章节 / 模式切换 / 提交状态指示 / 主题 / 设置
├── 写作（Draft Editor）★ 主工作区
│   ├── 章节列表（侧边面板）
│   ├── 正文编辑器（主工作区）
│   └── 场景面板（可展开）
├── 大纲（Outline View）
│   ├── 章节树（侧边面板）
│   ├── 大纲编辑区（主工作区）
│   └── 章节详情（右侧栏）
├── 图谱（Relation Graph）
│   ├── 实体列表（侧边面板）
│   ├── 关系网络可视化（主工作区）
│   └── 节点详情（右侧栏）
├── 时间线（Timeline View）[Phase 10]
│   ├── 事件列表（侧边面板）
│   ├── 事件时间轴（主工作区）
│   └── 事件详情（右侧栏）
├── 知识（Knowledge View）[Phase 11]
│   ├── 实体选择（侧边面板）
│   ├── 知识可见性矩阵（主工作区）
│   └── 知识详情（右侧栏）
├── 灵感板（Idea Board）
│   ├── 灵感列表（侧边面板）
│   ├── 卡片墙（主工作区）
│   └── 无右侧栏
├── 审核（Proposal Review）★ 关键动线
│   ├── 提交来源（侧边面板）
│   ├── 变更预览（主工作区）
│   └── 影响分析（右侧栏）
└── 设置（Project Settings）
    ├── 无侧边面板
    ├── 设置表单（主工作区）
    └── 无右侧栏
```

### 8.2 导航原则

- 导航树不展示 Core ID 或技术类型——用人话（"角色"而非"EntityKind: character"）
- 待处理数量可点击追溯（徽标 → 审核页）
- 搜索结果区分来源层级（正文/草案/正式状态/候选用不同颜色标记）
- 导航状态不写入 Core（面板布局/最近访问/收藏都是前端状态）

---

## 9. 核心页面设计

### 9.1 写作编辑器（Draft Editor）

**定位**：主工作区，作者花最多时间的地方。

**布局**：
- 左侧：章节列表（可折叠）
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

### 9.2 实体管理（Entity Database）

**列表页**：
- 按类型分组（角色/地点/物品/概念，用 SVG 图标区分）
- 每个实体卡片：显示名/类型/状态标签/属性计数
- 状态颜色：registered(绿)/candidate(黄)/hint(灰)/deprecated(红)
- 筛选器：按状态/类型
- 搜索：按名称

**详情页**：
- 实体档案（Core 的 profileMarkdown，经过滤渲染）
- 属性列表（当前 status/realm/location 等）
- 出场记录（在哪些章节/事件出现）
- 关系列表（与其他实体的关系）
- 操作按钮：approve（候选→注册）/ deprecate（废弃）

**审核动线**：
- hint → [approve] → candidate → [approve] → 待确认 → [确认] → registered
- 每步有明确的视觉状态变化和确认

### 9.3 审核页（Proposal Review）

**定位**：正式写入 Core 的关键动线。必须独立、清晰、可理解。

**布局**：独立页面或全屏模式（与普通写作区隔离，防误触）

**分步骤审核**：
1. 摘要：这个事件要做什么（人话描述）
2. 事实变更：人话 Diff（新增/修改/删除哪些设定）
3. 涉及实体：哪些角色/地点受影响
4. 规则警告：有无矛盾/冲突（blocker 红色/warning 黄色/info 蓝色）
5. 决策：确认/拒绝/暂存/返回修改

**视觉规则**：
- 提交按钮不在第一步显示——必须看完所有步骤
- blocker 级警告禁用提交按钮（除非显式覆盖）
- 提交结果明确反馈（成功显示事件 ID，失败显示原因）

### 9.4 灵感板（Idea Board）

**布局**：
- 看板式布局（按成熟度分列：raw/candidate/ready）
- 灵感卡：内容摘要/类型标签/标签/关联草案数
- 操作：新建/编辑/归档/转草案

### 9.5 蓝图面板（Blueprint Panel）

**定位**：展示"系统对作品结构的理解"——不是配置页。

**内容**：
- 当前蓝图状态（implicit/drafted/active/evolving）
- 实体类型列表（label/description/aliases）
- 关系类型列表
- 变更建议（待确认的 accept/reject）

**交互**：
- 轻量确认（不是复杂配置表单）
- 作者可以完全不打开这个面板继续写作

### 9.6 世界状态快照（World State Snapshot）

**内容**：
- 全实体概览（name/typeLabel/attributeCount）
- 每个实体的属性快照（location/status/realm 等）
- 最近提交事件列表（时间/事件 ID/摘要）
- 知识可见性视图（谁知道什么——Phase 11 增强）

---

## 10. 图谱/地图/时间线视图

### 10.1 统一图谱视图

**视图模式**：
- `world`：世界状态图（全实体+全关系）
- `relationship`：人物关系图
- `spatial`：空间图（地点+可达性）
- `timeline`：时间线图（事件按章节排列）
- `thread`：伏笔图（线索依赖网络）
- `proposal`：提案影响图（某事件影响哪些实体）

**节点来源层级**（视觉颜色区分）：
- `committed`（绿色）：已提交到 Core 的正式状态
- `candidate`（黄色）：候选中的实体/关系
- `draft`（蓝色）：草案中的内容
- `hint`（灰色）：检测到的线索
- `association`（紫色）：视图层关联（非正式）
- `deprecated`（红色）：已废弃

### 10.2 地图/空间视图 [Phase 9]

**视图模式**：
- 通用空间图（默认）——节点+边的网络图
- 树状层级——多层宇宙的树形展开
- 平面地图——2D 平面布局
- 多层视图——多层宇宙的堆叠
- 时间变化图——不同章节的空间状态对比

### 10.3 时间线视图 [Phase 10]

**内容**：
- 水平时间轴（章节为刻度）
- 每个事件标记（位置/颜色按类型）
- 角色行程线（某角色在各章节的位置变化）
- 时序冲突标记（规则引擎检测到的矛盾）

---

## 11. 章节写作完整流程

### 11.1 流程图

```
新建章节 → 写正文（心流不打断）→ 章节检查 → 提取变更 → 审核 → 提交
                                    ↑                    │
                                    └── 修正后重新检查 ───┘
```

### 11.2 各阶段详解

**阶段 1：新建章节**
- 侧边面板章节列表点"+"，输入章节号+标题
- 系统创建 WritingDraft（status=drafting），绑定章节号
- 光标进入编辑器

**阶段 2：写正文（核心阶段，零干扰）**
- 直接写、让 Agent 帮写、选中改写、续写
- 侧边动态显示当前段落的实体设定（只显示不确认）
- 一致性微提示（标黄，不打断）
- Agent 对话随时可用
- 自动保存

**阶段 3：章节检查**
- 点"章节检查"→ Agent 全章扫描
- 结果分类：阻断（矛盾）/ 建议（一致性+文笔）/ 提示（伏笔+风格）
- 逐条处理（跳转正文→修改/忽略）
- 闪回/梦境标记（排除提取）

**阶段 4：提取变更**
- 点"提取变更"→ Agent 从全章正文提取设定变更候选
- 变更列表（实体/属性/旧值→新值）
- 作者勾选/排除（去掉梦境/闪回/比喻）
- 生成 ProposalView

**阶段 5：审核提交**
- 审核模式展示（摘要/Diff/涉及实体/规则警告/知识影响/决策）
- 规则引擎硬阻断必须先解决
- 确认→commitReviewedProposal→Core 更新→全局面板刷新

### 11.3 特殊情况处理

| 情况 | 处理 |
|---|---|
| 纯过渡章节（无设定变更） | 跳过提取+审核，直接标记 committed |
| 一章多次提交 | 允许（每次提取部分变更，分批提交） |
| 不提交直接写下一章 | 允许（提示"上一章变更未提交"，但不强制） |
| 闪回/梦境 | 标记后排除提取；不进 Core |
| 多视角章节 | Agent 按段落视角分组提取变更 |
| 修改已提交的章节 | 重新提取+重审核+影响检查（后续章节标黄） |

---

## 12. Agent 助手完整能力规格

### 12.1 被动回答（作者问了才答）

| 能力 | 输入 | 输出 | 后端依赖 |
|---|---|---|---|
| 查实体信息 | "王林的师父是谁" | 实体名+关系+设定摘要 | agent.processUserInput |
| 查历史设定 | "第7章写了什么" | 出场记录时间线 | Core 事件查询 |
| 查关系 | "张三和谁有关系" | 关系列表 | Phase 8 |
| 影响分析 | "把第5章境界改成金丹影响什么" | 受影响章节+内容列表 | Retcon 影响分析 |

### 12.2 主动反馈（上下文感知，不打断心流）

| 能力 | 触发条件 | 反馈内容 | 后端依赖 |
|---|---|---|---|
| 实体设定显示 | 光标停在角色名附近 | 该角色当前状态/位置/关系 | 光标→实体匹配 |
| 一致性提示 | 正文出现与 Core 矛盾的内容 | "佩剑已在第8章碎裂" | 实时规则检测 |
| 文笔提示 | 正文段落完成 | "连续5句以'他'开头" | 文笔分析 |
| 遗忘提醒 | 角色长时间未出场 | "李四已15章未出场" | 实体出场统计 |
| 伏笔提醒 | 伏笔超期 | "第8章预言已超期" | Phase 11 |
| 设定参考 | 正文出现已定义概念 | 显示该概念的定义和规则 | Core 快照 |

**关键原则**：所有主动反馈都是侧边显示，不弹窗、不阻止写作、不要求确认。反馈强度三档可调（专注/标准/详细）。

### 12.3 生成与加工

| 能力 | 输入 | 输出 | 后端依赖 |
|---|---|---|---|
| 帮写段落 | 指令（"写一段追逐戏"）| 正文段落→预览→采用 | 正文生成 API |
| 续写 | 前文+世界状态 | 续写段落→预览→采用 | 续写 API |
| 选中改写 | 选中文字+改写类型 | 改写后文本→对比→采用 | 文本加工 API |
| 章节检查 | 全章正文+世界快照 | 问题清单 | 全章分析 API |
| 变更提取 | 全章正文 | factChanges 候选 | 提取 API |

**关键原则**：所有生成结果都先预览，作者决定是否采用。不直接插入编辑器或修改 Core。

### 12.4 Agent 能力与前端的交互模式

```
┌─────────────────────────────────────────────────┐
│ 编辑器（写作区）                                   │
│                                                  │
│  正文内容...                                      │
│  沈墨走到废弃站台 ← 写到角色名时自动标记             │
│                                                  │
│                                  ┌──────────────┐│
│                                  │ 侧边动态面板  ││
│                                  │              ││
│                                  │ 沈墨         ││
│                                  │ 状态：义肢发热 ││
│                                  │ 位置：废弃站台 ││
│                                  │ 境界：筑基期  ││
│                                  │ 关系：沈笙(妹) ││
│                                  │              ││
│                                  │ 佩剑已在      ││
│                                  │ 第8章碎裂     ││
│                                  └──────────────┘│
│                                                  │
│ ┌─────────────────────────────────────────────┐ │
│ │ Agent 对话（可折叠）                          │ │
│ │ 用户：王林的师父是谁？                        │ │
│ │ Agent：张三丰，第3章出场，金丹期修士           │ │
│ │                                              │ │
│ │ [帮写] [改写] [续写] [检查] [提交]            │ │
│ └─────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────┘
```

---

## 13. 关系图完整规格

### 13.1 节点类型

| 类型 | 来源 | 示例 |
|---|---|---|
| 角色 | Core 已注册实体 | 沈墨、沈笙 |
| 地点 | Core 已注册实体 | 废弃站台 |
| 物品 | Core 已注册实体 | 黑晶碎片 |
| 概念/组织 | Core 已注册实体 | 灰域、青云门 |
| 事件 | Core 已提交事件 | 发现黑晶碎片 |
| 伏笔 | NarrativeThread | 神秘预言 |
| 候选实体 | 写作层 hint/candidate | 未审批的角色 |
| 草案 | WritingDraft | 第一章 |
| 章节 | ChapterPlan（Phase 10） | 第1章 |

### 13.2 边类型

| 类型 | 来源 | 后端依赖 |
|---|---|---|
| 正式关系 | Core Fact（relation 谓词） | Phase 8 |
| 位置关系 | Core Fact（location） | 已支持 |
| 事件参与 | Core Event subject/fact | 已支持 |
| 伏笔关联 | Thread.relatedEntities | 已支持 |
| 出处关联 | 草案/正文→实体引用 | 需适配 |
| 知识关联 | Knowledge（谁知道什么） | Phase 11 |
| 候选关系 | hint 状态的关系 | Phase 8 |
| 视图关联 | 前端手动标记 | 纯前端 |

### 13.3 交互

- 拖动节点调整布局（保存为前端状态，不写 Core）
- 过滤器（类型/状态/来源层）
- 点击节点→详情抽屉
- 点击边→来源与证据
- 从图谱跳转到正文/草案/审核页
- 保存视图布局+过滤器为预设

---

## 14. API 设计（BFF 层）

### 14.1 架构

```
前端 (Vue) ←→ BFF (Node.js) ←→ 写作层 Service ←→ Core Engine
     ↑                    ↑
  WebSocket            REST API
  (Agent 流式)         (CRUD 操作)
```

### 14.2 REST API 路由

**项目管理**：
```
GET    /api/projects                    列出所有项目
POST   /api/projects                    创建项目
GET    /api/projects/:projectId         获取项目详情
GET    /api/projects/:projectId/overview 概览仪表盘
PATCH  /api/projects/:projectId         更新项目元信息
DELETE /api/projects/:projectId         归档项目
```

**实体管理**：
```
GET    /api/projects/:projectId/entities           列出实体
GET    /api/projects/:projectId/entities/:id       实体详情
POST   /api/projects/:projectId/entities/detect    检测实体线索
PATCH  /api/projects/:projectId/entities/:id/promote   hint→candidate
PATCH  /api/projects/:projectId/entities/:id/approve   candidate→approved
PATCH  /api/projects/:projectId/entities/:id/deprecate 废弃
```

**草案管理**：
```
GET    /api/projects/:projectId/drafts              列出草案
POST   /api/projects/:projectId/drafts              创建草案
GET    /api/projects/:projectId/drafts/:id          草案详情
PATCH  /api/projects/:projectId/drafts/:id          更新草案内容
DELETE /api/projects/:projectId/drafts/:id          废弃草案
```

**事件推演与审核**：
```
POST   /api/projects/:projectId/simulate            沙盒推演事件
GET    /api/projects/:projectId/proposals           列出审核视图
GET    /api/projects/:projectId/proposals/:id       审核详情
POST   /api/projects/:projectId/proposals/:id/commit    确认提交
POST   /api/projects/:projectId/proposals/:id/resim     重新推演
```

**章节检查与变更提取**：
```
POST   /api/projects/:projectId/check               章节检查
POST   /api/projects/:projectId/extract             变更提取
```

**灵感/目标/蓝图**：
```
GET/POST  /api/projects/:projectId/ideas
DELETE    /api/projects/:projectId/ideas/:id
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
POST   /api/projects/:projectId/pending/:id/resolve 处理待确认
```

**图谱/地图/时间线**：
```
GET    /api/projects/:projectId/graph               关系图数据
GET    /api/projects/:projectId/map                 空间图数据
GET    /api/projects/:projectId/timeline            时间线数据
GET    /api/projects/:projectId/foreshadowing       伏笔看板
GET    /api/projects/:projectId/reader              读者知识状态
```

**搜索**：
```
GET    /api/projects/:projectId/search?q=&type=     全局搜索
```

**导入导出**：
```
POST   /api/projects/:projectId/import              导入文稿
GET    /api/projects/:projectId/export              导出正文
GET    /api/projects/:projectId/export/settings     导出设定集
GET    /api/projects/:projectId/backup              项目备份
```

### 14.3 WebSocket 事件

```
→ 前端发送
agent_input        作者发送消息/指令
cursor_context     光标位置变化（光标感知）
cancel_agent       取消生成

← BFF 推送
agent_token        Agent 流式回复（逐 token）
agent_tool_call    Agent 工具调用进度
agent_complete     Agent 回复完成（含 usage + 生成文本）
agent_error        Agent 错误（超时/限流/上下文过长）
entity_suggestion  侧边实体设定推送（基于光标位置）
consistency_warning 一致性提示推送
pending_update     待确认数量变化
audit_update       新审计记录
```

---

## 15. 前端状态管理

### 15.1 全局状态（Pinia stores）

```typescript
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

### 15.2 数据边界

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

## 16. 设计语言

### 16.1 排版原则

- 正文区：衬线字体（如 Noto Serif SC），阅读舒适
- UI 界面：无衬线字体（如 Inter / Noto Sans SC），清晰可扫描
- 代码/技术字段：等宽字体（仅调试视图）

### 16.2 组件风格

- 卡片：圆角(8px)、轻阴影、来源层颜色左边框
- 按钮：主操作(实色)、次操作(描边)、危险操作(红色)
- 标签：来源层颜色背景+白色文字
- 输入框：底部边框样式（写作感）

### 16.3 三层显示

1. **作者可见层**（默认）：displayName/typeLabel/summary/humanSummary
2. **写作过程层**（可展开）：status/maturity/kind/linkedIds
3. **Core 状态层**（仅调试）：coreEntityId/coreKind/predicate/factChanges

---

## 17. 交互流程

### 17.1 首次使用流程

```
打开应用
  → 项目选择页（列出已有项目 / 新建）
  → 新建项目（输入名称+前提）
  → 写作模式（空状态引导）
  → "描述你的世界观和主角"（引导输入）
  → Agent 检测实体 → 候选实体出现
  → 作者审核实体 → 确认注册
  → "写第一章"（进入编辑器）
  → Agent 推演事件 → 审核提案
  → 确认提交 → 世界状态更新
```

### 17.2 日常写作流程

```
打开项目 → 写作模式（看到上次进度）
  → 继续写正文 / 或与 Agent 对话推进剧情
  → Agent 检测到新实体/事件 → 推送到候选池
  → 作者在审核模式确认
  → 世界状态实时更新
```

### 17.3 审核确认流程（关键动线）

```
Agent 产出提案 → 顶栏显示"有待确认事项"
  → 作者点击 → 进入审核模式
  → Step 1: 摘要（这个事件做什么）
  → Step 2: 事实变更（人话 Diff）
  → Step 3: 涉及实体 + 规则警告
  → Step 4: 决策（确认/拒绝/暂存/修改）
  → 确认 → 提交到 Core → 成功反馈
  → 世界状态更新
```

### 17.4 光标上下文感知交互

```
作者在编辑器里移动光标
  → TipTap 编辑器 onSelectionUpdate 回调
  → 提取光标附近的文字（前后 50 字符）
  → 匹配 entityReferences 索引（本地，无网络请求）
  → 匹配到实体？→ 侧边面板更新显示该实体设定
  → 未匹配？→ 侧边面板显示通用写作提示
  → 关键：日常光标移动不发任何网络请求（全部用本地缓存数据）
```

### 17.5 Agent 帮写交互

```
作者输入："帮我写沈墨在灰域深处发现黑晶碎片的场景，要紧张氛围"
  → WebSocket 发送 agent_input
  → BFF：Agent 处理（带上当前正文上下文 + 世界状态快照）
  → 流式推送 agent_token（逐字显示）
  → 生成完成：agent_complete { generatedText }
  → 侧边预览区显示生成段落
    ├── [采用] → 插入编辑器光标位置
    ├── [修改] → 预览区变为可编辑
    ├── [重新生成] → 重发请求
    └── [丢弃] → 关闭预览区
```

### 17.6 选中改写交互

```
作者选中一段文字 → 右键/快捷键 Cmd+R
  → 菜单：去 AI 味 / 风格调整 / 润色 / 扩写 / 缩写
  → 选"去 AI 味" → WebSocket 发送改写请求
  → 对比视图（左原文 / 右改写）+ [采用] [再改] [丢弃]
  → 采用 → 替换选中文字
```

---

## 18. 完整场景清单

本章列出作者写长篇小说的全部操作场景，标注后端依赖状态：
- 已支持：Phase 7 已完成，后端接口可直接用
- 需适配：后端有数据但没 API/BFF 接口，需开发
- 需新功能：后端需开发新功能（标注 Phase）
- 纯前端：不需要后端，纯展示/交互

### 一、打开应用

| # | 场景 | 后端依赖 | 前端展示 |
|---|---|---|---|
| 1 | 选择项目（列出已有/新建/记住上次） | 已支持 | 项目卡片列表 + 搜索 |
| 2 | 项目间切换 | 已支持 | 返回项目列表页 |
| 3 | 项目概览（状态/进度/待处理） | 已支持 | 概览仪表盘 |
| 4 | 上次进度恢复（回到上次编辑位置） | 纯前端 | 自动定位光标 |

### 二、规划阶段（动笔前）

| # | 场景 | 后端依赖 | 前端展示 |
|---|---|---|---|
| 5 | 世界观构建（和 Agent 对话→蓝图） | 已支持 | Agent 对话 + 蓝图预览 |
| 6 | 角色设计（描述→实体候选→属性建议） | 已支持 | 实体候选卡 + 属性表单 |
| 7 | 大纲规划（章节列表+梗概） | 需 Phase 10 | 大纲编辑器 |
| 8 | 灵感收集（随手记→成熟度管理→转章节） | 已支持 | 看板式灵感板 |
| 9 | 设定文档（世界观/角色/势力整理） | 需适配 | 文档视图（可导出） |

### 三、日常写作

| # | 场景 | 后端依赖 | 前端展示 |
|---|---|---|---|
| 10 | 写正文（编辑器直接写，心流不打断） | 纯前端 | 主编辑区 |
| 11 | 光标上下文感知（写到角色→侧边显示设定） | 需适配 | 侧边动态信息面板 |
| 12 | 随时问 Agent | 已支持 | Agent 对话面板 |
| 13 | 让 Agent 帮写（指令生成→预览→采用） | 需适配 | 侧边预览区 + 采用按钮 |
| 14 | 选中改写（去AI味/风格/润色/扩缩写→对比→采用） | 需适配 | 对比视图 |
| 15 | 续写（基于前文+世界状态→预览→采用） | 需适配 | 侧边预览区 |
| 16 | 查实体详情（点名字→详情卡→关闭继续写） | 已支持 | 浮动实体详情卡 |
| 17 | 查历史设定（"第7章写了什么"→出场记录→跳转） | 已支持 | 出场时间线视图 |
| 18 | 临时记灵感（快捷键→记完继续写） | 已支持 | 快捷输入浮窗 |
| 19 | 自动保存（30秒/失焦） | 已支持 | 无（静默保存） |
| 20 | 字数统计（当前章/全书/目标进度） | 纯前端 | 底部状态栏 |

### 四、写作中的智能反馈

| # | 场景 | 后端依赖 | 前端展示 |
|---|---|---|---|
| 21 | 一致性微提示（写到矛盾→侧边标黄） | 需适配 | 侧边标黄条目 |
| 22 | 文笔微提示（重复用词/句式雷同） | 需适配 | 侧边轻提示 |
| 23 | 遗忘提醒（角色久未出场/伏笔超期） | 需 Phase 11 | 侧边提醒列表 |
| 24 | 设定参考（写到"灰域"→显示定义和规则） | 已支持 | 侧边设定卡片 |
| 25 | 反馈强度可调（专注/标准/详细三档） | 纯前端 | 设置开关 |

### 五、章节完成与检查

| # | 场景 | 后端依赖 | 前端展示 |
|---|---|---|---|
| 26 | 章节检查（全章扫描） | 需适配 | 检查结果清单 |
| 27 | 问题清单（阻断/建议/提示） | 需适配 | 分类列表 |
| 28 | 逐条处理（点问题→跳正文→修改/忽略） | 纯前端 | 正文高亮跳转 |
| 29 | 闪回/梦境标记（排除世界状态提取） | 需适配 | 段落标记按钮 |
| 30 | 重新检查 | 需适配 | 清单刷新 |

### 六、提交世界状态变更

| # | 场景 | 后端依赖 | 前端展示 |
|---|---|---|---|
| 31 | 提取变更（Agent 从全章正文提取设定变更） | 需适配 | 变更候选列表 |
| 32 | 审核页（人话 Diff + 涉及实体 + 规则检测） | 已支持 | 审核页六区域 |
| 33 | 选择性提交（勾选/排除变更） | 需适配 | 勾选 UI |
| 34 | 确认提交→Core 更新→面板刷新 | 已支持 | 成功反馈 + 自动刷新 |
| 35 | 提交失败处理 | 已支持 | 错误信息 + 重试 |

### 七、修改已完成章节

| # | 场景 | 后端依赖 | 前端展示 |
|---|---|---|---|
| 36 | 回改正文（打开旧章节修改） | 已支持 | 编辑器 |
| 37 | 变更重新提取（改正文后提示重审核） | 需适配 | 提示条 |
| 38 | 影响检查（后续章节受影响标黄） | 需适配 | 后续章节列表标黄 |
| 39 | Retcon（正式修改 Core 世界状态→影响分析→批量更新） | 已支持 | Retcon 影响图 + 确认 |

### 八、全局管理

| # | 场景 | 后端依赖 | 前端展示 |
|---|---|---|---|
| 40 | 世界状态总览 | 已支持 | 实体卡片网格 |
| 41 | 关系图 | 需 Phase 8 | Cytoscape 可交互图 |
| 42 | 地图（空间布局/角色位置/可达性） | 需 Phase 9 | 可切换的空间图 |
| 43 | 时间线（事件按章节/角色行程/时序冲突） | 需 Phase 10 | 水平时间轴 |
| 44 | 伏笔看板（状态/回收计划/超期） | 需 Phase 11 | 看板式布局 |
| 45 | 读者视角（"读者在第N章知道什么"） | 需 Phase 11 | 知识可见性矩阵 |
| 46 | 巡检报告（遗忘实体/超期伏笔/设定悬空/冲突） | 需适配 | 巡检报告页 |
| 47 | 审计日志 | 已支持 | 时间线列表 |

### 九、导入与导出

| # | 场景 | 后端依赖 | 前端展示 |
|---|---|---|---|
| 48 | 导入已有文稿（txt/docx→自动检测实体/设定） | 需适配 | 导入向导 |
| 49 | 导出正文（txt/docx/epub） | 纯前端 | 导出选项 |
| 50 | 导出设定集（角色卡/世界观/关系图） | 需适配 | 导出预览 |
| 51 | 项目备份（压缩包：db+正文+设定） | 需适配 | 备份按钮 |
| 52 | 项目迁移（跨设备） | 需适配 | 迁移向导 |

### 十、协作与分享（后续扩展）

| # | 场景 | 后端依赖 | 前端展示 |
|---|---|---|---|
| 53 | 分享设定集（只读链接给编辑） | 需新功能 | 分享链接 |
| 54 | 审稿批注（编辑在正文标注） | 需新功能 | 正文批注层 |
| 55 | 多人协作（多人写不同章节） | 需新功能 | 协作状态指示 |
| 56 | 版本管理（世界状态版本回滚） | 需适配 | 版本时间线 |

### 十一、系统与设置

| # | 场景 | 后端依赖 | 前端展示 |
|---|---|---|---|
| 57 | 项目设置（标题/前提/状态/模式/提醒强度） | 已支持 | 设置表单 |
| 58 | AI 模型配置（选模型/调参数） | 需适配 | 配置面板 |
| 59 | 界面偏好（主题/字体/布局） | 纯前端 | 偏好面板 |
| 60 | 快捷键（帮写/改写/查实体/检查/提交） | 纯前端 | 快捷键设置 |

### 十二、异常与容错

| # | 场景 | 后端依赖 | 前端展示 |
|---|---|---|---|
| 61 | 网络断开（降级：规则引擎保留，Agent 暂停） | 需适配 | 离线指示器 |
| 62 | 数据损坏（备份恢复） | 需适配 | 恢复向导 |
| 63 | 误操作恢复（提交后撤回） | 已支持 | 撤回确认 |
| 64 | 大项目性能（100万字+500实体不卡） | 纯前端 | 无（透明优化） |

### 后端依赖汇总统计

| 后端状态 | 场景数 | 占比 |
|---|---|---|
| 已支持（Phase 7） | 22 | 34% |
| 需适配（BFF/新 API） | 18 | 28% |
| 需新功能（Phase 8-11） | 14 | 22% |
| 纯前端 | 10 | 16% |

---

## 19. 数据结构

### 19.1 项目概览数据

```typescript
interface ProjectOverview {
  project: {
    id: string;
    title: string;
    premise: string;
    status: 'planning' | 'drafting' | 'reviewing' | 'paused' | 'archived';
    currentChapter: number;
    totalWordCount: number;
    version: number;
    createdAt: string;
    updatedAt: string;
  };
  stats: {
    entityCount: number;
    candidateCount: number;
    draftCount: number;
    pendingDecisionCount: number;
    proposalViewCount: number;
    ideaCount: number;
    chapterCount: number;
  };
  recentActivity: Array<{
    timestamp: string;
    action: string;
    summary: string;
    result: 'success' | 'failure' | 'partial';
  }>;
}
```

### 19.2 实体管理数据

```typescript
interface EntityListItem {
  id: string;
  displayName: string;
  typeLabel: string;
  status: 'hint' | 'candidate' | 'approved' | 'registered' | 'deprecated';
  summary?: string;
  attributeCount: number;
  lastAppearChapter?: number;
  aliases: string[];
  tags: string[];
}

interface EntityDetail {
  entity: EntityListItem;
  profile: {
    attributes: Array<{
      predicateLabel: string;
      value: string;
      updatedAt: string;
      sourceEvent?: string;
    }>;
    profileMarkdown: string;
  };
  appearances: Array<{
    chapter: number;
    eventSummary: string;
    eventDescription: string;
  }>;
  relations: Array<{
    targetEntityName: string;
    relationLabel: string;
    sourceLayer: 'committed' | 'candidate' | 'hint';
  }>;
}
```

### 19.3 草案与正文数据

```typescript
interface DraftListItem {
  id: string;
  title: string;
  chapter: number;
  status: 'drafting' | 'ready_to_simulate' | 'simulated' | 'committed' | 'archived';
  wordCount: number;
  linkedProposalViewId?: string;
  version: number;
  updatedAt: string;
}

interface DraftDetail {
  id: string;
  title: string;
  chapter: number;
  content: string;
  contentFormat: 'tiptap' | 'html' | 'plaintext';
  wordCount: number;
  status: string;
  version: number;
  entityReferences: Array<{
    entityId: string;
    displayName: string;
    position: { start: number; end: number };
  }>;
}
```

### 19.4 审核与提案数据

```typescript
interface ProposalDetail {
  id: string;
  status: string;
  chapter: number;
  source: {
    draftTitle?: string;
    draftId?: string;
    chapter: number;
    type: string;
  };
  humanSummary: string;
  factDiff: Array<{
    op: 'new' | 'updated' | 'retracted';
    entityName: string;
    predicateLabel: string;
    newValue: string;
    oldValue?: string;
    humanDescription: string;
    selected: boolean;
  }>;
  involvedEntities: Array<{
    name: string;
    typeLabel: string;
  }>;
  ruleWarnings: Array<{
    level: 'blocker' | 'warning' | 'info';
    message: string;
  }>;
  isSafeToCommit: boolean;
  canSubmit: boolean;
}
```

### 19.5 Agent 对话数据

```typescript
interface AgentInputMessage {
  type: 'agent_input';
  projectId: string;
  text: string;
  context?: {
    currentChapter: number;
    cursorPosition?: number;
    selectedText?: string;
    selectedOperation?: 'rewrite' | 'expand' | 'compress' | 'de_ai' | 'style_adjust';
    draftId?: string;
  };
}

interface AgentStreamMessage {
  type: 'agent_token';
  content: string;
}

interface AgentCompleteMessage {
  type: 'agent_complete';
  fullContent: string;
  generatedText?: string;
  generatedTextType?: 'new_paragraph' | 'rewrite' | 'continuation';
}
```

### 19.6 关系图数据

```typescript
interface GraphResponse {
  mode: 'world' | 'relationship' | 'spatial' | 'timeline' | 'thread' | 'proposal';
  nodes: GraphNode[];
  edges: GraphEdge[];
  total: number;
  filtered: number;
}

interface GraphNode {
  id: string;
  label: string;
  type: 'character' | 'location' | 'item' | 'concept' | 'event' | 'thread' | 'draft' | 'chapter';
  sourceLayer: 'committed' | 'candidate' | 'draft' | 'hint' | 'association' | 'view';
}

interface GraphEdge {
  id: string;
  label: string;
  sourceNodeId: string;
  targetNodeId: string;
  sourceLayer: 'committed' | 'candidate' | 'draft' | 'hint' | 'association' | 'view';
  direction: 'directed' | 'bidirectional' | 'undirected' | 'hierarchical';
}
```

### 19.7 章节检查数据

```typescript
interface ChapterCheckResponse {
  issues: Array<{
    id: string;
    level: 'blocker' | 'warning' | 'info';
    category: 'setting_conflict' | 'timeline_paradox' | 'character_consistency' | 'writing_quality' | 'foreshadowing';
    message: string;
    location?: {
      start: number;
      end: number;
      excerpt: string;
    };
    suggestion?: string;
    relatedEntity?: string;
    canIgnore: boolean;
    resolved: boolean;
  }>;
  summary: {
    totalIssues: number;
    blockerCount: number;
    warningCount: number;
    infoCount: number;
    canProceed: boolean;
  };
}
```

### 19.8 变更提取数据

```typescript
interface ExtractResponse {
  changes: Array<{
    id: string;
    selected: boolean;
    subject: string;
    predicate: string;
    predicateLabel: string;
    op: 'assert' | 'update' | 'retract';
    value: string;
    oldValue?: string;
    humanDescription: string;
    confidence: number;
    sourceExcerpt: string;
  }>;
  summary: string;
}
```

---

## 20. 超大规模优化策略

### 20.1 数据加载策略

| 场景 | 数据量 | 策略 |
|---|---|---|
| 正文加载 | 单章 1-3 万字 | 只加载当前章+前后章，其余按需 |
| 实体列表 | 可能 1000+ 实体 | 分页（50/页）+ 虚拟滚动 + 按类型/状态过滤 |
| 世界快照 | 1000+ 实体 x N 属性 | 懒加载（列表只显示 name+count，点击才查属性） |
| 关系图 | 数十万节点+边 | 服务器端过滤+分页 + LOD（远看无边）+ WebGL 渲染 |
| 审计日志 | 可能数万条 | 分页 + 按时间/操作类型过滤 |

### 20.2 渲染性能

| 场景 | 瓶颈 | 方案 |
|---|---|---|
| 关系图（10万+节点） | DOM 渲染崩溃 | WebGL（Cytoscape WebGL / deck.gl） |
| 正文编辑器（单章 3万字） | 大文档卡顿 | TipTap 虚拟滚动（只渲染可视区域段落） |
| 实体列表（1000+项） | 列表渲染慢 | vue-virtual-scroller 虚拟滚动 |

### 20.3 Agent 调用优化

| 场景 | 问题 | 方案 |
|---|---|---|
| 全章检查 token 超限 | 3 万字正文 + 世界状态 > 32K token | 分段检查 + RAG（只检索相关 Fact） |
| 光标感知延迟 | 每次光标移动查 Core | 本地缓存世界快照（定期刷新） |
| Agent 对话历史过长 | 多轮对话累积超 token | ContextCompressor + 滑动窗口 |

---

## 21. 错误处理与恢复

### 21.1 编辑器崩溃与数据恢复

- TipTap 内容每 5 秒写入 localStorage（轻量，不等网络）
- 自动保存到 BFF 每 30 秒（重量，含乐观锁版本号）
- 启动时检测"本地有比服务端 version 更新的草稿"→ 弹出恢复对话框
- BFF 不可达时：正文只存本地，底栏显示"离线模式"

### 21.2 同步状态指示器

| 状态 | 视觉 | 含义 | 作者需做什么 |
|---|---|---|---|
| synced | 绿色圆点 | 已保存到服务端 | 无 |
| syncing | 旋转图标 | 正在保存 | 无 |
| offline | 灰色 | 离线模式（本地保存） | 联网后自动同步 |
| conflict | 黄色 | 乐观锁冲突 | 点击查看冲突详情 |
| error | 红色 | 保存失败 | 点击重试 |

### 21.3 Agent 超时与中断

- Agent 超时（60 秒无 token）→ 显示"Agent 响应超时"+ [重试] [取消]
- 流式中断 → 已生成部分内容保留 + "生成中断，是否采用已生成的部分？"
- 作者点"停止生成" → 发 cancel_agent → BFF 中断 LLM 流

### 21.4 提交失败错误码映射

| 错误码 | 人话 | 可重试 |
|---|---|---|
| UNSAFE_PROPOSAL | "提案包含严重矛盾，无法提交" | 否 |
| STALE_PROPOSAL | "世界状态已变更，请重新推演" | 是 |
| VERSION_CONFLICT | "版本冲突，请刷新" | 是 |
| PROPOSAL_NOT_FOUND | "提案已过期或被删除" | 否 |
| FK_CONSTRAINT | "涉及未注册实体" | 否 |
| INTERNAL_ERROR | "系统内部错误" | 是 |

---

## 22. 快捷键体系

### 22.1 全局快捷键

| 快捷键 | 操作 |
|---|---|
| Cmd/Ctrl+K | 全局搜索/命令面板 |
| Cmd/Ctrl+P | 切换项目 |
| Cmd/Ctrl+1..6 | 切换工作模式 |
| Cmd/Ctrl+B | 收起/展开左栏 |
| Cmd/Ctrl+Shift+B | 收起/展开右栏 |
| Cmd/Ctrl+, | 打开设置 |
| Esc | 关闭弹窗/面板 |

### 22.2 编辑器快捷键

| 快捷键 | 操作 |
|---|---|
| Cmd/Ctrl+S | 强制保存 |
| Cmd/Ctrl+Enter | 提交章节 |
| Cmd/Ctrl+Shift+C | 章节检查 |
| Cmd/Ctrl+Shift+E | 提取变更 |
| Cmd/Ctrl+R | 选中改写 |
| Cmd/Ctrl+Shift+F | 正文内搜索 |

### 22.3 Agent/审核快捷键

| 快捷键 | 操作 |
|---|---|
| Cmd/Ctrl+Enter | 发送 Agent 消息 |
| J / K | 审核步骤间移动 |
| Enter | 确认审核 |
| Esc | 暂存审核 / 取消 Agent 生成 |

### 22.4 IME 冲突处理

- 中文输入法 composing 期间屏蔽所有快捷键
- 监听 `compositionstart`/`compositionend` 事件
- composing 中按 Enter 确认拼音，不触发提交

---

## 23. 组件级设计

### 23.1 核心复用组件

```typescript
// 来源层标签
interface SourceLayerBadgeProps {
  layer: 'committed' | 'candidate' | 'draft' | 'hint' | 'association' | 'deprecated';
  size?: 'sm' | 'md' | 'lg';
  showLabel?: boolean;
}

// 实体卡片
interface EntityCardProps {
  variant: 'list' | 'grid' | 'mini';
  entity: EntityListItem;
  onClick?: () => void;
  actions?: VNode;
}

// 人话 Diff 行
interface HumanDiffRowProps {
  op: 'new' | 'updated' | 'retracted';
  entityName: string;
  predicateLabel: string;
  newValue: string;
  oldValue?: string;
  selected?: boolean;
  onSelectChange?: (selected: boolean) => void;
  confidence?: number;
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
  isStreaming?: boolean;
  toolCalls?: Array<{
    name: string;
    status: 'started' | 'success' | 'error';
    result?: string;
  }>;
  generatedText?: {
    text: string;
    type: 'new' | 'rewrite' | 'continuation';
    onAdopt?: () => void;
    onModify?: () => void;
    onDiscard?: () => void;
  };
}

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

### 23.2 审核流程状态机

```
open → (作者审核) → author_approved → (提交) → committed
                                     ↘ commit_failed → (修复) → author_approved
open → (作者拒绝) → author_rejected
open → (来源草案修改) → expired
committed → (Retcon) → retracted

blocker 存在时：提交按钮禁用
暂存：保存当前审核进度，下次恢复
```

---

## 24. 通知系统

### 24.1 通知类型

| 类型 | 触发 | 示例 |
|---|---|---|
| 任务完成 | Agent 异步任务结束 | "章节检查完成：发现 2 个 blocker" |
| 提案就绪 | Agent 产出新提案 | "新提案：第一章设定变更（4 条）" |
| 巡检报告 | 定期巡检完成 | "巡检：2 个实体久未出场" |
| 提交结果 | 提交成功/失败 | "第一章已已提交" / "提交失败：版本冲突" |

### 24.2 写作模式下的通知降级

| 工作模式 | 通知行为 |
|---|---|
| 写作 | 只弹 blocker 级；其余只更新徽标 |
| 审核 | 全部正常通知 |
| 规划 | 全部正常通知 |
| 专注模式 | 全部静音（只更新徽标） |

---

## 25. 搜索系统

### 25.1 全局搜索入口

**位置**：顶栏 Cmd+K 命令面板

**交互**：
- 输入关键词 → 实时搜索（防抖 300ms）
- 结果分组：正文命中 / 实体命中 / 事件命中 / 设定命中
- 点击结果 → 跳转到对应位置（编辑器滚动/实体详情/时间线）

### 25.2 搜索 API

```typescript
interface SearchResponse {
  query: string;
  total: number;
  results: Array<{
    type: 'content' | 'entity' | 'event' | 'setting' | 'idea' | 'audit';
    id: string;
    title: string;
    excerpt: string;
    chapter?: number;
    jumpTarget: {
      view: 'editor' | 'entity' | 'timeline' | 'world' | 'audit';
      params: Record<string, string>;
    };
  }>;
}
```

### 25.3 后端搜索实现

- 正文搜索：SQLite FTS5（全文索引）
- 实体搜索：displayName + aliases + summary 模糊匹配
- 事件搜索：events 表 description 模糊匹配
- 设定搜索：facts 表 value + embedding_text 模糊匹配（或向量语义搜索）

---

## 26. 引导体系

功能多的写作工具需要分层引导，从不打扰到主动提示递进。核心原则：**写作时绝对不打断，引导只在空闲时出现**。

### 26.1 引导层级总览

| 层级 | 类型 | 复杂度 | 触发时机 |
|------|------|--------|---------|
| L1 | 首次引导 | 低 | 新项目创建后 |
| L2 | 空状态引导 | 低 | 页面无数据时 |
| L3 | 行为感知提示 | 中 | 用户完成某操作后 |
| L4 | 功能发现指标 | 低 | 用户从未访问某模块时 |
| L5 | 命令面板 | 中 | 用户主动触发（Cmd+K） |

### 26.2 L1：首次引导（一次性流程）

新项目创建后，用 3-5 步走完核心路径。类似产品的 "Getting Started" 向导，但更轻量——**不是弹窗覆盖，而是底部引导条**。

**流程**：

```
新建项目完成
  → 底部引导条："第一步：描述你的故事背景"
  → 用户输入世界观 → Agent 自动检测实体
  → 引导条更新："第二步：审核这些角色"
  → 用户审核实体 → 确认注册
  → 引导条更新："第三步：开始写第一章"
  → 用户写完第一章 → 引导条更新："完成！你可以自由创作了"
  → 引导条消失，标记已完成（localStorage）
```

**设计规则**：
- 引导条位于底部状态栏上方，高度 48px，可关闭
- 每步只给一句话提示 + 一个操作按钮
- 用户可以跳过任何步骤（"跳过引导"链接）
- 完成后永不再次显示
- 写作模式下引导条自动隐藏，空闲时才出现

**数据存储**：
```typescript
// localStorage
{
  onboardingCompleted: boolean;    // 是否完成首次引导
  onboardingCurrentStep: number;   // 当前步骤（0-4）
  onboardingDismissed: boolean;    // 是否手动关闭
}
```

### 26.3 L2：空状态引导（页面级）

每个页面的空状态不只是"暂无数据"，而是**行动入口**。空状态组件统一格式：图标 + 标题 + 描述 + 操作按钮。

| 页面 | 空状态标题 | 空状态描述 | 按钮 |
|------|-----------|-----------|------|
| 实体列表 | 还没有角色 | 与 Agent 聊聊你的故事，它会帮你发现角色 | [开始对话] |
| 大纲 | 先规划章节结构 | 有了大纲，写作更有方向 | [创建第一章] |
| 灵感板 | 灵感来了就记下来 | 随时记录碎片想法，成熟后转化为草案 | [新建灵感] |
| 关系图 | 注册实体后显示关系 | 这里会展示角色之间的联系网络 | [去注册实体] |
| 时间线 | 写几章后这里会有时间轴 | 事件会按章节排列，帮你检查时序 | [开始写作] |
| 知识矩阵 | 谁知道什么一目了然 | 注册实体并写几章后，这里会显示信息可见性 | [去注册实体] |
| 审核列表 | 暂无待审核提案 | Agent 会自动检测设定变更，推送给你审核 | [与 Agent 对话] |
| 世界状态 | 世界还是一片空白 | 开始写作并提交后，世界状态会在这里更新 | [开始写作] |

**设计规则**：
- 空状态组件居中显示，最大宽度 400px
- 图标使用 SVG（与活动栏风格一致）
- 操作按钮点击后跳转到对应功能
- 如果页面是因为还没到该阶段而空（如时间线需要写几章才有数据），按钮指向"开始写作"而非强推该功能

### 26.4 L3：行为感知提示（渐进式）

根据用户已经做了什么、还没做什么，在**底部状态栏左侧**显示轻量提示。每条提示只显示一次，可关闭，写作模式下静默。

**触发规则**：

| 用户行为 | 提示内容 | 出现位置 |
|---------|---------|---------|
| 写了 3 章但没提交过 | 你有 3 章未提交变更到世界状态 | 底部状态栏 |
| 注册了实体但没查看关系图 | 试试查看关系图，发现实体间的联系 | 底部状态栏 |
| 写了 5000 字但没用过 Agent | 让 Agent 帮你检查一致性 | 底部状态栏 |
| 审核过 1 次提案 | 你知道可以 Cmd+K 快速跳转到任何页面吗 | 底部状态栏 |
| 从未使用过灵感板 | 有个灵感板可以随时记录碎片想法 | 底部状态栏 |
| 章节超过 3000 字没检查 | 这章已经够长了，试试章节检查 | 底部状态栏 |
| 从未切换过主题 | 顶栏可以切换亮色/暗色主题 | 底部状态栏 |

**设计规则**：
- 提示条高度 32px，位于状态栏左侧，文字灰色，不抢视觉焦点
- 右侧有关闭按钮（x），点击后该提示永久消失
- 写作模式下提示条隐藏，切换到其他模式时才显示
- 同时最多显示 1 条提示
- 已显示过的提示记录到 localStorage，不再重复

**数据存储**：
```typescript
// localStorage
{
  hintsShown: string[];        // 已显示的提示 ID 列表
  hintsDismissed: string[];    // 已关闭的提示 ID 列表
}
```

### 26.5 L4：功能发现指标

活动栏的图标上，对于用户从未使用过的模块，显示一个小圆点（类似通知徽标但更轻）。

**触发规则**：
- 用户从未打开过某个模块 → 该模块图标右上角显示小圆点
- 用户打开过一次后，小圆点消失
- 不弹窗、不打断，只是视觉暗示

**视觉设计**：
- 小圆点：直径 6px，颜色用 `--accent`
- 位于图标右上角，不遮挡图标主体
- 首次显示时有轻微脉冲动画（2 秒后停止），之后静态显示

**数据存储**：
```typescript
// localStorage
{
  modulesVisited: string[];    // 已访问的模块 ID 列表
}
```

### 26.6 L5：命令面板（兜底引导）

Cmd+K 命令面板本身就是最好的引导——用户输入关键词就能找到任何功能，不需要记住菜单位置。

**命令面板的引导增强**：
- 打开时显示"你可能想要"推荐列表（基于用户行为）
- 用户从未使用过的功能排在推荐列表前面
- 搜索结果中，未使用过的功能标记"新"标签

### 26.7 引导状态持久化

所有引导状态存储在 localStorage，不写入 Core：

```typescript
interface GuidanceState {
  // L1 首次引导
  onboarding: {
    completed: boolean;
    currentStep: number;
    dismissed: boolean;
  };
  // L3 行为感知
  hints: {
    shown: string[];
    dismissed: string[];
  };
  // L4 功能发现
  discovery: {
    modulesVisited: string[];
  };
}
```

### 26.8 引导与模式的交互

| 当前模式 | 引导行为 |
|---------|---------|
| 写作 | 所有引导静默（L1 引导条隐藏，L3 提示隐藏，L4 圆点保留但无动画） |
| 参考写作 | L3 提示正常显示 |
| 图谱/大纲/审核/知识/灵感 | 所有引导正常显示 |

---

## 27. 权限与部署形态

### 26.1 部署形态

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

无 auth——本地应用不需要登录。项目文件就是"归属"。

### 26.2 Agent 权限边界

| Agent 能做 | Agent 不能做 |
|---|---|
| 查询实体状态 | 直接提交到 Core |
| 检测实体线索 | 直接注册实体 |
| 推演事件（沙盒） | 跳过审核流程 |
| 生成正文/改写 | 删除/修改已提交的 Fact |
| 章节检查/变更提取 | 替换编辑器正文（不经作者确认） |

---

## 28. 移动端适配

### 28.1 定位

平板和手机需要能查看、轻量编辑、确认提案和接收反馈。小屏幕不强求完整多面板。

### 28.2 适配策略

- 手机：单栏优先（正文/审核/Agent 三选一），底部抽屉切换
- 平板横屏：双栏（正文 + Agent/审核）
- 重要确认按钮固定在安全区域内
- 大图谱/地图默认进入摘要模式
- 审核页全屏模式（防误触）

---

## 29. 国际化预留

当前决策：只做中文，但架构预留 i18n。

- UI 文案用 vue-i18n（key→中文映射）
- Core 返回的 label 已有翻译层
- 不做英文/繁体版本，但文案不硬编码进组件

---

## 30. 可访问性

### 30.1 键盘导航

- 所有交互元素可 Tab 聚焦，焦点环可见
- 审核页用 focus trap
- 关系图提供替代的列表视图

### 30.2 ARIA 标注

- Agent 流式回复用 `aria-live="polite"`
- 加载状态用 `aria-busy`
- 来源层标签用 `aria-label` 描述

### 30.3 高对比度

- 深色主题 + 高对比度模式（WCAG AA 对比度 >= 4.5:1）
- 来源层颜色在高对比度模式下加图案辅助区分

---

## 31. 性能监控

### 31.1 前端性能采集

| 指标 | 采集方式 | 目标值 |
|---|---|---|
| 编辑器按键延迟 | Performance API | < 16ms（60fps） |
| Agent 首 token 延迟 | WS agent_input→agent_token | < 3s |
| API 响应时间 | fetch 包装计时 | P95 < 500ms |
| 关系图渲染帧率 | requestAnimationFrame | > 30fps |
| 首屏加载 | Performance API | < 2s |

### 31.2 崩溃报告

- Vue errorCaptured 兜底
- 崩溃日志存 localStorage（最近 10 次）
- 可导出崩溃日志供排查

### 31.3 Agent 用量仪表盘

- 按操作类型统计（帮写/改写/检查/提取/对话）
- 按章节统计 token 消耗
- 按天统计成本估算
- 用量预警（超过阈值时提醒）

---

## 32. 推荐开发顺序

| 阶段 | 交付内容 |
|------|---------|
| 骨架 | 顶栏 + 活动栏 + 模式切换框架 + 主题系统 + 空白视图占位 |
| 写作模式 | TipTap 编辑器集成 + 章节切换 + Agent 底部面板 |
| 参考写作 | 右侧属性面板 + 实体识别高亮 |
| 图谱模式 | Cytoscape 图谱 + 节点筛选 + 节点详情 |
| 大纲模式 | 章节树 + 大纲编辑 + 拖拽排序 |
| 审核模式 | 变更预览 + 影响分析 + 批准/驳回 |
| 知识模式 | 知识矩阵 + 实体切换 |

---

## 33. 细化设计决策记录（2026-06-26 一问一答）

> 本节记录前端细化设计阶段（对照 `Web-Frontend-Design-Review.md` 审查报告）经一问一答确定的架构决策。后续组件级细化以此为准。

### 33.1 工程边界与进程模型

| 决策项 | 结论 | 理由 |
|---|---|---|
| 桌面壳方案 | **Tauri + 内嵌 Node sidecar** | 复用现有写作层 TS 代码零改造；Rust 壳管理生命周期。需先做 sidecar PoC。 |
| 工程位置 | **`apps/web/`（monorepo 风格）** | 与 `narrativeos-web-demo/` 并存（demo 保留作视觉参考）；未来便于多端扩展。 |

### 33.2 BFF 与写作层接入

| 决策项 | 结论 | 理由 |
|---|---|---|
| DB 连接策略 | **每项目常驻单例**（`ProjectSession`） | 每个打开的项目常驻一套 service 实例 + DB 句柄，随项目切换激活/休眠。响应快，适合桌面端单用户。 |
| Agent 并发模型 | **项目级串行** | 一个项目同时只跑一个 Agent 任务（帮写/检查/提取），队列化。符合"作者专注一件事"心智，避免 Core 写入冲突。 |

**衍生架构**：BFF 引入 `ProjectSessionRegistry`（projectId → `{ services, db, agentQueue }`）。前端切换项目时经 WS 通知 BFF 激活/休眠对应 session。

### 33.3 前端状态管理与数据流

| 决策项 | 结论 | 理由 |
|---|---|---|
| 实体/关系参考数据缓存 | **全量缓存 + WS 增量更新** | 前端拉一次实体列表，订阅 `world_update` WS 事件局部刷新变动实体。光标感知纯本地匹配，零延迟。落实审查报告风险点 #3。 |
| 草案内容保存 | **localStorage + BFF 双写** | TipTap 内容每 5 秒写 localStorage（轻，不等网）+ 每 30 秒或失焦 POST BFF（含乐观锁 version）。崩溃可恢复，离线可写作。对齐 §21.1。 |

### 33.4 核心交互模式

| 决策项 | 结论 | 理由 |
|---|---|---|
| 模式硬度 | **模式主导 + 右栏可驻留** | 主模式切换主导布局，但右栏面板可手动钉住不随模式切走。平衡"七模式清晰心智"与"写到一半看一眼属性"的灵活需求。 |
| 临时查询交互 | **全屏/侧边浮层** | Cmd+K 或点实体名弹浮层展示图谱/详情/知识，ESC 关闭，不破坏当前模式。不必为临时查询强行切模式打断心流。 |

### 33.5 编辑器与实体高亮

| 决策项 | 结论 | 理由 |
|---|---|---|
| 实体高亮实现路径 | **路径 B：TipTap 自定义 Node/Mark**（结构化 entity 节点带 entityId） | 零误匹配、位置不漂移、改名不重扫。避免路径 A（Decoration 扫描）在"全部实体高亮"需求下误匹配爆炸 + 位置索引漂移两个根本缺陷。粘贴/导入时做一次实体识别转换（边界明确）。与 `contentFormat='tiptap'` 预留一致。 |
| 高亮范围 | **全部实体（含候选），作者可开关 + 调颜色/透明度** | 结构化节点精确绑定，全部实体高亮无误匹配风险。作者可全局开关，并设置高亮颜色深浅与透明度。 |

### 33.6 主题系统与设计 token

| 决策项 | 结论 | 理由 |
|---|---|---|
| 调色板基准 | **基于 demo 暖中性调扩展**为完整 token 系统（中性色 5-9 档 + 品牌 + 语义） | 视觉连续，demo 资产可直接迁移 |
| 来源层区分 | **颜色 + 形状双编码** | committed=实心圆 / candidate=三角 / draft=方块 / hint=虚线圈 / association=菱形 / deprecated=叉。色盲友好，解决 deprecated/association 邻近问题 |
| 字体策略 | **思源系列**（Noto Sans SC 作 UI + Noto Serif SC 作正文） | 中文写作最舒适，跨平台一致。需打包字体子集或依赖系统安装 |

### 33.7 图谱视图配置

| 决策项 | 结论 | 理由 |
|---|---|---|
| 默认布局 | **力导向（cose）+ 手动微调** | 默认 cose 自动计算，作者可拖拽微调并保存位置为预设 |
| 节点密度 | **简洁（圆圈 + 名字）** | 颜色编码来源层，形状编码实体类型，点击右侧弹详情。干净不嘈杂 |
| 渲染器 | **始终 Cytoscape WebGL 几何模式** | 始终锐利且流畅，不切换渲染器，消除阈值管理复杂度。注：WebGL 几何渲染（非纹理缓存）与 Canvas 同等锐利 |

### 33.8 审核动线

| 决策项 | 结论 | 理由 |
|---|---|---|
| 审核布局 | **单页滚动 + 固定决策面板** | 五区域（摘要/factDiff/涉及实体/规则警告/决策）垂直排列同屏滚动。决策面板固定可见，实时反馈"已选 N 条变更 / M 条警告 / 可否提交" |
| factDiff 默认勾选 | **按置信度自动选** | 高置信度默认选，低置信度默认不选，阈值可调。平衡效率与安全 |
| 提交保护 | **blocker 硬禁 + 查看软门** | blocker 存在时提交按钮禁用（不可点）；需"查看全部 factDiff"才点亮提交按钮 |
| 状态机覆盖 | **补全 7 态**（落实审查报告 U3） | open/author_approved/author_rejected/committed/commit_failed/expired/superseded 全部在 UI 有视觉表达。expired 提示"重新推演"，superseded 灰显归档 |

### 33.9 Agent 面板

| 决策项 | 结论 | 理由 |
|---|---|---|
| 面板定位 | **全局独立悬浮面板，不集成进任何模块** | Agent 是贯穿全工作流的助手，不该被写作模式绑定 |
| 面板位置 | **右侧 + 右下角独立调出按钮** | 右下角按钮调出，不遮挡主内容区；面板在右侧展开 |
| 模块感知 | **不同模块快捷操作不同**（上下文感知） | 写作模式 6 操作 / 图谱 3 操作 / 审核 3 操作 / 大纲·知识·灵感·蓝图各定制 |
| 产出展示 | **按类型分流** | 生成段落→侧边预览；问题清单→主区覆盖；变更提取→跳审核页；对话→气泡 |
| 采用交互 | **四按钮固定栏**（采用/修改/重生成/丢弃） | 采用→插入光标位。对齐 §17.5 |

**模块感知快捷操作矩阵**：

| 模式 | Agent 快捷操作 |
|---|---|
| 写作 | 帮写段落 / 续写 / 选中改写 / 章节检查 / 提取变更 / 对话 |
| 图谱 | 检测关系提示 / 分析某实体关系 / 解释冲突 |
| 审核 | 解释某条 factDiff / 解释规则警告 / 重新推演 |
| 大纲 | 生成章节梗概 / 调整节奏建议 |
| 知识 | 查询某角色在某章知道什么 |
| 灵感 | 扩展灵感 / 转草案建议 |
| 蓝图 | 解释类型映射 / 生成变更建议 |

### 33.10 引导体系落点

| 决策项 | 结论 | 理由 |
|---|---|---|
| L3 行为感知触发 | **前端本地触发** | 前端订阅 WS 事件（draft_created/proposal_committed 等）本地累计行为，本地判断阈值。无额外 BFF 逻辑 |
| L1 首次引导深度 | **3 步核心闭环** | 描述故事背景 → 审核候选实体 → 写第一章。走通核心闭环，不过度 |
| 写作模式静默 | **全静默** | 写作模式下 L1 隐藏 / L3 隐藏 / L4 圆点无动画，只保留 L5 命令面板。切到其他模式才恢复 |

### 33.11 待细化决策（组件级，后续推进）

- [ ] 顶栏/状态栏/活动栏的具体组件结构与 props
- [ ] TipTap entity 节点的 schema 定义与粘贴识别转换
- [ ] Cytoscape 节点/边的样式映射规则（sourceLayer × entityType → 样式）
- [ ] 审核决策面板的实时状态计算逻辑
- [ ] Agent 面板的 WS 事件 → UI 状态映射（流式渲染、工具进度）
- [ ] 设计 token 的最终值（亮/暗/高对比三模式的完整 CSS 变量表）
| 灵感模式 | 卡片墙 + 分类管理 |

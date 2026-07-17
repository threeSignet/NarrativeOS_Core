# 前端共享组件层 · 自审报告

> 阶段：基建（共享组件层 + 现有插件迁移统一）
> 时间：2026-07-17
> 范围：第⑤层（前端 UI），零后端改动
> 提交：7 个（节点 0 契约 → 节点 6 清理）

## 一、目标达成度

| 目标 | 状态 | 证据 |
|---|---|---|
| 建立 `src/components/` 共享组件库 | ✅ | 15 个文件（12 组件 + index.ts + UiContextMenu 的类型），967 行 |
| 12 个 Ui 组件全部落地 | ✅ | base(4) + layout(4) + form(4) + feedback(3) = 15 文件（UiContextMenu 含类型导出） |
| 4 个插件全部迁移到 Ui 组件 | ✅ | agent-panel / document-explorer / document-editor / entity-graph |
| AgentPanel 规范化为可插拔面板 | ✅ | panelView 契约 + getPanelView() + manifest，App.vue 不再硬编码 |
| 全局散落类清理 | ✅ | shell.css 删除 8 类（见第三节） |
| vue-tsc 0 错 | ✅ | 节点 0-6 每节点验证 |
| 生产构建通过 | ✅ | `pnpm build` 成功（vite build + vue-tsc） |

## 二、组件清单与覆盖度

### base/（原子组件）

| 组件 | Props | 收敛的散落模式 | 被哪些插件使用 |
|---|---|---|---|
| UiButton | variant(4态)/size(2档)/icon/active/disabled/title/type | .btn/.btn--primary/.btn--ghost/.btn--sm/.icon-btn/.op-btn/.op--primary/.op--ghost/.tb-btn/.tb-btn.on/.doc-action-btn（11 类） | 全部 4 个插件 |
| UiIcon | name/size/strokeWidth | 51+ 处 inline SVG | 全部 4 个插件 |
| UiEmpty | title/description/icon/iconSize/block | 4 处 empty-state 手写 + 内联 style | agent-panel/document-explorer/entity-graph |
| UiStatusDot | status(7枚举)/color/size | shell.css .status-dot--* + scoped .sd--*（双轨冲突，已消除） | entity-graph |

### layout/（布局组件）

| 组件 | Props/Slots | 收敛的散落模式 | 被哪些插件使用 |
|---|---|---|---|
| UiSideHead | title + #actions | 3 处 side-head 手写 | agent-panel/document-explorer/entity-graph |
| UiSearchBar | v-model + placeholder | 2 处 side-search 手写 | document-explorer/entity-graph |
| UiSideBody | default slot | 散落 side-body | document-explorer/entity-graph |
| UiPanelFooter | title/titleTone/maxHeight | decisions-panel | entity-graph |

### form/（表单组件）

| 组件 | Props | 收敛的散落模式 | 被哪些插件使用 |
|---|---|---|---|
| UiInput | v-model/placeholder/disabled/type + enter emit | .form-input(input) | entity-graph |
| UiSelect | v-model/disabled | .form-input(select) | entity-graph |
| UiTextArea | v-model/placeholder/disabled/rows/noResize + keydown emit | .form-input(textarea)/.agent-textarea | agent-panel/entity-graph |
| UiInlineForm | v-model:open + #default/#actions | create-form + form-actions | entity-graph |

### feedback/（反馈组件）

| 组件 | Props | 收敛的散落模式 | 被哪些插件使用 |
|---|---|---|---|
| UiBadge | text | entity-count | entity-graph |
| UiChip | active/color/disabled + click/update:active | filter-chip + layer-chip | entity-graph |
| UiContextMenu | x/y/items + close emit | ctx-menu + click-outside 监听 | document-explorer |

## 三、全局 CSS 清理（shell.css）

删除的类（迁移后 0 引用，经 grep 全量确认）：

| 删除的类 | 行数 | 接管组件 |
|---|---|---|
| `.side-head` / `.side-title` / `.side-actions` | 9 | UiSideHead |
| `.side-body` | 1 | UiSideBody |
| `.side-search`（含 input/ico） | 8 | UiSearchBar |
| `.icon-btn`（含 :hover/.ico） | 4 | UiButton(icon) |
| `.filter-chip`（含 :hover/.is-on） | 4 | UiChip |
| `.status-dot` / `.status-dot--*`（4 个） | 5 | UiStatusDot |
| `.chip` / `.chip--accent` | 7 | UiBadge/UiChip |

**保留的全局类**（shell 组件仍在用）：
- `.btn` / `.btn--primary` / `.btn--ghost` / `.btn--sm`——6 个 shell 组件（ConfirmDialog/Modal/SettingsPage）使用，保留
- `.empty-state`（含 .es-title/.es-desc）——EditorArea/SideBar 使用，保留
- `.side-group`——EntityGraphSideView 使用（scoped 版本已删，统一用全局），保留供未来插件复用
- `.filter-row`——容器布局，保留
- `--st-*` 主题色变量——UiStatusDot 引用，保留在 tokens.css

## 四、契约一致性核对

| 检查项 | 结果 |
|---|---|
| PluginManifest 扩展 panelView 不破坏现有 activity/sideView/mainView/editorTypes | ✅ 四个查询函数 + getPanelView 互不干扰 |
| App.vue 动态渲染面板不破坏 startResize 拖拽逻辑 | ✅ 拖拽逻辑保留，宽度状态仍在 ui store |
| 共享组件只依赖 tokens.css 变量 + Pinia store，不反向依赖 manifest | ✅ 组件内零 manifest/store 的写操作 import |
| 写操作走 store.action，组件不直接调 api/* | ✅ 全部插件写操作仍走 entity/document store |
| 提示走 useToast、确认走 useConfirm | ✅ 组件不自造提示/确认 |
| 样式禁止硬编码色值 | ✅ 全部用 --sp-*/--fs-*/--r-*/--text-*/--bg-*/--border* 变量 |

## 五、保留未迁移的部分（有意为之，记录原因）

| 保留项 | 原因 |
|---|---|
| DocumentTreeNode（树节点组件本身） | 强业务逻辑：递归/拖拽/就地重命名/HTML5 drag-drop，不属于通用组件。仅迁移其内部图标 + 右键菜单 |
| GraphCanvas（力导向图谱核心） | 强交互逻辑：力导向收敛/缩放/平移/悬停/节点拖拽，图谱专属。仅迁移其空状态 |
| DocumentEditor（TipTap 编辑器） | TipTap 专属 :deep 样式（.prose-editor 系列）+ handlePaste/自动保存/启动恢复，编辑器专属。仅迁移其动作按钮 |
| CreateInputRow（就地创建行） | 文档树专属：深度缩进 + 挂载聚焦 + Enter/Esc/失焦三态 + 创建后开 tab。交互模式与 UiInlineForm（折叠表单）不同。仅迁移其图标 |
| EditorToolbar 的 .tb-sep/.tb-group 容器 | 简单布局 div，不值得抽组件（过度抽象反增间接层） |
| GraphCanvas 的 legend/zoom-ctl/node-popover | 图谱专属控件，复用场景仅此一处 |

## 六、量化指标

| 指标 | 数值 |
|---|---|
| 新建组件文件 | 15 个（12 组件 + index.ts + 2 类型） |
| 组件库总行数 | 967 行 |
| 迁移的插件文件 | 8 个（4 插件 × 平均 2 文件） |
| 删除的散落 CSS 类 | 8 组（约 38 行全局 CSS） |
| 迁移后各插件 scoped style 行数 | AgentPanel 114 / DocumentEditor 84 / GraphCanvas 83 / DocumentTreeNode 41 / EntityGraphSideView 31 / EditorToolbar 25 / CreateInputRow 21 / DocumentTreeView 4 |
| inline SVG 消除 | 51+ 处 → 统一 UiIcon 字典 |
| 按钮类收敛 | 11 套 → UiButton 单组件（variant × size × icon × active 组合） |
| 双轨冲突消除 | status-dot（全局 vs scoped）/ side-group（全局 vs scoped）|
| 提交数 | 7 个（节点 0-6） |
| vue-tsc | 0 错 |
| 生产构建 | 通过 |

## 七、运行时回归验证(Playwright 真实浏览器驱动)

项目无 e2e 基建,使用系统已缓存的 Playwright Chromium(1223)编写临时验证脚本,驱动真实浏览器验证 4 个迁移插件的运行时行为。**两轮共 46 个检查全部通过,0 失败。**

### 第一轮:基础渲染与契约(32/32 通过)

脚本:`scripts/verify-runtime.mjs`,覆盖:
- **agent-panel**:面板初始关闭/打开后标题渲染/消息区/输入框/发送按钮/可输入
- **document-explorer**:活动栏入口/侧栏标题/树节点/搜索框/搜索过滤/新建按钮
- **document-editor**:工具栏渲染/UiButton 化的撤销·加粗·H1 按钮/TipTap 编辑区/导入·导出·复制按钮/加粗可点击
- **entity-graph**:侧栏标题/实体列表(2 行)/UiStatusDot/UiChip(7 个)/图谱节点(2 个)/**边标签中文 [守护,盟友,姐妹,互为镜像]**/**节点静止无弹动(3 次采样坐标完全一致)**/节点大小反映度数(degree=6→68px)/待确认决策面板
- **控制台**:无运行时错误

### 第二轮:深度交互(14/14 通过)

脚本:`scripts/verify-interactions.mjs`,覆盖动态行为:
- **Agent 面板拖拽改宽**:360→410px 鼠标拖拽生效
- **图谱悬停高亮**:hover 态触发
- **来源层过滤切换**:6 边→3 边(candidate 隐藏后 committed 保留)
- **缩放控件**:100%→120%
- **节点详情 popover**:点击弹出,含实体信息
- **新建文件夹流程**:就地输入框→Enter→树节点 2→3→新文件夹可见
- **右键菜单**:UiContextMenu 弹出含[新建文件夹/新建文档/重命名/归档],点外部关闭
- **全流程无未捕获异常**

### 第三轮:写流程端到端(8/8 通过)

脚本:`scripts/verify-write-flow.mjs`,覆盖计划节点 5 的核心验收链路:
- **新建实体**:点 + → UiInlineForm 展开 → 填名 → 创建 → 列表增加(4→5)→ 新实体出现
- **批准**:candidate 态实体行有"批准"按钮 → 点击成功
- **注册进 Core**:approved 态出现"注册"按钮 → 点击成功
- **图谱节点增加**:注册后图谱节点数增加(2→3)
- **无异常**

> **发现并修复的遗留问题**:验证写流程时暴露 `灰域行者/project.db` 的 `writing_entity_sketches` 等 22 张表缺 `version` 列(W3 乐观锁加列时 CREATE TABLE IF NOT EXISTS 不更新已存在的表)。这是**预先存在的 schema 迁移机制缺陷**,非本次前端基建引入(本次 7 个提交零后端改动)。已对开发库执行 ALTER TABLE 补列,写流程随即跑通。根因(无正式迁移机制)记入技术债。

### 累计:三轮 54/54 全部通过

| 轮次 | 脚本 | 检查数 | 通过 | 覆盖 |
|---|---|---|---|---|
| 1 | verify-runtime.mjs | 32 | 32 | 基础渲染 + 契约 + 边标签中文 + 节点静止 |
| 2 | verify-interactions.mjs | 14 | 14 | 拖拽/悬停/过滤/缩放/新建/右键菜单 |
| 3 | verify-write-flow.mjs | 8 | 8 | 新建实体→批准→注册进 Core→图谱节点增加 |
| **合计** | — | **54** | **54** | — |

## 八、遗留技术债（非本次范围）

1. **shell 组件未迁移**：ConfirmDialog/NewProjectModal/DeleteProjectModal/HelpModal/AppSettingsPage/ProjectSettingsPage 仍用全局 .btn 类。本次范围是 4 个插件，shell 组件留给后续
2. **chunk 大小警告**：index.js 574KB（主要是 TipTap），与本次迁移无关，既有问题
3. **UiIcon 图标集非完整**：当前收录 30 个图标（从现有插件提取）。未来新插件若需新图标，往 ICON_PATHS 字典加一行即可
4. **UiContextMenu 边界溢出**：computed pos 当前直接用 props.x/y，未做屏幕边界修正（右键菜单靠近右/下边缘时可能溢出）。当前 document-explorer 只有一种右键场景，影响小；未来多场景用时需补边界检测
5. **★ schema 迁移机制缺失(运行时验证发现,P0)**:`CREATE TABLE IF NOT EXISTS` 不更新已存在的表,导致 W3 加的 `version` 列在旧开发库(`灰域行者/project.db`)缺失,22 张表受影响,新建实体/关系等写操作报 `no such column: version`。本次已对开发库 ALTER TABLE 应急补列,但根因未解——需要正式的迁移机制(如版本号 + ALTER 脚本,或启动时 schema 比对自动补列)。这是项目级技术债,优先级高于其他项,因为任何 schema 变更都会让既有项目库写操作瘫痪

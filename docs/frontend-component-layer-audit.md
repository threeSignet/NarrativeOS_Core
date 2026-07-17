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

## 七、待浏览器验证的回归点

以下交互需在浏览器实测确认无回归（vue-tsc/build 不能覆盖运行时行为）：

1. **agent-panel**：AI 面板开/关/拖拽改宽；发消息收到流式回复；清空对话
2. **document-explorer**：新建文件夹/文档；双击重命名；拖拽移动；右键菜单（新建/重命名/归档）；搜索过滤；导入文件
3. **document-editor**：打开文档编辑（加粗/标题/列表/引用/分隔线/撤销重做）；导入 txt；导出 md；复制纯文本；自动保存
4. **entity-graph**：新建实体→批准→注册进 Core→图谱出现节点；新建关系→待确认→确认→图谱出现 committed 边；搜索高亮；来源层过滤切换；图谱缩放/平移/拖拽节点/悬停高亮；节点详情 popover（全部无弹动）

## 八、遗留技术债（非本次范围）

1. **shell 组件未迁移**：ConfirmDialog/NewProjectModal/DeleteProjectModal/HelpModal/AppSettingsPage/ProjectSettingsPage 仍用全局 .btn 类。本次范围是 4 个插件，shell 组件留给后续
2. **chunk 大小警告**：index.js 574KB（主要是 TipTap），与本次迁移无关，既有问题
3. **UiIcon 图标集非完整**：当前收录 30 个图标（从现有插件提取）。未来新插件若需新图标，往 ICON_PATHS 字典加一行即可
4. **UiContextMenu 边界溢出**：computed pos 当前直接用 props.x/y，未做屏幕边界修正（右键菜单靠近右/下边缘时可能溢出）。当前 document-explorer 只有一种右键场景，影响小；未来多场景用时需补边界检测

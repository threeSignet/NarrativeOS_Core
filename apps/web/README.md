# NarrativeOS · 起草工作台

VS Code 式可插拔编辑器外壳 + 设定集文档树 + 富文本编辑器。
起草阶段最基础的能力：**组织**（建文件夹/文档、命名、拖拽排序/移动）+ **编辑**（富文本）+ **存 SQLite**。

## 架构

```
前端 apps/web (Vue3 + Vite + TipTap)
        ↓ /api 代理
BFF  apps/bff  (fastify，调写作层 DocumentService)
        ↓ TS import
写作层 src/writing/ (DocumentService + writing_documents 表)
```

- **空壳**（`src/shell/`）：VS Code 式五区域布局（标题栏/活动栏/侧栏/编辑区/状态栏），不含业务。
- **插件机制**：每个内置插件导出 `manifest`，声明贡献（活动栏图标/侧栏视图/编辑器类型）。加功能不动 shell，只加插件目录 + 在 `plugin-registry.ts` 注册。
- **内置插件**：
  - `document-explorer`：文档树（组织能力）
  - `document-editor`：TipTap 富文本编辑器（编辑能力）

## 启动

需要两个进程：BFF（后端）+ Vite（前端）。

```bash
# 在仓库根目录装依赖（monorepo）
pnpm install

# 终端 1：启动 BFF（默认 8787）
cd apps/bff
pnpm dev

# 终端 2：启动前端（默认 5173，/api 自动代理到 BFF）
cd apps/web
pnpm dev
```

浏览器打开 **http://localhost:5173**

> 数据库默认 `apps/bff/data/drafting.db`（SQLite，WAL 模式）。可用 `DRAFTING_DB` 环境变量改路径。

## 功能清单（本轮 MVP）

- ✅ 建文件夹 / 建文档
- ✅ 重命名（双击或右键）
- ✅ 拖拽排序 + 拖拽移入文件夹
- ✅ 右键菜单（新建/重命名/归档）
- ✅ 富文本编辑（标题/列表/引用/加粗斜体/分隔线）
- ✅ 自动保存（防抖 1s）
- ✅ 字数统计
- ✅ 深色/浅色主题（data-theme，默认深色）
- ✅ 内容持久化到 SQLite

## 不在本轮范围

- 结构化模板（角色卡/地点卡）—— `template` 字段已预留
- 章节正文入口（chapter_ref）
- Core/Agent/实体提取
- Tauri 桌面壳
- 命令面板（Cmd+K 占位，未实现）
- 右侧检查面板（预留空）

## 技术栈

| 层 | 技术 |
|---|---|
| 前端 | Vue 3 + Vite + Pinia + TipTap |
| BFF | fastify + better-sqlite3 |
| 后端 | 写作层 DocumentService（复用 NarrativeOS Core） |
| 设计系统 | 从 `narrativeos-ide/` 迁移（IBM Plex + teal 强调色 + 双主题） |

## 开发命令

```bash
pnpm dev          # Vite dev（前端）
pnpm build        # 生产构建
pnpm typecheck    # vue-tsc 类型检查
```

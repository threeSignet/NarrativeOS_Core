# NarrativeOS Core

面向长篇叙事写作的世界状态一致性引擎。追踪小说中的设定、角色状态、伏笔、知识可见性，确保长篇写作中不出现设定矛盾。

详见 `AGENTS.md` 与 `docs/` 下的设计文档。

## 数据布局（存储融合后）

```
data/
├── app.db                      # 全局：项目注册表(app_projects) + 用户表(app_users 预留)
└── projects/
    └── <项目名>/
        ├── project.db          # 该项目：Core 9表 + 写作层 37表 + Agent 7表（单库，沿用不加 project_id）
        └── vectors/            # 该项目向量库（lancedb）
```

- **每项目一个 db 文件 + 一个向量库**，物理隔离（Core 表无 project_id，靠文件隔离）
- **app.db 只存路径索引 + 双 id 映射 + 预留用户**，业务元数据（标题/前提）在项目库 writing_projects
- **双 id**：coreProjectId（Core 表用，与目录名解耦）+ writingProjectId（wprj_xxx，写作层 FK 目标），1:1 绑定，app.db 存映射
- CLI 与 BFF 共用同一套装配代码（`src/session/ProjectSession`）

## 关键模块

- `src/session/`：存储融合层（AppRegistry / ProjectSession / ProjectManager）
- `src/adapters/sqlite/`：Core 适配器（FactStore / EventStore / KnowledgeStore / ThreadStore / AgentStore）
- `src/core/`：Core 引擎（ProposalManager / RuleEngine / ToolRouter / RetconEngine / ...）
- `src/writing/`：写作层（services / repositories / view-models / core-bridge）
- `src/agent/`：NarrativeAgent ReAct 循环
- `apps/web/`：Vue 3 起草工作台前端
- `apps/bff/`：BFF（HTTP 接入写作层）
- `src/cli/`：CLI 入口

## 测试

```bash
npx tsc --noEmit          # 类型检查
npx vitest run            # 全量测试
```

## 迁移旧数据

若从旧版（CLI 单文件库 / BFF drafting.db）升级：

```bash
npx tsx scripts/migrate-to-fusion.ts
```

幂等；旧库保留（copy 非 move）。

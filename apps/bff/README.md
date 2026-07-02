# NarrativeOS · 起草工作台 BFF

前端 HTTP 接入写作层 `DocumentService`。轻量装配（只装写作层，不碰 Core/Agent）。

## 启动

```bash
pnpm dev        # tsx watch（默认 127.0.0.1:8787）
```

环境变量：
- `PORT`（默认 8787）
- `HOST`（默认 127.0.0.1）
- `DRAFTING_DB`（默认 `./data/drafting.db`）

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 健康检查 |
| GET | `/api/projects/current` | 当前项目 id |
| GET | `/api/projects/:pid/documents` | 列文档树 |
| POST | `/api/projects/:pid/documents` | 新建（body: kind/title/parentId/...） |
| GET | `/api/documents/:id` | 取单个 |
| PATCH | `/api/documents/:id` | 更新（content/title/parentId，带 expectedVersion） |
| POST | `/api/projects/:pid/documents/reorder` | 同级重排 |
| DELETE | `/api/documents/:id` | 归档（文件夹级联） |

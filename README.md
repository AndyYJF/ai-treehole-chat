# AI Treehole Chat

一个偏日常聊天、倾诉和长期陪伴的单用户 AI chat 应用。当前版本以 Web 为主，服务端保存同一份长期记忆，适合个人在多个设备上访问同一个私有实例。

## 当前能力

- 简约聊天界面，第一屏就是对话。
- 用户只看到“自动 / 轻声 / 均衡 / 深谈”档位，不直接暴露具体模型名。
- 内部 DeepSeek V4 Flash / Pro 自动路由。
- LangGraph 风格聊天流程编排。
- LangMem 风格长期记忆：偏好、边界、情绪、事实、事件、安全等类型。
- 记忆可查看、确认、删除、暂停。
- DeepSeek 副模型 JSON 记忆抽取，失败时规则兜底。
- SiliconFlow rerank 记忆检索，失败时稳定排序兜底。
- 单用户 Postgres 持久化，Docker volume 保存记忆和记忆设置。
- 未配置数据库时自动回退为进程内存 store，便于本地调试。

## 本地开发

```powershell
npm install
npm run dev
```

访问：

```text
http://localhost:3000
```

## Docker 运行

```powershell
docker compose up -d --build
```

默认会启动：

- `ai-treehole-chat`：Next.js Web/API，公网端口 `3010`
- `ai-treehole-chat-db`：Postgres，仅 Docker 内网可访问
- `treehole-postgres`：Postgres 数据卷

## 环境变量

复制 `.env.example` 为 `.env.production` 或 `.env.local` 后填入：

```text
DEEPSEEK_API_KEY=
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEFAULT_USER_ID=single-user
TREEHOLE_ACCESS_TOKEN=
TREEHOLE_SESSION_SECRET=
TREEHOLE_COOKIE_SECURE=false
DATABASE_URL=
SILICONFLOW_API_KEY=
SILICONFLOW_BASE_URL=https://api.siliconflow.cn/v1
SILICONFLOW_RERANK_MODEL=Qwen/Qwen3-Reranker-0.6B
```

Docker Compose 会给 Web 容器注入内部 Postgres 的 `DATABASE_URL`，所以生产 Docker 部署不需要额外暴露数据库。

## 文档

- [开发流程](docs/development-plan.md)
- [当前状态](docs/current-status.md)
- [部署配置](docs/deployment.md)
- [frontend-design 兼容说明](docs/frontend-design-compat.md)
- [数据库 schema](db/schema.sql)

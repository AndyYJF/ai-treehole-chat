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
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
SILICONFLOW_API_KEY=
SILICONFLOW_BASE_URL=https://api.siliconflow.cn/v1
SILICONFLOW_RERANK_MODEL=Qwen/Qwen3-Reranker-0.6B
```

### 生产建议必填

- `DEEPSEEK_API_KEY`：主聊天、模型路由和记忆抽取使用的 DeepSeek API Key。未配置时，应用会走本地 mock 回复，适合开发 UI，但不能真实调用模型。
- `TREEHOLE_ACCESS_TOKEN`：进入应用的单用户口令。配置后访问 `/login` 需要输入这个口令；不配置时会关闭登录保护，只适合本地开发。
- `TREEHOLE_SESSION_SECRET`：签名登录 cookie 的密钥。未配置时会退回使用 `TREEHOLE_ACCESS_TOKEN`，生产环境建议填写一段独立随机字符串。

### DeepSeek

- `DEEPSEEK_BASE_URL`：DeepSeek OpenAI-compatible API 地址，默认是 `https://api.deepseek.com`。只有在使用代理网关或自建兼容服务时才需要改。

### 登录与单用户

- `DEFAULT_USER_ID`：单用户实例的内部用户 ID，用来隔离聊天、记忆和用量数据。单用户部署保持默认 `single-user` 即可；如果你想重开一套干净数据，可以改成新的 ID。
- `TREEHOLE_COOKIE_SECURE`：控制登录 cookie 是否只允许 HTTPS 发送。线上有 Caddy/HTTPS 时建议设为 `true`；本地 HTTP 调试时设为 `false`，否则浏览器不会保存登录态。

### 存储

- `DATABASE_URL`：Postgres 连接串，用于持久化聊天记录、时间线、长期记忆和模型用量。未配置时会回退到进程内存，重启后数据会丢失。
- `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`：可选的 Supabase 存储入口。两者同时配置时会使用 Supabase 记忆仓库；否则使用 `DATABASE_URL` 对应的 Postgres。

Docker Compose 会给 Web 容器注入内部 Postgres 的 `DATABASE_URL`，所以生产 Docker 部署不需要额外暴露数据库。

### 记忆检索增强

- `SILICONFLOW_API_KEY`：可选。用于调用 SiliconFlow rerank 模型，对候选记忆重新排序，提高长对话中记忆命中质量。未配置时会使用本地稳定排序兜底。
- `SILICONFLOW_BASE_URL`：SiliconFlow API 地址，默认是 `https://api.siliconflow.cn/v1`。
- `SILICONFLOW_RERANK_MODEL`：rerank 使用的模型名，默认是 `Qwen/Qwen3-Reranker-0.6B`。

## 文档

- [开发流程](docs/development-plan.md)
- [当前状态](docs/current-status.md)
- [部署配置](docs/deployment.md)
- [数据库 schema](db/schema.sql)

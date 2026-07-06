# AI Treehole Chat

一个面向日常聊天、倾诉和长期陪伴的单用户 AI 树洞应用。

项目默认按“私人树洞”使用：用户通过一个访问口令进入，同一实例保存同一份对话、长期记忆和使用记录，适合个人在多台设备上访问同一个私有 AI 陪伴空间。

## 当前能力

- 树洞式聊天界面，第一屏直接进入对话，不做营销落地页。
- 支持 PWA，可在 iOS Safari 和 Android Chrome 中添加到主屏幕，以独立 App 方式打开。
- 输入框支持 `Enter` 发送、`Shift + Enter` 换行，并避免中文输入法组合输入时误发送。
- 用户侧只暴露“自动 / 轻声 / 均衡 / 深谈”模式，不直接暴露具体模型名。
- 内部按场景自动路由 DeepSeek V4 Flash / Pro。
- 聊天调用默认启用 DeepSeek thinking；思维链不会返回给用户，用户侧只显示“思考中（xx秒）”。
- 每轮对话都会获得当前 UTC+8 时间、星期和公开节假日上下文。
- 可选接入 Tavily 或 Brave Search；是否联网由一次轻量 LLM JSON 判定决定，不使用关键词规则触发。
- 联网判定和联网搜索会在用户等待时显示轻量状态；搜索失败时会降级为“不确定/结果不足”，不影响继续聊天。
- 支持流式回复，并避免回复完成后对话气泡重复刷新。
- 支持主动关怀：用户全局最近消息超过 8 小时后重新打开聊天，AI 可结合近期记忆和现实时间静默生成一条简短问候；服务端按用户全局消息防抖，避免多设备或切换时间线重复触发。
- 支持多条时间线、时间线标题自动生成、上下文清空和单条时间线删除。
- 长期记忆支持偏好、边界、情绪、事实、事件、安全等类型。
- 记忆可查看、确认、编辑、删除、清空，也可临时关闭记忆写入。
- 支持导入其他聊天助手的对话文本或文件，分析后由用户选择要添加的长期记忆。
- 记忆写入和每轮用户对话都会携带 UTC+8 时间戳进入上下文，方便 AI 理解时间顺序。
- 记忆模块会在后台合并相似/重复记忆；用户侧不展示重复处理细节。
- 助手回复下方可折叠查看“本轮参考的记忆”，帮助用户理解回答使用了哪些长期记忆。
- 支持定期记忆维护，也支持用户在记忆面板中手动触发维护。
- 支持记忆列表和可视化记忆图谱；图谱按类型聚合并做节点避让，减少重叠。
- SiliconFlow rerank 可选增强记忆检索；未配置时使用本地排序兜底。
- 支持时光信箱：系统每 7 天在后台读取近期情绪/事件记忆，生成一封不超过 500 字的总结信；左上角叶子 Logo 是信箱入口，未读信件会显示红点。
- Postgres 持久化聊天、时间线、长期记忆、记忆设置、时光信件和模型用量。
- 未配置数据库时回退到进程内存存储，便于本地开发，但重启后数据会丢失。
- 支持一键导出聊天、记忆、时光信件、用量等数据。
- 用量面板展示最近的模型、联网搜索、节假日查询和记忆抽取结果事件，方便观察延迟和失败情况。

## 本地开发

```powershell
npm install
npm run dev
```

访问：

```text
http://localhost:3000
```

常用检查：

```powershell
npm run lint
npm run build
```

## Docker 运行

```powershell
docker compose up -d --build
```

默认会启动：

- `ai-treehole-chat`：Next.js Web/API，公网端口 `3010`。
- `ai-treehole-chat-db`：Postgres，仅 Docker 内网访问。
- `treehole-postgres`：Postgres 数据卷，保存聊天和记忆数据。

访问：

```text
http://localhost:3010
```

## 首次部署

首次部署如果没有同时配置 `TREEHOLE_ACCESS_TOKEN` 和 `DEEPSEEK_API_KEY`，访问首页会进入 `/setup` 引导页。

按步骤填写：

- 进入树洞的访问口令。
- DeepSeek API Key。
- 可选的 DeepSeek Base URL。
- 可选的 SiliconFlow rerank 配置。

完成初始化后，配置会保存到 Postgres，并跳转到登录页。之后 `/setup` 不再显示。

环境变量仍然拥有最高优先级。如果 `.env.production` 已经配置好关键字段，应用会直接跳过引导页。

## 环境变量

本地开发可创建 `.env.local`，生产部署可创建 `.env.production`：

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
TAVILY_API_KEY=
BRAVE_SEARCH_API_KEY=
REALITY_COUNTRY_CODE=CN
```

### 必填建议

- `DEEPSEEK_API_KEY`：主聊天、模型路由、记忆抽取、标题生成等能力使用的 DeepSeek API Key。未配置时会使用本地 mock 回复，只适合开发 UI。
- `TREEHOLE_ACCESS_TOKEN`：单用户访问口令。配置后访问 `/login` 需要输入该口令；不配置时会关闭登录保护，只适合本地开发。
- `TREEHOLE_SESSION_SECRET`：签名登录 cookie 的密钥。生产环境建议使用独立随机字符串。

### DeepSeek

- `DEEPSEEK_BASE_URL`：DeepSeek OpenAI-compatible API 地址，默认是 `https://api.deepseek.com`。
- 聊天请求会启用 `thinking: { type: "enabled" }`。
- thinking 只用于主聊天 `operation=chat`；记忆抽取和标题生成使用 JSON/普通调用，不向用户展示思维链。

### 登录与单用户

- `DEFAULT_USER_ID`：单用户实例的内部用户 ID，用来隔离聊天、记忆和用量数据。单用户部署保持默认 `single-user` 即可。
- `TREEHOLE_COOKIE_SECURE`：控制登录 cookie 是否只允许 HTTPS 发送。线上有 HTTPS 反代时建议设为 `true`；直连 HTTP 或本地调试设为 `false`。

### 存储

- `DATABASE_URL`：Postgres 连接串，用于持久化聊天记录、时间线、长期记忆、记忆设置和模型用量。
- `DATABASE_URL` 同时用于持久化时光信箱信件。
- `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`：可选 Supabase 存储入口。两者同时配置时使用 Supabase 记忆仓库，否则使用 `DATABASE_URL` 对应的 Postgres。

Docker Compose 会给 Web 容器注入内部 Postgres 的 `DATABASE_URL`，生产 Docker 部署通常不需要额外暴露数据库。

### 记忆检索增强

- `SILICONFLOW_API_KEY`：可选。用于调用 SiliconFlow rerank 模型，对候选记忆重排，提高长对话中的记忆命中质量。
- `SILICONFLOW_BASE_URL`：SiliconFlow API 地址，默认是 `https://api.siliconflow.cn/v1`。
- `SILICONFLOW_RERANK_MODEL`：rerank 模型名，默认是 `Qwen/Qwen3-Reranker-0.6B`。

### 现实感知

- `REALITY_COUNTRY_CODE`：节假日查询使用的国家/地区代码，默认 `CN`。
- `TAVILY_API_KEY`：可选。配置后，LLM 判定用户需要现实世界最新信息时，会调用 Tavily 搜索并把结果加入模型上下文。
- `BRAVE_SEARCH_API_KEY`：可选。未配置 Tavily 但配置 Brave 时，使用 Brave Search 作为联网检索来源。

现实上下文会默认包含当前 UTC+8 时间、星期、今日节假日和近期节假日。联网搜索只由 LLM 判定是否需要；节假日数据用于公共节假日感知，不保证覆盖补班/调休工作日。

## 主动关怀与时光信箱

主动关怀和时光信箱都是静默陪伴功能，不会阻塞正常聊天。

- 主动关怀：当前端加载聊天界面时，如果用户全局最近消息已经超过 8 小时，后端会读取现实时间、近期记忆和最近聊天结尾，流式生成一条简短问候并写入当前时间线。
- 多设备防抖：后端以数据库中的用户全局最近消息为准，不依赖单一设备的 localStorage；8 小时内已有消息或主动问候时不会再次触发。
- 时光信箱：系统每 7 天最多生成一封信。生成条件是近期 `affect` / `episodic` 记忆数量不少于 3 条。
- 信箱入口：左上角叶子 Logo 可打开左侧抽屉；未读信件会在叶子右上角显示红点。点击信件后会标记为已读。

## 记忆模块

长期记忆会进入 AI 上下文，用于让树洞理解用户长期偏好、关系背景、重要事件和安全边界。

记忆来源包括：

- 当前聊天自动抽取。
- 外部聊天助手对话导入分析。
- 用户手动编辑后的记忆。

记忆处理逻辑：

- 新记忆写入时会和已有记忆做相似度合并。
- 用户编辑记忆时，如果与其他记忆重复，也会合并到更合适的记录。
- 定期维护会清理重复、合并相近内容并重新排序。
- 维护任务不会阻塞聊天和导入流程。
- 每条记忆保留创建时间、最近使用时间、有效时间等字段；缺失有效时间时按当前 UTC+8 时间补齐。

## 生产部署

服务器进入项目目录后执行：

```bash
cd /opt/ai-treehole-chat
docker compose up -d --build
```

查看状态：

```bash
docker compose ps
docker logs --tail 80 ai-treehole-chat
```

健康检查：

```bash
curl -I http://127.0.0.1:3010/
```

如果启用了访问口令，首页未登录时返回 `307 /login?next=%2F` 属于正常行为。

## 数据备份

备份 Postgres：

```bash
docker exec ai-treehole-chat-db pg_dump -U treehole treehole > treehole-backup.sql
```

恢复 Postgres：

```bash
cat treehole-backup.sql | docker exec -i ai-treehole-chat-db psql -U treehole treehole
```

重建 Web 镜像不会丢失数据；只有删除 Postgres volume 才会清空聊天和记忆。

## 文档

- [开发流程](docs/development-plan.md)
- [当前状态](docs/current-status.md)
- [部署配置](docs/deployment.md)
- [数据库 schema](db/schema.sql)

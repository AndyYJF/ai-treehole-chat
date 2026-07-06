# 部署配置

## 当前生产形态

当前按单用户私有实例部署：

- 一个 Next.js Web/API 容器。
- 一个仅 Docker 内网可访问的 Postgres 容器。
- 一个 Docker volume 保存长期记忆。
- 多设备通过同一个 URL 访问同一份记忆，不需要账号系统。

默认公网入口：

```text
http://<server-ip>:3010
```

## 服务器部署

```bash
cd /opt/ai-treehole-chat
docker compose up -d --build
```

查看状态：

```bash
docker ps --filter name=ai-treehole-chat
docker logs --tail 80 ai-treehole-chat
```

健康检查：

```bash
curl -i http://127.0.0.1:3010
curl -s http://127.0.0.1:3010/api/memories
curl -s -X POST http://127.0.0.1:3010/api/chat \
  -H 'Content-Type: application/json' \
  --data '{"message":"我今天有点焦虑，希望你先听我说","tier":"auto","memoryEnabled":true,"temperature":0.7,"recentMessages":[]}'
```

## 环境变量

`.env.production` 放在服务器 `/opt/ai-treehole-chat/.env.production`：

```text
DEEPSEEK_API_KEY=
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEFAULT_USER_ID=single-user
TREEHOLE_ACCESS_TOKEN=
TREEHOLE_SESSION_SECRET=
TREEHOLE_COOKIE_SECURE=false
SILICONFLOW_API_KEY=
SILICONFLOW_BASE_URL=https://api.siliconflow.cn/v1
SILICONFLOW_RERANK_MODEL=Qwen/Qwen3-Reranker-0.6B
TAVILY_API_KEY=
BRAVE_SEARCH_API_KEY=
REALITY_COUNTRY_CODE=CN
```

`DATABASE_URL` 由 `docker-compose.yml` 注入到 Web 容器，指向内部 Postgres：

```text
postgresql://treehole:treehole-local-change-me@db:5432/treehole
```

数据库没有映射宿主机端口，不直接暴露到公网。

`TREEHOLE_ACCESS_TOKEN` 配置后会启用单用户访问门禁。登录成功后服务端写入 httpOnly cookie；不配置时本地开发保持开放。

`REALITY_COUNTRY_CODE` 默认 `CN`，用于查询公开节假日。`TAVILY_API_KEY` 和 `BRAVE_SEARCH_API_KEY` 是可选联网搜索增强；是否搜索由一次轻量 LLM JSON 判定决定。不配置搜索 Key 时，聊天仍会获得当前时间和节假日上下文，但不会假装已经联网检索。

联网判定、联网搜索、节假日查询和记忆抽取结果会写入 `model_usage_events`，设置面板的用量区域会显示最近事件。搜索失败只会降级为“结果不足/不确定”，不会阻塞主聊天。

当前直连 IP 使用 HTTP，因此 `TREEHOLE_COOKIE_SECURE=false`。绑定 HTTPS 域名后应改为 `true`。

## 数据持久化

长期记忆和记忆开关保存在 Docker volume：

```text
treehole-postgres
```

重建 Web 镜像不会丢失记忆。只有删除该 volume 才会清空数据。

备份：

```bash
docker exec ai-treehole-chat-db pg_dump -U treehole treehole > treehole-backup.sql
```

恢复：

```bash
cat treehole-backup.sql | docker exec -i ai-treehole-chat-db psql -U treehole treehole
```

## 后续可选

- 绑定域名并用 Caddy/HTTPS 反代到 `127.0.0.1:3010`。
- 如果以后需要多用户，再接 Supabase Auth / RLS。
- 如果以后需要离线移动端，再接 Expo + PowerSync。

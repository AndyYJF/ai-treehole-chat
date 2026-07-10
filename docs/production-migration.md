# 生产迁移与回滚

本版本对已有数据库只做可重复的新增迁移：聊天幂等 turn、消息上下文、记忆版本号以及多端同步变化日志。它不会删除或重写历史聊天、记忆、信件和用量数据。

发布前务必在服务器执行一次逻辑备份，并确认转储文件非空：

```bash
ts=$(date +%Y%m%d%H%M%S)
mkdir -p /opt/ai-treehole-chat/.deploy-backups
docker compose exec -T db pg_dump -U treehole -Fc treehole \
  > /opt/ai-treehole-chat/.deploy-backups/treehole-predeploy-$ts.dump
test -s /opt/ai-treehole-chat/.deploy-backups/treehole-predeploy-$ts.dump
```

在替换 Web 容器前执行迁移。脚本是幂等的，重复执行安全：

```bash
docker compose exec -T db psql -v ON_ERROR_STOP=1 -U treehole -d treehole \
  < db/migrations/20260710_01_reliable_sync.sql
```

生产环境应设置独立的 `TREEHOLE_CONFIG_ENCRYPTION_KEY`（至少 32 个随机字符）。应用会优先使用它对数据库中的 API Key 加密；若未设置则回退使用 `TREEHOLE_SESSION_SECRET`。旧版明文配置保持可读，并会在下一次保存相关设置时自动转为加密格式。

回滚 Web 版本时保留 Postgres volume 即可。只有确认要回滚数据库结构时才使用备份恢复，例如：

```bash
docker compose exec -T db dropdb -U treehole treehole
docker compose exec -T db createdb -U treehole treehole
docker compose exec -T db pg_restore -U treehole -d treehole --clean --if-exists \
  < /opt/ai-treehole-chat/.deploy-backups/treehole-predeploy-YYYYMMDDHHMMSS.dump
```

不要把备份文件、`.env.production` 或任何 Key 提交到 Git。

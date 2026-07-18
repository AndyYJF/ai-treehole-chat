# Privacy and Data Controls

当前版本按单用户私有实例设计，不提供公开注册和多账号体系。

## Access Gate

- `TREEHOLE_ACCESS_TOKEN` 启用访问口令。
- 登录成功后服务端写入 `treehole_session` httpOnly cookie。
- 未登录页面会跳转 `/login`。
- 未登录 API 请求返回 `401`。
- 当前 HTTP 直连部署使用 `TREEHOLE_COOKIE_SECURE=false`；绑定 HTTPS 后应改为 `true`。

## Data Ownership

用户可以在界面里完成这些操作：

- 导出全部数据：设置面板里的下载按钮。
- 暂停或恢复记忆：设置面板里的记忆开关。
- 记忆写入后默认生效；用户可随时编辑或删除单条记忆。
- 删除单条记忆：记忆面板里的删除按钮。
- 清空全部记忆：记忆面板顶部的删除按钮。
- 新建或切换聊天时间线：主界面左上角的时间线按钮。
- 清空当前聊天上下文：时间线面板里的清空当前上下文按钮。
- 清空全部数据：设置面板的数据区域会同时清空聊天、记忆、用量记录，并重置本地界面偏好。
- 退出当前会话：设置面板里的退出按钮。

## API

- `GET /api/export`
  - 返回 `exportedAt`、`userId`、`threads`、`memories`、`memorySettings`、`modelUsage`。
  - 每条 `threads` 记录包含该时间线的元数据和消息列表。
  - `modelUsage` 只包含模型、调用类型、成功状态、延迟、token 和缓存命中统计，不包含原始聊天正文。
  - 受访问门禁保护。

- `GET /api/usage`
  - 返回模型调用汇总和最近调用事件。
  - 可用于观察 token 消耗、缓存命中率、失败率和延迟。
  - 受访问门禁保护。

- `DELETE /api/usage`
  - 清空当前单用户的模型用量记录。
  - 不影响聊天记录、长期记忆和模型服务商侧的账单记录。

- `GET /api/threads`
  - 返回当前时间线、时间线列表和当前时间线消息。
  - 可用 `threadId` 查询参数切换当前时间线。
- `POST /api/threads`
  - 创建一条新的空时间线。
- `DELETE /api/messages`
  - 清空当前单用户指定时间线的聊天上下文。
  - 可用 `threadId` 查询参数指定时间线。
  - 不删除长期记忆，也不删除其他时间线。

- `DELETE /api/memories`
  - 清空当前单用户长期记忆。
  - 不删除聊天记录和记忆开关设置。
- `DELETE /api/data`
  - 清空当前单用户的聊天记录、长期记忆和模型用量记录。
  - 将记忆开关恢复为开启。
  - 不删除服务器环境变量、访问口令、模型服务商侧账单记录或 Docker volume 本身。

## Current Privacy Boundary

- Postgres 只在 Docker 内网暴露，不映射公网端口。
- 模型调用仍会把必要上下文发送给模型服务商。
- 模型用量记录会保存在服务端数据库中，用于成本和缓存命中分析。
- 尚未实现端到端加密、SQLCipher 本地离线库、域名 HTTPS、自动备份加密。

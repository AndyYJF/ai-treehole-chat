# AI Treehole Chat 开发文档

## 1. 产品定位

这是一个偏日常聊天、倾诉和长期陪伴的 AI chat 应用。核心体验不是“工具面板”，而是一个安静、少文字、可长期记住用户的树洞。

优先级：

1. 记忆准确、可追溯、可删除。
2. 默认自动选择合适模型，用户只看到“自动 / 轻声 / 均衡 / 深谈”等挡位。
3. 缓存命中友好，稳定 prompt 前缀尽量不抖动。
4. 多平台同步，MVP 先做 Web，随后接 Expo / React Native。
5. 不做端到端加密作为第一目标，但要保留本地加密和隐私模式接口。

## 2. 技术栈

MVP：

- Web: Next.js App Router + TypeScript + Tailwind CSS
- UI: 自研极简组件，图标使用 lucide-react
- API: Next.js Route Handlers
- Memory: LangGraph / LangMem 思路，先用本地接口抽象，后续换 LangGraph 编排和 LangMem store
- Model: DeepSeek V4 系列
- Schema validation: zod

产品化目标：

- App: Expo / React Native
- Sync: Supabase Postgres + PowerSync
- Local store: SQLite，隐私版接 SQLCipher
- Vector: pgvector 起步，规模变大后可迁移 Qdrant
- Deploy: Supabase managed + Fly.io / Render / Railway

## 3. 记忆路线

采用 LangGraph / LangMem 的长期记忆思路，把记忆拆成：

- Semantic memory: 用户稳定事实、偏好、边界
- Episodic memory: 有时间线的事件
- Procedural memory: AI 对这个用户的回应方式
- Affect memory: 情绪模式和支持偏好
- Safety memory: 用户显式表达的风险信号和禁区

每条记忆必须有：

- `content`
- `type`
- `confidence`
- `sourceMessageIds`
- `createdAt`
- `lastSeenAt`
- `validFrom`
- `validUntil`
- `sensitivity`
- `userConfirmed`

原则：

- 只把用户明确表达的内容写成事实。
- 推断内容只能作为低置信度候选，不能直接当长期记忆。
- 敏感记忆默认更高保护，用户可查看、删除、暂停记忆。
- 记忆更新要能覆盖旧事实，而不是无限堆叠矛盾信息。

## 4. 模型路由

用户默认看到挡位，不直接看到模型名：

- 自动：由决策逻辑选择
- 轻声：轻量陪伴、闲聊
- 均衡：默认日常对话
- 深谈：关系复盘、长文本、复杂困扰

内部模型建议：

- 主聊天轻量/均衡：`deepseek-v4-flash`
- 主聊天深谈：`deepseek-v4-pro`
- 决策模型：`deepseek-v4-flash`
- 记忆抽取/合并：`deepseek-v4-flash`，低温度，JSON schema
- Embedding: Qwen3-Embedding-4B/8B
- Reranker: Qwen3-Reranker 或 bge-reranker-v2-m3

## 5. 缓存命中策略

DeepSeek 的 Context Caching 依赖重复前缀。请求组装顺序固定：

1. 固定系统提示
2. 固定人格和安全边界
3. 稳定排序的用户核心记忆
4. 稳定排序的偏好和边界
5. 当前会话摘要
6. 最近聊天记录
7. 本轮用户输入

实现要求：

- 记忆按 `type -> importance -> updatedAt -> id` 稳定排序。
- prompt 不随机插入片段。
- UI 参数可见可改，但藏在次级设置里。
- 不把所有历史都塞进上下文，优先检索高质量记忆。

## 6. 数据同步和隐私

MVP：

- Web 端先使用内存 mock store 和 API 抽象。
- 数据库 schema 先落 SQL 文件。

正式版：

- Supabase Auth 负责身份。
- Postgres 开启 RLS，所有用户数据按 `user_id` 隔离。
- PowerSync 把用户自己的会话、消息、记忆同步到本地 SQLite。
- 本地隐私版使用 SQLCipher。
- 云端模型调用前给用户清晰告知：内容会发送给模型服务商。

## 7. 界面原则

- 第一屏就是聊天。
- 不放营销式介绍。
- 设置、记忆、模型挡位都放在右上或抽屉里。
- 保留必要文字，不解释功能。
- 颜色克制，避免强烈单色主题。
- 移动端优先，桌面端保持居中宽度和舒适行长。

## 8. 开发顺序

1. Web MVP: 聊天界面、模型挡位、API route、mock memory。
2. 记忆系统: 抽取、合并、检索、用户可见记忆列表。
3. Supabase schema: users、threads、messages、memories、memory_events。
4. 接入 DeepSeek: 流式响应、错误兜底、用量记录。
5. 接入 embedding/reranker: 记忆检索排序。
6. Expo App: 复用 shared types 和 UI 语义。
7. PowerSync: 多端同步和离线读写。
8. 隐私增强: SQLCipher、隐私模式、本地副模型选项。

## 9. 当前实现范围

本仓库第一阶段完成：

- Next.js Web MVP
- 极简聊天 UI
- 用户可选模型挡位
- 自动模型路由
- LangGraph 风格聊天流程编排
- LangGraph/LangMem 风格记忆类型和 prompt 组装
- 记忆列表、确认、删除、清空、暂停记忆
- 数据导出和退出会话
- 服务端持久化聊天时间线，多设备访问同一实例时同步
- 折叠高级参数，默认不暴露具体模型名称
- DeepSeek API 接口和流式响应，未配置 key 时返回本地 mock
- DeepSeek usage 记录：token、缓存命中/未命中、延迟、失败状态
- Supabase repository 适配层，未配置时回退进程内 store
- 副模型 JSON 记忆抽取，失败时回退规则抽取
- Postgres repository、Docker Compose 和部署文档

## 10. 下一阶段验收项

要达到完整产品化，还需要继续完成：

- 域名、HTTPS 和安全 cookie。
- pgvector / Qwen3-Embedding / Reranker 的真实检索链路。
- Expo / React Native 客户端。
- PowerSync 多端同步和离线读写。
- 用量趋势面板和模型路由评估。
- 安全边界和敏感内容分级测试。

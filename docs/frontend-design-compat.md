# frontend-design 与 Codex 兼容方案

## 查证结论

`frontend-design` 是 Anthropic Claude Code 仓库中的官方 frontend design plugin。公开源码显示它的核心是一份 `SKILL.md`，内容是前端视觉设计指导，而不是独立 MCP server 或可跨客户端直接调用的工具。

参考：

- https://github.com/anthropics/claude-code/tree/main/plugins/frontend-design
- https://github.com/anthropics/claude-code/blob/main/plugins/frontend-design/skills/frontend-design/SKILL.md
- https://github.com/anthropics/knowledge-work-plugins/issues/49

GitHub issue #49 明确提到：该 plugin 目前只存在于 `anthropics/claude-code` 仓库，并且只能通过 Claude Code CLI 安装；有人建议把它加入 Cowork marketplace 或统一 plugin 系统。

## 对 Codex 的可行兼容路径

当前本环境没有可直接调用的 `frontend-design` 插件。可行方案有三种：

1. **手动等效使用**
   - 读取官方 `SKILL.md` 的设计原则。
   - 在本项目文档中沉淀本产品专属设计准则。
   - 开发时按这些准则执行。
   - 这是当前已采用的方案。

2. **迁移为 Codex Skill**
   - 新建一个本地 Codex skill，例如 `frontend-design-adapted`。
   - 用自己的语言总结设计原则，避免直接复制原文和许可证风险。
   - 在后续 Codex 任务中通过 skill 触发。

3. **迁移为 Codex Plugin**
   - 如果需要分发给多个项目，可以用 Codex plugin 结构封装。
   - 这个方案更重，适合团队复用，不适合当前 MVP 阶段。

## 本项目采用的设计约束

针对“树洞聊天 + 长期记忆”的主题，界面不做 landing page，不做卡片堆叠，不用强营销感视觉。

视觉方向：

- 背景使用低亮度雾灰蓝，而不是通用暖米色。
- 主色来自“夜间纸面 / 墨绿 / 低饱和蓝”，避免单一紫蓝渐变。
- 签名元素是顶部很窄的“记忆状态条”：只显示当前回复挡位，不解释系统内部。
- 字体和间距偏安静、克制，聊天气泡边界清楚但不厚重。

交互方向：

- 第一屏就是聊天。
- 模型参数收进设置，不放显眼位置。
- 用户只看到挡位，不看到模型名。
- 记忆入口可见，但不抢注意力。
- 空状态和错误提示短句即可。


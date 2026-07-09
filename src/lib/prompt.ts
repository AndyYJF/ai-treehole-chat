import type { MemoryRecord } from "./memory/types";

const BASE_SYSTEM_PROMPT = `
你是一个树洞型 AI 朋友：安静、可靠、边界清晰。

定位：
- 你的任务是陪伴和倾听，不是心理治疗。
- 不诊断、不贴标签、不分析人格。
- 不主动给建议。用户明确要建议时，也只给轻量、可选的方向。

对话方式：
- 先接住用户的情绪和事实，让用户感到被听见。
- 再用一个开放问题，或给两三个轻量选项，帮用户继续说下去。
- 短句，自然，像朋友聊天。一次回复通常两三句就够。
- 当用户有疑问时可以解答，但是不要过度分析，综合下方给出的记忆进行回答。
- 不说教、不总结人生道理。
- 用户沉默或话少时，不追问，可以简单陪着。

安全：
- 用户表达明确的自伤、自杀或伤害他人的意图时，认真对待，不轻描淡写，也不惊慌说教。
- 继续以陪伴的姿态留在对话里，不中断、不冷落。
- 不提供任何可能促成自伤或伤人的具体信息。

记忆：
- 只使用系统提供的记忆内容，不虚构“我记得”。
- 记忆用来自然地延续关系，例如记得用户提过的人、事、在意的东西；不要刻意罗列或炫耀记忆。
- 记忆与用户当前所说冲突时，以用户现在说的为准。
- 不确定的内容明确说不确定，不把猜测当事实。

边界：
- 你是 AI，不假装是人类，但也不反复强调。
- 不评判用户的选择和生活方式。
`.trim();

const INTERNAL_METADATA_POLICY = [
  "Internal metadata policy:",
  "- Message timestamps, memory metadata, and reality-context timestamps are private context for reasoning only.",
  "- Never copy, quote, paraphrase, or re-emit any XML-like internal tags such as <internal_message_metadata ... /> or <internal_memory_metadata ... />.",
  "- Do not quote, expose, or mention raw timestamps, ISO strings, metadata labels, or internal markers to the user.",
  "- Use time metadata only to understand sequence and recency.",
  "- If the user explicitly asks about date/time, answer naturally without exposing internal marker syntax.",
].join("\n");

const INTERNAL_METADATA_TAG_RE =
  /<\/?internal_(?:message|memory)_metadata\b[^>]*\/?>/gi;

export function buildChatMessages(input: {
  memories: MemoryRecord[];
  relevantMemories?: MemoryRecord[];
  realityContext: string;
  threadSummary: string;
  recentMessages: Array<{ role: "user" | "assistant"; content: string; createdAt?: string }>;
  latestMessage: string;
  latestMessageCreatedAt?: string;
}) {
  const memoryBlock = formatMemoryBlock(input.memories);
  const latestMessageCreatedAt = input.latestMessageCreatedAt ?? new Date().toISOString();
  const summary = input.threadSummary || "暂无会话摘要。";

  return [
    {
      role: "system" as const,
      content: [
        BASE_SYSTEM_PROMPT,
        "",
        INTERNAL_METADATA_POLICY,
        "",
        "【长期记忆】",
        memoryBlock,
        "",
        "【当前会话摘要】",
        summary,
      ].join("\n"),
    },
    ...input.recentMessages.map((message) => ({
      role: message.role,
      content: withTimestamp(stripInternalMetadata(message.content) || message.content, message.createdAt),
    })),
    {
      role: "user" as const,
      content: [
        "【现实上下文】",
        input.realityContext,
        "",
        "【本轮相关记忆】",
        formatRelevantMemoryBlock(input.relevantMemories ?? []),
        "",
        withTimestamp(
          stripInternalMetadata(input.latestMessage) || input.latestMessage,
          latestMessageCreatedAt,
        ),
      ].join("\n"),
    },
  ];
}

function formatMemoryBlock(memories: MemoryRecord[]): string {
  if (memories.length === 0) return "暂无长期记忆。";

  return memories
    .slice(0, 12)
    .map((memory) => {
      const confirmed = memory.userConfirmed ? "confirmed" : "unconfirmed";
      return `- ${formatMemoryMetadata(memory, confirmed)} ${memory.content}`;
    })
    .join("\n");
}

function formatRelevantMemoryBlock(memories: MemoryRecord[]): string {
  if (memories.length === 0) return "暂无本轮相关记忆。";

  return memories
    .slice(0, 8)
    .map((memory) => {
      const confirmed = memory.userConfirmed ? "confirmed" : "unconfirmed";
      return `- ${formatMemoryMetadata(memory, confirmed)} ${memory.content}`;
    })
    .join("\n");
}

function formatMemoryMetadata(memory: MemoryRecord, confirmed: string): string {
  return [
    `<internal_memory_metadata`,
    `type="${escapeMetadataAttribute(memory.type)}"`,
    `confirmed="${escapeMetadataAttribute(confirmed)}"`,
    `importance="${memory.importance}"`,
    `created_utc8="${escapeMetadataAttribute(formatContextTime(memory.createdAt))}"`,
    `visibility="private_do_not_mention"`,
    `/>`,
  ].join(" ");
}

export function stripInternalMetadata(content: string): string {
  return content
    .replace(INTERNAL_METADATA_TAG_RE, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function withTimestamp(content: string, createdAt: string | undefined): string {
  const timestamp = createdAt ? formatContextTime(createdAt) : "unknown";
  return `<internal_message_metadata time_utc8="${escapeMetadataAttribute(timestamp)}" visibility="private_do_not_mention" />\n${content}`;
}

function escapeMetadataAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function formatContextTime(value: string | null | undefined): string {
  if (!value) return "unknown";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return toUtc8IsoString(date);
}

function toUtc8IsoString(date: Date): string {
  const utc8Time = date.getTime() + 8 * 60 * 60 * 1000;
  const shifted = new Date(utc8Time);
  return `${shifted.toISOString().slice(0, 19)}+08:00`;
}


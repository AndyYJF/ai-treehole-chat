import type { MemoryRecord } from "./memory/types";

const BASE_SYSTEM_PROMPT = `
你是一个温暖、安静、可靠的树洞型 AI 朋友。

【你的核心定位】
- 你的任务是陪伴、倾听与共情，而不是居高临下的心理治疗。
- 不对用户进行诊断、不贴标签、不擅自剖析人格。
- 绝不说教，不主动给建议。只有当用户明确渴求建议时，才提供轻量、可选的思路。

【对话风格与方式】
- 永远先接住用户的情绪和事实，给予无条件的接纳，让用户感到“被看见、被理解”。
- 语言简练自然，像相识已久的老朋友在深夜聊天。一次回复通常两三句即可，留白给用户。
- 适当用一个温和的开放问题，或两三个轻量选项，帮助用户整理思绪并继续表达。
- 用户沉默、退缩或话少时，不要咄咄逼人地追问，可以只用一句话简单地陪着。
- 不讲大道理，不总结人生经验，不轻易评判用户的任何生活方式和选择。

【如何使用长期记忆】
- 下方提供的“长期记忆”是你与TA共度的过往。将其视作你对TA的深入了解，在对话中自然、温情地流露，不要像机器一样刻板罗列。
- 只使用提供的记忆内容，绝不虚构“我记得”。
- 当用户的当下表达与历史记忆冲突时，永远以TA此刻的感受为准。
- 保持边界感，你是 AI，不必假装人类，但请用最具人类温度的语言进行安抚。

【生命安全与危机干预】
- 当用户流露出明确的自伤、自杀或伤害他人的意图时，必须立刻严肃对待：绝不轻描淡写，但也绝不大惊小怪或急躁说教。
- 你必须继续以最坚定的姿态留在对话里：“我在，我会陪着你。” 绝不冷落或生硬中断对话。
- 绝不提供任何可能促成自伤、伤人的具体信息或手段。
- 在安抚住情绪的同时，极为温和地引导TA寻求现实中专业力量的支撑，你可以自然地附上24小时心理危机干预热线（如希望24热线：400-161-9995），告诉TA“有很多专业的人愿意接住你”。
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


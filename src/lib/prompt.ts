import type { MemoryRecord } from "./memory/types";

const BASE_SYSTEM_PROMPT = `
你是一个安静、可靠、边界清晰的树洞型 AI 朋友。
目标：陪用户把话说完，先理解感受，再提供轻量选择。
风格：简短、自然、不过度解释、不诊断、不居高临下。
安全：遇到明确自伤/伤人风险时，温和建议联系现实中的可信任的人或当地紧急服务。
记忆：只能使用提供的记忆，不要把猜测当成事实。
`.trim();

export function buildChatMessages(input: {
  memories: MemoryRecord[];
  threadSummary: string;
  recentMessages: Array<{ role: "user" | "assistant"; content: string }>;
  latestMessage: string;
}) {
  const memoryBlock = formatMemoryBlock(input.memories);
  const summary = input.threadSummary || "暂无会话摘要。";

  return [
    {
      role: "system" as const,
      content: [
        BASE_SYSTEM_PROMPT,
        "",
        "【长期记忆】",
        memoryBlock,
        "",
        "【当前会话摘要】",
        summary,
      ].join("\n"),
    },
    ...input.recentMessages,
    {
      role: "user" as const,
      content: input.latestMessage,
    },
  ];
}

function formatMemoryBlock(memories: MemoryRecord[]): string {
  if (memories.length === 0) return "暂无长期记忆。";

  return memories
    .slice(0, 12)
    .map((memory) => {
      const confirmed = memory.userConfirmed ? "confirmed" : "unconfirmed";
      return `- [${memory.type}/${confirmed}/importance:${memory.importance}] ${memory.content}`;
    })
    .join("\n");
}


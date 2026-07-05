import { callDeepSeekJson } from "./deepseek";

const fallbackTitle = "新对话";

export async function summarizeThreadTitle(input: {
  userId: string;
  userMessage: string;
  assistantReply: string;
}) {
  const fallback = titleFromText(input.userMessage);

  try {
    const data = await callDeepSeekJson({
      userId: input.userId,
      operation: "title_summarize",
      model: "deepseek-v4-flash",
      temperature: 0.1,
      messages: [
        {
          role: "system",
          content:
            "你只负责给私人树洞对话生成时间线标题。标题要温和、克制、具体，避免诊断和夸张。输出 JSON：{\"title\":\"...\"}。title 必须是中文，2 到 12 个字，不要标点，不要引号。",
        },
        {
          role: "user",
          content: `用户第一条消息：\n${input.userMessage}\n\n助手第一轮回复：\n${input.assistantReply.slice(
            0,
            800,
          )}`,
        },
      ],
    });

    const title = extractTitle(data);
    if (title) return title;
  } catch {
    // Title generation should never block saving the conversation.
  }

  return fallback;
}

export function normalizeThreadTitle(title: string) {
  const normalized = title.replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, 32) : fallbackTitle;
}

export function titleFromText(text: string) {
  const cleaned = text
    .replace(/https?:\/\/\S+/g, "")
    .replace(/["'“”‘’`*_~#>[\](){}<>]/g, "")
    .replace(/[，。！？、；：,.!?;:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!cleaned) return fallbackTitle;

  return normalizeThreadTitle(cleaned).slice(0, 12);
}

function extractTitle(data: unknown) {
  if (!data || typeof data !== "object") return "";
  const title = (data as { title?: unknown }).title;
  if (typeof title !== "string") return "";

  const normalized = normalizeThreadTitle(title.replace(/[，。！？、；：,.!?;:]/g, ""));
  return normalized === fallbackTitle ? "" : normalized.slice(0, 12);
}

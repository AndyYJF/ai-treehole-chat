import { z } from "zod";
import { callDeepSeekJson } from "../deepseek";
import type { MemoryCandidate } from "./types";

const memoryCandidateJsonSchema = z.object({
  memories: z.array(
    z.object({
      type: z.enum(["semantic", "episodic", "procedural", "affect", "safety", "preference", "boundary"]),
      content: z.string().min(4).max(140),
      confidence: z.number().min(0).max(1),
      importance: z.number().int().min(0).max(100),
      sensitivity: z.enum(["normal", "sensitive", "private"]),
      validFrom: z.string().nullable(),
      validUntil: z.string().nullable(),
    }),
  ),
});

const preferencePatterns = ["我喜欢", "我不喜欢", "我希望", "我更希望", "别", "不要"];
const affectPatterns = ["难过", "焦虑", "烦", "累", "崩溃", "开心", "失落", "害怕"];
const safetyPatterns = ["不想活", "自杀", "伤害自己", "伤害别人", "死了算了"];

export async function extractMemoryCandidates(input: {
  userId: string;
  messageId: string;
  userMessage: string;
}): Promise<MemoryCandidate[]> {
  const modelCandidates = await extractWithModel(input);
  if (modelCandidates.length > 0) return modelCandidates;

  return extractWithRules(input);
}

export function extractMemoryCandidatesWithRules(input: {
  messageId: string;
  userMessage: string;
}): MemoryCandidate[] {
  return extractWithRules(input);
}

async function extractWithModel(input: {
  userId: string;
  messageId: string;
  userMessage: string;
}): Promise<MemoryCandidate[]> {
  const today = new Date().toISOString();
  const json = await callDeepSeekJson({
    userId: input.userId,
    operation: "memory_extract",
    model: "deepseek-v4-flash",
    temperature: 0.05,
    messages: [
      {
        role: "system",
        content: [
          "你是长期陪伴聊天应用的记忆抽取器。",
          "只抽取用户明确表达的长期偏好、边界、事实、事件、情绪模式和安全风险。",
          "不要把猜测、诊断、模型建议写入记忆。",
          "输出严格 JSON，不要解释。",
          "schema: {\"memories\":[{\"type\":\"semantic|episodic|procedural|affect|safety|preference|boundary\",\"content\":\"string\",\"confidence\":0-1,\"importance\":0-100,\"sensitivity\":\"normal|sensitive|private\",\"validFrom\":\"ISO string or null\",\"validUntil\":\"ISO string or null\"}]}",
        ].join("\n"),
      },
      {
        role: "user",
        content: `当前时间：${today}\n用户消息：${input.userMessage}`,
      },
    ],
  });

  const parsed = memoryCandidateJsonSchema.safeParse(json);
  if (!parsed.success) return [];

  return parsed.data.memories.slice(0, 4).map((candidate) => ({
    ...candidate,
    validFrom: candidate.validFrom ?? today,
    sourceMessageIds: [input.messageId],
  }));
}

function extractWithRules(input: {
  messageId: string;
  userMessage: string;
}): MemoryCandidate[] {
  const text = input.userMessage.trim();
  const candidates: MemoryCandidate[] = [];

  if (text.length < 8) return candidates;

  if (safetyPatterns.some((pattern) => text.includes(pattern))) {
    candidates.push({
      type: "safety",
      content: toShortMemory(text),
      confidence: 0.65,
      importance: 92,
      sensitivity: "private",
      sourceMessageIds: [input.messageId],
      validFrom: new Date().toISOString(),
      validUntil: null,
    });
  }

  if (preferencePatterns.some((pattern) => text.includes(pattern))) {
    candidates.push({
      type: text.includes("不要") || text.includes("别") ? "boundary" : "preference",
      content: toShortMemory(text),
      confidence: 0.58,
      importance: 62,
      sensitivity: "normal",
      sourceMessageIds: [input.messageId],
      validFrom: new Date().toISOString(),
      validUntil: null,
    });
  }

  if (affectPatterns.some((pattern) => text.includes(pattern))) {
    candidates.push({
      type: "affect",
      content: toShortMemory(text),
      confidence: 0.5,
      importance: 56,
      sensitivity: "sensitive",
      sourceMessageIds: [input.messageId],
      validFrom: new Date().toISOString(),
      validUntil: null,
    });
  }

  return candidates.slice(0, 3);
}

function toShortMemory(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= 72) return compact;
  return `${compact.slice(0, 70)}...`;
}

import { z } from "zod";
import { callDeepSeekJson } from "../deepseek";
import { extractMemoryCandidatesWithRules } from "./extract";
import { memoryTypeSchema, sensitivitySchema, type MemoryCandidate } from "./types";

const maxImportChars = 60000;

const importedMemoryJsonSchema = z.object({
  memories: z.array(
    z.object({
      type: memoryTypeSchema,
      content: z.string().min(4).max(140),
      confidence: z.number().min(0).max(1),
      importance: z.number().int().min(0).max(100),
      sensitivity: sensitivitySchema,
      validFrom: z.string().nullable(),
      validUntil: z.string().nullable(),
      evidence: z.string().max(180).optional(),
    }),
  ),
});

export type ImportAnalysisResult = {
  sourceName: string;
  messageCount: number;
  analyzedChars: number;
  truncated: boolean;
  candidates: MemoryCandidate[];
};

type ConversationLine = {
  role: string;
  content: string;
};

export async function analyzeImportedConversation(input: {
  userId: string;
  sourceName?: string;
  content: string;
}): Promise<ImportAnalysisResult> {
  const sourceName = input.sourceName?.trim() || "外部对话";
  const normalized = normalizeImportedConversation(input.content);
  const sourceText = normalized.text.slice(0, maxImportChars);
  const truncated = normalized.text.length > maxImportChars;
  const messageId = `import-${Date.now()}`;
  const modelCandidates = await extractImportedMemoriesWithModel({
    userId: input.userId,
    messageId,
    sourceName,
    sourceText,
  });
  const candidates =
    modelCandidates.length > 0
      ? modelCandidates
      : extractMemoryCandidatesWithRules({
          messageId,
          userMessage: sourceText,
        });

  return {
    sourceName,
    messageCount: normalized.messageCount,
    analyzedChars: sourceText.length,
    truncated,
    candidates: dedupeCandidates(candidates).slice(0, 16),
  };
}

async function extractImportedMemoriesWithModel(input: {
  userId: string;
  messageId: string;
  sourceName: string;
  sourceText: string;
}): Promise<MemoryCandidate[]> {
  const today = toUtc8IsoString(new Date());
  const json = await callDeepSeekJson({
    userId: input.userId,
    operation: "memory_extract",
    model: "deepseek-v4-flash",
    temperature: 0.05,
    messages: [
      {
        role: "system",
        content: [
          "你是长期陪伴聊天应用的外部对话记忆分析器。",
          "任务：从用户导入的其他聊天助手对话中，抽取关于“用户本人”的长期记忆候选。",
          "只根据用户在对话中明确表达的内容抽取：长期偏好、边界、事实、重要经历、稳定情绪模式、安全风险。",
          "忽略其他助手的建议、判断、安慰和推测；不要把助手说过的话当成用户事实。",
          "不要诊断用户，不要抽取短期寒暄、一次性情绪和不确定猜测。",
          "每条 content 写成自然中文，主语可以是“用户”，长度不超过 140 字。",
          "输出严格 JSON，不要解释。",
          "schema: {\"memories\":[{\"type\":\"semantic|episodic|procedural|affect|safety|preference|boundary\",\"content\":\"string\",\"confidence\":0-1,\"importance\":0-100,\"sensitivity\":\"normal|sensitive|private\",\"validFrom\":\"ISO string or null\",\"validUntil\":\"ISO string or null\",\"evidence\":\"short quote\"}]}",
        ].join("\n"),
      },
      {
        role: "user",
        content: [
          `当前时间：${today}`,
          `导入来源：${input.sourceName}`,
          "外部对话如下：",
          input.sourceText,
        ].join("\n"),
      },
    ],
  });

  const parsed = importedMemoryJsonSchema.safeParse(json);
  if (!parsed.success) return [];

  return parsed.data.memories.map((candidate, index) => ({
    type: candidate.type,
    content: candidate.content,
    confidence: candidate.confidence,
    importance: candidate.importance,
    sensitivity: candidate.sensitivity,
    validFrom: candidate.validFrom ?? today,
    validUntil: candidate.validUntil,
    sourceMessageIds: [`${input.messageId}-${index}`],
  }));
}

function normalizeImportedConversation(content: string): {
  text: string;
  messageCount: number;
} {
  const raw = content.trim();
  if (!raw) return { text: "", messageCount: 0 };

  const parsed = parseJson(raw);
  if (parsed == null) {
    return {
      text: compactText(raw),
      messageCount: countPlainTextMessages(raw),
    };
  }

  const lines = collectConversationLines(parsed);
  if (lines.length === 0) {
    return {
      text: compactText(JSON.stringify(parsed, null, 2)),
      messageCount: 0,
    };
  }

  return {
    text: lines.map((line) => `${line.role}: ${compactText(line.content)}`).join("\n"),
    messageCount: lines.length,
  };
}

function parseJson(content: string): unknown | null {
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

function collectConversationLines(value: unknown): ConversationLine[] {
  const lines: ConversationLine[] = [];
  const seen = new Set<unknown>();

  function visit(node: unknown) {
    if (node == null || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);

    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }

    const record = node as Record<string, unknown>;
    const message = typeof record.message === "object" && record.message ? (record.message as Record<string, unknown>) : null;
    const role = readRole(record) ?? (message ? readRole(message) : null);
    const content = readContent(record) ?? (message ? readContent(message) : null);

    if (role && content) {
      lines.push({
        role,
        content,
      });
      return;
    }

    for (const child of Object.values(record)) {
      visit(child);
    }
  }

  visit(value);
  return lines.filter((line) => line.content.trim().length > 0).slice(0, 500);
}

function readRole(record: Record<string, unknown>): string | null {
  const direct = record.role ?? record.from ?? record.speaker;
  if (typeof direct === "string" && direct.trim()) return normalizeRole(direct);

  const author = record.author;
  if (author && typeof author === "object") {
    const role = (author as Record<string, unknown>).role;
    if (typeof role === "string" && role.trim()) return normalizeRole(role);
  }

  return null;
}

function readContent(record: Record<string, unknown>): string | null {
  for (const key of ["content", "text", "message"]) {
    const value = record[key];
    const content = stringifyMessageContent(value);
    if (content) return content;
  }

  return null;
}

function stringifyMessageContent(value: unknown): string | null {
  if (typeof value === "string") return value;

  if (Array.isArray(value)) {
    const parts = value.map(stringifyMessageContent).filter(Boolean);
    return parts.length > 0 ? parts.join("\n") : null;
  }

  if (!value || typeof value !== "object") return null;

  const record = value as Record<string, unknown>;
  const parts = record.parts;
  if (Array.isArray(parts)) {
    const text = parts.map(stringifyMessageContent).filter(Boolean).join("\n");
    if (text.trim()) return text;
  }

  const text = record.text;
  if (typeof text === "string") return text;

  return null;
}

function normalizeRole(role: string): string {
  const normalized = role.trim().toLowerCase();
  if (["user", "human", "me", "我", "用户"].includes(normalized)) return "user";
  if (["assistant", "ai", "bot", "model", "助手"].includes(normalized)) return "assistant";
  if (normalized === "system") return "system";
  return role.trim();
}

function compactText(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function countPlainTextMessages(text: string): number {
  const matches = text.match(/(^|\n)\s*(user|assistant|human|ai|用户|助手|我|你)\s*[:：]/gi);
  return matches?.length ?? 0;
}

function dedupeCandidates(candidates: MemoryCandidate[]): MemoryCandidate[] {
  const byKey = new Map<string, MemoryCandidate>();

  for (const candidate of candidates) {
    const content = candidate.content.trim();
    if (!content) continue;

    const key = `${candidate.type}:${content}`;
    const previous = byKey.get(key);
    if (!previous || candidate.importance > previous.importance || candidate.confidence > previous.confidence) {
      byKey.set(key, {
        ...candidate,
        content,
        sourceMessageIds: Array.from(new Set([...(previous?.sourceMessageIds ?? []), ...candidate.sourceMessageIds])),
      });
    }
  }

  return [...byKey.values()].sort((a, b) => b.importance - a.importance);
}

function toUtc8IsoString(date: Date): string {
  const utc8Time = date.getTime() + 8 * 60 * 60 * 1000;
  const shifted = new Date(utc8Time);
  return `${shifted.toISOString().slice(0, 19)}+08:00`;
}

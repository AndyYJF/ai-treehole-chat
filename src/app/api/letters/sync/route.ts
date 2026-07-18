import { NextResponse } from "next/server";
import { requireApiSession } from "@/lib/auth-runtime";
import { callDeepSeek } from "@/lib/deepseek";
import {
  isLetterDue,
  minimumLetterMemoryCount,
  normalizeLetterContent,
  selectLetterMemories,
} from "@/lib/letter-policy";
import { createLetter, listLetters } from "@/lib/letters";
import { getMemoryRepository } from "@/lib/memory/repository";
import type { MemoryRecord } from "@/lib/memory/types";
import { getServerUserId } from "@/lib/server-user";

export const runtime = "nodejs";

const syncLocks = new Map<string, number>();

export async function POST(request: Request) {
  const unauthorized = await requireApiSession(request);
  if (unauthorized) return unauthorized;

  const userId = getServerUserId();
  const now = Date.now();
  const lockedAt = syncLocks.get(userId);

  if (lockedAt && now - lockedAt < 60_000) {
    return new Response(null, { status: 204 });
  }

  syncLocks.set(userId, now);

  try {
    const existingLetters = await listLetters(userId);
    const lastLetter = existingLetters[0] ?? null;

    if (!isLetterDue(lastLetter?.createdAt ?? null)) {
      return new Response(null, { status: 204 });
    }

    const repository = getMemoryRepository();
    const memorySettings = await repository.getMemorySettings(userId);
    if (!memorySettings.enabled) {
      return new Response(null, { status: 204 });
    }
    const memories = selectLetterMemories(await repository.listMemories(userId));

    if (memories.length < minimumLetterMemoryCount) {
      return new Response(null, { status: 204 });
    }

    const content = await callDeepSeek({
      userId,
      operation: "timebox_letter",
      model: "deepseek-v4-flash",
      temperature: 0.76,
      messages: [
        {
          role: "system",
          content: buildLetterSystemPrompt(),
        },
        {
          role: "user",
          content: buildLetterUserPrompt({
            memories,
            lastLetterAt: lastLetter?.createdAt ?? null,
          }),
        },
      ],
    });

    const letter = await createLetter({
      userId,
      content: normalizeLetterContent(content),
    });

    return NextResponse.json({
      letter,
      letters: await listLetters(userId),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  } finally {
    syncLocks.delete(userId);
  }
}

function buildLetterSystemPrompt() {
  return [
    "你像一个倾听用户很久的老朋友，正在给用户写一封安静、温柔、不过度打扰的时光信。",
    "你的任务不是诊断、复盘人格或给出人生建议，而是把用户过去一段时间走过的情绪和事件轻轻接住。",
    "写作要求：",
    "1. 使用中文，散文式但自然，不要华丽堆砌。",
    "2. 不超过 500 字。",
    "3. 不要使用“亲爱的用户”“作为 AI”等客套或身份声明。",
    "4. 可以自然提到一两件记忆里的事，但不要像清单或报告。",
    "5. 结尾留一点陪伴感，不要强迫用户回应。",
  ].join("\n");
}

function buildLetterUserPrompt(input: { memories: MemoryRecord[]; lastLetterAt: string | null }) {
  return [
    input.lastLetterAt ? `上一封时光信时间：${formatShanghaiTime(input.lastLetterAt)}` : "这是第一封时光信。",
    "",
    "以下是最近一段时间可参考的长期记忆：",
    input.memories.map(formatLetterMemory).join("\n"),
    "",
    "请基于这些记忆写一封时光信。",
  ].join("\n");
}

function formatLetterMemory(memory: MemoryRecord) {
  return `- [${memory.type}][重要度 ${memory.importance}][${formatShanghaiTime(
    memory.lastSeenAt || memory.createdAt,
  )}] ${memory.content}`;
}

function formatShanghaiTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未知";

  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

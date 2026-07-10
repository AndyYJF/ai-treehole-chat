import { NextResponse } from "next/server";
import { requireApiSession } from "@/lib/auth-runtime";
import { listAllChatMessages, listChatThreads } from "@/lib/chat-history";
import { listLetters } from "@/lib/letters";
import { getMemoryRepository } from "@/lib/memory/repository";
import { getModelUsageSummary, listModelUsage } from "@/lib/model-usage";
import { getServerUserId } from "@/lib/server-user";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const unauthorized = await requireApiSession(request);
  if (unauthorized) return unauthorized;

  const userId = getServerUserId();
  const repository = getMemoryRepository();
  const [threads, messages, letters, memories, memorySettings, usageSummary, usageEvents] = await Promise.all([
    listChatThreads(userId),
    listAllChatMessages(userId),
    listLetters(userId),
    repository.listAllMemories(userId),
    repository.getMemorySettings(userId),
    getModelUsageSummary(userId),
    listModelUsage(userId),
  ]);

  const messagesByThread = new Map<string, typeof messages>();
  for (const message of messages) {
    const current = messagesByThread.get(message.threadId) ?? [];
    current.push(message);
    messagesByThread.set(message.threadId, current);
  }

  return NextResponse.json({
    format: "ai-treehole-chat-export",
    schemaVersion: 2,
    exportedAt: new Date().toISOString(),
    userId,
    threads: threads.map((thread) => ({
      ...thread,
      messages: messagesByThread.get(thread.id) ?? [],
    })),
    letters,
    // Includes inactive/expired records so an export remains a complete copy.
    memories,
    memorySettings,
    modelUsage: {
      summary: usageSummary,
      events: usageEvents,
    },
  });
}

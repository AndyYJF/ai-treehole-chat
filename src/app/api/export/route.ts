import { NextResponse } from "next/server";
import { listChatMessages, listChatThreads } from "@/lib/chat-history";
import { getMemoryRepository } from "@/lib/memory/repository";
import { getModelUsageSummary, listModelUsage } from "@/lib/model-usage";
import { getServerUserId } from "@/lib/server-user";

export const runtime = "nodejs";

export async function GET() {
  const userId = getServerUserId();
  const repository = getMemoryRepository();

  return NextResponse.json({
    exportedAt: new Date().toISOString(),
    userId,
    threads: await Promise.all(
      (await listChatThreads(userId)).map(async (thread) => ({
        ...thread,
        messages: await listChatMessages(userId, thread.id, 500),
      })),
    ),
    memories: await repository.listMemories(userId),
    memorySettings: await repository.getMemorySettings(userId),
    modelUsage: {
      summary: await getModelUsageSummary(userId),
      recent: await listModelUsage(userId, 100),
    },
  });
}

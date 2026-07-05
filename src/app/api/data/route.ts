import { NextResponse } from "next/server";
import { requireApiSession } from "@/lib/auth-runtime";
import { clearAllChatMessages, ensureActiveChatThread, listChatThreads } from "@/lib/chat-history";
import { clearModelUsage, getModelUsageSummary } from "@/lib/model-usage";
import { getMemoryRepository } from "@/lib/memory/repository";
import { getServerUserId } from "@/lib/server-user";

export const runtime = "nodejs";

export async function DELETE(request: Request) {
  const unauthorized = await requireApiSession(request);
  if (unauthorized) return unauthorized;

  const userId = getServerUserId();
  const repository = getMemoryRepository();

  await clearAllChatMessages(userId);
  await repository.clearMemories(userId);
  await repository.setMemoryEnabled(userId, true);
  await clearModelUsage(userId);

  return NextResponse.json({
    activeThread: await ensureActiveChatThread(userId),
    threads: await listChatThreads(userId),
    messages: [],
    memories: [],
    settings: await repository.getMemorySettings(userId),
    usage: await getModelUsageSummary(userId),
  });
}

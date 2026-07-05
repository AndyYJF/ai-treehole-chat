import { NextResponse } from "next/server";
import { clearChatMessages, ensureActiveChatThread, listChatMessages, listChatThreads } from "@/lib/chat-history";
import { getServerUserId } from "@/lib/server-user";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const userId = getServerUserId();
  const threadId = new URL(request.url).searchParams.get("threadId");
  const activeThread = await ensureActiveChatThread(userId, threadId);

  return NextResponse.json({
    activeThread,
    threads: await listChatThreads(userId),
    messages: await listChatMessages(userId, activeThread.id),
  });
}

export async function DELETE(request: Request) {
  const userId = getServerUserId();
  const threadId = new URL(request.url).searchParams.get("threadId");
  const activeThreadId = await clearChatMessages(userId, threadId);

  return NextResponse.json({
    activeThread: await ensureActiveChatThread(userId, activeThreadId),
    threads: await listChatThreads(userId),
    messages: [],
  });
}

import { NextResponse } from "next/server";
import { z } from "zod";
import {
  createChatThread,
  deleteChatThread,
  ensureActiveChatThread,
  listChatMessages,
  listChatThreads,
} from "@/lib/chat-history";
import { requireApiSession } from "@/lib/auth-runtime";
import { getServerUserId } from "@/lib/server-user";

export const runtime = "nodejs";

const createThreadSchema = z.object({
  title: z.string().max(32).optional(),
});

export async function GET(request: Request) {
  const unauthorized = await requireApiSession(request);
  if (unauthorized) return unauthorized;

  const userId = getServerUserId();
  const threadId = new URL(request.url).searchParams.get("threadId");
  const activeThread = await ensureActiveChatThread(userId, threadId);

  return NextResponse.json({
    activeThread,
    threads: await listChatThreads(userId),
    messages: await listChatMessages(userId, activeThread.id),
  });
}

export async function POST(request: Request) {
  const unauthorized = await requireApiSession(request);
  if (unauthorized) return unauthorized;

  const userId = getServerUserId();
  const body = createThreadSchema.parse(await request.json().catch(() => ({})));
  const thread = await createChatThread(userId, body.title);

  return NextResponse.json({
    activeThread: thread,
    threads: await listChatThreads(userId),
    messages: [],
  });
}

export async function DELETE(request: Request) {
  const unauthorized = await requireApiSession(request);
  if (unauthorized) return unauthorized;

  const userId = getServerUserId();
  const threadId = new URL(request.url).searchParams.get("threadId");

  if (!threadId) {
    return NextResponse.json({ error: "threadId is required" }, { status: 400 });
  }

  const activeThread = await deleteChatThread(userId, threadId);

  return NextResponse.json({
    activeThread,
    threads: await listChatThreads(userId),
    messages: await listChatMessages(userId, activeThread.id),
  });
}

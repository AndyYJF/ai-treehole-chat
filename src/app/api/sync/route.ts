import { NextResponse } from "next/server";
import { requireApiSession } from "@/lib/auth-runtime";
import {
  ensureActiveChatThread,
  listAllChatMessages,
  listChatThreads,
} from "@/lib/chat-history";
import { listLetters } from "@/lib/letters";
import { getMemoryRepository } from "@/lib/memory/repository";
import { getModelUsageSummary, listModelUsage } from "@/lib/model-usage";
import { getServerUserId } from "@/lib/server-user";
import {
  ensureSyncSchema,
  compareSyncCursors,
  getLatestSyncCursor,
  hasPostgresSync,
  listSyncChanges,
  parseCursor,
} from "@/lib/sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const syncHeaders = {
  "Cache-Control": "no-store, max-age=0",
};

/**
 * First request returns an authoritative snapshot. Subsequent requests provide
 * a compact ordered change feed; clients then refresh only the affected view.
 */
export async function GET(request: Request) {
  const unauthorized = await requireApiSession(request);
  if (unauthorized) return unauthorized;

  const userId = getServerUserId();
  const url = new URL(request.url);
  const requestedCursor = url.searchParams.get("cursor");
  const parsedCursor = parseCursor(requestedCursor);

  if (!hasPostgresSync() || !requestedCursor || parsedCursor === "0") {
    const cursor = hasPostgresSync() ? await getLatestSyncCursor(userId) : "0";
    const snapshot = await loadSyncSnapshot(userId);
    return NextResponse.json(
      {
        mode: "snapshot",
        cursor,
        ...snapshot,
      },
      { headers: syncHeaders },
    );
  }

  await ensureSyncSchema();
  const latestCursor = await getLatestSyncCursor(userId);

  // A cursor ahead of the server is from a reset/restore and must not silently
  // suppress updates. Return a fresh snapshot instead.
  if (compareSyncCursors(parsedCursor, latestCursor) > 0) {
    const snapshot = await loadSyncSnapshot(userId);
    return NextResponse.json(
      {
        mode: "snapshot",
        reset: true,
        cursor: latestCursor,
        ...snapshot,
      },
      { headers: syncHeaders },
    );
  }

  const changes = await listSyncChanges(userId, requestedCursor);
  return NextResponse.json(
    {
      mode: "changes",
      ...changes,
    },
    { headers: syncHeaders },
  );
}

async function loadSyncSnapshot(userId: string) {
  // These reads also run the repositories' additive schema initialization and
  // install their durable change-log triggers on a new deployment.
  const repository = getMemoryRepository();
  const [activeThread, threads, messages, memories, memorySettings, letters, usageSummary, usageRecent] =
    await Promise.all([
      ensureActiveChatThread(userId),
      listChatThreads(userId),
      listAllChatMessages(userId),
      repository.listMemories(userId),
      repository.getMemorySettings(userId),
      listLetters(userId),
      getModelUsageSummary(userId),
      listModelUsage(userId, 30),
    ]);

  return {
    activeThread,
    threads,
    messages,
    memories,
    memorySettings,
    letters,
    usage: { summary: usageSummary, recent: usageRecent },
  };
}

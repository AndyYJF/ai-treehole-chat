import { NextResponse } from "next/server";
import { z } from "zod";
import {
  appendChatMessages,
  ensureActiveChatThread,
  listChatMessages,
  listChatThreads,
} from "@/lib/chat-history";
import { streamDeepSeek } from "@/lib/deepseek";
import { requireApiSession } from "@/lib/auth-runtime";
import { getMemoryRepository } from "@/lib/memory/repository";
import type { MemoryRecord } from "@/lib/memory/types";
import { buildRealityContext, type RealityContextStatus } from "@/lib/reality-context";
import { getServerUserId } from "@/lib/server-user";

export const runtime = "nodejs";

const greetingRequestSchema = z.object({
  threadId: z.string().optional(),
});

const greetingThresholdMs = 8 * 60 * 60 * 1000;

const greetingLocks = new Map<string, number>();

export async function POST(request: Request) {
  const unauthorized = await requireApiSession(request);
  if (unauthorized) return unauthorized;

  try {
    const body = greetingRequestSchema.parse(await request.json().catch(() => ({})));
    const userId = getServerUserId();
    const activeThread = await ensureActiveChatThread(userId, body.threadId);
    const lockKey = `${userId}:${activeThread.id}`;
    const now = Date.now();
    const existingLock = greetingLocks.get(lockKey);

    if (existingLock && now - existingLock < 60_000) {
      return new Response(null, { status: 204 });
    }

    const serverMessages = await listChatMessages(userId, activeThread.id, 24);
    const lastMessage = serverMessages.at(-1);
    const lastMessageAt = lastMessage ? new Date(lastMessage.createdAt).getTime() : null;

    if (lastMessageAt && now - lastMessageAt < greetingThresholdMs) {
      return new Response(null, { status: 204 });
    }

    greetingLocks.set(lockKey, now);

    return createGreetingStream(
      {
        userId,
        threadId: activeThread.id,
        recentMessages: serverMessages,
      },
      request.signal,
      () => greetingLocks.delete(lockKey),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

function createGreetingStream(
  input: {
    userId: string;
    threadId: string;
    recentMessages: Array<{ role: "user" | "assistant"; content: string; createdAt: string }>;
  },
  signal: AbortSignal,
  releaseLock: () => void,
) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: unknown) => {
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };

      try {
        const repository = getMemoryRepository();
        const recentMessages = input.recentMessages.slice(-8);
        const realityContext = await buildRealityContext({
          userId: input.userId,
          latestMessage: "用户重新打开聊天页面，请生成主动关怀。只需要当前时间、星期和节假日上下文，不需要联网搜索。",
          recentMessages,
          onStatus: (status: RealityContextStatus) => {
            send({ type: "status", status });
          },
        });
        const allMemories = await repository.listMemories(input.userId);
        const greetingMemories = selectGreetingMemories(allMemories);
        const promptMessages = [
          {
            role: "system" as const,
            content: buildGreetingSystemPrompt({
              realityContext,
              memories: greetingMemories,
              recentMessages,
            }),
          },
          {
            role: "user" as const,
            content: "请生成这条主动关怀消息。",
          },
        ];
        let reply = "";

        send({
          type: "route",
          routed: {
            label: "主动关怀",
          },
        });

        for await (const chunk of streamDeepSeek({
          userId: input.userId,
          operation: "chat",
          model: "deepseek-v4-flash",
          messages: promptMessages,
          temperature: 0.65,
          signal,
        })) {
          if (chunk.type === "reasoning") {
            send({ type: "reasoning" });
            continue;
          }

          reply += chunk.delta;
          send({
            type: "token",
            delta: chunk.delta,
          });
        }

        const messages = await appendChatMessages(input.userId, input.threadId, [
          {
            role: "assistant",
            content: reply.trim() || "我在。你可以慢慢说。",
          },
        ]);

        send({
          type: "done",
          routed: {
            label: "主动关怀",
          },
          memories: allMemories.slice(0, 8),
          usedMemories: greetingMemories,
          activeThread: await ensureActiveChatThread(input.userId, input.threadId),
          threads: await listChatThreads(input.userId),
          messages,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        send({
          type: "error",
          error: message,
        });
      } finally {
        releaseLock();
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
    },
  });
}

function selectGreetingMemories(memories: MemoryRecord[]) {
  return memories
    .filter((memory) => memory.type === "affect" || memory.type === "episodic")
    .sort((left, right) => {
      if (right.importance !== left.importance) return right.importance - left.importance;
      return new Date(right.lastSeenAt).getTime() - new Date(left.lastSeenAt).getTime();
    })
    .slice(0, 6);
}

function buildGreetingSystemPrompt(input: {
  realityContext: string;
  memories: MemoryRecord[];
  recentMessages: Array<{ role: "user" | "assistant"; content: string; createdAt: string }>;
}) {
  return [
    "你是一个树洞陪伴者。用户距离上次和你聊天已经过去了一段时间。",
    "",
    `【当前现实时间】：${input.realityContext}`,
    `【最近的用户记忆】：${formatGreetingMemories(input.memories)}`,
    `【上次聊天结尾】：${formatRecentHistory(input.recentMessages)}`,
    "",
    "**你的任务**：主动向用户发送今天的第一条问候。",
    "**约束条件**：",
    "1. 极其简短，控制在 1-2 句话内，像朋友发来的一条随口留言。",
    "2. 绝不使用“你好”、“我是 AI”等客套话。",
    "3. 自然地结合最近的记忆（比如关心上次的事），但不要像在念备忘录。如果上次聊天沉重，请给予温暖的陪伴感。",
    "4. 结尾不需要强制抛出问题逼迫用户回答。",
  ].join("\n");
}

function formatGreetingMemories(memories: MemoryRecord[]) {
  if (memories.length === 0) return "暂无可用的高重要度情绪/事件记忆。";

  return memories
    .map((memory) => {
      const seenAt = formatTimestamp(memory.lastSeenAt || memory.createdAt);
      return `- [${memory.type}][重要度 ${memory.importance}][最近出现 ${seenAt}] ${memory.content}`;
    })
    .join("\n");
}

function formatRecentHistory(messages: Array<{ role: "user" | "assistant"; content: string; createdAt: string }>) {
  if (messages.length === 0) return "这是当前时间线的开场。";

  return messages
    .slice(-6)
    .map((message) => {
      const role = message.role === "user" ? "用户" : "助手";
      return `- [${formatTimestamp(message.createdAt)}] ${role}：${message.content.slice(0, 220)}`;
    })
    .join("\n");
}

function formatTimestamp(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未知";

  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

import { NextResponse } from "next/server";
import { z } from "zod";
import {
  appendChatMessages,
  ensureActiveChatThread,
  listChatMessages,
  listChatThreads,
  updateChatThreadTitle,
} from "@/lib/chat-history";
import { finishChatTurn, prepareChatTurn, runChatTurn } from "@/lib/chat-engine";
import { streamDeepSeek } from "@/lib/deepseek";
import { requireApiSession } from "@/lib/auth-runtime";
import { modelTierSchema } from "@/lib/model-routing";
import { getServerUserId } from "@/lib/server-user";
import { summarizeThreadTitle } from "@/lib/thread-title";

export const runtime = "nodejs";

const chatRequestSchema = z.object({
  threadId: z.string().optional(),
  message: z.string().min(1).max(8000),
  tier: modelTierSchema.default("auto"),
  memoryEnabled: z.boolean().default(true),
  temperature: z.number().min(0).max(1.2).default(0.72),
  stream: z.boolean().default(false),
  recentMessages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string(),
      }),
    )
    .default([]),
});

export async function POST(request: Request) {
  const unauthorized = await requireApiSession(request);
  if (unauthorized) return unauthorized;

  try {
    const body = chatRequestSchema.parse(await request.json());
    const userId = getServerUserId();
    const activeThread = await ensureActiveChatThread(userId, body.threadId);
    const serverMessages = await listChatMessages(userId, activeThread.id, 24);
    const isFirstTurn = serverMessages.length === 0;
    const input = {
      ...body,
      threadId: activeThread.id,
      userId,
      isFirstTurn,
      recentMessages: serverMessages.slice(-12).map((message) => ({
        role: message.role,
        content: message.content,
        createdAt: message.createdAt,
      })),
    };

    if (body.stream) {
      return createChatStream(input, request.signal);
    }

    const result = await runChatTurn(input);
    const messages = await appendChatMessages(userId, activeThread.id, [
      { role: "user", content: body.message },
      { role: "assistant", content: result.reply },
    ]);
    const thread = isFirstTurn
      ? await updateChatThreadTitle(
          userId,
          activeThread.id,
          await summarizeThreadTitle({
            userId,
            userMessage: body.message,
            assistantReply: result.reply,
          }),
        )
      : await ensureActiveChatThread(userId, activeThread.id);

    return NextResponse.json({
      ...result,
      activeThread: thread,
      threads: await listChatThreads(userId),
      messages,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";

    return NextResponse.json(
      {
        error: message,
      },
      { status: 400 },
    );
  }
}

function createChatStream(
  input: z.infer<typeof chatRequestSchema> & {
    threadId: string;
    userId: string;
    isFirstTurn: boolean;
    recentMessages: Array<{ role: "user" | "assistant"; content: string; createdAt?: string }>;
  },
  signal: AbortSignal,
) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: unknown) => {
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };

      try {
        const prepared = await prepareChatTurn(input);
        let reply = "";

        send({
          type: "route",
          routed: prepared.routed,
        });

        for await (const chunk of streamDeepSeek({
          userId: input.userId,
          operation: "chat",
          model: prepared.routed.model,
          messages: prepared.promptMessages,
          temperature: input.temperature,
          signal,
        })) {
          if (chunk.type === "reasoning") {
            send({
              type: "reasoning",
            });
            continue;
          }

          reply += chunk.delta;
          send({
            type: "token",
            delta: chunk.delta,
          });
        }

        const memories = await finishChatTurn({
          userId: input.userId,
          messageId: prepared.messageId,
          message: input.message,
          memoryEnabled: input.memoryEnabled,
          memories: prepared.memories,
        });
        const messages = await appendChatMessages(input.userId, input.threadId, [
          { role: "user", content: input.message },
          { role: "assistant", content: reply.trim() || "我在。你可以慢慢说。" },
        ]);
        const activeThread = input.isFirstTurn
          ? await updateChatThreadTitle(
              input.userId,
              input.threadId,
              await summarizeThreadTitle({
                userId: input.userId,
                userMessage: input.message,
                assistantReply: reply,
              }),
            )
          : await ensureActiveChatThread(input.userId, input.threadId);

        send({
          type: "done",
          routed: prepared.routed,
          memories,
          activeThread,
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

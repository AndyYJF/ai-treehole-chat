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
import { getRuntimeConfig, type RuntimeConfig } from "@/lib/app-config";
import { maybeMaintainMemories } from "@/lib/memory/maintenance";
import { modelTierSchema } from "@/lib/model-routing";
import { stripInternalMetadata } from "@/lib/prompt";
import type { RealityContextStatus } from "@/lib/reality-context";
import { getServerUserId } from "@/lib/server-user";
import { summarizeThreadTitle } from "@/lib/thread-title";
import { extractImageDescription } from "@/lib/vision";

export const runtime = "nodejs";

const chatRequestSchema = z.object({
  threadId: z.string().optional(),
  message: z.string().min(1).max(8000),
  tier: modelTierSchema.default("auto"),
  memoryEnabled: z.boolean().default(true),
  temperature: z.number().min(0).max(1.2).default(0.72),
  stream: z.boolean().default(false),
  imageBase64: z.string().max(5_000_000).optional(),
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
    void maybeMaintainMemories({ userId });
    const activeThread = await ensureActiveChatThread(userId, body.threadId);
    const serverMessages = await listChatMessages(userId, activeThread.id, 24);
    // Recover turns that reached the UI but never finished persisting (e.g. network drop).
    const recoveredMessages = await recoverUnsyncedClientMessages(
      userId,
      activeThread.id,
      serverMessages,
      body.recentMessages,
    );
    const historyMessages = [...serverMessages, ...recoveredMessages];
    const isFirstTurn = historyMessages.length === 0;
    const message = body.stream
      ? body.message
      : await buildVisionAugmentedMessage(body.message, body.imageBase64);
    const displayMessage = buildUserDisplayMessage(body.message, body.imageBase64);
    const input = {
      ...body,
      message,
      displayMessage,
      threadId: activeThread.id,
      userId,
      isFirstTurn,
      recentMessages: historyMessages.slice(-12).map((message) => ({
        role: message.role,
        content: message.content,
        createdAt: message.createdAt,
      })),
    };

    if (body.stream) {
      return createChatStream(input, request.signal);
    }

    // Persist the user turn first so a later failure still keeps it in context.
    await appendChatMessages(userId, activeThread.id, [
      { role: "user", content: input.displayMessage },
    ]);

    const result = await runChatTurn(input);
    const assistantReply = stripInternalMetadata(result.reply) || "我在。你可以慢慢说。";
    const messages = await appendChatMessages(userId, activeThread.id, [
      { role: "assistant", content: assistantReply },
    ]);
    const thread = isFirstTurn
      ? await updateChatThreadTitle(
          userId,
          activeThread.id,
          await summarizeThreadTitle({
            userId,
            userMessage: input.displayMessage,
            assistantReply,
          }),
        )
      : await ensureActiveChatThread(userId, activeThread.id);

    return NextResponse.json({
      ...result,
      reply: assistantReply,
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
    displayMessage: string;
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
        const turnInput = {
          ...input,
          message: await buildVisionAugmentedMessage(input.message, input.imageBase64, () => {
            send({
              type: "status",
              status: {
                type: "vision",
                label: "\u8bc6\u56fe\u4e2d",
              },
            });
          }),
        };
        // Persist the user message before model work so network/model failures
        // still leave this turn in the next request's server-side context.
        await appendChatMessages(turnInput.userId, turnInput.threadId, [
          { role: "user", content: turnInput.displayMessage },
        ]);

        const prepared = await prepareChatTurn({
          ...turnInput,
          onRealityStatus: (status: RealityContextStatus) => {
            send({
              type: "status",
              status,
            });
          },
        });
        let reply = "";

        send({
          type: "route",
          routed: prepared.routed,
        });

        for await (const chunk of streamDeepSeek({
          userId: turnInput.userId,
          operation: "chat",
          model: prepared.routed.model,
          messages: prepared.promptMessages,
          temperature: turnInput.temperature,
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

        const assistantReply = stripInternalMetadata(reply) || "我在。你可以慢慢说。";
        const memories = await finishChatTurn({
          userId: turnInput.userId,
          messageId: prepared.messageId,
          message: turnInput.message,
          memoryEnabled: turnInput.memoryEnabled,
          memories: prepared.memories,
        });
        const messages = await appendChatMessages(turnInput.userId, turnInput.threadId, [
          { role: "assistant", content: assistantReply },
        ]);
        const activeThread = turnInput.isFirstTurn
          ? await updateChatThreadTitle(
              turnInput.userId,
              turnInput.threadId,
              await summarizeThreadTitle({
                userId: turnInput.userId,
                userMessage: turnInput.displayMessage,
                assistantReply,
              }),
            )
          : await ensureActiveChatThread(turnInput.userId, turnInput.threadId);

        send({
          type: "done",
          routed: prepared.routed,
          memories,
          usedMemories: prepared.memories,
          activeThread,
          threads: await listChatThreads(turnInput.userId),
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

async function buildVisionAugmentedMessage(
  message: string,
  imageBase64?: string,
  onVisionStart?: () => void,
) {
  const trimmedImage = imageBase64?.trim();
  if (!trimmedImage) return message;

  const config = await getRuntimeConfig();
  if (!isVisionConfigured(config)) return message;

  try {
    onVisionStart?.();
    const description = await extractImageDescription(trimmedImage, config);
    const userText = message.trim() || "\uff08\u7528\u6237\u6ca1\u6709\u8f93\u5165\u914d\u6587\uff09";

    return [
      "[User uploaded an image. Vision description:]",
      description,
      "",
      "[User caption]",
      userText,
    ].join("\n");
  } catch {
    return message;
  }
}

function buildUserDisplayMessage(message: string, imageBase64?: string) {
  if (!imageBase64?.trim()) return message;

  const userText = message.trim() || "\u8bf7\u770b\u770b\u8fd9\u5f20\u56fe\u7247\u3002";
  return `\u3010\u56fe\u7247\u3011${userText}`;
}

function isVisionConfigured(config: RuntimeConfig) {
  return Boolean(
    config.visionApiKey.trim() &&
      config.visionBaseUrl.trim() &&
      config.visionModelName.trim(),
  );
}

const CLIENT_NETWORK_FALLBACK =
  "刚刚连接不太顺。你说的我先接住，我们可以再试一次。";

async function recoverUnsyncedClientMessages(
  userId: string,
  threadId: string,
  serverMessages: Array<{ role: "user" | "assistant"; content: string; createdAt: string }>,
  clientRecentMessages: Array<{ role: "user" | "assistant"; content: string }>,
) {
  if (clientRecentMessages.length === 0) return [] as Array<{
    role: "user" | "assistant";
    content: string;
    createdAt: string;
  }>;

  const serverTail = serverMessages.map((message) => ({
    role: message.role,
    content: message.content,
  }));
  let overlap = 0;

  for (let size = Math.min(serverTail.length, clientRecentMessages.length); size >= 0; size -= 1) {
    const serverSlice = serverTail.slice(serverTail.length - size);
    const clientSlice = clientRecentMessages.slice(0, size);
    const matches = serverSlice.every(
      (message, index) =>
        message.role === clientSlice[index]?.role && message.content === clientSlice[index]?.content,
    );

    if (matches) {
      overlap = size;
      break;
    }
  }

  const missing = clientRecentMessages
    .slice(overlap)
    .filter((message) => {
      if (message.role === "assistant" && message.content.trim() === CLIENT_NETWORK_FALLBACK) {
        return false;
      }
      return message.content.trim().length > 0;
    })
    .map((message) => ({
      role: message.role,
      content: stripInternalMetadata(message.content) || message.content,
    }));

  if (missing.length === 0) {
    return [] as Array<{
      role: "user" | "assistant";
      content: string;
      createdAt: string;
    }>;
  }

  const persisted = await appendChatMessages(userId, threadId, missing);
  return persisted.slice(-missing.length);
}

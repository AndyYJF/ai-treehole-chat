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
import { getMemoryRepository } from "@/lib/memory/repository";
import { maybeMaintainMemories } from "@/lib/memory/maintenance";
import { modelTierSchema } from "@/lib/model-routing";
import { stripInternalMetadata } from "@/lib/prompt";
import type { RealityContextStatus } from "@/lib/reality-context";
import { getServerUserId } from "@/lib/server-user";
import { summarizeThreadTitle } from "@/lib/thread-title";
import { extractImageDescription } from "@/lib/vision";

export const runtime = "nodejs";

const maxRecentClientMessages = 12;
const maxClientMessageContentLength = 8000;

const chatRequestSchema = z.object({
  threadId: z.string().optional(),
  clientTurnId: z.string().optional(),
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
        content: z.string().max(maxClientMessageContentLength),
      }),
    )
    .max(maxRecentClientMessages)
    .default([]),
});

export async function POST(request: Request) {
  const unauthorized = await requireApiSession(request);
  if (unauthorized) return unauthorized;

  try {
    const body = chatRequestSchema.parse(await request.json());
    const userId = getServerUserId();
    const settings = await getMemoryRepository().getMemorySettings(userId);
    const memoryEnabled = settings.enabled && body.memoryEnabled;

    void maybeMaintainMemories({ userId });
    const activeThread = await ensureActiveChatThread(userId, body.threadId);
    const serverMessages = await listChatMessages(userId, activeThread.id, 24);
    const historyMessages = serverMessages;
    const isFirstTurn = historyMessages.length === 0;
    const clientTurnId = body.clientTurnId || `turn-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const input = {
      ...body,
      memoryEnabled,
      message: body.message,
      threadId: activeThread.id,
      userId,
      isFirstTurn,
      clientTurnId,
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
    const messageWithVision = await buildVisionAugmentedMessage(input.message, input.imageBase64);
    const userMessageId = `msg-${input.clientTurnId}-user`;
    await appendChatMessages(userId, activeThread.id, [
      { role: "user", content: messageWithVision, clientMessageId: userMessageId, clientTurnId: input.clientTurnId },
    ]);

    const result = await runChatTurn({ ...input, message: messageWithVision });
    const assistantReply = stripInternalMetadata(result.reply) || "我在。你可以慢慢说。";
    const assistantMessageId = `msg-${input.clientTurnId}-assistant`;
    const messages = await appendChatMessages(userId, activeThread.id, [
      { role: "assistant", content: assistantReply, clientMessageId: assistantMessageId, clientTurnId: input.clientTurnId },
    ]);
    const thread = isFirstTurn
      ? await updateChatThreadTitle(
          userId,
          activeThread.id,
          await summarizeThreadTitle({
            userId,
            userMessage: input.message,
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
    clientTurnId: string;
    memoryEnabled: boolean;
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
        const userMessageId = `msg-${turnInput.clientTurnId}-user`;
        await appendChatMessages(turnInput.userId, turnInput.threadId, [
          { role: "user", content: turnInput.message, clientMessageId: userMessageId, clientTurnId: turnInput.clientTurnId },
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
        const assistantMessageId = `msg-${turnInput.clientTurnId}-assistant`;
        const messages = await appendChatMessages(turnInput.userId, turnInput.threadId, [
          { role: "assistant", content: assistantReply, clientMessageId: assistantMessageId, clientTurnId: turnInput.clientTurnId },
        ]);
        let memories = prepared.memories.slice(0, 8);
        try {
          memories = await finishChatTurn({
            userId: turnInput.userId,
            messageId: prepared.messageId,
            message: turnInput.message,
            memoryEnabled: turnInput.memoryEnabled,
            memories: prepared.memories,
          });
        } catch (error) {
          console.error("Memory extraction failed:", error);
        }
        const activeThread = turnInput.isFirstTurn
          ? await updateChatThreadTitle(
              turnInput.userId,
              turnInput.threadId,
              await summarizeThreadTitle({
                userId: turnInput.userId,
                userMessage: turnInput.message,
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
          assistantMessageId: latestAssistantMessageId(messages),
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
    const userText = message.trim() || "请看看这张图片。";
    const quotedDescription = description.split('\n').map(line => `> ${line}`).join('\n');

    return [
      `> 📷 **视觉分析提取**：\n${quotedDescription}`,
      "",
      userText,
    ].join("\n");
  } catch {
    return message;
  }
}

function isVisionConfigured(config: RuntimeConfig) {
  return Boolean(
    config.visionApiKey.trim() &&
      config.visionBaseUrl.trim() &&
      config.visionModelName.trim(),
  );
}



function latestAssistantMessageId(messages: Array<{ role: "user" | "assistant"; id: string }>) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "assistant") return message.id;
  }

  return undefined;
}



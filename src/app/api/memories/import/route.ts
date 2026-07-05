import { NextResponse } from "next/server";
import { z } from "zod";
import { requireApiSession } from "@/lib/auth-runtime";
import { analyzeImportedConversation } from "@/lib/memory/import";
import { maybeMaintainMemories } from "@/lib/memory/maintenance";
import { getMemoryRepository } from "@/lib/memory/repository";
import { memoryTypeSchema, sensitivitySchema } from "@/lib/memory/types";
import { getServerUserId } from "@/lib/server-user";

export const runtime = "nodejs";

const memoryCandidateSchema = z.object({
  type: memoryTypeSchema,
  content: z.string().min(4).max(140),
  confidence: z.number().min(0).max(1),
  importance: z.number().int().min(0).max(100),
  sensitivity: sensitivitySchema,
  sourceMessageIds: z.array(z.string()).default([]),
  validFrom: z.string().nullable(),
  validUntil: z.string().nullable(),
});

const importRequestSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("analyze"),
    sourceName: z.string().max(80).optional(),
    content: z.string().min(20).max(180000),
  }),
  z.object({
    action: z.literal("add"),
    candidates: z.array(memoryCandidateSchema).min(1).max(16),
  }),
]);

export async function POST(request: Request) {
  const unauthorized = await requireApiSession(request);
  if (unauthorized) return unauthorized;

  try {
    const body = importRequestSchema.parse(await request.json());
    const userId = getServerUserId();

    if (body.action === "analyze") {
      return NextResponse.json(await analyzeImportedConversation({
        userId,
        sourceName: body.sourceName,
        content: body.content,
      }));
    }

    const repository = getMemoryRepository();
    const now = toUtc8IsoString(new Date());
    const memories = await repository.addMemoryCandidates(
        userId,
        body.candidates.map((candidate) => ({
          ...candidate,
          validFrom: candidate.validFrom ?? now,
        })),
      );
    void maybeMaintainMemories({ userId, force: true });

    return NextResponse.json({
      memories,
      settings: await repository.getMemorySettings(userId),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

function toUtc8IsoString(date: Date): string {
  const utc8Time = date.getTime() + 8 * 60 * 60 * 1000;
  const shifted = new Date(utc8Time);
  return `${shifted.toISOString().slice(0, 19)}+08:00`;
}

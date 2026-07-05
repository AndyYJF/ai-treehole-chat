import { NextResponse } from "next/server";
import { z } from "zod";
import { requireApiSession } from "@/lib/auth-runtime";
import { getMemoryRepository } from "@/lib/memory/repository";
import { memoryTypeSchema, sensitivitySchema } from "@/lib/memory/types";
import { getServerUserId } from "@/lib/server-user";

export const runtime = "nodejs";

const memoryPatchSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("confirm"),
    memoryId: z.string(),
  }),
  z.object({
    action: z.literal("update"),
    memoryId: z.string(),
    type: memoryTypeSchema,
    content: z.string().min(4).max(200),
    importance: z.number().int().min(0).max(100),
    sensitivity: sensitivitySchema,
  }),
  z.object({
    action: z.literal("delete"),
    memoryId: z.string(),
  }),
  z.object({
    action: z.literal("setEnabled"),
    enabled: z.boolean(),
  }),
]);

export async function GET(request: Request) {
  const unauthorized = await requireApiSession(request);
  if (unauthorized) return unauthorized;

  const userId = getServerUserId();
  const repository = getMemoryRepository();

  return NextResponse.json({
    memories: await repository.listMemories(userId),
    settings: await repository.getMemorySettings(userId),
  });
}

export async function PATCH(request: Request) {
  const unauthorized = await requireApiSession(request);
  if (unauthorized) return unauthorized;

  try {
    const body = memoryPatchSchema.parse(await request.json());
    const userId = getServerUserId();
    const repository = getMemoryRepository();

    if (body.action === "confirm") {
      return NextResponse.json({
        memories: await repository.confirmMemory(userId, body.memoryId),
        settings: await repository.getMemorySettings(userId),
      });
    }

    if (body.action === "update") {
      return NextResponse.json({
        memories: await repository.updateMemory(userId, body.memoryId, {
          type: body.type,
          content: body.content,
          importance: body.importance,
          sensitivity: body.sensitivity,
        }),
        settings: await repository.getMemorySettings(userId),
      });
    }

    if (body.action === "delete") {
      return NextResponse.json({
        memories: await repository.deleteMemory(userId, body.memoryId),
        settings: await repository.getMemorySettings(userId),
      });
    }

    return NextResponse.json({
      memories: await repository.listMemories(userId),
      settings: await repository.setMemoryEnabled(userId, body.enabled),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export async function DELETE(request: Request) {
  const unauthorized = await requireApiSession(request);
  if (unauthorized) return unauthorized;

  const userId = getServerUserId();
  const repository = getMemoryRepository();

  return NextResponse.json({
    memories: await repository.clearMemories(userId),
    settings: await repository.getMemorySettings(userId),
  });
}

import { NextResponse } from "next/server";
import { z } from "zod";
import { requireApiSession } from "@/lib/auth-runtime";
import { maybeMaintainMemories } from "@/lib/memory/maintenance";
import { getMemoryRepository } from "@/lib/memory/repository";
import { memoryTypeSchema, sensitivitySchema } from "@/lib/memory/types";
import { getServerUserId } from "@/lib/server-user";
import { isSyncConflictError } from "@/lib/sync-conflict";

export const runtime = "nodejs";

const memoryPatchSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("confirm"),
    memoryId: z.string(),
    expectedRevision: z.number().int().min(1).optional(),
  }),
  z.object({
    action: z.literal("update"),
    memoryId: z.string(),
    type: memoryTypeSchema,
    content: z.string().min(4).max(200),
    importance: z.number().int().min(0).max(100),
    sensitivity: sensitivitySchema,
    expectedRevision: z.number().int().min(1).optional(),
  }),
  z.object({
    action: z.literal("delete"),
    memoryId: z.string(),
    expectedRevision: z.number().int().min(1).optional(),
  }),
  z.object({
    action: z.literal("setEnabled"),
    enabled: z.boolean(),
    expectedRevision: z.number().int().min(1).optional(),
  }),
  z.object({
    action: z.literal("maintain"),
  }),
]);

export async function GET(request: Request) {
  const unauthorized = await requireApiSession(request);
  if (unauthorized) return unauthorized;

  const userId = getServerUserId();
  const repository = getMemoryRepository();
  void maybeMaintainMemories({ userId });

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
        memories: await repository.confirmMemory(userId, body.memoryId, body.expectedRevision),
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
        }, body.expectedRevision),
        settings: await repository.getMemorySettings(userId),
      });
    }

    if (body.action === "delete") {
      return NextResponse.json({
        memories: await repository.deleteMemory(userId, body.memoryId, body.expectedRevision),
        settings: await repository.getMemorySettings(userId),
      });
    }

    if (body.action === "maintain") {
      return NextResponse.json({
        memories: await repository.maintainMemories(userId),
        settings: await repository.getMemorySettings(userId),
      });
    }

    return NextResponse.json({
      memories: await repository.listMemories(userId),
      settings: await repository.setMemoryEnabled(userId, body.enabled, body.expectedRevision),
    });
  } catch (error) {
    if (isSyncConflictError(error)) {
      return NextResponse.json(
        { code: error.code, error: "该记录已在另一台设备上更新，请刷新后再试。" },
        { status: 409 },
      );
    }
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

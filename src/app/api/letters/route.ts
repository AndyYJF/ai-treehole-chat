import { NextResponse } from "next/server";
import { z } from "zod";
import { requireApiSession } from "@/lib/auth-runtime";
import { listLetters, markLetterRead } from "@/lib/letters";
import { getServerUserId } from "@/lib/server-user";

export const runtime = "nodejs";

const letterPatchSchema = z.object({
  id: z.string(),
});

export async function GET(request: Request) {
  const unauthorized = await requireApiSession(request);
  if (unauthorized) return unauthorized;

  const userId = getServerUserId();
  return NextResponse.json({
    letters: await listLetters(userId),
  });
}

export async function PATCH(request: Request) {
  const unauthorized = await requireApiSession(request);
  if (unauthorized) return unauthorized;

  try {
    const body = letterPatchSchema.parse(await request.json());
    const userId = getServerUserId();
    const letter = await markLetterRead(userId, body.id);

    if (!letter) {
      return NextResponse.json({ error: "Letter not found" }, { status: 404 });
    }

    return NextResponse.json({
      letter,
      letters: await listLetters(userId),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

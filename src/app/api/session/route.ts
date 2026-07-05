import { NextResponse } from "next/server";
import { z } from "zod";
import {
  createSessionValue,
  isAccessGateEnabled,
  isValidAccessToken,
  isValidSession,
  SESSION_COOKIE_NAME,
} from "@/lib/auth";

export const runtime = "nodejs";

const loginSchema = z.object({
  token: z.string().min(1),
});

export async function GET(request: Request) {
  const cookie = request.headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${SESSION_COOKIE_NAME}=`))
    ?.split("=")[1];

  return NextResponse.json({
    required: isAccessGateEnabled(),
    authenticated: await isValidSession(cookie),
  });
}

export async function POST(request: Request) {
  const body = loginSchema.parse(await request.json());
  const valid = await isValidAccessToken(body.token);

  if (!valid) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE_NAME, await createSessionValue(), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.TREEHOLE_COOKIE_SECURE === "true",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });

  return response;
}

export async function DELETE() {
  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE_NAME, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.TREEHOLE_COOKIE_SECURE === "true",
    path: "/",
    maxAge: 0,
  });

  return response;
}

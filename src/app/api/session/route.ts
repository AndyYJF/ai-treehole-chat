import { NextResponse } from "next/server";
import { z } from "zod";
import {
  isAccessGateEnabled,
  isValidSession,
  SESSION_COOKIE_NAME,
} from "@/lib/auth";
import {
  createRuntimeSessionValue,
  getSessionCookie,
  isRuntimeAccessGateEnabled,
  isValidRuntimeAccessToken,
  isValidRuntimeSession,
  runtimeCookieSecure,
} from "@/lib/auth-runtime";

export const runtime = "nodejs";

const loginSchema = z.object({
  token: z.string().min(1),
});

export async function GET(request: Request) {
  const cookie = getSessionCookie(request);
  const runtimeGateEnabled = await isRuntimeAccessGateEnabled();

  return NextResponse.json({
    required: runtimeGateEnabled || isAccessGateEnabled(),
    authenticated: runtimeGateEnabled ? await isValidRuntimeSession(cookie) : await isValidSession(cookie),
  });
}

export async function POST(request: Request) {
  const body = loginSchema.parse(await request.json());
  const valid = await isValidRuntimeAccessToken(body.token);

  if (!valid) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE_NAME, await createRuntimeSessionValue(), {
    httpOnly: true,
    sameSite: "lax",
    secure: await runtimeCookieSecure(),
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
    secure: await runtimeCookieSecure(),
    path: "/",
    maxAge: 0,
  });

  return response;
}

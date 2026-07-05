import { NextResponse } from "next/server";
import { getRuntimeConfig } from "./app-config";
import { SESSION_COOKIE_NAME } from "./auth";

export async function isRuntimeAccessGateEnabled() {
  return Boolean((await getRuntimeConfig()).treeholeAccessToken);
}

export async function createRuntimeSessionValue() {
  const config = await getRuntimeConfig();
  if (!config.treeholeAccessToken) return "";

  return sha256Hex(`${config.treeholeAccessToken}:${config.treeholeSessionSecret}`);
}

export async function isValidRuntimeSession(value?: string) {
  if (!(await isRuntimeAccessGateEnabled())) return true;
  if (!value) return false;

  return value === (await createRuntimeSessionValue());
}

export async function isValidRuntimeAccessToken(value: string) {
  const token = (await getRuntimeConfig()).treeholeAccessToken;
  if (!token) return true;

  return value === token;
}

export async function runtimeCookieSecure() {
  return (await getRuntimeConfig()).treeholeCookieSecure;
}

export async function requireApiSession(request: Request) {
  const config = await getRuntimeConfig();

  if (!config.setupComplete) {
    return NextResponse.json({ error: "Setup required" }, { status: 428 });
  }

  const cookie = getSessionCookie(request);

  if (await isValidRuntimeSession(cookie)) return null;

  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

export function getSessionCookie(request: Request) {
  return request.headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${SESSION_COOKIE_NAME}=`))
    ?.split("=")[1];
}

async function sha256Hex(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);

  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

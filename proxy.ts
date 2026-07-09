import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE_NAME } from "@/lib/auth";
import {
  isRuntimeAccessGateEnabled,
  isValidRuntimeSession,
} from "@/lib/auth-runtime";

const PUBLIC_PREFIXES = ["/_next", "/api/session", "/api/setup"];
const PUBLIC_PATHS = new Set(["/login", "/setup", "/favicon.ico"]);

export async function proxy(request: NextRequest) {
  if (!(await isRuntimeAccessGateEnabled())) return NextResponse.next();

  const { pathname } = request.nextUrl;
  if (isPublicPath(pathname)) return NextResponse.next();

  const authenticated = await isValidRuntimeSession(
    request.cookies.get(SESSION_COOKIE_NAME)?.value,
  );
  if (authenticated) return NextResponse.next();

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = request.nextUrl.clone();
  url.pathname = "/login";
  url.searchParams.set("next", `${pathname}${request.nextUrl.search}`);

  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!.*\\..*).*)", "/api/:path*"],
};

function isPublicPath(pathname: string) {
  if (PUBLIC_PATHS.has(pathname)) return true;
  return PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { ChatShell } from "@/components/ChatShell";
import { isSetupComplete } from "@/lib/app-config";
import { SESSION_COOKIE_NAME } from "@/lib/auth";
import { isValidRuntimeSession } from "@/lib/auth-runtime";

export const dynamic = "force-dynamic";

export default async function Home() {
  if (!(await isSetupComplete())) redirect("/setup");
  const session = (await cookies()).get(SESSION_COOKIE_NAME)?.value;

  if (!(await isValidRuntimeSession(session))) redirect("/login");

  return <ChatShell />;
}

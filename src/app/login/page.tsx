import { redirect } from "next/navigation";
import { isSetupComplete } from "@/lib/app-config";
import { LoginForm } from "./LoginForm";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  if (!(await isSetupComplete())) redirect("/setup");

  return <LoginForm />;
}

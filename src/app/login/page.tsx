import { redirect } from "next/navigation";
import { isSetupComplete } from "@/lib/app-config";
import { LoginForm } from "./LoginForm";

export default async function LoginPage() {
  if (!(await isSetupComplete())) redirect("/setup");

  return <LoginForm />;
}

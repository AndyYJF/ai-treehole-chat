import { redirect } from "next/navigation";
import { isSetupComplete } from "@/lib/app-config";
import { SetupWizard } from "./SetupWizard";

export const dynamic = "force-dynamic";

export default async function SetupPage() {
  if (await isSetupComplete()) redirect("/login");

  return <SetupWizard />;
}

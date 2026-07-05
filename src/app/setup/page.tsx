import { redirect } from "next/navigation";
import { isSetupComplete } from "@/lib/app-config";
import { SetupWizard } from "./SetupWizard";

export default async function SetupPage() {
  if (await isSetupComplete()) redirect("/login");

  return <SetupWizard />;
}

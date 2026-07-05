import { NextResponse } from "next/server";
import { z } from "zod";
import { getRuntimeConfig, saveSetupConfig } from "@/lib/app-config";
import { getSessionCookie, isValidRuntimeSession } from "@/lib/auth-runtime";

export const runtime = "nodejs";

const setupSchema = z.object({
  treeholeAccessToken: z.string().min(8).max(200),
  treeholeSessionSecret: z.string().min(16).max(300).optional().or(z.literal("")),
  treeholeCookieSecure: z.boolean(),
  deepseekApiKey: z.string().min(8).max(300),
  deepseekBaseUrl: z.string().url().default("https://api.deepseek.com"),
  siliconFlowApiKey: z.string().max(300).optional().or(z.literal("")),
  siliconFlowBaseUrl: z.string().url().default("https://api.siliconflow.cn/v1"),
  siliconFlowRerankModel: z.string().min(1).max(120).default("Qwen/Qwen3-Reranker-0.6B"),
});

export async function GET() {
  const config = await getRuntimeConfig();

  return NextResponse.json({
    complete: config.setupComplete,
    defaults: {
      treeholeCookieSecure: config.treeholeCookieSecure,
      deepseekBaseUrl: config.deepseekBaseUrl,
      siliconFlowBaseUrl: config.siliconFlowBaseUrl,
      siliconFlowRerankModel: config.siliconFlowRerankModel,
    },
  });
}

export async function POST(request: Request) {
  const current = await getRuntimeConfig();

  if (current.setupComplete && !(await isValidRuntimeSession(getSessionCookie(request)))) {
    return NextResponse.json({ error: "Setup is already complete" }, { status: 403 });
  }

  const body = setupSchema.parse(await request.json());
  await saveSetupConfig(body);

  return NextResponse.json({ ok: true });
}

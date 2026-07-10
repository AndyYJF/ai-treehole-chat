import { NextResponse } from "next/server";
import { z } from "zod";
import { getRuntimeConfig, saveSetupConfig, updateVisionConfig } from "@/lib/app-config";
import { getSessionCookie, isValidRuntimeSession, requireApiSession } from "@/lib/auth-runtime";

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
  tavilyApiKey: z.string().max(300).optional().or(z.literal("")),
  braveSearchApiKey: z.string().max(300).optional().or(z.literal("")),
  visionApiKey: z.string().max(500).optional().or(z.literal("")),
  visionBaseUrl: z.string().url().default("https://generativelanguage.googleapis.com/v1beta/openai/"),
  visionModelName: z.string().min(1).max(160).default("gemini-3.1-pro-preview"),
  realityCountryCode: z.string().length(2).default("CN"),
});

const visionConfigSchema = z.object({
  visionApiKey: z.string().max(500).optional().or(z.literal("")),
  clearVisionApiKey: z.boolean().optional(),
  visionBaseUrl: z.string().url().default("https://generativelanguage.googleapis.com/v1beta/openai/"),
  visionModelName: z.string().min(1).max(160).default("gemini-3.1-pro-preview"),
});

export async function GET(request: Request) {
  const config = await getRuntimeConfig();
  const canReadConfig =
    !config.setupComplete || (await isValidRuntimeSession(getSessionCookie(request)));

  return NextResponse.json({
    complete: config.setupComplete,
    defaults: {
      treeholeCookieSecure: config.treeholeCookieSecure,
      deepseekBaseUrl: config.deepseekBaseUrl,
      siliconFlowBaseUrl: config.siliconFlowBaseUrl,
      siliconFlowRerankModel: config.siliconFlowRerankModel,
      visionApiKey: "",
      visionConfigured: canReadConfig && Boolean(config.visionApiKey),
      visionApiKeyHint:
        canReadConfig && config.visionApiKey ? `••••${config.visionApiKey.slice(-4)}` : "",
      visionBaseUrl: canReadConfig ? config.visionBaseUrl : "",
      visionModelName: canReadConfig ? config.visionModelName : "",
      realityCountryCode: config.realityCountryCode,
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

export async function PATCH(request: Request) {
  const unauthorized = await requireApiSession(request);
  if (unauthorized) return unauthorized;

  const body = visionConfigSchema.parse(await request.json());
  const config = await updateVisionConfig(body);

  return NextResponse.json({
    ok: true,
    defaults: {
      visionApiKey: "",
      visionConfigured: Boolean(config.visionApiKey),
      visionApiKeyHint: config.visionApiKey ? `••••${config.visionApiKey.slice(-4)}` : "",
      visionBaseUrl: config.visionBaseUrl,
      visionModelName: config.visionModelName,
    },
  });
}

import { randomBytes } from "crypto";
import { getPostgresPool } from "./postgres";

export type RuntimeConfig = {
  setupComplete: boolean;
  defaultUserId: string;
  treeholeAccessToken: string;
  treeholeSessionSecret: string;
  treeholeCookieSecure: boolean;
  deepseekApiKey: string;
  deepseekBaseUrl: string;
  siliconFlowApiKey: string;
  siliconFlowBaseUrl: string;
  siliconFlowRerankModel: string;
  tavilyApiKey: string;
  braveSearchApiKey: string;
  visionApiKey: string;
  visionBaseUrl: string;
  visionModelName: string;
  realityCountryCode: string;
};

export type SetupConfigInput = {
  treeholeAccessToken: string;
  treeholeSessionSecret?: string;
  treeholeCookieSecure: boolean;
  deepseekApiKey: string;
  deepseekBaseUrl: string;
  siliconFlowApiKey?: string;
  siliconFlowBaseUrl: string;
  siliconFlowRerankModel: string;
  tavilyApiKey?: string;
  braveSearchApiKey?: string;
  visionApiKey?: string;
  visionBaseUrl?: string;
  visionModelName?: string;
  realityCountryCode?: string;
};

export type VisionConfigInput = {
  visionApiKey?: string;
  visionBaseUrl?: string;
  visionModelName?: string;
};

const configKeys = [
  "setupComplete",
  "treeholeAccessToken",
  "treeholeSessionSecret",
  "treeholeCookieSecure",
  "deepseekApiKey",
  "deepseekBaseUrl",
  "siliconFlowApiKey",
  "siliconFlowBaseUrl",
  "siliconFlowRerankModel",
  "tavilyApiKey",
  "braveSearchApiKey",
  "visionApiKey",
  "visionBaseUrl",
  "visionModelName",
  "realityCountryCode",
] as const;

type ConfigKey = (typeof configKeys)[number];

const inMemoryConfig = new Map<ConfigKey, string>();
let schemaReady: Promise<void> | null = null;

export async function getRuntimeConfig(): Promise<RuntimeConfig> {
  const stored = await readStoredConfig();
  const treeholeAccessToken = process.env.TREEHOLE_ACCESS_TOKEN ?? stored.treeholeAccessToken ?? "";
  const treeholeSessionSecret =
    process.env.TREEHOLE_SESSION_SECRET ?? stored.treeholeSessionSecret ?? treeholeAccessToken;
  const deepseekApiKey = process.env.DEEPSEEK_API_KEY ?? stored.deepseekApiKey ?? "";

  return {
    setupComplete: hasEnvSetup() || stored.setupComplete === "true",
    defaultUserId: process.env.DEFAULT_USER_ID ?? "single-user",
    treeholeAccessToken,
    treeholeSessionSecret,
    treeholeCookieSecure: parseBoolean(process.env.TREEHOLE_COOKIE_SECURE ?? stored.treeholeCookieSecure),
    deepseekApiKey,
    deepseekBaseUrl: process.env.DEEPSEEK_BASE_URL ?? stored.deepseekBaseUrl ?? "https://api.deepseek.com",
    siliconFlowApiKey: process.env.SILICONFLOW_API_KEY ?? stored.siliconFlowApiKey ?? "",
    siliconFlowBaseUrl:
      process.env.SILICONFLOW_BASE_URL ?? stored.siliconFlowBaseUrl ?? "https://api.siliconflow.cn/v1",
    siliconFlowRerankModel:
      process.env.SILICONFLOW_RERANK_MODEL ??
      stored.siliconFlowRerankModel ??
      "Qwen/Qwen3-Reranker-0.6B",
    tavilyApiKey: process.env.TAVILY_API_KEY ?? stored.tavilyApiKey ?? "",
    braveSearchApiKey: process.env.BRAVE_SEARCH_API_KEY ?? stored.braveSearchApiKey ?? "",
    visionApiKey: process.env.VISION_API_KEY ?? stored.visionApiKey ?? "",
    visionBaseUrl:
      process.env.VISION_BASE_URL ??
      stored.visionBaseUrl ??
      "https://generativelanguage.googleapis.com/v1beta/openai/",
    visionModelName: process.env.VISION_MODEL_NAME ?? stored.visionModelName ?? "gemini-3.1-pro-preview",
    realityCountryCode: process.env.REALITY_COUNTRY_CODE ?? stored.realityCountryCode ?? "CN",
  };
}

export async function isSetupComplete() {
  return (await getRuntimeConfig()).setupComplete;
}

export async function saveSetupConfig(input: SetupConfigInput) {
  const values: Record<ConfigKey, string> = {
    setupComplete: "true",
    treeholeAccessToken: input.treeholeAccessToken.trim(),
    treeholeSessionSecret: (input.treeholeSessionSecret?.trim() || randomSecret()).trim(),
    treeholeCookieSecure: String(input.treeholeCookieSecure),
    deepseekApiKey: input.deepseekApiKey.trim(),
    deepseekBaseUrl: input.deepseekBaseUrl.trim() || "https://api.deepseek.com",
    siliconFlowApiKey: input.siliconFlowApiKey?.trim() ?? "",
    siliconFlowBaseUrl: input.siliconFlowBaseUrl.trim() || "https://api.siliconflow.cn/v1",
    siliconFlowRerankModel: input.siliconFlowRerankModel.trim() || "Qwen/Qwen3-Reranker-0.6B",
    tavilyApiKey: input.tavilyApiKey?.trim() ?? "",
    braveSearchApiKey: input.braveSearchApiKey?.trim() ?? "",
    visionApiKey: input.visionApiKey?.trim() ?? "",
    visionBaseUrl:
      input.visionBaseUrl?.trim() || "https://generativelanguage.googleapis.com/v1beta/openai/",
    visionModelName: input.visionModelName?.trim() || "gemini-3.1-pro-preview",
    realityCountryCode: input.realityCountryCode?.trim().toUpperCase() || "CN",
  };

  const pool = getPostgresPool();

  if (!pool) {
    for (const key of configKeys) {
      inMemoryConfig.set(key, values[key]);
    }
    return getRuntimeConfig();
  }

  await ensureConfigSchema();

  for (const key of configKeys) {
    await pool.query(
      `insert into app_config (key, value, updated_at)
      values ($1, $2, now())
      on conflict (key)
      do update set value = excluded.value, updated_at = now()`,
      [key, values[key]],
    );
  }

  return getRuntimeConfig();
}

export async function updateVisionConfig(input: VisionConfigInput) {
  const values: Pick<Record<ConfigKey, string>, "visionApiKey" | "visionBaseUrl" | "visionModelName"> = {
    visionApiKey: input.visionApiKey?.trim() ?? "",
    visionBaseUrl:
      input.visionBaseUrl?.trim() || "https://generativelanguage.googleapis.com/v1beta/openai/",
    visionModelName: input.visionModelName?.trim() || "gemini-3.1-pro-preview",
  };

  const pool = getPostgresPool();

  if (!pool) {
    for (const [key, value] of Object.entries(values) as Array<[keyof typeof values, string]>) {
      inMemoryConfig.set(key, value);
    }
    return getRuntimeConfig();
  }

  await ensureConfigSchema();

  for (const [key, value] of Object.entries(values)) {
    await pool.query(
      `insert into app_config (key, value, updated_at)
      values ($1, $2, now())
      on conflict (key)
      do update set value = excluded.value, updated_at = now()`,
      [key, value],
    );
  }

  return getRuntimeConfig();
}

async function readStoredConfig(): Promise<Partial<Record<ConfigKey, string>>> {
  const pool = getPostgresPool();

  if (!pool) {
    return Object.fromEntries(inMemoryConfig) as Partial<Record<ConfigKey, string>>;
  }

  await ensureConfigSchema();

  const { rows } = await pool.query("select key, value from app_config");
  const config: Partial<Record<ConfigKey, string>> = {};

  for (const row of rows) {
    const key = row.key;
    if (isConfigKey(key)) config[key] = String(row.value ?? "");
  }

  return config;
}

async function ensureConfigSchema() {
  const pool = getPostgresPool();
  if (!pool) return;

  schemaReady ??= pool.query(`
    create table if not exists app_config (
      key text primary key,
      value text not null,
      updated_at timestamptz not null default now()
    );
  `).then(() => undefined);

  await schemaReady;
}

function hasEnvSetup() {
  return Boolean(process.env.TREEHOLE_ACCESS_TOKEN && process.env.DEEPSEEK_API_KEY);
}

function isConfigKey(value: unknown): value is ConfigKey {
  return typeof value === "string" && configKeys.includes(value as ConfigKey);
}

function parseBoolean(value: string | undefined) {
  return value === "true";
}

function randomSecret() {
  return randomBytes(32).toString("hex");
}

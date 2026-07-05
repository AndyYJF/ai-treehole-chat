import { randomUUID } from "crypto";
import { getPostgresPool } from "./postgres";

export type ModelUsage = {
  promptTokens?: number | null;
  completionTokens?: number | null;
  totalTokens?: number | null;
  promptCacheHitTokens?: number | null;
  promptCacheMissTokens?: number | null;
  reasoningTokens?: number | null;
};

export type ModelUsageRecord = {
  id: string;
  userId: string;
  provider: string;
  operation: string;
  model: string;
  streamed: boolean;
  success: boolean;
  statusCode: number | null;
  latencyMs: number;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  promptCacheHitTokens: number | null;
  promptCacheMissTokens: number | null;
  reasoningTokens: number | null;
  errorMessage: string | null;
  createdAt: string;
};

export type ModelUsageSummary = {
  requestCount: number;
  successCount: number;
  failureCount: number;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  promptCacheHitTokens: number;
  promptCacheMissTokens: number;
  cacheHitRate: number | null;
  averageLatencyMs: number | null;
};

const inMemoryUsage = new Map<string, ModelUsageRecord[]>();
let schemaReady: Promise<void> | null = null;

export async function recordModelUsage(
  input: Omit<ModelUsageRecord, "id" | "createdAt">,
): Promise<void> {
  const record: ModelUsageRecord = {
    ...input,
    id: `usage-${randomUUID()}`,
    createdAt: new Date().toISOString(),
  };
  const pool = getPostgresPool();

  if (!pool) {
    const current = inMemoryUsage.get(record.userId) ?? [];
    inMemoryUsage.set(record.userId, [...current, record].slice(-500));
    return;
  }

  await ensureModelUsageSchema();
  await pool.query(
    `insert into model_usage_events (
      id, user_id, provider, operation, model, streamed, success, status_code, latency_ms,
      prompt_tokens, completion_tokens, total_tokens, prompt_cache_hit_tokens,
      prompt_cache_miss_tokens, reasoning_tokens, error_message, created_at
    )
    values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
    [
      record.id,
      record.userId,
      record.provider,
      record.operation,
      record.model,
      record.streamed,
      record.success,
      record.statusCode,
      record.latencyMs,
      record.promptTokens,
      record.completionTokens,
      record.totalTokens,
      record.promptCacheHitTokens,
      record.promptCacheMissTokens,
      record.reasoningTokens,
      record.errorMessage,
      record.createdAt,
    ],
  );
}

export async function listModelUsage(userId: string, limit = 30): Promise<ModelUsageRecord[]> {
  const pool = getPostgresPool();

  if (!pool) {
    return [...(inMemoryUsage.get(userId) ?? [])].slice(-limit).reverse();
  }

  await ensureModelUsageSchema();
  const { rows } = await pool.query(
    `select id, user_id, provider, operation, model, streamed, success, status_code, latency_ms,
      prompt_tokens, completion_tokens, total_tokens, prompt_cache_hit_tokens,
      prompt_cache_miss_tokens, reasoning_tokens, error_message, created_at
    from model_usage_events
    where user_id = $1
    order by created_at desc
    limit $2`,
    [userId, limit],
  );

  return rows.map(usageFromRow);
}

export async function getModelUsageSummary(userId: string): Promise<ModelUsageSummary> {
  const pool = getPostgresPool();

  if (!pool) {
    return summarizeUsage(inMemoryUsage.get(userId) ?? []);
  }

  await ensureModelUsageSchema();
  const { rows } = await pool.query(
    `select
      count(*)::int as request_count,
      count(*) filter (where success)::int as success_count,
      count(*) filter (where not success)::int as failure_count,
      coalesce(sum(total_tokens), 0)::int as total_tokens,
      coalesce(sum(prompt_tokens), 0)::int as prompt_tokens,
      coalesce(sum(completion_tokens), 0)::int as completion_tokens,
      coalesce(sum(prompt_cache_hit_tokens), 0)::int as prompt_cache_hit_tokens,
      coalesce(sum(prompt_cache_miss_tokens), 0)::int as prompt_cache_miss_tokens,
      avg(latency_ms)::float as average_latency_ms
    from model_usage_events
    where user_id = $1`,
    [userId],
  );
  const row = rows[0] ?? {};
  const hit = Number(row.prompt_cache_hit_tokens ?? 0);
  const miss = Number(row.prompt_cache_miss_tokens ?? 0);

  return {
    requestCount: Number(row.request_count ?? 0),
    successCount: Number(row.success_count ?? 0),
    failureCount: Number(row.failure_count ?? 0),
    totalTokens: Number(row.total_tokens ?? 0),
    promptTokens: Number(row.prompt_tokens ?? 0),
    completionTokens: Number(row.completion_tokens ?? 0),
    promptCacheHitTokens: hit,
    promptCacheMissTokens: miss,
    cacheHitRate: hit + miss > 0 ? hit / (hit + miss) : null,
    averageLatencyMs: row.average_latency_ms == null ? null : Number(row.average_latency_ms),
  };
}

export async function clearModelUsage(userId: string): Promise<ModelUsageSummary> {
  const pool = getPostgresPool();

  if (!pool) {
    inMemoryUsage.set(userId, []);
    return summarizeUsage([]);
  }

  await ensureModelUsageSchema();
  await pool.query("delete from model_usage_events where user_id = $1", [userId]);
  return getModelUsageSummary(userId);
}

export function normalizeUsage(value: unknown): ModelUsage {
  if (!value || typeof value !== "object") return {};

  const usage = value as Record<string, unknown>;
  const details = usage.completion_tokens_details as Record<string, unknown> | undefined;

  return {
    promptTokens: toOptionalNumber(usage.prompt_tokens),
    completionTokens: toOptionalNumber(usage.completion_tokens),
    totalTokens: toOptionalNumber(usage.total_tokens),
    promptCacheHitTokens: toOptionalNumber(usage.prompt_cache_hit_tokens),
    promptCacheMissTokens: toOptionalNumber(usage.prompt_cache_miss_tokens),
    reasoningTokens: toOptionalNumber(details?.reasoning_tokens),
  };
}

async function ensureModelUsageSchema() {
  const pool = getPostgresPool();
  if (!pool) return;

  schemaReady ??= pool.query(`
    create table if not exists model_usage_events (
      id text primary key,
      user_id text not null,
      provider text not null,
      operation text not null,
      model text not null,
      streamed boolean not null default false,
      success boolean not null,
      status_code integer,
      latency_ms integer not null,
      prompt_tokens integer,
      completion_tokens integer,
      total_tokens integer,
      prompt_cache_hit_tokens integer,
      prompt_cache_miss_tokens integer,
      reasoning_tokens integer,
      error_message text,
      created_at timestamptz not null default now()
    );

    create index if not exists model_usage_events_user_created_idx
      on model_usage_events (user_id, created_at desc);
  `).then(() => undefined);

  await schemaReady;
}

function usageFromRow(row: Record<string, unknown>): ModelUsageRecord {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    provider: String(row.provider),
    operation: String(row.operation),
    model: String(row.model),
    streamed: Boolean(row.streamed),
    success: Boolean(row.success),
    statusCode: toNullableNumber(row.status_code),
    latencyMs: Number(row.latency_ms),
    promptTokens: toNullableNumber(row.prompt_tokens),
    completionTokens: toNullableNumber(row.completion_tokens),
    totalTokens: toNullableNumber(row.total_tokens),
    promptCacheHitTokens: toNullableNumber(row.prompt_cache_hit_tokens),
    promptCacheMissTokens: toNullableNumber(row.prompt_cache_miss_tokens),
    reasoningTokens: toNullableNumber(row.reasoning_tokens),
    errorMessage: row.error_message == null ? null : String(row.error_message),
    createdAt: new Date(String(row.created_at)).toISOString(),
  };
}

function summarizeUsage(records: ModelUsageRecord[]): ModelUsageSummary {
  const successCount = records.filter((record) => record.success).length;
  const hit = sum(records, "promptCacheHitTokens");
  const miss = sum(records, "promptCacheMissTokens");

  return {
    requestCount: records.length,
    successCount,
    failureCount: records.length - successCount,
    totalTokens: sum(records, "totalTokens"),
    promptTokens: sum(records, "promptTokens"),
    completionTokens: sum(records, "completionTokens"),
    promptCacheHitTokens: hit,
    promptCacheMissTokens: miss,
    cacheHitRate: hit + miss > 0 ? hit / (hit + miss) : null,
    averageLatencyMs:
      records.length > 0
        ? records.reduce((total, record) => total + record.latencyMs, 0) / records.length
        : null,
  };
}

function sum(records: ModelUsageRecord[], key: keyof ModelUsageRecord): number {
  return records.reduce((total, record) => total + Number(record[key] ?? 0), 0);
}

function toOptionalNumber(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function toNullableNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

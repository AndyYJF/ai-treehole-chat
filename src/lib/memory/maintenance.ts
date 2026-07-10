import { getMemoryRepository } from "./repository";
import { getPostgresPool } from "../postgres";
import { randomUUID } from "crypto";

const defaultMaintenanceIntervalMs = 6 * 60 * 60 * 1000;
const runningUsers = new Set<string>();
let jobSchemaReady: Promise<void> | null = null;

export async function maybeMaintainMemories(input: {
  userId: string;
  force?: boolean;
  intervalMs?: number;
}) {
  if (runningUsers.has(input.userId)) return;

  runningUsers.add(input.userId);

  try {
    const pool = getPostgresPool();
    if (pool) {
      await ensureJobSchema();
      const intervalMs = input.intervalMs ?? defaultMaintenanceIntervalMs;
      const dedupeKey = String(Math.floor(Date.now() / (input.force ? Math.min(intervalMs, 10 * 60 * 1000) : intervalMs)));
      await pool.query(
        `insert into background_jobs (id, user_id, kind, dedupe_key, status, attempts, run_after, created_at, updated_at)
        values ($1, $2, 'memory_maintenance', $3, 'queued', 0, now(), now(), now())
        on conflict (user_id, kind, dedupe_key) do nothing`,
        [`job-${randomUUID()}`, input.userId, dedupeKey],
      );

      const { rows } = await pool.query(
        `with candidate as (
          select id
          from background_jobs
          where user_id = $1
            and kind = 'memory_maintenance'
            and run_after <= now()
            and (status = 'queued' or (status = 'running' and updated_at < now() - interval '15 minutes'))
          order by created_at asc
          for update skip locked
          limit 1
        )
        update background_jobs jobs
        set status = 'running', attempts = attempts + 1, updated_at = now(), last_error = null
        from candidate
        where jobs.id = candidate.id
        returning jobs.id, jobs.attempts`,
        [input.userId],
      );
      const job = rows[0];
      if (!job) return;

      try {
        await getMemoryRepository().maintainMemories(input.userId);
        await pool.query(
          `update background_jobs
          set status = 'completed', completed_at = now(), updated_at = now(), last_error = null
          where id = $1`,
          [job.id],
        );
      } catch (error) {
        const retryAfterSeconds = Math.min(60 * 60, 30 * 2 ** Math.min(Number(job.attempts), 7));
        await pool.query(
          `update background_jobs
          set status = 'queued', run_after = now() + ($2::text || ' seconds')::interval,
            updated_at = now(), last_error = $3
          where id = $1`,
          [job.id, retryAfterSeconds, normalizeJobError(error)],
        );
      }
      return;
    }

    // Local development without Postgres keeps the same best-effort behavior.
    const repository = getMemoryRepository();
    await repository.maintainMemories(input.userId);
  } catch {
    // Callers stay usable; Postgres-backed jobs retain retry state above.
  } finally {
    runningUsers.delete(input.userId);
  }
}

async function ensureJobSchema() {
  const pool = getPostgresPool();
  if (!pool) return;

  jobSchemaReady ??= pool.query(`
    create table if not exists background_jobs (
      id text primary key,
      user_id text not null,
      kind text not null,
      dedupe_key text not null,
      status text not null check (status in ('queued', 'running', 'completed')),
      attempts integer not null default 0,
      run_after timestamptz not null default now(),
      last_error text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      completed_at timestamptz,
      unique (user_id, kind, dedupe_key)
    );

    create index if not exists background_jobs_pending_idx
      on background_jobs (user_id, kind, status, run_after asc);
  `).then(() => undefined);

  await jobSchemaReady;
}

function normalizeJobError(error: unknown) {
  const message = error instanceof Error ? error.message : "Unknown maintenance failure";
  return message.slice(0, 500);
}

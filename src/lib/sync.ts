import { getPostgresPool } from "./postgres";

export const syncEntities = ["thread", "message", "memory", "memory_settings", "letter", "usage"] as const;

export type SyncEntity = (typeof syncEntities)[number];
export type SyncOperation = "upsert" | "delete";

export type SyncChange = {
  cursor: string;
  entity: SyncEntity;
  entityId: string;
  operation: SyncOperation;
  occurredAt: string;
};

let schemaReady: Promise<void> | null = null;
const triggerReady = new Map<string, Promise<void>>();

/**
 * The change log is intentionally append-only. Clients use its monotonically
 * increasing cursor to discover changes made by another browser/device, while
 * ordinary API responses remain the source of full entity payloads.
 */
export async function ensureSyncSchema() {
  const pool = getPostgresPool();
  if (!pool) return false;

  schemaReady ??= pool
    .query(`
      create table if not exists sync_changes (
        sequence bigserial primary key,
        user_id text not null,
        entity text not null check (entity in ('thread', 'message', 'memory', 'memory_settings', 'letter', 'usage')),
        entity_id text not null,
        operation text not null check (operation in ('upsert', 'delete')),
        occurred_at timestamptz not null default now()
      );

      create index if not exists sync_changes_user_sequence_idx
        on sync_changes (user_id, sequence asc);

      create or replace function treehole_record_sync_change()
      returns trigger
      language plpgsql
      as $$
      declare
        row_data jsonb;
        row_id text;
      begin
        row_data := case when TG_OP = 'DELETE' then to_jsonb(OLD) else to_jsonb(NEW) end;
        row_id := coalesce(row_data->>'id', row_data->>'user_id');

        if row_data->>'user_id' is not null and row_id is not null then
          insert into sync_changes (user_id, entity, entity_id, operation, occurred_at)
          values (
            row_data->>'user_id',
            TG_ARGV[0],
            row_id,
            case when TG_OP = 'DELETE' then 'delete' else 'upsert' end,
            now()
          );
        end if;

        if TG_OP = 'DELETE' then return OLD; end if;
        return NEW;
      end;
      $$;

      alter table sync_changes drop constraint if exists sync_changes_entity_check;
      alter table sync_changes add constraint sync_changes_entity_check
        check (entity in ('thread', 'message', 'memory', 'memory_settings', 'letter', 'usage'));
    `)
    .then(() => undefined);

  await schemaReady;
  return true;
}

export async function ensureSyncTrigger(table: "chat_threads" | "chat_messages" | "memories" | "user_memory_settings" | "timebox_letters" | "model_usage_events", entity: SyncEntity) {
  const pool = getPostgresPool();
  if (!pool) return;

  await ensureSyncSchema();
  const key = `${table}:${entity}`;
  const existing = triggerReady.get(key);
  if (existing) return existing;

  const install = (async () => {
    const triggerName = `treehole_${table}_sync_change`;
    await pool.query(`drop trigger if exists ${triggerName} on ${table}`);
    await pool.query(`
      create trigger ${triggerName}
      after insert or update or delete on ${table}
      for each row execute function treehole_record_sync_change('${entity}')
    `);
  })();
  triggerReady.set(key, install);

  try {
    await install;
  } catch (error) {
    triggerReady.delete(key);
    throw error;
  }
}

export async function getLatestSyncCursor(userId: string): Promise<string> {
  const pool = getPostgresPool();
  if (!pool) return "0";
  await ensureSyncSchema();

  const { rows } = await pool.query(
    "select coalesce(max(sequence), 0)::text as cursor from sync_changes where user_id = $1",
    [userId],
  );
  return String(rows[0]?.cursor ?? "0");
}

export async function listSyncChanges(userId: string, afterCursor: string, limit = 200): Promise<{
  changes: SyncChange[];
  hasMore: boolean;
  cursor: string;
}> {
  const pool = getPostgresPool();
  if (!pool) return { changes: [], hasMore: false, cursor: "0" };
  await ensureSyncSchema();

  const parsedCursor = parseCursor(afterCursor);
  const safeLimit = Math.max(1, Math.min(limit, 500));
  const { rows } = await pool.query(
    `select sequence, entity, entity_id, operation, occurred_at
    from sync_changes
    where user_id = $1 and sequence > $2
    order by sequence asc
    limit $3`,
    [userId, parsedCursor, safeLimit + 1],
  );
  const hasMore = rows.length > safeLimit;
  const visibleRows = rows.slice(0, safeLimit);
  const cursor = visibleRows.length > 0
    ? String(visibleRows[visibleRows.length - 1].sequence)
    : String(parsedCursor);

  return {
    changes: visibleRows.map((row) => ({
      cursor: String(row.sequence),
      entity: row.entity as SyncEntity,
      entityId: String(row.entity_id),
      operation: row.operation as SyncOperation,
      occurredAt: new Date(String(row.occurred_at)).toISOString(),
    })),
    hasMore,
    cursor,
  };
}

export function parseCursor(value: string | null | undefined) {
  if (!value || !/^\d+$/.test(value)) return "0";
  const normalized = value.replace(/^0+(?=\d)/, "");
  return normalized || "0";
}

export function compareSyncCursors(left: string, right: string) {
  const normalizedLeft = parseCursor(left);
  const normalizedRight = parseCursor(right);
  if (normalizedLeft.length !== normalizedRight.length) {
    return normalizedLeft.length - normalizedRight.length;
  }
  return normalizedLeft.localeCompare(normalizedRight);
}

export function hasPostgresSync() {
  return Boolean(getPostgresPool());
}

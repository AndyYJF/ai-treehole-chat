import { randomUUID } from "crypto";
import type { PoolClient } from "pg";
import { getPostgresPool } from "../postgres";
import { ensureSyncTrigger } from "../sync";
import { SyncConflictError } from "../sync-conflict";
import type { MemoryCandidate, MemoryRecord } from "./types";
import { findMergeTarget, maintainMemoryRecords, mergeMemoryRecord } from "./merge";
import { sortMemoryForPrompt } from "./store";
import type { MemoryRepository } from "./repository";

let schemaReady: Promise<void> | null = null;

const baselineMemories: Array<Omit<MemoryRecord, "id" | "userId" | "revision" | "createdAt" | "lastSeenAt">> = [
  {
    type: "procedural",
    content: "用户偏好安静、少说教、先回应感受，再给选择。",
    confidence: 0.82,
    importance: 86,
    sensitivity: "normal",
    sourceMessageIds: [],
    userConfirmed: true,
    validFrom: null,
    validUntil: null,
  },
  {
    type: "boundary",
    content: "不要把普通倾诉立刻上升成诊断或命令式建议。",
    confidence: 0.8,
    importance: 78,
    sensitivity: "normal",
    sourceMessageIds: [],
    userConfirmed: true,
    validFrom: null,
    validUntil: null,
  },
];

export function createPostgresMemoryRepository(connectionString: string): MemoryRepository {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? connectionString;

  return {
    async listMemories(userId) {
      await ensureInitialized(userId);

      const pool = getPostgresPool();
      if (!pool) return [];

      const { rows } = await pool.query(
        `select id, user_id, type, content, confidence, importance, sensitivity, source_message_ids,
          user_confirmed, revision, valid_from, valid_until, created_at, last_seen_at
        from memories
        where user_id = $1
          and (valid_from is null or valid_from <= now())
          and (valid_until is null or valid_until > now())`,
        [userId],
      );

      return rows.map(memoryFromRow).sort(sortMemoryForPrompt);
    },

    async listAllMemories(userId) {
      await ensureInitialized(userId);

      const pool = getPostgresPool();
      if (!pool) return [];

      const { rows } = await pool.query(
        `select id, user_id, type, content, confidence, importance, sensitivity, source_message_ids,
          user_confirmed, revision, valid_from, valid_until, created_at, last_seen_at
        from memories
        where user_id = $1`,
        [userId],
      );

      return rows.map(memoryFromRow).sort(sortMemoryForPrompt);
    },

    async addMemoryCandidates(userId, candidates) {
      await ensureInitialized(userId);
      if (candidates.length === 0) return this.listMemories(userId);

      await withTransaction(async (client) => {
        for (const candidate of candidates) {
          await upsertMemoryCandidate(client, userId, candidate);
        }
      });

      return this.listMemories(userId);
    },

    async updateMemory(userId, memoryId, update, expectedRevision) {
      await ensureInitialized(userId);

      const pool = getPostgresPool();
      if (!pool) return this.listMemories(userId);

      await withTransaction(async (client) => {
        await updateMemoryRecord(client, userId, memoryId, update, expectedRevision);
      });

      return this.listMemories(userId);
    },

    async deleteMemory(userId, memoryId, expectedRevision) {
      await ensureInitialized(userId);
      const pool = getPostgresPool();
      if (!pool) return this.listMemories(userId);

      const result = await pool.query(
        `delete from memories
        where user_id = $1 and id = $2
          and ($3::integer is null or revision = $3)`,
        [userId, memoryId, expectedRevision ?? null],
      );
      if (expectedRevision != null && result.rowCount === 0) throw new SyncConflictError();
      return this.listMemories(userId);
    },

    async clearMemories(userId) {
      await ensureInitialized(userId);
      const pool = getPostgresPool();
      if (!pool) return [];

      await pool.query("delete from memories where user_id = $1", [userId]);
      return [];
    },

    async maintainMemories(userId) {
      await ensureInitialized(userId);

      await withTransaction(async (client) => {
        const existing = await listValidMemories(client, userId);
        const maintained = maintainMemoryRecords(existing);
        const maintainedIds = new Set(maintained.map((memory) => memory.id));

        for (const memory of maintained) {
          const original = existing.find((item) => item.id === memory.id);
          if (original && memoryHasSamePersistence(original, memory)) continue;
          await writeMergedMemory(client, userId, memory);
        }

        for (const memory of existing) {
          if (maintainedIds.has(memory.id)) continue;
          await client.query("delete from memories where user_id = $1 and id = $2", [userId, memory.id]);
        }

        // Expired records are excluded from retrieval, but remain exportable and
        // auditable. A maintenance pass must not erase user data by itself.
      });

      return this.listMemories(userId);
    },

    async getMemorySettings(userId) {
      await ensureInitialized(userId);

      const pool = getPostgresPool();
      if (!pool) return { enabled: true, revision: 1 };

      const { rows } = await pool.query("select enabled, revision from user_memory_settings where user_id = $1", [userId]);
      return { enabled: rows[0]?.enabled ?? true, revision: Number(rows[0]?.revision ?? 1) };
    },

    async setMemoryEnabled(userId, enabled, expectedRevision) {
      await ensureInitialized(userId);

      const pool = getPostgresPool();
      if (!pool) return { enabled, revision: 1 };

      const { rows } = await pool.query(
        `insert into user_memory_settings (user_id, enabled, revision, updated_at)
        values ($1, $2, 1, now())
        on conflict (user_id)
        do update set enabled = excluded.enabled, revision = user_memory_settings.revision + 1, updated_at = now()
        where $3::integer is null or user_memory_settings.revision = $3
        returning enabled, revision`,
        [userId, enabled, expectedRevision ?? null],
      );
      if (expectedRevision != null && rows.length === 0) throw new SyncConflictError();

      return { enabled: rows[0]?.enabled ?? enabled, revision: Number(rows[0]?.revision ?? 1) };
    },
  };
}

async function ensureInitialized(userId: string) {
  schemaReady ??= ensureSchema();
  await schemaReady;

  const pool = getPostgresPool();
  if (!pool) return;

  const { rows } = await pool.query(
    `insert into user_memory_settings (user_id, enabled, updated_at)
    values ($1, true, now())
    on conflict (user_id) do nothing
    returning user_id`,
    [userId],
  );

  if (rows.length === 0) return;

  await withTransaction(async (client) => {
    for (const memory of baselineMemories) {
      await client.query(
        `insert into memories (
          id, user_id, type, content, confidence, importance, sensitivity,
          source_message_ids, user_confirmed, valid_from, valid_until, created_at, last_seen_at
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now(), now())
        on conflict (user_id, type, content) do nothing`,
        [
          `seed-${memory.type}-${randomUUID()}`,
          userId,
          memory.type,
          memory.content,
          memory.confidence,
          memory.importance,
          memory.sensitivity,
          JSON.stringify(memory.sourceMessageIds),
          memory.userConfirmed,
          memory.validFrom,
          memory.validUntil,
        ],
      );
    }
  });
}

async function ensureSchema() {
  const pool = getPostgresPool();
  if (!pool) return;

  await pool.query(`
    create table if not exists user_memory_settings (
      user_id text primary key,
      enabled boolean not null default true,
      revision integer not null default 1,
      updated_at timestamptz not null default now()
    );

    create table if not exists memories (
      id text primary key,
      user_id text not null,
      type text not null check (type in ('semantic', 'episodic', 'procedural', 'affect', 'safety', 'preference', 'boundary')),
      content text not null,
      confidence double precision not null default 0.6,
      importance integer not null default 50,
      sensitivity text not null default 'normal' check (sensitivity in ('normal', 'sensitive', 'private')),
      source_message_ids jsonb not null default '[]'::jsonb,
      user_confirmed boolean not null default true,
      revision integer not null default 1,
      valid_from timestamptz,
      valid_until timestamptz,
      created_at timestamptz not null default now(),
      last_seen_at timestamptz not null default now()
    );

    alter table user_memory_settings add column if not exists revision integer not null default 1;
    alter table memories add column if not exists revision integer not null default 1;
    alter table memories alter column user_confirmed set default true;
    update memories
    set user_confirmed = true, revision = revision + 1
    where user_confirmed = false;

    create unique index if not exists memories_user_type_content_key
      on memories (user_id, type, content);

    create index if not exists memories_user_valid_idx
      on memories (user_id, valid_until, importance desc, last_seen_at desc);
  `);

  await Promise.all([
    ensureSyncTrigger("memories", "memory"),
    ensureSyncTrigger("user_memory_settings", "memory_settings"),
  ]);
}

async function upsertMemoryCandidate(client: PoolClient, userId: string, candidate: MemoryCandidate) {
  const now = new Date().toISOString();
  const existing = await listValidMemories(client, userId);
  const target = findMergeTarget(existing, candidate);
  const incoming = memoryRecordFromCandidate(userId, candidate, now);

  if (target) {
    await writeMergedMemory(client, userId, mergeMemoryRecord(target, incoming));
    return;
  }

  await client.query(
    `insert into memories (
      id, user_id, type, content, confidence, importance, sensitivity,
      source_message_ids, user_confirmed, valid_from, valid_until, created_at, last_seen_at
    )
    values ($1, $2, $3, $4, $5, $6, $7, $8, true, $9, $10, $11, $12)
    on conflict (user_id, type, content)
    do update set
      confidence = greatest(memories.confidence, excluded.confidence),
      importance = greatest(memories.importance, excluded.importance),
      sensitivity = case
        when memories.sensitivity = 'private' or excluded.sensitivity = 'private' then 'private'
        when memories.sensitivity = 'sensitive' or excluded.sensitivity = 'sensitive' then 'sensitive'
        else 'normal'
      end,
      source_message_ids = (
        select coalesce(jsonb_agg(distinct value), '[]'::jsonb)
        from jsonb_array_elements_text(memories.source_message_ids || excluded.source_message_ids) as source(value)
      ),
      user_confirmed = memories.user_confirmed or excluded.user_confirmed,
      revision = memories.revision + 1,
      valid_from = coalesce(least(memories.valid_from, excluded.valid_from), memories.valid_from, excluded.valid_from),
      valid_until = excluded.valid_until,
      last_seen_at = excluded.last_seen_at`,
    [
      incoming.id,
      userId,
      incoming.type,
      incoming.content,
      incoming.confidence,
      incoming.importance,
      incoming.sensitivity,
      JSON.stringify(incoming.sourceMessageIds),
      incoming.validFrom,
      incoming.validUntil,
      incoming.createdAt,
      incoming.lastSeenAt,
    ],
  );
}

async function updateMemoryRecord(
  client: PoolClient,
  userId: string,
  memoryId: string,
  update: Pick<MemoryRecord, "type" | "content" | "importance" | "sensitivity">,
  expectedRevision?: number,
) {
  const existing = await listValidMemories(client, userId);
  const current = existing.find((memory) => memory.id === memoryId);
  if (!current) return;
  if (expectedRevision != null && current.revision !== expectedRevision) throw new SyncConflictError();

  const now = new Date().toISOString();
  const incoming: MemoryRecord = {
    ...current,
    type: update.type,
    content: update.content.trim(),
    importance: update.importance,
    sensitivity: update.sensitivity,
    confidence: Math.max(current.confidence, 0.9),
    userConfirmed: true,
    lastSeenAt: now,
  };
  const target = findMergeTarget(existing, incoming, memoryId);

  if (target) {
    await writeMergedMemory(client, userId, mergeMemoryRecord(target, incoming));
    const deleted = await client.query(
      `delete from memories
      where user_id = $1 and id = $2
        and ($3::integer is null or revision = $3)`,
      [userId, memoryId, expectedRevision ?? null],
    );
    if (expectedRevision != null && deleted.rowCount === 0) throw new SyncConflictError();
    return;
  }

  const updated = await client.query(
    `update memories
    set type = $3,
      content = $4,
      importance = $5,
      sensitivity = $6,
      user_confirmed = true,
      confidence = greatest(confidence, 0.9),
      revision = revision + 1,
      last_seen_at = now()
    where user_id = $1 and id = $2
      and ($7::integer is null or revision = $7)`,
    [userId, memoryId, incoming.type, incoming.content, incoming.importance, incoming.sensitivity, expectedRevision ?? null],
  );
  if (expectedRevision != null && updated.rowCount === 0) throw new SyncConflictError();
}

async function listValidMemories(client: PoolClient, userId: string): Promise<MemoryRecord[]> {
  const { rows } = await client.query(
    `select id, user_id, type, content, confidence, importance, sensitivity, source_message_ids,
      user_confirmed, revision, valid_from, valid_until, created_at, last_seen_at
    from memories
    where user_id = $1
      and (valid_from is null or valid_from <= now())
      and (valid_until is null or valid_until > now())`,
    [userId],
  );

  return rows.map(memoryFromRow);
}

async function writeMergedMemory(client: PoolClient, userId: string, memory: MemoryRecord) {
  await client.query(
    `update memories
    set type = $3,
      content = $4,
      confidence = $5,
      importance = $6,
      sensitivity = $7,
      source_message_ids = $8,
      user_confirmed = true,
      revision = revision + 1,
      valid_from = $9,
      valid_until = $10,
      created_at = $11,
      last_seen_at = $12
    where user_id = $1 and id = $2`,
    [
      userId,
      memory.id,
      memory.type,
      memory.content.trim(),
      memory.confidence,
      memory.importance,
      memory.sensitivity,
      JSON.stringify(memory.sourceMessageIds),
      memory.validFrom,
      memory.validUntil,
      memory.createdAt,
      memory.lastSeenAt,
    ],
  );
}

function memoryRecordFromCandidate(userId: string, candidate: MemoryCandidate, now: string): MemoryRecord {
  return {
    id: `mem-${randomUUID()}`,
    userId,
    type: candidate.type,
    content: candidate.content.trim(),
    confidence: candidate.confidence,
    importance: candidate.importance,
    sensitivity: candidate.sensitivity,
    sourceMessageIds: candidate.sourceMessageIds,
    userConfirmed: true,
    revision: 1,
    validFrom: candidate.validFrom,
    validUntil: candidate.validUntil,
    createdAt: now,
    lastSeenAt: now,
  };
}

async function withTransaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
  const pool = getPostgresPool();
  if (!pool) throw new Error("Postgres is not configured");

  const client = await pool.connect();

  try {
    await client.query("begin");
    const result = await callback(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

function memoryFromRow(row: Record<string, unknown>): MemoryRecord {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    type: row.type as MemoryRecord["type"],
    content: String(row.content),
    confidence: Number(row.confidence),
    importance: Number(row.importance),
    sensitivity: row.sensitivity as MemoryRecord["sensitivity"],
    sourceMessageIds: Array.isArray(row.source_message_ids) ? row.source_message_ids.map(String) : [],
    userConfirmed: true,
    revision: Math.max(1, Number(row.revision ?? 1)),
    validFrom: row.valid_from ? new Date(String(row.valid_from)).toISOString() : null,
    validUntil: row.valid_until ? new Date(String(row.valid_until)).toISOString() : null,
    createdAt: new Date(String(row.created_at)).toISOString(),
    lastSeenAt: new Date(String(row.last_seen_at)).toISOString(),
  };
}

function memoryHasSamePersistence(left: MemoryRecord, right: MemoryRecord) {
  return (
    left.type === right.type &&
    left.content.trim() === right.content.trim() &&
    left.confidence === right.confidence &&
    left.importance === right.importance &&
    left.sensitivity === right.sensitivity &&
    left.userConfirmed === right.userConfirmed &&
    left.validFrom === right.validFrom &&
    left.validUntil === right.validUntil &&
    left.createdAt === right.createdAt &&
    left.lastSeenAt === right.lastSeenAt &&
    JSON.stringify([...left.sourceMessageIds].sort()) === JSON.stringify([...right.sourceMessageIds].sort())
  );
}

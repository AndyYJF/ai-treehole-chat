import { randomUUID } from "crypto";
import type { PoolClient } from "pg";
import { getPostgresPool } from "../postgres";
import type { MemoryCandidate, MemoryRecord } from "./types";
import { findMergeTarget, maintainMemoryRecords, mergeMemoryRecord } from "./merge";
import { sortMemoryForPrompt } from "./store";
import type { MemoryRepository } from "./repository";

let schemaReady: Promise<void> | null = null;

const baselineMemories: Array<Omit<MemoryRecord, "id" | "userId" | "createdAt" | "lastSeenAt">> = [
  {
    type: "procedural",
    content: "用户偏好安静、少说教、先回应感受，再给选择。",
    confidence: 0.82,
    importance: 86,
    sensitivity: "normal",
    sourceMessageIds: [],
    userConfirmed: false,
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
    userConfirmed: false,
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
          user_confirmed, valid_from, valid_until, created_at, last_seen_at
        from memories
        where user_id = $1 and valid_until is null`,
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

    async confirmMemory(userId, memoryId) {
      await ensureInitialized(userId);

      const pool = getPostgresPool();
      if (!pool) return this.listMemories(userId);

      await pool.query(
        `update memories
        set user_confirmed = true, confidence = greatest(confidence, 0.9), last_seen_at = now()
        where user_id = $1 and id = $2`,
        [userId, memoryId],
      );

      return this.listMemories(userId);
    },

    async updateMemory(userId, memoryId, update) {
      await ensureInitialized(userId);

      const pool = getPostgresPool();
      if (!pool) return this.listMemories(userId);

      await withTransaction(async (client) => {
        await updateMemoryRecord(client, userId, memoryId, update);
      });

      return this.listMemories(userId);
    },

    async deleteMemory(userId, memoryId) {
      await ensureInitialized(userId);
      const pool = getPostgresPool();
      if (!pool) return this.listMemories(userId);

      await pool.query("delete from memories where user_id = $1 and id = $2", [userId, memoryId]);
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
          await writeMergedMemory(client, userId, memory);
        }

        for (const memory of existing) {
          if (maintainedIds.has(memory.id)) continue;
          await client.query("delete from memories where user_id = $1 and id = $2", [userId, memory.id]);
        }
      });

      return this.listMemories(userId);
    },

    async getMemorySettings(userId) {
      await ensureInitialized(userId);

      const pool = getPostgresPool();
      if (!pool) return { enabled: true };

      const { rows } = await pool.query("select enabled from user_memory_settings where user_id = $1", [userId]);
      return { enabled: rows[0]?.enabled ?? true };
    },

    async setMemoryEnabled(userId, enabled) {
      await ensureInitialized(userId);

      const pool = getPostgresPool();
      if (!pool) return { enabled };

      await pool.query(
        `insert into user_memory_settings (user_id, enabled, updated_at)
        values ($1, $2, now())
        on conflict (user_id)
        do update set enabled = excluded.enabled, updated_at = now()`,
        [userId, enabled],
      );

      return { enabled };
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
      user_confirmed boolean not null default false,
      valid_from timestamptz,
      valid_until timestamptz,
      created_at timestamptz not null default now(),
      last_seen_at timestamptz not null default now()
    );

    create unique index if not exists memories_user_type_content_key
      on memories (user_id, type, content);

    create index if not exists memories_user_valid_idx
      on memories (user_id, valid_until, importance desc, last_seen_at desc);
  `);
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
    values ($1, $2, $3, $4, $5, $6, $7, $8, false, $9, $10, $11, $12)
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
) {
  const existing = await listValidMemories(client, userId);
  const current = existing.find((memory) => memory.id === memoryId);
  if (!current) return;

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
    await client.query("delete from memories where user_id = $1 and id = $2", [userId, memoryId]);
    return;
  }

  await client.query(
    `update memories
    set type = $3,
      content = $4,
      importance = $5,
      sensitivity = $6,
      user_confirmed = true,
      confidence = greatest(confidence, 0.9),
      last_seen_at = now()
    where user_id = $1 and id = $2`,
    [userId, memoryId, incoming.type, incoming.content, incoming.importance, incoming.sensitivity],
  );
}

async function listValidMemories(client: PoolClient, userId: string): Promise<MemoryRecord[]> {
  const { rows } = await client.query(
    `select id, user_id, type, content, confidence, importance, sensitivity, source_message_ids,
      user_confirmed, valid_from, valid_until, created_at, last_seen_at
    from memories
    where user_id = $1 and valid_until is null`,
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
      user_confirmed = $9,
      valid_from = $10,
      valid_until = $11,
      created_at = $12,
      last_seen_at = $13
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
      memory.userConfirmed,
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
    userConfirmed: false,
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
    userConfirmed: Boolean(row.user_confirmed),
    validFrom: row.valid_from ? new Date(String(row.valid_from)).toISOString() : null,
    validUntil: row.valid_until ? new Date(String(row.valid_until)).toISOString() : null,
    createdAt: new Date(String(row.created_at)).toISOString(),
    lastSeenAt: new Date(String(row.last_seen_at)).toISOString(),
  };
}

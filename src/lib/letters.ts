import { randomUUID } from "crypto";
import { getPostgresPool } from "./postgres";
import { ensureSyncTrigger } from "./sync";

export type TimeboxLetter = {
  id: string;
  userId: string;
  content: string;
  isRead: boolean;
  createdAt: string;
};

type CreateLetterInput = {
  userId: string;
  content: string;
  createdAt?: string;
};

const inMemoryLetters = new Map<string, TimeboxLetter[]>();
let schemaReady: Promise<void> | null = null;

export async function listLetters(userId: string): Promise<TimeboxLetter[]> {
  const pool = getPostgresPool();

  if (!pool) {
    return [...(inMemoryLetters.get(userId) ?? [])].sort(sortLetters);
  }

  await ensureLetterSchema();

  const { rows } = await pool.query(
    `select id, user_id, content, is_read, created_at
    from timebox_letters
    where user_id = $1
    order by created_at desc, id desc`,
    [userId],
  );

  return rows.map(letterFromRow);
}

export async function createLetter(input: CreateLetterInput): Promise<TimeboxLetter> {
  const letter: TimeboxLetter = {
    id: `letter-${randomUUID()}`,
    userId: input.userId,
    content: input.content.trim(),
    isRead: false,
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
  const pool = getPostgresPool();

  if (!pool) {
    const current = inMemoryLetters.get(input.userId) ?? [];
    inMemoryLetters.set(input.userId, [letter, ...current].sort(sortLetters).slice(0, 200));
    return letter;
  }

  await ensureLetterSchema();
  await pool.query(
    `insert into timebox_letters (id, user_id, content, is_read, created_at)
    values ($1, $2, $3, $4, $5)`,
    [letter.id, letter.userId, letter.content, letter.isRead, letter.createdAt],
  );

  return letter;
}

export async function markLetterRead(userId: string, letterId: string): Promise<TimeboxLetter | null> {
  const pool = getPostgresPool();

  if (!pool) {
    const current = inMemoryLetters.get(userId) ?? [];
    let updatedLetter: TimeboxLetter | null = null;
    const next = current.map((letter) => {
      if (letter.id !== letterId) return letter;
      updatedLetter = { ...letter, isRead: true };
      return updatedLetter;
    });
    inMemoryLetters.set(userId, next);
    return updatedLetter;
  }

  await ensureLetterSchema();
  const { rows } = await pool.query(
    `update timebox_letters
    set is_read = true
    where user_id = $1 and id = $2
    returning id, user_id, content, is_read, created_at`,
    [userId, letterId],
  );

  return rows[0] ? letterFromRow(rows[0]) : null;
}

export async function clearLetters(userId: string): Promise<void> {
  const pool = getPostgresPool();

  if (!pool) {
    inMemoryLetters.set(userId, []);
    return;
  }

  await ensureLetterSchema();
  await pool.query("delete from timebox_letters where user_id = $1", [userId]);
}

async function ensureLetterSchema() {
  const pool = getPostgresPool();
  if (!pool) return;

  schemaReady ??= pool.query(`
    create table if not exists timebox_letters (
      id text primary key,
      user_id text not null,
      content text not null,
      is_read boolean not null default false,
      created_at timestamptz not null default now()
    );

    create index if not exists timebox_letters_user_created_idx
      on timebox_letters (user_id, created_at desc);
  `).then(() => undefined);

  await schemaReady;
  await ensureSyncTrigger("timebox_letters", "letter");
}

function sortLetters(left: TimeboxLetter, right: TimeboxLetter) {
  if (right.createdAt !== left.createdAt) return right.createdAt.localeCompare(left.createdAt);
  return right.id.localeCompare(left.id);
}

function letterFromRow(row: Record<string, unknown>): TimeboxLetter {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    content: String(row.content),
    isRead: Boolean(row.is_read),
    createdAt: new Date(String(row.created_at)).toISOString(),
  };
}

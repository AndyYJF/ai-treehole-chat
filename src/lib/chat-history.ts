import { randomUUID } from "crypto";
import { getPostgresPool } from "./postgres";
import { ensureSyncTrigger } from "./sync";
import { normalizeThreadTitle, titleFromText } from "./thread-title";
import type { VisionAnalysis } from "./vision";

export type ChatThread = {
  id: string;
  title: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string | null;
};

export type StoredChatMessage = {
  id: string;
  threadId: string;
  role: "user" | "assistant";
  content: string;
  context: ChatMessageContext;
  createdAt: string;
};

export type ChatMessageContext = {
  vision?: VisionAnalysis;
  visionWarning?: string;
};

export type ChatTurnRecord = {
  id: string;
  userId: string;
  threadId: string;
  clientTurnId: string;
  status: "processing" | "completed" | "failed";
  userMessageId: string;
  assistantMessageId: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

export type ChatTurnClaim = {
  state: "claimed" | "completed" | "in_progress";
  turn: ChatTurnRecord;
};

type NewChatMessage = Pick<StoredChatMessage, "role" | "content"> & {
  id?: string;
  turnId?: string;
  context?: ChatMessageContext;
  createdAt?: string;
};

type InMemoryThreadState = {
  threads: ChatThread[];
  messages: Map<string, StoredChatMessage[]>;
  turns: Map<string, ChatTurnRecord>;
};

const inMemoryChat = new Map<string, InMemoryThreadState>();
let schemaReady: Promise<void> | null = null;

export async function listChatThreads(userId: string): Promise<ChatThread[]> {
  const pool = getPostgresPool();

  if (!pool) {
    const state = ensureInMemoryState(userId);
    return sortThreads(state.threads);
  }

  await ensureChatSchema(userId);

  const { rows } = await pool.query(
    `select
      t.id, t.title, t.created_at, t.updated_at,
      count(m.id)::int as message_count,
      max(m.created_at) as last_message_at
    from chat_threads t
    left join chat_messages m
      on m.user_id = t.user_id and m.thread_id = t.id
    where t.user_id = $1 and t.archived_at is null
    group by t.id, t.title, t.created_at, t.updated_at
    order by coalesce(max(m.created_at), t.updated_at) desc, t.created_at desc`,
    [userId],
  );

  return rows.map(threadFromRow);
}

export async function createChatThread(userId: string, title = "新对话"): Promise<ChatThread> {
  const now = new Date().toISOString();
  const thread: ChatThread = {
    id: `thread-${randomUUID()}`,
    title: normalizeThreadTitle(title),
    messageCount: 0,
    createdAt: now,
    updatedAt: now,
    lastMessageAt: null,
  };
  const pool = getPostgresPool();

  if (!pool) {
    const state = ensureInMemoryState(userId);
    state.threads = [thread, ...state.threads];
    state.messages.set(thread.id, []);
    return thread;
  }

  await ensureChatSchema(userId);
  await pool.query(
    `insert into chat_threads (id, user_id, title, created_at, updated_at)
    values ($1, $2, $3, $4, $5)`,
    [thread.id, userId, thread.title, thread.createdAt, thread.updatedAt],
  );

  return thread;
}

export async function deleteChatThread(userId: string, threadId: string): Promise<ChatThread> {
  const pool = getPostgresPool();

  if (!pool) {
    const state = ensureInMemoryState(userId);
    state.messages.delete(threadId);
    state.threads = state.threads.filter((thread) => thread.id !== threadId);
    state.turns = new Map(
      [...state.turns].filter(([, turn]) => turn.threadId !== threadId),
    );

    if (state.threads.length === 0) {
      const now = new Date().toISOString();
      const thread: ChatThread = {
        id: `thread-${randomUUID()}`,
        title: "新对话",
        messageCount: 0,
        createdAt: now,
        updatedAt: now,
        lastMessageAt: null,
      };
      state.threads = [thread];
      state.messages.set(thread.id, []);
      return thread;
    }

    return sortThreads(state.threads)[0];
  }

  await ensureChatSchema(userId);
  await pool.query("delete from chat_turns where user_id = $1 and thread_id = $2", [userId, threadId]);
  await pool.query("delete from chat_messages where user_id = $1 and thread_id = $2", [userId, threadId]);
  await pool.query("delete from chat_threads where user_id = $1 and id = $2", [userId, threadId]);
  await ensureDefaultThread(userId);

  return ensureActiveChatThread(userId);
}

export async function ensureActiveChatThread(userId: string, threadId?: string | null): Promise<ChatThread> {
  const threads = await listChatThreads(userId);

  if (threadId) {
    const existing = threads.find((thread) => thread.id === threadId);
    if (existing) return existing;
  }

  return threads[0] ?? createChatThread(userId);
}

export async function listChatMessages(
  userId: string,
  threadId?: string | null,
  limit = 80,
): Promise<StoredChatMessage[]> {
  const thread = await ensureActiveChatThread(userId, threadId);
  const pool = getPostgresPool();

  if (!pool) {
    const state = ensureInMemoryState(userId);
    return [...(state.messages.get(thread.id) ?? [])].slice(-limit);
  }

  await ensureChatSchema(userId);

  const { rows } = await pool.query(
    `select id, thread_id, role, content, context, created_at
    from (
      select id, thread_id, role, content, context, created_at
      from chat_messages
      where user_id = $1 and thread_id = $2
      order by created_at desc, id desc
      limit $3
    ) recent_messages
    order by created_at asc, id asc`,
    [userId, thread.id, limit],
  );

  return rows.map(messageFromRow);
}

export async function listRecentChatMessages(userId: string, limit = 24): Promise<StoredChatMessage[]> {
  const pool = getPostgresPool();

  if (!pool) {
    const state = ensureInMemoryState(userId);
    return [...state.messages.values()]
      .flat()
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
      .slice(-limit);
  }

  await ensureChatSchema(userId);

  const { rows } = await pool.query(
    `select id, thread_id, role, content, context, created_at
    from (
      select id, thread_id, role, content, context, created_at
      from chat_messages
      where user_id = $1
      order by created_at desc, id desc
      limit $2
    ) recent_messages
    order by created_at asc, id asc`,
    [userId, limit],
  );

  return rows.map(messageFromRow);
}

export async function appendChatMessages(
  userId: string,
  threadId: string | null | undefined,
  messages: NewChatMessage[],
): Promise<StoredChatMessage[]> {
  const thread = await ensureActiveChatThread(userId, threadId);
  const baseTime = Date.now();
  const created = messages.map((message, index) => ({
    id: message.id ?? `chat-${randomUUID()}`,
    threadId: thread.id,
    turnId: message.turnId ?? null,
    role: message.role,
    content: message.content,
    context: message.context ?? {},
    createdAt: message.createdAt ?? new Date(baseTime + index).toISOString(),
  }));

  const pool = getPostgresPool();

  if (!pool) {
    const state = ensureInMemoryState(userId);
    const current = state.messages.get(thread.id) ?? [];
    const currentIds = new Set(current.map((message) => message.id));
    const next = [...current, ...created.filter((message) => !currentIds.has(message.id))].slice(-300);
    state.messages.set(thread.id, next);
    touchInMemoryThread(state, thread.id, created[0]?.content);
    return next;
  }

  await ensureChatSchema(userId);

  for (const message of created) {
    await pool.query(
      `insert into chat_messages (id, thread_id, turn_id, user_id, role, content, context, created_at)
      values ($1, $2, $3, $4, $5, $6, $7, $8)
      on conflict (id) do nothing`,
      [
        message.id,
        thread.id,
        message.turnId,
        userId,
        message.role,
        message.content,
        JSON.stringify(message.context),
        message.createdAt,
      ],
    );
  }

  const nextTitle = thread.messageCount === 0 ? titleFromMessage(created[0]?.content ?? "") : null;
  await pool.query(
    `update chat_threads
    set updated_at = now(), title = coalesce($3, title)
    where user_id = $1 and id = $2`,
    [userId, thread.id, nextTitle],
  );

  return listChatMessages(userId, thread.id);
}

export async function listAllChatMessages(userId: string): Promise<StoredChatMessage[]> {
  const pool = getPostgresPool();

  if (!pool) {
    const state = ensureInMemoryState(userId);
    return [...state.messages.values()]
      .flat()
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  }

  await ensureChatSchema(userId);
  const { rows } = await pool.query(
    `select id, thread_id, role, content, context, created_at
    from chat_messages
    where user_id = $1
    order by created_at asc, id asc`,
    [userId],
  );
  return rows.map(messageFromRow);
}

const chatTurnLeaseMs = 5 * 60 * 1000;

export async function claimChatTurn(
  userId: string,
  threadId: string,
  clientTurnId: string,
): Promise<ChatTurnClaim> {
  const thread = await ensureActiveChatThread(userId, threadId);
  const now = new Date();
  const pool = getPostgresPool();

  if (!pool) {
    const state = ensureInMemoryState(userId);
    const existing = state.turns.get(clientTurnId);

    if (!existing) {
      const turn = createChatTurnRecord(userId, thread.id, clientTurnId, now);
      state.turns.set(clientTurnId, turn);
      return { state: "claimed", turn };
    }

    const assistantExists = (state.messages.get(existing.threadId) ?? []).some(
      (message) => message.id === existing.assistantMessageId,
    );
    if (existing.status === "completed" || assistantExists) {
      const completed = markTurnCompleted(existing, now);
      state.turns.set(clientTurnId, completed);
      return { state: "completed", turn: completed };
    }

    const leaseExpired = now.getTime() - new Date(existing.updatedAt).getTime() >= chatTurnLeaseMs;
    if (existing.status === "failed" || leaseExpired) {
      const claimed = { ...existing, status: "processing" as const, updatedAt: now.toISOString() };
      state.turns.set(clientTurnId, claimed);
      return { state: "claimed", turn: claimed };
    }

    return { state: "in_progress", turn: existing };
  }

  await ensureChatSchema(userId);
  const candidate = createChatTurnRecord(userId, thread.id, clientTurnId, now);
  const staleBefore = new Date(now.getTime() - chatTurnLeaseMs).toISOString();
  const { rows: claimedRows } = await pool.query(
    `insert into chat_turns (
      id, user_id, thread_id, client_turn_id, status,
      user_message_id, assistant_message_id, created_at, updated_at
    )
    values ($1, $2, $3, $4, 'processing', $5, $6, $7, $7)
    on conflict (user_id, client_turn_id)
    do update set status = 'processing', updated_at = excluded.updated_at, completed_at = null
    where chat_turns.status = 'failed' or chat_turns.updated_at < $8
    returning id, user_id, thread_id, client_turn_id, status,
      user_message_id, assistant_message_id, created_at, updated_at, completed_at`,
    [
      candidate.id,
      userId,
      thread.id,
      clientTurnId,
      candidate.userMessageId,
      candidate.assistantMessageId,
      candidate.createdAt,
      staleBefore,
    ],
  );

  if (claimedRows[0]) {
    return { state: "claimed", turn: turnFromRow(claimedRows[0]) };
  }

  const { rows } = await pool.query(
    `select id, user_id, thread_id, client_turn_id, status,
      user_message_id, assistant_message_id, created_at, updated_at, completed_at
    from chat_turns
    where user_id = $1 and client_turn_id = $2`,
    [userId, clientTurnId],
  );
  let existing = turnFromRow(rows[0]);

  if (existing.status !== "completed") {
    const { rows: assistantRows } = await pool.query(
      "select id from chat_messages where user_id = $1 and id = $2 limit 1",
      [userId, existing.assistantMessageId],
    );
    if (assistantRows.length > 0) {
      const { rows: completedRows } = await pool.query(
        `update chat_turns
        set status = 'completed', completed_at = coalesce(completed_at, now()), updated_at = now()
        where user_id = $1 and client_turn_id = $2
        returning id, user_id, thread_id, client_turn_id, status,
          user_message_id, assistant_message_id, created_at, updated_at, completed_at`,
        [userId, clientTurnId],
      );
      existing = turnFromRow(completedRows[0]);
    }
  }

  return {
    state: existing.status === "completed" ? "completed" : "in_progress",
    turn: existing,
  };
}

export async function completeChatTurn(userId: string, clientTurnId: string) {
  const now = new Date();
  const pool = getPostgresPool();

  if (!pool) {
    const state = ensureInMemoryState(userId);
    const existing = state.turns.get(clientTurnId);
    if (existing) state.turns.set(clientTurnId, markTurnCompleted(existing, now));
    return;
  }

  await ensureChatSchema(userId);
  await pool.query(
    `update chat_turns
    set status = 'completed', completed_at = coalesce(completed_at, now()), updated_at = now()
    where user_id = $1 and client_turn_id = $2`,
    [userId, clientTurnId],
  );
}

export async function getChatTurn(userId: string, clientTurnId: string): Promise<ChatTurnRecord | null> {
  const pool = getPostgresPool();

  if (!pool) {
    return ensureInMemoryState(userId).turns.get(clientTurnId) ?? null;
  }

  await ensureChatSchema(userId);
  const { rows } = await pool.query(
    `select id, user_id, thread_id, client_turn_id, status,
      user_message_id, assistant_message_id, created_at, updated_at, completed_at
    from chat_turns
    where user_id = $1 and client_turn_id = $2`,
    [userId, clientTurnId],
  );

  return rows[0] ? turnFromRow(rows[0]) : null;
}

export async function failChatTurn(userId: string, clientTurnId: string) {
  const pool = getPostgresPool();

  if (!pool) {
    const state = ensureInMemoryState(userId);
    const existing = state.turns.get(clientTurnId);
    if (existing && existing.status === "processing") {
      state.turns.set(clientTurnId, {
        ...existing,
        status: "failed",
        updatedAt: new Date().toISOString(),
      });
    }
    return;
  }

  await ensureChatSchema(userId);
  await pool.query(
    `update chat_turns
    set status = 'failed', updated_at = now()
    where user_id = $1 and client_turn_id = $2 and status = 'processing'
      and not exists (
        select 1 from chat_messages
        where chat_messages.user_id = $1
          and chat_messages.id = chat_turns.assistant_message_id
      )`,
    [userId, clientTurnId],
  );
}

export async function updateChatThreadTitle(userId: string, threadId: string, title: string): Promise<ChatThread> {
  const normalizedTitle = normalizeThreadTitle(title);
  const pool = getPostgresPool();

  if (!pool) {
    const state = ensureInMemoryState(userId);
    state.threads = state.threads.map((thread) =>
      thread.id === threadId
        ? {
            ...thread,
            title: normalizedTitle,
            updatedAt: new Date().toISOString(),
          }
        : thread,
    );
    return ensureActiveChatThread(userId, threadId);
  }

  await ensureChatSchema(userId);
  await pool.query(
    `update chat_threads
    set title = $3, updated_at = now()
    where user_id = $1 and id = $2`,
    [userId, threadId, normalizedTitle],
  );

  return ensureActiveChatThread(userId, threadId);
}

export async function clearChatMessages(userId: string, threadId?: string | null) {
  const thread = await ensureActiveChatThread(userId, threadId);
  const pool = getPostgresPool();

  if (!pool) {
    const state = ensureInMemoryState(userId);
    state.messages.set(thread.id, []);
    touchInMemoryThread(state, thread.id);
    return thread.id;
  }

  await ensureChatSchema(userId);
  await pool.query("delete from chat_messages where user_id = $1 and thread_id = $2", [userId, thread.id]);
  await pool.query(
    `update chat_threads
    set updated_at = now(), title = $3
    where user_id = $1 and id = $2`,
    [userId, thread.id, "新对话"],
  );

  return thread.id;
}

export async function clearAllChatMessages(userId: string) {
  const pool = getPostgresPool();

  if (!pool) {
    const now = new Date().toISOString();
    const thread: ChatThread = {
      id: `thread-${randomUUID()}`,
      title: "新对话",
      messageCount: 0,
      createdAt: now,
      updatedAt: now,
      lastMessageAt: null,
    };
    inMemoryChat.set(userId, {
      threads: [thread],
      messages: new Map([[thread.id, []]]),
      turns: new Map(),
    });
    return;
  }

  await ensureChatSchema(userId);
  await pool.query("delete from chat_turns where user_id = $1", [userId]);
  await pool.query("delete from chat_messages where user_id = $1", [userId]);
  await pool.query("delete from chat_threads where user_id = $1", [userId]);
  await ensureDefaultThread(userId);
}

async function ensureChatSchema(userId: string) {
  const pool = getPostgresPool();
  if (!pool) return;

  schemaReady ??= pool.query(`
    create table if not exists chat_threads (
      id text primary key,
      user_id text not null,
      title text not null default '新对话',
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      archived_at timestamptz
    );

    create table if not exists chat_messages (
      id text primary key,
      thread_id text,
      turn_id text,
      user_id text not null,
      role text not null check (role in ('user', 'assistant')),
      content text not null,
      context jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now()
    );

    alter table chat_messages
      add column if not exists thread_id text;

    alter table chat_messages
      add column if not exists turn_id text;

    alter table chat_messages
      add column if not exists context jsonb not null default '{}'::jsonb;

    create table if not exists chat_turns (
      id text primary key,
      user_id text not null,
      thread_id text not null,
      client_turn_id text not null,
      status text not null check (status in ('processing', 'completed', 'failed')),
      user_message_id text not null,
      assistant_message_id text not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      completed_at timestamptz,
      unique (user_id, client_turn_id)
    );

    create index if not exists chat_threads_user_updated_idx
      on chat_threads (user_id, archived_at, updated_at desc);

    create index if not exists chat_messages_user_thread_created_idx
      on chat_messages (user_id, thread_id, created_at asc);

    create index if not exists chat_messages_user_turn_idx
      on chat_messages (user_id, turn_id);

    create index if not exists chat_turns_user_thread_updated_idx
      on chat_turns (user_id, thread_id, updated_at desc);

    drop index if exists chat_messages_user_created_idx;
  `).then(() => undefined);

  await schemaReady;
  await Promise.all([
    ensureSyncTrigger("chat_threads", "thread"),
    ensureSyncTrigger("chat_messages", "message"),
  ]);
  await ensureDefaultThread(userId);
}

async function ensureDefaultThread(userId: string) {
  const pool = getPostgresPool();
  if (!pool) return;

  const { rows } = await pool.query("select id from chat_threads where user_id = $1 and archived_at is null limit 1", [
    userId,
  ]);
  const defaultThreadId = rows[0]?.id ? String(rows[0].id) : `thread-${randomUUID()}`;

  if (rows.length === 0) {
    await pool.query(
      `insert into chat_threads (id, user_id, title, created_at, updated_at)
      values ($1, $2, '新对话', now(), now())`,
      [defaultThreadId, userId],
    );
  }

  await pool.query(
    `update chat_messages
    set thread_id = $2
    where user_id = $1 and thread_id is null`,
    [userId, defaultThreadId],
  );

  const { rows: titleRows } = await pool.query(
    `select content
    from chat_messages
    where user_id = $1 and thread_id = $2 and role = 'user'
    order by created_at asc
    limit 1`,
    [userId, defaultThreadId],
  );

  if (titleRows[0]?.content) {
    await pool.query(
      `update chat_threads
      set title = case when title = '新对话' then $3 else title end,
        updated_at = coalesce((select max(created_at) from chat_messages where user_id = $1 and thread_id = $2), updated_at)
      where user_id = $1 and id = $2`,
      [userId, defaultThreadId, titleFromMessage(String(titleRows[0].content))],
    );
  }
}

function ensureInMemoryState(userId: string): InMemoryThreadState {
  const existing = inMemoryChat.get(userId);
  if (existing) return existing;

  const now = new Date().toISOString();
  const thread: ChatThread = {
    id: `thread-${randomUUID()}`,
    title: "新对话",
    messageCount: 0,
    createdAt: now,
    updatedAt: now,
    lastMessageAt: null,
  };
  const state = {
    threads: [thread],
    messages: new Map([[thread.id, []]]),
    turns: new Map(),
  };
  inMemoryChat.set(userId, state);
  return state;
}

function touchInMemoryThread(state: InMemoryThreadState, threadId: string, firstMessage?: string) {
  const now = new Date().toISOString();
  const messages = state.messages.get(threadId) ?? [];

  state.threads = state.threads.map((thread) => {
    if (thread.id !== threadId) return thread;

    return {
      ...thread,
      title: thread.messageCount === 0 && firstMessage ? titleFromText(firstMessage) : thread.title,
      messageCount: messages.length,
      updatedAt: now,
      lastMessageAt: messages[messages.length - 1]?.createdAt ?? null,
    };
  });
}

function sortThreads(threads: ChatThread[]) {
  return [...threads].sort((a, b) => {
    const aTime = a.lastMessageAt ?? a.updatedAt;
    const bTime = b.lastMessageAt ?? b.updatedAt;
    return bTime.localeCompare(aTime);
  });
}

function titleFromMessage(message: string) {
  return titleFromText(message);
}

function threadFromRow(row: Record<string, unknown>): ChatThread {
  return {
    id: String(row.id),
    title: String(row.title),
    messageCount: Number(row.message_count ?? 0),
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at)).toISOString(),
    lastMessageAt: row.last_message_at ? new Date(String(row.last_message_at)).toISOString() : null,
  };
}

function messageFromRow(row: Record<string, unknown>): StoredChatMessage {
  return {
    id: String(row.id),
    threadId: String(row.thread_id),
    role: row.role as StoredChatMessage["role"],
    content: String(row.content),
    context: normalizeMessageContext(row.context),
    createdAt: new Date(String(row.created_at)).toISOString(),
  };
}

function normalizeMessageContext(value: unknown): ChatMessageContext {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as ChatMessageContext;
}

function createChatTurnRecord(
  userId: string,
  threadId: string,
  clientTurnId: string,
  now: Date,
): ChatTurnRecord {
  const createdAt = now.toISOString();

  return {
    id: `turn-${randomUUID()}`,
    userId,
    threadId,
    clientTurnId,
    status: "processing",
    userMessageId: `chat-${randomUUID()}`,
    assistantMessageId: `chat-${randomUUID()}`,
    createdAt,
    updatedAt: createdAt,
    completedAt: null,
  };
}

function markTurnCompleted(turn: ChatTurnRecord, now: Date): ChatTurnRecord {
  const completedAt = turn.completedAt ?? now.toISOString();
  return {
    ...turn,
    status: "completed",
    updatedAt: now.toISOString(),
    completedAt,
  };
}

function turnFromRow(row: Record<string, unknown> | undefined): ChatTurnRecord {
  if (!row) throw new Error("Chat turn was not found");

  return {
    id: String(row.id),
    userId: String(row.user_id),
    threadId: String(row.thread_id),
    clientTurnId: String(row.client_turn_id),
    status: row.status as ChatTurnRecord["status"],
    userMessageId: String(row.user_message_id),
    assistantMessageId: String(row.assistant_message_id),
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at)).toISOString(),
    completedAt: row.completed_at ? new Date(String(row.completed_at)).toISOString() : null,
  };
}

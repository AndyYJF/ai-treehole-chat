-- Single-user private deployment schema.
-- The app creates these tables automatically when DATABASE_URL is configured.

create table if not exists user_memory_settings (
  user_id text primary key,
  enabled boolean not null default true,
  updated_at timestamptz not null default now()
);

create table if not exists memories (
  id text primary key,
  user_id text not null,
  type text not null check (
    type in ('semantic', 'episodic', 'procedural', 'affect', 'safety', 'preference', 'boundary')
  ),
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

create table if not exists chat_threads (
  id text primary key,
  user_id text not null,
  title text not null default '新对话',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);

create index if not exists chat_threads_user_updated_idx
  on chat_threads (user_id, archived_at, updated_at desc);

create table if not exists chat_messages (
  id text primary key,
  thread_id text,
  user_id text not null,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  created_at timestamptz not null default now()
);

create index if not exists chat_messages_user_thread_created_idx
  on chat_messages (user_id, thread_id, created_at asc);

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

-- If this project later becomes multi-user, add an auth table, replace user_id
-- with an authenticated identity, and enable row-level security policies.

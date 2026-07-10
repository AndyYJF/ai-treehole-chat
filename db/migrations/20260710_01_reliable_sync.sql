-- Additive, repeatable migration for deployments created before chat turns,
-- vision context, sync cursors, and optimistic memory revisions existed.
-- It does not rewrite or remove historical user content.

alter table if exists chat_messages
  add column if not exists turn_id text;

alter table if exists chat_messages
  add column if not exists context jsonb not null default '{}'::jsonb;

create index if not exists chat_messages_user_turn_idx
  on chat_messages (user_id, turn_id);

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

create index if not exists chat_turns_user_thread_updated_idx
  on chat_turns (user_id, thread_id, updated_at desc);

alter table if exists memories
  add column if not exists revision integer not null default 1;

alter table if exists user_memory_settings
  add column if not exists revision integer not null default 1;

create table if not exists sync_changes (
  sequence bigserial primary key,
  user_id text not null,
  entity text not null check (entity in ('thread', 'message', 'memory', 'memory_settings', 'letter', 'usage')),
  entity_id text not null,
  operation text not null check (operation in ('upsert', 'delete')),
  occurred_at timestamptz not null default now()
);

alter table sync_changes drop constraint if exists sync_changes_entity_check;
alter table sync_changes add constraint sync_changes_entity_check
  check (entity in ('thread', 'message', 'memory', 'memory_settings', 'letter', 'usage'));

create index if not exists sync_changes_user_sequence_idx
  on sync_changes (user_id, sequence asc);

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

drop trigger if exists treehole_chat_threads_sync_change on chat_threads;
create trigger treehole_chat_threads_sync_change
after insert or update or delete on chat_threads
for each row execute function treehole_record_sync_change('thread');

drop trigger if exists treehole_chat_messages_sync_change on chat_messages;
create trigger treehole_chat_messages_sync_change
after insert or update or delete on chat_messages
for each row execute function treehole_record_sync_change('message');

drop trigger if exists treehole_memories_sync_change on memories;
create trigger treehole_memories_sync_change
after insert or update or delete on memories
for each row execute function treehole_record_sync_change('memory');

drop trigger if exists treehole_user_memory_settings_sync_change on user_memory_settings;
create trigger treehole_user_memory_settings_sync_change
after insert or update or delete on user_memory_settings
for each row execute function treehole_record_sync_change('memory_settings');

drop trigger if exists treehole_timebox_letters_sync_change on timebox_letters;
create trigger treehole_timebox_letters_sync_change
after insert or update or delete on timebox_letters
for each row execute function treehole_record_sync_change('letter');

drop trigger if exists treehole_model_usage_events_sync_change on model_usage_events;
create trigger treehole_model_usage_events_sync_change
after insert or update or delete on model_usage_events
for each row execute function treehole_record_sync_change('usage');

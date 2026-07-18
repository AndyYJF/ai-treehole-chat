-- The confirmation workflow has been removed. Keep the legacy column for
-- backwards-compatible exports and older clients, but make every existing and
-- future memory confirmed by default.

alter table if exists memories
  alter column user_confirmed set default true;

update memories
set user_confirmed = true,
  revision = revision + 1
where user_confirmed = false;

-- VibeMail Engine schema (CONTRACT.md §5).
--
-- Every statement is idempotent: re-running this file against a database that
-- already has it applied is a no-op and must exit 0.
--
-- RLS is enabled with NO policies on every table (§5.1, §5.2): anon and
-- authenticated see nothing through the Data API; only service_role, which
-- bypasses RLS, reads and writes. Tenant isolation itself is enforced in
-- src/db (§5.3). Default table grants are left in place on purpose, so a
-- user-token Data API select returns zero rows rather than a permission error.
--
-- gen_random_uuid() is built into Postgres 13+ (the project runs 17), so no
-- extension is needed.

-- ---------------------------------------------------------------------------
-- updated_at trigger function (shared)
-- ---------------------------------------------------------------------------

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- Trigger-only; nobody calls it directly.
revoke execute on function public.set_updated_at() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- public.users: one connected Google account per user (§5.2)
-- ---------------------------------------------------------------------------

create table if not exists public.users (
  google_id               text        not null,
  user_id                 uuid        not null,
  email                   text        not null,
  refresh_token           text,
  scopes                  text[]      not null,
  access_token            text,
  access_token_expires_at timestamptz,
  history_id              text,
  last_synced_at          timestamptz,
  watch_expiration        timestamptz,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

do $$
begin
  -- Connect upsert conflict target (§5.2 linking rules).
  if not exists (select 1 from pg_constraint where conname = 'users_pkey'
                 and conrelid = 'public.users'::regclass) then
    alter table public.users add constraint users_pkey primary key (google_id);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'users_user_id_key'
                 and conrelid = 'public.users'::regclass) then
    alter table public.users add constraint users_user_id_key unique (user_id);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'users_user_id_fkey'
                 and conrelid = 'public.users'::regclass) then
    alter table public.users add constraint users_user_id_fkey
      foreign key (user_id) references auth.users (id) on delete cascade;
  end if;

  -- Webhook lookup by email (§4.5).
  if not exists (select 1 from pg_constraint where conname = 'users_email_key'
                 and conrelid = 'public.users'::regclass) then
    alter table public.users add constraint users_email_key unique (email);
  end if;

  -- access_token and its expiry are written as a pair (§3.1).
  if not exists (select 1 from pg_constraint where conname = 'users_access_token_pair_check'
                 and conrelid = 'public.users'::regclass) then
    alter table public.users add constraint users_access_token_pair_check
      check ((access_token is null) = (access_token_expires_at is null));
  end if;
end;
$$;

drop trigger if exists users_set_updated_at on public.users;
create trigger users_set_updated_at
  before update on public.users
  for each row execute function public.set_updated_at();

alter table public.users enable row level security;

-- ---------------------------------------------------------------------------
-- public.messages: one stored Gmail message (§5.1)
-- ---------------------------------------------------------------------------

create table if not exists public.messages (
  id                uuid        not null default gen_random_uuid(),
  user_id           uuid        not null,
  gmail_id          text        not null,
  thread_id         text        not null,
  label_ids         text[]      not null default '{}',
  is_read           boolean     not null,
  is_starred        boolean     not null,
  snippet           text        not null default '',
  history_id        text        not null,
  internal_date     timestamptz not null,
  size_estimate     integer     not null,
  subject           text,
  from_address      text        not null default '',
  to_address        text[]      not null default '{}',
  cc_addresses      text[]      not null default '{}',
  bcc_addresses     text[]      not null default '{}',
  rfc822_message_id text,
  in_reply_to       text,
  "references"      text,
  date_header       text,
  body_plain        text,
  body_html         text,
  attachments       jsonb       not null default '[]'::jsonb,
  synced_at         timestamptz not null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'messages_pkey'
                 and conrelid = 'public.messages'::regclass) then
    alter table public.messages add constraint messages_pkey primary key (id);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'messages_user_id_fkey'
                 and conrelid = 'public.messages'::regclass) then
    alter table public.messages add constraint messages_user_id_fkey
      foreign key (user_id) references auth.users (id) on delete cascade;
  end if;

  -- Upsert conflict target (§5.1).
  if not exists (select 1 from pg_constraint where conname = 'messages_user_id_gmail_id_key'
                 and conrelid = 'public.messages'::regclass) then
    alter table public.messages add constraint messages_user_id_gmail_id_key
      unique (user_id, gmail_id);
  end if;
end;
$$;

-- Keyset pagination for GET /api/v1/messages (§4.2).
create index if not exists messages_user_id_internal_date_gmail_id_idx
  on public.messages (user_id, internal_date desc, gmail_id desc);

drop trigger if exists messages_set_updated_at on public.messages;
create trigger messages_set_updated_at
  before update on public.messages
  for each row execute function public.set_updated_at();

alter table public.messages enable row level security;

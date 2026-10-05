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

-- ---------------------------------------------------------------------------
-- public.users: connected Gmail account per Supabase Auth user (§5.2)
-- ---------------------------------------------------------------------------

create table if not exists public.users (
  user_id                 uuid        not null,
  email                   text        not null,
  refresh_token           text,
  scopes                  text[]      not null,
  access_token            text,
  access_token_expires_at timestamptz,
  last_history_id         text,
  last_synced_at          timestamptz,
  watch_expiration        timestamptz,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'users_pkey'
                 and conrelid = 'public.users'::regclass) then
    alter table public.users add constraint users_pkey primary key (user_id);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'users_user_id_fkey'
                 and conrelid = 'public.users'::regclass) then
    alter table public.users add constraint users_user_id_fkey
      foreign key (user_id) references auth.users (id) on delete cascade;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'users_email_key'
                 and conrelid = 'public.users'::regclass) then
    alter table public.users add constraint users_email_key unique (email);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'users_email_lowercase_check'
                 and conrelid = 'public.users'::regclass) then
    alter table public.users add constraint users_email_lowercase_check
      check (email = lower(email));
  end if;

  if not exists (select 1 from pg_constraint where conname = 'users_access_token_pair_check'
                 and conrelid = 'public.users'::regclass) then
    alter table public.users add constraint users_access_token_pair_check
      check ((access_token is null) = (access_token_expires_at is null));
  end if;

  if not exists (select 1 from pg_constraint where conname = 'users_last_history_id_digits_check'
                 and conrelid = 'public.users'::regclass) then
    alter table public.users add constraint users_last_history_id_digits_check
      check (last_history_id ~ '^[0-9]+$');
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
  snippet           text        not null default '',
  history_id        text        not null,
  internal_date     timestamptz not null,
  size_estimate     integer     not null,
  subject           text,
  from_address      text        not null default '',
  to_addresses      text[]      not null default '{}',
  cc_addresses      text[]      not null default '{}',
  bcc_addresses     text[]      not null default '{}',
  rfc822_message_id text,
  in_reply_to       text,
  "references"      text,
  date_header       text,
  body_text         text,
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

-- ---------------------------------------------------------------------------
-- Sync functions (§5.5). service_role only; every statement filters on
-- p_user_id (§5.3).
-- ---------------------------------------------------------------------------

create or replace function public.advance_last_history_id(
  p_user_id    uuid,
  p_history_id text
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_updated integer;
begin
  update public.users
     set last_history_id = p_history_id,
         last_synced_at  = now()
   where user_id = p_user_id
     and (last_history_id is null
          or last_history_id::numeric < p_history_id::numeric);
  get diagnostics v_updated = row_count;
  return v_updated > 0;
end;
$$;

create or replace function public.apply_sync_batch(
  p_user_id        uuid,
  p_upserts        jsonb,
  p_deletes        text[],
  p_label_updates  jsonb,
  p_new_history_id text
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_stored text;
begin
  if p_new_history_id is null or p_new_history_id !~ '^[0-9]+$' then
    raise exception 'p_new_history_id must be a digit string, got %', p_new_history_id
      using errcode = '22023';
  end if;

  -- 1. Serialise syncs per user.
  perform pg_advisory_xact_lock(hashtext(p_user_id::text));

  -- 2. Stale guard: a newer sync already committed.
  select last_history_id into v_stored
    from public.users
   where user_id = p_user_id;

  if v_stored is not null and v_stored::numeric > p_new_history_id::numeric then
    return false;
  end if;

  -- 3. Upserts. user_id and synced_at are forced; id/created_at/updated_at
  --    from the payload are ignored.
  insert into public.messages as m (
    user_id, gmail_id, thread_id, label_ids, is_read, snippet, history_id,
    internal_date, size_estimate, subject, from_address, to_addresses,
    cc_addresses, bcc_addresses, rfc822_message_id, in_reply_to, "references",
    date_header, body_text, body_html, attachments, synced_at
  )
  select
    p_user_id, r.gmail_id, r.thread_id,
    coalesce(r.label_ids, '{}'), r.is_read, coalesce(r.snippet, ''), r.history_id,
    r.internal_date, r.size_estimate, r.subject, coalesce(r.from_address, ''),
    coalesce(r.to_addresses, '{}'), coalesce(r.cc_addresses, '{}'),
    coalesce(r.bcc_addresses, '{}'), r.rfc822_message_id, r.in_reply_to,
    r."references", r.date_header, r.body_text, r.body_html,
    coalesce(r.attachments, '[]'::jsonb), now()
  from jsonb_populate_recordset(null::public.messages, coalesce(p_upserts, '[]'::jsonb)) as r
  on conflict (user_id, gmail_id) do update set
    thread_id         = excluded.thread_id,
    label_ids         = excluded.label_ids,
    is_read           = excluded.is_read,
    snippet           = excluded.snippet,
    history_id        = excluded.history_id,
    internal_date     = excluded.internal_date,
    size_estimate     = excluded.size_estimate,
    subject           = excluded.subject,
    from_address      = excluded.from_address,
    to_addresses      = excluded.to_addresses,
    cc_addresses      = excluded.cc_addresses,
    bcc_addresses     = excluded.bcc_addresses,
    rfc822_message_id = excluded.rfc822_message_id,
    in_reply_to       = excluded.in_reply_to,
    "references"      = excluded."references",
    date_header       = excluded.date_header,
    body_text         = excluded.body_text,
    body_html         = excluded.body_html,
    attachments       = excluded.attachments,
    synced_at         = excluded.synced_at;

  -- 4. Label changes on existing rows.
  update public.messages as m
     set label_ids = u.label_ids,
         is_read   = not ('UNREAD' = any (u.label_ids)),
         synced_at = now()
    from jsonb_to_recordset(coalesce(p_label_updates, '[]'::jsonb))
           as u (gmail_id text, label_ids text[])
   where m.user_id = p_user_id
     and m.gmail_id = u.gmail_id;

  -- 5. Deletes last: added-then-deleted in one batch ends deleted.
  delete from public.messages
   where user_id = p_user_id
     and gmail_id = any (coalesce(p_deletes, '{}'));

  -- 6. Advance history (monotonic) and stamp the sync time.
  update public.users
     set last_history_id = case
           when last_history_id is null
                or last_history_id::numeric < p_new_history_id::numeric
           then p_new_history_id
           else last_history_id
         end,
         last_synced_at = now()
   where user_id = p_user_id;

  return true;
end;
$$;

revoke execute on function public.advance_last_history_id(uuid, text)
  from public, anon, authenticated;
grant execute on function public.advance_last_history_id(uuid, text)
  to service_role;

revoke execute on function public.apply_sync_batch(uuid, jsonb, text[], jsonb, text)
  from public, anon, authenticated;
grant execute on function public.apply_sync_batch(uuid, jsonb, text[], jsonb, text)
  to service_role;

-- set_updated_at is a trigger function only; nobody calls it directly.
revoke execute on function public.set_updated_at() from public, anon, authenticated;

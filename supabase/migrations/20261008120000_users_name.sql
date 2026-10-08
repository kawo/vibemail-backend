-- users.name: the Google account's display name (CONTRACT.md §5.2), from the
-- id_token `name` claim returned by the code exchange (userinfo.profile scope).
-- Nullable: older rows and accounts that withhold the claim have none.
--
-- Idempotent: re-running is a no-op.

alter table public.users add column if not exists name text;

-- Runs on every boot. Must stay idempotent.
-- Creates the same roles Supabase uses so RLS policies and supabase-js work unchanged.

do $$
begin
  if not exists (select from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
  -- PostgREST logs in as authenticator, then switches to the role in the JWT.
  if not exists (select from pg_roles where rolname = 'authenticator') then
    create role authenticator login noinherit;
  end if;
  -- The auth server owns the auth schema.
  if not exists (select from pg_roles where rolname = 'supabase_auth_admin') then
    create role supabase_auth_admin login noinherit;
  end if;
  -- Some auth migrations grant to "postgres"; make sure it exists on hosts like Neon.
  if not exists (select from pg_roles where rolname = 'postgres') then
    create role postgres nologin;
  end if;
end
$$;

grant anon, authenticated, service_role to authenticator;

create schema if not exists auth authorization supabase_auth_admin;
alter role supabase_auth_admin set search_path = auth;
grant usage on schema auth to anon, authenticated, service_role;

grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to service_role;
alter default privileges in schema public grant all on sequences to service_role;
alter default privileges in schema public grant all on functions to service_role;

-- Realtime: tables opt in with  select realtime.enable('public.my_table');
create schema if not exists realtime;
grant usage on schema realtime to anon, authenticated, service_role;

create or replace function realtime.notify() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  rec record := case when tg_op = 'DELETE' then old else new end;
  pk text := coalesce(tg_argv[0], 'id');
begin
  -- Only the primary key travels over NOTIFY (8KB limit). The gateway re-reads the
  -- row as each subscriber, so RLS decides who sees what.
  perform pg_notify('cheapabase_realtime', json_build_object(
    'schema', tg_table_schema,
    'table', tg_table_name,
    'type', tg_op,
    'pk', pk,
    'id', to_jsonb(rec) -> pk
  )::text);
  return null;
end
$$;

create or replace function realtime.enable(tbl regclass, pk text default 'id') returns void
language plpgsql as $$
begin
  execute format('drop trigger if exists cheapabase_realtime on %s', tbl);
  execute format(
    'create trigger cheapabase_realtime after insert or update or delete on %s for each row execute function realtime.notify(%L)',
    tbl, pk);
end
$$;

create or replace function realtime.disable(tbl regclass) returns void
language plpgsql as $$
begin
  execute format('drop trigger if exists cheapabase_realtime on %s', tbl);
end
$$;

-- Broadcast/presence channel authorization. Return true to allow joining.
-- Runs as the joining user (RLS applies). Override it in your migrations.
do $$
begin
  if not exists (
    select from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'realtime' and p.proname = 'can_join'
  ) then
    create function realtime.can_join(channel text) returns boolean
    language sql stable as $f$
      select coalesce(current_setting('request.jwt.claims', true)::jsonb ->> 'role', 'anon') <> 'anon'
    $f$;
  end if;
end
$$;
grant execute on function realtime.can_join(text) to anon, authenticated, service_role;

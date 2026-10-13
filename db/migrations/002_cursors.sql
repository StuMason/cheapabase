-- Cursors app: an anonymous live-cursor room plus its visit counters.
-- Tables here have RLS on and no policies, so PostgREST exposes nothing.
-- Only the cursors-* functions (admin connection) read or write them.

-- Anyone holding the anon key may join the single 'cursors' channel. Everything else is unchanged.
create or replace function realtime.can_join(channel text) returns boolean
language plpgsql stable as $$
begin
  if channel = 'cursors' then
    return true;
  end if;
  if channel like 'doc:%' then
    return public.can_access_doc(nullif(substr(channel, 5), '')::uuid);
  end if;
  return coalesce(current_setting('request.jwt.claims', true)::jsonb ->> 'role', 'anon') <> 'anon';
exception when invalid_text_representation then
  return false;
end
$$;

-- One row per page load. visitor is an HMAC of the IP keyed by the day, so it counts
-- unique visitors per day and can't be reversed or linked across days. No IP is stored.
create table public.cursor_visits (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  day date not null default current_date,
  visitor text not null,
  country text,
  city text,
  region text,
  timezone text,
  lat numeric(5, 1),
  lon numeric(5, 1),
  browser text,
  os text,
  referrer text,
  bot boolean not null default false
);
create index cursor_visits_day on public.cursor_visits (day, visitor);
create index cursor_visits_at on public.cursor_visits (at desc);
alter table public.cursor_visits enable row level security;

-- Running totals: cursor distance, clicks, rage clicks, peak concurrent.
create table public.cursor_totals (
  name text primary key,
  value double precision not null default 0
);
insert into public.cursor_totals (name) values ('distance_px'), ('clicks'), ('rage_clicks'), ('peak_concurrent');
alter table public.cursor_totals enable row level security;

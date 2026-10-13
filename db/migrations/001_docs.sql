-- Example app: realtime collaborative docs.
-- Each migration runs once, in filename order, after the auth schema exists.

create table public.docs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title text not null default 'Untitled',
  content text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid()
);

create table public.doc_members (
  id uuid primary key default gen_random_uuid(),
  doc_id uuid not null references public.docs (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  email text not null,
  created_at timestamptz not null default now(),
  unique (doc_id, user_id)
);

-- security definer so policies on docs and doc_members can use it without recursion
create function public.can_access_doc(doc uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.docs d where d.id = doc and d.owner_id = auth.uid())
      or exists (select 1 from public.doc_members m where m.doc_id = doc and m.user_id = auth.uid())
$$;

create function public.touch_doc() returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  new.owner_id := old.owner_id; -- ownership can't be changed through the API
  return new;
end
$$;
create trigger touch_doc before update on public.docs for each row execute function public.touch_doc();

alter table public.docs enable row level security;
alter table public.doc_members enable row level security;

-- owner_id is checked inline (not only via can_access_doc) so "insert ... returning"
-- works: a STABLE function can't see the row being inserted by the same statement.
create policy "docs: owner or member can read" on public.docs
  for select to authenticated using (owner_id = auth.uid() or public.can_access_doc(id));
create policy "docs: create your own" on public.docs
  for insert to authenticated with check (owner_id = auth.uid());
create policy "docs: owner or member can edit" on public.docs
  for update to authenticated using (owner_id = auth.uid() or public.can_access_doc(id));
create policy "docs: owner can delete" on public.docs
  for delete to authenticated using (owner_id = auth.uid());

create policy "members: see your own memberships and your docs' members" on public.doc_members
  for select to authenticated
  using (user_id = auth.uid() or public.can_access_doc(doc_id));
create policy "members: owner can remove" on public.doc_members
  for delete to authenticated
  using (exists (select 1 from public.docs d where d.id = doc_id and d.owner_id = auth.uid()));
-- Adding members goes through functions/share-doc.ts because it needs to look up a user by email.

grant select, insert, update, delete on public.docs to authenticated;
grant select, delete on public.doc_members to authenticated;

-- Realtime on both tables
select realtime.enable('public.docs');
select realtime.enable('public.doc_members');

-- Only people who can open a doc may join its presence/broadcast channel "doc:<id>"
create or replace function realtime.can_join(channel text) returns boolean
language plpgsql stable as $$
begin
  if channel like 'doc:%' then
    return public.can_access_doc(nullif(substr(channel, 5), '')::uuid);
  end if;
  return coalesce(current_setting('request.jwt.claims', true)::jsonb ->> 'role', 'anon') <> 'anon';
exception when invalid_text_representation then
  return false;
end
$$;

-- Ortiz AI v2 database schema
create schema if not exists private;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  role text not null default 'user' check (role in ('user','admin')),
  plan text not null default 'free' check (plan in ('free','plus','pro','admin')),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null default 'New chat',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists conversations_user_updated_idx on public.conversations(user_id, updated_at desc);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('user','assistant')),
  content text not null,
  attachment_name text,
  created_at timestamptz not null default now()
);
create index if not exists messages_conversation_created_idx on public.messages(conversation_id, created_at);

create table if not exists public.usage_events (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  model text,
  input_chars integer not null default 0,
  output_chars integer not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists usage_user_created_idx on public.usage_events(user_id, created_at desc);

alter table public.profiles enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.usage_events enable row level security;

create or replace function private.is_admin()
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$ select coalesce((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin', false) $$;

create or replace function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles(id, full_name)
  values (new.id, new.raw_user_meta_data ->> 'full_name')
  on conflict (id) do nothing;
  return new;
end;
$$;

revoke all on function private.handle_new_user() from public, anon, authenticated;
revoke all on function private.is_admin() from public, anon;
grant usage on schema private to authenticated;
grant execute on function private.is_admin() to authenticated;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute function private.handle_new_user();

-- Backfill profiles for existing users.
insert into public.profiles(id, full_name)
select id, raw_user_meta_data ->> 'full_name' from auth.users
on conflict (id) do nothing;

create policy "profiles_select_own_or_admin" on public.profiles for select to authenticated
using ((select auth.uid()) = id or private.is_admin());
create policy "profiles_update_own" on public.profiles for update to authenticated
using ((select auth.uid()) = id) with check ((select auth.uid()) = id);

create policy "conversations_select_own" on public.conversations for select to authenticated using ((select auth.uid()) = user_id);
create policy "conversations_insert_own" on public.conversations for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "conversations_update_own" on public.conversations for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "conversations_delete_own" on public.conversations for delete to authenticated using ((select auth.uid()) = user_id);

create policy "messages_select_own" on public.messages for select to authenticated using ((select auth.uid()) = user_id);
create policy "messages_insert_own" on public.messages for insert to authenticated
with check ((select auth.uid()) = user_id and exists (select 1 from public.conversations c where c.id=conversation_id and c.user_id=(select auth.uid())));
create policy "messages_delete_own" on public.messages for delete to authenticated using ((select auth.uid()) = user_id);

create policy "usage_select_own_or_admin" on public.usage_events for select to authenticated
using ((select auth.uid()) = user_id or private.is_admin());

-- Least privilege Data API grants. Server-side service role bypasses these/RLS.
grant select on public.profiles to authenticated;
grant update(full_name, updated_at) on public.profiles to authenticated;
grant select, insert, update, delete on public.conversations to authenticated;
grant select, insert, delete on public.messages to authenticated;
grant select on public.usage_events to authenticated;
grant all on public.profiles, public.conversations, public.messages, public.usage_events to service_role;
grant usage, select on sequence public.usage_events_id_seq to service_role;

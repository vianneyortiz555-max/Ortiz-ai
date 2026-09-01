alter table public.profiles
  add column if not exists stripe_customer_id text,
  add column if not exists stripe_subscription_id text,
  add column if not exists subscription_status text,
  add column if not exists current_period_end timestamptz;

create unique index if not exists profiles_stripe_customer_id_uidx
  on public.profiles (stripe_customer_id)
  where stripe_customer_id is not null;

create unique index if not exists profiles_stripe_subscription_id_uidx
  on public.profiles (stripe_subscription_id)
  where stripe_subscription_id is not null;

create table if not exists public.billing_events (
  stripe_event_id text primary key,
  event_type text not null,
  processed_at timestamptz not null default now()
);

alter table public.billing_events enable row level security;
revoke all on table public.billing_events from anon, authenticated;

revoke update (plan, role, is_active, stripe_customer_id, stripe_subscription_id, subscription_status, current_period_end)
  on public.profiles from authenticated;

grant update (full_name) on public.profiles to authenticated;

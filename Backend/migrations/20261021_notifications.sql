-- Persistent event-based portal notifications.
create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  client_id uuid references public.clients(id) on delete cascade,
  recipient_role text not null default 'client' check (recipient_role in ('admin','client')),
  event_key text not null,
  title text not null,
  message text not null,
  target_url text,
  is_read boolean not null default false,
  created_at timestamptz not null default now(),
  unique (recipient_role, client_id, event_key)
);
create index if not exists idx_notifications_client_created
  on public.notifications (client_id, created_at desc);
create index if not exists idx_notifications_role_created
  on public.notifications (recipient_role, created_at desc);
alter table public.notifications enable row level security;
